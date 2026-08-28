/**
 * What the system can honestly say about its own compliance (STORY-014).
 *
 * A trust dashboard is an easy thing to build badly. The tempting version shows
 * a number — "trust score 87" — that moves for reasons nobody can name, and is
 * believed precisely because it is a number. This one is a list of checks, each
 * with the query behind it and the evidence it found, and the score is a summary
 * of that list rather than a thing in its own right.
 *
 * Two categories, and the distinction does the work:
 *
 *   **Invariants** are things that must never be true. Content published without
 *   an approval on record is not a degraded score, it is a breach of the promise
 *   the whole product makes, and one of them failing outranks every passing
 *   check in the list.
 *
 *   **Quality checks** are things that should be true. An approval nobody was
 *   signed in for is worth knowing about and is not the same kind of event.
 *
 * Anomalies are separate again — patterns that are *unusual* rather than wrong,
 * and the place a dashboard is most likely to invent findings. Each one states
 * its sample size and declines to conclude below it, which is the STORY-069 rule
 * applied to a different set of small numbers.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export const SEVERITY = { INVARIANT: 'invariant', QUALITY: 'quality' };

export const STATUS = {
  BREACH: 'breach',
  DEGRADED: 'degraded',
  HEALTHY: 'healthy',
};

/**
 * Every check, as a query that counts violations.
 *
 * `count = 0` is a pass, always. Writing them this way means the evidence a
 * check reports is the same thing the check tested, rather than a number derived
 * separately and hoped to agree.
 *
 * Demo fixtures are excluded from the publishing invariant by external id. The
 * demo injects published rows directly to build a sample for the meme-vs-text
 * comparison, and they are genuinely un-approved — the check is right to see
 * them, and flagging a shortcut this repository takes on purpose would drown the
 * signal it exists to carry. Named here rather than hidden.
 */
export const CHECKS = [
  {
    id: 'gate.posts',
    severity: SEVERITY.INVARIANT,
    label: 'Nothing published without an approval on record',
    why: 'REQ-006. The promise the whole product makes.',
    sql: `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
           WHERE sp.status = 'published'
             AND COALESCE(sp.external_id, '') NOT LIKE 'sim-%'
             AND NOT EXISTS (
               SELECT 1 FROM approvals a
                WHERE a.draft_id = sp.draft_id AND a.decision = 'approved')`,
  },
  {
    id: 'gate.outreach',
    severity: SEVERITY.INVARIANT,
    label: 'No outreach email sent without an approval on record',
    why: 'REQ-006, on the channel where a mistake reaches a named stranger.',
    sql: `SELECT COUNT(*)::int AS n FROM outreach_sends s
           WHERE NOT EXISTS (
             SELECT 1 FROM approvals a
              WHERE a.outreach_message_id = s.message_id AND a.decision = 'approved')`,
  },
  {
    id: 'gate.press',
    severity: SEVERITY.INVARIANT,
    label: 'No press kit distributed containing an unapproved material',
    why: 'REQ-003. A kit goes out whole, so one unapproved material is the kit.',
    sql: `SELECT COUNT(*)::int AS n FROM pr_distributions d
           JOIN pr_materials m ON m.kit_id = d.kit_id
          WHERE m.status NOT IN ('approved', 'distributed')`,
  },
  {
    id: 'gate.schedule',
    severity: SEVERITY.INVARIANT,
    label: 'Nothing queued for publishing that a human had not approved',
    why: 'The gate is in the scheduler; this is the gate checked from outside it.',
    sql: `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
           JOIN drafts d ON d.id = sp.draft_id
          WHERE d.status NOT IN ('approved', 'scheduled')`,
  },
  {
    id: 'approvals.attributable',
    severity: SEVERITY.QUALITY,
    label: 'Every approval names an authenticated session',
    why: 'STORY-064. A decision with no session behind it is a name in a text box.',
    sql: 'SELECT COUNT(*)::int AS n FROM approvals WHERE user_id IS NULL',
  },
  {
    id: 'queue.reachable',
    severity: SEVERITY.QUALITY,
    label: 'Nothing is waiting on a human nobody can reach',
    why: 'STORY-012. A queue with no reviewer configured is not an empty queue.',
    sql: `SELECT COUNT(*)::int AS n FROM authors au
           WHERE EXISTS (SELECT 1 FROM drafts d
                          WHERE d.author_id = au.id
                            AND d.status IN ('pending_approval', 'escalated'))
             AND NOT EXISTS (SELECT 1 FROM reviewers r
                              WHERE r.author_id = au.id AND r.active)`,
  },
  {
    id: 'jobs.no_dead_letters',
    severity: SEVERITY.QUALITY,
    label: 'No scheduled work has been given up on',
    why: 'STORY-065. A dead letter is work that stopped and told nobody.',
    sql: "SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'dead_letter'",
  },
  {
    id: 'audit.sealed',
    severity: SEVERITY.QUALITY,
    label: 'The audit log has been sealed recently enough to be verifiable',
    why: 'STORY-013. Unsealed rows are the window in which tampering leaves no trace.',
    sql: `SELECT GREATEST(0, COUNT(*)::int - $1) AS n FROM audit_log
           WHERE id > COALESCE((SELECT MAX(to_id) FROM audit_checkpoints), 0)`,
    params: () => [config.maxUnsealedAuditRows],
  },
];

