import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { integrationHealth } from './apiIntegrationAgent.js';
import { findAwaitingApproval } from './approvalNotificationAgent.js';
import { verifyAuditLog } from './auditSecurityAgent.js';
import { detectAnomalies } from '../services/anomalies.js';
import { VERDICTS, compareFormats } from '../services/engagement.js';
import { runChecks, scoreOf } from '../services/governance.js';
import { DECIDABLE, assess, thresholds } from '../services/escalationPolicy.js';

/**
 * Trust and Monitoring Agent (STORY-008).
 *
 * An independent second opinion on work another agent produced. It reads what
 * was written, recomputes the escalation decision from the stored scores and the
 * policy in force, and escalates anything the producer let through.
 *
 * It exists because the producer used to be the only judge of its own output.
 * That is the same objection this project already raised to letting a model
 * score itself, one level up: an agent that both writes the material and decides
 * whether the material is good enough has no one checking the second half. A
 * broken threshold, a missing check or a policy that has since been tightened
 * would all have gone unnoticed.
 *
 * It can raise a concern and never clear one. A monitor able to de-escalate is
 * a monitor that can be wrong in the direction that matters — the whole point is
 * that more things reach a human, never fewer.
 */
export const ACTOR = 'TrustMonitoringAgent';

/**
 * Re-derives the escalation decision for every press material still awaiting a
 * human, and acts on what it finds.
 *
 * Only decidable material is considered. Something already approved, rejected or
 * distributed has had its human moment; reopening it would be the monitor
 * overruling a person, which is not what it is for.
 */
export async function monitorPressMaterials({ authorId }) {
  return withTransaction(async (client) => {
    const limits = thresholds();

    const { rows: materials } = await client.query(
      `SELECT p.* FROM pr_materials p
         JOIN pr_kits k ON k.id = p.kit_id
        WHERE p.author_id = $1
          AND p.status = ANY($2)
          AND k.status <> 'superseded'
        ORDER BY p.id`,
      [authorId, DECIDABLE],
    );

    const raised = [];
    const confirmed = [];
    const producerStricter = [];

    for (const material of materials) {
      const verdict = assess({
        confidence: material.confidence,
        themeAlignment: material.theme_alignment,
      });

      const agreed = verdict.status === material.status;

      // The finding this agent exists for: the producer queued it for ordinary
      // approval and the policy says it should have gone to a human as a
      // concern. Escalating is not "changing a decision" — it is applying the
      // decision that should already have been applied.
      if (verdict.status === 'escalated' && material.status !== 'escalated') {
        const { rows: updated } = await client.query(
          `UPDATE pr_materials SET status = 'escalated', updated_at = now()
            WHERE id = $1 RETURNING *`,
          [material.id],
        );

        const escalation = await record(
          { material, verdict, limits, detectedBy: 'monitor', agreed: false, client },
        );

        await recordAction(
          {
            actor: ACTOR,
            action: 'escalation.raised',
            entityType: 'pr_material',
            entityId: material.id,
            authorId,
            before: material,
            after: updated[0],
            metadata: {
              escalationId: Number(escalation.id),
              materialType: material.type,
              reasons: verdict.reasons,
              confidence: Number(material.confidence),
              themeAlignment: Number(material.theme_alignment),
              thresholds: limits,
              producerStatus: material.status,
              // The part worth reading: an independent check disagreed with the
              // agent that produced the work.
              note: 'The drafting agent queued this for ordinary approval; policy says it needed a closer look.',
            },
          },
          client,
        );

        raised.push({ ...updated[0], escalationId: Number(escalation.id) });
        continue;
      }

      // Producer escalated and the policy agrees. Recorded once so the queue is
      // complete — a reviewer should see every escalation, not only the
      // surprising ones.
      if (material.status === 'escalated' && verdict.status === 'escalated') {
        const escalation = await record(
          { material, verdict, limits, detectedBy: 'producer', agreed: true, client },
        );
        if (escalation.inserted) confirmed.push(material);
        continue;
      }

      // Producer escalated something the current policy would not. Logged and
      // left exactly as it is: this agent does not clear concerns.
      if (material.status === 'escalated' && verdict.status !== 'escalated') {
        const escalation = await record(
          { material, verdict, limits, detectedBy: 'producer', agreed: false, client },
        );
        if (escalation.inserted) {
          await recordAction(
            {
              actor: ACTOR,
              action: 'escalation.producer_stricter',
              entityType: 'pr_material',
              entityId: material.id,
              authorId,
              metadata: {
                escalationId: Number(escalation.id),
                reasons: verdict.reasons,
                thresholds: limits,
                note:
                  'The drafting agent escalated this and the current policy would not. ' +
                  'Left escalated: this agent raises concerns and never clears them.',
              },
            },
            client,
          );
        }
        producerStricter.push(material);
        continue;
      }

      // Agreed it was fine. Nothing to record — a queue of things that are
      // fine is not a queue anybody reads.
      void agreed;
    }

    await recordAction(
      {
        actor: ACTOR,
        action: 'trust.scan_completed',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          examined: materials.length,
          raised: raised.length,
          confirmed: confirmed.length,
          producerStricter: producerStricter.length,
          thresholds: limits,
        },
      },
      client,
    );

    return { examined: materials.length, raised, confirmed, producerStricter };
  });
}

