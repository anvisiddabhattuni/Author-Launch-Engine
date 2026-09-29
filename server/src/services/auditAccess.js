import { grantMatrix, PERMISSIONS } from './permissions.js';

/**
 * Who may read and manage the audit logs (STORY-050 / REQ-013).
 *
 * Every route that serves audit data is listed here with the permission that
 * guards it, and why. The list is checked against the live router in
 * `auditAccess.test.js`: a route whose handler reads audit data and is not
 * here — or is here and guarded by something else — fails the build. That is
 * how three routes were found serving audit data with no permission at all:
 * an API key, which holds none, read a tenant's access log, its trust history
 * and its trust dashboard.
 *
 * "Audit data" means the audit log (and its encrypted storage), its seals, the
 * data access log (STORY-044) and the security log (STORY-051) — recognised in
 * a handler's source by the names below.
 */
export const AUDIT_DATA = /\b(audit_log|audit_log_sealed|audit_checkpoints|listAuditLog|verifyAuditLog|sealAuditLog|generateAuditReport|attentionFor|governanceScore|searchTenant|searchStatus|sealAndVerify|accessReport|tenantAccessEvents|data_access_events|security_log|security_log_sealed|securityLogReport|trustDashboard|buildTrustDashboard|trustHistory|accessOverview)\b/;

export const REVIEWER = 'access.manage | audit.read + tenant.read.all';

/** Reading across tenants versus a tenant's own. The tenant rule is enforced separately (STORY-017). */
export const AUDIT_ROUTES = {
  'GET /audit-log': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'The audit trail. Authors hold audit.read for their own tenant; tenant.read.all spans every tenant.' },
  'GET /audit-reports': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Audit log reports for a period (STORY-028). An author\'s own tenant; tenant.read.all spans every tenant.' },
  'GET /authors/:authorId/attention': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Recent actions from the audit trail beside pending approvals (STORY-057). A tenant\'s own.' },
  'GET /authors/:authorId/governance-score': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Scores the tenant\'s decisions against the audit trail and seals (STORY-058).' },
  'GET /authors/:authorId/search': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Searches the tenant\'s audit and data access logs in the index (STORY-055). A tenant\'s own; the security log is not searchable here.' },
  'GET /authors/:authorId/search/status': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'How far the index has got and whether it matched the logs at the last check (STORY-055). Counts only.' },
  'GET /audit-integrity': { permission: PERMISSIONS.AUDIT_VERIFY, can: 'read', why: 'Seal verification spans every tenant\'s rows (STORY-013), so it is for those who verify.' },
  'POST /audit-integrity/verify': { permission: PERMISSIONS.AUDIT_VERIFY, can: 'manage', why: 'Seals the unsealed range and verifies every seal, recording the result.' },
  'GET /authors/:authorId/trust-history': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Built from the audit trail. Was ungated: an API key read it (STORY-050).' },
  'GET /authors/:authorId/trust-dashboard': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'Shows the tenant\'s audit trail and seals. Was ungated: an API key read it (STORY-050).' },
  'GET /authors/:authorId/access-events': { permission: PERMISSIONS.AUDIT_READ, can: 'read', why: 'The data access log, a tenant\'s own. Was ungated: an API key read who opened the data (STORY-050).' },
  'GET /tenants': { permission: PERMISSIONS.TENANT_READ_ALL, can: 'read', why: 'Names who onboarded each tenant, from the audit log (STORY-043). Every tenant, so tenant.read.all.' },
  'GET /security/access': { permission: REVIEWER, can: 'read', why: 'The data access log across tenants (STORY-044).' },
  'GET /access': { permission: REVIEWER, can: 'read', why: 'Access changes and their trail (STORY-042).' },
  'GET /security/audit-access': { permission: REVIEWER, can: 'read', why: 'The security log: who tried to read the audit logs (STORY-051). Reading it is recorded in it.' },
  'GET /security/audit-access-policy': { permission: REVIEWER, can: 'read', why: 'This table, as the product shows it.' },
};

/**
 * The policy as it stands: for each role, which audit routes it may use —
 * derived from the live grant table, not written down twice.
 */
export async function auditAccessPolicy() {
  const matrix = await grantMatrix();
  const roles = matrix.map((r) => ({ role: r.role, permissions: new Set(r.permissions) }));
  const allowed = (perms, permission) =>
    permission === REVIEWER
      ? perms.has(PERMISSIONS.ACCESS_MANAGE) || (perms.has(PERMISSIONS.AUDIT_READ) && perms.has(PERMISSIONS.TENANT_READ_ALL))
      : perms.has(permission);
  const principals = [
    ...roles,
    // An API key (STORY-045) holds no permissions of its own.
    { role: 'api key', permissions: new Set() },
  ];
  return Object.entries(AUDIT_ROUTES).map(([route, spec]) => ({
    route,
    ...spec,
    roles: Object.fromEntries(principals.map((p) => {
      if (!allowed(p.permissions, spec.permission)) return [p.role, 'no'];
      const acrossTenants = p.permissions.has(PERMISSIONS.TENANT_READ_ALL);
      return [p.role, route.includes(':authorId') || route === 'GET /audit-log' ? (acrossTenants ? 'all tenants' : 'own tenant') : 'yes'];
    })),
  }));
}
