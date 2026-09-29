import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { integrationHealth } from './apiIntegrationAgent.js';
import { findAwaitingApproval } from './approvalNotificationAgent.js';
import { verifyAuditLog } from './auditSecurityAgent.js';
import { detectAnomalies } from '../services/anomalies.js';
import { VERDICTS, compareFormats } from '../services/engagement.js';
import { runChecks, scoreOf } from '../services/governance.js';
import { systemStatus } from '../services/healthMonitoring.js';
import { send } from '../services/messageBus.js';
import { outboundInventory } from '../services/outboundPaths.js';
import { classifyRoutes, surfaceCoverage } from '../services/tenantSurface.js';
import {
  assessmentHistory,
  checkEpisodes,
  recordAssessment,
} from '../services/trustHistory.js';
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
 * The three kinds of thing a producer decides about (STORY-026).
 *
 * STORY-008 built this monitor on one objection: an agent that writes the
 * material and also decides whether the material is good enough has nobody
 * checking the second half. That objection was answered for press materials and
 * left standing for the other two — not by oversight in the logic but by an
 * absence in the schema, which had a `pr_material_id` column and no other.
 *
 * Written as data rather than three near-identical functions, because three
 * copies of a re-derivation rule is three chances for it to drift — the same
 * reason `escalationPolicy` exists at all.
 */
const MONITORED = [
  {
    kind: 'pr_material',
    table: 'pr_materials',
    column: 'pr_material_id',
    label: (row) => `${row.type} press material`,
    // Press kits that were superseded are history; STORY-005 already refuses
    // decisions on withdrawn copy, so re-judging it would spend a reviewer's
    // attention on something the system will not let them action.
    from: `pr_materials p JOIN pr_kits k ON k.id = p.kit_id`,
    where: `k.status <> 'superseded'`,
  },
  {
    kind: 'draft',
    table: 'drafts',
    column: 'draft_id',
    label: (row) => `${row.format === 'meme' ? 'meme' : 'post'} for ${row.platform}`,
    from: 'drafts p',
    where: 'TRUE',
  },
  {
    kind: 'outreach_message',
    table: 'outreach_messages',
    column: 'outreach_message_id',
    label: () => 'outreach message',
    from: 'outreach_messages p',
    where: 'TRUE',
  },
];

/**
 * Re-derives the escalation decision for every press material still awaiting a
 * human, and acts on what it finds.
 *
 * Only decidable material is considered. Something already approved, rejected or
 * distributed has had its human moment; reopening it would be the monitor
 * overruling a person, which is not what it is for.
 */
