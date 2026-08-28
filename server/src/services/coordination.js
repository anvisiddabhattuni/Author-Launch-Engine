/**
 * Coordination and Governance Agent (STORY-011).
 *
 * The agent Basecamp names as the owner of task management across agents. It
 * exists as its own module because STORY-065 built the queue that *runs*
 * everyone's work without anything that decides *in what order* — and the queue
 * shipped supporting more than one worker, which is what turned an accident
 * into a defect.
 *
 * Two decisions, and only two:
 *
 *   priority — what should be reached first when several things are due.
 *   resource — what must not run at the same time as what.
 *
 * It deliberately does **not** enforce the approval gate. That has lived inside
 * `scheduleDraft`, `sendOutreachMessage` and `distributePressKit` since
 * STORY-001, precisely so a new caller cannot route around it, and a
 * coordinator that re-checked approval would be a second copy of the rule with
 * its own chance to drift — the exact mistake STORY-008 cleaned up. Compliance
 * here means the narrower thing the story's trust clause asks for: every
 * dispatch and every deferral is on the audit log, with the reason.
 */
import { recordAction } from './auditLog.js';

export const ACTOR = 'CoordinationGovernanceAgent';

/**
 * Higher runs first.
 *
 * The bands are the argument, not the numbers. Outbound work a human has
 * already authorised outranks everything, because somebody is waiting on the
 * other end of it and the decision to send has already been made. Producing
 * work outranks the consumers that react to what it produced, which is the
 * ordering nothing expressed before this story. Housekeeping comes last.
 */
export const PRIORITIES = {
  // A human approved this email. It is the only work in the queue with a person
  // on the far side of it, and it used to sort last.
  'outreach.send': 90,
  // The scheduled time has already passed; every minute here is a late post.
  'posts.publish_due': 80,
  // Produces the press materials the two consumers below react to.
  'press.draft_approaching': 50,
  // Re-derives escalation decisions over what the drafter produced.
  'trust.monitor_escalations': 30,
  // Tells a human what is waiting — last on purpose, so that it also covers
  // anything the monitor escalated in this same window rather than missing it
  // by one sweep.
  'reviews.notify_pending': 20,
  // The same reasoning, for everything that is not a press kit (STORY-012).
  // A shade lower so the two notifiers have a defined order rather than a tie
  // broken by whichever row happened to be inserted first.
  'approvals.notify_waiting': 19,
  // Lowest. It reads history rather than producing or reacting to work, and
  // sealing a few rows later costs nothing — where delaying an approved email
  // or a publish costs something to somebody (STORY-013).
  'audit.seal_and_verify': 10,
};

/** Anything unclassified sits between outbound work and housekeeping. */
export const DEFAULT_PRIORITY = 50;

/**
 * What each kind needs exclusive use of while it runs.
 *
 * `press` is one resource covering the drafter, the monitor and the notifier
 * because they are three stages of one pipeline over the same author's
 * `pr_materials`. Serialising them is what makes the ordering above mean
 * anything: priority decides who goes first, exclusion is what stops the other
 * two from reading the table while the first is still writing it.
 *
 * Scoped per author, so this serialises one tenant's pipeline and not the queue.
 * A hundred authors still draft, monitor and notify in parallel with each other.
 */
export const RESOURCES = {
  'press.draft_approaching': (job) => `author:${job.author_id}:press`,
  'trust.monitor_escalations': (job) => `author:${job.author_id}:press`,
  'reviews.notify_pending': (job) => `author:${job.author_id}:press`,
  // Its own resource rather than sharing the press pipeline's: it reads drafts,
  // outreach and recommendations, none of which the press stages touch, and
  // serialising it behind them would delay telling somebody for no benefit.
  'approvals.notify_waiting': (job) => `author:${job.author_id}:approvals`,
  // One global publisher. Two of these at once would race for the same due
  // posts; the idempotency key already prevents two existing, and this makes
  // the guarantee independent of that.
  'posts.publish_due': () => 'global:scheduled_posts',
  // One log, one sealer. Two of these at once would seal overlapping ranges and
  // produce two chains claiming to describe the same rows.
  'audit.seal_and_verify': () => 'global:audit_log',
  // Per message, not per author: two different approved emails have no reason
  // to wait for each other.
  'outreach.send': (job) => `outreach:${job.payload?.messageId}`,
};

/** The priority a job of this kind should carry. */
export const priorityFor = (kind) => PRIORITIES[kind] ?? DEFAULT_PRIORITY;

/**
 * The resource a job needs, or null when it contends with nothing.
 *
 * A kind with a resource function that cannot produce a key — an
 * `outreach.send` with no messageId, say — gets null rather than the string
 * "outreach:undefined". A malformed key would be a resource shared by every
 * malformed job, which is a worse failure than no exclusion at all.
 */
export function resourceFor(job) {
  const derive = RESOURCES[job.kind];
  if (!derive) return null;
  const key = derive(job);
  return typeof key === 'string' && !key.includes('undefined') && !key.includes('null')
    ? key
    : null;
}

/**
 * What the coordinator decided about one job, ready to be stored on it.
 *
 * Recorded on the row rather than re-derived on read, so a queue that looks
 * stuck can be explained later even if the tables above have changed since.
 */
export function planFor(job) {
  const priority = priorityFor(job.kind);
  const resource = resourceFor(job);
  return {
    priority,
    resource,
    coordination: {
      priority,
      resource,
      // The plain-English reason, for the person looking at a stalled queue.
      reason:
        priority >= 80
          ? 'outbound work a human authorised'
          : priority >= 50
            ? 'produces work other agents react to'
            : 'reacts to what the producers wrote',
      decidedBy: ACTOR,
    },
  };
}

/**
 * Records that work was handed out, or held back — the story's trust clause.
 *
 * A deferral is the interesting half. A job passed over because another agent
 * holds its resource is not an error and not a failure, and without a line
 * saying so it is indistinguishable from a queue with nothing to do.
 */
export async function recordDispatch({ job, deferredBehind = null }, client) {
  return recordAction(
    {
      actor: ACTOR,
      action: deferredBehind ? 'task.deferred' : 'task.dispatched',
      entityType: 'job',
      entityId: job.id,
      authorId: job.author_id,
      metadata: {
        kind: job.kind,
        priority: job.priority,
        resource: job.resource,
        ...(deferredBehind ? { deferredBehind } : {}),
      },
    },
    client,
  );
}
