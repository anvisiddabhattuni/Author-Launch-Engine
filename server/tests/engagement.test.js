/**
 * STORY-069 acceptance tests.
 *
 * The story's three Gherkin clauses are the first three `describe` blocks:
 * engagement captured by format, a comparison that is visible and honest, and
 * recommendations that stay advisory.
 *
 * The fourth block is the one that matters most and is not in the Gherkin at
 * all. This story rests on a premise — that memes outperform text — and the
 * mocked collector is the obvious place to quietly make that premise come true.
 * It is deliberately format-blind, and there is a test pinning that, because a
 * demo built on a rigged generator is a claim about the world dressed as a
 * demonstration of the apparatus.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { recommendMix } from '../src/agents/trustMonitoringAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approveMixRecommendation, rejectMixRecommendation } from '../src/services/approvals.js';
import {
  VERDICTS,
  collectEngagement,
  compareFormats,
  confidenceInterval,
  mockMetrics,
} from '../src/services/engagement.js';

let authorId;
let bookId;

/** Publishes `n` posts of one format, aged so they clear the maturity window. */
async function publish({ platform, format, n, ageDays = 30, tag }) {
  for (let i = 0; i < n; i += 1) {
    const at = new Date(Date.now() - (ageDays * 86400000 + i * 3600000));
    const { rows: d } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of,
                           status, format, media, image_rights)
       VALUES ($1,$2,$3,$4,0.9,'2026-07-06','approved',$5,$6,$7) RETURNING id`,
      [
        authorId,
        bookId,
        platform,
        `${tag} ${format} ${i}`,
        format,
        format === 'meme' ? JSON.stringify({ imageRef: 'x', altText: 'y' }) : null,
        format === 'meme' ? 'cleared' : 'not_applicable',
      ],
    );
    await query(
      `INSERT INTO scheduled_posts
         (draft_id, author_id, platform, scheduled_for, status, external_id, published_at, format)
       VALUES ($1,$2,$3,$4,'published',$5,$4,$6)`,
      [d[0].id, authorId, platform, at.toISOString(), `${tag}-${format}-${i}`, format],
    );
  }
}

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Engagement Test Author', `engagement-${Date.now()}@example.test`],
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

describe('STORY-069: engagement is captured by content format', () => {
  before(async () => {
    await publish({ platform: 'twitter', format: 'meme', n: 12, tag: 'cap' });
    await publish({ platform: 'twitter', format: 'text', n: 12, tag: 'cap' });
    await collectEngagement({ authorId });
  });

  it('tags every record with format, platform and a timestamp', async () => {
    const { rows } = await query('SELECT * FROM engagement WHERE author_id = $1', [authorId]);
    assert.equal(rows.length, 24);
    for (const r of rows) {
      assert.ok(['meme', 'text'].includes(r.format));
      assert.equal(r.platform, 'twitter');
      assert.ok(r.published_at instanceof Date);
      assert.ok(r.collected_at instanceof Date);
      assert.ok(Number(r.hours_live) > 0, 'and how long it had been live when read');
    }
  });

  it('carries the format from the draft through to the published record', async () => {
    const { rows } = await query(
      `SELECT sp.format AS published, d.format AS drafted
         FROM scheduled_posts sp JOIN drafts d ON d.id = sp.draft_id
        WHERE sp.author_id = $1`,
      [authorId],
    );
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.published === r.drafted));
  });

  it('keeps one reading per post rather than a pile of them', async () => {
    await collectEngagement({ authorId });
    const { rows } = await query(
      'SELECT COUNT(*)::int n, MAX(collections)::int c FROM engagement WHERE author_id = $1',
      [authorId],
    );
    assert.equal(rows[0].n, 24, 'a second run refreshes rather than duplicating');
    assert.ok(rows[0].c >= 2, 'and counts that it ran again');
  });

  it('records that the numbers came from a mock, and whether it was tilted', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'engagement.collected' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.match(rows[0].metadata.source, /mocked/);
    assert.equal(rows[0].metadata.formatEffect, 0);
  });
});

describe('STORY-069: the comparison is visible and honest', () => {
  it('says plainly when a cell is too small to conclude from', async () => {
    const { rows: a } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Thin Sample Author', `thin-${Date.now()}@example.test`],
    );
    const thinAuthor = a[0].id;
    const realAuthor = authorId;
    authorId = thinAuthor;
    try {
      await publish({ platform: 'twitter', format: 'meme', n: 2, tag: 'thin' });
      await publish({ platform: 'twitter', format: 'text', n: 9, tag: 'thin' });
      await collectEngagement({ authorId: thinAuthor });

      const c = await compareFormats({ authorId: thinAuthor });
      const tw = c.platforms.find((p) => p.platform === 'twitter');
      assert.equal(tw.verdict, VERDICTS.INSUFFICIENT);
      assert.match(tw.because, /2 memes/, 'and names the cell that is short');
      assert.match(tw.because, new RegExp(`${config.minSamplePerCell} of each`));
      assert.equal(c.conclusive, false);
      assert.equal(tw.lift, null, 'no headline number nobody should act on');
    } finally {
      authorId = realAuthor;
      await query('DELETE FROM authors WHERE id = $1', [thinAuthor]);
    }
  });

  it('reports n, mean and an interval per cell so a reader can check it', async () => {
    const c = await compareFormats({ authorId });
    const tw = c.platforms.find((p) => p.platform === 'twitter');
    for (const cell of [tw.meme, tw.text]) {
      assert.ok(cell.n >= config.minSamplePerCell);
      assert.ok(cell.mean > 0);
      assert.ok(cell.low < cell.mean && cell.mean < cell.high, 'the interval brackets the mean');
    }
  });

  it('refuses to call a winner when the intervals overlap', async () => {
    // Collected format-blind, so any gap between the two means is noise. The
    // honest verdict is that the data cannot separate them.
    const c = await compareFormats({ authorId });
    const tw = c.platforms.find((p) => p.platform === 'twitter');
    assert.equal(tw.verdict, VERDICTS.INDISTINGUISHABLE);
    assert.match(tw.because, /overlap/);
    assert.equal(tw.lift, null);
    assert.equal(c.conclusive, false);
  });

  it('excludes posts too young to have settled', async () => {
    const { rows: a } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Young Post Author', `young-${Date.now()}@example.test`],
    );
    const young = a[0].id;
    const realAuthor = authorId;
    authorId = young;
    try {
      // Published an hour ago: not yet a measurement of anything but recency.
      await publish({ platform: 'twitter', format: 'meme', n: 10, ageDays: 0, tag: 'young' });
      await collectEngagement({ authorId: young });
      const c = await compareFormats({ authorId: young });
      assert.ok(c.excludedTooYoung > 0, 'they are dropped, not averaged in');
      assert.equal(c.totalMeasured, 0);
      assert.equal(c.maturityHours, config.engagementMaturityHours);
    } finally {
      authorId = realAuthor;
      await query('DELETE FROM authors WHERE id = $1', [young]);
    }
  });

  it('computes an interval that widens as the sample shrinks', () => {
    const wide = confidenceInterval([0.01, 0.02, 0.03, 0.04]);
    const narrow = confidenceInterval(Array.from({ length: 40 }, (_, i) => 0.01 + (i % 4) / 100));
    assert.ok(wide.high - wide.low > narrow.high - narrow.low);
    assert.equal(confidenceInterval([0.01]).low, -Infinity, 'one point proves nothing');
  });
});

describe('STORY-069: the mocked collector does not favour memes', () => {
  it('produces identical metrics for a meme and a text post by default', () => {
    const args = { externalId: 'x-1', platform: 'twitter', hoursLive: 72 };
    const asMeme = mockMetrics({ ...args, format: 'meme' });
    const asText = mockMetrics({ ...args, format: 'text' });
    assert.deepEqual(
      asMeme,
      asText,
      'the generator must not know or care which format it is measuring',
    );
  });

  it('only tilts when a caller explicitly asks it to simulate one', () => {
    const args = { externalId: 'x-2', platform: 'twitter', hoursLive: 72, format: 'meme' };
    const flat = mockMetrics(args);
    const tilted = mockMetrics({ ...args, formatEffect: 0.6 });
    assert.ok(tilted.engagementRate > flat.engagementRate);
    assert.equal(mockMetrics({ ...args, format: 'text', formatEffect: 0.6 }).engagementRate,
      flat.engagementRate, 'and the tilt applies to memes only, by request');
  });

  it('finds no difference on format-blind data even at a healthy sample', async () => {
    const c = await compareFormats({ authorId });
    assert.equal(c.conclusive, false, 'which is the correct answer, not a failure');
  });
});

describe('STORY-069: recommendations stay advisory', () => {
  let leadAuthor;
  let recommendation;

  before(async () => {
    const { rows: a } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Mix Test Author', `mix-${Date.now()}@example.test`],
    );
    leadAuthor = a[0].id;
    const real = authorId;
    authorId = leadAuthor;
    await publish({ platform: 'twitter', format: 'meme', n: 20, tag: 'lead' });
    await publish({ platform: 'twitter', format: 'text', n: 20, tag: 'lead' });
    authorId = real;
    // A simulated world in which memes really do better, asked for out loud.
    await collectEngagement({ authorId: leadAuthor, formatEffect: 0.6 });
    const result = await recommendMix({ authorId: leadAuthor });
    recommendation = result.proposed[0];
  });

  after(async () => {
    await query('DELETE FROM authors WHERE id = $1', [leadAuthor]);
  });

  it('reaches a verdict when the evidence actually supports one', async () => {
    const c = await compareFormats({ authorId: leadAuthor });
    const tw = c.platforms.find((p) => p.platform === 'twitter');
    assert.equal(tw.verdict, VERDICTS.MEME);
    assert.ok(tw.lift > 0, 'and only then reports a lift');
    assert.equal(c.conclusive, true);
  });

  it('proposes rather than applies', async () => {
    assert.ok(recommendation, 'a recommendation was made');
    assert.equal(recommendation.status, 'pending_approval');
    const { rows } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [leadAuthor]);
    assert.equal(rows[0].memes_per_batch, null, 'and nothing about publishing has changed');
  });

  it('freezes the evidence it was made from', () => {
    assert.ok(recommendation.evidence.meme.n >= config.minSamplePerCell);
    assert.ok(recommendation.evidence.lift > 0);
    assert.ok(recommendation.evidence.because.length > 0);
    assert.equal(recommendation.evidence.minSample, config.minSamplePerCell);
  });

  it('says on the audit log that nothing was applied', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'mix.recommended' ORDER BY id DESC LIMIT 1`,
      [leadAuthor],
    );
    assert.equal(rows[0].metadata.applied, false);
    assert.equal(rows[0].metadata.requiresApproval, true);
  });

  it('changes the mix only once a human approves it', async () => {
    await approveMixRecommendation({
      recommendationId: recommendation.id,
      reviewer: 'Anvi Siddabhattuni',
    });
    const { rows } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [leadAuthor]);
    assert.equal(rows[0].memes_per_batch, recommendation.suggested_memes);
  });

  it('leaves the mix alone when a human rejects it', async () => {
    const { rows: before } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
      leadAuthor,
    ]);
    const again = await recommendMix({ authorId: leadAuthor });
    const next = again.proposed[0];
    assert.ok(next, 'a fresh recommendation');

    await rejectMixRecommendation({ recommendationId: next.id, reviewer: 'Anvi Siddabhattuni' });
    const { rows: after_ } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
      leadAuthor,
    ]);
    assert.equal(after_[0].memes_per_batch, before[0].memes_per_batch, 'a rejection is inert');
  });

  it('stays quiet on a platform the data cannot separate', async () => {
    const result = await recommendMix({ authorId });
    assert.deepEqual(result.proposed, [], 'no verdict, no proposal');
    assert.ok(result.skipped.length > 0);
    assert.equal(result.skipped[0].verdict, VERDICTS.INDISTINGUISHABLE);
  });
});
