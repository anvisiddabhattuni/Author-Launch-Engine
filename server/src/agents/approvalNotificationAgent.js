/**
 * Approval and Notification Agent (STORY-012).
 *
 * Half of this story has worked since STORY-001. Nothing reaches a platform
 * without a human decision, and the gate has grown to four targets — drafts,
 * outreach messages, press materials, mix recommendations — without being
 * forked once.
 *
 * The other half is the word "and". The clause is that the agent holds the
 * draft *and sends a notification*, and until this story `notifications` could
 * not reference anything but a press kit. Its own constraint said so. A social
 * post could sit in `pending_approval` for a week with no mechanism by which
 * anyone could be told: not a bug in the notifier, an absence in the schema.
 *
 * Two things this module deliberately does not do.
 *
 * It does not re-implement the gate. Holding work is `scheduleDraft`,
 * `sendOutreachMessage` and `distributePressKit` refusing to act, and it lives
 * inside those services precisely so a new caller cannot route around it — the
 * same reason STORY-011's coordinator does not re-check approval either.
 *
 * And it does not notify about press kits. STORY-007 already does, with
 * kit-specific content this has no business duplicating; two agents emailing
 * about the same kit is the drift STORY-008 spent a story removing. Kits appear
 * in the queue below — a reviewer should see everything in one place — and the
 * email about them still comes from `reviewNotifier`.
 */
import { randomUUID } from 'node:crypto';

import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { emailApi } from '../services/emailApi.js';
import { findReviewers } from '../services/reviewNotifier.js';

export const ACTOR = 'ApprovalNotificationAgent';

/**
 * The four things a human decides, and where each lives.
 *
 * `notifies` is false for press kits on purpose: they are in the queue so a
 * reviewer sees one list, and their email comes from STORY-007.
 */
export const QUEUES = [
  {
    kind: 'draft',
    table: 'drafts',
    column: 'draft_id',
    notifies: true,
    label: (row) => `${row.format === 'meme' ? 'Meme' : 'Post'} for ${row.platform}`,
    detail: (row) => String(row.content ?? '').replace(/\s+/g, ' ').slice(0, 90),
  },
  {
    kind: 'outreach',
    table: 'outreach_messages',
    column: 'outreach_message_id',
    notifies: true,
    label: () => 'Outreach email',
    detail: (row) => String(row.subject ?? '').slice(0, 90),
  },
  {
    kind: 'mixRecommendation',
    table: 'mix_recommendations',
    column: 'mix_recommendation_id',
    notifies: true,
    label: (row) => `Content mix change for ${row.platform}`,
    detail: (row) => `${row.current_memes} → ${row.suggested_memes} memes per batch`,
  },
  {
    kind: 'prMaterial',
    table: 'pr_materials',
    column: 'pr_kit_id',
    notifies: false,
    label: (row) => `Press ${String(row.type ?? '').replace('_', ' ')}`,
    detail: (row) => String(row.headline ?? '').slice(0, 90),
  },
];

/**
 * Priority of a waiting item (STORY-057), with the reason — declared here so
 * the dashboard can say why something is high, not only that it is.
 * First match wins.
 */
export const PRIORITY_RULES = [
  { level: 'high', when: (i) => i.escalated, why: 'escalated — a check asked for a person' },
  { level: 'high', when: (i) => i.ageHours >= 48, why: 'waiting more than two days' },
  { level: 'medium', when: (i) => i.ageHours >= 24, why: 'waiting more than a day' },
  { level: 'normal', when: () => true, why: 'waiting' },
];
const RANK = { high: 0, medium: 1, normal: 2 };

export function prioritise(item, now = new Date()) {
  const ageHours = Math.max(0, (now - new Date(item.createdAt)) / 3_600_000);
  const rule = PRIORITY_RULES.find((r) => r.when({ ...item, ageHours }));
  return { ...item, ageHours: Number(ageHours.toFixed(1)), priority: rule.level, priorityReason: rule.why };
}

/** Statuses a human can still act on, matching the approval gate's own rule. */
const WAITING = ['pending_approval', 'escalated'];

