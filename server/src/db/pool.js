import pg from 'pg';

import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

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

export const closePool = () => pool.end();
