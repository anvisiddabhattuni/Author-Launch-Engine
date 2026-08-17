import { draftPressKit } from '../agents/prMaterialsAgent.js';
import { query, withTransaction } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { ACTOR, activeKitFor, AWARD_OUTCOMES, outcomeOf } from './awards.js';

/**
 * Records what happened at an award, and draws the consequence.
 *
 * This is STORY-005's command. A win is the trigger the story asks for: the
 * moment an outcome is recorded as `won`, the agent drafts — still into the
 * approval gate, so the win reaches a human before it reaches a newsroom.
 *
 * A loss draws no material at all, and is audited anyway. "We decided not to
 * announce" is a decision, and an empty log cannot tell that apart from a system
 * that failed to notice.
 */
export async function recordAwardOutcome({
  milestoneId,
  outcome,
  awardName = null,
  actor = 'author',
  notes = '',
}) {
  if (!AWARD_OUTCOMES.includes(outcome)) {
    throw Object.assign(
      new Error(
        `Unknown award outcome "${outcome}" — expected one of ${AWARD_OUTCOMES.join(', ')}`,
      ),
      { status: 400 },
    );
  }

  const { milestone, before, staleKit, alreadySettled, activeKit } = await withTransaction(
    async (client) => {
    const { rows } = await client.query('SELECT * FROM milestones WHERE id = $1 FOR UPDATE', [
      milestoneId,
    ]);
    const existing = rows[0];
    if (!existing) throw Object.assign(new Error('Milestone not found'), { status: 404 });
    if (existing.type !== 'award') {
      throw Object.assign(new Error(`Milestone ${milestoneId} is a ${existing.type}, not an award`), {
        status: 400,
      });
    }

    // Recording the same result twice is not a new fact. Return the current
    // state rather than appending a second identical line to the log.
    if (outcomeOf(existing) === outcome && !awardName) {
      const active = await activeKitFor(milestoneId, client);
      return {
        milestone: existing,
        before: existing,
        staleKit: null,
        alreadySettled: true,
        activeKit: active,
      };
    }

    const { rows: updated } = await client.query(
      `UPDATE milestones
          SET outcome = $2,
              award_name = coalesce($3, award_name)
        WHERE id = $1
        RETURNING *`,
      [milestoneId, outcome, awardName],
    );

    await recordAction(
      {
        actor,
        action: 'award.outcome_recorded',
        entityType: 'milestone',
        entityId: milestoneId,
        authorId: existing.author_id,
        before: existing,
        after: updated[0],
        metadata: {
          from: outcomeOf(existing),
          to: outcome,
          award: updated[0].award_name,
          notes,
        },
      },
      client,
    );

    // A kit drafted while the book was only shortlisted says exactly that. Once
    // it has won, that copy is the wrong announcement, so it is withdrawn rather
    // than sent — but kept, because it is what the agent proposed at the time.
    // Re-recording an already-won award must not withdraw the win kit itself.
    let stale = null;
    if (outcome === 'won' && outcomeOf(existing) !== 'won') {
      const active = await activeKitFor(milestoneId, client);
      if (active) {
        const { rows: superseded } = await client.query(
          `UPDATE pr_kits
              SET status = 'superseded', superseded_reason = $2, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [active.id, 'award was won; shortlist copy no longer states the news'],
        );
        stale = superseded[0];

        await recordAction(
          {
            actor: ACTOR,
            action: 'pr_kit.superseded',
            entityType: 'pr_kit',
            entityId: active.id,
            authorId: existing.author_id,
            before: active,
            after: stale,
            metadata: {
              reason: 'award outcome changed to won; the shortlist release understates it',
              milestone: existing.title,
            },
          },
          client,
        );
      }
    }

    return { milestone: updated[0], before: existing, staleKit: stale };
  });

  if (alreadySettled) {
    return {
      milestone,
      kit: activeKit,
      materials: [],
      supersededKit: null,
      drafted: false,
    };
  }

  if (outcome === 'not_won') {
    await recordAction({
      actor: ACTOR,
      action: 'award.no_material',
      entityType: 'milestone',
      entityId: milestoneId,
      authorId: milestone.author_id,
      metadata: {
        reason: 'the book did not win; a loss is not announced',
        milestone: milestone.title,
        award: milestone.award_name,
      },
    });
    return { milestone, kit: null, materials: [], supersededKit: staleKit, drafted: false };
  }

  // Drafting runs in its own transaction, after the one above committed. The
  // stale kit has to be superseded first — two kits cannot be in progress at
  // once — so if drafting then fails, nothing is in progress and a retry can
  // draft. Both halves are in the log either way.
  const alreadyInProgress = await activeKitFor(milestoneId);
  if (alreadyInProgress) {
    return {
      milestone,
      kit: alreadyInProgress,
      materials: [],
      supersededKit: staleKit,
      drafted: false,
    };
  }

  const result = await draftPressKit({ milestoneId });

  if (staleKit) {
    await query('UPDATE pr_kits SET superseded_by = $2 WHERE id = $1', [staleKit.id, result.kit.id]);
  }

  return {
    milestone,
    kit: result.kit,
    materials: result.materials,
    supersededKit: staleKit,
    drafted: true,
    outcomeChangedFrom: outcomeOf(before),
  };
}
