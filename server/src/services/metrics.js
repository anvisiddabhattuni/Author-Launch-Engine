import { hostname } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

import client from 'prom-client';

import { config } from '../config.js';
import { outsideTenantScope, pool } from '../db/pool.js';

/**
 * Performance metrics for Prometheus (STORY-062 / REQ-016) — Trust and
 * Monitoring Agent.
 *
 * What scaling decisions need: how long requests take and how many fail, per
 * route; how much work is waiting and how old the oldest is; whether the
 * database pool is saturated; memory, CPU and event-loop lag per instance. The
 * alert rules in deploy/helm/author-launch-engine/files/prometheus/alerts.yml are written against these names,
 * and `promtool test rules` checks they fire when they should.
 *
 * Served at GET /metrics on the API's own port — not under /api, so the public
 * entrance (Caddy → nginx, which forwards only /api/) never exposes it. With
 * METRICS_TOKEN set, a scrape must also carry it.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ instance_name: hostname() });
client.collectDefaultMetrics({ register: registry, prefix: 'ale_' });

const httpDuration = new client.Histogram({
  name: 'ale_http_request_duration_seconds',
  help: 'API request duration, by route pattern and status class',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Called from the request observer for every finished request. Route patterns, never raw paths: ids would explode the series. */
export function observeHttp({ method, route, status, seconds }) {
  httpDuration.observe({ method, route: route ?? 'unmatched', status_class: `${Math.floor(status / 100)}xx` }, seconds);
}

// Read at scrape time, so a value is never older than the scrape.
const gauge = (name, help, labelNames, collect) => new client.Gauge({ name, help, labelNames, registers: [registry], collect });
const safely = (fn) => async function collect() {
  try {
    await outsideTenantScope(() => fn(this));
  } catch {
    // A failed read leaves the gauge unset; `up` and the API's own health say why.
  }
};

gauge('ale_jobs', 'Background jobs, by status', ['status'], safely(async (g) => {
  const { rows } = await pool.query('SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status');
  g.reset();
  for (const r of rows) g.set({ status: r.status }, r.n);
}));
gauge('ale_jobs_oldest_queued_seconds', 'Age of the oldest job due and still waiting', [], safely(async (g) => {
  const { rows: [r] } = await pool.query("SELECT EXTRACT(EPOCH FROM now() - MIN(run_at))::float AS s FROM jobs WHERE status = 'queued' AND run_at <= now()");
  g.set(Math.max(0, r.s ?? 0));
}));
gauge('ale_db_pool_connections', 'Database pool connections, by state', ['state'], safely(async (g) => {
  g.set({ state: 'total' }, pool.totalCount);
  g.set({ state: 'idle' }, pool.idleCount);
  g.set({ state: 'waiting' }, pool.waitingCount);
}));
gauge('ale_anomalies_open', 'Anomalies open or acknowledged, by severity (STORY-059)', ['severity'], safely(async (g) => {
  const { rows } = await pool.query("SELECT severity, COUNT(*)::int AS n FROM anomaly_events WHERE status IN ('open', 'acknowledged') GROUP BY severity");
  g.reset();
  for (const s of ['high', 'medium']) g.set({ severity: s }, rows.find((r) => r.severity === s)?.n ?? 0);
}));
gauge('ale_integration_circuit_open', '1 while an integration\'s circuit is open (STORY-038)', ['service'], safely(async (g) => {
  const { rows } = await pool.query('SELECT service, state FROM integration_circuits');
  g.reset();
  for (const r of rows) g.set({ service: r.service }, r.state === 'open' ? 1 : 0);
}));
gauge('ale_payments_failed_unreviewed', 'Failed payments no person has reviewed (STORY-036)', [], safely(async (g) => {
  const { rows: [r] } = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE needs_review AND reviewed_at IS NULL');
  g.set(r.n);
}));
gauge('ale_sms_retrying', 'Texts waiting for a retry (STORY-037)', [], safely(async (g) => {
  const { rows: [r] } = await pool.query("SELECT COUNT(*)::int AS n FROM sms_messages WHERE status = 'retrying'");
  g.set(r.n);
}));

/** GET /metrics. */
export async function metricsHandler(req, res) {
  if (config.metricsToken) {
    const given = Buffer.from(String(req.get('authorization') ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(config.metricsToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).send('metrics token required\n');
  }
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
}
