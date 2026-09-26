/**
 * STORY-027 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "System health monitoring" → when health checks are performed, system
 *       status is logged and displayed on the dashboard.
 *   "Availability alerts" → when an outage is detected, alerts are sent to the
 *       infrastructure team.
 *
 * Measured before this story: nothing performed a health check — `/health`
 * and `/ready` answered on demand and the answer was discarded — and the
 * `deployments` table called an instance running until it wrote a stop row,
 * which a process killed with SIGKILL cannot do. The worker had no row at all.
 * Nothing could alert, because every alert went to a tenant's reviewers and
 * an outage has no tenant.
 *
 * Every check here runs with an injected `now` and an injected `probe`, so no
 * test waits on a timer and none needs a second process to actually die.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { recordStart } from '../src/services/deployment.js';
import { CHECKS, runChecks } from '../src/services/governance.js';
import {
  ACTOR,
  alertOnOutages,
  defaultProbe,
  heartbeat,
  monitorAndAlert,
  operators,
  performHealthChecks,
  systemStatus,
} from '../src/services/healthMonitoring.js';
import { PERMISSIONS } from '../src/services/permissions.js';
import { __reset as resetStats, record, snapshot } from '../src/services/requestStats.js';
import { upsertUser } from '../src/services/auth.js';

/** A notifier that remembers instead of sending. */
const capture = () => {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { externalId: `captured_${sent.length}` };
    },
  };
};

/** Probes that answer whatever the test says, keyed by url. */
const probeFrom = (answers) => async (url) =>
  answers[url] ?? { status: 'down', latencyMs: 1, detail: `no answer configured for ${url}` };

let apiRow;
let workerRow;
let server;
let liveUrl;
/** The API answering, so a test about the worker is not also a test about the API. */
const apiUp = () => probeFrom({ [liveUrl]: { status: 'up', latencyMs: 2, detail: 'ready' } });

const stamp = Date.now();

before(async () => {
  // Nothing else's rows should decide these tests. Retire whatever the suite
  // before us left in the live set, and close any outage it opened.
  // Only the stale ones: another suite's freshly started row is harmless, and
  // closing it under that suite's feet would be this test causing the flake.
  await query(
    `UPDATE deployments SET stopped_at = now(), stop_reason = 'test setup'
      WHERE stopped_at IS NULL AND last_seen_at < now() - make_interval(secs => $1)`,
    [config.instanceStaleSeconds],
  );
  await query('UPDATE outages SET resolved_at = now() WHERE resolved_at IS NULL');
  await query("DELETE FROM health_checks WHERE checked_by LIKE 'test:%'");

  // A real app on a real port, so the default probe is tested against the
  // actual /api/ready rather than a stand-in.
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  liveUrl = `http://127.0.0.1:${server.address().port}`;

  apiRow = await recordStart({ version: `health-test-${stamp}-api`, component: 'api', url: liveUrl });
  workerRow = await recordStart({ version: `health-test-${stamp}-worker`, component: 'worker' });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await query("DELETE FROM outages WHERE detected_by LIKE 'test:%'");
  await query("DELETE FROM health_checks WHERE checked_by LIKE 'test:%'");
  await query("DELETE FROM deployments WHERE version LIKE 'health-test-%'");
  await query("DELETE FROM users WHERE email LIKE 'oncall-%@example.test'");
  await closePool();
});

