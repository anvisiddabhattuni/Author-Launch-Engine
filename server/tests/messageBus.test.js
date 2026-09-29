/**
 * STORY-039 acceptance tests.
 *
 *   "Agents send and receive messages through RabbitMQ" → given the server is
 *       running, when an agent sends a message, the intended recipient agent
 *       receives it.
 *
 * Measured before this story: eleven agents and no messages between them —
 * direct calls, or a table polled every five minutes. A reviewer heard about
 * an escalation at the next sweep, up to 300 seconds later, and nothing
 * recorded that one agent had told another anything.
 *
 * The Postgres transport is tested here in full. The RabbitMQ scenario runs
 * only where AMQP_URL is set — in CI, beside a RabbitMQ service container —
 * and reports itself *skipped* everywhere else. RabbitMQ is not installed on
 * the machine this was written on.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { monitorContent } from '../src/agents/trustMonitoringAgent.js';
import { closePool, pool, query } from '../src/db/pool.js';
import { listAuditLog } from '../src/services/auditLog.js';
import {
  ack,
  assertContract,
  busStatus,
  dispatch,
  nack,
  receive,
  redeliver,
  send,
  serialize,
  VISIBILITY_SECONDS,
} from '../src/services/messageBus.js';

let authorId;
let bookId;
/** The database's clock — the one every row in agent_messages is stamped with. */
const dbNow = async () => (await query('SELECT clock_timestamp() AS t')).rows[0].t;
const stamp = Date.now();
/** Handlers that record what arrived, so a test can see the recipient's view. */
const inbox = [];
const recording = {
  ApprovalNotificationAgent: { 'escalation.raised': async ({ payload }) => { inbox.push(['ApprovalNotificationAgent', payload]); return 'seen'; } },
  APIIntegrationAgent: { 'post.publish_failed': async ({ payload }) => { inbox.push(['APIIntegrationAgent', payload]); return 'seen'; } },
};

before(async () => {
  const { rows: a } = await query('INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *', [
    'Message Bus Author', `bus-${stamp}@example.test`,
  ]);
  authorId = Number(a[0].id);
  const { rows: b } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'B', 'Craft is slow.', ['craft']],
  );
  bookId = Number(b[0].id);
  // Drain anything other suites left, so each test sees only its own.
  await dispatch({ handlers: recording, authorId });
  inbox.length = 0;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('Scenario: an agent sends, and the intended recipient receives', () => {
  it('is received by the recipient, with the payload intact', async () => {
    await send({
      from: 'TrustMonitoringAgent', to: 'ApprovalNotificationAgent', topic: 'escalation.raised',
      authorId, payload: { authorId, escalationId: 42, reasons: ['voice'] },
    });
    const results = await dispatch({ handlers: recording, authorId });
    assert.deepEqual(results.map((r) => r.status), ['acked']);
    assert.deepEqual(inbox, [['ApprovalNotificationAgent', { authorId, escalationId: 42, reasons: ['voice'] }]]);
  });

  it('only the intended recipient ever sees it', async () => {
    inbox.length = 0;
    await send({ from: 'SchedulingAgent', to: 'APIIntegrationAgent', topic: 'post.publish_failed', authorId, payload: { authorId } });
    assert.deepEqual(await receive({ agent: 'ApprovalNotificationAgent', authorId }), [], 'delivered to the wrong agent');
    const mine = await receive({ agent: 'APIIntegrationAgent', authorId });
    assert.equal(mine.length, 1);
    await ack(mine[0]);
  });

  it('logs every message sent and received, with timestamps and both agents', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'agent_message', limit: 20 });
    const sent = entries.find((e) => e.action === 'message.sent' && e.metadata.topic === 'escalation.raised');
    const got = entries.find((e) => e.action === 'message.received' && e.metadata.topic === 'escalation.raised');
    assert.ok(sent && got, 'the trail is missing a side');
    assert.equal(sent.actor, 'TrustMonitoringAgent');
    assert.equal(got.actor, 'ApprovalNotificationAgent');
    assert.equal(got.metadata.from, 'TrustMonitoringAgent');
    assert.ok(sent.metadata.sentAt && got.metadata.processedAt);
    assert.ok(got.metadata.latencyMs >= 0);
    assert.equal(sent.entity_id, got.entity_id, 'the two rows do not name the same message');
  });

  it('refuses a recipient or a topic nobody declared', () => {
    assert.throws(() => assertContract({ to: 'NoSuchAgent', topic: 'x' }), /not a recipient/);
    assert.throws(() => assertContract({ to: 'ApprovalNotificationAgent', topic: 'post.publish_failed' }), /does not accept/);
  });
});

