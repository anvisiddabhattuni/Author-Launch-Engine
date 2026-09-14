import { query } from '../db/pool.js';
import { draftApproachingKits } from '../services/milestoneWatcher.js';
import { sendOutreachMessage } from '../services/outreachSender.js';
import { notifyPendingReviews, notifyRaisedEscalations } from '../services/reviewNotifier.js';
import { notifyAwaitingApproval } from '../agents/approvalNotificationAgent.js';
import { sealAndVerify } from '../agents/auditSecurityAgent.js';
import { monitorPressMaterials, trustDashboard } from '../agents/trustMonitoringAgent.js';
import { publishDue } from '../services/scheduler.js';
import { alertOnBreaches } from '../services/trustHistory.js';

/**
 * What the worker knows how to do (STORY-065).
 *
 * Every handler is an existing service function that was already written to be
 * called on a timer and never was. Nothing new is done here and nothing is
 * re-implemented — the worker is the caller those functions were waiting for.
 *
 * None of them can approve anything. STORY-064 made approval require a session
 * and the worker has none; what it does is act on work a human already approved.
 * That distinction is the whole reason a worker is safe to run unattended.
 */

/**
 * `scope: 'author'` means one job per author per interval; `'global'` means one
 * job full stop. `every` is how often the sweep is due, and is what its
 * idempotency key buckets on.
 */
export const RECURRING = [
  {
    kind: 'posts.publish_due',
    scope: 'global',
    describe: () => 'publish scheduled posts whose time has come',
  },
  {
    kind: 'press.draft_approaching',
    scope: 'author',
    describe: (job) => `draft kits for milestones approaching for author ${job.author_id}`,
  },
  {
    kind: 'reviews.notify_pending',
    scope: 'author',
    describe: (job) => `tell reviewers what is waiting for author ${job.author_id}`,
  },
  {
    kind: 'trust.monitor_escalations',
    scope: 'author',
    describe: (job) => `re-check escalation decisions for author ${job.author_id}`,
  },
  {
    kind: 'approvals.notify_waiting',
    scope: 'author',
    describe: (job) => `tell reviewers what is waiting on them for author ${job.author_id}`,
  },
  {
    // The sweep this story exists for (STORY-021). Author-scoped because the
    // dashboard is, and because the person who needs telling about a breach is
    // that tenant's reviewer.
    kind: 'trust.assess',
    scope: 'author',
    describe: (job) => `assess trust and alert on new breaches for author ${job.author_id}`,
  },
  {
    // Global: the audit log is one log across every tenant, and an integrity
    // check that ran per author would seal overlapping ranges of it.
    kind: 'audit.seal_and_verify',
    scope: 'global',
    describe: () => 'seal new audit rows and re-verify every seal',
  },
];

export const HANDLERS = {
  /** STORY-001's publisher. Only touches posts a human approved and scheduled. */
  'posts.publish_due': async () => {
    const published = await publishDue();
    return { published: published.length, ids: published.map((p) => p.id) };
  },

  /** STORY-004's watcher. Drafts on detection; drafting is not sending. */
  'press.draft_approaching': async ({ job }) => {
    const result = await draftApproachingKits({ authorId: Number(job.author_id) });
    return { drafted: result.drafted.length, skipped: result.skipped?.length ?? 0 };
  },

  /** STORY-007's notifier. Idempotent per reviewer per kit on its own account. */
  'reviews.notify_pending': async ({ job }) => {
    const result = await notifyPendingReviews({ authorId: Number(job.author_id) });
    return {
      notified: result.notified.length,
      skipped: result.skipped.length,
      unreachable: result.unreachable,
    };
  },

  /**
   * STORY-008's monitor. An independent re-derivation of every escalation
   * decision still awaiting a human, followed by telling someone about anything
   * it had to raise itself.
   *
   * On a schedule rather than only at draft time on purpose: a threshold
   * tightened today should catch work drafted yesterday that is still sitting
   * unapproved.
   */
  /**
   * STORY-021's sweep. Before this, the assessment ran only when a human opened
   * the page — so a broken invariant waited to be noticed, and "when did this
   * start failing" had no answer. Running it on a timer is what turns the score
   * into a series and a breach into an event with a time on it.
   */
  'trust.assess': async ({ job }) => {
    const authorId = Number(job.author_id);
    const dashboard = await trustDashboard({ authorId });
    const alert = await alertOnBreaches({ authorId, started: dashboard.changed.started });
    return {
      status: dashboard.governance.status,
      score: dashboard.governance.score,
      startedFailing: dashboard.changed.started.map((e) => e.check_id),
      recovered: dashboard.changed.recovered.map((e) => e.check_id),
      alerted: alert.alerted.length,
      alertSkipped: alert.reason,
    };
  },

  'trust.monitor_escalations': async ({ job }) => {
    const authorId = Number(job.author_id);
    const scan = await monitorPressMaterials({ authorId });
    const alerts = await notifyRaisedEscalations({ authorId });
    return {
      examined: scan.examined,
      raised: scan.raised.length,
      confirmed: scan.confirmed.length,
      producerStricter: scan.producerStricter.length,
      notified: alerts.notified.length,
    };
  },

  /**
   * STORY-013's integrity check.
   *
   * Seals what is new, then recomputes every seal from the live rows. It cannot
   * stop anyone rewriting history; it makes sure that afterwards somebody knows.
   */
  'audit.seal_and_verify': async () => {
    const { seal, verification } = await sealAndVerify();
    return {
      sealed: seal.sealed,
      rows: seal.rows ?? 0,
      status: verification.status,
      checkpoints: verification.checked,
      // Surfaced in the job result so a run that found tampering is visible in
      // the worker's own health view, not only in the log it was checking.
      tampering: verification.breaks.length > 0,
    };
  },

  /**
   * STORY-012's approval notifier.
   *
   * Everything a human has to decide except press kits, which STORY-007 already
   * mails about — two agents emailing about one kit is the drift STORY-008
   * removed. One digest per reviewer per sweep, and an item announced once is
   * never announced again however often this runs.
   */
  'approvals.notify_waiting': async ({ job }) => {
    const result = await notifyAwaitingApproval({ authorId: Number(job.author_id) });
    return {
      notified: result.notified.length,
      waiting: result.queue.total,
      alreadyKnown: result.skipped.length,
      unreachable: result.unreachable,
    };
  },

  /**
   * STORY-002's sender, enqueued per message when a human approves it.
   *
   * The service refuses anything not already approved, so a job that somehow
   * outlives a rejection fails loudly instead of sending — the gate is still in
   * the service, exactly where it has been since STORY-001.
   */
  'outreach.send': async ({ job }) => {
    const messageId = Number(job.payload.messageId);
    const { rows } = await query('SELECT status FROM outreach_messages WHERE id = $1', [messageId]);
    if (!rows[0]) throw new Error(`Outreach message ${messageId} no longer exists`);

    // Already gone. A retried job must not produce a second email, and the
    // honest way to say that is "this job's work is done" rather than letting
    // the service throw a 409 that would look like a failure and burn a retry.
    if (rows[0].status === 'sent') return { messageId, alreadySent: true };

    // Anything else that is not 'approved' — rejected after the job was queued,
    // say — is a real failure. The gate lives in the service and the worker
    // does not get to argue with it.
    const send = await sendOutreachMessage({ messageId });
    return { messageId, status: send?.status ?? 'sent' };
  },
};

export const describeJob = (job) =>
  RECURRING.find((r) => r.kind === job.kind)?.describe(job) ??
  (job.kind === 'outreach.send'
    ? `send approved outreach message ${job.payload?.messageId}`
    : job.kind);
