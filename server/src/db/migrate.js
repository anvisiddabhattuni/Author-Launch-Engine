import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { keyedOptions } from '../services/auditKey.js';

import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, 'migrations');

const databaseName = () => {
  const name = new URL(config.migrationDatabaseUrl).pathname.replace(/^\//, '');
  if (!name) throw new Error(`MIGRATION_DATABASE_URL has no database name: ${config.migrationDatabaseUrl}`);
  return name;
};

/** Connects to the maintenance database so we can create/drop the target one. */
const adminClient = () => {
  const url = new URL(config.migrationDatabaseUrl);
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
  // A migration that writes an audit entry, or moves existing ones into
  // encrypted storage (044), needs the key like any other connection (STORY-049).
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, options: keyedOptions });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Hidden files excluded: macOS tar packs '._name.sql' metadata beside each
    // file, which sorts first and is not SQL (found deploying STORY-061).
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && !f.startsWith('.')).sort();
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

    // Tenant schemas follow the tables (STORY-041). Every tenant that already
    // has one is rebuilt, so a table a migration just added is covered — or,
    // if it has no tenant and nobody classified it, is refused to tenants.
    const { rows: tenants } = await client.query(
      `SELECT substring(nspname FROM 8)::bigint AS id FROM pg_namespace n
        WHERE nspname ~ '^tenant_[0-9]+$'
          AND EXISTS (SELECT 1 FROM authors a WHERE a.id = substring(n.nspname FROM 8)::bigint)`,
    ).catch(() => ({ rows: [] }));
    for (const t of tenants) await client.query('SELECT ale_provision_tenant($1)', [t.id]);
    if (tenants.length) console.log(`rebuilt  ${tenants.length} tenant schema(s)`);

    // The application login has no password in the repository (STORY-033).
    // Where the server wants one, it is supplied here from the environment,
    // out of band, and never written to a migration.
    if (process.env.APP_DB_PASSWORD) {
      await client.query(
        `ALTER ROLE ale_app_login PASSWORD ${client.escapeLiteral(process.env.APP_DB_PASSWORD)}`,
      );
      console.log('set      ale_app_login password from APP_DB_PASSWORD');
    }
  } finally {
    await client.end();
  }
}

const reset = process.argv.includes('--reset');

await ensureDatabase({ reset });
await applyMigrations();
console.log('migrations complete');
