import { withTransaction } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

/**
 * Approval and Notification Agent (STORY-007).
 *
 * The half of REQ-006 that was never built. Approval gates, decisions and the
 * audit trail all existed; what did not was anyone being *told* that work was
 * waiting. A gate nobody knows to open is not a control, it is a queue.
 *
 * Nothing here can approve, reject or send. It reads what is pending and tells
 * a person about it — the trust boundary is untouched, and deliberately so:
 * this agent's whole job is to make a human act sooner, never to act for them.
 */
export const ACTOR = 'ApprovalNotificationAgent';

/** Statuses that mean a human still has to look at it. */
const AWAITING = ['pending_approval', 'escalated'];

/**
 * Kits with at least one material still awaiting a decision.
 *
 * Superseded kits are excluded. STORY-005 already refuses decisions on withdrawn
 * copy, so notifying someone about it would spend the reviewer's attention on
 * something the system will not even let them action.
 */
export async function findKitsAwaitingReview({ authorId }, client) {
  const { rows } = await client.query(
    // LEFT JOIN: an on-demand kit has no milestone, and a reviewer who is never
    // told about it is an approval gate nobody is standing at (STORY-018).
    `SELECT k.id,
            k.author_id,
            COALESCE(m.title, 'PR materials requested directly') AS milestone_title,
            m.type        AS milestone_type,
            m.event_date,
            m.award_name,
            m.outcome,
            COUNT(*) FILTER (WHERE p.status = ANY($2))::int          AS pending_count,
            COUNT(*) FILTER (WHERE p.status = 'escalated')::int      AS escalated_count,
            MIN(p.theme_alignment)                                   AS min_theme_alignment,
            MIN(p.voice_score)                                       AS min_voice_score
       FROM pr_kits k
       LEFT JOIN milestones m ON m.id = k.milestone_id
       JOIN pr_materials p    ON p.kit_id = k.id
      WHERE k.author_id = $1
        AND k.status = 'drafting'
      GROUP BY k.id, k.author_id, m.title, m.type, m.event_date, m.award_name, m.outcome
     HAVING COUNT(*) FILTER (WHERE p.status = ANY($2)) > 0
      ORDER BY COALESCE(m.event_date, k.created_at::date), k.id`,
    [authorId, AWAITING],
  );
  return rows;
}

/** Everyone the author has said should hear about pending work. */
export async function findReviewers({ authorId }, client) {
  const { rows } = await client.query(
    'SELECT * FROM reviewers WHERE author_id = $1 AND active ORDER BY id',
    [authorId],
  );
  return rows;
}

/**
 * What this kit actually announces.
 *
 * Not the milestone title. A won award keeps the title it was put on the
 * calendar with — "shortlisted for the Vermilion Prize" — so subject-lining a
 * reviewer with that title would describe the *win* kit as the shortlist one.
 * STORY-005 made the outcome data precisely so the announcement does not have
 * to be inferred from prose; the same rule has to hold in the mail about it.
 */
function announces(kit) {
  // No milestone type at all: the kit was requested rather than triggered
  // (STORY-018). Saying "a null" is how a nullable column reaches a reviewer.
  if (!kit.milestone_type) return 'the book itself, requested directly';
  if (kit.milestone_type === 'award') {
    const prize = kit.award_name ?? 'a nonfiction prize';
    return kit.outcome === 'won' ? `an award win — ${prize}` : `an award shortlisting — ${prize}`;
  }
  if (kit.milestone_type === 'anniversary') return 'a publication anniversary';
  if (kit.milestone_type === 'launch') return 'a book launch';
  return `a ${kit.milestone_type}`;
}

function compose({ kit, reviewer, author }) {
  const escalatedLine =
    kit.escalated_count > 0
      ? `${kit.escalated_count} of them ${kit.escalated_count === 1 ? 'was' : 'were'} escalated ` +
        'automatically and needs a closer read.'
      : 'None of them were escalated.';

  const announcement = announces(kit);

  return {
    subject:
      `${kit.pending_count} press ${kit.pending_count === 1 ? 'material' : 'materials'} ` +
      `awaiting your review — ${announcement}`,
    body: [
      `Hello ${reviewer.name},`,
      '',
      // An on-demand kit has no event date. `new Date(null)` is the epoch, not
      // an error, so left alone this sentence would have told a reviewer the
      // kit announces something on 1 January 1970.
      kit.event_date
        ? `A press kit for ${author.name} is waiting for a decision. It announces ${announcement} ` +
          `on ${new Date(kit.event_date).toISOString().slice(0, 10)}.`
        : `A press kit for ${author.name} is waiting for a decision. It announces ${announcement}, ` +
          'with no event date — it was requested rather than triggered by one.',
      '',
      // The milestone title is kept for context but no longer carries the
      // claim: an award keeps the title it was scheduled under even after it
      // has been won.
      `Milestone as scheduled: ${kit.milestone_title}`,
      `Awaiting review: ${kit.pending_count}`,
      escalatedLine,
      `Lowest theme alignment in the kit: ${Number(kit.min_theme_alignment).toFixed(2)}`,
      '',
      // The gate is the point, so the mail says so rather than implying that
      // clicking through is a formality.
      'Nothing in this kit can be distributed until every material in it is approved.',
      'Reviewing it is what releases it; taking no action leaves it unsent.',
      '',
      `Open the Press tab to review: /press (kit ${kit.id})`,
    ].join('\n'),
  };
}

