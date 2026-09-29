/**
 * STORY-044 acceptance tests.
 *
 *   "Audit tenant data access" → given the system logs data access events,
 *       when an audit is performed, then all access events are traceable to a
 *       specific tenant and user.
 *   Trust: capture all data access events with user and tenant identifiers.
 *
 * Measured before this story: nothing that was only read was recorded, and a
 * request for another tenant's data was refused and forgotten. The audit log
 * held changes; nobody could answer "who has looked at this tenant's data?"
 * or "has anyone been trying doors?".
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { flushAccessLog } from '../src/services/dataAccess.js';
import { classifyRoutes, fillPath } from '../src/services/tenantSurface.js';

const stamp = Date.now();
let server;
let base;
let mine;
let theirs;
let mineToken;
let theirsToken;
let admin;
let auditor;
let theirDraft;

const call = async (token, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call(null, 'POST', '/auth/login', { email, password })).body.token;
/** The events one path produced, newest first — after every pending write lands. */
const eventsFor = async (path, extra = '') => {
  await flushAccessLog();
  const { rows } = await query(`SELECT * FROM data_access_events WHERE path = $1 ${extra} ORDER BY id DESC`, [`/api${path}`]);
  return rows;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  mine = await onboardTenant({ name: 'Audit Mine', email: `dal-mine-${stamp}@example.test`, password: 'mine-password-1' });
  theirs = await onboardTenant({ name: 'Audit Theirs', email: `dal-theirs-${stamp}@example.test`, password: 'theirs-password-1' });
  mineToken = await login(`dal-mine-${stamp}@example.test`, 'mine-password-1');
  theirsToken = await login(`dal-theirs-${stamp}@example.test`, 'theirs-password-1');
  admin = await login('ops@example.test', 'ops-password');
  auditor = await login('auditor@example.test', 'compliance-only');
  const { rows: [b] } = await query(
    "INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','Craft is slow.','{craft}') RETURNING id", [theirs.author.id],
  );
  theirDraft = (await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
     VALUES ($1,$2,'twitter','theirs','pending_approval',0.9,CURRENT_DATE) RETURNING id`, [theirs.author.id, b.id],
  )).rows[0];
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[mine.author.id, theirs.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: every access is traceable to a tenant and a user', () => {
  it('an author reading their own data: who, whose, what, and the database role that served it', async () => {
    const path = `/authors/${mine.author.id}/books`;
    assert.equal((await call(mineToken, 'GET', path)).status, 200);
    const [e] = await eventsFor(path);
    assert.equal(Number(e.user_id), mine.user.id);
    assert.equal(e.user_email, `dal-mine-${stamp}@example.test`);
    assert.equal(Number(e.author_id), Number(mine.author.id));
    assert.equal(e.scope, 'tenant');
    assert.equal(e.outcome, 'allowed');
    assert.equal(e.route, '/authors/:authorId/books');
    assert.equal(e.db_role, `ale_tenant_${mine.author.id}`, 'the tenant-scoped role from STORY-041');
  });

  it('a request for another tenant\'s data is refused — and now recorded, against the tenant it was aimed at', async () => {
    const path = `/authors/${theirs.author.id}/books`;
    assert.equal((await call(mineToken, 'GET', path)).status, 403);
    const [e] = await eventsFor(path);
    assert.equal(e.outcome, 'denied');
    assert.equal(Number(e.author_id), Number(theirs.author.id));
    assert.equal(Number(e.actor_author_id), Number(mine.author.id));
    assert.match(e.reason, /addresses author/);
    assert.equal(e.db_role, null, 'a refused request read nothing');
  });

  it('acting on another tenant\'s row by id names that tenant too', async () => {
    const path = `/drafts/${theirDraft.id}/approve`;
    assert.equal((await call(mineToken, 'POST', path, {})).status, 403);
    const [e] = await eventsFor(path);
    assert.equal(e.outcome, 'denied');
    assert.equal(Number(e.author_id), Number(theirs.author.id));
  });

  it('an admin reading a tenant is recorded against that tenant; reading across all of them says so', async () => {
    const one = `/authors/${mine.author.id}/books`;
    await call(admin, 'GET', one);
    const [e] = await eventsFor(one, "AND user_role = 'admin'");
    assert.equal(Number(e.author_id), Number(mine.author.id));
    assert.equal(e.db_role, 'ale_app_login');
    await call(admin, 'GET', '/tenants');
    const [all] = await eventsFor('/tenants', "AND user_role = 'admin'");
    assert.equal(all.scope, 'all_tenants');
    assert.equal(all.author_id, null);
  });

  it('an attempt with no session is recorded with where it came from', async () => {
    const path = `/authors/${mine.author.id}/books`;
    assert.equal((await call(null, 'GET', path)).status, 401);
    const [e] = await eventsFor(path, "AND outcome = 'unauthenticated'");
    assert.equal(e.user_id, null);
    assert.ok(e.ip);
    assert.equal(Number(e.author_id), Number(mine.author.id));
  });
});

describe('The record itself', () => {
  it('the database refuses an event with no user, or a tenant event with no tenant', async () => {
    await assert.rejects(
      () => query("INSERT INTO data_access_events (scope, method, route, path, status, outcome) VALUES ('all_tenants','GET','/x','/x',200,'allowed')"),
      /data_access_events_has_user/,
    );
    await assert.rejects(
      () => query("INSERT INTO data_access_events (user_id, scope, method, route, path, status, outcome) VALUES (1,'tenant','GET','/x','/x',200,'allowed')"),
      /data_access_events_has_tenant/,
    );
  });

  it('is append-only: the application cannot change it, and the trigger stops even the owner', async () => {
    await assert.rejects(() => query('DELETE FROM data_access_events WHERE id = (SELECT MIN(id) FROM data_access_events)'), /permission denied/);
    await assert.rejects(() => query("UPDATE data_access_events SET outcome = 'allowed'"), /permission denied/);
    await assert.rejects(() => ownerQuery('DELETE FROM data_access_events WHERE id = (SELECT MIN(id) FROM data_access_events)'), /append-only/);
  });

  it('coverage: every read route the tenant walk can reach leaves exactly one record', async () => {
    const { walkable } = classifyRoutes();
    const missing = [];
    for (const route of walkable) {
      const path = fillPath(route, { authorId: mine.author.id, bookId: 1 });
      // This user's only: other suites poll some of these routes concurrently.
      const own = `AND user_id = ${Number(mine.user.id)}`;
      const before = (await eventsFor(path, own)).length;
      await call(mineToken, 'GET', path);
      const after = (await eventsFor(path, own)).length;
      if (after !== before + 1) missing.push(`${route} (${after - before})`);
    }
    assert.deepEqual(missing, [], 'routes whose access was not recorded exactly once');
    assert.ok(walkable.length > 20, `walked only ${walkable.length} routes`);
  });
});

describe('Scenario: unauthorized attempts are identified and mitigated', () => {
  it(`an account refused ${config.accessAlertThreshold} times is flagged once and the admins are told`, async () => {
    for (let i = 0; i < config.accessAlertThreshold + 1; i += 1) {
      await call(mineToken, 'GET', `/authors/${theirs.author.id}/books`);
    }
    await flushAccessLog();
    const key = `user:${mine.user.id}`;
    const { rows: flagged } = await query("SELECT metadata FROM audit_log WHERE action = 'access.suspicious' AND entity_id = $1", [key]);
    assert.equal(flagged.length, 1, 'flagged more or less than once');
    // Counted from every refusal in the window — the coverage walk above was
    // refused admin-only routes on the author's own tenant, and those count.
    // At least the threshold: records are written as responses finish, so the
    // count taken when the fifth lands may already include the sixth.
    assert.ok(flagged[0].metadata.refusals >= config.accessAlertThreshold);
    const { rows: tried } = await query(
      "SELECT DISTINCT author_id FROM data_access_events WHERE user_id = $1 AND outcome = 'denied'", [mine.user.id],
    );
    assert.ok(tried.some((t) => Number(t.author_id) === Number(theirs.author.id)));
    const { rows: [told] } = await query("SELECT metadata FROM audit_log WHERE action = 'access.alerted' AND entity_id = $1", [key]);
    assert.ok(told.metadata.alerted.includes('ops@example.test'), 'no admin was told');
  });

  it('the report shows it to the security officer — and not to an author', async () => {
    assert.equal((await call(mineToken, 'GET', '/security/access')).status, 403);
    const r = await call(auditor, 'GET', `/security/access?tenant=${theirs.author.id}&outcome=denied`);
    assert.equal(r.status, 200);
    assert.ok(r.body.events.length >= config.accessAlertThreshold);
    assert.ok(r.body.events.every((e) => Number(e.author_id) === Number(theirs.author.id) && e.outcome === 'denied'));
    assert.ok(r.body.flagged.some((f) => Number(f.user_id) === mine.user.id));
    assert.equal(r.body.totals.unattributed, 0, 'an event nobody can be named for');
  });

  it('an admin blocks the account and it stops on its very next request, with the token it already has', async () => {
    assert.equal((await call(mineToken, 'GET', `/authors/${mine.author.id}/books`)).status, 200);
    const blocked = await call(admin, 'POST', `/security/accounts/${mine.user.id}/block`, { reason: 'test: repeated attempts on another tenant' });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal((await call(mineToken, 'GET', `/authors/${mine.author.id}/books`)).status, 401);
    const { rows } = await query("SELECT actor, metadata FROM audit_log WHERE action = 'access.account_blocked' AND entity_id = $1", [String(mine.user.id)]);
    assert.equal(rows[0].actor, 'Ops');
    assert.match(rows[0].metadata.reason, /repeated attempts/);

    assert.equal((await call(admin, 'POST', `/security/accounts/${mine.user.id}/unblock`, {})).status, 200);
    mineToken = await login(`dal-mine-${stamp}@example.test`, 'mine-password-1');
    assert.equal((await call(mineToken, 'GET', `/authors/${mine.author.id}/books`)).status, 200);
  });

  it('only an admin may block, with a reason, and never themselves', async () => {
    assert.equal((await call(auditor, 'POST', `/security/accounts/${mine.user.id}/block`, { reason: 'compliance cannot do this' })).status, 403);
    assert.equal((await call(admin, 'POST', `/security/accounts/${mine.user.id}/block`, { reason: 'short' })).status, 400);
    const { rows: [ops] } = await query("SELECT id FROM users WHERE email = 'ops@example.test'");
    assert.equal((await call(admin, 'POST', `/security/accounts/${ops.id}/block`, { reason: 'blocking myself by mistake' })).status, 400);
  });
});

describe('A tenant can see who read its data', () => {
  it('through its own view — the admin\'s read of their data is there, other tenants\' events are not', async () => {
    await call(admin, 'GET', `/authors/${theirs.author.id}/books`);
    await flushAccessLog();
    const r = await call(theirsToken, 'GET', `/authors/${theirs.author.id}/access-events`);
    assert.equal(r.status, 200);
    assert.ok(r.body.some((e) => e.user_role === 'admin'), 'the admin\'s read is missing');
    assert.ok(r.body.some((e) => e.outcome === 'denied' && Number(e.actor_author_id) === Number(mine.author.id)),
      'the attempts on their data are missing');
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM data_access_events WHERE author_id = $1', [theirs.author.id]);
    assert.ok(r.body.length <= rows[0].n);
    assert.equal((await call(theirsToken, 'GET', `/authors/${mine.author.id}/access-events`)).status, 403);
  });
});
