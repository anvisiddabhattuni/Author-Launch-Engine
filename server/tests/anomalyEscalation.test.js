/**
 * STORY-059 acceptance tests — anomalies detected and escalated to a person.
 *
 *   Given the system is monitoring actions, when an anomaly is detected, then
 *   it is escalated to a human for review within 5 minutes.
 *
 *   Given an anomaly has been escalated, when the trust dashboard is accessed,
 *   then it is displayed prominently with details and status.
 *
 * Measured before: STORY-014's four detectors ran only when someone opened the
 * dashboard; nothing was stored, nothing had a status, nobody was told, and
 * none of them watched system activity (refusals, failures, bursts, volume).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { scanAndEscalate } from '../src/services/anomalyEscalation.js';
import { runChecks } from '../src/services/governance.js';

const stamp = Date.now();
let server;
let base;
let tenant;
let other;
const as = {};

const call = async (headers, method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
const refused = (authorId, count) => query(
  `INSERT INTO data_access_events (author_id, scope, method, route, path, status, outcome, ip)
   SELECT $1, 'tenant', 'GET', '/authors/:authorId/drafts', '/x', 401, 'unauthenticated', '203.0.113.' || (g % 5) FROM generate_series(1, $2) g`,
  [authorId, count],
);
const events = async (authorId) => (await ownerQuery('SELECT * FROM anomaly_events WHERE author_id = $1 ORDER BY id', [authorId])).rows;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Anomaly Author', email: `anom-${stamp}@example.test`, password: 'anomaly-pass-1' });
  other = await onboardTenant({ name: 'Anomaly Other', email: `anom-other-${stamp}@example.test`, password: 'anomaly-pass-2' });
  await query("INSERT INTO reviewers (author_id, name, email) VALUES ($1, 'Rev', $2)", [tenant.author.id, `anom-rev-${stamp}@example.test`]);
  as.me = await bearer(`anom-${stamp}@example.test`, 'anomaly-pass-1');
  as.other = await bearer(`anom-other-${stamp}@example.test`, 'anomaly-pass-2');
  as.auditor = await bearer('auditor@example.test', 'compliance-only');
});

after(async () => {
  for (const t of [tenant, other]) await query('DELETE FROM authors WHERE id = $1', [t.author.id]);
  await ownerQuery("DELETE FROM anomaly_events WHERE detector = 'test.late'");
  await new Promise((r) => server.close(r));
  await closePool();
});

describe('STORY-059: an anomaly is detected and escalated within five minutes', () => {
  it('below the threshold, nothing is raised', async () => {
    await refused(tenant.author.id, 5);
    await scanAndEscalate({});
    assert.equal((await events(tenant.author.id)).filter((e) => e.detector === 'access.refused_burst').length, 0);
  });

  it('a burst of refused requests is detected, and people are told in the same scan', async () => {
    await refused(tenant.author.id, 20);
    const started = Date.now();
    await scanAndEscalate({});
    const [e] = (await events(tenant.author.id)).filter((x) => x.detector === 'access.refused_burst');
    assert.ok(e, 'raised');
    assert.equal(e.severity, 'high');
    assert.match(e.summary, /refused requests/);
    assert.ok(e.escalated_at, 'escalated');
    const seconds = (new Date(e.escalated_at) - new Date(e.detected_at)) / 1000;
    assert.ok(seconds < 300, `within five minutes (${seconds}s)`);
    assert.ok(Date.now() - started < 60_000);
    assert.ok(e.escalated_to.includes(`anom-rev-${stamp}@example.test`), 'the tenant\'s reviewer');
    assert.ok(e.escalated_to.includes('auditor@example.test'), 'and the security officers');
  });

  it('escalation is on the audit log with how long it took', async () => {
    const [e] = (await events(tenant.author.id)).filter((x) => x.detector === 'access.refused_burst');
    const { rows: [log] } = await query("SELECT metadata FROM audit_log WHERE action = 'anomaly.escalated' AND entity_id = $1", [String(e.id)]);
    assert.ok(log.metadata.secondsToEscalate < 300);
  });

  it('a burst naming a tenant deleted since does not stop the scan', async () => {
    const gone = await onboardTenant({ name: 'Gone Author', email: `anom-gone-${stamp}@example.test`, password: 'gone-pass-12' });
    await refused(gone.author.id, 25);
    await query('DELETE FROM authors WHERE id = $1', [gone.author.id]);
    const r = await scanAndEscalate({});
    assert.ok(r.skippedDeletedTenants >= 1, 'skipped and counted, not crashed on');
  });

  it('a pattern that persists is counted, not re-announced', async () => {
    await scanAndEscalate({});
    const list = (await events(tenant.author.id)).filter((x) => x.detector === 'access.refused_burst');
    assert.equal(list.length, 1);
    assert.ok(list[0].occurrences >= 2, `seen again, counted (${list[0].occurrences})`);
    const { rows } = await query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'anomaly.escalated' AND entity_id = $1", [String(list[0].id)]);
    assert.equal(rows[0].n, 1, 'told once');
  });

  it('more approvals in a minute than anyone could read', async () => {
    const { rows: [b] } = await query("INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x','{craft}') RETURNING id", [tenant.author.id]);
    for (let i = 0; i < 10; i += 1) {
      const { rows: [d] } = await query(`INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
        VALUES ($1,$2,'twitter','p','approved',0.9,CURRENT_DATE) RETURNING id`, [tenant.author.id, b.id]);
      await query("INSERT INTO approvals (draft_id, decision, reviewer) VALUES ($1, 'approved', 'Speedy Reviewer')", [d.id]);
    }
    await scanAndEscalate({});
    const burst = (await events(tenant.author.id)).find((x) => x.detector === 'approvals.burst');
    assert.ok(burst);
    assert.match(burst.summary, /Speedy Reviewer approved 10 items within a minute/);
    assert.ok(burst.escalated_at);
  });

  it('a tenant far busier than its own normal — and not before it has a normal', async () => {
    const id = other.author.id;
    await query(`INSERT INTO audit_log (actor, action, entity_type, author_id, created_at)
                 SELECT 'x', 'draft.viewed', 'draft', $1, now() - interval '10 minutes' * g FROM generate_series(1, 5) g`, [id]);
    await query(`INSERT INTO audit_log (actor, action, entity_type, author_id, created_at)
                 SELECT 'x', 'draft.viewed', 'draft', $1, now() - interval '1 minute' FROM generate_series(1, 60)`, [id]);
    await scanAndEscalate({});
    assert.ok(!(await events(id)).some((e) => e.detector === 'activity.volume_spike'), 'no history, no verdict');
    await query("INSERT INTO audit_log (actor, action, entity_type, author_id, created_at) VALUES ('x', 'draft.viewed', 'draft', $1, now() - interval '23 hours 30 minutes')", [id]);
    await scanAndEscalate({});
    const spike = (await events(id)).find((e) => e.detector === 'activity.volume_spike');
    assert.ok(spike, 'with a day of history, 60 actions against a baseline of about one is a spike');
    assert.ok(spike.details.recent >= 60);
  });
});

describe('STORY-059: escalated anomalies on the trust dashboard', () => {
  it('shown with details and status, open first — to the tenant and to staff, not to others', async () => {
    const r = await call(as.me, 'GET', `/authors/${tenant.author.id}/anomalies`);
    assert.equal(r.status, 200);
    assert.ok(r.body.open >= 2);
    const [first] = r.body.events;
    assert.equal(first.status, 'open');
    assert.ok(first.details && first.escalated_to.length > 0);
    assert.equal((await call(as.other, 'GET', `/authors/${tenant.author.id}/anomalies`)).status, 403);
    assert.equal((await call(as.auditor, 'GET', `/authors/${tenant.author.id}/anomalies`)).status, 200);
  });

  it('the tenant\'s approver acknowledges, then resolves — saying what was done', async () => {
    const [e] = (await events(tenant.author.id)).filter((x) => x.detector === 'access.refused_burst');
    assert.equal((await call(as.me, 'POST', `/anomalies/${e.id}/acknowledge`, {})).body.status, 'acknowledged');
    assert.equal((await call(as.me, 'POST', `/anomalies/${e.id}/resolve`, { note: '' })).status, 400, 'a note is required');
    const done = await call(as.me, 'POST', `/anomalies/${e.id}/resolve`, { note: 'A misconfigured integration retrying without a key; key rotated.' });
    assert.equal(done.body.status, 'resolved');
    assert.equal(done.body.resolved_by, 'Anomaly Author');
    assert.equal((await call(as.other, 'POST', `/anomalies/${e.id}/acknowledge`, {})).status, 403);
  });

  it('the five minutes are checked: an anomaly not escalated in time fails a governance check', async () => {
    const before = (await runChecks({})).find((c) => c.id === 'anomalies.escalated_in_time');
    await ownerQuery(`INSERT INTO anomaly_events (author_id, detector, fingerprint, severity, summary, detected_at)
                      VALUES ($1, 'test.late', $2, 'high', 'late', now() - interval '10 minutes')`, [tenant.author.id, `test.late|${stamp}`]);
    const after = (await runChecks({})).find((c) => c.id === 'anomalies.escalated_in_time');
    assert.equal(after.passed, false);
    await ownerQuery("DELETE FROM anomaly_events WHERE detector = 'test.late'");
    assert.equal(before.passed, true, 'every real one above was escalated in time');
  });
});
