import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/**
 * Messages between agents (STORY-039 / REQ-010) — Coordination and Governance Agent.
 *
 * Before this, agents reached each other by calling functions directly or by
 * polling a table on a five-minute sweep. Polling is reliable and slow; a
 * reviewer learned of an escalation up to 300 seconds after it was raised, and
 * nothing recorded that one agent had told another anything.
 *
 * Three guarantees, each the reason for a design choice:
 *
 *   Not lost. `send` writes in the sender's own transaction (the outbox
 *     pattern), so the message exists if and only if the change it describes
 *     committed. A broker alone cannot promise that — the process can die
 *     between committing and publishing.
 *
 *   Delivered at least once. A delivered message not acknowledged within the
 *     visibility window is delivered again; after `max_attempts` it is dead-
 *     lettered and visible, never silently dropped. Consumers are written to
 *     be idempotent, which the existing notifiers already were.
 *
 *   To the intended recipient, and only a declared one. Each recipient
 *     declares the topics it accepts; a message to anyone else, or on a topic
 *     it does not take, is refused at send time — the STORY-020 shape again.
 *
 * The sweeps stay. Messages make a hand-off fast; the sweeps make it certain.
 * A message lost to a bug is a late notification, not a missing one.
 */
export const ACTOR = 'CoordinationGovernanceAgent';

/**
 * Who may be sent what. The contract, in one place, where a reviewer can read
 * it — and where a message nobody is listening for is refused rather than
 * queued forever.
 */
export const CONTRACTS = {
  ApprovalNotificationAgent: {
    'escalation.raised': 'The independent monitor escalated an item; tell its reviewers now, not at the next sweep.',
  },
  APIIntegrationAgent: {
    'post.publish_failed': 'An approved post failed at the platform; tell the author\'s reviewers (STORY-025).',
  },
};

/** How long a delivered, unacknowledged message waits before redelivery. */
export const VISIBILITY_SECONDS = 60;

/**
 * JSON that survives the round trip, or a refusal.
 *
 * `JSON.stringify` loses things without saying so: `undefined` fields vanish,
 * a Date becomes a string the consumer must know to parse back, a BigInt
 * throws, a function disappears. A field that silently disappears between two
 * agents is exactly the bug a message contract exists to prevent, so those
 * are refused by name, and Dates are written as ISO strings on purpose.
 */
export function serialize(payload, path = 'payload', seen = new Set()) {
  if (payload === null) return null;
  if (payload instanceof Date) {
    if (Number.isNaN(payload.getTime())) throw new TypeError(`${path} is an invalid Date`);
    return payload.toISOString();
  }
  switch (typeof payload) {
    case 'string':
    case 'boolean':
      return payload;
    case 'number':
      if (!Number.isFinite(payload)) throw new TypeError(`${path} is ${payload}, which JSON cannot carry`);
      return payload;
    case 'undefined':
      throw new TypeError(`${path} is undefined — JSON would drop it silently; send null if absent is meant`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`${path} is a ${typeof payload}, which JSON cannot carry`);
    default:
      break;
  }
  if (seen.has(payload)) throw new TypeError(`${path} refers back to itself`);
  seen.add(payload);
  const out = Array.isArray(payload)
    ? payload.map((v, i) => serialize(v, `${path}[${i}]`, seen))
    : Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, serialize(v, `${path}.${k}`, seen)]));
  seen.delete(payload);
  return out;
}

/** Refuses a message nobody declared they would take. */
export function assertContract({ to, topic }) {
  const accepts = CONTRACTS[to];
  if (!accepts) {
    throw Object.assign(
      new Error(`Message refused: "${to}" is not a recipient. Recipients: ${Object.keys(CONTRACTS).join(', ')}`),
      { status: 500 },
    );
  }
  if (!accepts[topic]) {
    throw Object.assign(
      new Error(`Message refused: ${to} does not accept "${topic}". It accepts: ${Object.keys(accepts).join(', ')}`),
      { status: 500 },
    );
  }
}

/**
 * Sends a message. Pass the caller's transaction client so the message commits
 * with the change it describes, or not at all.
 */
