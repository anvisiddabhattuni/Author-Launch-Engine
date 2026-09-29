/**
 * STORY-050 acceptance tests.
 *
 *   "Access audit logs with RBAC" → given a user with a specific role attempts
 *       to access audit logs, when the system checks the user's role, then
 *       access is granted or denied based on the role's permissions.
 *
 * Measured before this story: the permissions existed (audit.read, audit.verify
 * — STORY-019), but three routes served audit data guarded only by the tenant
 * rule, so an API key — which holds no permissions — read a tenant's access
 * log, trust history and trust dashboard. Two more carried their own copies of
 * the reviewer check. Nothing tied "which routes serve audit data" to "which
 * permission guards them", so the next route could forget.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { router } from '../src/routes/index.js';
import { AUDIT_DATA, AUDIT_ROUTES, REVIEWER, auditAccessPolicy } from '../src/services/auditAccess.js';

const stamp = Date.now();
let server;
let base;
let mine;
let theirs;
const as = {};

const call = async (headers, method, path) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined });
  return r.status;
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};

/** Every route on the live router: its key, its guards, and its handler source. */
const liveRoutes = () =>
  router.stack.filter((l) => l.route).map((l) => ({
    key: `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`,
    guards: l.route.stack.map((s) => s.handle.permission).filter(Boolean),
    source: l.route.stack.map((s) => s.handle.source ?? '').join('\n'),
  }));

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  mine = await onboardTenant({ name: 'RBAC Mine', email: `rbac-mine-${stamp}@example.test`, password: 'rbac-mine-pass' });
  theirs = await onboardTenant({ name: 'RBAC Theirs', email: `rbac-theirs-${stamp}@example.test`, password: 'rbac-theirs-pass' });
  as.none = {};
  as.author = await bearer(`rbac-mine-${stamp}@example.test`, 'rbac-mine-pass');
  as.otherAuthor = await bearer(`rbac-theirs-${stamp}@example.test`, 'rbac-theirs-pass');
  as.compliance = await bearer('auditor@example.test', 'compliance-only');
  as.admin = await bearer('ops@example.test', 'ops-password');
  const key = await (await fetch(`${base}/authors/${mine.author.id}/api-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...as.author }, body: JSON.stringify({ name: 'rbac probe' }),
  })).json();
  as.apiKey = { 'x-api-key': key.key };
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[mine.author.id, theirs.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('The roles and permissions for audit logs are declared — and the router is held to them', () => {
  it('every route whose handler reads audit data is declared, with a reason', () => {
    const undeclared = liveRoutes().filter((r) => AUDIT_DATA.test(r.source) && !(r.key in AUDIT_ROUTES)).map((r) => r.key);
    assert.deepEqual(undeclared, [], 'audit data served by a route nobody declared');
    for (const [route, spec] of Object.entries(AUDIT_ROUTES)) assert.ok(spec.why?.length > 20, `${route} has no reason`);
  });

  it('every declared route exists, and is guarded by exactly the permission declared for it', () => {
    const live = new Map(liveRoutes().map((r) => [r.key, r]));
    const wrong = [];
    for (const [route, spec] of Object.entries(AUDIT_ROUTES)) {
      const r = live.get(route);
      if (!r) wrong.push(`${route}: no such route`);
      else if (!r.guards.includes(spec.permission)) wrong.push(`${route}: guarded by ${r.guards.join(', ') || 'nothing'}, declared ${spec.permission}`);
    }
    assert.deepEqual(wrong, []);
  });
});

describe('Scenario: a user with a role attempts to access audit logs', () => {
  /** Expected status for a principal on a route, from the declared policy. */
  const expected = (who, route, spec) => {
    if (who === 'none') return 401;
    if (who === 'apiKey') return 403;
    const perms = {
      author: ['audit.read', 'content.approve'],
      otherAuthor: ['audit.read', 'content.approve'],
      compliance: ['audit.read', 'audit.verify', 'tenant.read.all'],
      admin: ['access.manage', 'audit.read', 'audit.verify', 'tenant.read.all', 'tenant.manage'],
    }[who];
    const holds = spec.permission === REVIEWER
      ? perms.includes('access.manage') || (perms.includes('audit.read') && perms.includes('tenant.read.all'))
      : perms.includes(spec.permission);
    if (!holds) return 403;
    // The tenant rule (STORY-017) on top: another author's tenant is not theirs.
    if (who === 'otherAuthor' && route.includes(':authorId')) return 403;
    // Granted, but the search index is not set up here (STORY-055): it says so.
    if (route === 'GET /authors/:authorId/search' && !config.elasticsearchUrl) return 503;
    return route.startsWith('POST') ? 201 : 200;
  };

  for (const who of ['none', 'author', 'otherAuthor', 'compliance', 'admin', 'apiKey']) {
    it(`${who}: granted or denied on every audit route exactly as the policy says`, async () => {
      const mismatches = [];
      for (const [route, spec] of Object.entries(AUDIT_ROUTES)) {
        const [method, path] = route.split(' ');
        const got = await call(as[who], method, path.replace(':authorId', String(mine.author.id)));
        const want = expected(who, route, spec);
        if (got !== want) mismatches.push(`${route}: ${got}, expected ${want}`);
      }
      assert.deepEqual(mismatches, []);
    });
  }

  it('an API key — no permissions of its own — reads none of it; before this story it read three', async () => {
    for (const path of ['access-events', 'trust-history', 'trust-dashboard']) {
      assert.equal(await call(as.apiKey, 'GET', `/authors/${mine.author.id}/${path}`), 403, path);
    }
  });

  it('a refusal is recorded against the person and the route (STORY-044)', async () => {
    await call(as.author, 'GET', '/audit-integrity');
    const { rows: [e] } = await query(
      "SELECT outcome, reason FROM data_access_events WHERE route = '/audit-integrity' AND user_id = $1 ORDER BY id DESC LIMIT 1",
      [mine.user.id],
    );
    assert.equal(e?.outcome, 'denied');
    assert.match(e.reason, /audit\.verify/);
  });
});

describe('The policy the product shows is the one it enforces', () => {
  it('derived from the live grant table: every role and an API key, for every audit route', async () => {
    const policy = await auditAccessPolicy();
    assert.equal(policy.length, Object.keys(AUDIT_ROUTES).length);
    const log = policy.find((p) => p.route === 'GET /audit-log');
    assert.equal(log.roles.author, 'own tenant');
    assert.equal(log.roles.compliance, 'all tenants');
    assert.equal(log.roles['api key'], 'no');
    const verify = policy.find((p) => p.route === 'POST /audit-integrity/verify');
    assert.equal(verify.roles.author, 'no');
  });

  it('only reviewers may read it', async () => {
    assert.equal(await call(as.author, 'GET', '/security/audit-access-policy'), 403);
    assert.equal(await call(as.compliance, 'GET', '/security/audit-access-policy'), 200);
  });
});
