import { pool } from '../db/pool.js';
import { verifyToken } from '../services/auth.js';
import { PERMISSIONS, assertKnownPermission, holds, permissionsForRole } from '../services/permissions.js';
import { accessVersion } from '../services/accessChanges.js';
import { sessionForKey } from '../services/apiKeys.js';

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
const PUBLIC_PATHS = new Set(['/health', '/ready', '/auth/login', '/auth/accept-invite']);

export async function authenticate(req, _res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  // A tenant's API key (STORY-045): `X-API-Key: ale_…` or `Authorization: ApiKey ale_…`.
  const presentedKey = req.get('x-api-key') ?? (scheme?.toLowerCase() === 'apikey' ? token : null);
  if (presentedKey) {
    try {
      req.user = await sessionForKey(presentedKey);
    } catch (error) {
      return next(error);
    }
    // Read-only unless created otherwise. Keys never manage keys (see apiKeys.js).
    if (req.user.apiKeyAccess === 'read' && req.method !== 'GET') {
      return next(forbidden('This API key is read-only'));
    }
    return next();
  }

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return next(unauthorized('Sign in required: send Authorization: Bearer <token>, or X-API-Key'));
  }

  try {
    const claims = verifyToken(token);
    req.user = {
      id: Number(claims.sub),
      name: claims.name,
      email: claims.email ?? null,
      role: claims.role,
      // Absent on a token issued before STORY-019. Read as "no permissions"
      // rather than falling back to the role, so an old session is denied
      // rather than waved through by the guard that was added to stop it.
      permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
      authorId: claims.authorId === null ? null : Number(claims.authorId),
    };
    // Absent on tokens issued before STORY-042: treated as behind, so they are
    // re-read rather than trusted.
    req.user.accessVersion = claims.accessVersion ?? null;
  } catch (error) {
    // The reason is deliberately not echoed back. "Signature invalid" versus
    // "expired" tells a probing caller which half of a forged token to fix.
    return next(unauthorized(`Session is not valid: ${error.name === 'TokenExpiredError' ? 'expired' : 'rejected'}`));
  }

  // A session issued before the last access change is re-read before it is
  // trusted (STORY-042). Permissions travel in the token so most requests pay
  // nothing; the version tells the few that must look again. Before this, an
  // author whose approval right had been revoked approved a draft with the
  // token they already held — for up to twelve hours.
  try {
    const current = await accessVersion();
    if (req.user.accessVersion === null || Number(req.user.accessVersion) !== current) {
      const { rows } = await pool.query('SELECT role, active, author_id FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0] || !rows[0].active) return next(unauthorized('Session is not valid: account no longer active'));
      req.user.role = rows[0].role;
      req.user.authorId = rows[0].author_id === null ? null : Number(rows[0].author_id);
      req.user.permissions = await permissionsForRole(rows[0].role);
      req.user.accessRefreshed = true;
    }
  } catch (error) {
    return next(error);
  }
  return next();
}

/**
 * Whether this session may address a tenant other than its own.
 *
 * Was `role === 'admin'`, in three places. That reading is why a compliance
 * officer had to be made an admin to read across tenants, which also handed
 * them the power to suspend one — the exact conflation STORY-019 exists to
 * undo. The question is "may they read across tenants", so that is now the
 * thing being asked (STORY-019).
 */
const readsAllTenants = (user) => holds(user, PERMISSIONS.TENANT_READ_ALL);

/**
 * Whether this session may *act* on another tenant's rows.
 *
 * Deliberately not the same question as `readsAllTenants`. `assertOwns` used
 * to short-circuit on the read permission, so granting a role the ability to
 * see every tenant also granted it the ability to approve, reject, send,
 * schedule and distribute in every tenant — the hole STORY-022 found by
 * approving a press release as the read-only compliance role (STORY-022).
 */
const actsOnAllTenants = (user) => holds(user, PERMISSIONS.TENANT_ACT_ALL);

/**
 * Pins every request to the caller's tenant.
 *
 * Before this, every list route read its tenant from a query parameter the
 * caller supplied — changing a number in the URL read another author's work.
 * An `author` may only ever address their own tenant, and a request that omits
 * the tenant gets theirs filled in rather than being served everything.
 *
 * A session holding `tenant.read.all` is left alone: reading across tenants is
 * the distinction that permission exists for. They still cannot approve
 * anonymously — that is `authenticate`'s job and it has already run.
 */
export function enforceTenant(req, _res, next) {
  if (PUBLIC_PATHS.has(req.path) || !req.user) return next();
  if (readsAllTenants(req.user)) return next();

  const own = req.user.authorId;
  const requested = req.query.authorId;
  // Whose data this request asked for, for the access log (STORY-044). Only
  // when it named one: an author's request that named none is about their own,
  // and the log works that out after routing, when the path's tenant is known.
  if (requested !== undefined) req.accessTarget = requested;

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
  req.accessTarget = value; // for the access log (STORY-044), allowed or not
  if (!req.user || readsAllTenants(req.user)) return next();
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
  // Acting, not reading. See `actsOnAllTenants` above for why these are two
  // permissions rather than one.
  const { rows } = await pool.query(`SELECT author_id FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) return; // Let the route's own 404 speak; this is not a tenant failure.
  // Whose row this is, for the access log (STORY-044) — read for admins too,
  // so an operator acting on a tenant's row is recorded against that tenant.
  if (rows[0].author_id !== null) req.accessTarget = rows[0].author_id;
  if (actsOnAllTenants(req.user)) return;

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

/**
 * Route guard: does this session hold the permission this route needs?
 *
 * Replaces `requireRole('admin')`, which asked who somebody *is* when the
 * question is what they may *do*. Those two agree right up until they don't —
 * a compliance officer needs the audit log and must not be able to suspend a
 * tenant, and under role checks there was no way to express that (STORY-019).
 *
 * The permission name is validated at module load rather than at request time,
 * so a typo is a startup crash instead of a route that quietly denies everyone.
 */
export const requirePermission = (permission) => {
  assertKnownPermission(permission);
  const guard = (req, _res, next) =>
    holds(req.user, permission)
      ? next()
      : next(forbidden(`This action requires permission: ${permission}`));
  // Readable off the router, so a test can say which permission guards which
  // route without a hand-kept list drifting from the code (STORY-050).
  guard.permission = permission;
  return guard;
};

/**
 * Reviewing across tenants: whoever manages access, or reads the audit trail
 * across tenants. Not `audit.read` alone — authors hold that for their own
 * trail (STORY-042, STORY-044).
 */
export const requireAuditReviewer = (() => {
  const guard = (req, _res, next) =>
    holds(req.user, PERMISSIONS.ACCESS_MANAGE) ||
    (holds(req.user, PERMISSIONS.AUDIT_READ) && holds(req.user, PERMISSIONS.TENANT_READ_ALL))
      ? next()
      : next(forbidden('This needs access.manage, or audit.read across tenants'));
  guard.permission = 'access.manage | audit.read + tenant.read.all';
  return guard;
})();

// `requireRole` was here. Every one of its seven call sites asked for 'admin',
// and every one of them actually meant a capability — manage tenants, curate
// templates, verify the log. Leaving it exported would leave the easy wrong
// answer available next to the right one, so it is gone rather than deprecated.
