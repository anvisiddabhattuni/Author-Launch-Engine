import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { planFor, priorityFor, recordDispatch, resourceFor } from '../services/coordination.js';

import { HANDLERS, RECURRING, describeJob } from './handlers.js';

/**
 * The job queue (STORY-065).
 *
 * Infrastructure and Deployment Agent. Claims work, runs it, retries it with
 * backoff, and hands what it cannot finish to a person rather than dropping it.
 *
 * It has no session and cannot get one. Everything it touches was approved by a
 * human first, and the services it calls still enforce that themselves — the
 * approval gate has lived in the service since STORY-001 precisely so a new
 * caller like this one cannot route around it.
 */
export const ACTOR = 'InfrastructureDeploymentAgent';

/**
 * Floors a time into the sweep window.
 *
 * This is what makes "every five minutes" mean *once* per five minutes rather
 * than once per worker per tick. Two workers polling every second still produce
 * one job per window, because they compute the same key and the unique
 * constraint keeps the second one out.
 */
export function windowStart(now, everySeconds) {
  const ms = everySeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export const recurringKey = ({ kind, authorId, now, everySeconds }) =>
  `${kind}:${authorId ?? 'all'}:${windowStart(now, everySeconds).toISOString()}`;

/**
 * Adds a job unless its key is already present.
 *
 * The conflict is not an error and is not logged as one — it is the mechanism.
 * Enqueueing the same unit of work twice is exactly what should happen when two
 * workers tick together or a button is double-clicked.
 */
export async function enqueue(
  { kind, idempotencyKey, authorId = null, payload = {}, runAt = new Date(), maxAttempts },
  client = pool,
) {
  // The Coordination and Governance Agent decides where this sits and what it
  // contends with, once, at enqueue time (STORY-011). Stamped on the row rather
  // than resolved at claim time so the decision is inspectable afterwards and
  // the claim query stays a single statement.
  const plan = planFor({ kind, author_id: authorId, payload });

  const { rows } = await client.query(
    `INSERT INTO jobs (kind, idempotency_key, author_id, payload, run_at, max_attempts,
                       priority, resource, coordination)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      kind,
      idempotencyKey,
      authorId,
      JSON.stringify(payload),
      runAt.toISOString(),
      maxAttempts ?? config.jobMaxAttempts,
      plan.priority,
      plan.resource,
      JSON.stringify(plan.coordination),
    ],
  );
  return { job: rows[0] ?? null, created: Boolean(rows[0]) };
}

/**
 * One job per recurring kind per window — per author where the work is scoped.
 *
 * The per-author insert is a single `INSERT … SELECT FROM authors` rather than a
 * read followed by a loop of inserts. Split in two, an author deleted between
 * the read and the write lands a foreign key violation and takes down the whole
 * sweep — including the work queued for every other tenant. Doing it in one
 * statement means the set of authors cannot change underneath it.
 */
export async function ensureRecurringJobs({ now = new Date(), everySeconds } = {}) {
  const every = everySeconds ?? config.jobSweepSeconds;
  const start = windowStart(now, every);
  const created = [];

  for (const spec of RECURRING) {
    if (spec.scope === 'global') {
      const { job } = await enqueue({
        kind: spec.kind,
        idempotencyKey: recurringKey({ kind: spec.kind, authorId: null, now, everySeconds: every }),
        runAt: start,
      });
      if (job) created.push(job);
      continue;
    }

    const { rows } = await pool.query(
      // FOR SHARE holds each author row for the length of the statement. One
      // atomic INSERT … SELECT narrows the window but does not close it: under
      // READ COMMITTED the foreign key is re-checked at write time, so an author
      // deleted after the select and before the check still fails the insert —
      // and takes every other tenant's sweep down with it.
      // Priority and the resource template are computed here rather than per
      // row: the resource for a per-author sweep is a pure function of the
      // author id, so the set-based insert can build it inline and stay one
      // statement (STORY-011).
      `WITH targets AS (SELECT id FROM authors ORDER BY id FOR SHARE)
       INSERT INTO jobs (kind, idempotency_key, author_id, run_at, max_attempts,
                         priority, resource, coordination)
       SELECT $1, $1 || ':' || t.id || ':' || $2, t.id, $2::timestamptz, $3,
              $4, replace($5, '{authorId}', t.id::text), $6::jsonb
         FROM targets t
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        spec.kind,
        start.toISOString(),
        config.jobMaxAttempts,
        priorityFor(spec.kind),
        resourceFor({ kind: spec.kind, author_id: '{authorId}' }),
        JSON.stringify(planFor({ kind: spec.kind, author_id: 0 }).coordination),
      ],
    );
    created.push(...rows);
  }
  return created;
}

