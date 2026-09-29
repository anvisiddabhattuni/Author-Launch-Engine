import { createHash } from 'node:crypto';

import { verifyAuditLog } from '../agents/auditSecurityAgent.js';
import { outsideTenantScope, pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/**
 * Audit log reports (STORY-028 / REQ-005) — Audit and Security Agent.
 *
 * What a stakeholder asks for when they say "the audit log for March": every
 * action in a period, with its time and who did it, filterable, summarised,
 * exportable — and provably the report that was generated. Each report carries
 * a SHA-256 of its records, the seal verification at the time it was made
 * (STORY-013), and is itself on the audit log.
 *
 * "Who did it" is resolved as far as the log allows, and says how: an agent
 * (the system acting), a person matched to their account (email and role), or
 * a name the log recorded that no account has — never guessed.
 */
export const ACTOR = 'AuditSecurityAgent';
export const MAX_ROWS = 5000;

const fail = (status, message) => Object.assign(new Error(message), { status });

function range({ from, to }) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw fail(400, 'from and to must be dates');
  if (start > end) throw fail(400, 'from is after to');
  return { start, end };
}

export async function generateAuditReport({ from, to, authorId = null, actor = null, action = null, user }) {
  const { start, end } = range({ from, to });
  const params = [start.toISOString(), end.toISOString()];
  const conditions = ['a.created_at >= $1', 'a.created_at <= $2'];
  if (authorId) {
    params.push(Number(authorId));
    conditions.push(`a.author_id = $${params.length}`);
  }
  if (actor) {
    params.push(actor);
    conditions.push(`a.actor = $${params.length}`);
  }
  if (action) {
    // A prefix: "draft." is every draft action.
    // Escaped, not stripped: action names contain underscores, which LIKE
    // reads as a wildcard ("report.test_person" matched nothing when stripped).
    params.push(`${action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    conditions.push(`a.action LIKE $${params.length} ESCAPE '\\'`);
  }
  const where = conditions.join(' AND ');

  const { rows: records } = await pool.query(
    `SELECT a.id, a.created_at, a.actor, a.action, a.entity_type, a.entity_id, a.author_id,
            t.name AS tenant_name, a.before, a.after, a.metadata,
            u.id AS actor_user_id, u.email AS actor_email, u.role AS actor_role,
            CASE WHEN u.id IS NOT NULL THEN 'person'
                 WHEN a.actor ~ '(Agent|System|Worker|Scheduler)$' THEN 'agent'
                 ELSE 'unmatched' END AS actor_kind
       FROM audit_log a
       LEFT JOIN users u ON u.name = a.actor
       LEFT JOIN authors t ON t.id = a.author_id
      WHERE ${where}
      ORDER BY a.created_at, a.id
      LIMIT ${MAX_ROWS + 1}`,
    params,
  );
  const truncated = records.length > MAX_ROWS;
  if (truncated) records.length = MAX_ROWS;

  const count = (key) => Object.entries(records.reduce((acc, r) => ({ ...acc, [key(r)]: (acc[key(r)] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]);
  const summary = {
    records: records.length,
    truncated,
    byAction: count((r) => r.action).slice(0, 25),
    byActor: count((r) => r.actor).slice(0, 25),
    byDay: count((r) => new Date(r.created_at).toISOString().slice(0, 10)).sort((a, b) => a[0].localeCompare(b[0])),
    actorKinds: Object.fromEntries(count((r) => r.actor_kind)),
    tenants: new Set(records.map((r) => r.author_id).filter(Boolean)).size,
  };

  // What makes this report checkable later: a digest of exactly these records,
  // and whether the log's seals held when it was made.
  const digest = createHash('sha256')
    .update(JSON.stringify(records.map((r) => [r.id, r.created_at, r.actor, r.action, r.entity_type, r.entity_id, r.author_id, r.before, r.after, r.metadata])))
    .digest('hex');
  // System acts, outside the requester's tenant scope: the seals cover every
  // tenant's rows (a tenant-scoped read would see its own and call the seals
  // broken), and an author's reads are read-only (STORY-041). The records
  // above were read through the requester's scope, so an author's report is
  // confined by the database, not only by the filter.
  const integrity = await outsideTenantScope(() => verifyAuditLog({})).then((v) => v.status).catch(() => 'unknown');

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: { id: user.id, name: user.name, role: user.role },
    period: { from: start.toISOString(), to: end.toISOString() },
    filters: { authorId: authorId ? Number(authorId) : null, actor, action },
    integrity,
    digest,
    summary,
    records,
  };

  await outsideTenantScope(() => recordAction({
    actor: user.name,
    action: 'audit.report_generated',
    entityType: 'audit_report',
    entityId: digest.slice(0, 16),
    authorId: authorId ? Number(authorId) : null,
    metadata: { period: report.period, filters: report.filters, records: records.length, truncated, digest, integrity, userId: user.id },
  }));
  return report;
}

const csvCell = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The same report as CSV, with its digest and integrity in the header lines. */
export function reportAsCsv(report) {
  const head = [
    `# Author Launch Engine audit log report`,
    `# period ${report.period.from} to ${report.period.to}; generated ${report.generatedAt} by ${report.generatedBy.name} (${report.generatedBy.role})`,
    `# ${report.summary.records} records${report.summary.truncated ? ' (truncated)' : ''}; seals: ${report.integrity}; sha256 ${report.digest}`,
  ];
  const cols = ['id', 'created_at', 'actor', 'actor_kind', 'actor_email', 'actor_role', 'action', 'entity_type', 'entity_id', 'author_id', 'tenant_name', 'before', 'after', 'metadata'];
  const lines = report.records.map((r) => cols.map((c) => csvCell(c === 'created_at' ? new Date(r[c]).toISOString() : r[c])).join(','));
  return [...head, cols.join(','), ...lines].join('\n');
}
