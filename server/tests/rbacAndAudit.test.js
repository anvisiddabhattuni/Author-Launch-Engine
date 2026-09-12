/**
 * STORY-019 acceptance tests.
 *
 * Two Gherkin scenarios, and one of them had never been implemented:
 *
 *   "Log agent action"        → every action logged with who, what, when and
 *                               the before-after states.
 *   "Secure audit log access" → a user with the right RBAC permissions reads
 *                               the log; otherwise access is denied.
 *
 * Measured before writing any of this: `GET /api/audit-log` had no guard at
 * all. The 403 an author got asking for another tenant came from
 * `enforceTenant` — tenant scoping, which answers "whose rows?" rather than
 * "may this role read audit data?". The tests below therefore check the second
 * question specifically, including the case that proves the two are different:
 * a role that reads every tenant's log and can change nothing.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, pool, query } from '../src/db/pool.js';
import { REDACTED, recordAction, redact } from '../src/services/auditLog.js';
import { CHECKS, runChecks } from '../src/services/governance.js';
import { PERMISSIONS, grantMatrix, holds, permissionsForRole } from '../src/services/permissions.js';
import { restoreTenant, suspendTenant } from '../src/agents/tenantManagementAgent.js';
import { upsertUser } from '../src/services/auth.js';

let server;
let baseUrl;
let authorId;
let otherAuthorId;
const token = {};

const signIn = async (email, password) => {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert.ok(body.token, `could not sign in as ${email}: ${JSON.stringify(body)}`);
  return body.token;
};

const status = async (role, path, method = 'GET', body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token[role]}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response.status;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const stamp = Date.now();
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['RBAC Test Author', `rbac-${stamp}@example.test`],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['RBAC Other Author', `rbac-other-${stamp}@example.test`],
  );
  otherAuthorId = b[0].id;

  await upsertUser({
    email: `rbac-author-${stamp}@example.test`,
    name: 'RBAC Author User',
    password: 'rbac-password',
    role: 'author',
    authorId,
  });
  await upsertUser({
    email: `rbac-compliance-${stamp}@example.test`,
    name: 'RBAC Compliance User',
    password: 'rbac-password',
    role: 'compliance',
    authorId: null,
  });
  await upsertUser({
    email: `rbac-admin-${stamp}@example.test`,
    name: 'RBAC Admin User',
    password: 'rbac-password',
    role: 'admin',
    authorId: null,
  });

  token.author = await signIn(`rbac-author-${stamp}@example.test`, 'rbac-password');
  token.compliance = await signIn(`rbac-compliance-${stamp}@example.test`, 'rbac-password');
  token.admin = await signIn(`rbac-admin-${stamp}@example.test`, 'rbac-password');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: Secure audit log access', () => {
  it('lets a permitted user read the log', async () => {
    assert.equal(await status('author', '/audit-log'), 200);
    assert.equal(await status('compliance', '/audit-log'), 200);
    assert.equal(await status('admin', '/audit-log'), 200);
  });

  it('denies a user who holds no audit permission', async () => {
    // A role with nothing granted. The point: denial is the default, so a role
    // added later is denied until somebody grants it rather than inheriting
    // access from having been added.
    await query(
      `INSERT INTO roles (name, description) VALUES ('observer','Granted nothing, on purpose.')
       ON CONFLICT (name) DO NOTHING`,
    );
    const stamp = Date.now();
    await upsertUser({
      email: `rbac-observer-${stamp}@example.test`,
      name: 'RBAC Observer',
      password: 'rbac-password',
      role: 'observer',
      authorId,
    });
    token.observer = await signIn(`rbac-observer-${stamp}@example.test`, 'rbac-password');

    assert.deepEqual(await permissionsForRole('observer'), []);
    assert.equal(await status('observer', '/audit-log'), 403);
  });

  it('denies integrity verification to someone who may only read', async () => {
    // The distinction role checks could not express: reading the log and
    // verifying it are different permissions.
    assert.equal(await status('author', '/audit-integrity'), 403);
    assert.equal(await status('author', '/audit-integrity/verify', 'POST'), 403);
    assert.equal(await status('compliance', '/audit-integrity'), 200);
  });

  it('scopes an author to their own tenant and lets compliance cross it', async () => {
    assert.equal(await status('author', `/audit-log?authorId=${otherAuthorId}`), 403);
    assert.equal(await status('compliance', `/audit-log?authorId=${otherAuthorId}`), 200);
  });
});

describe('Reading the audit log is not permission to change anything', () => {
  it('refuses tenant management to a compliance session', async () => {
    assert.equal(await status('compliance', `/tenants/${otherAuthorId}/suspend`, 'POST', { reason: 'x' }), 403);
    assert.equal(await status('compliance', `/tenants/${otherAuthorId}/restore`, 'POST'), 403);
    assert.equal(await status('compliance', '/tenants', 'POST', { name: 'X', email: 'x@y.test', password: 'longenough' }), 403);
  });

  it('refuses template curation to a compliance session', async () => {
    assert.equal(await status('compliance', '/meme-templates', 'POST', { key: 'x' }), 403);
  });

  it('is the separation a role check could not express', async () => {
    const matrix = await grantMatrix();
    const compliance = matrix.find((r) => r.role === 'compliance');
    const admin = matrix.find((r) => r.role === 'admin');

    assert.ok(compliance.permissions.includes(PERMISSIONS.AUDIT_READ));
    assert.ok(compliance.permissions.includes(PERMISSIONS.TENANT_READ_ALL));
    assert.equal(compliance.permissions.includes(PERMISSIONS.TENANT_MANAGE), false);
    // The admin still has everything, so the new role took nothing away.
    assert.ok(admin.permissions.includes(PERMISSIONS.TENANT_MANAGE));
  });

  it('008 said adding a role would be a row rather than a migration to every check', async () => {
    // Taking that claim at its word: `compliance` was added by this story and
    // no route names it. If any route did, this would be the test that says so.
    const routes = await (await import('node:fs/promises')).readFile(
      new URL('../src/routes/index.js', import.meta.url),
      'utf8',
    );
    assert.equal(routes.includes("'compliance'"), false, 'a route hardcodes the compliance role');
    assert.equal(routes.includes('requireRole'), false, 'a route still guards on role rather than permission');
  });
});

describe('A tenantless account must be able to read across tenants', () => {
  it('refuses an account with no tenant and no cross-tenant permission', async () => {
    // 008 wrote this as CHECK (role = 'admin' OR author_id IS NOT NULL) — the
    // same conflation, in the schema. It rejected the first compliance user.
    await assert.rejects(
      () =>
        upsertUser({
          email: `rbac-stranded-${Date.now()}@example.test`,
          name: 'Stranded',
          password: 'rbac-password',
          role: 'author',
          authorId: null,
        }),
      (error) => {
        assert.match(error.message, /cannot read across tenants|could see nothing/);
        return true;
      },
    );
  });
});

describe('Scenario: Log agent action — the before-after states', () => {
  it('records both states when a tenant is suspended and restored', async () => {
    await suspendTenant({ authorId: otherAuthorId, reason: 'story-019 test', user: { name: 'ops' } });
    const { rows: suspended } = await query(
      "SELECT * FROM audit_log WHERE action = 'tenant.suspended' AND author_id = $1 ORDER BY id DESC LIMIT 1",
      [otherAuthorId],
    );
    assert.ok(suspended[0], 'suspension was not logged');
    assert.equal(suspended[0].before.tenant_status, 'active');
    assert.equal(suspended[0].after.tenant_status, 'suspended');

    await restoreTenant({ authorId: otherAuthorId, user: { name: 'ops' } });
    const { rows: restored } = await query(
      "SELECT * FROM audit_log WHERE action = 'tenant.restored' AND author_id = $1 ORDER BY id DESC LIMIT 1",
      [otherAuthorId],
    );
    assert.equal(restored[0].before.tenant_status, 'suspended');
    assert.equal(restored[0].after.tenant_status, 'active');
  });

  it('checks the rule from outside, and only for real transitions', async () => {
    assert.ok(CHECKS.some((c) => c.id === 'audit.states_recorded'));
    const result = (await runChecks({})).find((c) => c.id === 'audit.states_recorded');
    assert.equal(result.passed, true, `${result.violations} transitions recorded no states`);

    // The check must not demand states from a creation, a scan, or a gate
    // refusal — none of them has a prior state, and requiring one would be
    // requiring fiction. `meme_template.rejected` is the case that caught the
    // first version of this check out: 67 refusals counted as violations.
    // Written here rather than borrowed from another suite: these files each
    // make their own fixtures, and a test that needs someone else's rows passes
    // or fails on run order.
    await recordAction({
      actor: 'story-019-test',
      action: 'draft.created',
      entityType: 'draft',
      entityId: 0,
      authorId,
      after: { status: 'pending_approval' },
    });
    await recordAction({
      actor: 'story-019-test',
      action: 'trust.scan_completed',
      entityType: 'author',
      entityId: authorId,
      authorId,
      metadata: { examined: 3 },
    });
    await recordAction({
      actor: 'story-019-test',
      action: 'meme_template.rejected',
      entityType: 'meme_template',
      entityId: 'some-key',
      authorId,
      metadata: { reason: 'no licence' },
    });

    const afterFixtures = (await runChecks({})).find((c) => c.id === 'audit.states_recorded');
    assert.equal(
      afterFixtures.passed,
      true,
      'a creation and a scan should not count as transitions missing their states',
    );
  });

  it('does count a transition that records no states', async () => {
    // The check has to be able to fail, or it is decoration.
    //
    // Proving that needs a bad row, and a bad row here is permanent: the table
    // refuses UPDATE and DELETE, so a poison fixture would leave this check red
    // in every later run and in the demo — a governance check nobody can clear
    // is one people learn to scroll past, which is the STORY-017 lesson.
    // A rolled-back transaction is the way out: the triggers block edits to
    // committed rows and have nothing to say about a write that never commits.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordAction(
        {
          actor: 'story-019-test',
          action: 'draft.rejected',
          entityType: 'draft',
          entityId: 1,
          authorId,
          metadata: { note: 'a transition recording neither state' },
        },
        client,
      );

      const check = CHECKS.find((c) => c.id === 'audit.states_recorded');
      const { rows } = await client.query(check.sql);
      assert.ok(rows[0].n >= 1, 'a stateless transition slipped past the check');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // And the committed log is still clean afterwards.
    const result = (await runChecks({})).find((c) => c.id === 'audit.states_recorded');
    assert.equal(result.passed, true, 'the rollback left a row behind');
  });
});

describe('TBI: a secret cannot be written to a table nothing can edit', () => {
  it('redacts credential-shaped fields at any depth', () => {
    const out = redact({
      email: 'keep@example.test',
      password_hash: 'scrypt$abc',
      nested: { api_key: 'sk-live-1', deeper: [{ token: 't' }, { note: 'keep' }] },
    });
    assert.equal(out.email, 'keep@example.test');
    assert.equal(out.password_hash, REDACTED);
    assert.equal(out.nested.api_key, REDACTED);
    assert.equal(out.nested.deeper[0].token, REDACTED);
    assert.equal(out.nested.deeper[1].note, 'keep');
  });

  it('keeps the key and replaces the value, rather than dropping the field', () => {
    // That a write touched a credential is itself an audit fact. Dropping the
    // key would make the log quietly incomplete.
    const out = redact({ password: 'hunter2' });
    assert.ok('password' in out);
    assert.equal(out.password, REDACTED);
  });

  it('survives a cycle rather than taking the transaction down with it', () => {
    const loop = { name: 'row' };
    loop.self = loop;
    assert.equal(redact(loop).self, '[circular]');
  });

  it('redacts a whole users row logged through recordAction', async () => {
    // The live hazard: 28 call sites pass `after: row`. The day one of those
    // rows is a users row, the hash is in an append-only table forever.
    const { rows: users } = await query('SELECT * FROM users LIMIT 1');
    assert.ok(users[0].password_hash, 'fixture user has no hash to leak');

    const written = await recordAction({
      actor: 'story-019-test',
      action: 'user.audited',
      entityType: 'user',
      entityId: users[0].id,
      after: users[0],
    });
    assert.equal(written.after.password_hash, REDACTED);
    assert.equal(written.after.email, users[0].email, 'an email is not a credential');
  });

  it('leaves no credential-shaped value anywhere in the log', async () => {
    const { rows } = await query('SELECT before, after, metadata FROM audit_log');
    const KEYS = /^(password|password_hash|token|secret|api_?key|authorization|credential|salt|jwt)$/i;
    const offenders = [];
    const walk = (value) => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        if (KEYS.test(key) && inner !== REDACTED) offenders.push(`${key}=${String(inner).slice(0, 20)}`);
        walk(inner);
      }
    };
    for (const row of rows) {
      walk(row.before);
      walk(row.after);
      walk(row.metadata);
    }
    assert.deepEqual(offenders, [], 'unredacted credentials in an append-only table');
  });
});

describe('The session carries what it was granted', () => {
  it('puts permissions in the token so the guard can be synchronous', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token.compliance}` },
    });
    const { user } = await response.json();
    assert.ok(Array.isArray(user.permissions));
    assert.ok(holds(user, PERMISSIONS.AUDIT_VERIFY));
    assert.equal(holds(user, PERMISSIONS.TENANT_MANAGE), false);
  });

  it('treats a token with no permissions claim as holding none', () => {
    // A session issued before this story must be denied by the new guard, not
    // waved through by it.
    assert.equal(holds({ role: 'admin' }, PERMISSIONS.TENANT_MANAGE), false);
    assert.equal(holds({ role: 'admin', permissions: null }, PERMISSIONS.AUDIT_READ), false);
  });

  it('records the grants on the login, so a later access question is answerable', async () => {
    const { rows } = await query(
      "SELECT * FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 5",
    );
    const withGrants = rows.find((r) => Array.isArray(r.metadata.permissions));
    assert.ok(withGrants, 'no login recorded what it granted');
  });
});