describe('Scenario: health checks are performed, and status is logged', () => {
  it('the deployments table alone cannot tell a dead instance from a live one', async () => {
    // The finding this story starts from. Two rows, both "running" by the
    // only measure the table had — no stop row — and one of them has not
    // spoken for two minutes. (Not longer: past `instanceDeadSeconds` the
    // monitor retires the row, which is the last describe's subject.)
    await query("UPDATE deployments SET last_seen_at = now() - interval '2 minutes' WHERE id = $1", [workerRow.id]);
    const { rows } = await query(
      'SELECT id, stopped_at FROM deployments WHERE id = ANY($1::bigint[])',
      [[apiRow.id, workerRow.id]],
    );
    assert.ok(rows.every((r) => r.stopped_at === null), 'both rows claim to be running');
  });

  it('a check judges each instance from its heartbeat, and writes a row per target', async () => {
    const now = new Date();
    await heartbeat({ deploymentId: apiRow.id });
    const result = await performHealthChecks({ now, checkedBy: 'test:first', probe: apiUp() });

    assert.equal(result.recorded, true);
    assert.equal(result.database.status, 'up');
    const api = result.instances.find((i) => i.deploymentId === Number(apiRow.id));
    const worker = result.instances.find((i) => i.deploymentId === Number(workerRow.id));
    assert.equal(api.status, 'up');
    assert.equal(worker.status, 'down', 'a two-minute-old heartbeat was not judged down');
    assert.match(worker.detail, /heartbeat \d+s old/);

    // Logged: one row per target, with who checked and why.
    const { rows } = await query(
      "SELECT target, status, detail, checked_by FROM health_checks WHERE checked_by = 'test:first' ORDER BY id",
    );
    // Targets carry the component: the API and the worker under test share a
    // process, so `host:pid` alone would name both — and PIDs are reused
    // across restarts anyway.
    // A subset, not an equality: a dev server left running while the tests
    // run is a live instance too, and it is right for the check to see it.
    const targets = new Set(rows.map((r) => r.target));
    for (const expected of ['database', `api:${apiRow.instance}`, `worker:${workerRow.instance}`]) {
      assert.ok(targets.has(expected), `no health_checks row for ${expected}`);
    }
    assert.equal(rows.find((r) => r.target === `worker:${workerRow.instance}`).status, 'down');
  });

  it('the default probe asks the real /api/ready, from outside the process', async () => {
    const probed = await defaultProbe(liveUrl);
    assert.equal(probed.status, 'up', probed.detail);
    assert.ok(probed.latencyMs >= 0);

    // And a URL nothing answers on is down, not an exception.
    const nothing = await defaultProbe('http://127.0.0.1:1');
    assert.equal(nothing.status, 'down');
  });

  it('a fresh heartbeat with a failing probe is still not "up"', async () => {
    // The heartbeat proves the event loop turns. It does not prove the
    // instance can answer a request.
    await heartbeat({ deploymentId: apiRow.id });
    const result = await performHealthChecks({
      checkedBy: 'test:probe',
      probe: probeFrom({ [liveUrl]: { status: 'degraded', latencyMs: 8, detail: 'HTTP 503 — schema: 1 migration missing' } }),
    });
    const api = result.instances.find((i) => i.deploymentId === Number(apiRow.id));
    assert.equal(api.status, 'degraded');
    assert.match(api.detail, /503/);
  });

  it('is displayed: the read-model shows each instance with its latest verdict', async () => {
    const status = await systemStatus({});
    const worker = status.instances.find((i) => i.deploymentId === Number(workerRow.id));
    assert.equal(worker.status, 'down');
    assert.equal(status.components.worker.status, 'down');
    assert.ok(status.lastCheckAt, 'no check time to display');
    assert.ok(status.checksRecorded > 0);
  });

  it('carries what the instance has been answering, not only that it is up', () => {
    resetStats();
    for (let i = 0; i < 99; i += 1) record({ ms: 10 + i, status: 200 });
    record({ ms: 250, status: 500 });
    const stats = snapshot();
    assert.equal(stats.requests, 100);
    assert.equal(stats.errors, 1);
    assert.equal(stats.errorRate, 0.01);
    assert.ok(stats.p95Ms >= stats.p50Ms);
    assert.equal(stats.maxMs, 250);
  });
});

