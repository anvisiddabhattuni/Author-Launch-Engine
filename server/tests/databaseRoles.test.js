/**
 * STORY-033 acceptance tests.
 *
 *   "PostgreSQL database setup with trust controls" → reliable storage,
 *       complex queries, and secure access with roles and permissions
 *       configured.
 *
 * Measured before this story: the API connected as `anvi`, a Postgres
 * superuser that owns all 46 tables. The audit log's append-only triggers
 * held only against callers who could not switch them off — and the owner
 * can. The demo's STORY-013 stages switched them off through the
 * application's own pool.
 *
 * Every test here runs on the application's real connection (the pool) and
 * asks it to do what an attacker holding that connection would try. The
 * owner is used only to set up and to prove the second wall — the trigger —
 * still stands behind the first.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import pg from 'pg';

import { config } from '../src/config.js';
import { closePool, ownerQuery, pool, query } from '../src/db/pool.js';
import { readiness } from '../src/services/deployment.js';
import { runChecks } from '../src/services/governance.js';

/**
 * Tables the application may add to and read, never change. Declared here so
 * a new table is either writable or on this list — a later migration adding
 * an append-only table that forgets its REVOKE fails the coverage test below.
 */
const APPEND_ONLY = ['audit_checkpoints', 'data_access_events'];
/**
 * The audit log's encrypted storage (STORY-049). The application has no
 * privilege on it at all: it reads and writes through the `audit_log` view,
 * which decrypts and encrypts, and cannot reach the ciphertext directly.
 */
const ENCRYPTED_STORAGE = ['audit_log_sealed', 'security_log_sealed'];
/** The owner's record of which migrations ran. The app reads it for readiness. */
const OWNER_RECORD = ['schema_migrations'];
/**
 * Changed only by an approved access change, through `ale_apply_access_change`
 * (STORY-042): who holds which permission, and each account's role. `users`
 * stays updatable in its other columns; its role column is not.
 */
const REVIEWED_ONLY = ['role_permissions', 'users'];

after(async () => {
  await closePool();
});

