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
  // Above the producers, below authorised outbound work. An outage noticed
  // one sweep late is five minutes nobody was told; but it is cheap, and it
  // never outranks an email a human is waiting on (STORY-027).
  'system.health_check': 70,
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
  // Reads what was published and moves nothing (STORY-029). Below the
  // notifiers: a reading taken five minutes later is the same reading.
  'engagement.collect': 15,
  // Lowest. It reads history rather than producing or reacting to work, and
  // sealing a few rows later costs nothing — where delaying an approved email
  // or a publish costs something to somebody (STORY-013).
  'audit.seal_and_verify': 10,
  // Below even the sealer: it copies the logs into the search index, and a copy
  // made one sweep later is the same copy (STORY-055).
  'search.aggregate': 5,
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
  // One indexer: two would race to move the same marks (STORY-055).
  'search.aggregate': () => 'global:search_index',
  // Per author: two collections for one author would append two readings a
  // second apart, which is not a series, it is a stutter.
  'engagement.collect': (job) => `author:${job.author_id}:engagement`,
  // One monitor at a time. The unique index on open outages already makes two
  // concurrent checks safe; this makes the intent visible on the job row.
  'system.health_check': () => 'global:health',
  // Per message, not per author: two different approved emails have no reason
  // to wait for each other.
  'outreach.send': (job) => `outreach:${job.payload?.messageId}`,
};

/**
 * Who each kind of task is assigned to, what it needs, and why it sits where
 * it does (STORY-040).
 *
 * "Assigned to agents" was implicit before: a job had a kind and a handler,
 * and which agent was doing the work had to be read out of the code. And
 * "resource availability" meant only the exclusive resource above — nothing
 * knew that an agent's work needs an integration. With email down (STORY-038),
 * the approval notifier ran anyway, every send was refused, and the notifier
 * recorded the items as announced. They are never announced again.
 *
 * `requires` lists the integrations a task cannot do its job without. While
 * one of them has an open circuit, the task waits — without spending an
 * attempt — until the circuit will accept a trial call.
 */
export const TASKS = {
  'outreach.send':             { agent: 'PROutreachAgent',              requires: ['email'],
    reason: 'outbound work a human authorised' },
  'posts.publish_due':         { agent: 'SchedulingAgent',              requires: [],
    // Per platform, inside the publisher: one platform down must not hold
    // back posts to the other three.
    reason: 'outbound work a human authorised — late the moment it is due' },
  'system.health_check':       { agent: 'InfrastructureDeploymentAgent', requires: [],
    reason: 'notices outages; cheap, and must not wait behind the work it watches' },
  'press.draft_approaching':   { agent: 'PRMaterialsAgent',             requires: [],
    reason: 'produces work other agents react to' },
  'trust.monitor_escalations': { agent: 'TrustMonitoringAgent',         requires: [],
    reason: 'reacts to what the producers wrote' },
  'trust.assess':              { agent: 'TrustMonitoringAgent',         requires: [],
    reason: 'reads the whole system and writes one assessment; reacts, produces nothing others wait on' },
  'reviews.notify_pending':    { agent: 'ApprovalNotificationAgent',    requires: ['email'],
    reason: 'reacts to what the producers made: tells a human what is waiting, after them so it covers it' },
  'approvals.notify_waiting':  { agent: 'ApprovalNotificationAgent',    requires: ['email'],
    reason: 'reacts to what the producers made: tells a human what is waiting, after them so it covers it' },
  'posts.notify_failures':     { agent: 'APIIntegrationAgent',          requires: ['email'],
    reason: 'reacts to the publisher: tells a human a post failed, after it so it covers this window' },
  'engagement.collect':        { agent: 'TrustMonitoringAgent',         requires: [],
    reason: 'reads what was published and moves nothing' },
  'audit.seal_and_verify':     { agent: 'AuditSecurityAgent',           requires: [],
    reason: 'reads history; sealing a few rows later costs nothing' },
  'search.aggregate':          { agent: 'TrustMonitoringAgent',         requires: [],
    reason: 'copies the logs into the search index; Postgres stays the record' },
};

// The two kinds that used to fall to the default, and be described by it.
PRIORITIES['trust.assess'] = 25;
PRIORITIES['posts.notify_failures'] = 21;

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
  const task = TASKS[job.kind];
  return {
    priority,
    resource,
    agent: task?.agent ?? '',
    requires: task?.requires ?? [],
    coordination: {
      priority,
      resource,
      agent: task?.agent ?? null,
      requires: task?.requires ?? [],
      // The plain-English reason, for the person reviewing the assignment.
      // Declared per kind rather than guessed from the number: the guess
      // described two kinds as producers when neither produces anything.
      reason: task?.reason ?? 'undeclared kind — no agent, priority or reason was chosen for it',
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
export async function recordDispatch({ job, deferredBehind = null, higherPriorityWaiting = null, chosenBy = null }, client) {
  return recordAction(
    {
      actor: ACTOR,
      action: deferredBehind ? 'task.deferred' : 'task.dispatched',
      entityType: 'job',
      entityId: job.id,
      authorId: job.author_id,
      metadata: {
        kind: job.kind,
        // Who the work was given to, and on what grounds (STORY-040) — the
        // record a reviewer checks an assignment against.
        agent: job.agent || null,
        priority: job.priority,
        reason: job.coordination?.reason ?? null,
        resource: job.resource,
        requires: job.requires ?? [],
        ...(deferredBehind ? { deferredBehind } : {}),
        ...(job.deferred_reason && !deferredBehind ? { waitedFor: job.deferred_reason } : {}),
        ...(chosenBy ? { chosenBy } : {}),
        ...(higherPriorityWaiting ? { higherPriorityWaiting } : {}),
      },
    },
    client,
  );
}
