/**
 * STORY-028 acceptance tests.
 *
 *   "Generate audit log report" → given a stakeholder requests an audit log
 *       report, when it is generated, then it includes detailed records of all
 *       actions with timestamps and user details.
 *   "Secure report access" → given a user requests a report, when they have
 *       the permissions, access is granted; otherwise it is denied.
 *
 * Measured before this story: the audit list took a tenant, a type and a
 * limit. No period, no filter by person or action, no summary, no export, no
 * way to show a report had not been edited — and "who" was a name string, with
 * nothing saying whether it was a person, an agent, or neither.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { recordAction } from '../src/services/auditLog.js';

const stamp = Date.now();
let server;
let base;
let mine;
let theirs;
const as = {};

const call = async (headers, path) => {
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  mine = await onboardTenant({ name: 'Report Mine', email: `report-mine-${stamp}@example.test`, password: 'report-mine-pass' });
  theirs = await onboardTenant({ name: 'Report Theirs', email: `report-theirs-${stamp}@example.test`, password: 'report-theirs-pass' });
  as.author = await bearer(`report-mine-${stamp}@example.test`, 'report-mine-pass');
  as.otherAuthor = await bearer(`report-theirs-${stamp}@example.test`, 'report-theirs-pass');
  as.compliance = await bearer('auditor@example.test', 'compliance-only');
  // Actions in each tenant: a person's, an agent's.
  await recordAction({ actor: 'Report Mine', action: 'report.test_person', entityType: 'test', authorId: mine.author.id, metadata: { n: 1 } });
  await recordAction({ actor: 'ContentDraftingAgent', action: 'report.test_agent', entityType: 'test', authorId: mine.author.id });
  await recordAction({ actor: 'Report Theirs', action: 'report.test_person', entityType: 'test', authorId: theirs.author.id });
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[mine.author.id, theirs.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: a stakeholder requests an audit log report', () => {
  let report;

  it('it holds every action in the period, with its timestamp and who did it', async () => {
    const r = await call(as.compliance, `/audit-reports?authorId=${mine.author.id}&action=report.`);
    assert.equal(r.status, 200);
    report = r.body;
    assert.equal(report.summary.records, 2);
    for (const rec of report.records) {
      assert.ok(rec.created_at && rec.actor && rec.action, 'a record without time, actor or action');
    }
    const person = report.records.find((x) => x.action === 'report.test_person');
    assert.equal(person.actor_kind, 'person');
    assert.equal(person.actor_email, `report-mine-${stamp}@example.test`);
    assert.equal(person.actor_role, 'author');
    const agent = report.records.find((x) => x.action === 'report.test_agent');
    assert.equal(agent.actor_kind, 'agent');
  });

  it('summarised, stamped with who generated it, the seal status, and a digest of exactly its records', () => {
    assert.equal(report.generatedBy.name, 'Rae Lindqvist');
    assert.ok(['intact', 'altered', 'unsealed'].includes(report.integrity));
    assert.deepEqual(report.summary.byAction.map(([a]) => a).sort(), ['report.test_agent', 'report.test_person']);
    const recomputed = createHash('sha256').update(JSON.stringify(report.records.map((r) => [r.id, r.created_at, r.actor, r.action, r.entity_type, r.entity_id, r.author_id, r.before, r.after, r.metadata]))).digest('hex');
    assert.equal(report.digest, recomputed, 'the digest does not describe the records');
  });

  it('downloads as CSV, with the digest in the header', async () => {
    const r = await call(as.compliance, `/audit-reports?authorId=${mine.author.id}&action=report.&format=csv`);
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/csv/);
    assert.match(r.disposition, /attachment; filename="audit-report-/);
    assert.match(r.body, new RegExp(`sha256 ${report.digest}`));
    assert.equal(r.body.split('\n').filter((l) => l.includes('report.test_')).length, 2);
  });

  it('generating a report is itself on the audit log', async () => {
    const { rows } = await query("SELECT actor, metadata FROM audit_log WHERE action = 'audit.report_generated' AND metadata->>'digest' = $1", [report.digest]);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].actor, 'Rae Lindqvist');
  });

  it('refuses a period that runs backwards', async () => {
    assert.equal((await call(as.compliance, '/audit-reports?from=2026-09-10T00:00:00Z&to=2026-09-01T00:00:00Z')).status, 400);
  });
});

describe('Scenario: secure report access', () => {
  it('an author gets their own tenant\'s report — and nobody else\'s, not even by leaving the tenant out', async () => {
    const own = await call(as.author, '/audit-reports?action=report.');
    assert.equal(own.status, 200);
    assert.ok(own.body.records.length >= 2);
    assert.ok(own.body.records.every((r) => Number(r.author_id) === Number(mine.author.id)), 'another tenant\'s actions in an author\'s report');
    assert.equal((await call(as.author, `/audit-reports?authorId=${theirs.author.id}`)).status, 403);
  });

  it('compliance reports across tenants', async () => {
    const all = await call(as.compliance, '/audit-reports?action=report.test_person');
    const tenants = new Set(all.body.records.map((r) => Number(r.author_id)));
    assert.ok(tenants.has(Number(mine.author.id)) && tenants.has(Number(theirs.author.id)), `saw ${[...tenants]} of ${all.body.summary.records}, want ${mine.author.id} and ${theirs.author.id}`);
  });

  it('no session, or an API key (no permissions): denied', async () => {
    assert.equal((await call({}, '/audit-reports')).status, 401);
    const key = await (await fetch(`${base}/authors/${mine.author.id}/api-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...as.author }, body: JSON.stringify({ name: 'report probe' }),
    })).json();
    assert.equal((await call({ 'x-api-key': key.key }, '/audit-reports')).status, 403);
  });
});
