/**
 * STORY-007 acceptance tests.
 *
 * The story's Gherkin — "Given a PR draft is pending review; When a human
 * reviews and approves the draft; Then the draft is marked as approved and
 * ready for distribution" — is the first `describe` block. It passed before
 * this story was started: STORY-003 built the review interface, the actions,
 * the decisions table and the audit trail.
 *
 * The rest cover build step 5, which had never been written — `grep -ri notif`
 * over the repo returned nothing — and which is half of REQ-006's acceptance
 * criteria: "the approval process includes notifications to relevant
 * stakeholders and is logged for traceability."
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftPressKit } from '../src/agents/prMaterialsAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial } from '../src/services/approvals.js';
import {
  ACTOR as NOTIFY_AGENT,
  findKitsAwaitingReview,
  notifyPendingReviews,
} from '../src/services/reviewNotifier.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

const BOOK_CONTENT = [
  'Craft is the slow accumulation of decisions nobody claps for.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it.',
  'Resilience is what remains when motivation has gone home for the evening.',
  'Deep work is a way of refusing the terms the world offers you by default.',
].join('\n\n');

/** Never fails, so a test asserting failure has to opt in explicitly. */
const okNotifier = {
  name: 'test-notifier',
  sent: [],
  async send({ to, subject, body }) {
    okNotifier.sent.push({ to, subject, body });
    return { externalId: `test_${okNotifier.sent.length}` };
  },
};

let authorId;
let bookId;

const createMilestone = async (title, daysAhead) => {
  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, location, details)
     VALUES ($1,$2,'launch',$3,$4,'Ljubljana','First print run.') RETURNING *`,
    [authorId, bookId, title, new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10)],
  );
  return rows[0];
};

const addReviewer = async (name, email, role = 'publisher') => {
  const { rows } = await query(
    'INSERT INTO reviewers (author_id, name, email, role) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, name, email, role],
  );
  return rows[0];
};

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Review Test Author',
      `review-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain'] }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,'The Quiet Craft',$2,$3,'2023-04-01') RETURNING *`,
    [authorId, BOOK_CONTENT, BOOK_THEMES],
  );
  bookId = bookRows[0].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-007: human review of PR drafts', () => {
  let materials;
  let kitId;

  before(async () => {
    const milestone = await createMilestone('Reviewable launch', 60);
    ({ materials, kit: { id: kitId } = {} } = await draftPressKit({ milestoneId: milestone.id }));
  });

  it('Given a PR draft is pending review, it is waiting on a human', () => {
    assert.ok(materials.length > 0);
    for (const material of materials) {
      assert.ok(
        ['pending_approval', 'escalated'].includes(material.status),
        `${material.type} was not waiting on anyone`,
      );
    }
  });

  it('When a human reviews and approves, Then the draft is marked approved', async () => {
    const release = materials.find((m) => m.type === 'press_release');
    const approved = await approvePrMaterial({
      materialId: release.id,
      reviewer: 'Dana the Publisher',
      notes: 'Reads well, cleared.',
    });
    assert.equal(approved.status, 'approved');
  });

  it('and the decision is recorded against a named human, with their notes', async () => {
    const release = materials.find((m) => m.type === 'press_release');
    const { rows } = await query(
      'SELECT * FROM approvals WHERE pr_material_id = $1 ORDER BY id DESC LIMIT 1',
      [release.id],
    );
    assert.equal(rows[0].decision, 'approved');
    assert.equal(rows[0].reviewer, 'Dana the Publisher');
    assert.equal(rows[0].notes, 'Reads well, cleared.');
  });

  it('and is ready for distribution only once every material is approved', async () => {
    const stillWaiting = await findKitsAwaitingReview({ authorId }, { query });
    assert.ok(
      stillWaiting.some((k) => Number(k.id) === Number(kitId)),
      'one approval should not release the whole kit',
    );

    for (const material of materials) {
      if (material.type !== 'press_release') {
        await approvePrMaterial({ materialId: material.id, reviewer: 'Dana the Publisher' });
      }
    }

    const cleared = await findKitsAwaitingReview({ authorId }, { query });
    assert.ok(
      !cleared.some((k) => Number(k.id) === Number(kitId)),
      'a fully approved kit is no longer awaiting review',
    );
  });
});