describe('Delivered reliably', () => {
  it('is written with the change it describes, or not at all', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const m = await send({ from: 'TrustMonitoringAgent', to: 'ApprovalNotificationAgent', topic: 'escalation.raised', authorId, payload: { authorId } }, client);
      await client.query('ROLLBACK');
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM agent_messages WHERE message_id = $1', [m.message_id]);
      assert.equal(rows[0].n, 0, 'a message outlived the change it described');
    } finally {
      client.release();
    }
  });

  it('a message received and never acknowledged comes back', async () => {
    await send({ from: 'SchedulingAgent', to: 'APIIntegrationAgent', topic: 'post.publish_failed', authorId, payload: { authorId, n: 1 } });
    // The database's clock, not this process's: the row was stamped by it, and
    // a JavaScript "now" can sit milliseconds before a message that exists.
    const now = await dbNow();
    const [first] = await receive({ agent: 'APIIntegrationAgent', now, authorId });
    // The consumer "dies" here. Nothing is delivered until the window passes…
    assert.deepEqual(await receive({ agent: 'APIIntegrationAgent', now: new Date(now.getTime() + 1000), authorId }), []);
    // …and then it is delivered again, as the same message.
    const [again] = await receive({ agent: 'APIIntegrationAgent', now: new Date(now.getTime() + (VISIBILITY_SECONDS + 1) * 1000), authorId });
    assert.equal(again.message_id, first.message_id);
    assert.equal(again.attempts, 2);
    await ack(again);
  });

  it('two consumers never take the same message', async () => {
    for (let i = 0; i < 6; i += 1) {
      await send({ from: 'SchedulingAgent', to: 'APIIntegrationAgent', topic: 'post.publish_failed', authorId, payload: { authorId, i } });
    }
    const [a, b] = await Promise.all([receive({ agent: 'APIIntegrationAgent', max: 4, authorId }), receive({ agent: 'APIIntegrationAgent', max: 4, authorId })]);
    const ids = [...a, ...b].map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'a message was delivered to both');
    assert.equal(ids.length, 6);
    for (const m of [...a, ...b]) await ack(m);
  });

  it('a failing handler retries with backoff, then dead-letters — never drops', async () => {
    const m = await send({ from: 'SchedulingAgent', to: 'APIIntegrationAgent', topic: 'post.publish_failed', authorId, payload: { authorId }, maxAttempts: 2 });
    const boom = { APIIntegrationAgent: { 'post.publish_failed': async () => { throw new Error('mail server down'); } } };
    let now = await dbNow();
    const first = await dispatch({ handlers: boom, now, authorId });
    assert.equal(first.find((r) => r.error)?.status, 'retrying');
    now = new Date(now.getTime() + 600_000);
    const second = await dispatch({ handlers: boom, now, authorId });
    assert.equal(second.find((r) => r.error)?.status, 'dead_letter');

    const { rows } = await query('SELECT status, last_error FROM agent_messages WHERE message_id = $1', [m.message_id]);
    assert.equal(rows[0].status, 'dead_letter');
    assert.match(rows[0].last_error, /mail server down/);
    const status = await busStatus({ authorId });
    assert.ok(status.dead.some((d) => Number(d.id) === Number(m.id)), 'the dead letter is not visible');

    await redeliver({ id: m.id, user: { name: 'test operator' } });
    const back = await dispatch({ handlers: recording, now: new Date(now.getTime() + 1000), authorId });
    assert.ok(back.some((r) => Number(r.id) === Number(m.id) && r.status === 'acked'));
  });
});

