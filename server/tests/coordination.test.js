/**
 * STORY-011 acceptance tests.
 *
 * The story's Gherkin — "Given multiple agents are operating simultaneously;
 * When tasks are distributed; Then the agent resolves conflicts using a
 * priority-based algorithm and enforces compliance" — is the first `describe`.
 *
 * The regression test is the one that matters. STORY-065 built the queue to
 * support more than one worker and it does; what it could not say was that
 * `press.draft_approaching` PRODUCES the materials `trust.monitor_escalations`
 * consumes. Run on two workers, the drafter created six materials and the
 * monitor examined *zero* of them, because it read the table while the
 * drafter's transaction was still open. With one worker the order was right by
 * accident — RECURRING is declared producer-first and ids ascend.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ACTOR as COORDINATOR,
  DEFAULT_PRIORITY,
  PRIORITIES,
  planFor,
  priorityFor,
  resourceFor,
} from '../src/services/coordination.js';
import { closePool, query } from '../src/db/pool.js';
import { enqueue, runOnce } from '../src/jobs/queue.js';

let authorId;
let otherAuthorId;

/**
 * Only this suite's rows.
 *
 * An earlier draft cleared the whole `jobs` table in `beforeEach`, which
 * deleted work other suites had queued and broke them — the same cross-suite
 * coupling STORY-008 hit from the other direction. A test that needs a clean
 * queue does not get to give everyone else one.
 */
const clearQueue = () =>
  query('DELETE FROM jobs WHERE author_id = ANY($1)', [[authorId, otherAuthorId]]);

/**
 * The claim order, restricted to this suite's authors.
 *
 * Mirrors the ORDER BY inside `claim` rather than draining the queue, because
 * draining would run other suites' sweeps as a side effect.
 */
const queued = async () => {
  const { rows } = await query(
    `SELECT kind, author_id, priority, resource, status FROM jobs
      WHERE status = 'queued' AND author_id = ANY($1)
      ORDER BY priority DESC, run_at, id`,
    [[authorId, otherAuthorId]],
  );
  return rows;
};

before(async () => {
  const { rows } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2), ($3,$4) RETURNING *',
    [
      'Coordination Test Author',
      `coord-${Date.now()}@example.test`,
      'Coordination Other Author',
      `coord-other-${Date.now()}@example.test`,
    ],
  );
  authorId = rows[0].id;
  otherAuthorId = rows[1].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1)', [[authorId, otherAuthorId]]);
  await closePool();
});

