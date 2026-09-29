/**
 * STORY-022 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Access control enforcement" → an action requiring permissions is granted
 *       or denied on the user's role.
 *   "Audit log access"           → the audit log is granted or denied likewise.
 *
 * Both passed before this story started; STORY-019 built them. The fourth build
 * step did not: "Integrate RBAC checks with audit log access **and approval
 * processes**." Measured first, and the gap was worse than an omission —
 * eight approve/reject routes carried no permission check at all, and the
 * `compliance` role, added by STORY-019 to read everything and change nothing,
 * approved a press release in another tenant on the first attempt.
 *
 * The mechanism is the thing to remember. STORY-019 replaced `role === 'admin'`
 * with `holds(user, 'tenant.read.all')` in three guards. Two of them decide
 * which tenant a request may *address*; the third, `assertOwns`, decides whether
 * a caller may *act on a row*. A read permission became a write permission for
 * every row-addressed action, and it was invisible because at that moment only
 * `admin` held it — and for an admin the two had always been the same.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { PERMISSIONS, grantMatrix, permissionsForRole } from '../src/services/permissions.js';
import { upsertUser } from '../src/services/auth.js';

let server;
let baseUrl;
let authorId;
let otherAuthorId;
let draftId;
let otherDraftId;
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

const post = async (role, path, body = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token[role]}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

/** A fresh draft awaiting a decision, so each test has its own target. */
const pendingDraft = async (owner) => {
  const { rows: book } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [owner, 'Permissions Book', 'A book about craft.', ['craft']],
  );
  const { rows } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                         theme_alignment, week_of)
     VALUES ($1,$2,'twitter','a draft awaiting a decision','pending_approval',0.9,0.9,CURRENT_DATE)
     RETURNING *`,
    [owner, book[0].id],
  );
  return rows[0].id;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const stamp = Date.now();
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Approval Perms Author', `approvalperms-${stamp}@example.test`],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Approval Perms Other', `approvalperms-other-${stamp}@example.test`],
  );
  otherAuthorId = b[0].id;

  for (const [role, tenant] of [['author', authorId], ['compliance', null], ['admin', null]]) {
    await upsertUser({
      email: `approvalperms-${role}-${stamp}@example.test`,
      name: `Approval Perms ${role}`,
      password: 'approval-password',
      role,
      authorId: tenant,
    });
    token[role] = await signIn(`approvalperms-${role}-${stamp}@example.test`, 'approval-password');
  }

  draftId = await pendingDraft(authorId);
  otherDraftId = await pendingDraft(otherAuthorId);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: access control enforcement — approving is a permission', () => {
  it('lets a role that holds content.approve approve', async () => {
    const result = await post('author', `/drafts/${draftId}/approve`, { notes: 'looks right' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'approved');
  });

  it('refuses a role that does not', async () => {
    // The regression this story exists for. Before it, this returned 200.
    const target = await pendingDraft(authorId);
    const result = await post('compliance', `/drafts/${target}/approve`, { notes: 'by compliance' });
    assert.equal(result.status, 403, `compliance approved a draft: ${JSON.stringify(result.body)}`);
    assert.match(result.body.error, /content\.approve/);

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [target]);
    assert.equal(rows[0].status, 'pending_approval', 'the draft moved anyway');
  });

  it('refuses rejection too, not only approval', async () => {
    // Rejecting is also a decision about outbound content, and a role that may
    // not approve must not be able to bin someone's work either.
    const target = await pendingDraft(authorId);
    const result = await post('compliance', `/drafts/${target}/reject`, { notes: 'no' });
    assert.equal(result.status, 403);
  });

  it('covers every approvable kind, not just drafts', async () => {
    // Four things are approvable. A permission on one of them is a gate on one
    // door of a building with four.
    for (const path of [
      '/outreach-messages/1/approve',
      '/pr-materials/1/approve',
      '/mix-recommendations/1/approve',
    ]) {
      const result = await post('compliance', path, {});
      assert.equal(result.status, 403, `${path} was not permission-gated`);
      assert.match(result.body.error, /content\.approve/);
    }
  });
});

describe('Reading across tenants is not acting across tenants', () => {
  it('still lets compliance read another tenant', async () => {
    // The power it is supposed to have, unchanged.
    const response = await fetch(`${baseUrl}/audit-log?authorId=${otherAuthorId}`, {
      headers: { Authorization: `Bearer ${token.compliance}` },
    });
    assert.equal(response.status, 200);
  });

  it('refuses compliance acting on another tenant, even with a permission it lacks', async () => {
    const result = await post('compliance', `/drafts/${otherDraftId}/approve`, {});
    assert.equal(result.status, 403);
  });

  it('grants tenant.act.all only to admin', async () => {
    const matrix = await grantMatrix();
    const holders = matrix
      .filter((r) => r.permissions.includes(PERMISSIONS.TENANT_ACT_ALL))
      .map((r) => r.role);
    assert.deepEqual(holders, ['admin']);

    // And the read permission is held more widely, which is the whole reason
    // they had to become two.
    const readers = matrix
      .filter((r) => r.permissions.includes(PERMISSIONS.TENANT_READ_ALL))
      .map((r) => r.role)
      .sort();
    assert.deepEqual(readers, ['admin', 'compliance']);
  });

  it('lets an admin act across tenants', async () => {
    const result = await post('admin', `/drafts/${otherDraftId}/approve`, { notes: 'operator' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  it('confines an author to their own tenant', async () => {
    const target = await pendingDraft(otherAuthorId);
    const result = await post('author', `/drafts/${target}/approve`, {});
    assert.equal(result.status, 403);
    assert.match(result.body.error, /belongs to another author/);
  });
});

describe('The grant table says what each role may do', () => {
  it('gives author the approval permission and nothing operational', async () => {
    const perms = await permissionsForRole('author');
    assert.ok(perms.includes(PERMISSIONS.CONTENT_APPROVE));
    assert.equal(perms.includes(PERMISSIONS.TENANT_MANAGE), false);
    assert.equal(perms.includes(PERMISSIONS.TENANT_ACT_ALL), false);
  });

  it('gives compliance neither approval nor action', async () => {
    const perms = await permissionsForRole('compliance');
    assert.equal(perms.includes(PERMISSIONS.CONTENT_APPROVE), false);
    assert.equal(perms.includes(PERMISSIONS.TENANT_ACT_ALL), false);
    // What it does keep: seeing everything.
    assert.ok(perms.includes(PERMISSIONS.AUDIT_READ));
    assert.ok(perms.includes(PERMISSIONS.TENANT_READ_ALL));
  });
});

describe('Scenario: audit log access', () => {
  it('grants it to a role holding audit.read and denies one without', async () => {
    // STORY-019's clause, re-asserted here because STORY-022 names it too and a
    // regression in it would be as serious as the approval one.
    const allowed = await fetch(`${baseUrl}/audit-log`, {
      headers: { Authorization: `Bearer ${token.compliance}` },
    });
    assert.equal(allowed.status, 200);

    await query(
      `INSERT INTO roles (name, description) VALUES ('nothing','Granted nothing.')
       ON CONFLICT (name) DO NOTHING`,
    );
    const stamp = Date.now();
    await upsertUser({
      email: `approvalperms-nothing-${stamp}@example.test`,
      name: 'Granted Nothing',
      password: 'approval-password',
      role: 'nothing',
      authorId,
    });
    const denied = await fetch(`${baseUrl}/audit-log`, {
      headers: {
        Authorization: `Bearer ${await signIn(`approvalperms-nothing-${stamp}@example.test`, 'approval-password')}`,
      },
    });
    assert.equal(denied.status, 403);
  });
});

describe('No approve route is left unguarded', () => {
  it('every approve and reject route carries the permission', async () => {
    // The scan, rather than a list somebody keeps in their head. STORY-020's
    // lesson: a check that verifies the gates that exist cannot see a missing
    // one, so this reads the routes and counts.
    const source = await (await import('node:fs/promises')).readFile(
      new URL('../src/routes/index.js', import.meta.url),
      'utf8',
    );
    // Each kind of approval has its own gate: content needs content.approve;
    // access changes (STORY-042) need access.manage — a publicist who may
    // approve a press release must not thereby approve who else may.
    const GATES = [['/access/', 'ACCESS_MANAGE']];
    const unguarded = [];
    for (const match of source.matchAll(/router\.post\('([^']*\/(?:approve|reject))',\s*([^\n]*)/g)) {
      const needed = GATES.find(([prefix]) => match[1].startsWith(prefix))?.[1] ?? 'CONTENT_APPROVE';
      if (!match[2].includes(needed)) unguarded.push(`${match[1]} (needs ${needed})`);
    }
    assert.deepEqual(unguarded, [], 'an approve/reject route has no permission on it');
  });
});
