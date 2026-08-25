/**
 * STORY-001 acceptance tests.
 *
 * The two `describe` blocks map one-to-one onto the Gherkin scenarios on the
 * Basecamp story; the remaining blocks cover the Trust-Before-Intelligence
 * controls the story requires (audit log, approval gate, escalation).
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts, scoreDraft, weekStart } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approveDraft, rejectDraft } from '../src/services/approvals.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { nextOptimalSlot, publishDue, scheduleDraft } from '../src/services/scheduler.js';

let authorId;
let bookId;

/** Isolates each run from previous ones without touching the append-only log. */
before(async () => {
  const { rows: authorRows } = await query(
    `INSERT INTO authors (name, email, voice_profile)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [
      'Test Author',
      `test-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain', 'warm'] }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [
      authorId,
      'The Quiet Craft',
      'Attention is a muscle, and like any muscle it adapts to the load you give it. ' +
        'Craft is the slow accumulation of decisions nobody claps for and nobody sees. ' +
        'Resilience is what remains when motivation has gone home for the evening. ' +
        'Deep work is a way of refusing the terms the world offers you by default.',
      ['deep work', 'craft', 'attention', 'resilience'],
    ],
  );
  bookId = bookRows[0].id;

  for (const content of [
    'Craft is the slow accumulation of decisions nobody claps for.',
    'Attention is a muscle and mine was weak today. Showed up anyway.',
    'Deep work is a refusal of interruption as a default condition.',
  ]) {
    await query(
      'INSERT INTO social_history (author_id, platform, content, posted_at) VALUES ($1,$2,$3,now())',
      [authorId, 'twitter', content],
    );
  }
});

after(async () => {
  await closePool();
});

describe('Scenario: Drafting social media content', () => {
  it('creates at least three posts for the week, each tailored to a platform', async () => {
    const platforms = ['twitter', 'instagram', 'linkedin'];
    const drafts = await draftWeeklyPosts({ authorId, bookId, count: 3, platforms });

    assert.ok(
      drafts.length >= config.minPostsPerWeek,
      `expected >= ${config.minPostsPerWeek} drafts, got ${drafts.length}`,
    );

    const covered = new Set(drafts.map((d) => d.platform));
    assert.deepEqual([...covered].sort(), [...platforms].sort(), 'every platform is covered');

    const { rows } = await query('SELECT max_chars, platform FROM platform_windows');
    const limits = new Map(rows.map((r) => [r.platform, r.max_chars]));
    for (const draft of drafts) {
      assert.ok(
        draft.content.length <= limits.get(draft.platform),
        `${draft.platform} draft fits the platform limit`,
      );
    }
  });

  it('grounds every draft in the book themes and the author voice', async () => {
    const { rows } = await query('SELECT * FROM drafts WHERE author_id = $1', [authorId]);
    assert.ok(rows.length > 0);

    for (const draft of rows) {
      assert.ok(draft.themes_used.length > 0, 'draft records which themes it used');
      const bookThemes = ['deep work', 'craft', 'attention', 'resilience'];
      assert.ok(
        draft.themes_used.every((t) => bookThemes.includes(t)),
        `themes ${draft.themes_used} all come from the book`,
      );
      assert.ok(Number(draft.confidence) > 0, 'draft carries a confidence score');
      // `grounding=` was STORY-001's label-reuse measure; STORY-009 replaced it
      // with `themes=` scored against retrieved evidence. Either satisfies what
      // this criterion actually asks: the number has to be explainable.
      assert.match(
        draft.rationale,
        /(themes|grounding)=.*voice=.*fit=/,
        'confidence is explainable',
      );
    }
  });

  it('buckets drafts into the current ISO week so cadence is measurable', async () => {
    const { rows } = await query(
      'SELECT week_of, COUNT(*)::int AS total FROM drafts WHERE author_id = $1 GROUP BY week_of',
      [authorId],
    );
    const thisWeek = rows.find((r) => r.week_of.toISOString().slice(0, 10) === weekStart());
    assert.ok(thisWeek, 'drafts land in the current week bucket');
    assert.ok(thisWeek.total >= config.minPostsPerWeek);
  });

  it('never creates a draft that is already publishable', async () => {
    const { rows } = await query('SELECT DISTINCT status FROM drafts WHERE author_id = $1', [authorId]);
    for (const row of rows) {
      assert.ok(
        ['pending_approval', 'escalated'].includes(row.status),
        `new drafts start behind the gate, saw "${row.status}"`,
      );
    }
  });
});

