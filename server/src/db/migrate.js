import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, 'migrations');

const databaseName = () => {
  const name = new URL(config.databaseUrl).pathname.replace(/^\//, '');
  if (!name) throw new Error(`DATABASE_URL has no database name: ${config.databaseUrl}`);
  return name;
};

/** Connects to the maintenance database so we can create/drop the target one. */
const adminClient = () => {
  const url = new URL(config.databaseUrl);
  url.pathname = '/postgres';
  return new pg.Client({ connectionString: url.toString() });
};

async function ensureDatabase({ reset }) {
  const name = databaseName();
  const client = adminClient();
  await client.connect();
  try {
    if (reset) {
      // Terminate other sessions first, otherwise DROP DATABASE blocks.
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`);
      console.log(`dropped database ${name}`);
    }

    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
      console.log(`created database ${name}`);
    }
  } finally {
    await client.end();
  }
}

async function applyMigrations() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip     ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`applied  ${file}`);
    }
  } finally {
    await client.end();
  }
}

const reset = process.argv.includes('--reset');

await ensureDatabase({ reset });
await applyMigrations();
console.log('migrations complete');