/**
 * Takes the oldest due job.
 *
 * `SKIP LOCKED` is what lets more than one worker run: a row another worker has
 * already locked is passed over rather than waited on, so a slow job never
 * blocks a fast one and no row is ever handed out twice.
 *
 * `attempts` increments on claim rather than on failure, deliberately. A job
 * that kills its worker never reaches a failure handler; counted on claim, it
 * still exhausts its retries and dead-letters instead of looping forever.
 */
/**
 * Postgres unique-violation on the one-running-per-resource index.
 *
 * Not an error condition: it is two workers arriving at the same free resource
 * in the same instant, which is exactly what the index exists to arbitrate. The
 * loser has not failed, it simply has nothing to claim this pass.
 */
const RESOURCE_TAKEN = (error) =>
  error?.code === '23505' && error?.constraint === 'jobs_one_running_per_resource';

async function claim({ now, jobId = null }, client) {
  const { rows } = await client.query(
    `UPDATE jobs SET status = 'running', claimed_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT j.id FROM jobs j
         WHERE j.status = 'queued' AND j.run_at <= $1
           AND ($2::bigint IS NULL OR j.id = $2)
           -- Mutual exclusion (STORY-011). A job whose resource another agent
           -- is holding is passed over, not waited on — the same instinct as
           -- SKIP LOCKED one level up: the worker goes and does something else.
           AND (j.resource IS NULL OR NOT EXISTS (
                 SELECT 1 FROM jobs holder
                  WHERE holder.status = 'running'
                    AND holder.resource = j.resource
           ))
         -- Priority first. FIFO alone sent the one piece of outbound work a
         -- human had authorised to the back of every internal sweep.
         ORDER BY j.priority DESC, j.run_at, j.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [now.toISOString(), jobId],
  );
  return rows[0] ?? null;
}

/** Exponential: 30s, 60s, 120s… so a failing provider is backed away from. */
const backoffMs = (attempts) =>
  config.jobBackoffSeconds * 1000 * 2 ** Math.max(0, attempts - 1);

async function settleFailure({ job, error, now }) {
  const exhausted = job.attempts >= job.max_attempts;
  const runAt = new Date(now.getTime() + backoffMs(job.attempts));

  const { rows } = await pool.query(
    `UPDATE jobs
        SET status = $2, last_error = $3, run_at = $4, finished_at = CASE WHEN $2 = 'dead_letter' THEN now() ELSE NULL END
      WHERE id = $1 RETURNING *`,
    [job.id, exhausted ? 'dead_letter' : 'queued', error.message, runAt.toISOString()],
  );

  await recordAction({
    actor: ACTOR,
    // Retries exhausted is not another failure, it is a handover. The action
    // name says so, because this is the row a human is meant to find.
    action: exhausted ? 'job.dead_lettered' : 'job.retrying',
    entityType: 'job',
    entityId: job.id,
    authorId: job.author_id,
    before: job,
    after: rows[0],
    metadata: {
      kind: job.kind,
      describe: describeJob(job),
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      error: error.message,
      nextRunAt: exhausted ? null : runAt.toISOString(),
      // Said plainly on the log: nothing was dropped, and something is waiting
      // on a person now.
      needsHuman: exhausted,
    },
  });

  return rows[0];
}

async function settleSuccess({ job, result }) {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'done', finished_at = now(), result = $2, last_error = NULL
      WHERE id = $1 RETURNING *`,
    [job.id, JSON.stringify(result ?? {})],
  );

  await recordAction({
    actor: ACTOR,
    action: 'job.succeeded',
    entityType: 'job',
    entityId: job.id,
    authorId: job.author_id,
    before: job,
    after: rows[0],
    metadata: {
      kind: job.kind,
      describe: describeJob(job),
      attempts: job.attempts,
      result: result ?? {},
    },
  });

  return rows[0];
}

