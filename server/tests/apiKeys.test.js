/**
 * STORY-045 acceptance tests.
 *
 *   "API key management" → given a tenant requests an API key, when the system
 *       generates and assigns a key, then the key is unique to the tenant and
 *       securely stored.
 *   Build step 3: API requests are validated against the correct tenant's key.
 *   Trust: log API key generation and usage events with tenant identifiers.
 *
 * Measured before this story: no per-tenant keys existed. The only key was the
 * application's own ANTHROPIC_API_KEY; an integration could reach the API only
 * by signing in as a person — with that person's password and permissions,
 * approval included.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { MAX_LIVE_KEYS } from '../src/services/apiKeys.js';
import { flushAccessLog } from '../src/services/dataAccess.js';

const stamp = Date.now();
let server;
let base;
let mine;
let theirs;
let mineToken;
let theirsToken;
let admin;
let readKey;
let writeKey;

const call = async ({ token, key, keyScheme = 'header' }, method, path, body) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key && keyScheme === 'header') headers['x-api-key'] = key;
  if (key && keyScheme === 'authorization') headers.authorization = `ApiKey ${key}`;
  const r = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call({}, 'POST', '/auth/login', { email, password })).body.token;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  mine = await onboardTenant({ name: 'Keys Mine', email: `keys-mine-${stamp}@example.test`, password: 'mine-password-1' });
  theirs = await onboardTenant({ name: 'Keys Theirs', email: `keys-theirs-${stamp}@example.test`, password: 'theirs-password-1' });
  mineToken = await login(`keys-mine-${stamp}@example.test`, 'mine-password-1');
  theirsToken = await login(`keys-theirs-${stamp}@example.test`, 'theirs-password-1');
  admin = await login('ops@example.test', 'ops-password');
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[mine.author.id, theirs.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: a tenant requests an API key', () => {
  it('the key is generated, assigned to the tenant, and shown exactly once', async () => {
    const r = await call({ token: mineToken }, 'POST', `/authors/${mine.author.id}/api-keys`, { name: 'Newsletter sync' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    readKey = r.body.key;
    assert.match(readKey, /^ale_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.authorId, Number(mine.author.id));
    assert.equal(r.body.access, 'read', 'read-only unless asked otherwise');
    const list = await call({ token: mineToken }, 'GET', `/authors/${mine.author.id}/api-keys`);
    assert.equal(list.status, 200);
    assert.ok(list.body.every((k) => !('key' in k)), 'the key came back a second time');
    assert.equal(list.body[0].prefix, r.body.prefix);
  });

  it('is stored only as a hash — the table is not a list of working keys', async () => {
    const { rows } = await query('SELECT * FROM tenant_api_keys WHERE author_id = $1', [mine.author.id]);
    assert.equal(rows.length, 1);
    // The secret is everything after `ale_<12-char prefix>_` — and may itself
    // contain underscores, so it is sliced, not split.
    const secret = readKey.slice('ale_'.length + 12 + 1);
    assert.equal(secret.length, 43);
    assert.ok(!JSON.stringify(rows).includes(secret), 'the secret is in the database');
    assert.equal(rows[0].secret_hash, createHash('sha256').update(readKey).digest('hex'));
  });

  it('every key is unique, and the database would refuse a duplicate', async () => {
    const second = await call({ token: mineToken }, 'POST', `/authors/${mine.author.id}/api-keys`, { name: 'Uploader', access: 'read_write', expiresInDays: 30 });
    writeKey = second.body.key;
    assert.notEqual(writeKey, readKey);
    const { rows: [row] } = await query('SELECT * FROM tenant_api_keys WHERE prefix = $1', [second.body.prefix]);
    await assert.rejects(
      () => query(
        `INSERT INTO tenant_api_keys (author_id, prefix, secret_hash, name, access, created_by, expires_at)
         VALUES ($1, 'duplicate000', $2, 'dup', 'read', $3, now() + interval '1 day')`,
        [theirs.author.id, row.secret_hash, theirs.user.id],
      ),
      /duplicate key/,
    );
  });

  it('generation is on the audit log with the tenant and the person', async () => {
    const { rows } = await query("SELECT actor, metadata FROM audit_log WHERE action = 'api_key.created' AND author_id = $1 ORDER BY id", [mine.author.id]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].metadata.tenant, Number(mine.author.id));
    assert.equal(rows[0].actor, 'Keys Mine');
    assert.ok(!JSON.stringify(rows).includes(readKey), 'the key is in the audit log');
  });
});

describe('Requests are validated against the correct tenant\'s key', () => {
  it('a key reads its own tenant, by either header, and each use is logged against tenant and key', async () => {
    const path = `/authors/${mine.author.id}/books`;
    assert.equal((await call({ key: readKey }, 'GET', path)).status, 200);
    assert.equal((await call({ key: readKey, keyScheme: 'authorization' }, 'GET', path)).status, 200);
    await flushAccessLog();
    const { rows: [e] } = await query('SELECT * FROM data_access_events WHERE path = $1 AND api_key_id IS NOT NULL ORDER BY id DESC LIMIT 1', [`/api${path}`]);
    assert.equal(Number(e.author_id), Number(mine.author.id));
    assert.equal(Number(e.user_id), mine.user.id, 'the person the key acts for');
    assert.equal(e.user_role, 'api_key');
    assert.equal(e.db_role, `ale_tenant_${mine.author.id}`, 'read through the tenant\'s own schema');
  });

  it('a key cannot reach another tenant', async () => {
    assert.equal((await call({ key: readKey }, 'GET', `/authors/${theirs.author.id}/books`)).status, 403);
  });

  it('a read-only key cannot write; a read-write key can', async () => {
    const book = { title: 'Via key', content: 'Uploaded by an integration.', themes: ['craft'] };
    const refused = await call({ key: readKey }, 'POST', `/authors/${mine.author.id}/books`, book);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /read-only/);
    assert.equal((await call({ key: writeKey }, 'POST', `/authors/${mine.author.id}/books`, book)).status, 201);
  });

  it('no key can approve — the approval gate stays human', async () => {
    const { rows: [b] } = await query("INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x','{craft}') RETURNING id", [mine.author.id]);
    const { rows: [d] } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
       VALUES ($1,$2,'twitter','x','pending_approval',0.9,CURRENT_DATE) RETURNING id`, [mine.author.id, b.id],
    );
    const r = await call({ key: writeKey }, 'POST', `/drafts/${d.id}/approve`, {});
    assert.equal(r.status, 403);
    assert.match(r.body.error, /content\.approve/);
  });

  it('a key cannot manage keys, and another tenant cannot manage this one\'s', async () => {
    assert.equal((await call({ key: writeKey }, 'POST', `/authors/${mine.author.id}/api-keys`, { name: 'x' })).status, 403);
    assert.equal((await call({ key: writeKey }, 'GET', `/authors/${mine.author.id}/api-keys`)).status, 403);
    assert.equal((await call({ token: theirsToken }, 'GET', `/authors/${mine.author.id}/api-keys`)).status, 403);
    const byAdmin = await call({ token: admin }, 'POST', `/authors/${theirs.author.id}/api-keys`, { name: 'Set up by ops' });
    assert.equal(byAdmin.status, 201, 'an admin who manages tenants can issue one');
  });
});

describe('Keys that must stop working', () => {
  it('revoked: refused on the next request, with the reason kept for the security officer only', async () => {
    const list = await call({ token: mineToken }, 'GET', `/authors/${mine.author.id}/api-keys`);
    const id = list.body.find((k) => readKey.includes(k.prefix)).id;
    assert.equal((await call({ token: mineToken }, 'POST', `/authors/${mine.author.id}/api-keys/${id}/revoke`, {})).status, 200);
    const path = `/authors/${mine.author.id}/milestones`;
    const r = await call({ key: readKey }, 'GET', path);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'API key not accepted', 'the caller learns nothing about why');
    await flushAccessLog();
    const { rows: [e] } = await query('SELECT reason FROM data_access_events WHERE path = $1 ORDER BY id DESC LIMIT 1', [`/api${path}`]);
    assert.match(e.reason, /was revoked/);
    const { rows: audit } = await query("SELECT 1 FROM audit_log WHERE action = 'api_key.revoked' AND author_id = $1", [mine.author.id]);
    assert.equal(audit.length, 1);
  });

  it('made up, or one character wrong: the same refusal', async () => {
    assert.equal((await call({ key: 'ale_000000000000_' + 'x'.repeat(43) }, 'GET', `/authors/${mine.author.id}/books`)).status, 401);
    const tampered = `${writeKey.slice(0, -1)}${writeKey.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await call({ key: tampered }, 'GET', `/authors/${mine.author.id}/books`)).status, 401);
  });

  it('expired', async () => {
    const prefix = writeKey.slice('ale_'.length, 'ale_'.length + 12);
    await ownerQuery(
      "UPDATE tenant_api_keys SET created_at = now() - interval '40 days', expires_at = now() - interval '1 second' WHERE prefix = $1", [prefix],
    );
    assert.equal((await call({ key: writeKey }, 'GET', `/authors/${mine.author.id}/books`)).status, 401);
    await ownerQuery("UPDATE tenant_api_keys SET expires_at = now() + interval '1 day' WHERE prefix = $1", [prefix]);
    assert.equal((await call({ key: writeKey }, 'GET', `/authors/${mine.author.id}/books`)).status, 200);
  });

  it('when the person it acts for is blocked (STORY-044), or the tenant is suspended', async () => {
    const path = `/authors/${mine.author.id}/books`;
    await call({ token: admin }, 'POST', `/security/accounts/${mine.user.id}/block`, { reason: 'test: does the key stop too' });
    assert.equal((await call({ key: writeKey }, 'GET', path)).status, 401);
    await call({ token: admin }, 'POST', `/security/accounts/${mine.user.id}/unblock`, {});
    assert.equal((await call({ key: writeKey }, 'GET', path)).status, 200);
    await call({ token: admin }, 'POST', `/tenants/${mine.author.id}/suspend`, { reason: 'test: suspended tenant' });
    assert.equal((await call({ key: writeKey }, 'GET', path)).status, 401);
    await call({ token: admin }, 'POST', `/tenants/${mine.author.id}/restore`, {});
  });

  it(`at most ${MAX_LIVE_KEYS} live keys per tenant`, async () => {
    const live = (await call({ token: admin }, 'GET', `/authors/${theirs.author.id}/api-keys`)).body.filter((k) => k.status === 'live').length;
    for (let i = live; i < MAX_LIVE_KEYS; i += 1) {
      assert.equal((await call({ token: theirsToken }, 'POST', `/authors/${theirs.author.id}/api-keys`, { name: `k${i}` })).status, 201);
    }
    assert.equal((await call({ token: theirsToken }, 'POST', `/authors/${theirs.author.id}/api-keys`, { name: 'one too many' })).status, 409);
  });
});
