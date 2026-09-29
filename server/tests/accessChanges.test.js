/**
 * STORY-042 acceptance tests.
 *
 *   "Access control enforcement" → when the system checks a user's credentials
 *       and permissions, they can only access their own tenant's data.
 *   Trust: any new role or permission change is reviewed and approved by an admin.
 *
 * The first clause has held since STORY-017 (the application) and STORY-041
 * (the database); `tenantIsolation.test.js` and `tenantSchemas.test.js` carry
 * it. This file is the trust clause, measured before this story as three holes:
 * no reviewed way to change access at all; one admin minting another through
 * onboarding in a single request; and a revoked permission that kept working
 * for the life of the session token.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { decideChange, proposeChange, withdrawChange } from '../src/services/accessChanges.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { upsertUser } from '../src/services/auth.js';
import { CHECKS, runChecks } from '../src/services/governance.js';

const stamp = Date.now();
let server;
let base;
let alice; // admin — proposes
let bob; // admin — approves
let tenant;
let tenantToken;

const login = async (email, password) =>
  (await (await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })).json()).token;
const call = async (token, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** A session-shaped user for calling the service directly. */
const asUser = (u) => ({ id: Number(u.id), name: u.name, permissions: ['access.manage'] });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  alice = await upsertUser({ email: `access-alice-${stamp}@example.test`, name: 'Alice Admin', password: 'alice-password', role: 'admin' });
  bob = await upsertUser({ email: `access-bob-${stamp}@example.test`, name: 'Bob Admin', password: 'bob-password', role: 'admin' });
  tenant = await onboardTenant({ name: 'Access Tenant', email: `access-tenant-${stamp}@example.test`, password: 'tenant-password' });
  tenantToken = await login(`access-tenant-${stamp}@example.test`, 'tenant-password');
});

