import { verifyAuditLogCached } from '../agents/auditSecurityAgent.js';
import { findAwaitingApproval } from '../agents/approvalNotificationAgent.js';
import { outsideTenantScope, pool } from '../db/pool.js';
import { runChecks, SEVERITY } from './governance.js';

/**
 * The governance score (STORY-058 / REQ-015, REQ-005) — Trust and Monitoring
 * Agent.
 *
 * Before this story the "score" was the share of governance checks passing
 * (22 of 24). That says the rules held; it says nothing about what the system
 * *did*. The story asks for a formula over behaviour — "% actions audited,
 * % approvals honored, failure rate" — with a breakdown. So:
 *
 *   factor              weight  measured over the window
 *   checks passing       0.25   governance checks passing (STORY-014)
 *   approvals honoured   0.25   published / sent / distributed items with a human approval first
 *   decisions audited    0.15   approvals and rejections with their audit entry
 *   reliability          0.15   sends and jobs that did not fail
 *   timeliness           0.10   waiting items younger than two days
 *   log integrity        0.10   seals intact and every entry encrypted (STORY-013, STORY-049)
 *
 * A factor with nothing to measure is left out and its weight shared among the
 * rest — shown, not hidden. And any broken invariant caps the score at 50: a
 * system that did the one thing it promises not to is not "92% governed".
 */
export const FACTORS = [
  { id: 'checks', label: 'Governance checks passing', weight: 0.25 },
  { id: 'honoured', label: 'Approvals honoured before anything went out', weight: 0.25 },
  { id: 'audited', label: 'Decisions on the audit log', weight: 0.15 },
  { id: 'reliability', label: 'Sends and jobs that did not fail', weight: 0.15 },
  { id: 'timeliness', label: 'Waiting items younger than two days', weight: 0.10 },
  { id: 'integrity', label: 'Audit log sealed and encrypted', weight: 0.10 },
];
export const INVARIANT_CAP = 0.5;
export const WINDOW_DAYS = 30;

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

/** Combines measured factors into the score. Pure, so the formula is testable on its own. */
export function combine(measured, { invariantsBroken = [] } = {}) {
  const usable = FACTORS.filter((f) => measured[f.id] && measured[f.id].d > 0);
  const totalWeight = usable.reduce((a, f) => a + f.weight, 0);
  const factors = FACTORS.map((f) => {
    const m = measured[f.id] ?? { n: 0, d: 0 };
    const noData = m.d === 0;
    const value = noData ? null : m.n / m.d;
    const weight = noData || totalWeight === 0 ? 0 : f.weight / totalWeight;
    return {
      ...f,
      measured: { n: m.n, d: m.d },
      detail: m.detail ?? '',
      noData,
      value: value === null ? null : Number(value.toFixed(3)),
      effectiveWeight: Number(weight.toFixed(3)),
      contribution: value === null ? 0 : Number((value * weight * 100).toFixed(1)),
    };
  });
  const raw = factors.reduce((a, f) => a + (f.value ?? 0) * f.effectiveWeight, 0);
  const capped = invariantsBroken.length > 0 && raw > INVARIANT_CAP;
  const score = Math.round((capped ? INVARIANT_CAP : raw) * 100);
  return {
    score: usable.length ? score : null,
    uncapped: Math.round(raw * 100),
    capped,
    capReason: capped ? `capped at ${INVARIANT_CAP * 100}: ${invariantsBroken.join(', ')} broken — no number of passing checks offsets that` : null,
    factors,
  };
}