export async function send({ from, to, topic, payload = {}, authorId = null, maxAttempts = 5 }, client = pool) {
  assertContract({ to, topic });
  const body = serialize(payload);
  const messageId = randomUUID();
  const { rows } = await client.query(
    `INSERT INTO agent_messages (message_id, topic, sender, recipient, payload, author_id, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [messageId, topic, from, to, JSON.stringify(body), authorId, maxAttempts],
  );
  await recordAction(
    {
      actor: from,
      action: 'message.sent',
      entityType: 'agent_message',
      entityId: messageId,
      authorId,
      metadata: { topic, from, to, sentAt: rows[0].created_at },
    },
    client,
  );
  return rows[0];
}

/**
 * Claims up to `max` messages for one recipient.
 *
 * SKIP LOCKED, so two workers never take the same message; the claim moves
 * `available_at` forward by the visibility window, so a message whose handler
 * never acknowledges it comes back rather than vanishing.
 */
export async function receive({ agent, max = 20, now = null, authorId = null }) {
  // The database's clock by default, not this process's. Every row was
  // stamped by the database; comparing those stamps against a worker's own
  // clock meant a worker running slow — by milliseconds on one machine, by
  // seconds across two — could not see a message that already existed. Found
  // as a 1-in-60 test flake. An explicit `now` is for tests that move time.
  const { rows } = await pool.query(
    `UPDATE agent_messages m
        SET status = 'delivered', attempts = attempts + 1,
            delivered_at = COALESCE($2, clock_timestamp()),
            available_at = COALESCE($2, clock_timestamp()) + make_interval(secs => $4)
      WHERE m.id IN (
        SELECT id FROM agent_messages
         WHERE recipient = $1 AND status IN ('queued', 'delivered')
           AND available_at <= COALESCE($2, clock_timestamp())
           -- One tenant's messages only, when asked: for draining a single
           -- author's backlog, and for tests that share a database.
           AND ($5::bigint IS NULL OR author_id = $5)
         ORDER BY id
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING m.*`,
    [agent, now, max, VISIBILITY_SECONDS, authorId],
  );
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Done. Recorded with how long the hand-off took, which is the number this story exists to shrink. */
export async function ack(message, { now = new Date(), result = null } = {}) {
  await pool.query(
    "UPDATE agent_messages SET status = 'acked', acked_at = $2 WHERE id = $1",
    [message.id, now],
  );
  await recordAction({
    actor: message.recipient,
    action: 'message.received',
    entityType: 'agent_message',
    entityId: message.message_id,
    authorId: message.author_id,
    metadata: {
      topic: message.topic,
      from: message.sender,
      to: message.recipient,
      sentAt: message.created_at,
      processedAt: now,
      latencyMs: now - new Date(message.created_at),
      attempt: message.attempts,
      result,
    },
  });
}

/**
 * Not done. Tried again later, with backoff, or dead-lettered once it has had
 * its attempts — visible on the Worker tab and the audit log, never dropped.
 */
export async function nack(message, error, { now = new Date() } = {}) {
  const dead = message.attempts >= message.max_attempts;
  const retryAt = new Date(now.getTime() + Math.min(300, 5 * 2 ** (message.attempts - 1)) * 1000);
  await pool.query(
    `UPDATE agent_messages SET status = $2, available_at = $3, last_error = $4 WHERE id = $1`,
    [message.id, dead ? 'dead_letter' : 'queued', retryAt, String(error?.message ?? error).slice(0, 500)],
  );
  await recordAction({
    actor: message.recipient,
    action: dead ? 'message.dead_lettered' : 'message.failed',
    entityType: 'agent_message',
    entityId: message.message_id,
    authorId: message.author_id,
    metadata: {
      topic: message.topic,
      from: message.sender,
      to: message.recipient,
      attempt: message.attempts,
      error: String(error?.message ?? error),
      ...(dead ? {} : { retryAt }),
    },
  });
  return { dead };
}

/**
 * Delivers everything waiting, to every recipient that has a handler.
 *
 * Called on every worker tick — every `WORKER_POLL_SECONDS`, five by default —
 * which is what turns "up to 300 seconds" into "within one poll".
 */
export async function dispatch({ handlers, now = null, max = 20, channel = null, authorId = null } = {}) {
  const table = handlers ?? (await import('../jobs/messageHandlers.js')).MESSAGE_HANDLERS;
  // RabbitMQ as the carrier, when configured and connected (amqpTransport.js).
  if (channel) {
    const { dispatchViaBroker } = await import('./amqpTransport.js');
    return (await dispatchViaBroker({ channel, handlers: table, now })).results;
  }
  const results = [];
  for (const agent of Object.keys(CONTRACTS)) {
    for (const message of await receive({ agent, max, now, authorId })) {
      const handler = table[agent]?.[message.topic];
      // Acknowledgements are stamped with the delivery time the database
      // chose, so latency is measured on one clock end to end.
      const at = now ?? new Date(message.delivered_at);
      try {
        if (!handler) throw new Error(`${agent} has no handler for "${message.topic}"`);
        const result = await handler({ message, payload: message.payload });
        await ack(message, { now: at, result });
        results.push({ id: Number(message.id), topic: message.topic, to: agent, status: 'acked', result });
      } catch (error) {
        const { dead } = await nack(message, error, { now: at });
        results.push({ id: Number(message.id), topic: message.topic, to: agent, status: dead ? 'dead_letter' : 'retrying', error: error.message });
      }
    }
  }
  return results;
}

/** The read-model: counts by state, the dead letters, and how fast hand-offs are. */
export async function busStatus({ limit = 20, authorId = null } = {}) {
  // Scoped like every other read-model: a tenant sees messages about its own
  // work and the system-wide ones; a session that reads across tenants passes
  // null and sees everything (STORY-017, STORY-024).
  const scope = 'WHERE ($1::bigint IS NULL OR author_id = $1 OR author_id IS NULL)';
  const { rows: counts } = await pool.query(
    `SELECT recipient, topic, status, COUNT(*)::int AS n FROM agent_messages ${scope} GROUP BY 1,2,3 ORDER BY 1,2,3`,
    [authorId],
  );
  const { rows: latency } = await pool.query(
    `SELECT topic,
            COUNT(*)::int AS delivered,
            ROUND(AVG(EXTRACT(EPOCH FROM (acked_at - created_at)) * 1000))::int AS avg_ms,
            ROUND(MAX(EXTRACT(EPOCH FROM (acked_at - created_at)) * 1000))::int AS max_ms
       FROM agent_messages ${scope} AND status = 'acked' GROUP BY topic ORDER BY topic`,
    [authorId],
  );
  const { rows: dead } = await pool.query(
    `SELECT id, topic, sender, recipient, attempts, last_error, created_at, author_id
       FROM agent_messages ${scope} AND status = 'dead_letter' ORDER BY id DESC LIMIT $2`,
    [authorId, limit],
  );
  const { rows: recent } = await pool.query(
    `SELECT id, topic, sender, recipient, status, attempts, created_at, acked_at, author_id
       FROM agent_messages ${scope} ORDER BY id DESC LIMIT $2`,
    [authorId, limit],
  );
  return { contracts: CONTRACTS, counts, latency, dead, recent, pollSeconds: config.workerPollSeconds };
}

/** Puts a dead letter back. A human decision, recorded like retrying a job. */
export async function redeliver({ id, user }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE agent_messages SET status = 'queued', attempts = 0, available_at = now(), last_error = ''
        WHERE id = $1 AND status = 'dead_letter' RETURNING *`,
      [id],
    );
    if (!rows[0]) throw Object.assign(new Error('No dead letter with that id'), { status: 404 });
    await recordAction(
      {
        actor: user?.name ?? 'operator',
        action: 'message.redelivered',
        entityType: 'agent_message',
        entityId: rows[0].message_id,
        authorId: rows[0].author_id,
        metadata: { topic: rows[0].topic, to: rows[0].recipient },
      },
      client,
    );
    return rows[0];
  });
}
