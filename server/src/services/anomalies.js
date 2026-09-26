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
async function fastDecisions(client, authorId) {
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
      WHERE $2::bigint IS NULL
         OR COALESCE(d.author_id, m.author_id, p.author_id) = $2
      GROUP BY a.reviewer`,
    [config.fastApprovalSeconds, authorId ?? null],
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
async function neverRejects(client, authorId) {
  const { rows } = await client.query(
    `SELECT a.reviewer,
            COUNT(*)::int AS decisions,
            COUNT(*) FILTER (WHERE a.decision = 'rejected')::int AS rejections
       FROM approvals a
       LEFT JOIN drafts d            ON d.id = a.draft_id
       LEFT JOIN outreach_messages m ON m.id = a.outreach_message_id
       LEFT JOIN pr_materials p      ON p.id = a.pr_material_id
      WHERE $1::bigint IS NULL
         OR COALESCE(d.author_id, m.author_id, p.author_id) = $1
      GROUP BY a.reviewer`,
    [authorId ?? null],
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
async function producerDisagreement(client, authorId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE agreed = FALSE)::int AS disagreed
       FROM escalations
      WHERE $1::bigint IS NULL OR author_id = $1`,
    [authorId ?? null],
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
/**
 * Two drafts that say nearly the same thing (STORY-026).
 *
 * Every other detector here watches *reviewer* behaviour — who approves in
 * seconds, who never rejects, where the monitor disagrees with a producer. None
 * of them looks at the content, and REQ-006's second clause for this story is
 * explicitly about content: "an anomaly is detected in generated content; when
 * it deviates from typical patterns; then it is escalated for human review."
 *
 * Near-duplicate output is the content anomaly worth detecting without a model.
 * A generator repeating itself is a real failure — the author's feed carrying
 * the same sentence twice in a week is exactly what a person would catch and a
 * per-draft score cannot, because every individual draft is fine. It is only
 * anomalous *relative to its neighbours*, which is what "deviates from typical
 * patterns" means and why no amount of scoring one draft at a time finds it.
 *
 * Deliberately not machine learning, for the reason STORY-021 gave about the
 * same build-note suggestion: no training data at this size, and a score a
 * reviewer cannot audit is worse than none. Jaccard overlap on distinctive
 * words is crude and legible — "these two share 82% of their words" is a claim
 * somebody can check by reading them.
 */
async function nearDuplicateContent(client, authorId) {
  const { rows } = await client.query(
    `SELECT id, platform, content, status, week_of FROM drafts
      WHERE ($1::bigint IS NULL OR author_id = $1)
        AND status = ANY($2)
      ORDER BY id`,
    [authorId, ['pending_approval', 'escalated', 'approved']],
  );

  // Words of four letters or more, **and any run of digits**.
  //
  // Dropping digits is what made "simulated post 0" and "simulated post 39"
  // identical: both reduced to {simulated, post}, and the only thing that
  // distinguished them was the part being discarded. Keeping numbers as tokens
  // separates them at 50% overlap without needing a length floor that would
  // exclude genuinely short social posts — which are short by nature, and where
  // real repetition matters most.
  const words = (text) =>
    new Set(String(text).toLowerCase().match(/[a-z][a-z'-]{3,}|\d+/g) ?? []);

  // A duplicate claim needs enough words to be a claim at all.
  //
  // The first version of this had no floor and reported 40 findings on the
  // demo's "simulated post 0" … "simulated post 39" fixtures: the tokenizer
  // drops digits, so every one of them reduces to {simulated, post} and matches
  // every other at 100%. Two words agreeing is not evidence of anything, and
  // those 40 false positives buried the 10 genuine repetitions underneath them.
  //
  // Same rule every other detector in this file already follows — state the
  // minimum, and decline to conclude below it.
  // Four, not eight. A social post is short on purpose; the earlier floor of
  // eight excluded 47 of 62 drafts and lost real repetitions along with the
  // false ones. Four distinctive tokens is the point below which "they share
  // all their words" stops being evidence.
  const MIN_WORDS = 4;
  const substantial = rows.filter((r) => words(r.content).size >= MIN_WORDS);
  const tooShort = rows.length - substantial.length;

  // Grouped, not pairwise. Twelve identical drafts are 66 pairs and one
  // finding, and a reviewer handed 66 rows will read none of them. The first
  // version of this reported pairs and the demo printed a wall of them, which
  // is how a detector that is right becomes a detector nobody uses.
  const groups = [];
  const placed = new Set();

  for (let i = 0; i < substantial.length; i += 1) {
    if (placed.has(substantial[i].id)) continue;
    const a = words(substantial[i].content);

    const members = [substantial[i]];
    let lowest = 1;
    for (let j = i + 1; j < substantial.length; j += 1) {
      if (placed.has(substantial[j].id)) continue;
      const b = words(substantial[j].content);
      const overlap = [...a].filter((w) => b.has(w)).length / new Set([...a, ...b]).size;
      if (overlap >= config.nearDuplicateOverlap) {
        members.push(substantial[j]);
        lowest = Math.min(lowest, overlap);
      }
    }
    if (members.length < 2) continue;

    for (const m of members) placed.add(m.id);
    groups.push({
      draftIds: members.map((m) => Number(m.id)),
      platforms: [...new Set(members.map((m) => m.platform))],
      weeks: [...new Set(members.map((m) => String(m.week_of).slice(0, 10)))],
      overlap: Number(lowest.toFixed(2)),
      excerpt: String(members[0].content).replace(/\s+/g, ' ').slice(0, 70),
      detail:
        `${members.length} drafts say the same thing (${Math.round(lowest * 100)}% overlap): ` +
        `${members.map((m) => m.id).join(', ')}`,
    });
  }

  const findings = groups;

  return {
    id: 'content.near_duplicate',
    label: 'Two drafts that say nearly the same thing',
    confidence:
      findings.length > 0
        ? CONFIDENCE.REPORTED
        // A duplicate needs a pair, and a pair of substantial drafts. Saying
        // "clear" below that would be the detector claiming a result it cannot
        // have.
        : substantial.length < 2
          ? CONFIDENCE.INSUFFICIENT
          : CONFIDENCE.CLEAR,
    findings,
    sample: {
      drafts: rows.length,
      compared: substantial.length,
      tooShort,
      duplicated: findings.reduce((n, g) => n + g.draftIds.length, 0),
    },
    because:
      substantial.length < 2
        ? `only ${substantial.length} draft(s) long enough to compare — a duplicate needs a pair`
        : `compared ${substantial.length} drafts of at least ${MIN_WORDS} distinctive words at a ` +
          `${Math.round(config.nearDuplicateOverlap * 100)}% overlap threshold` +
          (tooShort > 0 ? `; ${tooShort} too short to judge and not compared` : ''),
  };
}

export async function detectAnomalies({ authorId = null } = {}, client = pool) {
  // `authorId` null means an operator asking across every tenant. Passing it
  // through rather than filtering afterwards matters: a reviewer's decision
  // counts have to be computed within a tenant, or a shared reviewer's pattern
  // in one author's queue leaks into another's dashboard as a number.
  const detectors = await Promise.all([
    fastDecisions(client, authorId),
    neverRejects(client, authorId),
    nearDuplicateContent(client, authorId),
    producerDisagreement(client, authorId),
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
