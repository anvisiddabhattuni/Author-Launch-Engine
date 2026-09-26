/**
 * Meme versus text, measured (STORY-069).
 *
 * The four meme stories rest on a premise nobody has checked: that memes earn
 * more traction than text. This is the story that makes the premise falsifiable,
 * and the honest version of it answers "not yet" most of the time.
 *
 * Two things it deliberately does not do.
 *
 * It does not divide two averages and print a winner. With the sample sizes this
 * system will realistically have for months, the ratio of two means is noise
 * wearing a decimal point. A verdict requires enough posts in *both* cells and
 * confidence intervals that do not overlap, and says which of those failed.
 *
 * And the mocked collector is format-blind. A generator quietly tuned so memes
 * win would make the demo a claim about the world rather than a demonstration of
 * the apparatus — the same reason the drafting agent is not allowed to grade its
 * own output.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/** The story names the Trust and Monitoring Agent as the owner. */
export const ACTOR = 'TrustMonitoringAgent';

/** What the comparison can honestly conclude. */
export const VERDICTS = {
  INSUFFICIENT: 'insufficient_data',
  INDISTINGUISHABLE: 'no_measurable_difference',
  MEME: 'meme_leads',
  TEXT: 'text_leads',
};

/** FNV-1a, as elsewhere: deterministic mock data, reproducible demo. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Platform base rates. Rough real-world orders of magnitude, not a claim. */
const PLATFORM_BASE = {
  twitter: { impressions: 4000, rate: 0.018 },
  instagram: { impressions: 2600, rate: 0.041 },
  facebook: { impressions: 1800, rate: 0.012 },
  linkedin: { impressions: 3200, rate: 0.022 },
};

/**
 * Mocked platform metrics for one published post.
 *
 * `formatEffect` is the honest seam. It defaults to 0 — the generator does not
 * know or care whether a post is a meme — so any difference the dashboard
 * reports on default data is sampling noise, which is exactly what it should
 * then refuse to call a result. A caller may set it to *simulate* a world where
 * memes do better, and the demo does so out loud rather than baking it in.
 */
export function mockMetrics({ externalId, platform, format, hoursLive, formatEffect = 0 }) {
  const base = PLATFORM_BASE[platform] ?? { impressions: 2000, rate: 0.02 };
  const seed = hash(`${externalId}:${platform}`);

  // ±35% spread, so cells have real variance and a confidence interval means
  // something. A tight mock would let the comparison "conclude" on four posts.
  const spread = 0.65 + ((seed % 700) / 1000);
  const impressions = Math.max(50, Math.round(base.impressions * spread));

  const effect = format === 'meme' ? 1 + formatEffect : 1;
  const noise = 0.6 + (((seed >>> 9) % 800) / 1000);
  const rate = Math.max(0.0005, base.rate * noise * effect);

  // Volume accrues with age and settles (STORY-029): about half of what a post
  // will ever earn by 12 hours, 93% by 48 — which is why the maturity window
  // is 48. The *rate* is untouched, so the format comparison sees the same
  // number at every age and a series of readings shows a post filling in
  // rather than a flat line repeated. A mock that never moved would make the
  // history this story adds a table of identical rows.
  const growth = Math.max(0.05, 1 - Math.exp(-Number(hoursLive) / 18));
  const impressionsNow = Math.max(50, Math.round(impressions * growth));

  const engagements = Math.max(1, Math.round(impressionsNow * rate));
  // Split roughly 70/18/12 with a deterministic wobble.
  const likes = Math.round(engagements * 0.7);
  const shares = Math.round(engagements * 0.18);
  const comments = Math.max(0, engagements - likes - shares);

  return {
    impressions: impressionsNow,
    likes,
    shares,
    comments,
    engagementRate: Number(((likes + shares + comments) / impressionsNow).toFixed(6)),
    hoursLive: Number(Number(hoursLive).toFixed(2)),
  };
}

/**
 * Collects metrics for every published post, tagged by format and platform.
 *
 * Upserts one row per post: the comparison needs one consistent reading each,
 * and keeping every reading would invite comparing a meme measured an hour after
 * publishing against a three-week-old text post.
 */
