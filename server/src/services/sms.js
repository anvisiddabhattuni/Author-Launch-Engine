import { callExternal, httpJson, isRetryable } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';
import { enqueue } from '../jobs/queue.js';
import { outsideTenantScope, pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { assertDeclaredPath } from './outboundPaths.js';

/**
 * Text messages through Twilio (STORY-037 / REQ-009, REQ-013) — Approval and
 * Notification Agent.
 *
 *   Given an approval is required, when the system notifies the user, then the
 *   notification is delivered via Twilio.
 *   Given Twilio is temporarily unavailable, when the system sends, then it
 *   logs the failure and retries after a delay.
 *
 * Every text is a row in `sms_messages` and an entry on the audit log. A send
 * goes through the integration gateway (a timeout, a couple of quick retries);
 * if Twilio is still down after those, the message is left 'retrying' with a
 * time for the next attempt, and an `sms.send` job tries again then — minutes
 * later, not milliseconds — up to SMS_MAX_ATTEMPTS, after which it is 'failed'
 * and said so.
 */
const ACTOR = 'ApprovalNotificationAgent';
export const smsConfigured = () => Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber);
const E164 = /^\+[1-9]\d{7,14}$/;

async function deliver(message) {
  const url = `${config.twilioApiBase}/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`;
  return callExternal({
    service: 'twilio',
    operation: 'messages.create',
    authorId: message.author_id,
    fn: (signal) => httpJson(url, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: message.to_number, From: config.twilioFromNumber, Body: message.body }).toString(),
    }),
  });
}

/** One attempt at a stored message; records the outcome and, if Twilio is down, when to try next. */
export async function attemptSms(messageId) {
  return outsideTenantScope(async () => {
    const { rows: [m] } = await pool.query('SELECT * FROM sms_messages WHERE id = $1', [messageId]);
    if (!m) throw new Error(`Text message ${messageId} no longer exists`);
    if (m.status === 'sent' || m.status === 'failed') return m;
    const attempts = m.attempts + 1;
    try {
      const sent = await deliver(m);
      const { rows: [done] } = await pool.query(
        `UPDATE sms_messages SET status = 'sent', twilio_sid = $2, attempts = $3, sent_at = now(), last_error = NULL,
                next_attempt_at = NULL WHERE id = $1 RETURNING *`,
        [m.id, sent.sid, attempts],
      );
      await recordAction({ actor: ACTOR, action: 'sms.sent', entityType: 'sms', entityId: String(m.id), authorId: m.author_id,
        metadata: { purpose: m.purpose, to: mask(m.to_number), twilioSid: sent.sid, attempts } });
      return done;
    } catch (error) {
      // Down, overloaded, unreachable or timed out: try later. A 4xx (a bad
      // number, bad credentials) would fail the same way again: stop.
      const transient = isRetryable(error) || !error.status;
      const again = transient && attempts < config.smsMaxAttempts;
      const nextAt = again ? new Date(Date.now() + config.smsRetrySeconds * 1000 * 2 ** (attempts - 1)) : null;
      const { rows: [done] } = await pool.query(
        `UPDATE sms_messages SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5 WHERE id = $1 RETURNING *`,
        [m.id, again ? 'retrying' : 'failed', attempts, error.message.slice(0, 500), nextAt],
      );
      await recordAction({ actor: ACTOR, action: again ? 'sms.retry_scheduled' : 'sms.failed', entityType: 'sms', entityId: String(m.id),
        authorId: m.author_id, metadata: { purpose: m.purpose, to: mask(m.to_number), attempts, error: error.message.slice(0, 200), nextAttemptAt: nextAt } });
      if (again) {
        await enqueue({ kind: 'sms.send', idempotencyKey: `sms.send:${m.id}:${attempts}`, authorId: m.author_id, payload: { messageId: m.id }, runAt: nextAt, maxAttempts: 1 });
      }
      return done;
    }
  });
}

/** Stores a text, then tries to send it. Never throws for a delivery problem — the row says what happened. */
export async function sendSms({ to, body, via, purpose, authorId = null, reviewerId = null, batchId = null }) {
  assertDeclaredPath(via);
  if (!smsConfigured()) {
    throw Object.assign(new Error('Text messages are not set up here: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.'), { status: 503 });
  }
  if (!E164.test(to ?? '')) throw Object.assign(new Error(`Not a phone number in international form (+15551234567): "${to}"`), { status: 400 });
  const { rows: [m] } = await outsideTenantScope(() => pool.query(
    `INSERT INTO sms_messages (author_id, reviewer_id, to_number, body, purpose, via, batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [authorId, reviewerId, to, body.slice(0, 320), purpose, via, batchId],
  ));
  return attemptSms(m.id);
}

/** The last digits only, in the audit log: enough to recognise, not enough to reuse. */
export const mask = (n) => `…${String(n).slice(-4)}`;

export async function smsLog(authorId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, reviewer_id, to_number, body, purpose, status, attempts, twilio_sid, last_error, next_attempt_at, sent_at, created_at
       FROM sms_messages WHERE author_id = $1 ORDER BY id DESC LIMIT $2`,
    [authorId, limit],
  );
  return { configured: smsConfigured(), messages: rows.map((r) => ({ ...r, to_number: mask(r.to_number) })) };
}
