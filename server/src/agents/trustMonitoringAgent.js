import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
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
      `SELECT e.*,
              p.type, p.headline, p.status AS material_status, p.kit_id,
              m.title AS milestone_title,
              (p.status = ANY($2)) AS open
         FROM escalations e
         JOIN pr_materials p ON p.id = e.pr_material_id
         JOIN pr_kits k      ON k.id = p.kit_id
         JOIN milestones m   ON m.id = k.milestone_id
        WHERE e.author_id = $1
        ORDER BY e.id DESC`,
      [authorId, DECIDABLE],
    ),
  );

  const all = rows.map((r) => ({ ...r, open: Boolean(r.open) }));
  return openOnly ? all.filter((r) => r.open) : all;
}
