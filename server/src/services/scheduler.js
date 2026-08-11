import { withTransaction, query } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { getSocialApi } from './socialApis.js';

export const ACTOR = 'SchedulingAgent';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Finds the next optimal posting slot for a platform.
 *
 * Walks forward day by day from `from`, and for each day that the platform
 * performs well on, tries its best hours in preference order. A slot is only
 * taken if it is in the future and no other post is already queued within an
 * hour of it, so a week's posts spread out instead of stacking up.
 */
export function nextOptimalSlot({ window, from = new Date(), taken = [], horizonDays = 14 }) {
  const bestDays = new Set(window.best_days);
  const takenTimes = taken.map((t) => new Date(t).getTime());

  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset += 1) {
    const day = new Date(from);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (!bestDays.has(isoDay)) continue;

    for (const hour of window.best_hours) {
      const slot = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0),
      );
      if (slot.getTime() <= from.getTime()) continue;
      const collides = takenTimes.some((t) => Math.abs(t - slot.getTime()) < HOUR_MS);
      if (!collides) return slot;
    }
  }

  throw new Error(`No optimal slot found for ${window.platform} within ${horizonDays} days`);
}

/**
 * Queues an approved draft at the next optimal time for its platform.
 *
 * Refuses anything not already approved — this is the enforcement point for
 * the approval gate, so the check cannot be skipped by calling the scheduler
 * directly.
 */
export async function scheduleDraft({ draftId, from = new Date() }) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [draftId]);
      const draft = rows[0];
      if (!draft) throw Object.assign(new Error('Draft not found'), { status: 404 });

      if (draft.status !== 'approved') {
        throw Object.assign(
          new Error(`Draft ${draftId} cannot be scheduled: status is "${draft.status}", not "approved"`),
          { status: 409, blockedDraft: draft },
        );
      }

      const { rows: windowRows } = await client.query(
        'SELECT * FROM platform_windows WHERE platform = $1',
        [draft.platform],
      );
      const window = windowRows[0];
      if (!window) {
        throw Object.assign(new Error(`No posting window configured for ${draft.platform}`), {
          status: 400,
        });
      }

      const { rows: existing } = await client.query(
        `SELECT scheduled_for FROM scheduled_posts
          WHERE author_id = $1 AND platform = $2 AND status = 'queued'`,
        [draft.author_id, draft.platform],
      );

      const slot = nextOptimalSlot({
        window,
        from,
        taken: existing.map((r) => r.scheduled_for),
      });

      const { rows: scheduled } = await client.query(
        `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [draftId, draft.author_id, draft.platform, slot.toISOString()],
      );

      const { rows: updated } = await client.query(
        "UPDATE drafts SET status = 'scheduled', updated_at = now() WHERE id = $1 RETURNING *",
        [draftId],
      );

      await recordAction(
        {
          actor: ACTOR,
          action: 'draft.scheduled',
          entityType: 'scheduled_post',
          entityId: scheduled[0].id,
          authorId: draft.author_id,
          before: draft,
          after: { ...updated[0], scheduled_for: scheduled[0].scheduled_for },
          metadata: {
            platform: draft.platform,
            scheduled_for: scheduled[0].scheduled_for,
            chosen_because: `best hour ${slot.getUTCHours()}:00 UTC on ISO day ${slot.getUTCDay() === 0 ? 7 : slot.getUTCDay()} for ${draft.platform}`,
          },
        },
        client,
      );

      return scheduled[0];
    });
  } catch (error) {
    // A refused action still has to appear in the log. The transaction above
    // has already rolled back, so this entry is written on its own connection
    // and survives the rejection.
    if (error.blockedDraft) {
      await recordAction({
        actor: ACTOR,
        action: 'schedule.blocked',
        entityType: 'draft',
        entityId: draftId,
        authorId: error.blockedDraft.author_id,
        before: error.blockedDraft,
        metadata: {
          reason: 'approval gate: draft is not approved',
          status: error.blockedDraft.status,
        },
      });
    }
    throw error;
  }
}

/** Publishes queued posts whose time has come, through the mocked adapters. */
export async function publishDue({ now = new Date() } = {}) {
  const { rows: due } = await query(
    `SELECT sp.*, d.content
       FROM scheduled_posts sp
       JOIN drafts d ON d.id = sp.draft_id
      WHERE sp.status = 'queued' AND sp.scheduled_for <= $1
      ORDER BY sp.scheduled_for`,
    [now.toISOString()],
  );

  const results = [];
  for (const post of due) {
    try {
      const api = getSocialApi(post.platform);
      const result = await api.publish({ content: post.content, scheduledFor: post.scheduled_for });

      const { rows } = await query(
        `UPDATE scheduled_posts
            SET status = 'published', external_id = $1, published_at = now()
          WHERE id = $2 RETURNING *`,
        [result.externalId, post.id],
      );

      await recordAction({
        actor: ACTOR,
        action: 'post.published',
        entityType: 'scheduled_post',
        entityId: post.id,
        authorId: post.author_id,
        before: post,
        after: rows[0],
        metadata: { externalId: result.externalId, permalink: result.permalink, mocked: true },
      });

      results.push(rows[0]);
    } catch (error) {
      const { rows } = await query(
        "UPDATE scheduled_posts SET status = 'failed', error = $1 WHERE id = $2 RETURNING *",
        [error.message, post.id],
      );

      await recordAction({
        actor: ACTOR,
        action: 'post.failed',
        entityType: 'scheduled_post',
        entityId: post.id,
        authorId: post.author_id,
        before: post,
        after: rows[0],
        metadata: { error: error.message },
      });

      results.push(rows[0]);
    }
  }

  return results;
}
