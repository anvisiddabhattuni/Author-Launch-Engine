/**
 * STORY-041 acceptance tests.
 *
 *   "Tenant data isolation" → given a new author is onboarded, when the system
 *       creates a database schema for them, their data is isolated in it.
 *
 * Measured before this story: the database enforced no separation between
 * tenants. One login could read every author's rows; isolation lived entirely
 * in each query's WHERE clause, which is what STORY-017 found missing.
 *
 * Now each tenant has a schema `tenant_<id>` of views over their rows and a role
 * that can read only that schema, and an author's GET requests run as it. The
 * test that carries the story is the one with a deliberately broken route — a
 * query with no WHERE clause at all — that still returns only the caller's rows.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import pg from 'pg';

import { config } from '../src/config.js';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { asTenant, closePool, ownerQuery, query, withTransaction } from '../src/db/pool.js';
import { SYSTEM_READS, applyTenantScope } from '../src/middleware/tenantScope.js';
import { TENANT_SCOPED_ROUTES, router } from '../src/routes/index.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { provisionTenant } from '../src/services/tenantSchemas.js';

const stamp = Date.now();
let mine;
let theirs;

/** Runs one statement as the tenant, in a savepoint so a refusal does not end the scope. */
const tryAs = (tenant, sql) =>
  asTenant(tenant, () => withTransaction((c) => c.query(sql)), { provision: provisionTenant })
    .then((r) => ({ ok: true, rows: r.rows }), (e) => ({ ok: false, error: e.message }));

