/**
 * What this API instance has been answering, and how (STORY-027).
 *
 * "Up" is a low bar. An instance answering every request with a 500 in 4ms is
 * up, ready, and useless — so the heartbeat carries this alongside it, and the
 * dashboard can say "up, 0.4% errors, p95 41ms" instead of a green dot.
 *
 * In memory, per process, and deliberately small: a ring of the last N
 * requests rather than a table of every one. It is a *snapshot* of recent
 * behaviour, shipped on each heartbeat; the row of record is the heartbeat
 * that carried it. Writing a row per request would make the monitoring the
 * heaviest thing the database does.
 */

const WINDOW = 500;

const samples = new Array(WINDOW);
let next = 0;
let total = 0;
let errors = 0;
let since = new Date();

/** Express middleware. Measures every request that finishes, including 404s. */
export function observeRequests() {
  return (req, res, nextFn) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      record({ ms, status: res.statusCode });
    });
    nextFn();
  };
}

/** Records one finished request. Exported so tests can feed it directly. */
export function record({ ms, status }) {
  samples[next] = { ms, status };
  next = (next + 1) % WINDOW;
  total += 1;
  if (status >= 500) errors += 1;
}

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
};

/**
 * The numbers as they stand.
 *
 * `errorRate` is over the window, not the lifetime — an instance that had a
 * bad minute an hour ago should not carry it forever, and one that is failing
 * *now* should not have it diluted by a good morning. Lifetime totals are
 * reported beside it so the two are not confused.
 */
export function snapshot() {
  const recent = samples.filter(Boolean);
  const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
  const recentErrors = recent.filter((s) => s.status >= 500).length;
  return {
    window: recent.length,
    requests: total,
    errors,
    recentErrors,
    errorRate: recent.length === 0 ? null : Math.round((recentErrors / recent.length) * 1000) / 1000,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
    since,
  };
}

/** Test hook. */
export function __reset() {
  samples.fill(undefined);
  next = 0;
  total = 0;
  errors = 0;
  since = new Date();
}
