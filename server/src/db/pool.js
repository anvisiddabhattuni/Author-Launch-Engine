import pg from 'pg';

import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

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