/**
 * Runs every check and reports what it found.
 *
 * The audit-integrity verdict is passed in rather than recomputed here: it is
 * expensive, it belongs to the Audit and Security Agent, and a second
 * implementation of it would be free to disagree with the first.
 */
export async function runChecks({ auditIntegrity = null } = {}, client = pool) {
  const results = [];

  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql, check.params ? check.params() : []);
    const count = rows[0].n;
    results.push({
      id: check.id,
      severity: check.severity,
      label: check.label,
      why: check.why,
      passed: count === 0,
      violations: count,
    });
  }

  if (auditIntegrity) {
    results.push({
      id: 'audit.integrity',
      severity: SEVERITY.INVARIANT,
      label: 'The audit log still says what it said when it was written',
      why: 'STORY-013. An unverifiable log is a promise, not a record.',
      passed: auditIntegrity.status !== 'altered',
      violations: auditIntegrity.breaks?.length ?? 0,
      // "Nothing sealed yet" is not a pass and not a failure. Reported as its
      // own thing rather than being rounded to whichever is convenient.
      note:
        auditIntegrity.status === 'nothing_sealed_yet'
          ? 'nothing sealed yet, so nothing has been verified'
          : (auditIntegrity.breaks?.[0]?.finding ?? null),
    });
  }

  return results;
}

/**
 * The governance score, and why it is not the verdict.
 *
 * A single failed invariant means the system broke its central promise, and no
 * number of passing checks offsets that — so `status` is decided by severity
 * and the score is reported beside it as a summary. A dashboard that showed
 * "94%" while content had been published unapproved would be worse than one that
 * showed nothing.
 */
export function scoreOf(results) {
  const invariants = results.filter((r) => r.severity === SEVERITY.INVARIANT);
  const failedInvariants = invariants.filter((r) => !r.passed);
  const failedQuality = results.filter((r) => r.severity === SEVERITY.QUALITY && !r.passed);

  const status = failedInvariants.length > 0
    ? STATUS.BREACH
    : failedQuality.length > 0
      ? STATUS.DEGRADED
      : STATUS.HEALTHY;

  return {
    status,
    score: results.length === 0 ? null : Number(
      (results.filter((r) => r.passed).length / results.length).toFixed(3),
    ),
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    failedInvariants: failedInvariants.map((r) => r.id),
    failedQuality: failedQuality.map((r) => r.id),
    // The sentence a person should read first.
    headline: failedInvariants.length > 0
      ? `${failedInvariants.length} compliance invariant${failedInvariants.length === 1 ? '' : 's'} broken — content reached the outside without the approval this system promises.`
      : failedQuality.length > 0
        ? `Gates intact. ${failedQuality.length} governance check${failedQuality.length === 1 ? '' : 's'} degraded.`
        : 'Every check passing.',
  };
}
