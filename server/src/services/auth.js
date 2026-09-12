import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { pool } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { permissionsForRole } from './permissions.js';

const scrypt = promisify(scryptCb);

/**
 * Coordination and Governance Agent (STORY-064).
 *
 * The identity the approval gate has been assuming since STORY-001. Everything
 * outbound already required a human decision; what was missing was any way to
 * know which human, or whether they were entitled to decide at all.
 *
 * Deliberately thin. Two roles, one session, one tenant boundary. Per-resource
 * permissions are STORY-022 in R5 and are not smuggled in here.
 */
export const ACTOR = 'CoordinationGovernanceAgent';

/**
 * scrypt work factors. Stored inside each hash rather than read from config at
 * verify time, so raising them later does not invalidate every existing row —
 * old hashes keep verifying under the factors they were written with.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** "scrypt$N$r$p$salt$hash" — self-describing, so verification needs no config. */
export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt's default maxmem is too small for N=16384 at this keylen.
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;

  const expectedBuf = Buffer.from(expected, 'base64');
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), expectedBuf.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });

  // Constant-time: a length-varying or short-circuiting compare leaks how much
  // of a guess was right, one byte at a time.
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}

/**
 * The claims a request is allowed to act on. Kept small — a token is not a profile.
 *
 * `permissions` joins `role` here rather than being looked up per request
 * (STORY-019). The middleware that reads them runs before Express has matched a
 * route and has to stay synchronous, and a grant change already could not reach
 * a live session — `role` has been a claim since STORY-064, so a role change
 * has always waited for the next token. Carrying the grants alongside it adds
 * no new staleness, and the lag is written into Known gaps.
 */
export function issueToken(user, permissions = []) {
  return jwt.sign(
    {
      sub: String(user.id),
      name: user.name,
      role: user.role,
      permissions,
      // null for an admin, which is what lets them read across tenants.
      authorId: user.author_id === null ? null : Number(user.author_id),
    },
    config.jwtSecret,
    { expiresIn: config.jwtTtl, issuer: 'author-launch-engine' },
  );
}

/**
 * Verifies a token.
 *
 * The algorithm is pinned. Left open, a token signed `alg: none` — or signed
 * with the public half of an asymmetric pair — is a forged session that
 * verifies cleanly, which is the classic way hand-rolled JWT handling fails.
 */
export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: 'author-launch-engine',
  });
}

const INVALID = () =>
  Object.assign(new Error('Email or password is incorrect'), { status: 401 });

/**
 * Signs a user in.
 *
 * An unknown email and a wrong password return the same error, so the endpoint
 * cannot be used to enumerate who has an account. A failed attempt is audited
 * with the email tried but never the password.
 */
export async function login({ email, password }) {
  if (!email?.trim() || !password) {
    throw Object.assign(new Error('Email and password are required'), { status: 400 });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [
    email.trim(),
  ]);
  const user = rows[0];

  const ok = user && user.active && (await verifyPassword(password, user.password_hash));
  if (!ok) {
    await recordAction({
      actor: ACTOR,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      authorId: user?.author_id ?? null,
      metadata: {
        email: email.trim(),
        // Distinguished on the log but not in the response: an operator reading
        // the trail should be able to tell a disabled account from a bad
        // password, while the caller learns neither.
        reason: !user ? 'no such user' : !user.active ? 'account inactive' : 'bad password',
      },
    });
    throw INVALID();
  }

  const permissions = await permissionsForRole(user.role);

  await recordAction({
    actor: user.name,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    authorId: user.author_id,
    // What the session was granted, on the record at the moment it was granted.
    // An access question asked later — "how did they read that?" — is answered
    // by the log rather than by today's grant table, which may have changed.
    metadata: { role: user.role, email: user.email, permissions },
  });

  return { token: issueToken(user, permissions), user: publicUser(user) };
}

/** Never let a password hash out of the service, even internally. */
export const publicUser = (user) => ({
  id: Number(user.id),
  email: user.email,
  name: user.name,
  role: user.role,
  authorId: user.author_id === null ? null : Number(user.author_id),
});

/** Creates or updates a login. Used by the seed; there is no public signup. */
export async function upsertUser({ email, name, password, role, authorId = null }) {
  const password_hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, author_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role, author_id = EXCLUDED.author_id, active = TRUE
     RETURNING *`,
    [email, name, password_hash, role, authorId],
  );
  return rows[0];
}
