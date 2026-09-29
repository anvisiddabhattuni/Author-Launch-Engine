import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { PERMISSIONS, holds } from './permissions.js';

/**
 * Per-tenant API keys (STORY-045 / REQ-011) — API Integration Agent.
 *
 * A key is `ale_<prefix>_<secret>`. The prefix finds the row and is safe to
 * show; the whole key is stored only as its SHA-256. Keys are 32 random bytes,
 * so a fast hash is enough — there is nothing to guess at — and a copy of the
 * table is not a set of working keys.
 *
 * The build note says to keep keys in environment variables or a secrets
 * manager. That is right for the application's own secrets (it is where
 * ANTHROPIC_API_KEY lives) and cannot work for these: they are created by
 * tenants while the system runs, one set per tenant. Storing only a hash
 * means there is no secret to keep at all.
 *
 * A key acts for the person who created it, inside one tenant, with no
 * permissions of its own: it reads what an author reads (and, if created
 * `read_write`, submits what an author submits) and can never approve —
 * `content.approve` stays with people, which is what the approval gate is.
 */
export const ACTOR = 'APIIntegrationAgent';
export const ACCESS = ['read', 'read_write'];
export const MAX_LIVE_KEYS = 10;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const FORMAT = /^ale_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

/** Who may manage this tenant's keys: the tenant itself, or an admin who manages tenants. Never a key. */
function assertManages(user, authorId) {
  if (!user) throw fail(401, 'Sign in required');
  if (user.apiKeyId) throw fail(403, 'An API key cannot create, list or revoke API keys; a person has to');
  if (Number(user.authorId) === Number(authorId)) return;
  if (holds(user, PERMISSIONS.TENANT_MANAGE)) return;
  throw fail(403, 'Only this tenant, or an admin who manages tenants, can manage its API keys');
}

const publicKey = (row) => ({
  id: Number(row.id),
  authorId: Number(row.author_id),
  prefix: row.prefix,
  name: row.name,
  access: row.access,
  createdBy: row.created_by_name ?? null,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  status: row.revoked_at ? 'revoked' : new Date(row.expires_at) <= new Date() ? 'expired' : 'live',
});

/** Creates a key. The full key is in the return value and nowhere else, ever. */
export async function createApiKey({ authorId, name, access = 'read', expiresInDays = DEFAULT_DAYS, user }) {
  assertManages(user, authorId);
  if (!ACCESS.includes(access)) throw fail(400, `access must be one of ${ACCESS.join(', ')}`);
  const days = Number(expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw fail(400, `A key expires in 1 to ${MAX_DAYS} days`);

  const { rows: [tenant] } = await pool.query('SELECT id, tenant_status FROM authors WHERE id = $1', [authorId]);
  if (!tenant) throw fail(404, 'No such tenant');
  if (tenant.tenant_status !== 'active') throw fail(409, 'A suspended tenant cannot be given new API keys');
  const { rows: [{ n }] } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM tenant_api_keys WHERE author_id = $1 AND revoked_at IS NULL AND expires_at > now()',
    [authorId],
  );
  if (n >= MAX_LIVE_KEYS) throw fail(409, `This tenant already has ${MAX_LIVE_KEYS} live keys; revoke one first`);

  const prefix = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
  const secret = randomBytes(32).toString('base64url');
  const key = `ale_${prefix}_${secret}`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO tenant_api_keys (author_id, prefix, secret_hash, name, access, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING *`,
    [authorId, prefix, sha256(key), name.trim(), access, user.id, days],
  );
  await recordAction({
    actor: user.name,
    action: 'api_key.created',
    entityType: 'api_key',
    entityId: String(row.id),
    authorId: Number(authorId),
    metadata: { tenant: Number(authorId), prefix, name: row.name, access, expiresAt: new Date(row.expires_at).toISOString(), createdBy: user.id },
  });
  return { ...publicKey({ ...row, created_by_name: user.name }), key };
}

export async function listApiKeys({ authorId, user }) {
  assertManages(user, authorId);
  const { rows } = await pool.query(
    `SELECT k.*, u.name AS created_by_name FROM tenant_api_keys k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.author_id = $1 ORDER BY k.revoked_at IS NOT NULL, k.id DESC`,
    [authorId],
  );
  return rows.map(publicKey);
}

export async function revokeApiKey({ authorId, keyId, user }) {
  assertManages(user, authorId);
  const { rows: [row] } = await pool.query(
    `UPDATE tenant_api_keys SET revoked_at = now(), revoked_by = $3
      WHERE id = $1 AND author_id = $2 AND revoked_at IS NULL RETURNING *`,
    [keyId, authorId, user.id],
  );
  if (!row) throw fail(404, 'No live key with that id in this tenant');
  await recordAction({
    actor: user.name,
    action: 'api_key.revoked',
    entityType: 'api_key',
    entityId: String(row.id),
    authorId: Number(authorId),
    metadata: { tenant: Number(authorId), prefix: row.prefix, name: row.name, revokedBy: user.id },
  });
  return publicKey(row);
}

/**
 * Turns a presented key into a session, or refuses it. Checked on every
 * request with no cache, so a revocation bites on the next one.
 *
 * Every refusal says the same thing to the caller; the reason goes to the
 * access log (STORY-044) for the security officer.
 */
export async function sessionForKey(presented) {
  const refuse = (reason) => Object.assign(new Error('API key not accepted'), { status: 401, accessReason: reason });
  const match = FORMAT.exec(presented ?? '');
  if (!match) throw refuse('malformed API key');
  const { rows: [row] } = await pool.query(
    `SELECT k.*, u.name AS creator_name, u.email AS creator_email, u.active AS creator_active, a.tenant_status
       FROM tenant_api_keys k JOIN users u ON u.id = k.created_by JOIN authors a ON a.id = k.author_id
      WHERE k.prefix = $1`,
    [match[1]],
  );
  const given = Buffer.from(sha256(presented), 'hex');
  if (!row || !timingSafeEqual(given, Buffer.from(row.secret_hash, 'hex'))) throw refuse('unknown API key');
  if (row.revoked_at) throw refuse(`API key ${row.prefix} was revoked`);
  if (new Date(row.expires_at) <= new Date()) throw refuse(`API key ${row.prefix} has expired`);
  if (!row.creator_active) throw refuse(`API key ${row.prefix}: the account it acts for is blocked or inactive`);
  if (row.tenant_status !== 'active') throw refuse(`API key ${row.prefix}: tenant is suspended`);

  // At most once a minute: usage is in the access log in full; this column is
  // only "has it been used lately".
  pool.query(
    `UPDATE tenant_api_keys SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [row.id],
  ).catch(() => {});

  return {
    id: Number(row.created_by),
    name: `${row.creator_name} (API key ${row.prefix})`,
    email: row.creator_email,
    role: 'api_key',
    // None of their own. Reading one's own tenant needs none; approving does,
    // and a key never has it.
    permissions: [],
    authorId: Number(row.author_id),
    apiKeyId: Number(row.id),
    apiKeyAccess: row.access,
  };
}
