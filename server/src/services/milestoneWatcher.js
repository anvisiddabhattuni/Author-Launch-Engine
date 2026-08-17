import { ACTOR, draftPressKit } from '../agents/prMaterialsAgent.js';
import { config } from '../config.js';
import { recordAction } from './auditLog.js';
import { findApproachingMilestones } from './milestones.js';

/**
 * The trigger STORY-004 asks for: "Given a book anniversary is approaching."
 *
 * STORY-003 could already draft a press kit, but only when a human noticed a
 * date and asked for one. This watches the lead-time window instead, so an
 * approaching milestone produces its kit without being remembered.
 *
 * Drafting is the whole of it. Every material still lands in `pending_approval`
 * (or `escalated`), and distribution still refuses until a person has approved
 * each one — detection changes when drafting starts, never who decides.
 */
export async function draftApproachingKits({
  authorId,
  now = new Date(),
  leadTimeDays = config.milestoneLeadTimeDays,
  providerName = config.aiProvider,
  provider = null,
} = {}) {
  const approaching = await findApproachingMilestones({ authorId, now, leadTimeDays });

  const drafted = [];
  const alreadyDrafted = [];
  const failed = [];

  for (const milestone of approaching) {
    if (milestone.kit_id) {
      alreadyDrafted.push(milestone);
      continue;
    }

    // Recorded before drafting, and outside the drafting transaction, so the
    // detection survives a provider failure. A watcher that silently noticed
    // nothing is indistinguishable from one that never ran.
    await recordAction({
      actor: ACTOR,
      action: 'milestone.approaching',
      entityType: 'milestone',
      entityId: milestone.id,
      authorId,
      metadata: {
        milestone: milestone.title,
        milestoneType: milestone.type,
        eventDate: milestone.event_date,
        daysUntil: milestone.days_until,
        leadTimeDays,
        anniversaryYears: milestone.anniversaryYears,
      },
    });

    try {
      const result = await draftPressKit({
        milestoneId: milestone.id,
        providerName,
        ...(provider ? { provider } : {}),
      });
      drafted.push({ ...result, milestone: { ...milestone, ...result.milestone } });
    } catch (error) {
      await recordAction({
        actor: ACTOR,
        action: 'pr_kit.draft_failed',
        entityType: 'milestone',
        entityId: milestone.id,
        authorId,
        metadata: { milestone: milestone.title, reason: error.message },
      });
      failed.push({ milestone, reason: error.message });
    }
  }

  await recordAction({
    actor: ACTOR,
    action: 'milestone.scan_completed',
    entityType: 'author',
    entityId: authorId,
    authorId,
    metadata: {
      leadTimeDays,
      windowEndsOn: new Date(now.getTime() + leadTimeDays * 86400000).toISOString().slice(0, 10),
      approaching: approaching.length,
      drafted: drafted.length,
      alreadyDrafted: alreadyDrafted.length,
      failed: failed.length,
    },
  });

  return { approaching, drafted, alreadyDrafted, failed, leadTimeDays };
}