describe('Nobody to tell (build step 5, the unbuilt clause)', () => {
  let kitId;

  before(async () => {
    const milestone = await createMilestone('Unreachable launch', 70);
    ({ kit: { id: kitId } = {} } = await draftPressKit({ milestoneId: milestone.id }));
  });

  it('records that work is waiting and no reviewer exists, rather than passing over it', async () => {
    const result = await notifyPendingReviews({ authorId, notifier: okNotifier });
    assert.equal(result.unreachable, true);
    assert.deepEqual(result.notified, []);

    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'review.no_reviewers'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0], 'an unreachable queue must not be silent');
    assert.equal(rows[0].actor, NOTIFY_AGENT);
    assert.ok(rows[0].metadata.materialsAwaitingReview > 0);
  });

  it('notifies every active reviewer once one exists', async () => {
    await addReviewer('Dana Vogel', 'dana@example.test', 'publisher');
    await addReviewer('Sam Iyer', 'sam@example.test', 'publicist');

    const result = await notifyPendingReviews({ authorId, notifier: okNotifier });
    assert.equal(result.unreachable, false);

    // Asserts that both reviewers *were told*, not that this call did the
    // telling. `reviews.notify_pending` is a recurring job, so any suite that
    // ticks the worker can notify these reviewers first — and notification is
    // idempotent per kit per reviewer, so this call then correctly sends
    // nothing. STORY-008 hit the same coupling and fixed it the same way.
    const { rows } = await query(
      `SELECT DISTINCT r.email FROM notifications n
         JOIN reviewers r ON r.id = n.reviewer_id
        WHERE n.author_id = $1 AND n.pr_kit_id IS NOT NULL`,
      [authorId],
    );
    const told = rows.map((r) => r.email).sort();
    assert.deepEqual(told, ['dana@example.test', 'sam@example.test'], 'both stakeholders told');
  });

  it('says what is waiting, so the mail is worth opening', async () => {
    // Read from the row rather than the spy, for the same reason: the send that
    // produced it may have come from the worker rather than from this suite.
    const { rows } = await query(
      `SELECT subject, body FROM notifications
        WHERE author_id = $1 AND pr_kit_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    const mail = rows[0];
    assert.ok(mail, 'a notification was written');
    assert.match(mail.subject, /awaiting your review/i);
    assert.match(mail.body, /Unreachable launch/);
    assert.match(mail.body, /Nothing in this kit can be distributed until every material/);
    assert.match(mail.body, /Awaiting review: \d+/);
  });

  it('describes a won award as a win, not by the title it was scheduled under', async () => {
    // A won award keeps the title it went on the calendar with ("shortlisted
    // for X"). Subject-lining a reviewer with that title would describe the win
    // kit as the shortlist one — the exact confusion STORY-005 made data.
    const { rows: award } = await query(
      `INSERT INTO milestones (author_id, book_id, type, title, event_date, award_name, outcome)
       VALUES ($1,$2,'award','The Quiet Craft shortlisted for the Vermilion Prize',$3,
               'Vermilion Prize','won') RETURNING *`,
      [authorId, bookId, new Date(Date.now() + 130 * 86400000).toISOString().slice(0, 10)],
    );
    await draftPressKit({ milestoneId: award[0].id });

    const before = okNotifier.sent.length;
    await notifyPendingReviews({ authorId, notifier: okNotifier });
    const mails = okNotifier.sent.slice(before);
    const about = mails.filter((m) => m.body.includes('Vermilion Prize'));

    assert.ok(about.length > 0, 'the award kit should have been notified about');
    for (const mail of about) {
      assert.match(mail.subject, /award win/, 'the subject must say it is a win');
      assert.doesNotMatch(
        mail.subject,
        /shortlist/i,
        'the subject must not describe a win as a shortlisting',
      );
    }
  });

  it('does not tell the same reviewer about the same kit twice', async () => {
    const before = okNotifier.sent.length;
    const result = await notifyPendingReviews({ authorId, notifier: okNotifier });

    assert.deepEqual(result.notified, [], 'a second run should send nothing new');
    assert.equal(okNotifier.sent.length, before, 'no reviewer should be re-mailed');
    assert.ok(result.skipped.length >= 2);

    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE pr_kit_id = $1',
      [kitId],
    );
    assert.equal(rows[0].n, 2, 'one notification per reviewer per kit');
  });

  it('stops notifying a deactivated reviewer without losing what they were sent', async () => {
    const { rows: sam } = await query(
      "SELECT * FROM reviewers WHERE author_id = $1 AND email = 'sam@example.test'",
      [authorId],
    );
    await query('UPDATE reviewers SET active = FALSE WHERE id = $1', [sam[0].id]);

    const milestone = await createMilestone('After Sam left', 80);
    await draftPressKit({ milestoneId: milestone.id });

    const result = await notifyPendingReviews({ authorId, notifier: okNotifier });
    assert.ok(
      result.notified.every((n) => Number(n.reviewer_id) !== Number(sam[0].id)),
      'a deactivated reviewer should not be mailed',
    );

    const { rows: history } = await query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE reviewer_id = $1',
      [sam[0].id],
    );
    assert.ok(history[0].n > 0, 'their earlier notifications are still on the record');

    await query('UPDATE reviewers SET active = TRUE WHERE id = $1', [sam[0].id]);
  });
});

describe('TBI: notifying is not deciding', () => {
  it('leaves every status exactly as it found it', async () => {
    const milestone = await createMilestone('Untouched by the notifier', 100);
    const { materials } = await draftPressKit({ milestoneId: milestone.id });
    const before = materials.map((m) => `${m.id}:${m.status}`).sort();

    await notifyPendingReviews({ authorId, notifier: okNotifier });

    const { rows } = await query(
      'SELECT id, status FROM pr_materials WHERE id = ANY($1)',
      [materials.map((m) => m.id)],
    );
    assert.deepEqual(
      rows.map((r) => `${r.id}:${r.status}`).sort(),
      before,
      'the notifier must not advance anything through the gate',
    );
  });

  it('never notifies about withdrawn copy', async () => {
    const { rows: kit } = await query(
      `SELECT k.id FROM pr_kits k
        WHERE k.author_id = $1 AND k.status = 'drafting' ORDER BY k.id DESC LIMIT 1`,
      [authorId],
    );
    await query("UPDATE pr_kits SET status = 'superseded' WHERE id = $1", [kit[0].id]);

    const waiting = await findKitsAwaitingReview({ authorId }, { query });
    assert.ok(
      !waiting.some((k) => Number(k.id) === Number(kit[0].id)),
      'a reviewer should not be sent to copy the system will refuse to let them decide',
    );

    await query("UPDATE pr_kits SET status = 'drafting' WHERE id = $1", [kit[0].id]);
  });

  it('records a failed send as failed rather than dropping it', async () => {
    const failing = {
      name: 'test-failing-notifier',
      async send() {
        throw new Error('mailbox unavailable');
      },
    };
    const milestone = await createMilestone('Undeliverable', 110);
    await draftPressKit({ milestoneId: milestone.id });

    const result = await notifyPendingReviews({ authorId, notifier: failing });
    const failed = result.notified.filter((n) => n.status === 'failed');
    assert.ok(failed.length > 0, 'the failure should be recorded, not swallowed');
    assert.match(failed[0].error, /mailbox unavailable/);

    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'review.notification_failed'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0], 'a failed notification belongs on the log too');
    assert.equal(rows[0].actor, NOTIFY_AGENT);
  });
});

describe('TBI: the notification trail', () => {
  it('logs who was told, about what, under the notification agent', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'review.notified'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0]);
    assert.equal(rows[0].actor, NOTIFY_AGENT);
    assert.ok(rows[0].metadata.recipient.includes('@'));
    assert.ok(rows[0].metadata.pendingCount > 0);
    assert.ok(rows[0].metadata.kitId);
  });
});
