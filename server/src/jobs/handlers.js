import { query } from '../db/pool.js';
import { draftApproachingKits } from '../services/milestoneWatcher.js';
import { sendOutreachMessage } from '../services/outreachSender.js';
import { notifyPendingReviews, notifyRaisedEscalations } from '../services/reviewNotifier.js';
import { notifyAwaitingApproval } from '../agents/approvalNotificationAgent.js';
import { sealAndVerify } from '../agents/auditSecurityAgent.js';
import { monitorPressMaterials, trustDashboard } from '../agents/trustMonitoringAgent.js';
import { publishDue } from '../services/scheduler.js';
import { alertOnBreaches } from '../services/trustHistory.js';
import { notifyFailedPublishes } from '../services/publishFailureNotifier.js';
import { monitorAndAlert } from '../services/healthMonitoring.js';
import { trackEngagement } from '../services/performanceMetrics.js';
import { config } from '../config.js';
import { aggregate, reconcile } from '../services/searchIndex.js';
import { attemptSms } from '../services/sms.js';

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
    // Author-scoped: the person who needs telling is this tenant's reviewer,
    // and a failed post belongs to exactly one tenant (STORY-025).
    kind: 'posts.notify_failures',
    scope: 'author',
    describe: (job) => `tell reviewers about posts that failed to publish for author ${job.author_id}`,
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
  {
    // Author-scoped, like everything that reads one tenant's posts. Before
    // STORY-029 engagement was collected when a human pressed a button —
    // zero sweeps, two collections ever — and "tracked" means on a timer.
    kind: 'engagement.collect',
    scope: 'author',
    describe: (job) => `collect engagement for every published post of author ${job.author_id}`,
  },
  {
    // Global: an outage has no tenant (STORY-027). The worker running this is
    // what notices a dead API; the API's own timer is what notices a dead
    // worker. Neither can notice itself.
    kind: 'system.health_check',
    scope: 'global',
    describe: () => 'check every component is answering, and page someone if one is not',
  },
  // Only where there is an index to fill (STORY-055). Global: the logs are
  // one log each, and two per-tenant runs would race on the same mark.
  ...(config.elasticsearchUrl
    ? [{ kind: 'search.aggregate', scope: 'global', describe: () => 'copy new log rows and a metrics snapshot to the search index, then reconcile' }]
    : []),
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
      failed: result.failed?.length ?? 0,
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
  /**
   * STORY-025's sweep. The publish failure was recorded and nobody was told;
   * this is the half of the acceptance clause that did not exist.
   */
  'posts.notify_failures': async ({ job }) => {
    const authorId = Number(job.author_id);
    const result = await notifyFailedPublishes({ authorId });
    return {
      notified: result.notified.length,
      announced: result.announced,
      skipped: result.reason,
    };
  },

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

  /** STORY-029's tracker. Appends a reading per published post; mocked, and says so. */
  'engagement.collect': async ({ job }) => trackEngagement({ authorId: Number(job.author_id) }),

  /**
   * STORY-027's monitor. Probes the database and every live instance, logs a
   * row per target, opens or resolves an outage on the transition, and tells
   * the operators once per outage.
   */
  'system.health_check': async () => {
    const result = await monitorAndAlert({});
    return {
      recorded: result.recorded,
      database: result.database.status,
      api: result.components.api?.status ?? null,
      worker: result.components.worker?.status ?? null,
      instances: result.instances.length,
      outagesStarted: result.started.map((o) => o.component),
      outagesResolved: result.resolved.map((o) => o.component),
      retired: result.retired.length,
      alerted: result.alert.alerted.length,
      alertSkipped: result.alert.reason,
    };
  },

  /**
   * STORY-013's integrity check.
   *
   * Seals what is new, then recomputes every seal from the live rows. It cannot
   * stop anyone rewriting history; it makes sure that afterwards somebody knows.
   */
  'search.aggregate': async () => {
    const run = await aggregate({});
    const checked = await reconcile({});
    return {
      indexed: Object.fromEntries(run.sources.map((s) => [s.source, s.indexed])),
      repaired: checked.reduce((a, c) => a + c.filled + c.rewritten, 0) + run.sources.reduce((a, s) => a + s.repaired, 0),
      inSync: checked.every((c) => c.inSync),
      tookMs: run.tookMs,
    };
  },
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
      failed: result.failed?.length ?? 0,
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
  // A text Twilio could not take earlier (STORY-037). The service records the
  // outcome and schedules the next try itself; the job only asks.
  'sms.send': async ({ job }) => {
    const m = await attemptSms(Number(job.payload.messageId));
    return { messageId: m.id, status: m.status, attempts: m.attempts };
  },
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
    : job.kind === 'sms.send'
      ? `retry text message ${job.payload?.messageId}`
      : job.kind);
