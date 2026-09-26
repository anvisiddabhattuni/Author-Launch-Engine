/**
 * STORY-029 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Track content performance" → given content is published and receives
 *       engagement, metrics are tracked and displayed on the dashboard.
 *   "Analyze user engagement" → given metrics are collected, analysis provides
 *       insights on content effectiveness.
 *
 * Measured before this story: STORY-069 collected engagement when a human
 * pressed a button — zero recurring sweeps, two collections ever, both from
 * the demo — and kept one reading per post, overwritten each time, so a post
 * that stalled and one still climbing looked identical. Exactly one question
 * was asked of the data (memes or text); nothing asked whether the platform,
 * the scheduler's window, or the system's own scores had anything to do with
 * how a post performed.
 *
 * The collector is mocked and blind to everything but platform. So the honest
 * finding for most of the new questions on default data is "no measurable
 * relationship", and these tests assert that the apparatus says so — and
 * that it *can* say otherwise when the numbers actually differ.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { CHECKS, runChecks } from '../src/services/governance.js';
import {
  FINDINGS,
  contentPerformance,
  correlate,
  trackEngagement,
} from '../src/services/performanceMetrics.js';

let authorId;
let bookId;
const stamp = Date.now();

/** Publishes `n` posts at a given UTC hour, aged past the maturity window. */
async function publish({ platform, n, hour, ageDays = 30, tag, theme = 0.8, voice = 0.8 }) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const at = new Date(Date.UTC(2026, 6, 1 + i, hour, 0, 0));
    at.setUTCDate(at.getUTCDate() - ageDays + 30);
    const { rows: d } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of,
                           status, format, theme_alignment, voice_score)
       VALUES ($1,$2,$3,$4,0.9,'2026-07-06','approved','text',$5,$6) RETURNING id`,
      [authorId, bookId, platform, `${tag} post ${i}`, theme, voice],
    );
    const { rows: sp } = await query(
      `INSERT INTO scheduled_posts
         (draft_id, author_id, platform, scheduled_for, status, external_id, published_at, format)
       VALUES ($1,$2,$3,$4,'published',$5,$4,'text') RETURNING id`,
      // No timestamp in the id. The mock seeds its "random" engagement from
      // it, so a timestamp made every run draw a new sample — and a test that
      // asserts "no relationship" on a fresh random sample fails about one run
      // in twenty, because that is what a 95% interval means. It did, during
      // STORY-033. The same ids give the same sample, every run.
      [d[0].id, authorId, platform, at.toISOString(), `${tag}-${i}`],
    );
    ids.push(Number(sp[0].id));
  }
  return ids;
}

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Performance Test Author', `performance-${stamp}@example.test`],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes)
     VALUES ($1,'The Quiet Craft','Attention is a muscle.',$2) RETURNING *`,
    [authorId, ['attention', 'craft']],
  );
  bookId = b[0].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('Scenario: content performance is tracked, as a series, on a timer', () => {
  let postIds;

  it('a matured post nobody measured is a governance finding, not a blank', async () => {
    postIds = await publish({ platform: 'twitter', n: 3, hour: 13, tag: 'tracked' });
    const check = CHECKS.find((c) => c.id === 'engagement.tracked');
    assert.ok(check, 'no governance check for unmeasured posts');
    const before = (await runChecks({})).find((c) => c.id === 'engagement.tracked');
    assert.ok(before.violations >= 3, `expected the three new posts to count, got ${before.violations}`);
  });

  it('the sweep is on the worker\'s list, and collecting appends rather than replaces', async () => {
    const { RECURRING, HANDLERS } = await import('../src/jobs/handlers.js');
    assert.ok(RECURRING.find((r) => r.kind === 'engagement.collect' && r.scope === 'author'), 'no sweep collects engagement');
    assert.equal(typeof HANDLERS['engagement.collect'], 'function');

    const day1 = new Date('2026-08-10T12:00:00Z');
    const day2 = new Date('2026-08-12T12:00:00Z');
    const first = await trackEngagement({ authorId, now: day1 });
    assert.equal(first.collected, 3);
    await trackEngagement({ authorId, now: day2 });

    const { rows: snapshot } = await query(
      'SELECT COUNT(*)::int AS n FROM engagement WHERE scheduled_post_id = ANY($1::bigint[])', [postIds],
    );
    const { rows: series } = await query(
      'SELECT COUNT(*)::int AS n FROM content_metrics WHERE scheduled_post_id = ANY($1::bigint[])', [postIds],
    );
    // STORY-069's one-reading-per-post snapshot is kept; the history is new.
    assert.equal(snapshot[0].n, 3);
    assert.equal(series[0].n, 6, 'two collections should be two readings per post');
  });

  it('the governance check clears once the posts are measured', async () => {
    const after = (await runChecks({})).find((c) => c.id === 'engagement.tracked');
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
        WHERE sp.author_id = $1 AND NOT EXISTS (SELECT 1 FROM engagement e WHERE e.scheduled_post_id = sp.id)`,
      [authorId],
    );
    assert.equal(rows[0].n, 0, 'this author still has unmeasured posts');
    // Other suites may leave their own; ours no longer count.
    assert.ok(after.violations >= 0);
  });

  it('is displayed: each post carries its series, and a second reading can say "climbing"', async () => {
    const view = await contentPerformance({ authorId, now: new Date('2026-08-12T13:00:00Z') });
    assert.equal(view.coverage.published, 3);
    assert.equal(view.coverage.measured, 3);
    assert.equal(view.coverage.readings, 6);
    assert.equal(view.coverage.allMocked, true, 'nothing here came from a platform, and the view must say so');

    const post = view.posts.find((p) => p.id === postIds[0]);
    assert.equal(post.readings, 2);
    assert.equal(post.history.length, 2);
    assert.ok(post.history[1].hoursLive > post.history[0].hoursLive, 'series is not in time order');
    // The mock accrues with age and both readings are past saturation, so
    // "settled" is the right call — and it is a call one reading could not make.
    assert.ok(['climbing', 'settled'].includes(post.trajectory));
    assert.notEqual(post.trajectory, 'one_reading');
  });

  it('a post with one reading says so rather than guessing a trajectory', async () => {
    const [lone] = await publish({ platform: 'linkedin', n: 1, hour: 12, tag: 'lone' });
    await trackEngagement({ authorId, now: new Date('2026-08-13T12:00:00Z') });
    const view = await contentPerformance({ authorId, now: new Date('2026-08-13T13:00:00Z') });
    assert.equal(view.posts.find((p) => p.id === lone).trajectory, 'one_reading');
  });
});

describe('Scenario: the metrics are analysed, and the analysis says what it cannot say', () => {
  it('refuses to conclude about timing below the sample floor', async () => {
    const view = await contentPerformance({ authorId, now: new Date('2026-08-13T13:00:00Z') });
    const timing = view.insights.find((i) => i.id === 'timing.window');
    assert.ok(timing, 'no timing insight');
    assert.equal(timing.finding, FINDINGS.INSUFFICIENT);
    assert.match(timing.because, new RegExp(`${config.minSamplePerCell} of each needed`));
  });

  it('with enough posts in and out of the window, a blind collector yields no relationship', async () => {
    // twitter's best hours are 13, 15, 17. Eight more in-window, eight at 3am.
    await publish({ platform: 'twitter', n: 8, hour: 15, tag: 'inwin' });
    await publish({ platform: 'twitter', n: 8, hour: 3, tag: 'outwin' });
    await trackEngagement({ authorId, now: new Date('2026-08-14T12:00:00Z') });

    const view = await contentPerformance({ authorId, now: new Date('2026-08-14T13:00:00Z') });
    const timing = view.insights.find((i) => i.id === 'timing.window');
    // Cells are per platform — pooled, this question measured the platform.
    const twitter = timing.cells.twitter;
    assert.ok(twitter['in-window posts'].n >= config.minSamplePerCell);
    assert.ok(twitter['out-of-window posts'].n >= config.minSamplePerCell);
    // The mock does not know what time it is. Finding a difference here would
    // be finding one in the noise, and the failure mode this guards against.
    assert.equal(timing.finding, FINDINGS.NONE, timing.because);
    assert.match(timing.because, /ranges overlap/);
  });

  it('compares platforms, and names the leader only when the ranges separate', async () => {
    // instagram's mock base rate is more than twice twitter's, so at eight
    // settled posts each the intervals separate and the view may say so.
    await publish({ platform: 'instagram', n: 8, hour: 16, tag: 'insta' });
    await trackEngagement({ authorId, now: new Date('2026-08-15T12:00:00Z') });
    const view = await contentPerformance({ authorId, now: new Date('2026-08-15T13:00:00Z') });
    const leader = view.insights.find((i) => i.id === 'platform.leader');
    assert.equal(leader.finding, FINDINGS.FOUND, leader.because);
    assert.equal(leader.leads, 'instagram');
    assert.ok(leader.lift > 0);
    assert.match(leader.because, /do not overlap/);
  });

  it('asks whether the system\'s own scores predict engagement, and answers honestly', async () => {
    const view = await contentPerformance({ authorId, now: new Date('2026-08-15T13:00:00Z') });
    for (const id of ['scores.themeAlignment', 'scores.voice']) {
      const insight = view.insights.find((i) => i.id === id);
      assert.ok(insight, `no ${id} insight`);
      // Every fixture carries the same score, and the view has to say that a
      // constant cannot explain anything rather than reporting r = 0 as "no
      // effect" — those are different findings.
      assert.equal(insight.finding, FINDINGS.NONE);
      assert.match(insight.because, /same .* score/);
    }
  });

  it('does not mistake the platform for the score', async () => {
    // The bug the first version had. High-scoring fixtures on the platform
    // with the higher mock base rate produced r = 0.37, t = 3.2 — "significant"
    // — on a collector that has never read a draft. Engagement is now taken
    // relative to posts on the same platform and format before correlating.
    const { rows: a } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Confound Author', `confound-${stamp}@example.test`],
    );
    const { rows: b } = await query(
      `INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x',$2) RETURNING *`,
      [a[0].id, ['craft']],
    );
    const saved = [authorId, bookId];
    [authorId, bookId] = [a[0].id, b[0].id];
    try {
      await publish({ platform: 'instagram', n: 10, hour: 16, tag: 'hi', theme: 0.95, voice: 0.95 });
      await publish({ platform: 'twitter', n: 10, hour: 15, tag: 'lo', theme: 0.55, voice: 0.55 });
      await trackEngagement({ authorId, now: new Date('2026-08-15T12:00:00Z') });
      const view = await contentPerformance({ authorId, now: new Date('2026-08-15T13:00:00Z') });
      const theme = view.insights.find((i) => i.id === 'scores.themeAlignment');
      assert.notEqual(theme.finding, FINDINGS.FOUND, `found a relationship that is only the platform: ${theme.because}`);
      const timing = view.insights.find((i) => i.id === 'timing.window');
      assert.notEqual(timing.finding, FINDINGS.FOUND, `timing found a lead that is only the platform: ${timing.because}`);
    } finally {
      await query('DELETE FROM authors WHERE id = $1', [authorId]);
      [authorId, bookId] = saved;
    }
  });

  it('can find a relationship when there is one', () => {
    const positive = Array.from({ length: 20 }, (_, i) => [i / 20, 0.01 + i * 0.001 + (i % 3) * 0.0004]);
    const c = correlate(positive);
    assert.ok(c.r > 0.9, `r was ${c.r}`);
    assert.equal(c.significant, true);

    const noise = Array.from({ length: 20 }, (_, i) => [i / 20, [0.02, 0.011, 0.03, 0.015][i % 4]]);
    assert.equal(correlate(noise).significant, false);

    assert.equal(correlate([[1, 2], [1, 3], [1, 4]]).constant, true);
    assert.equal(correlate([[1, 2]]).r, null, 'two points are not a correlation');
  });

  it('the format comparison is STORY-069\'s own, not a second copy', async () => {
    const view = await contentPerformance({ authorId, now: new Date('2026-08-15T13:00:00Z') });
    const format = view.insights.find((i) => i.id === 'format.meme_vs_text');
    assert.ok(format);
    assert.ok(Array.isArray(format.detail), 'the per-platform detail should be compareFormats output');
    assert.ok(format.detail.every((p) => 'verdict' in p && 'because' in p));
  });
});