describe('Serialised and deserialised correctly', () => {
  it('writes Dates as ISO strings, and round-trips everything it accepts', () => {
    const at = new Date('2026-09-26T10:00:00Z');
    const out = serialize({ at, n: 3, list: [1, 'two', null], nested: { ok: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), { at: '2026-09-26T10:00:00.000Z', n: 3, list: [1, 'two', null], nested: { ok: true } });
  });

  it('refuses what JSON would silently lose', () => {
    // A field that vanishes between two agents is the bug a contract prevents.
    assert.throws(() => serialize({ reviewer: undefined }), /payload\.reviewer is undefined/);
    assert.throws(() => serialize({ id: 10n }), /bigint/);
    assert.throws(() => serialize({ fn: () => 1 }), /function/);
    assert.throws(() => serialize({ score: NaN }), /NaN/);
    const loop = { a: 1 }; loop.self = loop;
    assert.throws(() => serialize(loop), /refers back to itself/);
  });
});

describe('The real hand-off: an escalation reaches its reviewers within one poll', () => {
  it('the monitor sends as it escalates, and the notifier acts on the next tick', async () => {
    await query('INSERT INTO reviewers (author_id, name, email, role) VALUES ($1,$2,$3,$4)', [
      authorId, 'Bus Reviewer', `bus-reviewer-${stamp}@example.test`, 'publicist',
    ]);
    await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, theme_alignment, voice_score, week_of)
       VALUES ($1,$2,'twitter','copy that does not sound like the author','pending_approval',0.9,0.9,0.1,CURRENT_DATE)`,
      [authorId, bookId],
    );
    await monitorContent({ authorId });
    const { rows: queued } = await query(
      "SELECT * FROM agent_messages WHERE author_id = $1 AND topic = 'escalation.raised' AND status = 'queued'",
      [authorId],
    );
    assert.equal(queued.length, 1, 'the monitor escalated without telling anyone');
    assert.equal(queued[0].sender, 'TrustMonitoringAgent');

    // The real handlers this time — the notifier, not a recording.
    const results = await dispatch({ authorId });
    const delivered = results.find((r) => r.topic === 'escalation.raised' && r.status === 'acked');
    assert.ok(delivered, 'not delivered');
    assert.ok(delivered.result.notified >= 1, 'the reviewer was not told');
  });
});

describe('Scenario, on RabbitMQ', () => {
  it('sends through the broker and the intended recipient receives it', async (t) => {
    if (!process.env.AMQP_URL) {
      // Said, not hidden: this is the part of the story that has not run here.
      t.skip('RabbitMQ not available — set AMQP_URL (CI runs it beside a RabbitMQ service)');
      return;
    }
    const { connect } = await import('../src/services/amqpTransport.js');
    const { connection, channel } = await connect();
    try {
      inbox.length = 0;
      await send({ from: 'TrustMonitoringAgent', to: 'ApprovalNotificationAgent', topic: 'escalation.raised', authorId, payload: { authorId, via: 'broker', at: new Date('2026-01-01T00:00:00Z') } });
      const results = await dispatch({ handlers: recording, channel, authorId });
      assert.ok(results.some((r) => r.transport === 'rabbitmq' && r.status === 'acked'));
      assert.deepEqual(inbox.at(-1), ['ApprovalNotificationAgent', { authorId, via: 'broker', at: '2026-01-01T00:00:00.000Z' }]);
    } finally {
      await connection.close();
    }
  });
});
