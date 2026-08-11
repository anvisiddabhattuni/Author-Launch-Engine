/**
 * STORY-002 acceptance tests.
 *
 * The first two `describe` blocks map one-to-one onto the Gherkin scenarios on
 * the Basecamp story; the rest cover the Trust-Before-Intelligence controls the
 * story requires (audit log, approval gate before sending, escalation).
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { monthStart, scoutOpportunities } from '../src/agents/opportunityScoutingAgent.js';
import { draftOutreachMessages, scoreMessage } from '../src/agents/prOutreachAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approveOutreach, rejectOutreach } from '../src/services/approvals.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { searchAllDirectories } from '../src/services/directories.js';
import { scoreOpportunity } from '../src/services/keywordAnalysis.js';
import { sendOutreachMessage } from '../src/services/outreachSender.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

let authorId;
let bookId;

before(async () => {
  const { rows: authorRows } = await query(
    `INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *`,
    [
      'Outreach Test Author',
      `outreach-${Date.now()}@example.test`,
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
      BOOK_THEMES,
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

describe('Scenario: Identifying opportunities', () => {
  it('identifies at least five relevant opportunities for the month', async () => {
    const result = await scoutOpportunities({ authorId, bookId });

    assert.ok(
      result.identified.length >= config.minOpportunitiesPerMonth,
      `expected >= ${config.minOpportunitiesPerMonth} opportunities, got ${result.identified.length}`,
    );
    assert.equal(result.month, monthStart());
  });

  it('categorizes them by type', async () => {
    const { rows } = await query(
      `SELECT type, COUNT(*)::int AS total FROM opportunities
        WHERE author_id = $1 GROUP BY type ORDER BY type`,
      [authorId],
    );
    const types = rows.map((r) => r.type);

    assert.deepEqual(types, ['event', 'podcast', 'speaking'], 'all three types are represented');
    for (const row of rows) assert.ok(row.total > 0);
  });

  it('rejects listings that do not match the book, rather than storing noise', async () => {
    const listings = await searchAllDirectories({});
    const offTopic = listings.find((l) => l.name === 'Regional Logistics Expo');
    const { relevance } = scoreOpportunity({ listing: offTopic, bookThemes: BOOK_THEMES });

    assert.ok(relevance < config.relevanceThreshold, `logistics expo scored ${relevance}`);

    const { rows } = await query(
      'SELECT 1 FROM opportunities WHERE author_id = $1 AND name = $2',
      [authorId, 'Regional Logistics Expo'],
    );
    assert.equal(rows.length, 0, 'off-topic listing was never recorded');
  });

  it('scores a single strong theme match as relevant', () => {
    // Regression: an earlier formula weighted breadth over strength, so a
    // podcast squarely about one theme scored below the threshold.
    const { relevance, matchedThemes } = scoreOpportunity({
      listing: {
        topics: ['attention', 'focus'],
        description: 'A show about attention and focus in modern work.',
      },
      bookThemes: BOOK_THEMES,
    });

    assert.deepEqual(matchedThemes, ['attention']);
    assert.ok(relevance >= config.relevanceThreshold, `single-theme match scored ${relevance}`);
  });

  it('is idempotent, so rescanning does not inflate the monthly count', async () => {
    const before = await query('SELECT COUNT(*)::int AS n FROM opportunities WHERE author_id = $1', [
      authorId,
    ]);
    const rescan = await scoutOpportunities({ authorId, bookId });
    const after = await query('SELECT COUNT(*)::int AS n FROM opportunities WHERE author_id = $1', [
      authorId,
    ]);

    assert.equal(rescan.identified.length, 0, 'nothing new on a repeat scan');
    assert.equal(after.rows[0].n, before.rows[0].n, 'count is unchanged');
  });

  it('records every identified opportunity in the audit log', async () => {
    const log = await listAuditLog({ authorId, entityType: 'opportunity', limit: 50 });
    assert.ok(log.length >= config.minOpportunitiesPerMonth);
    for (const entry of log) {
      assert.equal(entry.action, 'opportunity.identified');
      assert.equal(entry.actor, 'OpportunityScoutingAgent');
      assert.ok(entry.after, 'the recorded opportunity is captured');
    }
  });
});

describe('Scenario: Drafting outreach messages', () => {
  let messages;

  it('drafts a message for each identified opportunity', async () => {
    messages = await draftOutreachMessages({ authorId, bookId, limit: 10 });
    assert.ok(messages.length >= config.minOpportunitiesPerMonth);
  });

  it('personalizes each message to its opportunity', async () => {
    for (const message of messages) {
      const haystack = `${message.subject}\n${message.body}`.toLowerCase();

      assert.ok(
        haystack.includes(message.opportunity.name.toLowerCase()),
        `message ${message.id} names "${message.opportunity.name}"`,
      );
      assert.ok(
        haystack.includes(message.opportunity.host.split(' ')[0].toLowerCase()),
        `message ${message.id} greets the host by name`,
      );
      assert.ok(message.personalization.length > 0, 'personalization tokens recorded');
    }
  });

  it('frames the ask differently per opportunity type', async () => {
    const byType = new Map(messages.map((m) => [m.opportunity.type, m]));
    assert.ok(byType.has('podcast') && byType.has('speaking'), 'multiple types drafted');
    assert.notEqual(
      byType.get('podcast').subject.replace(/[^a-z ]/gi, ''),
      byType.get('speaking').subject.replace(/[^a-z ]/gi, ''),
      'a podcast pitch and a speaker proposal are not the same ask',
    );
  });

  it('holds every message for human review rather than sending it', async () => {
    const { rows } = await query(
      'SELECT DISTINCT status FROM outreach_messages WHERE author_id = $1',
      [authorId],
    );
    for (const row of rows) {
      assert.ok(
        ['pending_approval', 'escalated'].includes(row.status),
        `new messages start behind the gate, saw "${row.status}"`,
      );
    }

    const { rows: sends } = await query(
      'SELECT COUNT(*)::int AS n FROM outreach_sends WHERE author_id = $1',
      [authorId],
    );
    assert.equal(sends[0].n, 0, 'nothing was sent during drafting');
  });

  it('does not re-draft an opportunity that already has a message', async () => {
    const again = await draftOutreachMessages({ authorId, bookId, limit: 10 });
    assert.equal(again.length, 0);
  });

  it('sends an approved message through the mocked email provider', async () => {
    const { rows } = await query(
      "SELECT * FROM outreach_messages WHERE author_id = $1 AND status = 'pending_approval' LIMIT 1",
      [authorId],
    );
    const message = rows[0];
    assert.ok(message, 'a pending message is available');

    await approveOutreach({ messageId: message.id, reviewer: 'Reviewer One', notes: 'good fit' });
    const send = await sendOutreachMessage({ messageId: message.id });

    assert.equal(send.status, 'sent');
    assert.match(send.external_id, /^msg_\d{6}$/, 'provider returned a message id');
    assert.match(send.recipient, /@/, 'sent to the opportunity contact');

    const { rows: after } = await query('SELECT status FROM outreach_messages WHERE id = $1', [
      message.id,
    ]);
    assert.equal(after[0].status, 'sent');
  });
});

describe('Approval gate before sending (REQ-006)', () => {
  let pending;

  before(async () => {
    const { rows } = await query(
      `SELECT * FROM outreach_messages
        WHERE author_id = $1 AND status IN ('pending_approval','escalated') LIMIT 1`,
      [authorId],
    );
    pending = rows[0];
  });

  it('refuses to send a message that has not been approved', async () => {
    await assert.rejects(
      () => sendOutreachMessage({ messageId: pending.id }),
      /not "approved"/,
      'the gate rejects unapproved outreach',
    );

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM outreach_sends WHERE message_id = $1', [
      pending.id,
    ]);
    assert.equal(rows[0].n, 0, 'no send row was created');
  });

  it('logs the refused attempt even though the transaction rolled back', async () => {
    const log = await listAuditLog({ authorId, entityType: 'outreach_message', limit: 50 });
    assert.ok(
      log.some((entry) => entry.action === 'outreach.send_blocked'),
      'a blocked send is on the record',
    );
  });

  it('refuses to send a rejected message', async () => {
    const { rows } = await query(
      `SELECT * FROM outreach_messages
        WHERE author_id = $1 AND status IN ('pending_approval','escalated') LIMIT 1`,
      [authorId],
    );
    await rejectOutreach({ messageId: rows[0].id, reviewer: 'Reviewer One', notes: 'not a fit' });

    await assert.rejects(() => sendOutreachMessage({ messageId: rows[0].id }), /not "approved"/);
  });

  it('requires a named reviewer', async () => {
    const { rows } = await query(
      `SELECT * FROM outreach_messages
        WHERE author_id = $1 AND status IN ('pending_approval','escalated') LIMIT 1`,
      [authorId],
    );
    await assert.rejects(
      () => approveOutreach({ messageId: rows[0].id, reviewer: '  ' }),
      /reviewer name/,
    );
  });

  it('records the decision against the same approvals table as social drafts', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM approvals
        WHERE outreach_message_id IS NOT NULL AND draft_id IS NULL`,
    );
    assert.ok(rows[0].n > 0, 'outreach decisions share the approvals table');
  });
});

describe('Escalation on low confidence (TBI)', () => {
  it('escalates a generic message that ignores the opportunity', () => {
    const { confidence } = scoreMessage({
      subject: 'Collaboration opportunity',
      body: 'Hello, I would love to discuss a partnership. Please let me know if you are interested.',
      personalization: ['The Long Game', 'Dana Whitfield', 'deep work'],
      bookThemes: BOOK_THEMES,
      history: [{ content: 'Craft is the slow accumulation of decisions nobody claps for.' }],
    });

    assert.ok(
      confidence < config.confidenceEscalationThreshold,
      `a form letter scores ${confidence}, below ${config.confidenceEscalationThreshold}`,
    );
  });

  it('scores a personalized, grounded message above the threshold', () => {
    const { confidence } = scoreMessage({
      subject: 'Guest pitch for The Long Game: The Quiet Craft',
      body:
        'Hi Dana,\n\nI have been listening to The Long Game, and your episodes on deep work are ' +
        'the reason I am writing. I wrote "The Quiet Craft", which sits squarely on deep work ' +
        'and craft. Craft is the slow accumulation of decisions nobody claps for.',
      personalization: ['The Long Game', 'Dana Whitfield', 'deep work'],
      bookThemes: BOOK_THEMES,
      history: [
        { content: 'Craft is the slow accumulation of decisions nobody claps for.' },
        { content: 'Deep work is a refusal of interruption as a default condition.' },
      ],
    });

    assert.ok(confidence >= config.confidenceEscalationThreshold, `scored ${confidence}`);
  });

  it('penalises a message that runs too long for an email', () => {
    const long = 'Craft and deep work and attention. '.repeat(60);
    const { confidence, rationale } = scoreMessage({
      subject: 'Guest pitch for The Long Game',
      body: long,
      personalization: ['The Long Game'],
      bookThemes: BOOK_THEMES,
      history: [{ content: 'craft and attention' }],
    });

    assert.ok(confidence < 1);
    assert.match(rationale, /fit=/);
  });
});
