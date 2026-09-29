import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';

/**
 * The audit log's encryption key (STORY-049 / REQ-013).
 *
 * 32 random bytes. The database never stores it: each connection the
 * application opens is handed it (`ale.audit_key`, a session setting, set by
 * parameter so it never appears in query text), and the database encrypts
 * every audit entry with AES-256 as it is written and decrypts it as it is
 * read. A dump, a backup, a replica or any login the application did not open
 * sees ciphertext.
 *
 * Where it lives: `AUDIT_KEY` (base64), or the file at `AUDIT_KEY_FILE` —
 * deliberately not the env file that holds DATABASE_URL, which is the
 * objection STORY-019 raised: a key beside the thing it protects protects
 * nothing. In production that file is a mounted secret; in development it is
 * created on first use, readable by its owner only.
 */
function load() {
  if (process.env.AUDIT_KEY) return Buffer.from(process.env.AUDIT_KEY, 'base64');
  const file = config.auditKeyFile;
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (config.nodeEnv === 'production') {
    throw new Error(`No audit log key: set AUDIT_KEY or mount one at ${file}. Entries are never stored unencrypted.`);
  }
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`[audit] created a development audit log key at ${file}`);
  return key;
}

const key = load();
if (key.length !== 32) throw new Error(`The audit log key must be 32 bytes (AES-256); got ${key.length}`);

/** What the database is given as the passphrase. */
export const auditPassphrase = key.toString('base64');
/** Names the key without revealing it — stored on each row, so a rotation can tell old from new. */
export const auditKeyId = createHash('sha256').update(key).digest('hex').slice(0, 12);

/**
 * Connection settings that hand every session the key at startup — before any
 * statement, and never in query text or pg_stat_activity. Pass as `options`
 * to a pg Pool or Client.
 */
export const keyedOptions = `-c ale.audit_key=${auditPassphrase} -c ale.audit_key_id=${auditKeyId}`;