after(async () => {
  await query("DELETE FROM access_changes WHERE reason LIKE 'test:%'");
  await query('DELETE FROM authors WHERE id = $1', [tenant.author.id]);
  await query('DELETE FROM users WHERE id = ANY($1::bigint[])', [[alice.id, bob.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: no one grants themselves, or anyone, access alone', () => {
  it('onboarding refuses a privileged role — one admin can no longer mint another', async () => {
    await assert.rejects(
      () => onboardTenant({ name: 'X', email: `access-minted-${stamp}@example.test`, password: 'long-enough-3', role: 'admin' }),
      /request an access change — another admin must approve it/,
    );
  });

  it('a sign-up cannot rewrite an existing account\'s role either', async () => {
    await assert.rejects(
      () => upsertUser({ email: `access-tenant-${stamp}@example.test`, name: 'X', password: 'whatever-1', role: 'admin', authorId: tenant.author.id }),
      /Changing a role is a reviewed access change/,
    );
  });

  it('the application login cannot write grants or roles directly — only the reviewed function can', async () => {
    await assert.rejects(() => query("INSERT INTO role_permissions (role, permission) VALUES ('author', 'tenant.manage')"), /permission denied/);
    await assert.rejects(() => query("UPDATE users SET role = 'admin' WHERE id = $1", [tenant.user.id]), /permission denied/);
  });

  it('a request needs a reason, and changes nothing until decided', async () => {
    await assert.rejects(() => proposeChange({ kind: 'assign_role', userId: tenant.user.id, newRole: 'compliance', reason: 'short', user: asUser(alice) }), /at least ten/);
    const change = await proposeChange({ kind: 'assign_role', userId: tenant.user.id, newRole: 'compliance', reason: 'test: needs to read every tenant for the audit', user: asUser(alice) });
    assert.equal(change.status, 'pending');
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [tenant.user.id]);
    assert.equal(rows[0].role, 'author', 'a pending request changed something');
    await withdrawChange({ id: change.id, user: asUser(alice) });
  });
});

describe('Scenario: a second admin reviews and approves', () => {
  let change;

  it('the requester cannot approve their own request — the service says so, and the database refuses it', async () => {
    change = await proposeChange({ kind: 'grant_permission', role: 'compliance', permission: 'templates.manage', reason: 'test: compliance reviews template licences', user: asUser(alice) });
    await assert.rejects(() => decideChange({ id: change.id, user: asUser(alice), approve: true }), /Another admin has to decide it/);
    // And beneath the service, for any path that does not go through it.
    await assert.rejects(
      () => query("UPDATE access_changes SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [change.id]),
      /access_changes_two_people/,
    );
  });

  it('a different admin approves, and the change applies in the same step', async () => {
    const applied = await decideChange({ id: change.id, user: asUser(bob), approve: true, note: 'agreed' });
    assert.equal(applied.status, 'approved');
    assert.ok(applied.applied_at);
    const { rows } = await query("SELECT 1 FROM role_permissions WHERE role = 'compliance' AND permission = 'templates.manage'");
    assert.equal(rows.length, 1);
  });

  it('who asked, who agreed, and what moved are all on the audit log', async () => {
    const entries = (await listAuditLog({ entityType: 'access_change', limit: 50 })).filter((e) => e.entity_id === String(change.id));
    const actions = entries.map((e) => e.action).sort();
    assert.deepEqual(actions, ['access.change_applied', 'access.change_approved', 'access.change_requested']);
    const appliedEntry = entries.find((e) => e.action === 'access.change_applied');
    assert.ok(!appliedEntry.before.permissions.includes('templates.manage'));
    assert.ok(appliedEntry.after.permissions.includes('templates.manage'));
    assert.equal(entries.find((e) => e.action === 'access.change_requested').actor, 'Alice Admin');
    assert.equal(entries.find((e) => e.action === 'access.change_approved').actor, 'Bob Admin');
  });

  it('put back the same way', async () => {
    const back = await proposeChange({ kind: 'revoke_permission', role: 'compliance', permission: 'templates.manage', reason: 'test: restore the grant matrix', user: asUser(bob) });
    await decideChange({ id: back.id, user: asUser(alice), approve: true });
    const { rows } = await query("SELECT 1 FROM role_permissions WHERE role = 'compliance' AND permission = 'templates.manage'");
    assert.equal(rows.length, 0);
  });
});

describe('An approved change takes effect on the next request, not at token expiry', () => {
  it('a session that could approve cannot, one request after its permission is revoked', async () => {
    const { rows: [book] } = await query(
      "INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x','{craft}') RETURNING id", [tenant.author.id],
    );
    const drafts = [];
    for (let i = 0; i < 2; i += 1) {
      drafts.push((await query(
        `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
         VALUES ($1,$2,'twitter','pending','pending_approval',0.9,CURRENT_DATE) RETURNING id`, [tenant.author.id, book.id],
      )).rows[0]);
    }
    assert.equal((await call(tenantToken, 'POST', `/drafts/${drafts[0].id}/approve`, {})).status, 200);

    const revoke = await proposeChange({ kind: 'revoke_permission', role: 'author', permission: 'content.approve', reason: 'test: revoke to prove it bites at once', user: asUser(alice) });
    await decideChange({ id: revoke.id, user: asUser(bob), approve: true });
    try {
      // The very same token. Before STORY-042 this was 200 for up to 12 hours.
      const r = await call(tenantToken, 'POST', `/drafts/${drafts[1].id}/approve`, {});
      assert.equal(r.status, 403);
    } finally {
      const restore = await proposeChange({ kind: 'grant_permission', role: 'author', permission: 'content.approve', reason: 'test: restore after the revocation test', user: asUser(bob) });
      await decideChange({ id: restore.id, user: asUser(alice), approve: true });
    }
    assert.equal((await call(tenantToken, 'POST', `/drafts/${drafts[1].id}/approve`, {})).status, 200, 'the restore did not take effect either');
  });
});

describe('Checked from outside', () => {
  it('the governance invariant counts an elevated account nobody approved', async () => {
    // The check's own SQL, narrowed to one account. Comparing the global count
    // before and after raced every other suite that creates staff accounts.
    const check = CHECKS.find((c) => c.id === 'access.elevated_reviewed');
    const countFor = async (id) =>
      (await query(check.sql.replace('WHERE u.active', 'WHERE u.id = $1 AND u.active'), [id])).rows[0].n;
    const rogue = await upsertUser({ email: `access-rogue-${stamp}@example.test`, name: 'Rogue', password: 'rogue-password', role: 'compliance' });
    try {
      assert.equal(await countFor(rogue.id), 1, 'a role nobody approved went uncounted');
      assert.equal(await countFor(alice.id), 1, 'and so is an admin made outside review');
      assert.ok((await runChecks({})).find((c) => c.id === 'access.elevated_reviewed').violations >= 1);
    } finally {
      await query('DELETE FROM users WHERE id = $1', [rogue.id]);
    }
  });

  it('the Access view is for those who manage access or read the audit trail — not authors', async () => {
    assert.equal((await call(tenantToken, 'GET', '/access')).status, 403);
    const auditor = await login('auditor@example.test', 'compliance-only');
    const r = await call(auditor, 'GET', '/access');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.changes) && Array.isArray(r.body.matrix));
  });
});
