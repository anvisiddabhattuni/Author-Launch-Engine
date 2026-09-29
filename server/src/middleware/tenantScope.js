import { enterTenantScope } from '../db/pool.js';
import { PERMISSIONS, holds } from '../services/permissions.js';
import { provisionTenant } from '../services/tenantSchemas.js';

/**
 * An author's reads run inside their own schema (STORY-041).
 *
 * On by default for every GET route: a route added next month is isolated
 * without anyone remembering to isolate it — the STORY-064 rule. The
 * exceptions are the routes that need to see past one tenant, each with the
 * reason, where a reviewer can disagree with it. Found by switching isolation
 * on everywhere and reading what broke, not by guessing in advance.
 *
 * Sessions that read across tenants (admin, compliance) are not scoped: seeing
 * every tenant is their job, and STORY-019's permissions already decide who
 * they are.
 */
export const SYSTEM_READS = {
  '/health': 'Public, no session, no tenant rows (STORY-015).',
  '/ready': 'Public, no session, no tenant rows (STORY-015).',
  '/auth/me': 'The caller\'s own session, read from the users table before any tenant is known.',
  '/authors/:authorId/trust-dashboard':
    'Verifies the audit log\'s seals, which cover every tenant\'s rows together (STORY-013), and records ' +
    'the assessment it shows (STORY-021) — a system act, and a write. Its tenant rows are filtered by its ' +
    'own queries and walked for leaks by STORY-024.',
};

/** Prepends the tenant scope to every GET route not declared above. */
export function applyTenantScope(router) {
  const scoped = [];
  for (const layer of router.stack) {
    const route = layer.route;
    if (!route?.methods?.get || route.path in SYSTEM_READS) continue;
    route.get(tenantScope);
    route.stack.unshift(route.stack.pop());
    scoped.push(route.path);
  }
  return scoped;
}

export function tenantScope(req, res, next) {
  const user = req.user;
  if (!user || holds(user, PERMISSIONS.TENANT_READ_ALL) || !user.authorId) return next();
  req.dbRole = `ale_tenant_${Number(user.authorId)}`; // for the access log (STORY-044)
  enterTenantScope(user.authorId, next, res, {
    provision: (tenant) => provisionTenant(tenant, { reason: 'first read after STORY-041' }),
  }).catch(next);
}
tenantScope.tenantScoped = true;
