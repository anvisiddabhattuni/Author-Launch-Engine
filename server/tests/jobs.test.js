/**
 * STORY-065 acceptance tests.
 *
 * The story's three Gherkin scenarios are the first three `describe` blocks:
 * scheduled work runs unattended, re-running is safe, failures reach a human.
 *
 * `tick()` is called directly rather than starting the worker process and
 * waiting on its poll interval — the loop in worker.js is a `setInterval` and a
 * signal handler around this function, and testing through a timer would buy
 * nothing but flakiness.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { HANDLERS } from '../src/jobs/handlers.js';
import {
  enqueue,
  recurringKey,
  reapStaleJobs,
  retryJob,
  runOnce,
  tick,
  windowStart,
} from '../src/jobs/queue.js';
import { approveDraft } from '../src/services/approvals.js';
import { scheduleDraft } from '../src/services/scheduler.js';

const stamp = Date.now();
let authorId;
let bookId;

/** Handlers registered only for these tests, so real work is never involved. */
let failures = 0;
let runs = 0;
HANDLERS['test.always_fails'] = async () => {
  failures += 1;
  throw new Error('the provider said no');
};
HANDLERS['test.counts'] = async () => {
  runs += 1;
  return { runs };
};

/**
 * Runs exactly the job we care about.
 *
 * A bare `runOnce()` claims the globally oldest due job, so it can pick up work
 * another suite queued — and with several authors in the database there may be
 * more of that than a test wants to wade through. Naming the job is what makes
 * each test independent of everything else in the shared queue.
 */
const drain = (jobId) => runOnce({ jobId });

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [`Jobs Author ${stamp}`, `jobs-${stamp}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = a[0].id;

  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes)
     VALUES ($1,'The Quiet Craft','Attention is a muscle. Craft is slow and quiet.',$2)
     RETURNING *`,
    [authorId, ['deep work', 'craft']],
  );
  bookId = b[0].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await query("DELETE FROM jobs WHERE kind LIKE 'test.%'");
  await closePool();
});

describe('STORY-065: scheduled work runs unattended', () => {
  let post;

  before(async () => {
    const [draft] = await draftWeeklyPosts({ authorId, bookId, count: 1 });
    await approveDraft({ draftId: draft.id, reviewer: 'A Human' });
    post = await scheduleDraft({ draftId: draft.id });
    // Bring its slot forward so it is due without waiting for the real one.
    await query('UPDATE scheduled_posts SET scheduled_for = now() - interval $$1 minute$$ WHERE id = $1', [
      post.id,
    ]);
  });

  it('Given approved content is queued, When its time arrives, Then the worker publishes it', async () => {
    // Enqueued with a key of its own rather than leaning on the recurring
    // sweep: the sweep is once per window by design, so whether *this* test
    // gets a fresh one depends on what ran in the same five minutes. The
    // recurring path has its own test below.
    const { job } = await enqueue({
      kind: 'posts.publish_due',
      idempotencyKey: `posts.publish_due:test:${stamp}`,
    });
    const publisher = await drain(job.id);
    assert.ok(publisher, 'the publish sweep did not run');
    assert.equal(publisher.status, 'done');

    const { rows } = await query('SELECT * FROM scheduled_posts WHERE id = $1', [post.id]);
    assert.equal(rows[0].status, 'published', 'nobody was present and it still went out');
    assert.ok(rows[0].external_id, 'the provider id was not recorded');
  });

  it('and the run itself is recorded', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE action = 'job.succeeded' AND metadata->>'kind' = 'posts.publish_due'
        ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(rows[0], 'a scheduled run must appear on the log');
    assert.equal(rows[0].actor, 'InfrastructureDeploymentAgent');
    assert.ok(rows[0].metadata.describe);
  });

  it('does the work a human asked for without being able to approve anything', async () => {
    // The worker has no session at all (STORY-064). An unapproved draft is not
    // its to release, and the gate lives in the service, so running the sweep
    // cannot move it.
    const [unapproved] = await draftWeeklyPosts({ authorId, bookId, count: 1 });
    await assert.rejects(() => scheduleDraft({ draftId: unapproved.id }), /approved/i);

    await tick();

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [unapproved.id]);
    assert.notEqual(rows[0].status, 'approved', 'the worker approved something');
  });
});

