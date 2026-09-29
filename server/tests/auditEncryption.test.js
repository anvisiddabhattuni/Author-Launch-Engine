/**
 * STORY-049 acceptance tests.
 *
 *   "Encrypt audit logs" → given an audit log entry is created, when the entry
 *       is stored in the database, then the entry is encrypted using AES-256.
 *   Build: a key management system for the key.
 *
 * STORY-019 declined this, and its reasons were real: the tamper seals hash row
 * contents, forty files read the log in SQL, and the key would have sat beside
 * DATABASE_URL. These tests hold the story to its clause *and* to those three.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { after, describe, it } from 'node:test';

import pg from 'pg';

import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { auditKeyId, keyedOptions } from '../src/services/auditKey.js';
import { recordAction } from '../src/services/auditLog.js';
import { runChecks } from '../src/services/governance.js';

const SECRET = `unmistakable-marker-${Date.now()}`;

/** An owner connection, with the key, with another key, or with none. */
async function ownerClient(options) {
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, ...(options ? { options } : {}) });
  await client.connect();
  return client;
}

after(async () => {
  await closePool();
});

describe('Scenario: an audit entry is created and stored', () => {
  let entry;

  it('is stored as AES-256 ciphertext — the clear text is nowhere in the stored row', async () => {
    entry = await recordAction({ actor: 'Test', action: 'test.encrypted', entityType: 'test', metadata: { note: SECRET } });
    const { rows: [stored] } = await ownerQuery(
      'SELECT payload, key_id, encode(payload, \'escape\') AS bytes FROM audit_log_sealed WHERE id = $1', [entry.id],
    );
    assert.ok(!stored.bytes.includes(SECRET), 'the entry is readable in storage');
    // OpenPGP symmetric-key session packet: tag 3, version 4, then the cipher.
    // 9 is AES-256 (RFC 4880 §9.2).
    assert.equal(stored.payload[0], 0xc3);
    assert.equal(stored.payload[2], 4);
    assert.equal(stored.payload[3], 9, 'not AES-256');
    assert.equal(stored.key_id, auditKeyId);
  });

  it('the columns that route and filter the log stay clear; the entry itself does not', async () => {
    const { rows: [cols] } = await ownerQuery(
      "SELECT array_agg(column_name::text ORDER BY column_name) AS names FROM information_schema.columns WHERE table_name = 'audit_log_sealed'",
    );
    assert.deepEqual(cols.names, ['action', 'actor', 'created_at', 'entity_id', 'entity_type', 'id', 'key_id', 'payload', 'tenant_id']);
  });

  it('the application reads it back exactly as written — every existing reader unchanged', async () => {
    const { rows: [row] } = await query('SELECT * FROM audit_log WHERE id = $1', [entry.id]);
    assert.equal(row.metadata.note, SECRET);
    const { rows: byContent } = await query("SELECT id FROM audit_log WHERE metadata->>'note' = $1", [SECRET]);
    assert.equal(byContent.length, 1, 'SQL that filters inside an entry stopped working');
  });
});

describe('The key is kept apart from the database', () => {
  it('a connection without the key reads empty entries, and cannot write one at all', async () => {
    const client = await ownerClient(null);
    try {
      const { rows: [row] } = await client.query("SELECT action, metadata FROM audit_log WHERE action = 'test.encrypted' ORDER BY id DESC LIMIT 1");
      assert.equal(row.action, 'test.encrypted', 'routing columns stay readable');
      assert.equal(row.metadata, null, 'the entry opened without the key');
      await assert.rejects(
        () => client.query("INSERT INTO audit_log (actor, action, entity_type) VALUES ('x', 'y', 'z')"),
        /never stored unencrypted/,
      );
    } finally {
      await client.end();
    }
  });

  it('the wrong key opens nothing', async () => {
    const client = await ownerClient('-c ale.audit_key=not-the-key -c ale.audit_key_id=wrong');
    try {
      const { rows: [row] } = await client.query("SELECT metadata FROM audit_log WHERE action = 'test.encrypted' ORDER BY id DESC LIMIT 1");
      assert.deepEqual(row.metadata, { undecryptable: true });
    } finally {
      await client.end();
    }
  });

  it('the application login cannot reach the ciphertext directly — only the view that encrypts', async () => {
    await assert.rejects(() => query('SELECT * FROM audit_log_sealed LIMIT 1'), /permission denied/);
    await assert.rejects(() => query("INSERT INTO audit_log_sealed (actor, action, entity_type, payload, key_id) VALUES ('x','y','z','\\x00','k')"), /permission denied/);
  });

  it('the key file is its owner\'s alone, and the key is not in the env file beside DATABASE_URL', () => {
    if (!process.env.AUDIT_KEY) {
      assert.equal(statSync(config.auditKeyFile).mode & 0o777, 0o600);
    }
    assert.match(keyedOptions, /ale\.audit_key=/);
    assert.ok(!(process.env.DATABASE_URL ?? '').includes('audit_key'));
  });
});

describe('What STORY-019 was worried about', () => {
  it('the tamper seals still catch an edit — made to the ciphertext itself', async () => {
    const e = await recordAction({ actor: 'Test', action: 'test.sealed', entityType: 'test', metadata: { n: 1 } });
    const client = await ownerClient(keyedOptions);
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_log_sealed DISABLE TRIGGER ALL');
      // Flip one byte in the middle of the ciphertext.
      await client.query("UPDATE audit_log_sealed SET payload = set_byte(payload, 30, (get_byte(payload, 30) + 1) % 256) WHERE id = $1", [e.id]);
      const { rows: [row] } = await client.query('SELECT metadata FROM audit_log WHERE id = $1', [e.id]);
      assert.deepEqual(row.metadata, { undecryptable: true }, 'an edited ciphertext opened');
      const check = (await runChecks({}, client)).find((c) => c.id === 'audit.encrypted');
      assert.equal(check.passed, false, 'the governance invariant missed it');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('the log is still append-only, in the same words, through the view', async () => {
    await assert.rejects(() => ownerQuery("UPDATE audit_log SET action = 'x' WHERE id = (SELECT MIN(id) FROM audit_log)"), /append-only/);
    await assert.rejects(() => ownerQuery('DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log)'), /append-only/);
  });

  it('the governance invariant counts an entry under another key', async () => {
    const client = await ownerClient('-c ale.audit_key=a-different-key -c ale.audit_key_id=other');
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO audit_log (actor, action, entity_type) VALUES ('x', 'test.other_key', 'test')");
      const { rows: [status] } = await client.query('SELECT * FROM audit_encryption_status()');
      assert.ok(Number(status.other_keys) >= 1);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
    const check = (await runChecks({})).find((c) => c.id === 'audit.encrypted');
    assert.equal(check.passed, true);
  });
});
