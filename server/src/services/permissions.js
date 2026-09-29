import { pool } from '../db/pool.js';

/**
 * What a role may do (STORY-019).
 *
 * Permissions are rows, not role names spelled into each route, because the
 * story's second acceptance clause asks whether a *user has the permission* —
 * and `role === 'admin'` cannot answer that question, it can only answer a
 * different one that usually agrees with it. The two stop agreeing the moment
 * somebody needs to read the audit log without being able to suspend a tenant,
 * which is precisely what a compliance officer is.
 *
 * The names are the contract. Spelling one wrong in a route would deny
 * everything rather than allow everything, which is the right way round for a
 * typo, but `assertKnownPermission` makes it a startup error instead.
 */
export const PERMISSIONS = {
  AUDIT_READ: 'audit.read',
  /** Approve or reject outbound content. The gate REQ-006 is about (STORY-022). */
  CONTENT_APPROVE: 'content.approve',
  AUDIT_VERIFY: 'audit.verify',
  TENANT_READ_ALL: 'tenant.read.all',
  /**
   * Act on any tenant's rows, not merely read them.
   *
   * Split from TENANT_READ_ALL by STORY-022. They were one permission, and
   * `assertOwns` — which guards approve, reject, send, schedule and distribute
   * — short-circuited on the read one. That made every read-across-tenants
   * role a write-across-tenants role, which is how `compliance` came to be
   * able to approve a press release in someone else's tenant.
   */
  TENANT_ACT_ALL: 'tenant.act.all',
  TENANT_MANAGE: 'tenant.manage',
  TEMPLATES_MANAGE: 'templates.manage',
  /**
   * Run health checks on demand and be told when a component goes down
   * (STORY-027). "The infrastructure team" as a capability: every other alert
   * goes to a tenant's reviewers, and an outage belongs to no tenant.
   */
  SYSTEM_OPERATE: 'system.operate',
  /**
   * Propose and decide changes to roles and permissions (STORY-042) — never
   * both for the same change; the database refuses an approver who asked.
   */
  ACCESS_MANAGE: 'access.manage',
};

const KNOWN = new Set(Object.values(PERMISSIONS));

/** Catches a mistyped permission at the call site rather than as a silent deny. */
export function assertKnownPermission(name) {
  if (!KNOWN.has(name)) {
    throw new Error(
      `Unknown permission "${name}". Known: ${[...KNOWN].sort().join(', ')}. ` +
        'A permission that exists in no grant denies everyone, silently.',
    );
  }
  return name;
}

/**
 * The permissions granted to a role.
 *
 * Read at sign-in and carried in the token, so the middleware that needs them
 * stays synchronous and no request pays for a lookup. The cost is that a grant
 * change reaches a signed-in user only when their token is next issued — the
 * same lag `role` has had since STORY-064, because `role` is already a claim.
 * This adds no new class of staleness, and it is named in the README's Known
 * gaps rather than left for someone to discover.
 */
export async function permissionsForRole(role, client = pool) {
  const { rows } = await client.query(
    'SELECT permission FROM role_permissions WHERE role = $1 ORDER BY permission',
    [role],
  );
  return rows.map((r) => r.permission);
}

/** Every role and what it may do — for the demo, and for a reviewer's eyes. */
export async function grantMatrix(client = pool) {
  const { rows } = await client.query(
    `SELECT r.name AS role, r.description,
            COALESCE(ARRAY_AGG(rp.permission ORDER BY rp.permission)
                     FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role = r.name
      GROUP BY r.name, r.description
      ORDER BY r.name`,
  );
  return rows;
}

/**
 * Whether a session holds a permission.
 *
 * Falls back to the empty set rather than to the role, on purpose. A token
 * issued before this story carries no `permissions` claim, and reading the
 * absence as "allow, they're an admin" would make the guard advisory for
 * exactly the sessions that predate it.
 */
export const holds = (user, permission) =>
  Array.isArray(user?.permissions) && user.permissions.includes(permission);
