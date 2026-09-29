/**
 * STORY-040 acceptance tests.
 *
 *   "Tasks are prioritized and assigned by the central task manager" → given
 *       several tasks queued, when the task manager evaluates them, they are
 *       assigned to agents by priority and resource availability.
 *   Trust: task assignments are logged and can be reviewed for correctness.
 *
 * Measured before this story: STORY-011's coordinator ordered by priority and
 * held exclusive resources, and —
 *   * the deferral logging it documented was never called;
 *   * two kinds fell to the default priority and were described by a reason
 *     that was false for both;
 *   * "availability" knew nothing of integrations — with email's circuit open,
 *     the approval notifier ran, every send was refused, and it reported
 *     "notified: 2".
 *
 * Every test drives the queue by job id, so it cannot pick up another suite's
 * work running alongside.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { notifyAwaitingApproval } from '../src/agents/approvalNotificationAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { HANDLERS, RECURRING } from '../src/jobs/handlers.js';
import { enqueue, recordDeferrals, runOnce } from '../src/jobs/queue.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { PRIORITIES, TASKS, planFor } from '../src/services/coordination.js';
import { runChecks } from '../src/services/governance.js';

let authorId;
const stamp = Date.now();
const key = (s) => `tm-${stamp}-${s}`;

before(async () => {
  const { rows } = await query('INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING id', [
    'Task Manager Author', `tm-${stamp}@example.test`,
  ]);
  authorId = Number(rows[0].id);
});

/**
 * A stand-in for email. Opening the real email circuit would refuse every
 * email the suites running alongside this one send — which it did, on the
 * first full run, and took the outage-alert tests down with it.
 */
const SVC = `tm-mail-${stamp}`;
const needsSvc = async (jobId) => query('UPDATE jobs SET requires = $2 WHERE id = $1', [jobId, [SVC]]);

after(async () => {
  await query('DELETE FROM integration_circuits WHERE service = $1', [SVC]);
  await query("DELETE FROM jobs WHERE idempotency_key LIKE $1", [`tm-${stamp}-%`]);
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('Every task kind is assigned, on declared grounds', () => {
  it('every kind the worker runs names its agent, its priority and a reason', () => {
    const kinds = new Set([...RECURRING.map((r) => r.kind), ...Object.keys(HANDLERS)]);
    const missing = [...kinds].filter((k) => !TASKS[k] || !(k in PRIORITIES) || !TASKS[k].agent || !TASKS[k].reason);
    assert.deepEqual(missing, []);
  });

  it('the two kinds that fell to the default are declared, and not described as producers', () => {
    for (const kind of ['trust.assess', 'posts.notify_failures']) {
      const plan = planFor({ kind, author_id: 1 });
      assert.notEqual(plan.priority, 50, `${kind} still takes the default`);
      assert.doesNotMatch(plan.coordination.reason, /produces work other agents react to/);
    }
  });

  it('a job carries the agent it is assigned to and what it needs', async () => {
    const { job } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: key('carry'), authorId });
    assert.equal(job.agent, 'ApprovalNotificationAgent');
    assert.deepEqual(job.requires, ['email']);
  });
});

describe('Scenario: assigned by priority and resource availability', () => {
  it('a task whose integration is down waits without spending an attempt, and says why — once', async () => {
    const retryAt = new Date(Date.now() + 3_600_000);
    await query(
      `INSERT INTO integration_circuits (service, state, consecutive_failures, opened_at, retry_at, last_error)
       VALUES ($2,'open',5,now(),$1,'relay down')
       ON CONFLICT (service) DO UPDATE SET state = 'open', opened_at = now(), retry_at = $1`,
      [retryAt, SVC],
    );
    const { job } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: key('held'), authorId });
    await needsSvc(job.id);
    const soon = new Date(Date.now() + 1000);

    assert.equal(await runOnce({ now: soon, jobId: job.id }), null, 'ran while email was down');
    const first = await recordDeferrals({ now: soon });
    const again = await recordDeferrals({ now: new Date(soon.getTime() + 5000) });
    assert.ok(first.some((d) => d.id === Number(job.id)), 'the wait was not recorded');
    assert.ok(!again.some((d) => d.id === Number(job.id)), 'recorded again on the next poll');

    const { rows } = await query('SELECT attempts, status, deferred_reason FROM jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].attempts, 0, 'an attempt was spent on work that could not be done');
    assert.equal(rows[0].status, 'queued');
    assert.match(rows[0].deferred_reason, new RegExp(`waiting for ${SVC}: its circuit is open until`));

    const entry = (await listAuditLog({ authorId, entityType: 'job', limit: 50 }))
      .find((e) => e.action === 'task.deferred' && e.entity_id === String(job.id));
    assert.ok(entry, 'task.deferred was never written — as before this story');
    assert.equal(entry.metadata.agent, 'ApprovalNotificationAgent');
  });

  it('is released when the circuit will take a trial — or nothing would ever test it', async () => {
    const { rows: [circuit] } = await query('SELECT retry_at FROM integration_circuits WHERE service = $1', [SVC]);
    const { rows: [job] } = await query('SELECT id FROM jobs WHERE idempotency_key = $1', [key('held')]);
    await query('DELETE FROM integration_circuits WHERE service = $1', [SVC]); // the provider is back
    const ran = await runOnce({ now: new Date(new Date(circuit.retry_at).getTime() + 1000), jobId: job.id });
    assert.ok(ran, 'held past the point the circuit would accept a call');
    assert.equal(ran.attempts, 1);
  });

  it('a task whose resource another agent holds waits, and the wait names the holder', async () => {
    // A resource only this test uses. The real one, author:<id>:press, is also
    // taken by the recurring sweeps other suites' worker ticks create for every
    // author — including this one — and once in about ten runs one held it at
    // exactly this moment.
    const resource = `test:${stamp}:held`;
    const { job: holder } = await enqueue({ kind: 'press.draft_approaching', idempotencyKey: key('holder'), authorId });
    await query("UPDATE jobs SET status = 'running', claimed_at = now(), resource = $2 WHERE id = $1", [holder.id, resource]);
    const { job: waiter } = await enqueue({ kind: 'trust.monitor_escalations', idempotencyKey: key('waiter'), authorId });
    await query('UPDATE jobs SET resource = $2 WHERE id = $1', [waiter.id, resource]);
    waiter.resource = resource;

    const now = new Date(Date.now() + 1000);
    assert.equal(await runOnce({ now, jobId: waiter.id }), null);
    await recordDeferrals({ now });
    const { rows } = await query('SELECT deferred_reason FROM jobs WHERE id = $1', [waiter.id]);
    assert.match(rows[0].deferred_reason, new RegExp(`held by job ${holder.id} \\(press.draft_approaching\\)`));
    await query("UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1", [holder.id]);
  });
});

