import amqp from 'amqplib';

import { pool } from '../db/pool.js';
import { ack, CONTRACTS, nack, receive } from './messageBus.js';

/**
 * RabbitMQ as the carrier (STORY-039) — the broker the story names.
 *
 * NOT RUN on the machine this was written on: RabbitMQ is not installed. It is
 * exercised in CI, where a RabbitMQ service container runs beside Postgres and
 * `tests/messageBus.test.js` runs its broker scenario with AMQP_URL set.
 * Locally that scenario reports itself skipped — never passed.
 *
 * The `agent_messages` table stays the source of truth even here. A broker on
 * its own cannot promise a message exists if and only if the change it
 * describes committed — the process can die between the commit and the
 * publish. So the sender still writes in its own transaction (the outbox), and
 * this relays: claim what is due from the table, publish it to the recipient's
 * queue, and acknowledge the row only once the recipient's handler has run and
 * the broker has been acked. A relay that dies after publishing leaves the row
 * delivered-but-unacked, and it is republished after the visibility window —
 * at-least-once, as with the Postgres transport, and handled the same way.
 */
export const EXCHANGE = 'ale.agents';
export const queueFor = (agent) => `agent.${agent}`;

export async function connect(url = process.env.AMQP_URL) {
  if (!url) throw new Error('AMQP_URL is not set — the RabbitMQ transport has nowhere to connect');
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, 'direct', { durable: true });
  for (const agent of Object.keys(CONTRACTS)) {
    await channel.assertQueue(queueFor(agent), { durable: true });
    await channel.bindQueue(queueFor(agent), EXCHANGE, agent);
  }
  return { connection, channel };
}

/** Table → broker. Publisher confirms, so a row is never marked sent on a publish the broker dropped. */
async function relay({ channel, now }) {
  let published = 0;
  for (const agent of Object.keys(CONTRACTS)) {
    for (const row of await receive({ agent, now })) {
      channel.publish(EXCHANGE, agent, Buffer.from(JSON.stringify(row.payload)), {
        persistent: true,
        messageId: row.message_id,
        type: row.topic,
        appId: row.sender,
        headers: { rowId: String(row.id) },
        timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
      });
      published += 1;
    }
  }
  await channel.waitForConfirms();
  return published;
}

/**
 * Broker → handler → acknowledgements. Pulled with `get` rather than pushed
 * with `consume`, so it fits the worker's tick the way the Postgres transport
 * does and a tick has an end.
 */
export async function dispatchViaBroker({ channel, handlers, now = null }) {
  const published = await relay({ channel, now });
  const results = [];
  for (const agent of Object.keys(CONTRACTS)) {
    for (;;) {
      const msg = await channel.get(queueFor(agent), { noAck: false });
      if (!msg) break;
      const topic = msg.properties.type;
      // Deserialised from the wire, not handed across in memory: this is the
      // round trip build step 3 asks to be correct.
      const payload = JSON.parse(msg.content.toString('utf8'));
      // The row is the record of truth — its attempt count, its sender — read
      // back rather than rebuilt from broker headers that could disagree.
      const { rows: [row] } = await pool.query('SELECT * FROM agent_messages WHERE id = $1', [
        msg.properties.headers.rowId,
      ]);
      if (!row || row.status === 'acked') {
        // Already handled — a republish racing its own acknowledgement.
        channel.ack(msg);
        continue;
      }
      try {
        const handler = handlers[agent]?.[topic];
        if (!handler) throw new Error(`${agent} has no handler for "${topic}"`);
        const result = await handler({ message: row, payload });
        channel.ack(msg);
        await ack(row, { now: now ?? new Date(), result });
        results.push({ id: row.id, topic, to: agent, status: 'acked', transport: 'rabbitmq', result });
      } catch (error) {
        // Removed from the broker; the row goes back to queued with backoff,
        // and the relay republishes it — the table decides, not the broker.
        channel.nack(msg, false, false);
        await nack(row, error, { now: now ?? new Date() });
        results.push({ id: row.id, topic, to: agent, status: 'retrying', transport: 'rabbitmq', error: error.message });
      }
    }
  }
  return { published, results };
}