describe('Scenario: Scheduling social media content', () => {
  it('queues an approved post at an optimal time for its platform', async () => {
    const { rows } = await query(
      "SELECT * FROM drafts WHERE author_id = $1 AND status = 'pending_approval' LIMIT 1",
      [authorId],
    );
    const draft = rows[0];
    assert.ok(draft, 'a pending draft is available');

    await approveDraft({ draftId: draft.id, reviewer: 'Reviewer One', notes: 'ok' });
    const scheduled = await scheduleDraft({ draftId: draft.id });

    assert.equal(scheduled.status, 'queued');
    assert.ok(scheduled.scheduled_for > new Date(), 'slot is in the future');

    const { rows: windows } = await query('SELECT * FROM platform_windows WHERE platform = $1', [
      draft.platform,
    ]);
    const slot = new Date(scheduled.scheduled_for);
    assert.ok(
      windows[0].best_hours.includes(slot.getUTCHours()),
      `hour ${slot.getUTCHours()} is one of ${draft.platform}'s best hours`,
    );
    const isoDay = slot.getUTCDay() === 0 ? 7 : slot.getUTCDay();
    assert.ok(windows[0].best_days.includes(isoDay), 'day is one of the platform best days');

    const { rows: after } = await query('SELECT status FROM drafts WHERE id = $1', [draft.id]);
    assert.equal(after[0].status, 'scheduled');
  });

  it('spaces posts on the same platform rather than stacking them', () => {
    const window = { platform: 'twitter', best_hours: [13, 15, 17], best_days: [1, 2, 3, 4, 5] };
    const from = new Date('2026-08-10T08:00:00Z'); // a Monday
    const first = nextOptimalSlot({ window, from, taken: [] });
    const second = nextOptimalSlot({ window, from, taken: [first] });

    assert.notEqual(first.toISOString(), second.toISOString());
    assert.ok(Math.abs(second - first) >= 60 * 60 * 1000, 'slots are at least an hour apart');
  });

  it('publishes a due post through the mocked platform adapter', async () => {
    const published = await publishDue({ now: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) });
    assert.ok(published.length > 0, 'at least one post was due');
    const ok = published.find((p) => p.status === 'published');
    assert.ok(ok, 'a post reached the mocked platform');
    assert.match(ok.external_id, /^[a-z]+_\d{6}$/, 'platform returned an id');
  });
});

describe('Approval gate (REQ-006)', () => {
  it('refuses to schedule a draft that has not been approved', async () => {
    const [draft] = await draftWeeklyPosts({
      authorId,
      bookId,
      count: 1,
      platforms: ['facebook'],
    });

    await assert.rejects(
      () => scheduleDraft({ draftId: draft.id }),
      /not "approved"/,
      'the gate rejects unapproved content',
    );

    const { rows } = await query('SELECT status FROM scheduled_posts WHERE draft_id = $1', [draft.id]);
    assert.equal(rows.length, 0, 'nothing was queued');
  });

  it('logs the refused attempt even though the transaction rolled back', async () => {
    const log = await listAuditLog({ authorId, entityType: 'draft', limit: 50 });
    assert.ok(
      log.some((entry) => entry.action === 'schedule.blocked'),
      'a blocked attempt is on the record',
    );
  });

  it('refuses to schedule a rejected draft', async () => {
    const [draft] = await draftWeeklyPosts({ authorId, bookId, count: 1, platforms: ['facebook'] });
    await rejectDraft({ draftId: draft.id, reviewer: 'Reviewer One', notes: 'off voice' });

    await assert.rejects(() => scheduleDraft({ draftId: draft.id }), /not "approved"/);
  });

  it('will not let the same draft be decided twice', async () => {
    const [draft] = await draftWeeklyPosts({ authorId, bookId, count: 1, platforms: ['facebook'] });
    await approveDraft({ draftId: draft.id, reviewer: 'Reviewer One' });

    await assert.rejects(
      () => rejectDraft({ draftId: draft.id, reviewer: 'Reviewer Two' }),
      /can no longer be decided/,
    );
  });

  it('requires a named reviewer', async () => {
    const [draft] = await draftWeeklyPosts({ authorId, bookId, count: 1, platforms: ['facebook'] });
    await assert.rejects(() => approveDraft({ draftId: draft.id, reviewer: '' }), /reviewer name/);
  });
});

