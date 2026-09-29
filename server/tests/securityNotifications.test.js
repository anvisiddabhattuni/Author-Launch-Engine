/**
 * STORY-052 acceptance tests.
 *
 *   "Unauthorized access notification" → given an unauthorized access attempt
 *       to audit logs is detected, when the system identifies the attempt, then
 *       a notification is sent to the security officer with details of it.
 *
 * Measured before this story: refused attempts on the audit logs were recorded
 * (STORY-044, STORY-051) and nobody was told. The only alert was STORY-044's —
 * after five refusals of any kind, to admins, about data access in general.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { flushAccessLog } from '../src/services/dataAccess.js';
import { WINDOW_MINUTES, securityOfficers } from '../src/services/securityNotifications.js';

const stamp = Date.now();
let server;
let base;
let tenant;
const as = {};

const call = async (headers, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await call({}, 'POST', '/auth/login', { email, password });
  return { authorization: `Bearer ${r.body.token}` };
};
const forUser = async (userId) => {
  await flushAccessLog();
  const { rows } = await query('SELECT * FROM security_notifications WHERE user_id = $1 ORDER BY id', [userId]);
  return rows;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Notify Author', email: `notify-${stamp}@example.test`, password: 'notify-password' });
  as.author = await bearer(`notify-${stamp}@example.test`, 'notify-password');
  as.compliance = await bearer('auditor@example.test', 'compliance-only');
  as.admin = await bearer('ops@example.test', 'ops-password');
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[tenant.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: an unauthorized attempt on the audit logs is detected', () => {
  it('the first refused attempt notifies every security officer at once, with the details', async () => {
    assert.equal((await call({ ...as.author, 'user-agent': 'NotifyTest/2.0' }, 'GET', '/audit-integrity')).status, 403);
    const [n] = await forUser(tenant.user.id);
    assert.ok(n, 'nobody was notified');
    const officers = (await securityOfficers()).map((o) => o.email).sort();
    assert.ok(officers.includes('auditor@example.test') && officers.includes('ops@example.test'));
    assert.deepEqual([...n.delivered].sort(), officers, 'not every officer received it');
    assert.deepEqual(n.failed, []);
    assert.equal(n.route, 'GET /audit-integrity');
    assert.equal(n.outcome, 'denied');
    assert.match(n.reason, /audit\.verify/);
    assert.match(n.subject_label, new RegExp(`notify-${stamp}@example.test \\(author\\)`));
  });

  it('the email carries who, what, when, from where and why — and it is on the audit log', async () => {
    const [n] = await forUser(tenant.user.id);
    const { rows: [entry] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'security.notified' AND entity_id = $1", [String(n.id)],
    );
    assert.equal(entry.metadata.route, 'GET /audit-integrity');
    assert.deepEqual([...entry.metadata.delivered].sort(), [...n.delivered].sort());
    const { rows: [sent] } = await query(
      "SELECT COUNT(*)::int AS n FROM api_interactions WHERE service = 'email' AND outcome = 'ok' AND created_at > $1", [n.first_at],
    );
    assert.ok(sent.n >= n.delivered.length, 'the gateway has no record of the sends');
  });

  it(`further attempts in the next ${WINDOW_MINUTES} minutes join that alert — one notice, with the count`, async () => {
    await call(as.author, 'GET', '/security/audit-access');
    await call(as.author, 'GET', '/audit-integrity');
    const notes = await forUser(tenant.user.id);
    assert.equal(notes.length, 1, 'a burst of attempts sent a burst of alerts');
    assert.equal(notes[0].attempts, 3);
    assert.deepEqual([...notes[0].routes_tried].sort(), ['GET /audit-integrity', 'GET /security/audit-access']);
  });

  it('an attempt with no session is identified by where it came from', async () => {
    assert.equal((await call({}, 'GET', `/authors/${tenant.author.id}/access-events`)).status, 401);
    await flushAccessLog();
    // Keyed by address: earlier no-session attempts from this machine may have
    // opened the alert already, and this one joins it.
    const { rows: [n] } = await query(
      "SELECT * FROM security_notifications WHERE subject_key LIKE 'ip:%' AND 'GET /authors/:authorId/access-events' = ANY(routes_tried) ORDER BY id DESC LIMIT 1",
    );
    assert.ok(n, 'the attempt reached no alert');
    assert.match(n.subject_label, /no session, from/);
  });

  it('an allowed read notifies nobody', async () => {
    const before = (await query('SELECT COUNT(*)::int AS n FROM security_notifications')).rows[0].n;
    await call(as.compliance, 'GET', '/audit-log');
    await flushAccessLog();
    const afterCount = (await query('SELECT COUNT(*)::int AS n FROM security_notifications')).rows[0].n;
    assert.equal(afterCount, before);
  });
});

describe('The officer takes action', () => {
  it('officers see open alerts and acknowledge them; the acknowledgement is recorded', async () => {
    const list = await call(as.compliance, 'GET', '/security/notifications?open=true');
    assert.equal(list.status, 200);
    const mine = list.body.find((n) => Number(n.user_id) === tenant.user.id);
    const ack = await call(as.compliance, 'POST', `/security/notifications/${mine.id}/acknowledge`, { note: 'Spoke to the author; clicked a link by mistake.' });
    assert.equal(ack.status, 200);
    assert.ok(ack.body.acknowledged_at);
    const { rows: [e] } = await query("SELECT actor, metadata FROM audit_log WHERE action = 'security.notification_acknowledged' AND entity_id = $1", [String(mine.id)]);
    assert.equal(e.actor, 'Rae Lindqvist');
    assert.equal((await call(as.compliance, 'POST', `/security/notifications/${mine.id}/acknowledge`, {})).status, 404, 'acknowledged twice');
  });

  it('only security officers see or acknowledge them', async () => {
    assert.equal((await call(as.author, 'GET', '/security/notifications')).status, 403);
  });
});
