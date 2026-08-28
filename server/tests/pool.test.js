/**
 * The connection pool must survive losing a connection.
 *
 * `pg.Pool` emits `error` on idle clients, and in Node an `error` event with no
 * listener is a thrown exception — so without a handler, anything that severs a
 * connection from the far end kills the whole API process rather than costing
 * it one connection.
 *
 * This is a regression test for a real crash: `npm run db:reset` runs
 * `pg_terminate_backend` on every other session before dropping the database,
 * which killed the running dev server with Postgres 57P01. A failover, a
 * restart, or an idle timeout enforced server-side do the same thing.
 *
 * Asserted by inspecting the listener rather than by actually terminating
 * backends: this suite shares a database with every other one, and killing
 * connections to prove a point would take them down with it.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, pool, query } from '../src/db/pool.js';

after(async () => {
  await closePool();
});

describe('The connection pool survives a dropped connection', () => {
  it('listens for errors on idle clients', () => {
    assert.ok(
      pool.listenerCount('error') > 0,
      'an unhandled error event on an idle client crashes the process',
    );
  });

  it('still answers a query', async () => {
    const { rows } = await query('SELECT 1 AS ok');
    assert.equal(rows[0].ok, 1);
  });
});
