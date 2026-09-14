import { withTransaction, pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';
import { SEVERITY } from './governance.js';

/**
 * The trust dashboard's memory (STORY-021).
 *
 * STORY-014 built a dashboard that answers "what is true now". REQ-007 asks
 * users to *monitor and analyse* trust metrics, and analysis needs a second
 * reading to compare the first one to. Every load recomputed a snapshot and
 * compared it to nothing, so two questions an operator actually asks were
 * unanswerable: **when did this start failing**, and **is it getting worse**.
 *
 * The third question was worse than unanswerable. Nothing ran the assessment
 * unless a human opened the page, so a broken invariant waited to be noticed.
 * A dashboard nobody is looking at reports nothing.
 *
 * So: store each assessment, and treat a check *changing state* as the event.
 * The episode — failing from here until there — is what carries "since when",
 * and it is written once at the transition rather than derived by scanning
 * adjacent assessments on every page load.
 */
export const ACTOR = 'TrustMonitoringAgent';

const scopeOf = (authorId) => (authorId === undefined ? null : authorId);

/**
 * Records one assessment and returns what changed since the last one.
 *
 * The comparison is against the previous *stored* assessment for the same
 * scope, not against whatever the caller happens to hold. Two callers
 * assessing concurrently would otherwise each compare to their own starting
 * point and both report the same transition.
 */
export async function recordAssessment({ authorId = null, governance, checks, anomalies }, client) {
  const run = async (tx) => {
    const scope = scopeOf(authorId);

    const { rows: stored } = await tx.query(
      `INSERT INTO trust_assessments
         (author_id, status, score, passed, total, failed_invariants, failed_quality,
          anomalies_found, checks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        scope,
        governance.status,
        governance.score,
        governance.passed,
        governance.total,
        // `scoreOf` returns the failing check *ids*, not counts — the columns
        // want how many. Reading these as numbers is what the first version did,
        // and Postgres refused the array outright rather than storing nonsense.
        governance.failedInvariants?.length ?? 0,
        governance.failedQuality?.length ?? 0,
        anomalies?.findings ?? 0,
        JSON.stringify(
          checks.map((c) => ({
            id: c.id,
            severity: c.severity,
            passed: c.passed,
            violations: c.violations ?? 0,
          })),
        ),
      ],
    );

    // Which checks are currently failing, and which already had an open
    // episode. The difference in each direction is a transition.
    const failing = checks.filter((c) => !c.passed);
    const failingIds = failing.map((c) => c.id);

    const { rows: open } = await tx.query(
      `SELECT * FROM trust_check_episodes
        WHERE COALESCE(author_id, -1) = COALESCE($1::bigint, -1)
          AND recovered_at IS NULL`,
      [scope],
    );
    const openIds = new Set(open.map((e) => e.check_id));

    const started = [];
    for (const check of failing) {
      if (openIds.has(check.id)) continue;
      const { rows } = await tx.query(
        `INSERT INTO trust_check_episodes
           (author_id, check_id, severity, label, violations)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [scope, check.id, check.severity, check.label ?? '', check.violations ?? 0],
      );
      // ON CONFLICT DO NOTHING returns no row when a concurrent sweep opened the
      // episode first. That is the correct outcome — one outage, one episode —
      // and not a transition this run gets to announce.
      if (rows[0]) {
        started.push(rows[0]);
        await recordAction(
          {
            actor: ACTOR,
            action: 'governance.check_failed',
            entityType: 'governance_check',
            entityId: check.id,
            authorId: scope,
            after: { check: check.id, violations: check.violations ?? 0 },
            metadata: {
              severity: check.severity,
              label: check.label,
              why: check.why,
              violations: check.violations ?? 0,
              // The point of the episode: this is the moment, not the moment
              // somebody happened to look.
              episodeId: Number(rows[0].id),
            },
          },
          tx,
        );
      }
    }

    const recovered = [];
    for (const episode of open) {
      if (failingIds.includes(episode.check_id)) continue;
      const { rows } = await tx.query(
        `UPDATE trust_check_episodes SET recovered_at = now()
          WHERE id = $1 AND recovered_at IS NULL RETURNING *`,
        [episode.id],
      );
      if (rows[0]) {
        recovered.push(rows[0]);
        await recordAction(
          {
            actor: ACTOR,
            action: 'governance.check_recovered',
            entityType: 'governance_check',
            entityId: episode.check_id,
            authorId: scope,
            before: { check: episode.check_id, failingSince: episode.started_at },
            after: { check: episode.check_id, recoveredAt: rows[0].recovered_at },
            metadata: {
              severity: episode.severity,
              // How long it was broken, which is the number that says whether
              // anybody was actually watching.
              openForSeconds: Math.round(
                (new Date(rows[0].recovered_at) - new Date(episode.started_at)) / 1000,
              ),
            },
          },
          tx,
        );
      }
    }

    return { assessment: stored[0], started, recovered, stillFailing: open.length - recovered.length };
  };

  return client ? run(client) : withTransaction(run);
}

