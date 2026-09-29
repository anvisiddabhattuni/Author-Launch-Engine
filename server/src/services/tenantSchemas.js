import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/**
 * Per-tenant schemas (STORY-041 / REQ-011) — Infrastructure and Deployment Agent.
 *
 * Each tenant gets a schema `tenant_<id>` of views showing only its rows, and a
 * role `ale_tenant_<id>` that can read only that schema. Built by the owner's
 * function `ale_provision_tenant` (036), which the application may execute and
 * cannot otherwise imitate: it is the one piece of DDL the app can cause.
 */
export const ACTOR = 'InfrastructureDeploymentAgent';

/** Builds, or rebuilds, a tenant's schema. Logged with the tenant and when (the story's trust clause). */
export async function provisionTenant(authorId, { reason = 'first use' } = {}) {
  const tenant = Number(authorId);
  const { rows: before } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [`tenant_${tenant}`]);
  const { rows } = await pool.query('SELECT * FROM ale_provision_tenant($1)', [tenant]);
  const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  await recordAction({
    actor: ACTOR,
    action: before.length ? 'tenant.schema_rebuilt' : 'tenant.schema_created',
    entityType: 'tenant',
    entityId: tenant,
    authorId: tenant,
    metadata: {
      tenant,
      schema: `tenant_${tenant}`,
      role: `ale_tenant_${tenant}`,
      provisionedAt: new Date().toISOString(),
      reason,
      views: rows.filter((r) => r.object.startsWith('tenant_')).length,
      sharedReadable: rows.filter((r) => r.kind === 'shared, readable').length,
      byKind,
    },
  });
  return { tenant, schema: `tenant_${tenant}`, objects: rows };
}

/** What a tenant's schema contains, for the dashboard and for a reviewer. */
export async function tenantSchema(authorId) {
  const tenant = Number(authorId);
  const { rows: views } = await pool.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name`,
    [`tenant_${tenant}`],
  );
  const { rows: shared } = await pool.query('SELECT * FROM tenant_shared_tables ORDER BY table_name');
  return {
    tenant,
    schema: `tenant_${tenant}`,
    role: `ale_tenant_${tenant}`,
    provisioned: views.length > 0,
    views: views.map((v) => v.table_name),
    shared,
  };
}