/**
 * Tells reviewers about escalations the *monitor* raised (STORY-008).
 *
 * Deliberately narrower than the pending-review nudge above. "Something is
 * waiting" is routine; "an independent check caught something the drafting
 * agent queued as fine" is not, and folding the second into the first would
 * bury it. Only monitor-raised escalations notify — a producer escalating its
 * own draft is already covered by the pending-review mail.
 */
export async function notifyRaisedEscalations({ authorId, notifier = emailApi }) {
  return withTransaction(async (client) => {
    const { rows: pending } = await client.query(
      // LEFT JOIN for the same reason as above: an escalation on an on-demand
      // kit is exactly the kind a reviewer most needs to hear about, and an
      // inner join here silently withheld it (STORY-018).
      `SELECT e.*, p.type, p.headline,
              COALESCE(m.title, 'PR materials requested directly') AS milestone_title
         FROM escalations e
         JOIN pr_materials p ON p.id = e.pr_material_id
         JOIN pr_kits k      ON k.id = p.kit_id
         LEFT JOIN milestones m ON m.id = k.milestone_id
        WHERE e.author_id = $1
          AND e.detected_by = 'monitor'
          AND p.status = 'escalated'
        ORDER BY e.id`,
      [authorId],
    );
    if (pending.length === 0) return { notified: [], skipped: [] };

    const reviewers = await findReviewers({ authorId }, client);
    if (reviewers.length === 0) {
      await recordAction(
        {
          actor: ACTOR,
          action: 'review.no_reviewers',
          entityType: 'author',
          entityId: authorId,
          authorId,
          metadata: {
            escalationsAwaitingReview: pending.length,
            reason: 'A monitor raised escalations and no active reviewer is configured.',
          },
        },
        client,
      );
      return { notified: [], skipped: [], unreachable: true };
    }

    const notified = [];
    const skipped = [];

    for (const escalation of pending) {
      for (const reviewer of reviewers) {
        const subject =
          `Escalated by monitoring — ${escalation.type.replace('_', ' ')} for ` +
          `${escalation.milestone_title}`;
        const body = [
          `Hello ${reviewer.name},`,
          '',
          'An independent check flagged a press material that the drafting agent had queued for',
          'ordinary approval. It has been moved to escalated and is waiting on you.',
          '',
          `Material: ${escalation.type.replace('_', ' ')} — "${escalation.headline}"`,
          `Milestone: ${escalation.milestone_title}`,
          `Raised for: ${escalation.reasons.join(', ')}`,
          `Confidence ${Number(escalation.confidence).toFixed(2)} ` +
            `(floor ${Number(escalation.threshold_confidence).toFixed(2)}) · ` +
            `theme alignment ${Number(escalation.theme_alignment).toFixed(2)} ` +
            `(floor ${Number(escalation.threshold_theme_alignment).toFixed(2)})`,
          '',
          'Nothing has been sent. Nothing in this kit can be distributed until every material',
          'in it is approved.',
        ].join('\n');

        const { rows: inserted } = await client.query(
          `INSERT INTO notifications
             (author_id, reviewer_id, escalation_id, channel, subject, body, pending_count)
           VALUES ($1,$2,$3,'email',$4,$5,1)
           -- The predicate is required: the unique index is partial, and without
           -- it Postgres cannot tell which index this conflict refers to.
           ON CONFLICT (escalation_id, reviewer_id) WHERE escalation_id IS NOT NULL
             DO NOTHING
           RETURNING *`,
          [authorId, reviewer.id, escalation.id, subject, body],
        );
        if (!inserted[0]) {
          skipped.push({ escalationId: Number(escalation.id), reviewer: reviewer.name });
          continue;
        }

        let notification = inserted[0];
        try {
          const result = await notifier.send({
            to: reviewer.email,
            subject,
            body,
            via: 'review.notify_escalation',
          });
          const { rows: sent } = await client.query(
            `UPDATE notifications SET status = 'sent', external_id = $2, sent_at = now()
              WHERE id = $1 RETURNING *`,
            [notification.id, result.externalId],
          );
          notification = sent[0];
        } catch (error) {
          const { rows: failed } = await client.query(
            "UPDATE notifications SET status = 'failed', error = $2 WHERE id = $1 RETURNING *",
            [notification.id, error.message],
          );
          notification = failed[0];
        }

        await recordAction(
          {
            actor: ACTOR,
            action:
              notification.status === 'sent' ? 'review.notified' : 'review.notification_failed',
            entityType: 'notification',
            entityId: notification.id,
            authorId,
            after: notification,
            metadata: {
              about: 'escalation',
              escalationId: Number(escalation.id),
              reviewer: reviewer.name,
              recipient: reviewer.email,
              reasons: escalation.reasons,
              provider: notifier.name,
            },
          },
          client,
        );

        notified.push(notification);
      }
    }

    return { notified, skipped };
  });
}

