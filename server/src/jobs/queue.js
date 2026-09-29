import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { planFor, priorityFor, recordDispatch, resourceFor } from '../services/coordination.js';

import { HANDLERS, RECURRING, describeJob } from './handlers.js';
import { dispatch } from '../services/messageBus.js';

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
                       priority, resource, coordination, agent, requires)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
      plan.agent,
      plan.requires,
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
                         priority, resource, coordination, agent, requires)
       SELECT $1, $1 || ':' || t.id || ':' || $2, t.id, $2::timestamptz, $3,
              $4, replace($5, '{authorId}', t.id::text), $6::jsonb, $7, $8
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
        planFor({ kind: spec.kind, author_id: 0 }).agent,
        planFor({ kind: spec.kind, author_id: 0 }).requires,
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
    `WITH claimed AS (
     UPDATE jobs SET status = 'running', claimed_at = now(), attempts = attempts + 1
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
           -- Availability (STORY-040): an integration this task needs is down
           -- and not yet due its trial call. Skipped without spending an
           -- attempt — running it would only have the gateway refuse, and the
           -- notifiers record a refused send as announced.
           AND NOT EXISTS (
                 SELECT 1 FROM integration_circuits c
                  WHERE c.service = ANY(j.requires) AND c.state = 'open'
                    AND c.retry_at IS NOT NULL AND c.retry_at > $1::timestamptz
           )
         -- Priority first. FIFO alone sent the one piece of outbound work a
         -- human had authorised to the back of every internal sweep.
         ORDER BY j.priority DESC, j.run_at, j.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *)
     -- What this choice went ahead of, read in the same statement as the
     -- choice (STORY-040) — so from the same snapshot of the queue. The first
     -- version looked it up afterwards, and with two workers a resource held
     -- at the moment of choosing had been released by the moment of looking:
     -- a correct decision recorded as a wrong one, twice, in the demo.
     SELECT c.*, COALESCE((
       SELECT json_agg(json_build_object(
                'id', b.id, 'kind', b.kind, 'priority', b.priority, 'resource', b.resource,
                'held_by', b.held_by, 'held_by_kind', b.held_by_kind,
                'down_service', b.down_service, 'down_until', b.down_until))
         FROM (${BLOCKERS_SQL}
                WHERE j.status = 'queued' AND j.run_at <= $1::timestamptz
                  AND j.priority > c.priority AND j.id <> c.id AND j.created_at <= now()
                ORDER BY (j.author_id IS NOT DISTINCT FROM c.author_id) DESC, j.priority DESC, j.id
                LIMIT 10) b), '[]'::json) AS passed_over
       FROM claimed c`,
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
  // made the decision, before the work is done rather than after. With what
  // it was chosen over (STORY-040): any higher-priority task still waiting, and
  // what was blocking it. An entry with no blocker is a wrong assignment, and
  // the governance check `tasks.priority_respected` counts them.
  //
  //
  // Read by the claim itself, from the same snapshot (see `claim`): only tasks
  // that already existed, the same tenant's first, capped at ten. One that
  // shows no blocker may still have been mid-claim by another worker — SKIP
  // LOCKED passes over a row being claimed — and that is checked here, after
  // the fact, when the other claim has committed.
  const passedOver = job.passed_over ?? [];
  delete job.passed_over;
  const higherPriorityWaiting = [];
  for (const h of passedOver) {
    let blockedBy = blockerOf(h);
    if (!blockedBy) {
      const { rows: [now2] } = await pool.query('SELECT status FROM jobs WHERE id = $1', [h.id]);
      if (now2 && now2.status !== 'queued') blockedBy = 'claimed by another worker at the same moment';
    }
    higherPriorityWaiting.push({ id: Number(h.id), kind: h.kind, priority: h.priority, blockedBy });
  }
  await recordDispatch({
    job,
    // A job run by id — the Retry button, a test — was requested, not chosen.
    // Priority is not what decided it, so it is not judged against priority.
    chosenBy: jobId ? 'request' : 'priority',
    higherPriorityWaiting,
  });

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
 * Every queued job with whatever is stopping it running: a resource another
 * job holds, or an integration whose circuit is open and not yet due a trial.
 */
const BLOCKERS_SQL = `
  SELECT j.*, holder.id AS held_by, holder.kind AS held_by_kind,
         down.service AS down_service, down.retry_at AS down_until
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT h.id, h.kind FROM jobs h
       WHERE j.resource IS NOT NULL AND h.status = 'running' AND h.resource = j.resource
       LIMIT 1) holder ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.service, c.retry_at FROM integration_circuits c
       WHERE c.service = ANY(j.requires) AND c.state = 'open'
         AND c.retry_at IS NOT NULL AND c.retry_at > $1::timestamptz
       LIMIT 1) down ON TRUE`;

/** The reason a queued job cannot run, in words, or null when nothing blocks it. */
export function blockerOf(row) {
  if (row.down_service) {
    return `waiting for ${row.down_service}: its circuit is open until ${new Date(row.down_until).toISOString()}`;
  }
  if (row.held_by) return `waiting for ${row.resource}, held by job ${row.held_by} (${row.held_by_kind})`;
  return null;
}

/**
 * Records each task that is due and held back, with why — once per reason,
 * not once per poll (STORY-040).
 *
 * STORY-011 wrote the logging for this and nothing ever called it: a deferred
 * job left no trace, so a stalled queue looked exactly like an empty one. A
 * worker polls every five seconds; recording every poll would bury the one
 * line a person needs under seven hundred copies of it, so the reason is
 * stored on the job and a new row is written only when it changes.
 */
export async function recordDeferrals({ now = new Date() } = {}) {
  const { rows } = await pool.query(
    `${BLOCKERS_SQL}
      WHERE j.status = 'queued' AND j.run_at <= $1::timestamptz
        AND (holder.id IS NOT NULL OR down.service IS NOT NULL)`,
    [now.toISOString()],
  );
  const recorded = [];
  for (const row of rows) {
    const reason = blockerOf(row);
    // The reason carries the retry time, so "down until 10:05" and "down until
    // 10:07" are different reasons — a circuit that re-opened is news.
    const { rows: changed } = await pool.query(
      `UPDATE jobs SET deferred_reason = $2::text, deferred_at = $3::timestamptz
        WHERE id = $1 AND deferred_reason IS DISTINCT FROM $2::text RETURNING *`,
      [row.id, reason, now],
    );
    if (changed[0]) {
      await recordDispatch({ job: changed[0], deferredBehind: reason });
      recorded.push({ id: Number(row.id), kind: row.kind, reason });
    }
  }
  return recorded;
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
export async function tick({ now: given = null, max = 25, channel = null } = {}) {
  const now = given ?? new Date();
  const reclaimed = await reapStaleJobs({ now });
  const scheduled = await ensureRecurringJobs({ now });
  const deferred = await recordDeferrals({ now });

  const ran = [];
  for (let i = 0; i < max; i += 1) {
    const job = await runOnce({ now });
    if (!job) break;
    ran.push(job);
  }
  // Messages between agents, delivered on every poll (STORY-039) — which is
  // what makes a hand-off take seconds instead of a sweep interval.
  // Only a caller-supplied time; otherwise the database's clock decides what
  // is due, the same clock that stamped the messages (see messageBus.receive).
  const messages = await dispatch({ now: given, channel });
  return { reclaimed, scheduled, deferred, ran, messages };
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