/** Measures every factor and returns the score with its breakdown. */
export async function governanceScore({ authorId = null, days = WINDOW_DAYS } = {}) {
  // System reads: the checks and seals span every tenant (STORY-041's
  // trust-dashboard exception, for the same reason).
  return outsideTenantScope(async () => {
    const tenant = authorId ? Number(authorId) : null;
    const since = `now() - make_interval(days => ${Math.min(Math.max(Number(days) || WINDOW_DAYS, 1), 365)})`;
    const t = (alias) => (tenant ? `AND ${alias}.author_id = ${tenant}` : '');

    const results = await runChecks({});
    const invariantsBroken = results.filter((r) => r.severity === SEVERITY.INVARIANT && !r.passed).map((r) => r.id);

    const honoured = await one(
      `SELECT
         (SELECT COUNT(*) FROM scheduled_posts sp WHERE sp.status = 'published' AND sp.published_at > ${since} ${t('sp')})
       + (SELECT COUNT(*) FROM outreach_sends os WHERE os.status = 'sent' AND os.sent_at > ${since} ${t('os')})
       + (SELECT COUNT(*) FROM pr_distributions pd WHERE pd.status = 'sent' AND pd.sent_at > ${since} ${t('pd')}) AS d,
         (SELECT COUNT(*) FROM scheduled_posts sp WHERE sp.status = 'published' AND sp.published_at > ${since} ${t('sp')}
             AND EXISTS (SELECT 1 FROM approvals a WHERE a.draft_id = sp.draft_id AND a.decision = 'approved' AND a.created_at <= sp.published_at))
       + (SELECT COUNT(*) FROM outreach_sends os WHERE os.status = 'sent' AND os.sent_at > ${since} ${t('os')}
             AND EXISTS (SELECT 1 FROM approvals a WHERE a.outreach_message_id = os.message_id AND a.decision = 'approved' AND a.created_at <= os.sent_at))
       + (SELECT COUNT(*) FROM pr_distributions pd WHERE pd.status = 'sent' AND pd.sent_at > ${since} ${t('pd')}
             AND NOT EXISTS (SELECT 1 FROM pr_materials m WHERE m.kit_id = pd.kit_id
                              AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.pr_material_id = m.id AND a.decision = 'approved' AND a.created_at <= pd.sent_at))) AS n`,
    );

    const audited = await one(
      `SELECT COUNT(*) AS d,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM audit_log l
                 WHERE l.entity_id = COALESCE(a.draft_id, a.outreach_message_id, a.pr_material_id, a.mix_recommendation_id)::text
                   AND l.action LIKE '%.' || a.decision
                   AND l.entity_type = CASE WHEN a.draft_id IS NOT NULL THEN 'draft'
                                            WHEN a.outreach_message_id IS NOT NULL THEN 'outreach_message'
                                            WHEN a.pr_material_id IS NOT NULL THEN 'pr_material'
                                            ELSE 'mix_recommendation' END)) AS n
         FROM approvals a
         LEFT JOIN drafts d ON d.id = a.draft_id
         LEFT JOIN outreach_messages o ON o.id = a.outreach_message_id
         LEFT JOIN pr_materials p ON p.id = a.pr_material_id
         LEFT JOIN mix_recommendations x ON x.id = a.mix_recommendation_id
        WHERE a.created_at > ${since}
          ${tenant ? `AND COALESCE(d.author_id, o.author_id, p.author_id, x.author_id) = ${tenant}` : ''}`,
    );

    const reliability = await one(
      `SELECT
         (SELECT COUNT(*) FROM scheduled_posts sp WHERE sp.status IN ('published', 'failed') AND sp.created_at > ${since} ${t('sp')})
       + (SELECT COUNT(*) FROM outreach_sends os WHERE os.status IN ('sent', 'failed') AND os.created_at > ${since} ${t('os')})
       + (SELECT COUNT(*) FROM pr_distributions pd WHERE pd.status IN ('sent', 'failed') AND pd.created_at > ${since} ${t('pd')})
       + (SELECT COUNT(*) FROM jobs j WHERE j.status IN ('done', 'dead_letter') AND j.created_at > ${since} ${tenant ? `AND (j.author_id = ${tenant} OR j.author_id IS NULL)` : ''}) AS d,
         (SELECT COUNT(*) FROM scheduled_posts sp WHERE sp.status = 'failed' AND sp.created_at > ${since} ${t('sp')})
       + (SELECT COUNT(*) FROM outreach_sends os WHERE os.status = 'failed' AND os.created_at > ${since} ${t('os')})
       + (SELECT COUNT(*) FROM pr_distributions pd WHERE pd.status = 'failed' AND pd.created_at > ${since} ${t('pd')})
       + (SELECT COUNT(*) FROM jobs j WHERE j.status = 'dead_letter' AND j.created_at > ${since} ${tenant ? `AND (j.author_id = ${tenant} OR j.author_id IS NULL)` : ''}) AS failed`,
    );

    let waiting = { total: 0, items: [] };
    if (tenant) waiting = await findAwaitingApproval({ authorId: tenant });
    else {
      const { rows } = await pool.query('SELECT id FROM authors');
      for (const a of rows) {
        const w = await findAwaitingApproval({ authorId: a.id });
        waiting.total += w.total;
        waiting.items.push(...w.items);
      }
    }
    const stale = waiting.items.filter((i) => i.ageHours >= 48).length;

    const seals = await verifyAuditLogCached().then((v) => v.status).catch(() => 'unknown');
    const enc = await one('SELECT entries, other_keys, unopened FROM audit_encryption_status()');
    const encryptionOk = Number(enc.other_keys) + Number(enc.unopened) === 0;

    const measured = {
      checks: { n: results.filter((r) => r.passed).length, d: results.length, detail: invariantsBroken.length ? `invariants broken: ${invariantsBroken.join(', ')}` : 'no invariant broken' },
      honoured: { n: Number(honoured.n), d: Number(honoured.d), detail: 'posts published, outreach sent and press distributed with an approval recorded before they went out' },
      audited: { n: Number(audited.n), d: Number(audited.d), detail: 'approvals and rejections with their matching audit entry' },
      reliability: { n: Number(reliability.d) - Number(reliability.failed), d: Number(reliability.d), detail: `${reliability.failed} failed: publishes, sends, distributions and dead-lettered jobs` },
      timeliness: { n: waiting.total - stale, d: waiting.total, detail: `${stale} of ${waiting.total} waiting items older than two days` },
      integrity: { n: (seals !== 'altered' ? 1 : 0) + (encryptionOk ? 1 : 0), d: 2, detail: `seals ${seals}; ${encryptionOk ? 'every entry encrypted under the current key' : 'entries not opening or under another key'}` },
    };
    return {
      computedAt: new Date().toISOString(),
      window: { days: Number(days) || WINDOW_DAYS, authorId: tenant },
      ...combine(measured, { invariantsBroken }),
    };
  });
}
