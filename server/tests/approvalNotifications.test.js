/**
 * STORY-012 acceptance tests.
 *
 * The story has one Gherkin clause — "the agent holds the draft for human
 * approval **and** sends a notification" — and it is really two. The holding has
 * worked since STORY-001 and the first block re-asserts it across all four
 * things a human decides, because a story about the gate should check the gate.
 *
 * The second half is what was missing. Until this story `notifications` could
 * not reference anything but a press kit; its own constraint said
 * `num_nonnulls(pr_kit_id) = 1`. A social post could sit in `pending_approval`
 * for a week with no mechanism by which anyone could be told — an absence in the
 * schema, not a bug in the notifier.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ACTOR,
  QUEUES,
  findAwaitingApproval,
  notifyAwaitingApproval,
} from '../src/agents/approvalNotificationAgent.js';
import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { approveDraft } from '../src/services/approvals.js';
import { scheduleDraft } from '../src/services/scheduler.js';

/** Captures what would have been emailed, so assertions can read the digest. */
const recorder = () => {
  const sent = [];
  return {
    sent,
    async send({ to, subject, body }) {
      sent.push({ to, subject, body });
      return { externalId: `rec_${sent.length}`, acceptedAt: new Date().toISOString() };
    },
  };
};

let authorId;
let bookId;
let reviewerId;

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Approval Test Author', `approval-${Date.now()}@example.test`],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes)
     VALUES ($1,'The Quiet Craft',$2,$3) RETURNING *`,
    [
      authorId,
      'Attention is a muscle, and like any muscle it adapts to the load you give it.',
      ['attention', 'craft'],
    ],
  );
  bookId = b[0].id;
  await query(
    `INSERT INTO social_history (author_id, platform, content, posted_at)
     VALUES ($1,'twitter','Attention is a muscle and mine was weak today.', now()),
            ($1,'twitter','Craft is the slow accumulation of decisions nobody claps for.', now()),
            ($1,'twitter','The desk at 6am, just practice.', now())`,
    [authorId],
  );
  await draftWeeklyPosts({ authorId, bookId, count: 4 });
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-012: drafts are held for human approval', () => {
  it('creates every draft in a state a human still has to decide', async () => {
    const { rows } = await query('SELECT status FROM drafts WHERE author_id = $1', [authorId]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => ['pending_approval', 'escalated'].includes(r.status)));
  });

  it('refuses to publish one that has not been decided', async () => {
    const { rows } = await query(
      "SELECT id FROM drafts WHERE author_id = $1 AND status = 'pending_approval' LIMIT 1",
      [authorId],
    );
    await assert.rejects(() => scheduleDraft({ draftId: rows[0].id }), /not "approved"/);
  });

  it('covers all four things a human decides, in one queue', async () => {
    const queue = await findAwaitingApproval({ authorId });
    assert.ok(queue.total > 0);
    assert.deepEqual(
      QUEUES.map((q) => q.kind).sort(),
      ['draft', 'mixRecommendation', 'outreach', 'prMaterial'],
    );
  });

  it('reads what is waiting from the rows themselves, not a second copy', async () => {
    // A stored queue would be free to disagree with the statuses it mirrors —
    // the reason STORY-008's escalation queue is derived too.
    const before_ = await findAwaitingApproval({ authorId });
    const { rows } = await query(
      "SELECT id FROM drafts WHERE author_id = $1 AND status = 'pending_approval' LIMIT 1",
      [authorId],
    );
    await approveDraft({ draftId: rows[0].id, reviewer: 'Approval Tester' });
    const after_ = await findAwaitingApproval({ authorId });
    assert.equal(after_.total, before_.total - 1, 'approving something removes it from the queue');
  });
});

describe('STORY-012: and sends a notification', () => {
  it('could not have notified about a draft before this story', async () => {
    // The gap, stated as the schema stated it. Adding a notification row that
    // names no target at all is still refused, so the constraint is doing work.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO notifications (author_id, reviewer_id, channel, subject, body)
           VALUES ($1,$2,'email','x','y')`,
          [authorId, 1],
        ),
      /notifications_exactly_one_target/,
    );
  });

  it('records that work is waiting and nobody is configured to tell', async () => {
    const notifier = recorder();
    const result = await notifyAwaitingApproval({ authorId, notifier });
    assert.equal(result.unreachable, true);
    assert.equal(notifier.sent.length, 0);

    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'approval.unreachable' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0].metadata.waiting > 0, 'the silence is on the record, not passed over');
  });

  it('sends one digest per reviewer rather than one email per item', async () => {
    const { rows } = await query(
      `INSERT INTO reviewers (author_id, name, email, active)
       VALUES ($1,'Ali Reviewer',$2,true) RETURNING *`,
      [authorId, `ali-${Date.now()}@example.test`],
    );
    reviewerId = rows[0].id;

    const notifier = recorder();
    const result = await notifyAwaitingApproval({ authorId, notifier });

    assert.equal(notifier.sent.length, 1, 'one email');
    assert.ok(result.notified[0].items > 1, 'covering several items');
    assert.match(notifier.sent[0].subject, /items waiting on your approval/);
  });

  it('writes a row per item so the trail is per-decision', async () => {
    const { rows } = await query(
      'SELECT COUNT(*)::int n, COUNT(DISTINCT batch_id)::int b FROM notifications WHERE author_id = $1',
      [authorId],
    );
    assert.ok(rows[0].n > 1, 'many rows');
    assert.equal(rows[0].b, 1, 'one batch — one email');
  });

  it('names what is waiting, so the mail is worth opening', async () => {
    const { rows } = await query(
      'SELECT body FROM notifications WHERE author_id = $1 ORDER BY id LIMIT 1',
      [authorId],
    );
    assert.match(rows[0].body, /waiting on a decision from you/);
    assert.match(rows[0].body, /Post for/, 'and lists the individual items');
    assert.match(rows[0].body, /nothing will be until you decide/);
  });

  it('never announces the same item to the same reviewer twice', async () => {
    const notifier = recorder();
    const result = await notifyAwaitingApproval({ authorId, notifier });
    assert.equal(notifier.sent.length, 0, 'a second sweep sends nothing');
    assert.ok(result.skipped.length > 0, 'because every item was already announced');
  });

  it('announces only what is new when more work arrives', async () => {
    await draftWeeklyPosts({ authorId, bookId, count: 2, weekOf: '2026-09-07' });
    const notifier = recorder();
    const result = await notifyAwaitingApproval({ authorId, notifier });

    assert.equal(notifier.sent.length, 1);
    const announced = result.notified[0].items;
    const queue = await findAwaitingApproval({ authorId });
    assert.ok(
      announced < queue.total,
      'the digest covers the new items, not the whole pile again',
    );
  });

  it('is enforced by the database, not only by the query', async () => {
    const { rows } = await query(
      'SELECT draft_id FROM notifications WHERE author_id = $1 AND draft_id IS NOT NULL LIMIT 1',
      [authorId],
    );
    await assert.rejects(
      () =>
        query(
          `INSERT INTO notifications (author_id, reviewer_id, draft_id, channel, subject, body)
           VALUES ($1,$2,$3,'email','again','again')`,
          [authorId, reviewerId, rows[0].draft_id],
        ),
      /notifications_one_per_draft_reviewer/,
    );
  });

  it('logs that it told somebody and decided nothing', async () => {
    const { rows } = await query(
      `SELECT actor, metadata FROM audit_log
        WHERE author_id = $1 AND action = 'approval.notified' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.equal(rows[0].actor, ACTOR);
    assert.equal(rows[0].metadata.decided, false);
    assert.ok(rows[0].metadata.batchId);
  });

  it('does not move a single status when it runs', async () => {
    const before_ = await query(
      'SELECT id, status FROM drafts WHERE author_id = $1 ORDER BY id',
      [authorId],
    );
    await notifyAwaitingApproval({ authorId, notifier: recorder() });
    const after_ = await query(
      'SELECT id, status FROM drafts WHERE author_id = $1 ORDER BY id',
      [authorId],
    );
    assert.deepEqual(after_.rows, before_.rows, 'notifying is not deciding');
  });

  it('leaves press kits to the notifier that already mails about them', async () => {
    // Two agents emailing about one kit is the drift STORY-008 removed. Kits are
    // in the queue so a reviewer sees one list; the email comes from STORY-007.
    const prQueue = QUEUES.find((q) => q.kind === 'prMaterial');
    assert.equal(prQueue.notifies, false);

    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'approval.sweep_completed' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok('deferredToReviewNotifier' in rows[0].metadata, 'and says so on the log');
  });
});

describe('It runs unattended (REQ-004)', () => {
  it('is a recurring job the worker knows how to run', async () => {
    const { RECURRING, HANDLERS } = await import('../src/jobs/handlers.js');
    assert.ok(RECURRING.some((r) => r.kind === 'approvals.notify_waiting'));
    assert.equal(typeof HANDLERS['approvals.notify_waiting'], 'function');
  });

  it('is ordered by the coordinator, after the producers it reacts to', async () => {
    const { PRIORITIES, resourceFor } = await import('../src/services/coordination.js');
    assert.ok(PRIORITIES['approvals.notify_waiting'] < PRIORITIES['press.draft_approaching']);
    assert.equal(
      resourceFor({ kind: 'approvals.notify_waiting', author_id: 7 }),
      'author:7:approvals',
      'its own resource: it touches none of the press pipeline tables',
    );
  });
});