/**
 * Tells every active reviewer about every kit still awaiting a decision.
 *
 * Idempotent per reviewer per kit. Re-running is safe and is meant to be — like
 * `draftApproachingKits` in STORY-004, this is the function a scheduled worker
 * would call, and nothing runs on a timer yet. A reviewer who has simply not
 * got to it does not get mailed again on every tick: an alert that repeats
 * itself is an alert people learn to ignore, which spends the exact attention
 * this gate exists to spend.
 */
export async function notifyPendingReviews({ authorId, notifier = emailApi }) {
  return withTransaction(async (client) => {
    const { rows: authorRows } = await client.query('SELECT * FROM authors WHERE id = $1', [
      authorId,
    ]);
    const author = authorRows[0];
    if (!author) throw Object.assign(new Error('Author not found'), { status: 404 });

    const kits = await findKitsAwaitingReview({ authorId }, client);
    const reviewers = await findReviewers({ authorId }, client);

    // Work is waiting and there is nobody to tell. Logged rather than passed
    // over in silence: an empty notification run must not read the same as a
    // system with nothing to report, which is the same reason STORY-005 records
    // that a loss produced no material.
    if (kits.length > 0 && reviewers.length === 0) {
      await recordAction(
        {
          actor: ACTOR,
          action: 'review.no_reviewers',
          entityType: 'author',
          entityId: authorId,
          authorId,
          metadata: {
            kitsAwaitingReview: kits.length,
            materialsAwaitingReview: kits.reduce((n, k) => n + k.pending_count, 0),
            reason:
              'Materials are awaiting review and no active reviewer is configured, so nobody was told.',
          },
        },
        client,
      );
      return { notified: [], skipped: [], kits, reviewers, unreachable: true };
    }

    const notified = [];
    const skipped = [];

    for (const kit of kits) {
      for (const reviewer of reviewers) {
        const { subject, body } = compose({ kit, reviewer, author });

        // The unique constraint is the idempotency, not a check-then-insert:
        // two workers firing at once would both pass the check.
        const { rows: inserted } = await client.query(
          `INSERT INTO notifications
             (author_id, reviewer_id, pr_kit_id, channel, subject, body, pending_count)
           VALUES ($1,$2,$3,'email',$4,$5,$6)
           ON CONFLICT (pr_kit_id, reviewer_id) WHERE pr_kit_id IS NOT NULL
             DO NOTHING
           RETURNING *`,
          [authorId, reviewer.id, kit.id, subject, body, kit.pending_count],
        );

        if (!inserted[0]) {
          skipped.push({ kitId: kit.id, reviewer: reviewer.name, reason: 'already notified' });
          continue;
        }

        let notification = inserted[0];
        try {
          const result = await notifier.send({
            to: reviewer.email,
            subject,
            body,
            via: 'review.notify_pending',
          });
          const { rows: sent } = await client.query(
            `UPDATE notifications
                SET status = 'sent', external_id = $2, sent_at = now()
              WHERE id = $1 RETURNING *`,
            [notification.id, result.externalId],
          );
          notification = sent[0];
        } catch (error) {
          const { rows: failed } = await client.query(
            "UPDATE notifications SET status = 'failed', error = $2 WHERE id = $1 RETURNING *",
            [notification.id, error.message],
          );
          notification = failed[0];
        }

        await recordAction(
          {
            actor: ACTOR,
            action:
              notification.status === 'sent' ? 'review.notified' : 'review.notification_failed',
            entityType: 'notification',
            entityId: notification.id,
            authorId,
            after: notification,
            metadata: {
              kitId: kit.id,
              milestone: kit.milestone_title,
              reviewer: reviewer.name,
              recipient: reviewer.email,
              role: reviewer.role,
              pendingCount: kit.pending_count,
              escalatedCount: kit.escalated_count,
              channel: notification.channel,
              provider: notifier.name,
              error: notification.error ?? null,
            },
          },
          client,
        );

        notified.push(notification);
      }
    }

    return { notified, skipped, kits, reviewers, unreachable: false };
  });
}