/**
 * Everything waiting on a human for one author, in one shape.
 *
 * A read-model rather than a stored queue: "what is waiting" is a question the
 * status columns already answer, and a second copy of that state would be free
 * to disagree with them — the reason STORY-008's escalation queue is derived
 * from the material's own status too.
 */
export async function findAwaitingApproval({ authorId }, client = pool) {
  const items = [];

  for (const queue of QUEUES) {
    const { rows } = await client.query(
      `SELECT * FROM ${queue.table}
        WHERE author_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at, id`,
      [authorId, queue.kind === 'mixRecommendation' ? ['pending_approval'] : WAITING],
    );

    for (const row of rows) {
      items.push({
        kind: queue.kind,
        id: Number(row.id),
        label: queue.label(row),
        detail: queue.detail(row),
        status: row.status,
        // Why it is waiting, when the system had an opinion. An escalated item
        // is not merely unreviewed; something judged it and asked for a person.
        escalated: row.status === 'escalated',
        createdAt: row.created_at,
        notifiable: queue.notifies,
      });
    }
  }

  // Most urgent first, oldest first within a level (STORY-057).
  const ranked = items.map((i) => prioritise(i)).sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.ageHours - a.ageHours);
  items.splice(0, items.length, ...ranked);

  return {
    items,
    total: items.length,
    escalated: items.filter((i) => i.escalated).length,
    byPriority: { high: 0, medium: 0, normal: 0, ...items.reduce((acc, i) => ({ ...acc, [i.priority]: (acc[i.priority] ?? 0) + 1 }), {}) },
    oldestHours: items.length ? Math.max(...items.map((i) => i.ageHours)) : null,
    byKind: items.reduce((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

const summarise = (items) => {
  const counts = items.reduce((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});
  const names = {
    draft: 'social post',
    outreach: 'outreach email',
    mixRecommendation: 'content mix change',
  };
  return Object.entries(counts)
    .map(([kind, n]) => `${n} ${names[kind] ?? kind}${n === 1 ? '' : 's'}`)
    .join(', ');
};

function digestBody({ reviewer, items, authorName }) {
  const lines = items.map(
    (i) => `  - ${i.label}${i.escalated ? '  [escalated]' : ''}\n      ${i.detail}`,
  );
  const escalated = items.filter((i) => i.escalated).length;

  return [
    `Hello ${reviewer.name},`,
    '',
    `${summarise(items)} for ${authorName} are waiting on a decision from you.`,
    escalated > 0
      ? `${escalated} of them ${escalated === 1 ? 'was' : 'were'} escalated — something checked ${escalated === 1 ? 'it' : 'them'} and asked for a person.`
      : '',
    '',
    ...lines,
    '',
    'Nothing here has been published, and nothing will be until you decide.',
    '',
    'Review them in the Author Launch Engine.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Tells each reviewer what is newly waiting on them — once per item, ever.
 *
 * One email per reviewer per sweep, not one per item. STORY-007's model is one
 * email per press kit, which is right for a kit: they are rare and each is a
 * decision on its own. Social drafts arrive four at a time every week, and the
 * same model there is four emails a week per reviewer — which a reviewer stops
 * reading, at which point the notification is worse than none.
 *
 * Rows are still written per item, so the idempotency guarantee holds: an item
 * announced to a reviewer is never announced to them again, however often the
 * sweep runs.
 */
export async function notifyAwaitingApproval({ authorId, notifier = emailApi }) {
  const { rows: authors } = await pool.query('SELECT * FROM authors WHERE id = $1', [authorId]);
  const author = authors[0];
  if (!author) throw Object.assign(new Error('Author not found'), { status: 404 });

  const queue = await findAwaitingApproval({ authorId });
  const notifiable = queue.items.filter((i) => i.notifiable);
  const reviewers = await findReviewers({ authorId }, pool);

  // Work waiting and nobody to tell. Recorded rather than passed over in
  // silence — the state STORY-007 named, and it is no less true here.
  if (notifiable.length > 0 && reviewers.length === 0) {
    await recordAction({
      actor: ACTOR,
      action: 'approval.unreachable',
      entityType: 'author',
      entityId: authorId,
      authorId,
      metadata: {
        waiting: notifiable.length,
        byKind: queue.byKind,
        reason: 'no active reviewer is configured for this author',
      },
    });
    return { notified: [], failed: [], skipped: [], unreachable: true, queue };
  }

  const notified = [];
  const failed = [];
  const skipped = [];
  const batchId = randomUUID();

  for (const reviewer of reviewers) {
    // Only what this reviewer has not already been told about. A digest that
    // re-lists the same drafts every sweep is noise wearing an envelope.
    const fresh = [];
    for (const item of notifiable) {
      const column = QUEUES.find((q) => q.kind === item.kind).column;
      const { rows } = await pool.query(
        `SELECT 1 FROM notifications WHERE ${column} = $1 AND reviewer_id = $2`,
        [item.id, reviewer.id],
      );
      if (rows.length === 0) fresh.push(item);
      else skipped.push({ reviewer: reviewer.email, kind: item.kind, id: item.id });
    }

    if (fresh.length === 0) continue;

    const subject = `${fresh.length} item${fresh.length === 1 ? '' : 's'} waiting on your approval — ${author.name}`;
    const body = digestBody({ reviewer, items: fresh, authorName: author.name });

    // One transaction per reviewer: the rows that record "this person was told"
    // and the send itself must not be able to disagree. A send that succeeds
    // without its rows would announce the same items again next sweep.
    const written = await withTransaction(async (client) => {
      const rows = [];
      for (const item of fresh) {
        const column = QUEUES.find((q) => q.kind === item.kind).column;
        const { rows: inserted } = await client.query(
          `INSERT INTO notifications
             (author_id, reviewer_id, ${column}, channel, subject, body, pending_count, batch_id)
           VALUES ($1,$2,$3,'email',$4,$5,$6,$7)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [authorId, reviewer.id, item.id, subject, body, fresh.length, batchId],
        );
        if (inserted[0]) rows.push(inserted[0]);
      }
      return rows;
    });

    if (written.length === 0) continue;

    let delivered = false;
    try {
      const sent = await notifier.send({
        to: reviewer.email,
        subject,
        body,
        via: 'approval.notify_waiting',
      });
      await pool.query(
        `UPDATE notifications SET status = 'sent', external_id = $2, sent_at = now()
          WHERE batch_id = $1 AND reviewer_id = $3`,
        [batchId, sent.externalId, reviewer.id],
      );
      notified.push({ reviewer: reviewer.email, items: written.length, externalId: sent.externalId });
      delivered = true;
    } catch (error) {
      await pool.query(
        `UPDATE notifications SET status = 'failed', error = $2
          WHERE batch_id = $1 AND reviewer_id = $3`,
        [batchId, error.message, reviewer.id],
      );
      // Left as 'failed' rather than deleted: the item stays announced-to so a
      // retry does not re-announce, and the failure is visible to a person.
      // Not counted as notified (STORY-040): it was, and during an email
      // outage the sweep reported "notified: 2" when nobody had been told.
      failed.push({ reviewer: reviewer.email, items: written.length, error: error.message });
    }

    await recordAction({
      actor: ACTOR,
      action: delivered ? 'approval.notified' : 'approval.notify_failed',
      entityType: 'reviewer',
      entityId: reviewer.id,
      authorId,
      metadata: {
        reviewer: reviewer.email,
        items: written.length,
        batchId,
        byKind: fresh.reduce((acc, i) => {
          acc[i.kind] = (acc[i.kind] ?? 0) + 1;
          return acc;
        }, {}),
        escalated: fresh.filter((i) => i.escalated).length,
        // Said plainly: this told somebody, it did not decide anything.
        decided: false,
      },
    });
  }

  await recordAction({
    actor: ACTOR,
    action: 'approval.sweep_completed',
    entityType: 'author',
    entityId: authorId,
    authorId,
    metadata: {
      waiting: queue.total,
      notifiable: notifiable.length,
      reviewers: reviewers.length,
      notified: notified.length,
      alreadyKnown: skipped.length,
      // Press kits are in the queue and not in this sweep; STORY-007 mails
      // about those, and two agents emailing one kit is drift.
      deferredToReviewNotifier: queue.items.filter((i) => !i.notifiable).length,
    },
  });

  return { notified, failed, skipped, unreachable: false, queue, batchId };
}
