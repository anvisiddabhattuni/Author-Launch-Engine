import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { beforeClose, outsideTenantScope, pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { forgetAccessVersion } from './accessChanges.js';
import { AUDIT_ROUTES } from './auditAccess.js';
import { notifyAuditAttempt } from './securityNotifications.js';
import { emailApi } from './emailApi.js';
import { PERMISSIONS, holds } from './permissions.js';

/**
 * Tenant data access audit (STORY-044 / REQ-011) — Audit and Security Agent.
 *
 * Every request that reaches tenant data is recorded as it finishes: who made
 * it, whose data it was about, what it asked for, how it ended and which
 * database role served it. The audit log (STORY-004) records what *changed*;
 * this records what was *looked at* and what was *refused* — before it, a
 * request for another tenant's data was turned away and left no trace.
 *
 * Refusals are also counted: an account (or, with no session, an address)
 * refused `accessAlertThreshold` times inside `accessAlertMinutes` is flagged
 * on the audit log and the admins are told, once per window. An admin can
 * block the account from the Security tab, and it stops on its next request.
 */
export const ACTOR = 'AuditSecurityAgent';

/** Not tenant data, and polled by machines: logging them would drown the rest. */
export const NOT_LOGGED = new Set(['/health', '/ready', '/auth/login', '/auth/accept-invite']);

/** Routes that read the caller's own account, not any tenant's data. */
const OWN_ACCOUNT = new Set(['/auth/me']);

/** The application's own database login, named for the record. */
const appLogin = (() => {
  try {
    return decodeURIComponent(new URL(config.databaseUrl).username) || null;
  } catch {
    return null;
  }
})();

const outcomeOf = (status) =>
  status < 400 ? 'allowed'
    : status === 401 ? 'unauthenticated'
      : status === 403 ? 'denied'
        : status === 404 ? 'not_found'
          : status < 500 ? 'invalid'
            : 'error';

const toTenant = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The audit routes (STORY-050), as patterns — so a request refused before it
 * was routed (no session) is still recognised as an attempt on an audit log.
 */
const AUDIT_PATTERNS = Object.keys(AUDIT_ROUTES).map((key) => {
  const [method, path] = key.split(' ');
  return { key, method, pattern: new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`) };
});
export const auditRouteFor = (method, path) =>
  AUDIT_PATTERNS.find((p) => p.method === method && p.pattern.test(path))?.key ?? null;

/** What one finished request was, as a row. Exported for the tests. */
export function describeRequest(req, res, ms) {
  const user = req.user ?? null;
  const route = req.route?.path ?? null;
  const status = res.statusCode;
  const outcome = outcomeOf(status);
  // A request refused before routing (no session) has no params yet; the
  // path still says whose data it was aimed at.
  // By the time a response finishes, Express has restored the full URL, so
  // the path is read from originalUrl rather than req.path.
  const path = req.originalUrl.split('?')[0];
  const target = toTenant(req.accessTarget ?? req.params?.authorId ?? path.match(/^\/api\/authors\/(\d+)/)?.[1]);

  let scope;
  let tenant = null;
  if (route && OWN_ACCOUNT.has(route)) {
    scope = 'own_account';
  } else if (target) {
    scope = 'tenant';
    tenant = target;
  } else if (user?.authorId && !holds(user, PERMISSIONS.TENANT_READ_ALL)) {
    // An author's request that named no tenant is about their own.
    scope = 'tenant';
    tenant = Number(user.authorId);
  } else {
    scope = 'all_tenants';
  }

  return {
    requestId: req.accessId ?? randomUUID(),
    // An attempt on an audit log (STORY-051): also written to the security log.
    auditRoute: auditRouteFor(req.method, path.replace(/^\/api/, '')),
    userName: user?.name ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    userId: user?.id ?? null,
    apiKeyId: user?.apiKeyId ?? null,
    userEmail: user?.email ?? null,
    userRole: user?.role ?? null,
    actorAuthorId: user?.authorId ?? null,
    authorId: tenant,
    scope,
    method: req.method,
    route: route ?? path.replace(/^\/api/, ''),
    path,
    status,
    outcome,
    reason: outcome === 'allowed' ? null : (res.locals.accessReason ?? null),
    dbRole: outcome === 'allowed' ? (req.dbRole ?? appLogin) : null,
    ms: Math.round(ms * 10) / 10,
    ip: req.ip ?? null,
  };
}

const pending = new Set();
let failures = 0;

/** Waits for every access record still being written. For tests and shutdown. */
export async function flushAccessLog() {
  while (pending.size) await Promise.allSettled([...pending]);
}

beforeClose.add(flushAccessLog);

/** Records that failed to write since start — reported, not swallowed. */
export const accessLogFailures = () => failures;

/** The middleware. Mounted on /api before the router. */
export function accessLog() {
  return (req, res, next) => {
    if (NOT_LOGGED.has(req.path)) return next();
    req.accessId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const event = describeRequest(req, res, ms);
      // Outside the request's tenant scope: a tenant's read-only role cannot
      // write its own access record, and must not be able to.
      const write = outsideTenantScope(() => recordAccess(event)).catch((error) => {
        failures += 1;
        console.error(`[access] could not record ${event.method} ${event.path}: ${error.message}`);
      });
      pending.add(write);
      write.finally(() => pending.delete(write));
    });
    return next();
  };
}

/** Writes one event, then — if it was a refusal — checks for a pattern. */
export async function recordAccess(event) {
  // One transaction: an attempt on an audit log is in both logs or neither.
  const row = await withTransaction(async (client) => {
    const { rows: [inserted] } = await client.query(
      `INSERT INTO data_access_events
         (user_id, user_email, user_role, actor_author_id, author_id, scope, method, route, path,
          status, outcome, reason, db_role, duration_ms, ip, api_key_id, request_id, audit_route)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        event.userId, event.userEmail, event.userRole, event.actorAuthorId, event.authorId, event.scope,
        event.method, event.route, event.path, event.status, event.outcome, event.reason, event.dbRole,
        event.ms, event.ip, event.apiKeyId, event.requestId, Boolean(event.auditRoute),
      ],
    );
    if (event.auditRoute) {
      // The security log (STORY-051): separate, encrypted, append-only.
      await client.query(
        `INSERT INTO security_log (request_id, method, route, outcome, status, user_id, tenant_id, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          event.requestId, event.method, event.auditRoute, event.outcome, event.status, event.userId, event.authorId,
          JSON.stringify({
            email: event.userEmail, name: event.userName, role: event.userRole, ip: event.ip,
            userAgent: event.userAgent, path: event.path, reason: event.reason, apiKeyId: event.apiKeyId,
          }),
        ],
      );
    }
    return inserted;
  });
  if (row.outcome === 'denied' || row.outcome === 'unauthenticated') {
    // A refused attempt on an audit log tells the security officers now (STORY-052).
    if (event.auditRoute) {
      const { rows: [entry] } = await pool.query('SELECT * FROM security_log WHERE request_id = $1', [event.requestId]);
      if (entry) await notifyAuditAttempt(entry);
    }
    await checkForPattern(row);
  }
  return row;
}

const subjectOf = (row) =>
  row.user_id ? { kind: 'account', key: `user:${row.user_id}`, label: row.user_email ?? `user ${row.user_id}` }
    : { kind: 'address', key: `ip:${row.ip ?? 'unknown'}`, label: row.ip ?? 'unknown address' };

/**
 * Flags an account refused too often, once per window.
 *
 * Serialised per subject with an advisory lock: two refusals landing together
 * must not both see "the fifth" and page twice, nor both see "the fourth" and
 * page never.
 */
async function checkForPattern(row) {
  const subject = subjectOf(row);
  const window = `${config.accessAlertMinutes} minutes`;
  const flagged = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`access-pattern:${subject.key}`]);
    const { rows: [counted] } = await client.query(
      `SELECT COUNT(*)::int AS n, array_agg(DISTINCT path) AS paths,
              array_agg(DISTINCT author_id) FILTER (WHERE author_id IS NOT NULL) AS tenants
         FROM data_access_events
        WHERE occurred_at > now() - $2::interval AND outcome IN ('denied', 'unauthenticated')
          AND ${row.user_id ? 'user_id = $1' : "user_id IS NULL AND ip IS NOT DISTINCT FROM $1"}`,
      [row.user_id ?? row.ip, window],
    );
    if (counted.n < config.accessAlertThreshold) return null;
    const { rows: already } = await client.query(
      `SELECT 1 FROM audit_log WHERE action = 'access.suspicious' AND entity_id = $1
          AND created_at > now() - $2::interval LIMIT 1`,
      [subject.key, window],
    );
    if (already[0]) return null;
    const entry = await recordAction(
      {
        actor: ACTOR,
        action: 'access.suspicious',
        entityType: subject.kind,
        entityId: subject.key,
        metadata: {
          subject: subject.label,
          userId: row.user_id === null ? null : Number(row.user_id),
          refusals: counted.n,
          windowMinutes: config.accessAlertMinutes,
          paths: (counted.paths ?? []).slice(0, 10),
          tenantsTried: (counted.tenants ?? []).map(Number),
        },
      },
      client,
    );
    return { entry, counted };
  });
  if (!flagged) return null;

  const { rows: admins } = await pool.query(
    `SELECT u.email FROM users u JOIN role_permissions rp ON rp.role = u.role
      WHERE rp.permission = 'access.manage' AND u.active ORDER BY u.id`,
  );
  const sent = [];
  for (const admin of admins) {
    try {
      await emailApi.send({
        to: admin.email,
        subject: `Security: ${subject.label} refused ${flagged.counted.n} times in ${config.accessAlertMinutes} minutes`,
        body: [
          `${subject.label} has been refused tenant data ${flagged.counted.n} times in the last ${config.accessAlertMinutes} minutes.`,
          '',
          'Tried:',
          ...(flagged.counted.paths ?? []).slice(0, 10).map((p) => `  ${p}`),
          '',
          'Every attempt, and a button to block the account:',
          `  ${config.appUrl}/security?outcome=refused${row.user_id ? `&user=${row.user_id}` : ''}`,
        ].join('\n'),
        via: 'security.alert_access',
      });
      sent.push(admin.email);
    } catch (error) {
      console.error(`[access] alert to ${admin.email} failed: ${error.message}`);
    }
  }
  await recordAction({
    actor: ACTOR,
    action: 'access.alerted',
    entityType: subject.kind,
    entityId: subject.key,
    // Who was actually told — not who we tried (STORY-038's lesson).
    metadata: { alerted: sent, attempted: admins.length },
  });
  return flagged;
}

/**
 * The security officer's report: events matching the filters, the totals, and
 * who has been flagged. Readable by those who read the audit trail across
 * tenants (admin, compliance).
 */
export async function accessReport({ authorId = null, userId = null, outcome = null, hours = 24, limit = 200 } = {}) {
  const conditions = ['e.occurred_at > now() - make_interval(hours => $1)'];
  const params = [Math.min(Math.max(Number(hours) || 24, 1), 24 * 90)];
  if (authorId) {
    params.push(Number(authorId));
    conditions.push(`e.author_id = $${params.length}`);
  }
  if (userId) {
    params.push(Number(userId));
    conditions.push(`e.user_id = $${params.length}`);
  }
  if (outcome === 'refused') {
    conditions.push("e.outcome IN ('denied', 'unauthenticated')");
  } else if (outcome) {
    params.push(outcome);
    conditions.push(`e.outcome = $${params.length}`);
  }
  const where = conditions.join(' AND ');
  const { rows: events } = await pool.query(
    `SELECT e.*, COALESCE(e.user_email, u.email) AS user_email, a.name AS tenant_name
       FROM data_access_events e
       LEFT JOIN authors a ON a.id = e.author_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where} ORDER BY e.id DESC LIMIT ${Math.min(Number(limit) || 200, 500)}`,
    params,
  );
  const { rows: [totals] } = await pool.query(
    `SELECT COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE outcome = 'allowed')::int AS allowed,
            COUNT(*) FILTER (WHERE outcome = 'denied')::int AS denied,
            COUNT(*) FILTER (WHERE outcome = 'unauthenticated')::int AS unauthenticated,
            COUNT(DISTINCT user_id)::int AS users,
            COUNT(DISTINCT author_id)::int AS tenants,
            COUNT(*) FILTER (WHERE user_id IS NULL AND outcome <> 'unauthenticated')::int AS unattributed
       FROM data_access_events e WHERE ${where}`,
    params,
  );
  const { rows: byTenant } = await pool.query(
    `SELECT e.author_id, a.name, COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE outcome = 'denied')::int AS denied,
            COUNT(DISTINCT e.user_id)::int AS users,
            COUNT(DISTINCT e.user_id) FILTER (WHERE e.actor_author_id IS DISTINCT FROM e.author_id)::int AS outside_users
       FROM data_access_events e LEFT JOIN authors a ON a.id = e.author_id
      WHERE ${where} AND e.author_id IS NOT NULL
      GROUP BY e.author_id, a.name ORDER BY events DESC`,
    params,
  );
  const { rows: flagged } = await pool.query(
    `SELECT l.entity_id AS subject_key, l.metadata, l.created_at,
            u.id AS user_id, u.email, u.role, u.active
       FROM audit_log l
       LEFT JOIN users u ON u.id = (l.metadata->>'userId')::bigint
      WHERE l.action = 'access.suspicious' AND l.created_at > now() - make_interval(hours => $1)
      ORDER BY l.id DESC LIMIT 20`,
    [params[0]],
  );
  return {
    hours: params[0],
    threshold: { refusals: config.accessAlertThreshold, minutes: config.accessAlertMinutes },
    totals,
    byTenant,
    flagged,
    events,
    recordingFailures: failures,
  };
}

/** A tenant's view of who has read its data — through the tenant's own view (STORY-041). */
export async function tenantAccessEvents(authorId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT occurred_at, user_email, user_role, actor_author_id, method, route, path, outcome, db_role, api_key_id
       FROM data_access_events WHERE author_id = $1 ORDER BY id DESC LIMIT $2`,
    [Number(authorId), Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Stops an account on its next request. Mitigation, logged with who and why. */
export async function setAccountBlocked({ userId, blocked, reason = '', user }) {
  if (Number(userId) === Number(user?.id)) throw fail(400, 'You cannot block your own account');
  if (blocked && (!reason || reason.trim().length < 10)) throw fail(400, 'Say why, in at least ten characters');
  const { rows: [target] } = await pool.query('SELECT id, email, role, active FROM users WHERE id = $1', [userId]);
  if (!target) throw fail(404, 'No such account');
  const { rows: [{ changed }] } = await pool.query(
    'SELECT ale_set_account_active($1, $2) AS changed',
    [userId, !blocked],
  );
  if (!changed) throw fail(409, blocked ? 'That account is already blocked' : 'That account is not blocked');
  // This process re-reads at once; any other API process within its one-second cache.
  forgetAccessVersion();
  await recordAction({
    actor: user?.name ?? ACTOR,
    action: blocked ? 'access.account_blocked' : 'access.account_unblocked',
    entityType: 'user',
    entityId: String(userId),
    before: { active: target.active },
    after: { active: !blocked },
    metadata: { email: target.email, role: target.role, reason: reason || null, by: user?.id ?? null },
  });
  return { id: Number(userId), email: target.email, active: !blocked };
}

/**
 * The security log (STORY-051): every attempt on an audit log, allowed or
 * refused, with who, from where and how it ended. Decrypted on the way out;
 * reading it is itself an attempt on an audit log, and is recorded.
 */
export async function securityLogReport({ hours = 24, outcome = null, limit = 200 } = {}) {
  const window = Math.min(Math.max(Number(hours) || 24, 1), 24 * 90);
  const params = [window];
  let filter = '';
  if (outcome === 'refused') filter = "AND outcome IN ('denied', 'unauthenticated')";
  else if (outcome) {
    params.push(outcome);
    filter = `AND outcome = $${params.length}`;
  }
  const { rows: entries } = await pool.query(
    `SELECT id, occurred_at, method, route, outcome, status, user_id, tenant_id, user_email, user_name, user_role,
            ip, user_agent, path, reason, api_key_id
       FROM security_log WHERE occurred_at > now() - make_interval(hours => $1) ${filter}
      ORDER BY id DESC LIMIT ${Math.min(Number(limit) || 200, 500)}`,
    params,
  );
  const { rows: [totals] } = await pool.query(
    `SELECT COUNT(*)::int AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'allowed')::int AS allowed,
            COUNT(*) FILTER (WHERE outcome IN ('denied', 'unauthenticated'))::int AS refused,
            COUNT(DISTINCT user_id)::int AS people
       FROM security_log WHERE occurred_at > now() - make_interval(hours => $1)`,
    [window],
  );
  return { hours: window, totals, entries };
}