describe('STORY-011: tasks are managed across agents', () => {
  beforeEach(clearQueue);

  it('resolves the order with a priority-based algorithm, not arrival order', async () => {
    // Enqueued deliberately worst-first: under STORY-065's FIFO claim this is
    // exactly the order they would have run in.
    await enqueue({ kind: 'reviews.notify_pending', idempotencyKey: 'c-notify', authorId });
    await enqueue({ kind: 'trust.monitor_escalations', idempotencyKey: 'c-monitor', authorId });
    await enqueue({ kind: 'press.draft_approaching', idempotencyKey: 'c-draft', authorId });
    await enqueue({
      kind: 'outreach.send',
      idempotencyKey: 'c-send',
      authorId,
      payload: { messageId: 1 },
    });

    assert.deepEqual(
      (await queued()).map((j) => j.kind),
      [
        'outreach.send',
        'press.draft_approaching',
        'trust.monitor_escalations',
        'reviews.notify_pending',
      ],
      'the exact reverse of the order they were queued in',
    );
  });

  it('enforces compliance by logging every distribution as it is made', async () => {
    const { job: pending } = await enqueue({
      kind: 'reviews.notify_pending',
      idempotencyKey: 'c-log',
      authorId,
    });
    const job = await runOnce({ jobId: pending.id });
    assert.ok(job);

    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE actor = $1 AND action = 'task.dispatched' AND entity_id = $2`,
      [COORDINATOR, String(job.id)],
    );
    assert.equal(rows.length, 1, 'the coordinator records what it handed out');
    assert.equal(rows[0].metadata.kind, 'reviews.notify_pending');
    assert.equal(rows[0].metadata.priority, PRIORITIES['reviews.notify_pending']);
  });

  it('does not re-implement the approval gate it coordinates around', async () => {
    // The gate lives in the service and has since STORY-001. A coordinator that
    // re-checked approval would be a second copy of the rule, free to drift —
    // the mistake STORY-008 existed to clean up. Assert the coordinator's own
    // module has no opinion about approval at all.
    const module = await import('../src/services/coordination.js');
    const surface = Object.keys(module).join(' ').toLowerCase();
    assert.ok(!surface.includes('approve'), 'coordination exposes no approval logic');
  });
});

describe('The ordering nothing expressed (the STORY-065 regression)', () => {
  beforeEach(clearQueue);

  it('runs the producer before the agents that consume what it produced', async () => {
    // Queued consumer-first, which is the order STORY-065's FIFO claim would
    // have used and the order that produced "examined 0" on two workers.
    for (const [kind, key] of [
      ['reviews.notify_pending', 'r-notify'],
      ['trust.monitor_escalations', 'r-monitor'],
      ['press.draft_approaching', 'r-draft'],
    ]) {
      await enqueue({ kind, idempotencyKey: key, authorId });
    }

    assert.deepEqual(
      (await queued()).map((j) => j.kind),
      [
        'press.draft_approaching',
        'trust.monitor_escalations',
        'reviews.notify_pending',
      ],
      'the drafter is reached first however they arrived',
    );
  });

  it('never runs two agents against one author press pipeline at once', async () => {
    await enqueue({ kind: 'press.draft_approaching', idempotencyKey: 'x-draft', authorId });
    await enqueue({ kind: 'trust.monitor_escalations', idempotencyKey: 'x-monitor', authorId });

    // Hold the first job in 'running' the way a slow worker would.
    const { rows: held } = await query(
      `UPDATE jobs SET status = 'running', claimed_at = now()
        WHERE kind = 'press.draft_approaching' AND author_id = $1 RETURNING *`,
      [authorId],
    );
    assert.equal(held.length, 1);

    const { rows: monitor } = await query(
      `SELECT id FROM jobs WHERE idempotency_key = 'x-monitor'`,
    );
    const blocked = await runOnce({ jobId: monitor[0].id });
    assert.equal(blocked, null, 'the monitor waits rather than reading a half-written table');

    await query("UPDATE jobs SET status = 'done' WHERE id = $1", [held[0].id]);
    const freed = await runOnce({ jobId: monitor[0].id });
    assert.equal(freed.kind, 'trust.monitor_escalations', 'and runs once the resource is released');
  });

  it('still runs two different authors in parallel', async () => {
    await enqueue({ kind: 'press.draft_approaching', idempotencyKey: 'p-a', authorId });
    await enqueue({
      kind: 'press.draft_approaching',
      idempotencyKey: 'p-b',
      authorId: otherAuthorId,
    });

    await query(
      `UPDATE jobs SET status = 'running', claimed_at = now()
        WHERE idempotency_key = 'p-a'`,
    );

    const { rows: theirs } = await query("SELECT id FROM jobs WHERE idempotency_key = 'p-b'");
    const other = await runOnce({ jobId: theirs[0].id });
    assert.ok(other, 'one tenant holding its own pipeline must not stall another');
    assert.equal(Number(other.author_id), Number(otherAuthorId));
  });

  it('arbitrates a dead heat in the database rather than in the claim query', async () => {
    await enqueue({ kind: 'press.draft_approaching', idempotencyKey: 'race-1', authorId });
    await query("UPDATE jobs SET status = 'running' WHERE idempotency_key = 'race-1'");

    // A second job naming the same resource cannot also be running.
    await enqueue({ kind: 'trust.monitor_escalations', idempotencyKey: 'race-2', authorId });
    await assert.rejects(
      () => query("UPDATE jobs SET status = 'running' WHERE idempotency_key = 'race-2'"),
      /jobs_one_running_per_resource/,
      'the unique index is the arbiter, not the SELECT that preceded it',
    );
  });

  it('reports an idle pass rather than an error when it loses that race', async () => {
    await enqueue({ kind: 'press.draft_approaching', idempotencyKey: 'idle-1', authorId });
    await query("UPDATE jobs SET status = 'running' WHERE idempotency_key = 'idle-1'");
    await enqueue({ kind: 'reviews.notify_pending', idempotencyKey: 'idle-2', authorId });

    // The remaining candidate needs the held resource, so there is nothing to
    // claim — and that is a quiet null, not a throw.
    const { rows: blocked } = await query("SELECT id FROM jobs WHERE idempotency_key = 'idle-2'");
    assert.equal(await runOnce({ jobId: blocked[0].id }), null);
  });
});

describe('What the coordinator decides, and records on the row', () => {
  beforeEach(clearQueue);

  it('ranks outbound human-authorised work above every internal sweep', () => {
    assert.ok(PRIORITIES['outreach.send'] > PRIORITIES['press.draft_approaching']);
    assert.ok(PRIORITIES['posts.publish_due'] > PRIORITIES['press.draft_approaching']);
    assert.ok(
      PRIORITIES['press.draft_approaching'] > PRIORITIES['trust.monitor_escalations'],
      'producers outrank the consumers that react to them',
    );
    assert.ok(
      PRIORITIES['trust.monitor_escalations'] > PRIORITIES['reviews.notify_pending'],
      'telling a human comes last, so it covers what the monitor just raised',
    );
  });

  it('puts an unclassified kind between outbound work and housekeeping', () => {
    assert.equal(priorityFor('something.new'), DEFAULT_PRIORITY);
    assert.ok(DEFAULT_PRIORITY < PRIORITIES['outreach.send']);
    assert.ok(DEFAULT_PRIORITY > PRIORITIES['reviews.notify_pending']);
  });

  it('scopes the press resource per author, not globally', () => {
    assert.equal(
      resourceFor({ kind: 'press.draft_approaching', author_id: 7 }),
      'author:7:press',
    );
    assert.equal(
      resourceFor({ kind: 'trust.monitor_escalations', author_id: 7 }),
      'author:7:press',
      'three stages of one pipeline share one resource',
    );
  });

  it('gives a job with no contention no resource at all', () => {
    assert.equal(resourceFor({ kind: 'something.new', author_id: 7 }), null);
  });

  it('refuses to build a resource key out of a missing id', () => {
    // "outreach:undefined" would be one resource shared by every malformed job,
    // which is a worse failure than no exclusion.
    assert.equal(resourceFor({ kind: 'outreach.send', payload: {} }), null);
    assert.equal(resourceFor({ kind: 'press.draft_approaching', author_id: null }), null);
  });

  it('writes the decision onto the job so a stalled queue can be explained', async () => {
    await enqueue({
      kind: 'outreach.send',
      idempotencyKey: 'plan-1',
      authorId,
      payload: { messageId: 42 },
    });
    const { rows } = await query("SELECT * FROM jobs WHERE idempotency_key = 'plan-1'");
    assert.equal(rows[0].priority, PRIORITIES['outreach.send']);
    assert.equal(rows[0].resource, 'outreach:42');
    assert.equal(rows[0].coordination.decidedBy, COORDINATOR);
    assert.match(rows[0].coordination.reason, /human authorised/);
  });

  it('explains a consumer differently from a producer', () => {
    assert.match(planFor({ kind: 'press.draft_approaching', author_id: 1 }).coordination.reason, /produces/);
    assert.match(planFor({ kind: 'reviews.notify_pending', author_id: 1 }).coordination.reason, /reacts/);
  });

  it('gives two approved emails no reason to wait for each other', () => {
    const a = resourceFor({ kind: 'outreach.send', payload: { messageId: 1 } });
    const b = resourceFor({ kind: 'outreach.send', payload: { messageId: 2 } });
    assert.notEqual(a, b);
  });
});