/**
 * Claims and runs at most one job. Returns null when there is nothing due.
 *
 * Pass `jobId` to run one specific job — what a human wants after reviving a
 * dead letter, and what a test needs so it does not have to drain everyone
 * else's work to reach its own.
 */
export async function runOnce({ now = new Date(), jobId = null } = {}) {
  let job;
  try {
    job = await withTransaction((client) => claim({ now, jobId }, client));
  } catch (error) {
    // Another worker took this job's resource between our check and our write.
    // Nothing has gone wrong and nothing needs retrying: report an idle pass and
    // let the caller come back round. Any other error is a real one and is
    // rethrown (STORY-011).
    if (RESOURCE_TAKEN(error)) return null;
    throw error;
  }
  if (!job) return null;

  // The story's trust clause: task distributions are logged, by the agent that
  // made the decision, before the work is done rather than after.
  await recordDispatch({ job });

  const handler = HANDLERS[job.kind];
  if (!handler) {
    // An unknown kind is a deployment problem, not a transient one. Retrying it
    // three times before telling anyone would only delay the same answer.
    return settleFailure({
      job: { ...job, attempts: job.max_attempts },
      error: new Error(`No handler registered for job kind "${job.kind}"`),
      now,
    });
  }

  try {
    return await settleSuccess({ job, result: await handler({ job }) });
  } catch (error) {
    return settleFailure({ job, error, now });
  }
}

/**
 * Returns work abandoned by a worker that died mid-job.
 *
 * The attempt has already been counted, so a job that reliably kills its worker
 * still walks to the dead letter instead of being retried forever.
 */
export async function reapStaleJobs({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - config.jobStaleSeconds * 1000);
  const { rows } = await pool.query(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
            last_error = 'Worker stopped before finishing this job'
      WHERE status = 'running' AND claimed_at <= $1
      RETURNING *`,
    [cutoff.toISOString()],
  );

  for (const job of rows) {
    await recordAction({
      actor: ACTOR,
      action: job.status === 'dead_letter' ? 'job.dead_lettered' : 'job.reclaimed',
      entityType: 'job',
      entityId: job.id,
      authorId: job.author_id,
      after: job,
      metadata: {
        kind: job.kind,
        attempts: job.attempts,
        reason: 'claimed by a worker that stopped before finishing',
        needsHuman: job.status === 'dead_letter',
      },
    });
  }
  return rows;
}

/**
 * One cycle: recover abandoned work, enqueue anything now due, drain the queue.
 *
 * Capped rather than looping until empty, so one tick cannot run forever and a
 * worker always comes back to reap and re-enqueue.
 */
export async function tick({ now = new Date(), max = 25 } = {}) {
  const reclaimed = await reapStaleJobs({ now });
  const scheduled = await ensureRecurringJobs({ now });

  const ran = [];
  for (let i = 0; i < max; i += 1) {
    const job = await runOnce({ now });
    if (!job) break;
    ran.push(job);
  }
  return { reclaimed, scheduled, ran };
}

/** Puts a dead letter back in the queue. The one thing a human does to a job. */
export async function retryJob({ jobId, user = null }) {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'dead_letter' RETURNING *`,
    [jobId],
  );
  if (!rows[0]) {
    throw Object.assign(new Error(`Job ${jobId} is not waiting on a human`), { status: 409 });
  }

  await recordAction({
    actor: user?.name ?? ACTOR,
    action: 'job.retried_by_human',
    entityType: 'job',
    entityId: rows[0].id,
    authorId: rows[0].author_id,
    after: rows[0],
    metadata: { kind: rows[0].kind, userId: user?.id ?? null, attributable: Boolean(user) },
  });

  return rows[0];
}