describe('Assignments can be reviewed for correctness', () => {
  it('each dispatch records its agent, its grounds, and every higher-priority task it went ahead of — with the blocker', async () => {
    // A higher-priority task, blocked by an unavailable integration…
    await query(
      `INSERT INTO integration_circuits (service, state, consecutive_failures, opened_at, retry_at, last_error)
       VALUES ($1,'open',5,now(),now() + interval '1 hour','relay down')
       ON CONFLICT (service) DO UPDATE SET state = 'open', opened_at = now(), retry_at = now() + interval '1 hour'`,
      [SVC],
    );
    const { job: high } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: key('high'), authorId });
    await needsSvc(high.id);
    // …and a lower-priority one that can run.
    const { job: low } = await enqueue({ kind: 'engagement.collect', idempotencyKey: key('low'), authorId });
    assert.ok(high.priority > low.priority);

    await runOnce({ now: new Date(Date.now() + 1000), jobId: low.id });
    const entry = (await listAuditLog({ authorId, entityType: 'job', limit: 50 }))
      .find((e) => e.action === 'task.dispatched' && e.entity_id === String(low.id));
    assert.equal(entry.metadata.agent, 'TrustMonitoringAgent');
    assert.ok(entry.metadata.reason);
    const passed = entry.metadata.higherPriorityWaiting.find((h) => h.id === Number(high.id));
    assert.ok(passed, 'the review record does not show what this task went ahead of');
    assert.match(passed.blockedBy, new RegExp(`waiting for ${SVC}`));
    assert.equal(entry.metadata.chosenBy, 'request', 'run by id is a request, not a priority decision');
    await query('DELETE FROM integration_circuits WHERE service = $1', [SVC]);
  });

  it('the governance check passes on correct assignments, and fails on one that kept a higher task waiting', async () => {
    let check = (await runChecks({})).find((c) => c.id === 'tasks.priority_respected');
    const before = check.violations;
    // Went ahead of a higher-priority task with nothing blocking it, and that
    // task was still waiting a minute later: a wrong choice.
    const { job: starved } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: key('starved'), authorId });
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, author_id, metadata, created_at)
       VALUES ('CoordinationGovernanceAgent','task.dispatched','job','fixture',$1,$2, now() - interval '1 minute')`,
      [authorId, JSON.stringify({ chosenBy: 'priority', higherPriorityWaiting: [{ id: Number(starved.id), kind: 'approvals.notify_waiting', priority: 19, blockedBy: null }] })],
    );
    // The same, except the higher task started 8ms later: a race between
    // workers, not a wrong choice — the case the first version counted.
    const { job: raced } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: key('raced'), authorId });
    await query("UPDATE jobs SET status = 'done', claimed_at = now() + interval '8 milliseconds' WHERE id = $1", [raced.id]);
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, author_id, metadata)
       VALUES ('CoordinationGovernanceAgent','task.dispatched','job','fixture',$1,$2)`,
      [authorId, JSON.stringify({ chosenBy: 'priority', higherPriorityWaiting: [{ id: Number(raced.id), kind: 'approvals.notify_waiting', priority: 19, blockedBy: null }] })],
    );
    check = (await runChecks({})).find((c) => c.id === 'tasks.priority_respected');
    assert.equal(check.violations, before + 1, 'counted the race, or missed the starved task');
    await query("DELETE FROM jobs WHERE id = $1", [starved.id]);
  });
});

describe('A notice that was not sent is not counted as sent', () => {
  it('the approval notifier reports failures apart from deliveries, and logs them as failures', async () => {
    await query('INSERT INTO reviewers (author_id, name, email, role) VALUES ($1,$2,$3,$4)', [
      authorId, 'TM Reviewer', `tm-reviewer-${stamp}@example.test`, 'publicist',
    ]);
    const { rows: [book] } = await query(
      "INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x','{craft}') RETURNING id",
      [authorId],
    );
    await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
       VALUES ($1,$2,'twitter','waiting on a human','pending_approval',0.9,CURRENT_DATE)`,
      [authorId, book.id],
    );
    const refusing = { name: 'down', async send() { throw Object.assign(new Error('email is not being called: circuit open'), { status: 503 }); } };
    const result = await notifyAwaitingApproval({ authorId, notifier: refusing });
    assert.equal(result.notified.length, 0, 'a refused send was counted as notified');
    assert.equal(result.failed.length, 1);
    const entry = (await listAuditLog({ authorId, limit: 20 })).find((e) => e.action.startsWith('approval.notif'));
    assert.equal(entry.action, 'approval.notify_failed');
  });
});