describe('STORY-065: re-running is safe', () => {
  it('enqueues one job however many times the same key is offered', async () => {
    const key = `test.counts:${stamp}:once`;
    const first = await enqueue({ kind: 'test.counts', idempotencyKey: key, authorId });
    const second = await enqueue({ kind: 'test.counts', idempotencyKey: key, authorId });
    const third = await enqueue({ kind: 'test.counts', idempotencyKey: key, authorId });

    assert.equal(first.created, true);
    assert.equal(second.created, false, 'the same key must not queue twice');
    assert.equal(third.created, false);

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs WHERE idempotency_key = $1', [
      key,
    ]);
    assert.equal(rows[0].n, 1);
  });

  it('runs a recurring sweep once per window, not once per tick', async () => {
    // Mid-window on purpose. With a real `now` this asserted that the current
    // instant is not within a second of a window boundary, which is true about
    // 299 times in 300 — a latent flake that only showed up once the suite was
    // run twenty times in a row. The comment below already knew about this
    // hazard for the ticks; the key comparison needed it too.
    const now = new Date('2026-01-01T12:02:30.000Z');
    const a = recurringKey({ kind: 'posts.publish_due', authorId: null, now, everySeconds: 300 });
    const b = recurringKey({
      kind: 'posts.publish_due',
      authorId: null,
      now: new Date(now.getTime() + 1000),
      everySeconds: 300,
    });
    assert.equal(a, b, 'two moments in the same window must produce the same key');

    // A fixed `now`, so the three ticks cannot straddle a window boundary and
    // legitimately create a second job — which would be correct behaviour and a
    // failing test.
    //
    // Counted by this window's key, not across the table: other suites tick
    // in real time alongside this one, and one that crosses into the next
    // window during the test legitimately adds that window's sweep — which a
    // table-wide count read as this test's ticks doubling up.
    const pinned = new Date();
    await tick({ now: pinned });
    await tick({ now: pinned });
    await tick({ now: pinned });
    const key = recurringKey({ kind: 'posts.publish_due', authorId: null, now: pinned, everySeconds: config.jobSweepSeconds });
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM jobs WHERE idempotency_key = $1', [key]);
    assert.equal(rows[0].n, 1, 'three ticks in one window queued extra work');
  });

  it('windows are stable and adjacent, so no run is skipped or doubled', () => {
    const t = new Date('2026-08-20T12:07:31.500Z');
    assert.equal(windowStart(t, 300).toISOString(), '2026-08-20T12:05:00.000Z');
    assert.equal(
      windowStart(new Date(t.getTime() + 300_000), 300).toISOString(),
      '2026-08-20T12:10:00.000Z',
    );
  });

  it('produces no second email when the same send job runs twice', async () => {
    const { rows: opportunity } = await query(
      `INSERT INTO opportunities (author_id, source, external_id, type, name, host, contact_email,
                                  url, description, topics, relevance, matched_themes, rationale,
                                  discovered_month, status)
       VALUES ($1,'test',$2,'podcast','Test Show','A Host','host@example.test',
               'http://example.test','A show about craft and attention.',
               $3,0.9,$3,'seeded for a jobs test',date_trunc('month', now()),'identified')
       RETURNING *`,
      [authorId, `jobs-${stamp}`, ['craft', 'attention']],
    );
    const { rows: message } = await query(
      `INSERT INTO outreach_messages (author_id, book_id, opportunity_id, subject, body,
                                      personalization, confidence, rationale, status)
       VALUES ($1,$2,$3,'A pitch','Body of the pitch.',$4,0.9,'seeded','approved')
       RETURNING *`,
      [authorId, bookId, opportunity[0].id, ['the show name']],
    );

    const key = `outreach.send:${message[0].id}`;
    const { job: sendJob } = await enqueue({
      kind: 'outreach.send',
      idempotencyKey: key,
      authorId,
      payload: { messageId: Number(message[0].id) },
    });
    // Nudge run_at into the past explicitly. Postgres `now()` is transaction
    // start time and can sit a hair ahead of the JS clock the claim compares
    // against, which would leave the job not-yet-due for a moment.
    await query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [sendJob.id]);
    const first = await drain(sendJob.id);
    assert.ok(first, 'the send job was not claimable');
    assert.equal(first.status, 'done');

    // Simulate the crash-and-retry the story describes: the same unit of work,
    // run a second time.
    await query(
      "UPDATE jobs SET status = 'queued', run_at = now() - interval '1 second' WHERE idempotency_key = $1",
      [key],
    );
    const second = await drain(sendJob.id);
    assert.ok(second, 'the retried send job was not claimable');
    assert.equal(second.status, 'done', 'the retry must not look like a failure');
    assert.equal(second.result.alreadySent, true);

    const { rows: sends } = await query(
      'SELECT COUNT(*)::int AS n FROM outreach_sends WHERE message_id = $1',
      [message[0].id],
    );
    assert.equal(sends[0].n, 1, 'the retry sent a second email');
  });
});