describe('Scenario: an outage is detected, and the infrastructure team is told', () => {
  let started;

  it('a component going down opens exactly one outage', async () => {
    const first = await performHealthChecks({ checkedBy: 'test:outage', probe: apiUp() });
    // The worker has been down for every check so far; the first run in the
    // previous describe already opened its outage.
    const { rows } = await query("SELECT * FROM outages WHERE component = 'worker' AND resolved_at IS NULL");
    assert.equal(rows.length, 1, 'one component, one open outage');
    started = rows;

    // Down since the last heartbeat, not since somebody looked.
    const lag = (new Date(rows[0].detected_at) - new Date(rows[0].down_since)) / 1000;
    assert.ok(lag > 100, `down_since should be the stale heartbeat, lag was ${lag}s`);
    assert.deepEqual(first.started.map((o) => o.component), [], 'a persisting outage was re-opened');
  });

  it('the infrastructure team is whoever holds system.operate', async () => {
    const before = await operators();
    assert.ok(before.every((o) => o.role === 'admin'), 'only admin holds it out of the box');

    await upsertUser({
      email: `oncall-${stamp}@example.test`,
      name: 'On Call',
      password: 'pager-duty',
      role: 'admin',
    });
    const now = await operators();
    assert.ok(now.some((o) => o.email === `oncall-${stamp}@example.test`));
    assert.equal(PERMISSIONS.SYSTEM_OPERATE, 'system.operate');
  });

  it('alerts them once, with when it went down and when it was noticed', async () => {
    const notifier = capture();
    const result = await alertOnOutages({ started, notifier });
    assert.ok(result.alerted.length > 0, `nobody alerted: ${result.reason}`);
    assert.ok(result.alerted.some((a) => a.operator === `oncall-${stamp}@example.test`));

    const message = notifier.sent[0];
    assert.match(message.subject, /Outage: worker down/);
    assert.match(message.body, /down since/);
    assert.match(message.body, /heartbeat \d+s old/);
    assert.equal(message.via, 'system.alert_outage');

    // And never again for this outage.
    const again = await alertOnOutages({ started, notifier });
    assert.deepEqual(again.alerted, []);
    assert.match(again.reason, /already alerted/);
  });

  it('is on the record as a detection, with the lag that grades the monitoring', async () => {
    const entries = await listAuditLog({ entityType: 'outage', limit: 50 });
    const detected = entries.find((e) => e.action === 'outage.detected' && e.metadata.component === 'worker');
    assert.ok(detected, 'no outage.detected row');
    assert.equal(detected.actor, ACTOR);
    assert.ok(detected.metadata.detectionLagSeconds > 0);
    const alerted = entries.find((e) => e.action === 'outage.alerted');
    assert.ok(alerted, 'no outage.alerted row');
  });

  it('resolves when the component answers again — never by time passing', async () => {
    await heartbeat({ deploymentId: workerRow.id });
    const result = await performHealthChecks({ checkedBy: 'test:recovery', probe: apiUp() });
    assert.deepEqual(result.resolved.map((o) => o.component), ['worker']);
    const { rows } = await query('SELECT resolved_at FROM outages WHERE id = $1', [started[0].id]);
    assert.notEqual(rows[0].resolved_at, null);

    const entries = await listAuditLog({ entityType: 'outage', limit: 50 });
    const resolved = entries.find((e) => e.action === 'outage.resolved');
    assert.ok(resolved.metadata.downForSeconds > 0);
    assert.equal(resolved.metadata.wasAlerted, true);
  });

  it('the governance dashboard sees an open outage as a degraded check', async () => {
    assert.ok(CHECKS.find((c) => c.id === 'system.no_open_outage'), 'no governance check for outages');
    const results = await runChecks({});
    const check = results.find((c) => c.id === 'system.no_open_outage');
    assert.equal(check.passed, true, 'an outage is still open after recovery');
  });

  it('an outage nobody can be told about is its own finding', async () => {
    // Take the permission away from everyone, briefly.
    await query("UPDATE users SET active = FALSE WHERE role = 'admin'");
    try {
      await query("UPDATE deployments SET last_seen_at = now() - interval '3 minutes' WHERE id = $1", [workerRow.id]);
      const result = await monitorAndAlert({ checkedBy: 'test:unreachable', probe: apiUp(), notifier: capture() });
      assert.deepEqual(result.started.map((o) => o.component), ['worker']);
      assert.deepEqual(result.alert.alerted, []);
      assert.match(result.alert.reason, /nobody holds/);

      const entries = await listAuditLog({ entityType: 'outage', limit: 50 });
      assert.ok(entries.find((e) => e.action === 'outage.unreachable'), 'silence was not recorded');

      // The claim was released, so a later grant can still be told.
      const { rows } = await query("SELECT alerted_at FROM outages WHERE component = 'worker' AND resolved_at IS NULL");
      assert.equal(rows[0].alerted_at, null);
    } finally {
      await query("UPDATE users SET active = TRUE WHERE role = 'admin'");
      await heartbeat({ deploymentId: workerRow.id });
      await performHealthChecks({ checkedBy: 'test:cleanup', probe: apiUp() });
    }
  });
});

describe('The live set stops lying about the dead', () => {
  it('retires an instance quiet for longer than the dead threshold, and says presumed', async () => {
    const { rows: ghost } = await query(
      `INSERT INTO deployments (version, component, instance, status, last_seen_at)
       VALUES ($1,'api',$2,'ready', now() - make_interval(secs => $3))
       RETURNING *`,
      [`health-test-${stamp}-ghost`, `ghost-host:${stamp}`, config.instanceDeadSeconds + 60],
    );
    const result = await performHealthChecks({ checkedBy: 'test:retire', probe: apiUp() });
    assert.ok(result.retired.some((r) => Number(r.id) === Number(ghost[0].id)), 'the ghost was not retired');

    const { rows } = await query('SELECT status, stop_reason, stopped_at, last_seen_at FROM deployments WHERE id = $1', [ghost[0].id]);
    assert.equal(rows[0].status, 'crashed');
    assert.match(rows[0].stop_reason, /presumed dead/);
    // Stopped when it was last seen, not when we noticed — the record says
    // what is known, not what is convenient.
    assert.equal(new Date(rows[0].stopped_at).getTime(), new Date(rows[0].last_seen_at).getTime());

    const entries = await listAuditLog({ entityType: 'deployment', limit: 50 });
    assert.ok(entries.find((e) => e.action === 'deployment.presumed_dead'));
  });

  it('a component that was never started is not_deployed, not down', async () => {
    // The distinction the dashboard has drawn since STORY-014 for the worker.
    await query("UPDATE deployments SET stopped_at = now(), stop_reason = 'test' WHERE id = $1", [workerRow.id]);
    const result = await performHealthChecks({ checkedBy: 'test:none', probe: apiUp() });
    assert.equal(result.components.worker.status, 'not_deployed');
    assert.deepEqual(result.started, [], 'an absent component opened an outage');
  });

  it('the sweep is on the worker\'s list, and the send path is declared', async () => {
    const { RECURRING, HANDLERS } = await import('../src/jobs/handlers.js');
    const { declaredPaths } = await import('../src/services/outboundPaths.js');
    assert.ok(RECURRING.find((r) => r.kind === 'system.health_check' && r.scope === 'global'));
    assert.equal(typeof HANDLERS['system.health_check'], 'function');
    assert.ok(declaredPaths().includes('system.alert_outage'));
  });
});
