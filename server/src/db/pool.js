import pg from 'pg';

import { config } from '../config.js';
import { keyedOptions } from '../services/auditKey.js';

import { AsyncLocalStorage } from 'node:async_hooks';

// Every connection is handed the audit log key as it opens (STORY-049), as a
// startup setting: no statement ever runs on a connection that cannot read or
// write the log.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, options: keyedOptions });

/**
 * The connection a request is scoped to, when it is (STORY-041).
 *
 * An author's reads run on one connection that has become their tenant role,
 * with their schema first on the search path. Every query issued while that
 * request is being handled — through `query`, through `pool.query` directly,
 * through `withTransaction` — goes to that connection, so a service written
 * years before this story is isolated without being edited. That is the point:
 * isolation that depends on each query remembering its WHERE clause is the
 * isolation STORY-017 found leaking.
 */
const scope = new AsyncLocalStorage();
const rawQuery = pool.query.bind(pool);
pool.query = (...args) => {
  const scoped = scope.getStore();
  return scoped ? scoped.client.query(...args) : rawQuery(...args);
};

/**
 * Makes sure the tenant's schema exists before scoping to it.
 *
 * The schema, not the role: roles belong to the server and survive a
 * database being dropped and recreated (`npm run db:reset`), schemas do not.
 * The first version checked the role, found it, switched to it, and ran every
 * query with a search path pointing at a schema that no longer existed — so
 * each one fell through to the shared table and was refused. Loudly, which is
 * the right failure, but a failure.
 */
async function ensureSchema(client, tenant, provision) {
  const { rows } = await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [`tenant_${tenant}`]);
  if (rows[0].present) return;
  if (!provision) throw new Error(`Tenant ${tenant} has no schema, and nothing was given to provision one`);
  await provision(tenant);
}

/** The tenant the current code is running as, or null for system access. */
export const currentTenant = () => scope.getStore()?.tenant ?? null;

/**
 * Runs outside any tenant scope. For system writes that happen while a
 * request's tenant transaction may still be open — the access log (STORY-044)
 * writes as a request finishes, and a tenant's read-only role cannot, and must
 * not be able to, write its own access record.
 */
export const outsideTenantScope = (fn) => scope.exit(fn);

/**
 * Runs `fn` as tenant `authorId`: their role, their schema, read-only.
 *
 * Read-only because it wraps reads; a handler that turns out to write fails
 * loudly here rather than writing as a tenant — which is how the routes that
 * need system access were found, and each is declared with its reason in
 * `middleware/tenantScope.js`.
 */
export async function asTenant(authorId, fn, { provision } = {}) {
  const tenant = Number(authorId);
  if (!Number.isSafeInteger(tenant) || tenant <= 0) throw new Error(`Not a tenant: ${authorId}`);
  const client = await pool.connect();
  try {
    await ensureSchema(client, tenant, provision);
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL ROLE ale_tenant_${tenant}`);
    await client.query(`SET LOCAL search_path TO tenant_${tenant}, public`);
    const result = await scope.run({ client, tenant }, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Starts a tenant scope for the rest of an Express request. Unlike `asTenant`
 * it cannot await the handler — Express does not return one — so the
 * transaction is finished when the response is.
 */
export async function enterTenantScope(authorId, next, res, { provision } = {}) {
  const tenant = Number(authorId);
  const client = await pool.connect();
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await client.query('COMMIT').catch(() => {});
    client.release();
  };
  try {
    await ensureSchema(client, tenant, provision);
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL ROLE ale_tenant_${tenant}`);
    await client.query(`SET LOCAL search_path TO tenant_${tenant}, public`);
  } catch (error) {
    finished = true;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw error;
  }
  res.on('finish', finish);
  res.on('close', finish);
  scope.run({ client, tenant }, next);
}

/**
 * An idle pooled connection dropped by the server.
 *
 * Without this listener the process dies. `pg.Pool` emits `error` on idle
 * clients, and an `error` event with no listener is a thrown exception in Node —
 * so anything that severs a connection from the far end takes the whole API
 * down rather than costing it one connection.
 *
 * That is not a hypothetical. `npm run db:reset` calls `pg_terminate_backend`
 * on every other session before dropping the database, and it killed the
 * running dev server: Postgres 57P01, "terminating connection due to
 * administrator command", unhandled, process gone. A failover, a restart, a DBA
 * running the same statement, or an idle timeout enforced server-side all
 * produce exactly this.
 *
 * Logged rather than swallowed, because a connection dying is worth knowing
 * about even though it is survivable. The pool discards the client and opens a
 * fresh one on the next query, so callers see nothing.
 */
pool.on('error', (error) => {
  console.error(
    `[db] idle connection lost (${error.code ?? 'no code'}): ${error.message}. ` +
      'The pool will open a new one on the next query.',
  );
});

export const query = (text, params) => pool.query(text, params);

/**
 * Runs `fn` inside a transaction so a partial failure cannot leave a draft
 * approved but unscheduled (or scheduled but unaudited).
 */
export async function withTransaction(fn) {
  // Inside a tenant scope the transaction is already open, on the scoped
  // connection: a nested one becomes a savepoint there, rather than a fresh
  // connection with system access that would quietly step outside the scope.
  const scoped = scope.getStore();
  if (scoped) {
    await scoped.client.query('SAVEPOINT scoped_tx');
    try {
      const result = await fn(scoped.client);
      await scoped.client.query('RELEASE SAVEPOINT scoped_tx');
      return result;
    } catch (error) {
      await scoped.client.query('ROLLBACK TO SAVEPOINT scoped_tx');
      throw error;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Work that must finish before the pool closes — the access log (STORY-044)
 * writes after each response, so the last request's record is still in flight
 * when a test or a shutting-down server closes the pool.
 */
export const beforeClose = new Set();
export const closePool = async () => {
  for (const hook of beforeClose) await hook();
  return pool.end();
};

/**
 * Runs one statement as the schema owner, on a connection opened for it.
 *
 * For the two places that legitimately need the owner's power and are not
 * migrations: the demo, which disables the audit triggers to show that
 * tampering is detected (STORY-013), and the tests that prove the
 * application login *cannot* do what the owner can (STORY-033). The
 * application itself never calls this — which is the point of it being
 * separate rather than the pool having a switch.
 */
export async function ownerQuery(text, params) {
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, options: keyedOptions });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}
