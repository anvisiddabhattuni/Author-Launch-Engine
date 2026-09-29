import { findAwaitingApproval } from '../agents/approvalNotificationAgent.js';
import { pool } from '../db/pool.js';
import { PERMISSIONS, holds } from './permissions.js';

/**
 * What needs attention (STORY-057 / REQ-015, REQ-004) — Trust and Monitoring
 * Agent.
 *
 * The trust dashboard showed pending approvals as counts by kind and recent
 * actions as a time of day. This is the one read the dashboard and the
 * app-wide notice poll: every waiting item with its timestamp and priority,
 * recent actions with their full timestamp and priority, and what is waiting
 * for *this* person to decide.
 */

/** Priority of a recent action, by what it says happened. First match wins. */
export const ACTION_PRIORITY = [
  { level: 'high', pattern: /(breach|refused|suspicious|escalat|fail|blocked|dead_letter|outage|undecryptable|altered|changes_requested)/, why: 'something went wrong or was refused' },
  { level: 'medium', pattern: /(approved|rejected|scheduled|published|sent|distributed|onboarded|suspended|revoked|acknowledged)/, why: 'a decision or something leaving the system' },
  { level: 'normal', pattern: /.*/, why: 'routine' },
];

export const actionPriority = (action) => {
  const rule = ACTION_PRIORITY.find((r) => r.pattern.test(action));
  return { priority: rule.level, priorityReason: rule.why };
};

export async function attentionFor({ authorId, user, recent = 20 }) {
  const awaiting = await findAwaitingApproval({ authorId: Number(authorId) });
  const { rows } = await pool.query(
    `SELECT id, created_at, actor, action, entity_type, entity_id
       FROM audit_log WHERE author_id = $1 ORDER BY id DESC LIMIT $2`,
    [Number(authorId), Math.min(Number(recent) || 20, 100)],
  );
  const recentActions = rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), ...actionPriority(r.action) }));
  const canApprove = holds(user, PERMISSIONS.CONTENT_APPROVE);
  return {
    generatedAt: new Date().toISOString(),
    awaiting,
    recentActions,
    // The notice: what is waiting for this person, if they are someone who decides.
    forYou: canApprove && awaiting.total > 0
      ? {
        count: awaiting.total,
        high: awaiting.byPriority.high,
        oldestHours: awaiting.oldestHours,
        message: `${awaiting.total} item${awaiting.total === 1 ? '' : 's'} waiting for your approval`
          + (awaiting.byPriority.high ? ` — ${awaiting.byPriority.high} high priority` : '')
          + (awaiting.oldestHours >= 24 ? `, oldest ${Math.floor(awaiting.oldestHours / 24)} day${awaiting.oldestHours >= 48 ? 's' : ''}` : ''),
      }
      : null,
  };
}
