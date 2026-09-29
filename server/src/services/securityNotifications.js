import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

/**
 * Telling the security officer (STORY-052 / REQ-013) — Approval and
 * Notification Agent.
 *
 * The first refused attempt on an audit log from a person (or, with no
 * session, an address) notifies every security officer — whoever holds
 * audit.verify — at once. Attempts inside the next WINDOW_MINUTES join that
 * notification instead of sending another: an officer hears about a person
 * trying doors once, with the count, not forty times.
 *
 * Sent through the email adapter (STORY-002), which is shaped like SendGrid's
 * send call so swapping the provider is a change to that one file; every send
 * goes through the integration gateway (STORY-038) and its circuit breaker.
 */
export const ACTOR = 'ApprovalNotificationAgent';
export const WINDOW_MINUTES = 10;

const subjectOf = (entry) =>
  entry.user_id
    ? { key: `user:${entry.user_id}`, label: entry.api_key_id ? `${entry.user_email} (API key #${entry.api_key_id})` : `${entry.user_email} (${entry.user_role})` }
    : { key: `ip:${entry.ip ?? 'unknown'}`, label: `no session, from ${entry.ip ?? 'an unknown address'}` };

/** Who is told: every active account holding audit.verify. */
export async function securityOfficers(client = pool) {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.name FROM users u JOIN role_permissions rp ON rp.role = u.role
      WHERE rp.permission = 'audit.verify' AND u.active ORDER BY u.id`,
  );
  return rows;
}

const when = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/**
 * Called for each refused attempt on an audit log, with its security log
 * entry (decrypted). Opens a notification and sends it, or folds the attempt
 * into the open one for the same subject.
 */
export async function notifyAuditAttempt(entry) {
  const subject = subjectOf(entry);
  const decided = await withTransaction(async (client) => {
    // One decision per subject at a time: two refusals landing together must
    // not both open a notification.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit-attempt:${subject.key}`]);
    const { rows: [open] } = await client.query(
      `SELECT * FROM security_notifications
        WHERE subject_key = $1 AND first_at > now() - make_interval(mins => $2)
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [subject.key, WINDOW_MINUTES],
    );
    if (open) {
      const { rows: [folded] } = await client.query(
        `UPDATE security_notifications
            SET attempts = attempts + 1, last_at = now(),
                routes_tried = CASE WHEN $2 = ANY(routes_tried) THEN routes_tried ELSE routes_tried || $2 END
          WHERE id = $1 RETURNING *`,
        [open.id, entry.route],
      );
      return { notification: folded, send: false };
    }
    const officers = await securityOfficers(client);
    const { rows: [created] } = await client.query(
      `INSERT INTO security_notifications
         (subject_key, subject_label, user_id, first_log_id, route, outcome, reason, routes_tried, first_at, last_at, recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,ARRAY[$5],$8,$8,$9) RETURNING *`,
      [subject.key, subject.label, entry.user_id, entry.id, entry.route, entry.outcome, entry.reason, entry.occurred_at,
        officers.map((o) => o.email)],
    );
    return { notification: created, send: true, officers };
  });

  if (!decided.send) return decided.notification;

  const n = decided.notification;
  const body = [
    `An attempt to read the audit logs was refused.`,
    '',
    `  Who:        ${subject.label}${entry.user_name ? ` — ${entry.user_name}` : ''}`,
    `  Tried:      ${entry.route}  (${entry.path})`,
    `  When:       ${when(entry.occurred_at)}`,
    `  From:       ${entry.ip ?? 'unknown address'}${entry.user_agent ? ` · ${entry.user_agent}` : ''}`,
    `  Outcome:    ${entry.outcome} — ${entry.reason ?? 'no reason recorded'}`,
    '',
    `Further attempts from the same ${entry.user_id ? 'account' : 'address'} in the next ${WINDOW_MINUTES} minutes are added to this alert, not sent separately.`,
    `See every attempt, acknowledge this alert, or block the account:`,
    `  ${config.appUrl}/security?outcome=refused${entry.user_id ? `&user=${entry.user_id}` : ''}`,
  ].join('\n');

  const delivered = [];
  const failed = [];
  for (const officer of decided.officers) {
    try {
      await emailApi.send({
        to: officer.email,
        subject: `Security: refused attempt on the audit logs — ${subject.label}`,
        body,
        via: 'security.alert_audit_access',
      });
      delivered.push(officer.email);
    } catch (error) {
      failed.push(officer.email);
      console.error(`[security] alert to ${officer.email} failed: ${error.message}`);
    }
  }
  const { rows: [sent] } = await pool.query(
    'UPDATE security_notifications SET delivered = $2, failed = $3 WHERE id = $1 RETURNING *',
    [n.id, delivered, failed],
  );
  await recordAction({
    actor: ACTOR,
    action: 'security.notified',
    entityType: 'security_notification',
    entityId: String(n.id),
    metadata: {
      subject: subject.label,
      route: entry.route,
      outcome: entry.outcome,
      reason: entry.reason,
      securityLogId: Number(entry.id),
      delivered,
      failed,
    },
  });
  return sent;
}

export async function listNotifications({ open = null, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM security_notifications
      ${open === true ? 'WHERE acknowledged_at IS NULL' : open === false ? 'WHERE acknowledged_at IS NOT NULL' : ''}
      ORDER BY last_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function acknowledge({ id, note = '', user }) {
  const { rows: [row] } = await pool.query(
    `UPDATE security_notifications SET acknowledged_by = $2, acknowledged_at = now(), note = NULLIF($3, '')
      WHERE id = $1 AND acknowledged_at IS NULL RETURNING *`,
    [id, user.name, note.trim()],
  );
  if (!row) throw fail(404, 'No open notification with that id');
  await recordAction({
    actor: user.name,
    action: 'security.notification_acknowledged',
    entityType: 'security_notification',
    entityId: String(id),
    metadata: { subject: row.subject_label, attempts: row.attempts, note: row.note, userId: user.id },
  });
  return row;
}