before(async () => {
  mine = await onboardTenant({ name: 'Schema Mine', email: `schema-mine-${stamp}@example.test`, password: 'long-enough-1' });
  theirs = await onboardTenant({ name: 'Schema Theirs', email: `schema-theirs-${stamp}@example.test`, password: 'long-enough-2' });
  for (const t of [mine, theirs]) {
    const { rows: [b] } = await query(
      "INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','Craft is slow.','{craft}') RETURNING id",
      [t.author.id],
    );
    await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
       VALUES ($1,$2,'twitter','private to this tenant','pending_approval',0.9,CURRENT_DATE)`,
      [t.author.id, b.id],
    );
  }
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[mine.author.id, theirs.author.id]]);
  await closePool();
});

describe('Scenario: onboarding creates the tenant\'s schema', () => {
  it('exists as soon as onboarding returns, with a view for the tenant\'s data', async () => {
    assert.equal(mine.schema.name, `tenant_${mine.author.id}`);
    const { rows } = await query(
      "SELECT table_name FROM information_schema.views WHERE table_schema = $1",
      [mine.schema.name],
    );
    const views = new Set(rows.map((r) => r.table_name));
    for (const t of ['authors', 'books', 'drafts', 'draft_themes', 'audit_log', 'escalation_targets']) {
      assert.ok(views.has(t), `no ${t} in the tenant schema`);
    }
  });

  it('is on the audit log with the tenant and the time', async () => {
    const entry = (await listAuditLog({ authorId: mine.author.id, limit: 20 }))
      .find((e) => e.action === 'tenant.schema_created');
    assert.ok(entry, 'no tenant.schema_created row');
    assert.equal(Number(entry.metadata.tenant), Number(mine.author.id));
    assert.ok(entry.metadata.provisionedAt);
    assert.equal(entry.metadata.reason, 'onboarded');
  });
});

describe('Scenario: the tenant\'s data is isolated in it', () => {
  it('every view in the schema holds only the tenant\'s rows (and system-wide ones)', async () => {
    const { rows: views } = await query(
      `SELECT v.table_name FROM information_schema.views v
         JOIN information_schema.columns c ON c.table_schema = v.table_schema AND c.table_name = v.table_name AND c.column_name = 'author_id'
        WHERE v.table_schema = $1`,
      [mine.schema.name],
    );
    for (const { table_name: t } of views) {
      const r = await tryAs(mine.author.id, `SELECT DISTINCT author_id FROM ${t}`);
      assert.ok(r.ok, `${t}: ${r.error}`);
      const foreign = r.rows.filter((x) => x.author_id !== null && Number(x.author_id) !== Number(mine.author.id));
      assert.deepEqual(foreign, [], `${t} shows another tenant's rows`);
    }
  });

  it('sees no staff account and no access request — rows with no author are private by default', async () => {
    // The hole STORY-042's first test found: users with no author are admins
    // and compliance officers, and the first version showed them to every
    // tenant — email and password hash readable, if a query asked.
    const r = await tryAs(mine.author.id, 'SELECT email, author_id FROM users');
    assert.ok(r.ok, r.error);
    assert.ok(r.rows.every((u) => Number(u.author_id) === Number(mine.author.id)), `staff accounts visible: ${r.rows.map((u) => u.email).join(', ')}`);
    const a = await tryAs(mine.author.id, 'SELECT 1 FROM access_changes');
    assert.equal(a.ok, false, 'access requests visible to a tenant');
  });

  it('the tenant cannot reach the shared tables, or another tenant\'s schema', async () => {
    for (const sql of [
      'SELECT * FROM public.drafts',
      `SELECT * FROM tenant_${theirs.author.id}.drafts`,
      'SELECT * FROM audit_checkpoints',
    ]) {
      const r = await tryAs(mine.author.id, sql);
      assert.equal(r.ok, false, `${sql} was allowed`);
      assert.match(r.error, /permission denied/);
    }
  });

  it('a route whose query forgets its WHERE clause still returns only the caller\'s rows', async () => {
    // The failure STORY-017 found, reproduced on purpose: no author filter at all.
    const app = express();
    const r = express.Router();
    r.use((req, _res, next) => { req.user = { authorId: Number(mine.author.id), permissions: [] }; next(); });
    r.get('/careless', async (_req, res, next) => {
      try {
        const { rows } = await query('SELECT author_id, content FROM drafts'); // no WHERE
        res.json(rows);
      } catch (error) { next(error); }
    });
    applyTenantScope(r);
    app.use(r);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/careless`)).json();
      assert.ok(body.length > 0, 'the tenant\'s own draft is missing');
      assert.ok(body.every((d) => Number(d.author_id) === Number(mine.author.id)), 'another tenant\'s draft was served');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is read-only: a scoped request cannot write, even to its own rows', async () => {
    const r = await tryAs(mine.author.id, `UPDATE drafts SET content = 'x' WHERE author_id = ${mine.author.id}`);
    assert.equal(r.ok, false);
  });
});

describe('Coverage', () => {
  it('every GET route is tenant-scoped, or declared a system read with a reason', () => {
    const gets = router.stack.filter((l) => l.route?.methods?.get).map((l) => l.route.path);
    const unaccounted = gets.filter((p) => !TENANT_SCOPED_ROUTES.includes(p) && !(p in SYSTEM_READS));
    assert.deepEqual(unaccounted, []);
    for (const [path, why] of Object.entries(SYSTEM_READS)) {
      assert.ok(gets.includes(path), `${path} is declared but is not a route`);
      assert.ok(why.length > 20, `${path} has no real reason`);
    }
  });

  it('every table is the tenant\'s, owned through a parent, or declared shared — nothing by default', async () => {
    const { rows: tables } = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const { rows: views } = await query(
      'SELECT table_name FROM information_schema.views WHERE table_schema = $1', [mine.schema.name],
    );
    const { rows: shared } = await query('SELECT table_name FROM tenant_shared_tables');
    const covered = new Set([...views, ...shared].map((r) => r.table_name));
    assert.deepEqual(tables.map((r) => r.table_name).filter((t) => !covered.has(t)), []);
  });

  it('a table added by a later migration is covered when the schema is rebuilt', async () => {
    // All in one owner transaction, rolled back. The probe table used to be
    // created and dropped for real, and every suite onboarding a tenant at the
    // same moment saw it: first a foreign key to `authors` deadlocked them,
    // then provisioning listed the table and found it gone. Uncommitted, the
    // table exists for this transaction only.
    const tenant = Number(mine.author.id);
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE story041_probe (id serial PRIMARY KEY, author_id BIGINT)');
      await client.query('INSERT INTO story041_probe (author_id) VALUES ($1), ($2)', [tenant, theirs.author.id]);
      await client.query('SELECT * FROM ale_provision_tenant($1)', [tenant]);
      await client.query(`SET LOCAL ROLE ale_tenant_${tenant}`);
      await client.query(`SET LOCAL search_path TO tenant_${tenant}, public`);
      const { rows } = await client.query('SELECT author_id FROM story041_probe');
      assert.deepEqual(rows.map((x) => Number(x.author_id)), [tenant]);
      await assert.rejects(() => client.query('SELECT author_id FROM public.story041_probe'), /permission denied/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});

describe('What this does not protect against — pinned, so a stronger design flips it', () => {
  it('a statement that can run arbitrary SQL can switch back to the application login', async () => {
    // Postgres always lets a session return to the login it connected as, so
    // SET ROLE scoping stops a forgotten WHERE clause — the leak this project
    // actually had — and does not stop injected SQL. That threat is met by
    // parameterised queries and by STORY-033's login, which cannot touch the
    // schema or the audit log. A login per tenant would close it, at the cost
    // of a connection pool per author. If that is ever built, this test fails
    // and should be inverted.
    const r = await tryAs(mine.author.id, 'RESET ROLE');
    assert.equal(r.ok, true);
  });
});
