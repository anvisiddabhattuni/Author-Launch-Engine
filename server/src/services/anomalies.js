/**
 * Patterns worth a second look (STORY-014).
 *
 * Separate from the governance checks on purpose. A check asks whether something
 * that must be true is true; an anomaly asks whether something looks unusual,
 * and that is a much weaker claim on much less data.
 *
 * This is the part of a trust dashboard most likely to invent findings. A
 * "spike" over four data points is noise, and a dashboard that reports one will
 * be believed. So every detector here states the sample it had and declines
 * rather than guessing — the STORY-069 rule, applied to a different set of small
 * numbers. "Not enough history to say" is a finding, and it is reported as one
 * rather than being rounded down to a silent pass.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export const CONFIDENCE = {
  /** Enough evidence for the pattern to mean something. */
  REPORTED: 'reported',
  /** The pattern exists but there is too little to call it a pattern. */
  INSUFFICIENT: 'insufficient_evidence',
  /** Looked, found nothing. */
  CLEAR: 'clear',
};

/**
 * Decisions made so fast they cannot have been reviews.
 *
 * A signal, never a verdict: some decisions are genuinely obvious, and a
 * reviewer clearing an obviously-good draft in three seconds is doing their job.
 * What it is useful for is the shape — a reviewer whose decisions are *all* that
 * fast is a different thing from one whose decisions sometimes are.
 */
async function fastDecisions(client) {
  const { rows } = await client.query(
    `SELECT a.reviewer,
            COUNT(*)::int AS decisions,
            COUNT(*) FILTER (
              WHERE a.created_at - COALESCE(d.created_at, m.created_at, p.created_at)
                    < make_interval(secs => $1)
            )::int AS fast
       FROM approvals a
       LEFT JOIN drafts d            ON d.id = a.draft_id
       LEFT JOIN outreach_messages m ON m.id = a.outreach_message_id
       LEFT JOIN pr_materials p      ON p.id = a.pr_material_id
      GROUP BY a.reviewer`,
    [config.fastApprovalSeconds],
  );

  const enough = rows.filter((r) => r.decisions >= config.minDecisionsForPattern);
  const thin = rows.filter((r) => r.decisions < config.minDecisionsForPattern);

  const flagged = enough
    .filter((r) => r.fast === r.decisions)
    .map((r) => ({
      reviewer: r.reviewer,
      decisions: r.decisions,
      fast: r.fast,
      detail: `every one of ${r.decisions} decisions was made within ${config.fastApprovalSeconds}s of the item being created`,
    }));

  return {
    id: 'reviewer.rubber_stamping',
    label: 'A reviewer whose every decision was made in seconds',
    confidence:
      flagged.length > 0
        ? CONFIDENCE.REPORTED
        : enough.length === 0
          ? CONFIDENCE.INSUFFICIENT
          : CONFIDENCE.CLEAR,
    findings: flagged,
    sample: { reviewers: rows.length, withEnoughDecisions: enough.length },
    because:
      enough.length === 0
        ? `no reviewer has made ${config.minDecisionsForPattern} decisions yet — nothing here would mean anything`
        : `${enough.length} reviewer(s) have enough decisions to show a pattern` +
          (thin.length > 0 ? `; ${thin.length} do not and were not judged` : ''),
  };
}

/**
 * A reviewer who has never once said no.
 *
 * Not misconduct — a queue can genuinely be all good. It is worth surfacing
 * because an approval gate that has never rejected anything is indistinguishable
 * from no gate at all, and that is exactly the thing this dashboard exists to
 * notice about itself.
 */
async function neverRejects(client) {
  const { rows } = await client.query(
    `SELECT reviewer,
            COUNT(*)::int AS decisions,
            COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejections
       FROM approvals GROUP BY reviewer`,
  );

  const enough = rows.filter((r) => r.decisions >= config.minDecisionsForPattern);
  const flagged = enough
    .filter((r) => r.rejections === 0)
    .map((r) => ({
      reviewer: r.reviewer,
      decisions: r.decisions,
      rejections: 0,
      detail: `${r.decisions} decisions, none of them a rejection`,
    }));

  return {
    id: 'reviewer.never_rejects',
    label: 'A gate that has never turned anything away',
    confidence:
      flagged.length > 0
        ? CONFIDENCE.REPORTED
        : enough.length === 0
          ? CONFIDENCE.INSUFFICIENT
          : CONFIDENCE.CLEAR,
    findings: flagged,
    sample: { reviewers: rows.length, withEnoughDecisions: enough.length },
    because:
      enough.length === 0
        ? `no reviewer has made ${config.minDecisionsForPattern} decisions yet`
        : 'an approval gate that never rejects is hard to tell apart from no gate',
  };
}

/**
 * Work the producers and the independent monitor disagreed about.
 *
 * STORY-008 records when the monitor had to raise something a producer let
 * through. One is a difference of opinion; a run of them means a producer's own
 * check is drifting, and that is the thing worth catching early.
 */
async function producerDisagreement(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE agreed = FALSE)::int AS disagreed
       FROM escalations`,
  );
  const { total, disagreed } = rows[0];

  return {
    id: 'monitor.disagreement',
    label: 'The independent monitor catching what a producer let through',
    confidence:
      total < config.minDecisionsForPattern
        ? CONFIDENCE.INSUFFICIENT
        : disagreed > 0
          ? CONFIDENCE.REPORTED
          : CONFIDENCE.CLEAR,
    findings:
      total >= config.minDecisionsForPattern && disagreed > 0
        ? [{ disagreed, total, detail: `${disagreed} of ${total} escalations were raised by the monitor, not the producer` }]
        : [],
    sample: { escalations: total },
    because:
      total < config.minDecisionsForPattern
        ? `${total} escalation(s) on record — too few for a rate to mean anything`
        : 'a producer whose own check keeps missing things is drifting',
  };
}

/**
 * Everything, with the honest state of each.
 *
 * Returns detectors that found nothing and detectors that could not look, both
 * explicitly. A dashboard listing only its findings looks the same whether it
 * checked and found nothing or never checked at all.
 */
export async function detectAnomalies({} = {}, client = pool) {
  const detectors = await Promise.all([
    fastDecisions(client),
    neverRejects(client),
    producerDisagreement(client),
  ]);

  return {
    detectors,
    reported: detectors.filter((d) => d.confidence === CONFIDENCE.REPORTED),
    insufficient: detectors.filter((d) => d.confidence === CONFIDENCE.INSUFFICIENT),
    // The count a dashboard should lead with: things it actually found, not
    // things it looked for.
    findings: detectors.reduce((n, d) => n + d.findings.length, 0),
  };
}