export async function monitorContent({ authorId, kinds = MONITORED.map((m) => m.kind) }) {
  return withTransaction(async (client) => {
    const limits = thresholds();

    const raised = [];
    const confirmed = [];
    const producerStricter = [];
    let examined = 0;
    const byKind = {};

    for (const spec of MONITORED.filter((m) => kinds.includes(m.kind))) {
      const { rows: materials } = await client.query(
        `SELECT p.* FROM ${spec.from}
          WHERE p.author_id = $1
            AND p.status = ANY($2)
            AND ${spec.where}
          ORDER BY p.id`,
        [authorId, DECIDABLE],
      );
      examined += materials.length;
      byKind[spec.kind] = { examined: materials.length, raised: 0 };

    for (const material of materials) {
      const verdict = assess({
        confidence: material.confidence,
        themeAlignment: material.theme_alignment,
        // The floor STORY-018 and STORY-023 added. The monitor was re-deriving
        // a decision from two of the three numbers the producer used, which
        // would have made it disagree with a correct producer on voice.
        voice: material.voice_score ?? null,
      });

      const agreed = verdict.status === material.status;

      // The finding this agent exists for: the producer queued it for ordinary
      // approval and the policy says it should have gone to a human as a
      // concern. Escalating is not "changing a decision" — it is applying the
      // decision that should already have been applied.
      if (verdict.status === 'escalated' && material.status !== 'escalated') {
        const { rows: updated } = await client.query(
          `UPDATE ${spec.table} SET status = 'escalated', updated_at = now()
            WHERE id = $1 RETURNING *`,
          [material.id],
        );

        const escalation = await record(
          { material, spec, verdict, limits, detectedBy: 'monitor', agreed: false, client },
        );

        await recordAction(
          {
            actor: ACTOR,
            action: 'escalation.raised',
            entityType: spec.kind,
            entityId: material.id,
            authorId,
            before: material,
            after: updated[0],
            metadata: {
              escalationId: Number(escalation.id),
              materialType: spec.label(material),
              contentKind: spec.kind,
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

        raised.push({ ...updated[0], kind: spec.kind, escalationId: Number(escalation.id) });
        byKind[spec.kind].raised += 1;
        continue;
      }

      // Producer escalated and the policy agrees. Recorded once so the queue is
      // complete — a reviewer should see every escalation, not only the
      // surprising ones.
      if (material.status === 'escalated' && verdict.status === 'escalated') {
        const escalation = await record(
          { material, spec, verdict, limits, detectedBy: 'producer', agreed: true, client },
        );
        if (escalation.inserted) confirmed.push(material);
        continue;
      }

      // Producer escalated something the current policy would not. Logged and
      // left exactly as it is: this agent does not clear concerns.
      if (material.status === 'escalated' && verdict.status !== 'escalated') {
        const escalation = await record(
          { material, spec, verdict, limits, detectedBy: 'producer', agreed: false, client },
        );
        if (escalation.inserted) {
          await recordAction(
            {
              actor: ACTOR,
              action: 'escalation.producer_stricter',
              entityType: spec.kind,
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
    }

    // Clause two of the story: an anomaly detected in generated content is
    // *escalated*, not merely displayed. Every anomaly detector before this one
    // reported to a dashboard and moved nothing — which is the STORY-018 shape
    // again, a number shown and not acted on (STORY-026).
    //
    // Run after the per-item re-derivation because it asks a different kind of
    // question. Every other check scores one draft on its own; a duplicate is
    // only visible between two, so no amount of per-item scoring can find it.
    // Deliberately the pool, not the transaction client. `detectAnomalies` runs
    // its detectors with Promise.all, which is correct on a pool — each gets
    // its own connection — and wrong on a single client, where concurrent
    // queries on one connection are a pg deprecation warning today and an error
    // in pg@9. The detectors only read already-committed rows, so reading
    // outside this transaction costs nothing.
    const anomalies = await detectAnomalies({ authorId });
    const duplicates = anomalies.detectors.find((d) => d.id === 'content.near_duplicate');
    const spec = MONITORED.find((m) => m.kind === 'draft');

    for (const finding of duplicates?.findings ?? []) {
      // Escalate every member except the first. The first is not more correct
      // than the others — it is simply the one a reviewer can keep — and
      // escalating all of them would put a whole group in front of a human for
      // one decision. A group of three leaves two escalated, which is the
      // number of drafts that actually need removing.
      for (const laterId of finding.draftIds.slice(1)) {
      const { rows: draftRows } = await client.query(
        `SELECT * FROM drafts WHERE id = $1 AND status = ANY($2)`,
        [laterId, DECIDABLE],
      );
      const draft = draftRows[0];
      if (!draft) continue;

      const { rows: updated } = await client.query(
        `UPDATE drafts SET status = 'escalated', updated_at = now()
          WHERE id = $1 RETURNING *`,
        [laterId],
      );

      const escalation = await record({
        material: draft,
        spec,
        verdict: { status: 'escalated', reasons: ['near_duplicate'] },
        limits,
        detectedBy: 'monitor',
        agreed: false,
        client,
      });

      await recordAction(
        {
          actor: ACTOR,
          action: 'escalation.raised',
          entityType: 'draft',
          entityId: laterId,
          authorId,
          before: draft,
          after: updated[0],
          metadata: {
            escalationId: escalation.id ? Number(escalation.id) : null,
            contentKind: 'draft',
            reasons: ['near_duplicate'],
            keptInstead: finding.draftIds[0],
            groupSize: finding.draftIds.length,
            overlap: finding.overlap,
            note: finding.detail,
          },
        },
        client,
      );

      raised.push({ ...updated[0], kind: 'draft', reason: 'near_duplicate' });
      byKind.draft = byKind.draft ?? { examined: 0, raised: 0 };
      byKind.draft.raised += 1;
      }
    }

    await recordAction(
      {
        actor: ACTOR,
        action: 'trust.scan_completed',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          examined,
          raised: raised.length,
          confirmed: confirmed.length,
          producerStricter: producerStricter.length,
          // Per kind, because "examined 33" hides which third of the system was
          // actually looked at — the thing that went unnoticed for eighteen
          // stories (STORY-026).
          byKind,
          // Content anomalies are a different kind of finding from a
          // re-derived threshold decision, and collapsing them would hide
          // which one moved something.
          duplicatesEscalated: (duplicates?.findings ?? []).length,
          thresholds: limits,
        },
      },
      client,
    );

    return { examined, byKind, raised, confirmed, producerStricter };
  });
}

/**
 * The press-only name STORY-008 introduced, kept as an alias.
 *
 * Every caller of it meant "re-check what is waiting"; none of them meant
 * "re-check only press". Now that the monitor covers all three content types,
 * the old name would be a lie about scope, so it forwards rather than narrows.
 */
export const monitorPressMaterials = ({ authorId }) => monitorContent({ authorId });

/** One escalation row per item, whoever noticed first, whatever kind it is. */
async function record({ material, spec, verdict, limits, detectedBy, agreed, client }) {
  const { rows } = await client.query(
    `INSERT INTO escalations
       (author_id, ${spec.column}, reasons, confidence, theme_alignment, voice_score,
        threshold_confidence, threshold_theme_alignment, threshold_voice,
        detected_by, producer_status, monitor_status, agreed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      material.author_id,
      material.id,
      verdict.reasons,
      material.confidence,
      material.theme_alignment,
      // Voice became a floor for press in STORY-018 and outreach in STORY-023,
      // and nothing recorded what the floor had been at the time.
      material.voice_score ?? null,
      limits.confidence,
      limits.themeAlignment,
      limits.voice,
      detectedBy,
      material.status,
      verdict.status,
      agreed,
    ],
  );

  if (rows[0]) {
    // Tell the notifier now, in this transaction (STORY-039). Before, the
    // reviewer heard at the next `trust.monitor_escalations` sweep — up to
    // five minutes later — and nothing recorded that one agent told another.
    await send(
      {
        from: ACTOR,
        to: 'ApprovalNotificationAgent',
        topic: 'escalation.raised',
        authorId: material.author_id,
        payload: {
          authorId: Number(material.author_id),
          escalationId: Number(rows[0].id),
          kind: spec.kind ?? spec.column,
          reasons: verdict.reasons,
        },
      },
      client,
    );
    return { ...rows[0], inserted: true };
  }

  const { rows: existing } = await client.query(
    `SELECT * FROM escalations WHERE ${spec.column} = $1`,
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
      // All three content types (STORY-026). This was an inner join on
      // pr_materials, which was correct while escalations could only be about
      // press — and silently dropped every draft and outreach escalation the
      // moment the monitor could raise one. The same failure widening a
      // required column caused in STORY-018, caught here by the demo rather
      // than by a user.
      `SELECT e.*,
              t.target_type, t.target_id,
              COALESCE(p.type, d.format, 'outreach') AS type,
              COALESCE(p.headline, LEFT(d.content, 80), o.subject) AS headline,
              COALESCE(p.status, d.status, o.status) AS material_status,
              p.kit_id,
              COALESCE(m.title, CASE WHEN e.pr_material_id IS NOT NULL
                                     THEN 'PR materials requested directly' END) AS milestone_title,
              (COALESCE(p.status, d.status, o.status) = ANY($2)) AS open
         FROM escalations e
         JOIN escalation_targets t ON t.id = e.id
         LEFT JOIN pr_materials p      ON p.id = e.pr_material_id
         LEFT JOIN pr_kits k           ON k.id = p.kit_id
         LEFT JOIN milestones m        ON m.id = k.milestone_id
         LEFT JOIN drafts d            ON d.id = e.draft_id
         LEFT JOIN outreach_messages o ON o.id = e.outreach_message_id
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

  const [checks, anomalies, queue, integrations, system] = await Promise.all([
    runChecks({ auditIntegrity }),
    detectAnomalies({ authorId }),
    authorId ? findAwaitingApproval({ authorId }) : Promise.resolve(null),
    // Every outbound call, by service (STORY-016). A provider degrading is
    // visible here before it is visible as failed work.
    integrationHealth({ sinceHours: 24, authorId }),
    systemStatus({}),
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
    // Whether the processes are up, from the checks that measured them
    // (STORY-027). Until now this panel said "worker last ran 4 min ago" and
    // could say nothing about the API a reader was looking at it through.
    system,
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
      auditIntegrity: auditIntegrity.status,
    },
  });

  // Stored, not only logged (STORY-021). The comment that used to sit here said
  // the audit log already made the score a series, and that was true and not
  // enough: answering "which checks changed state" from an append-only table of
  // JSON blobs means parsing the whole thing on every page load. A read-model is
  // the right shape for a question asked that often.
  //
  // Recording also *detects* — a check that moved passing→failing opens an
  // episode here, which is what lets the page say how long something has been
  // broken instead of only that it is.
  const changes = await recordAssessment({ authorId: authorId ?? null, governance, checks, anomalies });
  const episodes = await checkEpisodes({ authorId: authorId ?? null });
  const history = await assessmentHistory({ authorId: authorId ?? null, limit: 30 });
  const openByCheck = new Map(
    episodes.filter((e) => e.recovered_at === null).map((e) => [e.check_id, e]),
  );

  // Every way out of the system, gated and exempt alike (STORY-020). Listed
  // rather than summarised: an exemption a reviewer cannot see is
  // indistinguishable from a gate nobody built.
  return {
    governance,
    // Each failing check now carries how long it has been failing. "Failing"
    // and "failing since Tuesday" are different findings, and only the second
    // one tells an operator whether anybody noticed.
    checks: checks.map((c) => {
      const episode = openByCheck.get(c.id);
      return episode
        ? { ...c, failingSince: episode.started_at, alertedAt: episode.alerted_at }
        : c;
    }),
    anomalies,
    health,
    queue,
    recent,
    outbound: outboundInventory(),
    // Which readable routes are walked for cross-tenant leaks, and which are
    // deliberately not (STORY-024). The count is the part that regressed
    // silently before — 10 of 35, for six stories — so it belongs on the page
    // rather than only inside a passing check.
    surface: { ...surfaceCoverage(), declared: classifyRoutes().declared },
    // The 'analyse' half of REQ-007: a score with nothing to compare it to is a
    // number, not a metric.
    history,
    episodes,
    changed: { started: changes.started, recovered: changes.recovered },
    assessedAt: now,
  };
}
