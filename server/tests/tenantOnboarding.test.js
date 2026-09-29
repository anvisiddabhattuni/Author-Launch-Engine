/**
 * STORY-043 acceptance tests.
 *
 *   "Tenant onboarding" → when an admin onboards a new tenant, the author's
 *       account and a private schema are set up, and they get a welcome email.
 *   Trust: every onboarding is logged with the time and the admin's id.
 *
 * Measured before this story: onboarding was an API call with no screen and
 * no email; the audit row named the agent, not the admin; the author and the
 * account were committed separately, so a clash on the account left an author
 * nobody could ever sign in to; and the admin chose the author's password —
 * so the admin knew it, and it had to reach the author some other way.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { acceptInvite, devLink } from '../src/services/invites.js';

const stamp = Date.now();
let server;
let base;
let admin;
let author;
const created = [];

const post = async (path, body, token) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (path, token) => {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = (email, password) => post('/auth/login', { email, password });
const tokenOf = (link) => new URL(link).searchParams.get('token');

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  admin = (await login('ops@example.test', 'ops-password')).body.token;
  author = (await login('mira@example.test', 'quiet-craft')).body.token;
});

after(async () => {
  if (created.length) await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [created]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: an admin onboards a new tenant', () => {
  let onboarded;
  const email = `onboard-${stamp}@example.test`;

  it('creates the author, the account and the private schema in one request — with no password', async () => {
    const r = await post('/tenants', { name: 'Nadia Onboarded', email }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    onboarded = r.body;
    created.push(onboarded.author.id);
    assert.equal(onboarded.user.role, 'author');
    assert.equal(onboarded.user.activated, false, 'the account has a password nobody chose');
    assert.equal(onboarded.schema.name, `tenant_${onboarded.author.id}`);
    assert.ok(onboarded.schema.objects > 0);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [onboarded.user.id]);
    assert.equal(rows[0].password_hash, null);
  });

  it('the admin cannot choose the password — one sent is refused, not silently dropped', async () => {
    const r = await post('/tenants', { name: 'X', email: `onboard-pw-${stamp}@example.test`, password: 'admin-knows-this' }, admin);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /sets their own password/);
  });

  it('sends a welcome email through the declared path', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log WHERE action = 'tenant.onboarded' AND author_id = $1`, [onboarded.author.id],
    );
    assert.match(rows[0].metadata.welcomeEmail, /^msg_/, 'no welcome email was sent');
    const { rows: calls } = await query(
      "SELECT outcome FROM api_interactions WHERE service = 'email' AND author_id = $1", [onboarded.author.id],
    );
    assert.ok(calls.some((c) => c.outcome === 'ok'));
  });

  it('logs the time and the admin who did it — the person, not the agent', async () => {
    const { rows: [entry] } = await query(
      `SELECT actor, created_at, metadata FROM audit_log WHERE action = 'tenant.onboarded' AND author_id = $1`,
      [onboarded.author.id],
    );
    const { rows: [ops] } = await query("SELECT id, name FROM users WHERE email = 'ops@example.test'");
    assert.equal(entry.actor, ops.name);
    assert.equal(Number(entry.metadata.adminId), Number(ops.id));
    assert.ok(entry.created_at);
    assert.equal(entry.metadata.access, 'invitation');
    // A Date passed straight in was flattened to {} by the audit writer.
    assert.match(entry.metadata.inviteExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('the author cannot sign in until they accept, and the log says why', async () => {
    assert.equal((await login(email, 'anything-at-all')).status, 401);
    const { rows } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'auth.login_failed' AND metadata->>'email' = $1 ORDER BY id DESC LIMIT 1", [email],
    );
    assert.equal(rows[0]?.metadata.reason, 'invitation not yet accepted');
  });

  it('the link is stored only as a hash — the table is not a list of working invitations', async () => {
    const token = tokenOf(onboarded.invite.devInviteLink);
    const { rows } = await query('SELECT token_hash FROM tenant_invites WHERE author_id = $1', [onboarded.author.id]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  });

  it('the author sets their own password from the link, publicly, and is signed in', async () => {
    const token = tokenOf(onboarded.invite.devInviteLink);
    const r = await post('/auth/accept-invite', { token, password: 'my-own-password' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.equal((await login(email, 'my-own-password')).status, 200);
    const me = await get('/auth/me', r.body.token);
    assert.equal(Number(me.body.user.authorId), Number(onboarded.author.id));
  });

  it('and the link works once', async () => {
    const r = await post('/auth/accept-invite', { token: tokenOf(onboarded.invite.devInviteLink), password: 'someone-else-now' });
    assert.equal(r.status, 400);
    assert.equal((await login(email, 'someone-else-now')).status, 401);
    const { rows } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'tenant.invite_refused' AND author_id = $1 ORDER BY id DESC LIMIT 1",
      [onboarded.author.id],
    );
    assert.equal(rows[0]?.metadata.reason, 'already used', 'a refused link left no trace');
  });

  it('the admin\'s list shows who has signed in', async () => {
    const r = await get('/tenants', admin);
    assert.equal(r.status, 200);
    const row = r.body.find((t) => Number(t.id) === Number(onboarded.author.id));
    assert.equal(row.activated, true);
    assert.equal(row.has_schema, true);
    assert.equal(row.onboarded_by, 'Ops');
  });
});

describe('Links that should not work', () => {
  let tenant;

  before(async () => {
    tenant = await onboardTenant({ name: 'Link Tests', email: `onboard-links-${stamp}@example.test` });
    created.push(tenant.author.id);
  });

  it('a resend retires the old link', async () => {
    const first = tokenOf(tenant.invite.devInviteLink);
    const r = await post(`/tenants/${tenant.author.id}/invite`, {}, admin);
    assert.equal(r.status, 200);
    await assert.rejects(() => acceptInvite({ token: first, password: 'long-enough-1' }), /expired or has already been used/);
    const { rows } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'tenant.invite_refused' AND author_id = $1 ORDER BY id DESC LIMIT 1",
      [tenant.author.id],
    );
    assert.equal(rows[0].metadata.reason, 'replaced by a newer link');
    tenant.latest = tokenOf(r.body.devInviteLink);
  });

  it('an expired link is refused with the same answer', async () => {
    await ownerQuery(
      "UPDATE tenant_invites SET created_at = now() - interval '4 days', expires_at = now() - interval '1 second' WHERE author_id = $1 AND revoked_at IS NULL",
      [tenant.author.id],
    );
    await assert.rejects(() => acceptInvite({ token: tenant.latest, password: 'long-enough-1' }), /expired or has already been used/);
  });

  it('a made-up link is refused', async () => {
    const r = await post('/auth/accept-invite', { token: 'not-a-real-token', password: 'long-enough-1' });
    assert.equal(r.status, 400);
  });

  it('a short password is refused before the link is spent', async () => {
    const r = await post(`/tenants/${tenant.author.id}/invite`, {}, admin);
    const short = await post('/auth/accept-invite', { token: tokenOf(r.body.devInviteLink), password: 'short' });
    assert.equal(short.status, 400);
    const ok = await post('/auth/accept-invite', { token: tokenOf(r.body.devInviteLink), password: 'long-enough-1' });
    assert.equal(ok.status, 200, 'the short attempt used the link up');
  });

  it('once they have a password, resending is refused', async () => {
    assert.equal((await post(`/tenants/${tenant.author.id}/invite`, {}, admin)).status, 409);
  });

  it('in production the link is never in an API response — only in the email', () => {
    const was = config.nodeEnv;
    config.nodeEnv = 'production';
    try {
      assert.deepEqual(devLink('abc'), {});
    } finally {
      config.nodeEnv = was;
    }
  });
});

describe('Onboarding is all or nothing', () => {
  it('an address already used by a staff login leaves no half-made tenant behind', async () => {
    const staffEmail = `onboard-staff-${stamp}@example.test`;
    // An account whose address is not an author's: a second login on an
    // existing tenant, the shape a staff or assistant account takes.
    const { rows: [staff] } = await query(
      "INSERT INTO users (email, name, password_hash, role, author_id) VALUES ($1, 'Assistant', NULL, 'author', (SELECT id FROM authors WHERE email = 'mira@example.test')) RETURNING id",
      [staffEmail],
    );
    try {
      const r = await post('/tenants', { name: 'Clash', email: staffEmail }, admin);
      assert.equal(r.status, 409);
      const { rows } = await query('SELECT 1 FROM authors WHERE lower(email) = lower($1)', [staffEmail]);
      assert.equal(rows.length, 0, 'the author was committed without its account');
    } finally {
      await query('DELETE FROM users WHERE id = $1', [staff.id]);
    }
  });

  it('only those who manage tenants can onboard or list them', async () => {
    assert.equal((await post('/tenants', { name: 'X', email: `onboard-x-${stamp}@example.test` }, author)).status, 403);
    assert.equal((await get('/tenants', author)).status, 403);
  });
});