/**
 * Tells someone an invariant just broke.
 *
 * Only invariants, and only on the transition. A quality check dipping is worth
 * seeing on the page and is not worth waking anyone for, and re-sending on
 * every sweep while a breach persists is how an alert channel gets filtered
 * into a folder nobody opens — the same reasoning that makes STORY-012 announce
 * each waiting item exactly once.
 */
export async function alertOnBreaches({ authorId = null, started, notifier = emailApi }) {
  const breaches = started.filter((e) => e.severity === SEVERITY.INVARIANT && !e.alerted_at);
  if (breaches.length === 0) return { alerted: [], reason: 'no new invariant breach' };

  const { rows: reviewers } = await pool.query(
    'SELECT * FROM reviewers WHERE author_id = $1 AND active ORDER BY id',
    [authorId],
  );

  if (reviewers.length === 0) {
    // Not silent. A breach nobody can be told about is its own finding, and the
    // same shape STORY-012 gave an unreachable approval queue.
    await recordAction({
      actor: ACTOR,
      action: 'governance.breach_unreachable',
      entityType: 'author',
      entityId: authorId ?? 'all',
      authorId,
      metadata: {
        checks: breaches.map((b) => b.check_id),
        reason: 'An invariant broke and no active reviewer is configured to be told.',
      },
    });
    return { alerted: [], reason: 'no active reviewer' };
  }

  const subject = `Trust breach: ${breaches.map((b) => b.check_id).join(', ')}`;
  const body = [
    'An invariant that is supposed to never fail has started failing.',
    '',
    ...breaches.map((b) => `  ${b.check_id} — ${b.label} (${b.violations} violation(s))`),
    '',
    'This is not a score dipping. An invariant is a thing the product promises',
    'cannot happen, so one failing outranks every other check on the dashboard.',
    '',
    'Open the Trust tab to see what it found: /trust',
  ].join('\n');

  const alerted = [];
  for (const reviewer of reviewers) {
    const sent = await notifier.send({
      to: reviewer.email,
      subject,
      body,
      authorId,
      // Written as a literal rather than a constant on purpose: STORY-020's
      // source scan greps for `via: '...'` at the call site, and a variable
      // here would hide the declaration from the check that exists to find it.
      // It refused this file until the literal was inlined.
      via: 'trust.alert_breach',
    });
    alerted.push({ reviewer: reviewer.email, externalId: sent.externalId });
  }

  await pool.query(
    'UPDATE trust_check_episodes SET alerted_at = now() WHERE id = ANY($1::bigint[])',
    [breaches.map((b) => b.id)],
  );

  await recordAction({
    actor: ACTOR,
    action: 'governance.breach_alerted',
    entityType: 'author',
    entityId: authorId ?? 'all',
    authorId,
    metadata: {
      checks: breaches.map((b) => b.check_id),
      reviewers: alerted.map((a) => a.reviewer),
    },
  });

  return { alerted, reason: null };
}

/** The score as a series, for the dashboard's chart and for "is this getting worse". */
export async function assessmentHistory({ authorId = null, limit = 30 } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM trust_assessments
      WHERE COALESCE(author_id, -1) = COALESCE($1::bigint, -1)
      ORDER BY assessed_at DESC, id DESC
      LIMIT $2`,
    [scopeOf(authorId), limit],
  );
  return rows;
}

/**
 * Open and recent episodes, so every failing check on the dashboard can say
 * how long it has been failing rather than only that it is.
 */
export async function checkEpisodes({ authorId = null, limit = 50 } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM trust_check_episodes
      WHERE COALESCE(author_id, -1) = COALESCE($1::bigint, -1)
      ORDER BY recovered_at IS NULL DESC, started_at DESC
      LIMIT $2`,
    [scopeOf(authorId), limit],
  );
  return rows;
}
