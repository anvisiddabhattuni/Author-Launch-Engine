/**
 * Slow reports, served from the last result while a fresh one is worked out.
 *
 * Found live (2026-10-06): with 166,000 audit entries, the trust dashboard
 * took 70 s and the governance score 65 s — every view re-verified every seal
 * by decrypting the whole log — and the score card polls every 15 s, so slow
 * requests stacked on each other. A trust page nobody can open protects
 * nothing.
 *
 * Each report keeps its last result. A request gets it at once; if it is older
 * than its age limit, one refresh starts in the background (never two at once).
 * Only the very first request waits, and `warm` makes even that happen at
 * start-up instead of on someone's screen. Results carry `computedAt`, so the
 * page can say how fresh they are.
 *
 * Off (age 0) outside production: the tests tamper with the log and expect the
 * very next read to say so.
 */
import { outsideTenantScope } from '../db/pool.js';

const entries = new Map();

function refresh(key, compute) {
  const entry = entries.get(key) ?? {};
  // System reads, run outside any request's tenant scope: a background refresh
  // can outlive the request that started it, and its transaction with it.
  entry.pending = outsideTenantScope(compute)
    .then((value) => {
      entries.set(key, { value, at: Date.now(), pending: null });
      return value;
    })
    .catch((error) => {
      const current = entries.get(key);
      if (current) current.pending = null;
      throw error;
    });
  entries.set(key, entry);
  return entry.pending;
}

/** The last result for `key`, refreshed in the background once older than `maxAgeMs`. */
export function cachedReport(key, maxAgeMs, compute) {
  if (!(maxAgeMs > 0)) return compute();
  const entry = entries.get(key);
  if (entry?.value !== undefined) {
    if (Date.now() - entry.at > maxAgeMs && !entry.pending) {
      refresh(key, compute).catch((e) => console.warn(`[reportCache] ${key} refresh failed: ${e.message}`));
    }
    return Promise.resolve(entry.value);
  }
  return entry?.pending ?? refresh(key, compute);
}

/** Works a report out ahead of the first request. Failures are logged, never thrown. */
export function warm(key, compute) {
  refresh(key, compute).catch((e) => console.warn(`[reportCache] warming ${key} failed: ${e.message}`));
}

/** For tests: forget everything. */
export const clearReports = () => entries.clear();
