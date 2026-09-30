/**
 * STORY-062 acceptance tests — scalability monitored, alerts raised.
 *
 *   Given monitoring tools are set up, when system performance metrics are
 *   collected, then alerts are triggered for any anomalies or resource
 *   constraints.
 *
 * Measured before: request timings lived in an in-memory ring per instance
 * (STORY-027), readable only through the API; nothing exported metrics, and
 * nothing alerted on latency, errors, backlog or memory.
 *
 * The rules' own firing logic is tested by `promtool test rules
 * deploy/helm/author-launch-engine/files/prometheus/alerts.test.yml` (CI's `monitoring` job). Here: the API
 * exports every metric the rules read, keeps /metrics private, and turns an
 * Alertmanager notification into an anomaly escalated to the operators.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import YAML from 'yaml';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery } from '../src/db/pool.js';

const stamp = Date.now();
let server;
let root;
const saved = { metrics: config.metricsToken, am: config.alertmanagerToken };
const rules = YAML.parse(readFileSync(new URL('../../deploy/helm/author-launch-engine/files/prometheus/alerts.yml', import.meta.url), 'utf8'));

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}`;
  config.alertmanagerToken = 'am-test-token';
});

after(async () => {
  Object.assign(config, { metricsToken: saved.metrics, alertmanagerToken: saved.am });
  await ownerQuery("DELETE FROM anomaly_events WHERE fingerprint LIKE $1", [`%${stamp}%`]);
  await new Promise((r) => server.close(r));
  await closePool();
});

describe('STORY-062: performance metrics are collected', () => {
  let text;
  before(async () => {
    await fetch(`${root}/api/health`);
    text = await (await fetch(`${root}/metrics`)).text();
  });

  it('every metric an alert rule reads is exported — a renamed metric cannot silently disable an alert', () => {
    const exprs = rules.groups.flatMap((g) => g.rules.map((r) => r.expr)).join('\n');
    const used = [...new Set(exprs.match(/\bale_[a-z0-9_]+/g))].map((m) => m.replace(/_(bucket|count|sum)$/, ''));
    for (const name of used) assert.match(text, new RegExp(`^${name}(_bucket|_count|_sum)?[{ ]`, 'm'), `${name} is read by alerts.yml and not exported`);
  });

  it('requests are labelled by route pattern, not by raw path', () => {
    assert.match(text, /ale_http_request_duration_seconds_count\{[^}]*route="\/api\/health"/);
    assert.ok(!/route="[^"]*\/\d+/.test(text), 'no ids in route labels — they would explode the series');
  });

  it('is not public: not under /api, and behind a token when one is set', async () => {
    assert.notEqual((await fetch(`${root}/api/metrics`)).status, 200);
    config.metricsToken = 'scrape-secret';
    try {
      assert.equal((await fetch(`${root}/metrics`)).status, 401);
      assert.equal((await fetch(`${root}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } })).status, 200);
    } finally {
      config.metricsToken = saved.metrics;
    }
  });
});

describe('STORY-062: alerts reach a person', () => {
  const alert = (status) => ({
    alerts: [{
      status,
      fingerprint: `backlog-${stamp}`,
      labels: { alertname: 'AleJobBacklog', severity: 'high', instance_name: 'api-1' },
      annotations: { summary: 'Background work is falling behind', description: 'The oldest due job has waited 20m.' },
      startsAt: new Date().toISOString(),
    }],
  });
  const post = (body, token = 'am-test-token') => fetch(`${root}/api/alerts/prometheus`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const event = async () => (await ownerQuery('SELECT * FROM anomaly_events WHERE fingerprint = $1 ORDER BY id DESC LIMIT 1', [`prometheus.AleJobBacklog|backlog-${stamp}`])).rows[0];

  it('refuses an alert without Alertmanager\'s token', async () => {
    assert.equal((await post(alert('firing'), 'wrong')).status, 401);
  });

  it('a firing alert becomes an anomaly, escalated to the operators at once', async () => {
    const r = await post(alert('firing'));
    assert.equal(r.status, 200);
    const e = await event();
    assert.equal(e.status, 'open');
    assert.equal(e.author_id, null, 'system-wide');
    assert.match(e.summary, /falling behind/);
    assert.ok(e.escalated_at, 'escalated');
    assert.ok(e.escalated_to.includes('ops@example.test'), 'to whoever holds system.operate');
  });

  it('the same alert again is counted, not re-announced; its resolution closes it', async () => {
    await post(alert('firing'));
    assert.equal((await event()).occurrences, 2);
    await post(alert('resolved'));
    const e = await event();
    assert.equal(e.status, 'resolved');
    assert.equal(e.resolved_by, 'Prometheus');
  });
});
