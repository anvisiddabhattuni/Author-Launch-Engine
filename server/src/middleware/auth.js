import { pool } from '../db/pool.js';
import { verifyToken } from '../services/auth.js';

/**
 * Session and tenant enforcement (STORY-064).
 *
 * Two separate jobs, deliberately not merged: `authenticate` answers "is there a
 * real person behind this request", `enforceTenant` answers "may that person
 * touch this data". Collapsing them is how an authenticated user ends up
 * reading someone else's tenant — being signed in is not the same as being
 * entitled.
 */

const unauthorized = (message) => Object.assign(new Error(message), { status: 401 });
const forbidden = (message) => Object.assign(new Error(message), { status: 403 });

/** Paths that must work before anyone has a session. */
// `/ready` is public for the same reason `/health` is: the thing asking is a
// load balancer, and it has no credentials and never will. It exposes which
// migrations are missing, which is operational detail rather than tenant data
// (STORY-015).
const PUBLIC_PATHS = new Set(['/health', '/ready', '/auth/login']);

export function authenticate(req, _res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return next(unauthorized('Sign in required: send Authorization: Bearer <token>'));
  }

  try {
    const claims = verifyToken(token);
    req.user = {
      id: Number(claims.sub),
      name: claims.name,
      role: claims.role,
      authorId: claims.authorId === null ? null : Number(claims.authorId),
    };
    return next();
  } catch (error) {
    // The reason is deliberately not echoed back. "Signature invalid" versus
    // "expired" tells a probing caller which half of a forged token to fix.
    return next(unauthorized(`Session is not valid: ${error.name === 'TokenExpiredError' ? 'expired' : 'rejected'}`));
  }
}

/**
 * Pins every request to the caller's tenant.
 *
 * Before this, every list route read its tenant from a query parameter the
 * caller supplied — changing a number in the URL read another author's work.
 * An `author` may only ever address their own tenant, and a request that omits
 * the tenant gets theirs filled in rather than being served everything.
 *
 * An `admin` is left alone: reading across tenants is the distinction the role
 * exists for. They still cannot approve anonymously — that is `authenticate`'s
 * job and it has already run.
 */
export function enforceTenant(req, _res, next) {
  if (PUBLIC_PATHS.has(req.path) || !req.user) return next();
  if (req.user.role === 'admin') return next();

  const own = req.user.authorId;
  const requested = req.query.authorId;

  if (requested !== undefined && Number(requested) !== own) {
    return next(deniedTenant(own, requested));
  }

  // Fill the tenant in rather than leaving a list route unfiltered.
  if (requested === undefined) req.query.authorId = String(own);
  return next();
}

const deniedTenant = (own, requested) =>
  forbidden(`Signed in against author ${own}; this request addresses author ${requested}`);

/**
 * The same check for `:authorId` in the path.
 *
 * It has to be a separate hook. Router-level middleware runs before Express has
 * matched a route, so `req.params` is empty there — a check written against
 * `req.params.authorId` inside `enforceTenant` silently passes every request,
 * which is exactly what it did until `GET /authors/2/books` came back 200 for
 * the wrong tenant. `router.param` fires once the value actually exists.
 */
export function tenantParam(req, _res, next, value) {
  if (!req.user || req.user.role === 'admin') return next();
  if (Number(value) !== req.user.authorId) {
    return next(deniedTenant(req.user.authorId, value));
  }
  return next();
}

/**
 * Refuses to act on a resource belonging to another tenant.
 *
 * `enforceTenant` cannot see this case: `/pr-materials/42/approve` names no
 * author, so the tenant is a property of row 42 rather than of the URL. Used on
 * the paths where acting across a boundary would actually cost something —
 * approving, sending, scheduling, distributing.
 */
export async function assertOwns(req, table, id) {
  if (!req.user) throw unauthorized('Sign in required');
  if (req.user.role === 'admin') return;

  const { rows } = await pool.query(`SELECT author_id FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) return; // Let the route's own 404 speak; this is not a tenant failure.

  // A row with no tenant is system-wide work — a global job sweep, say. It
  // belongs to nobody rather than to somebody else, so it is the operator's,
  // and saying "another author" about it would be a misleading refusal.
  if (rows[0].author_id === null) {
    throw forbidden(`That ${table.replace(/s$/, '')} is system-wide and needs an admin`);
  }

  if (Number(rows[0].author_id) !== req.user.authorId) {
    throw forbidden(`That ${table.replace(/s$/, '')} belongs to another author`);
  }
}

/** Route guard for the few things only an operator should do. */
export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role)
      ? next()
      : next(forbidden(`This action requires role: ${roles.join(' or ')}`));