describe('STORY-065: failures are visible', () => {
  let jobId;

  before(async () => {
    failures = 0;
    const { job } = await enqueue({
      kind: 'test.always_fails',
      idempotencyKey: `test.always_fails:${stamp}`,
      authorId,
      maxAttempts: 3,
    });
    jobId = job.id;
  });

  it('retries with backoff rather than giving up on the first failure', async () => {
    const first = await drain(jobId);
    assert.equal(Number(first.id), Number(jobId));
    assert.equal(first.status, 'queued', 'it should be waiting for another go');
    assert.equal(first.attempts, 1);
    assert.match(first.last_error, /the provider said no/);
    assert.ok(
      new Date(first.run_at).getTime() > Date.now(),
      'the retry should be scheduled into the future, not run immediately',
    );
  });

  it('backs off further each time', async () => {
    const runs = [];
    for (let i = 0; i < 2; i += 1) {
      // Jump past the backoff rather than waiting it out.
      await query("UPDATE jobs SET run_at = now() - interval $$1 second$$ WHERE id = $1", [jobId]);
      runs.push(await drain(jobId));
    }
    assert.equal(runs[0].attempts, 2);
    assert.equal(runs[1].attempts, 3);
    assert.equal(failures, 3, 'the handler should have been tried three times');
  });

  it('Then the item is flagged for a human with the error recorded', async () => {
    const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    assert.equal(rows[0].status, 'dead_letter', 'exhausted retries must stop, not loop');
    assert.match(rows[0].last_error, /the provider said no/, 'the error must survive');
    assert.ok(rows[0].finished_at);

    const { rows: log } = await query(
      `SELECT * FROM audit_log WHERE action = 'job.dead_lettered' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [String(jobId)],
    );
    assert.ok(log[0], 'a dead letter must be announced, not just stored');
    assert.equal(log[0].metadata.needsHuman, true);
    assert.equal(log[0].metadata.attempts, 3);
  });

  it('is not silently dropped — it stays queryable as work still owed', async () => {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'dead_letter' AND author_id = $1",
      [authorId],
    );
    assert.ok(rows[0].n >= 1);
  });

  it('lets a human put it back, and records who did', async () => {
    const revived = await retryJob({ jobId, user: { id: 1, name: 'Ops Person' } });
    assert.equal(revived.status, 'queued');
    assert.equal(revived.attempts, 0);

    const { rows } = await query(
      `SELECT * FROM audit_log WHERE action = 'job.retried_by_human' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [String(jobId)],
    );
    assert.equal(rows[0].actor, 'Ops Person');
    assert.equal(rows[0].metadata.attributable, true);

    await query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [jobId]);
  });

  it('refuses to revive a job that is not waiting on anyone', async () => {
    await assert.rejects(() => retryJob({ jobId }), /not waiting on a human/);
  });

  it('dead-letters an unknown kind immediately instead of retrying a deployment bug', async () => {
    const { job } = await enqueue({
      kind: 'test.no_such_handler',
      idempotencyKey: `test.no_such_handler:${stamp}`,
      authorId,
    });
    const settled = await drain(job.id);
    assert.equal(Number(settled.id), Number(job.id));
    assert.equal(settled.status, 'dead_letter');
    assert.match(settled.last_error, /No handler registered/);
  });
});

describe('Crash recovery', () => {
  it('returns work abandoned by a worker that stopped mid-job', async () => {
    const { job } = await enqueue({
      kind: 'test.counts',
      idempotencyKey: `test.counts:${stamp}:stale`,
      authorId,
    });
    // A worker claimed it and never came back.
    await query(
      `UPDATE jobs SET status = 'running', attempts = 1,
              claimed_at = now() - ($2 || ' seconds')::interval
        WHERE id = $1`,
      [job.id, config.jobStaleSeconds + 60],
    );

    const reclaimed = await reapStaleJobs();
    assert.ok(reclaimed.some((j) => Number(j.id) === Number(job.id)));

    const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'queued', 'abandoned work should be picked up again');
    assert.match(rows[0].last_error, /stopped before finishing/);
  });

  it('counts the attempt, so a job that kills its worker still reaches a human', async () => {
    const { job } = await enqueue({
      kind: 'test.counts',
      idempotencyKey: `test.counts:${stamp}:poison`,
      authorId,
      maxAttempts: 2,
    });
    await query(
      `UPDATE jobs SET status = 'running', attempts = 2,
              claimed_at = now() - ($2 || ' seconds')::interval
        WHERE id = $1`,
      [job.id, config.jobStaleSeconds + 60],
    );

    await reapStaleJobs();
    const { rows } = await query('SELECT status FROM jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'dead_letter', 'a poison job must not be retried forever');
  });
});

describe('Two workers', () => {
  it('never hand the same job to both', async () => {
    const keys = [1, 2, 3, 4].map((n) => `test.counts:${stamp}:race${n}`);
    for (const key of keys) {
      await enqueue({ kind: 'test.counts', idempotencyKey: key, authorId });
    }

    // Four claims at once, the way two polling workers would overlap.
    const claimed = await Promise.all([runOnce(), runOnce(), runOnce(), runOnce()]);
    const ids = claimed.filter(Boolean).map((j) => Number(j.id));
    assert.equal(new Set(ids).size, ids.length, 'the same job was claimed twice');
  });
});
