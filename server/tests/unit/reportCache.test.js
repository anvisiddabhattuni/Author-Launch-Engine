/**
 * Slow reports served from their last result (services/reportCache.js).
 *
 * Measured before (live, 2026-10-06): the trust dashboard took 70 s and the
 * governance score 65 s per view, and the score card polls every 15 s.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { cachedReport, clearReports } from '../../src/services/reportCache.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let runs;
const slow = () => pause(40).then(() => (runs += 1));

beforeEach(() => { clearReports(); runs = 0; });

describe('a slow report, kept ready', () => {
  it('runs once for requests that arrive together', async () => {
    const [a, b] = await Promise.all([cachedReport('r', 1000, slow), cachedReport('r', 1000, slow)]);
    assert.deepEqual([a, b, runs], [1, 1, 1]);
  });

  it('answers a repeat at once', async () => {
    await cachedReport('r', 1000, slow);
    const started = Date.now();
    assert.equal(await cachedReport('r', 1000, slow), 1);
    assert.ok(Date.now() - started < 20);
  });

  it('shows the old result at once when it is out of date, and refreshes behind it', async () => {
    await cachedReport('r', 30, slow);
    await pause(50);
    const started = Date.now();
    assert.equal(await cachedReport('r', 30, slow), 1, 'the old result, not a wait');
    assert.ok(Date.now() - started < 20);
    await pause(60);
    assert.equal(await cachedReport('r', 10_000, slow), 2, 'the background refresh landed');
  });

  it('keeps nothing when the age limit is 0 — the setting outside production', async () => {
    await cachedReport('r', 0, slow);
    await cachedReport('r', 0, slow);
    assert.equal(runs, 2);
  });

  it('does not keep a failure: the next request tries again', async () => {
    await assert.rejects(cachedReport('r', 1000, () => Promise.reject(new Error('db down'))), /db down/);
    assert.equal(await cachedReport('r', 1000, slow), 1);
  });
});
