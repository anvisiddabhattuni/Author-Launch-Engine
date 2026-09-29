/**
 * STORY-051 acceptance tests.
 *
 *   "Monitor audit log access" → given an attempt to access audit logs is made,
 *       when the attempt is logged, then it is recorded in a separate security
 *       log with user details and outcome.
 *   Build step 3: the security log is also encrypted and access-controlled.
 *
 * Measured before this story: attempts on the audit logs landed in the data
 * access log (STORY-044) — in the clear, among every other request, readable by
 * whoever reads that log. Nothing separate, nothing encrypted.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { keyedOptions } from '../src/services/auditKey.js';
import { flushAccessLog } from '../src/services/dataAccess.js';
import { runChecks } from '../src/services/governance.js';

const stamp = Date.now();
let server;
let base;
let tenant;
const as = {};

const call = async (headers, path, extra = {}) =>
  (await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json', ...headers, ...extra } })).status;
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
/**
 * The newest security log entry for a path — by this person, or with no
 * session, since other suites reach the same routes at the same moment.
 */
const latestFor = async (path, email = null) => {
  await flushAccessLog();
  const { rows: [entry] } = await query(
    `SELECT * FROM security_log WHERE path = $1 AND ${email ? 'user_email = $2' : 'user_id IS NULL'} ORDER BY id DESC LIMIT 1`,
    email ? [`/api${path}`, email] : [`/api${path}`],
  );
  return entry;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Seclog Author', email: `seclog-${stamp}@example.test`, password: 'seclog-password' });
  as.author = await bearer(`seclog-${stamp}@example.test`, 'seclog-password');
  as.compliance = await bearer('auditor@example.test', 'compliance-only');
  const key = await (await fetch(`${base}/authors/${tenant.author.id}/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...as.author }, body: JSON.stringify({ name: 'seclog probe' }),
  })).json();
  as.apiKey = { 'x-api-key': key.key };
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[tenant.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: an attempt to access audit logs is recorded, with user details and outcome', () => {
  it('an allowed read: who, their role, from where, with what browser, and that it was allowed', async () => {
    const path = `/audit-log?authorId=${tenant.author.id}`;
    assert.equal(await call(as.compliance, path, { 'user-agent': 'SeclogTest/1.0' }), 200);
    const e = await latestFor('/audit-log', 'auditor@example.test');
    assert.equal(e.outcome, 'allowed');
    assert.equal(e.route, 'GET /audit-log');
    assert.equal(e.user_email, 'auditor@example.test');
    assert.equal(e.user_role, 'compliance');
    assert.equal(e.user_agent, 'SeclogTest/1.0');
    assert.ok(e.ip);
  });

  it('a refused attempt, with the reason', async () => {
    assert.equal(await call(as.author, '/audit-integrity'), 403);
    const e = await latestFor('/audit-integrity', `seclog-${stamp}@example.test`);
    assert.equal(e.outcome, 'denied');
    assert.equal(e.user_email, `seclog-${stamp}@example.test`);
    assert.match(e.reason, /audit\.verify/);
  });

  it('an attempt with no session, and one with an API key', async () => {
    assert.equal(await call({}, `/authors/${tenant.author.id}/trust-history`), 401);
    const anon = await latestFor(`/authors/${tenant.author.id}/trust-history`);
    assert.equal(anon.outcome, 'unauthenticated');
    assert.equal(anon.user_id, null);
    assert.equal(anon.route, 'GET /authors/:authorId/trust-history', 'refused before routing, still recognised');
    assert.equal(await call(as.apiKey, `/authors/${tenant.author.id}/access-events`), 403);
    const keyed = await latestFor(`/authors/${tenant.author.id}/access-events`, `seclog-${stamp}@example.test`);
    assert.ok(keyed.api_key_id, 'the key is named');
  });

  it('only audit logs: an ordinary read is not in the security log', async () => {
    const path = `/authors/${tenant.author.id}/books`;
    await call(as.author, path);
    await flushAccessLog();
    const { rows } = await query('SELECT 1 FROM security_log WHERE path = $1', [`/api${path}`]);
    assert.equal(rows.length, 0);
  });
});

describe('Separate, encrypted and access-controlled', () => {
  it('separate from the audit trail, and linked to the access record by request', async () => {
    await flushAccessLog();
    const { rows: [e] } = await query('SELECT request_id FROM security_log ORDER BY id DESC LIMIT 1');
    const { rows: access } = await query('SELECT audit_route FROM data_access_events WHERE request_id = $1', [e.request_id]);
    assert.equal(access.length, 1);
    assert.equal(access[0].audit_route, true);
    const { rows: inTrail } = await query("SELECT 1 FROM audit_log WHERE entity_type = 'security_log' LIMIT 1");
    assert.equal(inTrail.length, 0, 'the security log is not rows in the audit log');
  });

  it('stored encrypted with AES-256 — the email is not in the stored bytes', async () => {
    const { rows: [stored] } = await ownerQuery(
      "SELECT get_byte(payload, 3) AS cipher, position(convert_to('auditor@example.test', 'UTF8') IN payload) AS found FROM security_log_sealed ORDER BY id DESC LIMIT 1",
    );
    assert.equal(stored.cipher, 9);
    assert.equal(stored.found, 0);
  });

  it('without the key, nobody reads who it was', async () => {
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await client.connect();
    try {
      const { rows: [e] } = await client.query('SELECT outcome, user_email FROM security_log ORDER BY id DESC LIMIT 1');
      assert.ok(e.outcome);
      assert.equal(e.user_email, null);
    } finally {
      await client.end();
    }
  });

  it('the application reaches it only through the encrypting view; the read-only role not at all', async () => {
    await assert.rejects(() => query('SELECT * FROM security_log_sealed LIMIT 1'), /permission denied/);
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, options: keyedOptions });
    await client.connect();
    try {
      await client.query('SET ROLE ale_readonly');
      await assert.rejects(() => client.query('SELECT * FROM security_log LIMIT 1'), /permission denied/);
    } finally {
      await client.end();
    }
  });

  it('append-only', async () => {
    await assert.rejects(() => ownerQuery("UPDATE security_log_sealed SET outcome = 'allowed'"), /append-only/);
    await assert.rejects(() => ownerQuery('DELETE FROM security_log_sealed'), /append-only/);
  });

  it('only reviewers read it — and reading it is itself recorded there', async () => {
    assert.equal(await call(as.author, '/security/audit-access'), 403);
    const r = await fetch(`${base}/security/audit-access?outcome=refused`, { headers: as.compliance });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.entries.every((e) => ['denied', 'unauthenticated'].includes(e.outcome)));
    assert.ok(body.totals.refused >= 3);
    // The auditor's own entry: other suites hit this route at the same moment.
    await flushAccessLog();
    const { rows: [e] } = await query(
      "SELECT user_email FROM security_log WHERE path = '/api/security/audit-access' AND user_email = 'auditor@example.test' AND occurred_at > now() - interval '1 minute' LIMIT 1",
    );
    assert.ok(e, 'reading the security log was not recorded in it');
  });
});

describe('Checked from outside', () => {
  it('the invariant: every access record on an audit route has its security entry', async () => {
    await flushAccessLog();
    const check = (await runChecks({})).find((c) => c.id === 'security_log.complete');
    assert.equal(check.passed, true, `${check.violations} audit-route accesses missing from the security log`);
    // And it fails when one is missing.
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, options: keyedOptions });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO data_access_events (user_id, scope, method, route, path, status, outcome, request_id, audit_route)
         VALUES (1, 'all_tenants', 'GET', '/audit-log', '/api/audit-log', 200, 'allowed', gen_random_uuid(), TRUE)`,
      );
      const inTx = (await runChecks({}, client)).find((c) => c.id === 'security_log.complete');
      assert.equal(inTx.passed, false);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