describe('Escalation on low confidence (TBI)', () => {
  it('escalates a draft that is not grounded in the book', () => {
    const { confidence } = scoreDraft({
      content: 'Buy my book today! Limited time offer!!! Click the link in bio now!!!',
      themesUsed: [],
      bookThemes: ['deep work', 'craft', 'attention', 'resilience'],
      history: [{ content: 'Craft is the slow accumulation of decisions nobody claps for.' }],
      maxChars: 280,
    });

    assert.ok(
      confidence < config.confidenceEscalationThreshold,
      `ungrounded copy scores ${confidence}, below the ${config.confidenceEscalationThreshold} threshold`,
    );
  });

  it('scores a grounded, on-voice draft above the threshold', () => {
    const { confidence } = scoreDraft({
      content: 'Craft is the slow accumulation of decisions nobody claps for. That is deep work.',
      themesUsed: ['craft', 'deep work'],
      bookThemes: ['deep work', 'craft', 'attention', 'resilience'],
      history: [
        { content: 'Craft is the slow accumulation of decisions nobody claps for.' },
        { content: 'Deep work is a refusal of interruption as a default condition.' },
      ],
      maxChars: 280,
    });

    assert.ok(confidence >= config.confidenceEscalationThreshold, `grounded copy scored ${confidence}`);
  });

  it('penalises a draft that overflows the platform limit', () => {
    const long = 'attention and craft '.repeat(40);
    const { confidence } = scoreDraft({
      content: long,
      themesUsed: ['craft'],
      bookThemes: ['craft', 'attention'],
      history: [{ content: 'craft and attention' }],
      maxChars: 280,
    });
    assert.ok(confidence < 1, 'overflow reduces confidence');
  });
});

describe('Append-only audit log (REQ-005)', () => {
  it('records who did what, with before and after state', async () => {
    const log = await listAuditLog({ authorId, limit: 100 });
    assert.ok(log.length > 0);

    const created = log.find((e) => e.action === 'draft.created');
    assert.ok(created, 'draft creation is logged');
    assert.equal(created.actor, 'ContentDraftingAgent');
    assert.ok(created.after, 'after-state captured');

    const approved = log.find((e) => e.action === 'draft.approved');
    assert.ok(approved, 'approval is logged');
    assert.equal(approved.actor, 'Reviewer One', 'the human reviewer is named');
    assert.ok(approved.before && approved.after, 'before and after captured');
    assert.notEqual(approved.before.status, approved.after.status);
  });

  it('rejects UPDATE at the database level', async () => {
    const [entry] = await listAuditLog({ authorId, limit: 1 });
    await assert.rejects(
      () => query('UPDATE audit_log SET action = $1 WHERE id = $2', ['tampered', entry.id]),
      /append-only/,
    );
  });

  it('rejects DELETE at the database level', async () => {
    const [entry] = await listAuditLog({ authorId, limit: 1 });
    await assert.rejects(() => query('DELETE FROM audit_log WHERE id = $1', [entry.id]), /append-only/);
  });

  it('rejects TRUNCATE at the database level', async () => {
    await assert.rejects(() => query('TRUNCATE audit_log'), /append-only/);
  });
});
