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
import { outboundInventory } from './outboundPaths.js';
import { surfaceCoverage } from './tenantSurface.js';
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
    id: 'tenant.isolation',
    severity: SEVERITY.INVARIANT,
    label: 'No tenant data has escaped its tenant',
    why: 'REQ-010. Isolation is a column here, so a leak is a row rather than a breach of a wall.',
    // Orphaned rows: owned by a tenant that no longer exists, so no tenant
    // filter will ever exclude them. Checked here as well as by the Tenant
    // Management Agent, because the dashboard should not have to be told.
    sql: `SELECT (
            (SELECT COUNT(*) FROM drafts d
              WHERE d.author_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = d.author_id))
          + (SELECT COUNT(*) FROM scheduled_posts sp
              JOIN drafts d2 ON d2.id = sp.draft_id
             WHERE sp.author_id IS DISTINCT FROM d2.author_id)
          )::int AS n`,
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
    id: 'tenant.surface_walked',
    severity: SEVERITY.INVARIANT,
    label: 'Every readable route is walked for cross-tenant leaks, or says why not',
    why: 'REQ-005 / STORY-024. STORY-017 walked 10 of 35 routes and nothing noticed the other 25.',
    // Code, not rows — the same reason gate.outbound_declared is not SQL. A
    // route that is row-addressed (`/thing/:id`) cannot be walked generically
    // and is not currently declared either; one appearing is the regression
    // this catches, because it is the shape that goes unwalked silently.
    evaluate: () => {
      const { needsId, unaccounted } = surfaceCoverage();
      return needsId + unaccounted;
    },
  },
  {
    id: 'gate.outbound_declared',
    severity: SEVERITY.INVARIANT,
    label: 'Every gated outbound path names an invariant that checks it',
    why: 'REQ-006 / STORY-020. A gate nobody verifies is the state REQ-006 was in before STORY-013.',
    // Not SQL: the question is about code, not rows, and the three data-level
    // gate checks are precisely what cannot see it. A gated path that names no
    // invariant is a promise with nothing behind it.
    evaluate: () => outboundInventory().unverified.length,
  },
  {
    id: 'posts.failures_announced',
    severity: SEVERITY.QUALITY,
    label: 'Every post that failed to publish was announced to somebody',
    why: 'REQ-006 / STORY-025. A failure the system knows about and the author does not is the worst shape.',
    // Only counts failures for authors who have a reviewer to tell. One with
    // none is a different finding, recorded as publish.failure_unreachable, and
    // rolling the two together would let a missing reviewer hide a missing
    // notification.
    sql: `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
           WHERE sp.status = 'failed'
             AND EXISTS (SELECT 1 FROM reviewers r WHERE r.author_id = sp.author_id AND r.active)
             AND NOT EXISTS (
               SELECT 1 FROM notifications n WHERE n.scheduled_post_id = sp.id)`,
  },
  {
    id: 'audit.states_recorded',
    severity: SEVERITY.QUALITY,
    label: 'Every recorded state change carries the states it changed',
    why: 'STORY-019 / REQ-005. "Before-after states" is the clause; two actions were logging neither.',
    // Deliberately narrow. Most rows with no before/after are correct: a
    // creation has no prior state, and a scan or a retrieval has no state at
    // all. Demanding states from those would be demanding fiction — the same
    // mistake as backfilling a voice score nothing measured. So this counts
    // only *transitions*: a stored row that moved from one status to another,
    // which by definition had one before.
    //
    // `rejected` is qualified by entity type rather than matched on the verb,
    // and the first version of this check was wrong for exactly that reason —
    // it counted 67 `meme_template.rejected` rows as violations. Those are gate
    // *refusals*: the generator reached for a template it may not use and was
    // told no. Nothing was stored and nothing moved, so there is no prior state
    // to record, and the check demanding one would have been the very mistake
    // the paragraph above warns about.
    //
    // The entity list is fixed in code, which is the standing limitation of
    // every check here: a new approvable thing gets no coverage until somebody
    // adds it. Named in the README's Known gaps rather than left implied.
    //
    // `message.sent` (STORY-039) is excluded for the same reason as the
    // template refusals: a message being sent is its *creation* — no row moved
    // from one status to another — and the first run after STORY-039 counted
    // every one as a transition missing its states. The verb list is a
    // heuristic, and each new use of a listed verb has to be read, not matched.
    sql: `SELECT COUNT(*)::int AS n FROM audit_log
           WHERE (
                   (action ~ '\\.(approved|suspended|restored|retired|distributed|published|sent|scheduled)$'
                    AND entity_type <> 'agent_message')
                OR (action ~ '\\.rejected$'
                    AND entity_type IN ('draft', 'outreach_message', 'pr_material', 'mix_recommendation'))
                 )
             AND (before IS NULL OR after IS NULL)`,
  },
  {
    id: 'press.voice_measured',
    severity: SEVERITY.QUALITY,
    label: 'Every press material carries a voice verdict',
    why: 'STORY-018 / REQ-011. A floor nothing was measured against is not a floor.',
    // Bounded by the watermark 023 recorded. Materials written before this
    // story have no verdict and will never get one — backfilling a score
    // nothing measured would be inventing the evidence the check exists to
    // find. Counting them would report a permanent failure nobody can fix,
    // which is how a red check becomes background noise.
    sql: `SELECT COUNT(*)::int AS n FROM pr_materials
           WHERE voice_score IS NULL
             AND id > COALESCE((SELECT material_id FROM pr_voice_watermark), 0)`,
  },
  {
    id: 'integrations.circuits_closed',
    severity: SEVERITY.QUALITY,
    label: 'Every external integration is answering',
    why: 'STORY-038 / REQ-009. An open circuit is a provider the gateway has stopped calling because it stopped answering.',
    sql: "SELECT COUNT(*)::int AS n FROM integration_circuits WHERE state <> 'closed'",
  },
  {
    id: 'audit.encrypted',
    severity: SEVERITY.INVARIANT,
    label: 'Every audit entry is encrypted with AES-256 under the current key, and opens',
    why:
      'STORY-049 / REQ-013. An entry under a key the application no longer holds is unreadable to it; one ' +
      'that does not open was edited after it was written. Counted by the storage itself, which the ' +
      'application cannot read directly.',
    sql: 'SELECT (other_keys + unopened)::int AS n FROM audit_encryption_status()',
  },
  {
    id: 'security_log.complete',
    severity: SEVERITY.INVARIANT,
    label: 'Every attempt on an audit log is in the security log',
    why:
      'STORY-051 / REQ-013. Each attempt is written to the data access log and the security log in one ' +
      'transaction; an access record on an audit route with no security entry means the watching stopped.',
    sql: `SELECT COUNT(*)::int AS n FROM data_access_events e
           WHERE e.audit_route AND NOT EXISTS (SELECT 1 FROM security_log s WHERE s.request_id = e.request_id)`,
  },
  {
    id: 'db.least_privilege',
    severity: SEVERITY.QUALITY,
    label: 'The application connects to the database with the least power it needs',
    why:
      'STORY-033 / REQ-008. As a superuser or table owner, the process that writes the audit log can ' +
      'switch off the triggers that keep it append-only.',
    // Asked on the application's own connection, which is the one that matters.
    sql: `SELECT (r.rolsuper OR EXISTS (SELECT 1 FROM pg_tables
                                         WHERE schemaname = 'public' AND tableowner = current_user))::int AS n
            FROM pg_roles r WHERE r.rolname = current_user`,
  },
  {
    id: 'engagement.tracked',
    severity: SEVERITY.QUALITY,
    label: 'Every published post that has matured has been measured',
    why: 'STORY-029 / REQ-007. A post nobody measured is a post the performance view is silently not about.',
    sql: `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
           WHERE sp.status = 'published'
             AND sp.published_at < now() - make_interval(hours => $1)
             AND NOT EXISTS (SELECT 1 FROM engagement e WHERE e.scheduled_post_id = sp.id)`,
    params: () => [config.engagementMaturityHours],
  },
  {
    id: 'system.no_open_outage',
    severity: SEVERITY.QUALITY,
    label: 'Every component is answering',
    why: 'STORY-027 / REQ-007. A row here is a component that stopped answering and has not come back.',
    // Quality, not invariant: an outage is a thing that happens, not a promise
    // broken. What would be a breach is an outage nobody was told about, and
    // `outage.unreachable` on the audit log is where that is found.
    sql: 'SELECT COUNT(*)::int AS n FROM outages WHERE resolved_at IS NULL',
  },
  {
    id: 'jobs.no_dead_letters',
    severity: SEVERITY.QUALITY,
    label: 'No scheduled work has been given up on',
    why: 'STORY-065. A dead letter is work that stopped and told nobody.',
    sql: "SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'dead_letter'",
  },
  {
    id: 'access.elevated_reviewed',
    severity: SEVERITY.INVARIANT,
    label: 'Every account with more than author access got it through a reviewed change',
    why:
      'STORY-042 / REQ-011. A role granted without a second admin\'s approval — or before this story, ' +
      'through onboarding in one request — is access nobody agreed to.',
    // An invariant: the review is the whole promise. Accounts the seed or a
    // migration created before anyone could approve are recorded as
    // 'bootstrap', which only the schema owner can write.
    sql: `SELECT COUNT(*)::int AS n FROM users u
           WHERE u.active AND u.role <> 'author'
             AND NOT EXISTS (
               SELECT 1 FROM access_changes c
                WHERE c.user_id = u.id AND c.kind = 'assign_role' AND c.new_role = u.role
                  AND (c.status = 'bootstrap' OR c.applied_at IS NOT NULL))`,
  },
  {
    id: 'tasks.priority_respected',
    severity: SEVERITY.QUALITY,
    label: 'No higher-priority task was kept waiting by a lower one, for no reason',
    why:
      'STORY-040 / REQ-010. Every dispatch records the higher-priority tasks it went ahead of and what ' +
      'blocked each. One with no blocker that then waited is the task manager choosing wrongly.',
    // Judged by consequence, not by snapshot — and the first version was wrong
    // for that reason. With several workers the queue is in motion: a task can
    // be mid-claim by another worker (SKIP LOCKED passes over it) at the
    // instant this one is chosen, and be running milliseconds later. The demo
    // flagged two such "inversions"; the higher task started 8ms after. What
    // would actually be wrong is a higher-priority task left *waiting*, so a
    // skipped, unblocked task counts only if it then waited more than 5s — or
    // was never picked up at all.
    sql: `SELECT COUNT(*)::int AS n
            FROM audit_log a
            CROSS JOIN LATERAL jsonb_array_elements(a.metadata->'higherPriorityWaiting') w
            LEFT JOIN jobs h ON h.id = (w->>'id')::bigint
           WHERE a.action = 'task.dispatched'
             AND a.metadata->>'chosenBy' = 'priority'
             AND w->'blockedBy' = 'null'::jsonb
             AND (h.id IS NULL OR h.claimed_at IS NULL OR h.claimed_at > a.created_at + interval '5 seconds')`,
  },
  {
    id: 'messages.no_dead_letters',
    severity: SEVERITY.QUALITY,
    label: 'No message between agents has been given up on',
    why: 'STORY-039 / REQ-010. A dead letter is one agent telling another something that never landed.',
    sql: "SELECT COUNT(*)::int AS n FROM agent_messages WHERE status = 'dead_letter'",
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
    // Most checks count violating rows. `evaluate` is for the ones whose
    // question is not about rows at all — STORY-020's outbound coverage asks
    // about code, which is exactly the blind spot the three SQL gate checks
    // share.
    const count = check.evaluate
      ? check.evaluate()
      : (await client.query(check.sql, check.params ? check.params() : [])).rows[0].n;
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
    // Names what actually broke.
    //
    // This used to say "content reached the outside without the approval this
    // system promises" for *any* failed invariant. That sentence is true of the
    // gate checks and false of every other one — with only `audit.integrity`
    // failing, the dashboard reported an escape that had not happened while the
    // real finding (the log was altered) went unnamed. A headline that is right
    // for the common case and wrong for the actual one is worse than a generic
    // one, because it sends the reader to check the wrong thing.
    headline: (() => {
      if (failedInvariants.length === 0) {
        return failedQuality.length > 0
          ? `Gates intact. ${failedQuality.length} governance check${failedQuality.length === 1 ? '' : 's'} degraded.`
          : 'Every check passing.';
      }
      // `failedInvariants` here is the array of check *objects*; the returned
      // field of the same name is their ids. Reading it as ids is what 500'd
      // the dashboard on the first attempt.
      const ids = failedInvariants.map((r) => r.id);
      const gates = ids.filter((id) => id.startsWith('gate.'));
      const others = ids.filter((id) => !id.startsWith('gate.'));
      const parts = [];
      if (gates.length > 0) {
        parts.push(
          `content reached the outside without the approval this system promises (${gates.join(', ')})`,
        );
      }
      if (others.length > 0) {
        parts.push(`${others.join(', ')} broken`);
      }
      return `${failedInvariants.length} invariant${failedInvariants.length === 1 ? '' : 's'} broken — ${parts.join('; ')}.`;
    })(),
  };
}