describe('Scenario: the application connects with the least power it needs', () => {
  it('is not a superuser and owns nothing', async () => {
    const { rows: [who] } = await query(
      `SELECT current_user AS role, r.rolsuper,
              (SELECT COUNT(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    assert.equal(who.role, 'ale_app_login', 'the pool is not using the application login');
    assert.equal(who.rolsuper, false);
    assert.equal(who.owns, 0);
  });

  for (const [what, sql] of [
    ['create a table', 'CREATE TABLE sneaky (id int)'],
    ['drop a table', 'DROP TABLE drafts'],
    ['switch off the audit triggers', 'ALTER TABLE audit_log_sealed DISABLE TRIGGER ALL'],
    ['rewrite an audit row', "UPDATE audit_log SET action = 'rewritten' WHERE id = (SELECT MIN(id) FROM audit_log)"],
    ['delete an audit row', 'DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log)'],
    ['rewrite a seal', "UPDATE audit_checkpoints SET digest = 'x'"],
    ['empty a table', 'TRUNCATE drafts'],
    ['forge a migration record', "INSERT INTO schema_migrations (filename) VALUES ('999_fake.sql')"],
    // Whoever owns the database, by name, asked of Postgres. This was
    // 'GRANT anvi …' — the role on the laptop it was written on — and on any
    // other machine, CI included, the answer was "role does not exist", which
    // is not a refusal and failed the test (STORY-053).
    ['grant itself the owner', async () => `GRANT ${(await ownerQuery('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()')).rows[0].o} TO ale_app_login`],
    ['become another role', 'SET ROLE ale_readonly'],
  ]) {
    it(`cannot ${what}`, async () => {
      const statement = typeof sql === 'function' ? await sql() : sql;
      await assert.rejects(() => query(statement), /permission denied|must be owner|not.*member|must have admin|append-only/i);
    });
  }

  it('can still do its job: read and write ordinary rows, and append to the log', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        "INSERT INTO authors (name, email) VALUES ('Role Test', 'role-test@example.test') RETURNING id",
      );
      await client.query('UPDATE authors SET name = $1 WHERE id = $2', ['Role Test 2', rows[0].id]);
      await client.query('DELETE FROM authors WHERE id = $1', [rows[0].id]);
      await client.query(
        "INSERT INTO audit_log (actor, action, entity_type) VALUES ('test', 'role.checked', 'test')",
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('Two walls, not one', () => {
  it('the trigger still stands behind the privilege — even the owner is refused an ordinary UPDATE', async () => {
    // The privilege stops the app login; the trigger stops a mistaken write by
    // anyone who has UPDATE. Only disabling the trigger — an owner's act, and
    // one STORY-013's seals detect — gets past both.
    await assert.rejects(
      () => ownerQuery("UPDATE audit_log SET action = 'x' WHERE id = (SELECT MIN(id) FROM audit_log)"),
      /append-only/,
    );
  });

  it('a read-only role reads everything and writes nothing', async () => {
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await client.connect();
    try {
      await client.query('SET ROLE ale_readonly');
      const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM audit_log');
      assert.ok(rows[0].n >= 0);
      await assert.rejects(
        () => client.query("INSERT INTO authors (name, email) VALUES ('x', 'ro@example.test')"),
        /permission denied/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('Coverage: every table is where it should be', () => {
  it('the app can write every table except the declared append-only ones and the owner\'s record', async () => {
    const { rows } = await query(
      `SELECT tablename,
              has_table_privilege('ale_app', format('public.%I', tablename), 'SELECT') AS can_read,
              has_table_privilege('ale_app', format('public.%I', tablename), 'INSERT') AS can_insert,
              has_table_privilege('ale_app', format('public.%I', tablename), 'UPDATE') AS can_update,
              has_table_privilege('ale_readonly', format('public.%I', tablename), 'SELECT') AS ro_read
         FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const unreadable = rows.filter((r) => !r.can_read || !r.ro_read).map((r) => r.tablename);
    assert.deepEqual(unreadable, ENCRYPTED_STORAGE, 'a table the app or the read-only role cannot read');

    const noUpdate = rows.filter((r) => !r.can_update).map((r) => r.tablename).sort();
    assert.deepEqual(noUpdate, [...APPEND_ONLY, ...OWNER_RECORD, ...REVIEWED_ONLY, ...ENCRYPTED_STORAGE].sort(),
      'the tables the app cannot update are not exactly the declared ones');

    const noInsert = rows.filter((r) => !r.can_insert).map((r) => r.tablename).sort();
    assert.deepEqual(noInsert, [...OWNER_RECORD, 'role_permissions', ...ENCRYPTED_STORAGE].sort());

    // users: every column but the role.
    const { rows: [cols] } = await query(
      `SELECT has_column_privilege('ale_app', 'public.users', 'role', 'UPDATE') AS role_col,
              has_column_privilege('ale_app', 'public.users', 'active', 'UPDATE') AS active_col`,
    );
    assert.equal(cols.role_col, false, 'the app can change a role without review');
    assert.equal(cols.active_col, true);
  });

  it('a table added by a later migration is granted without anyone remembering', async () => {
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE future_feature (id serial PRIMARY KEY, note text)');
      const { rows } = await client.query(
        "SELECT has_table_privilege('ale_app', 'public.future_feature', 'INSERT') AS ok",
      );
      assert.equal(rows[0].ok, true, 'default privileges did not reach a new table');
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});

describe('It is reported, not only enforced', () => {
  it('readiness names the role and passes', async () => {
    const r = await readiness({});
    const check = r.checks.find((c) => c.id === 'privileges');
    assert.ok(check, 'readiness does not check privileges');
    assert.equal(check.ok, true);
    assert.equal(check.elevated, false);
    assert.match(check.detail, /ale_app_login: rows only/);
  });

  it('the Trust tab\'s governance check agrees', async () => {
    const check = (await runChecks({})).find((c) => c.id === 'db.least_privilege');
    assert.equal(check.passed, true);
  });

  it('and would fail if the app ran as the owner', async () => {
    const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await client.connect();
    try {
      const check = (await runChecks({}, client)).find((c) => c.id === 'db.least_privilege');
      assert.equal(check.passed, false, 'a check that cannot fail is not a check');
    } finally {
      await client.end();
    }
  });
});