/** One escalation row per material, whoever noticed first. */
async function record({ material, verdict, limits, detectedBy, agreed, client }) {
  const { rows } = await client.query(
    `INSERT INTO escalations
       (author_id, pr_material_id, reasons, confidence, theme_alignment,
        threshold_confidence, threshold_theme_alignment,
        detected_by, producer_status, monitor_status, agreed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (pr_material_id) DO NOTHING
     RETURNING *`,
    [
      material.author_id,
      material.id,
      verdict.reasons,
      material.confidence,
      material.theme_alignment,
      limits.confidence,
      limits.themeAlignment,
      detectedBy,
      material.status,
      verdict.status,
      agreed,
    ],
  );

  if (rows[0]) return { ...rows[0], inserted: true };

  const { rows: existing } = await client.query(
    'SELECT * FROM escalations WHERE pr_material_id = $1',
    [material.id],
  );
  return { ...existing[0], inserted: false };
}

/**
 * The read-model: what has been escalated, why, and whether it is still open.
 *
 * "Open" is read from the material's current status rather than stored on the
 * escalation, so a human approving something cannot leave a stale queue behind.
 */
export async function listEscalations({ authorId, openOnly = false }) {
  const { rows } = await withTransaction(async (client) =>
    client.query(
      // LEFT JOIN: a dashboard that silently omits every on-demand kit's
      // escalations is worse than no dashboard, because it reads as "nothing
      // is wrong" (STORY-018).
      `SELECT e.*,
              p.type, p.headline, p.status AS material_status, p.kit_id,
              COALESCE(m.title, 'PR materials requested directly') AS milestone_title,
              (p.status = ANY($2)) AS open
         FROM escalations e
         JOIN pr_materials p ON p.id = e.pr_material_id
         JOIN pr_kits k      ON k.id = p.kit_id
         LEFT JOIN milestones m ON m.id = k.milestone_id
        WHERE e.author_id = $1
        ORDER BY e.id DESC`,
      [authorId, DECIDABLE],
    ),
  );

  const all = rows.map((r) => ({ ...r, open: Boolean(r.open) }));
  return openOnly ? all.filter((r) => r.open) : all;
}

/**
 * Proposes a change to the meme/text mix — as a proposal, and nothing else
 * (STORY-069).
 *
 * The story's third clause is that a recommendation "never silently changes what
 * gets published". That is enforced structurally rather than by intention: this
 * writes a row with `status = 'pending_approval'`, and the drafting agent reads
 * `authors.memes_per_batch`, which only an approval moves. An unapproved
 * recommendation is a suggestion sitting in a table that nothing consults.
 *
 * It only proposes where the comparison actually reached a verdict. On a
 * platform the data cannot separate, staying quiet is the correct output — a
 * recommendation drawn from an inconclusive comparison would launder noise into
 * an instruction, which is the failure this whole story exists to avoid.
 */
export async function recommendMix({ authorId, now = new Date() }) {
  const comparison = await compareFormats({ authorId });
  const { rows: authors } = await query('SELECT * FROM authors WHERE id = $1', [authorId]);
  const author = authors[0];
  if (!author) throw Object.assign(new Error('Author not found'), { status: 404 });

  const currentMemes = author.memes_per_batch ?? config.minMemesPerBatch;
  const proposed = [];
  const skipped = [];

  for (const platform of comparison.platforms) {
    const decisive =
      platform.verdict === VERDICTS.MEME || platform.verdict === VERDICTS.TEXT;

    if (!decisive) {
      skipped.push({ platform: platform.platform, verdict: platform.verdict, because: platform.because });
      continue;
    }

    const favours = platform.verdict === VERDICTS.MEME ? 'meme' : 'text';
    // One step at a time. A measured difference is evidence that the mix should
    // move, not evidence of how far — and a proposal a human can sanity-check in
    // one glance is likelier to get a real decision than a recalculated ratio.
    const suggested = favours === 'meme' ? currentMemes + 1 : Math.max(0, currentMemes - 1);

    if (suggested === currentMemes) {
      skipped.push({
        platform: platform.platform,
        verdict: platform.verdict,
        because: 'already at the floor for that direction',
      });
      continue;
    }

    const { rows } = await query(
      `INSERT INTO mix_recommendations
         (author_id, platform, favours, current_memes, suggested_memes, evidence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (author_id, platform) WHERE status = 'pending_approval'
       DO UPDATE SET favours = EXCLUDED.favours,
                     current_memes = EXCLUDED.current_memes,
                     suggested_memes = EXCLUDED.suggested_memes,
                     evidence = EXCLUDED.evidence,
                     updated_at = now()
       RETURNING *`,
      [
        authorId,
        platform.platform,
        favours,
        currentMemes,
        suggested,
        JSON.stringify({
          // Frozen at the moment it was made: a recommendation read next month
          // has to be answerable from itself rather than re-derived against data
          // that has since moved.
          meme: platform.meme,
          text: platform.text,
          lift: platform.lift,
          because: platform.because,
          minSample: comparison.minSample,
          maturityHours: comparison.maturityHours,
          measuredAt: now.toISOString(),
        }),
      ],
    );

    await recordAction({
      actor: ACTOR,
      action: 'mix.recommended',
      entityType: 'mix_recommendation',
      entityId: rows[0].id,
      authorId,
      after: rows[0],
      metadata: {
        platform: platform.platform,
        favours,
        from: currentMemes,
        to: suggested,
        lift: platform.lift,
        // Said plainly on the log: this is a proposal and nothing has changed.
        applied: false,
        requiresApproval: true,
      },
    });

    proposed.push(rows[0]);
  }

  await recordAction({
    actor: ACTOR,
    action: 'mix.scan_completed',
    entityType: 'author',
    entityId: authorId,
    authorId,
    metadata: {
      platforms: comparison.platforms.length,
      proposed: proposed.length,
      skipped: skipped.length,
      conclusive: comparison.conclusive,
      totalMeasured: comparison.totalMeasured,
    },
  });

  return { proposed, skipped, comparison };
}