export async function collectEngagement(
  { authorId, now = new Date(), formatEffect = 0 },
  client = pool,
) {
  const { rows: posts } = await client.query(
    `SELECT sp.id, sp.draft_id, sp.author_id, sp.platform, sp.format,
            sp.external_id, sp.published_at
       FROM scheduled_posts sp
      WHERE sp.status = 'published' AND sp.published_at IS NOT NULL
        AND ($1::bigint IS NULL OR sp.author_id = $1)`,
    [authorId ?? null],
  );

  const collected = [];
  for (const post of posts) {
    const hoursLive = Math.max(
      0,
      (now.getTime() - new Date(post.published_at).getTime()) / 3600000,
    );
    const m = mockMetrics({
      externalId: post.external_id ?? `post-${post.id}`,
      platform: post.platform,
      format: post.format,
      hoursLive,
      formatEffect,
    });

    const { rows } = await client.query(
      `INSERT INTO engagement
         (scheduled_post_id, draft_id, author_id, platform, format, published_at,
          collected_at, hours_live, impressions, likes, shares, comments, engagement_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (scheduled_post_id) DO UPDATE
         SET collected_at = EXCLUDED.collected_at,
             hours_live = EXCLUDED.hours_live,
             impressions = EXCLUDED.impressions,
             likes = EXCLUDED.likes,
             shares = EXCLUDED.shares,
             comments = EXCLUDED.comments,
             engagement_rate = EXCLUDED.engagement_rate,
             collections = engagement.collections + 1
       RETURNING *`,
      [
        post.id,
        post.draft_id,
        post.author_id,
        post.platform,
        post.format,
        post.published_at,
        now.toISOString(),
        m.hoursLive,
        m.impressions,
        m.likes,
        m.shares,
        m.comments,
        m.engagementRate,
      ],
    );
    collected.push(rows[0]);

    // The same reading, appended rather than replaced (STORY-029). The row
    // above is what the post is doing now; this is what it has done.
    await client.query(
      `INSERT INTO content_metrics
         (scheduled_post_id, draft_id, author_id, platform, format, collected_at,
          hours_live, impressions, likes, shares, comments, engagement_rate, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'mock')`,
      [
        post.id,
        post.draft_id,
        post.author_id,
        post.platform,
        post.format,
        now.toISOString(),
        m.hoursLive,
        m.impressions,
        m.likes,
        m.shares,
        m.comments,
        m.engagementRate,
      ],
    );
  }

  await recordAction(
    {
      actor: ACTOR,
      action: 'engagement.collected',
      entityType: 'author',
      entityId: authorId ?? 'all',
      authorId: authorId ?? null,
      metadata: {
        posts: collected.length,
        byFormat: collected.reduce((acc, r) => {
          acc[r.format] = (acc[r.format] ?? 0) + 1;
          return acc;
        }, {}),
        // On the record, because a reader of these numbers is entitled to know
        // they came from a mock and whether that mock had a thumb on the scale.
        source: 'mocked platform adapters',
        formatEffect,
      },
    },
    client,
  );

  return collected;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation. n-1, because these are samples, not populations. */
function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * A 95% interval by normal approximation.
 *
 * Not a t-test, and the difference matters at these sample sizes — which is
 * precisely why the minimum-sample rule does the real work here and this is only
 * ever consulted after that rule has passed. Stated in the output so nobody
 * reads more into the interval than it can carry.
 */
export function confidenceInterval(values) {
  const n = values.length;
  const m = mean(values);
  const sd = stdDev(values);
  const margin = n < 2 ? Infinity : 1.96 * (sd / Math.sqrt(n));
  return { n, mean: m, sd, low: m - margin, high: m + margin };
}

/**
 * Compares the two formats per platform, and says what it cannot say.
 *
 * Posts younger than the maturity window are excluded rather than averaged in:
 * a post collected an hour after publishing has not finished earning whatever
 * it was going to earn, and mixing it with a settled one measures age.
 */
export async function compareFormats(
  { authorId, minSample = config.minSamplePerCell, maturityHours = config.engagementMaturityHours },
  client = pool,
) {
  const { rows } = await client.query(
    `SELECT platform, format, engagement_rate, hours_live
       FROM engagement WHERE author_id = $1`,
    [authorId],
  );

  const mature = rows.filter((r) => Number(r.hours_live) >= maturityHours);
  const excludedTooYoung = rows.length - mature.length;

  const platforms = [...new Set(mature.map((r) => r.platform))].sort();
  const byPlatform = platforms.map((platform) => {
    const cell = (format) =>
      confidenceInterval(
        mature
          .filter((r) => r.platform === platform && r.format === format)
          .map((r) => Number(r.engagement_rate)),
      );

    const meme = cell('meme');
    const text = cell('text');

    let verdict;
    let because;

    if (meme.n < minSample || text.n < minSample) {
      verdict = VERDICTS.INSUFFICIENT;
      const short = [
        meme.n < minSample ? `${meme.n} meme${meme.n === 1 ? '' : 's'}` : null,
        text.n < minSample ? `${text.n} text post${text.n === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      because = `${short.join(' and ')} — ${minSample} of each needed before this can say anything`;
    } else if (meme.low <= text.high && text.low <= meme.high) {
      verdict = VERDICTS.INDISTINGUISHABLE;
      because =
        'the two ranges overlap, so any gap between the averages is inside the noise';
    } else {
      verdict = meme.mean > text.mean ? VERDICTS.MEME : VERDICTS.TEXT;
      because = `the ranges do not overlap at ${minSample}+ posts each`;
    }

    return {
      platform,
      meme: summarise(meme),
      text: summarise(text),
      verdict,
      because,
      // Only meaningful when a verdict was actually reached. Reported as null
      // otherwise rather than as a number nobody should act on.
      lift:
        verdict === VERDICTS.MEME || verdict === VERDICTS.TEXT
          ? Number(((meme.mean - text.mean) / text.mean).toFixed(3))
          : null,
    };
  });

  return {
    minSample,
    maturityHours,
    excludedTooYoung,
    totalMeasured: mature.length,
    platforms: byPlatform,
    // The headline the UI leads with. Saying this plainly is the story's second
    // acceptance clause, and it is the opposite of what a dashboard usually does.
    conclusive: byPlatform.some(
      (p) => p.verdict === VERDICTS.MEME || p.verdict === VERDICTS.TEXT,
    ),
  };
}

const summarise = (ci) => ({
  n: ci.n,
  mean: ci.n === 0 ? null : Number(ci.mean.toFixed(5)),
  sd: ci.n < 2 ? null : Number(ci.sd.toFixed(5)),
  low: Number.isFinite(ci.low) ? Number(ci.low.toFixed(5)) : null,
  high: Number.isFinite(ci.high) ? Number(ci.high.toFixed(5)) : null,
});