/**
 * The trust dashboard (STORY-014).
 *
 * Everything it shows already existed and existed separately: escalations here,
 * dead letters there, audit integrity somewhere else, work waiting on a human on
 * a fourth screen. Each was observable and none of them were observable
 * together, which meant nobody could answer "is this system behaving" without
 * knowing where to look for four different answers.
 *
 * Assembled rather than computed. Every number here is produced by the module
 * that owns it — audit integrity by the Audit and Security Agent, the queue by
 * the Approval and Notification Agent — because a dashboard that recomputes what
 * it displays is a second implementation free to disagree with the first, and
 * the disagreement would be invisible.
 */
export async function trustDashboard({ authorId, now = new Date() } = {}) {
  // The expensive one first, and only once: verification walks every seal.
  const auditIntegrity = await verifyAuditLog({});

  const [checks, anomalies, queue, integrations] = await Promise.all([
    runChecks({ auditIntegrity }),
    detectAnomalies({ authorId }),
    authorId ? findAwaitingApproval({ authorId }) : Promise.resolve(null),
    // Every outbound call, by service (STORY-016). A provider degrading is
    // visible here before it is visible as failed work.
    integrationHealth({ sinceHours: 24, authorId }),
  ]);

  const governance = scoreOf(checks);

  const { rows: jobs } = await query(
    `SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`,
  );
  const { rows: lastRun } = await query(
    'SELECT MAX(finished_at) AS at FROM jobs WHERE status = $1',
    ['done'],
  );
  // Scoped to the tenant, or the leak this story found. `tenantParam` guards the
  // *address* of this route — /authors/1/... is refused to author 2 — and says
  // nothing about the rows the handler then goes and fetches. Asking for your
  // own dashboard returned the last twenty audit rows across every tenant.
  const { rows: recent } = await query(
    `SELECT actor, action, entity_type, entity_id, author_id, created_at
       FROM audit_log
      WHERE $1::bigint IS NULL OR author_id = $1 OR author_id IS NULL
      ORDER BY id DESC LIMIT 20`,
    [authorId ?? null],
  );

  const lastRunAt = lastRun[0].at ? new Date(lastRun[0].at) : null;
  const minutesSinceRun = lastRunAt ? Math.round((now - lastRunAt) / 60000) : null;

  const health = {
    jobs: Object.fromEntries(jobs.map((j) => [j.status, j.n])),
    lastWorkerRun: lastRunAt,
    minutesSinceRun,
    // A worker that has never run and a worker that stopped an hour ago look
    // identical in a status count, and are very different problems.
    workerSeen: lastRunAt !== null,
    auditIntegrity: auditIntegrity.status,
    sealedThrough: auditIntegrity.sealedThrough,
    integrations,
  };

  await recordAction({
    actor: ACTOR,
    action: 'governance.assessed',
    entityType: 'author',
    entityId: authorId ?? 'all',
    authorId: authorId ?? null,
    metadata: {
      status: governance.status,
      score: governance.score,
      passed: governance.passed,
      total: governance.total,
      failedInvariants: governance.failedInvariants,
      failedQuality: governance.failedQuality,
      anomaliesFound: anomalies.findings,
      // On the log so the score is a series rather than a snapshot — the audit
      // log is already the append-only store this would otherwise need.
      auditIntegrity: auditIntegrity.status,
    },
  });

  return { governance, checks, anomalies, health, queue, recent, assessedAt: now };
}
