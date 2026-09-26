/**
 * Content performance (STORY-029 / REQ-007) — Trust and Monitoring Agent.
 *
 * STORY-069 built collection and asked one question of it: memes or text. This
 * module tracks — on a timer, as a series — and asks the other questions the
 * product acts on every week and had never checked:
 *
 *   which platform earns more, for this author;
 *   whether posting in the scheduler's "optimal window" (STORY-001) pays off;
 *   whether the scores this system escalates on — theme alignment, voice —
 *     have anything to do with how a post performs.
 *
 * Every answer is in the STORY-069 shape. It states its sample, it declines to
 * conclude below it, and when it does conclude it says what the evidence was.
 * On mocked engagement the honest answer to most of these is "no measurable
 * relationship", and that is the correct output: the collector is blind to
 * everything but platform, so a dashboard that found a relationship on default
 * data would be finding one in the noise. The point is that it *could* find
 * one, and would say how.
 *
 * `content_metrics` is the build note's table, and it is a history rather than
 * a snapshot on purpose: "is this post still earning or has it stalled" is a
 * question about two readings, and one overwritten reading cannot answer it.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { collectEngagement, compareFormats, confidenceInterval } from './engagement.js';

export const ACTOR = 'TrustMonitoringAgent';

/** What an analysis can honestly say. */
export const FINDINGS = {
  INSUFFICIENT: 'insufficient_data',
  NONE: 'no_measurable_relationship',
  FOUND: 'relationship_found',
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Pearson correlation with a plain significance test.
 *
 * t = r·√((n−2)/(1−r²)) against 2.0 is the 5% two-tailed line for the sample
 * sizes this will see. Not a substitute for a real model; a floor below which
 * "the score predicts engagement" is not a claim anyone may make.
 */
export function correlate(pairs) {
  const n = pairs.length;
  if (n < 3) return { n, r: null, t: null, significant: false };
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  // A tolerance, not equality: twenty-eight copies of 0.8 do not sum to
  // exactly 22.4 in floating point, and "constant" is a different finding
  // from "r = 0" — a constant cannot explain anything, a zero correlation
  // means it was tried and did not.
  if (sxx < 1e-9 || syy < 1e-12) return { n, r: 0, t: 0, significant: false, constant: true };
  const r = sxy / Math.sqrt(sxx * syy);
  const t = Math.abs(r) >= 1 ? Infinity : r * Math.sqrt((n - 2) / (1 - r * r));
  return { n, r: Number(r.toFixed(3)), t: Number(t.toFixed(2)), significant: Math.abs(t) >= 2.0 };
}

const summarise = (ci) => ({
  n: ci.n,
  mean: ci.n === 0 ? null : Number(ci.mean.toFixed(5)),
  low: Number.isFinite(ci.low) ? Number(ci.low.toFixed(5)) : null,
  high: Number.isFinite(ci.high) ? Number(ci.high.toFixed(5)) : null,
});

/** Two cells, compared the way STORY-069 compares formats. */
function compareCells(label, a, b, minSample) {
  const ca = confidenceInterval(a.values);
  const cb = confidenceInterval(b.values);
  if (ca.n < minSample || cb.n < minSample) {
    const short = [
      ca.n < minSample ? `${ca.n} ${a.name}` : null,
      cb.n < minSample ? `${cb.n} ${b.name}` : null,
    ].filter(Boolean);
    return {
      finding: FINDINGS.INSUFFICIENT,
      because: `${short.join(' and ')} — ${minSample} of each needed before this can say anything`,
      cells: { [a.name]: summarise(ca), [b.name]: summarise(cb) },
    };
  }
  if (ca.low <= cb.high && cb.low <= ca.high) {
    return {
      finding: FINDINGS.NONE,
      because: `the two ranges overlap at ${ca.n} and ${cb.n} posts, so any gap between the averages is inside the noise`,
      cells: { [a.name]: summarise(ca), [b.name]: summarise(cb) },
    };
  }
  const leader = ca.mean > cb.mean ? a : b;
  const other = leader === a ? b : a;
  return {
    finding: FINDINGS.FOUND,
    because: `${leader.name} leads ${other.name} and the ranges do not overlap at ${minSample}+ posts each`,
    leads: leader.name,
    lift: Number((((leader === a ? ca.mean : cb.mean) - (leader === a ? cb.mean : ca.mean)) / (leader === a ? cb.mean : ca.mean)).toFixed(3)),
    cells: { [a.name]: summarise(ca), [b.name]: summarise(cb) },
  };
}

/**
 * The sweep. Collects for one author and says what it collected — the
 * "tracked" half of the first acceptance clause, which used to be a button.
 */
export async function trackEngagement({ authorId, now = new Date(), formatEffect = 0 } = {}) {
  // `formatEffect` is STORY-069's honest seam and stays 0 from the sweep. The
  // demo passes it so its simulated world survives the sweeps it runs.
  const collected = await collectEngagement({ authorId, now, formatEffect });
  return {
    collected: collected.length,
    byPlatform: collected.reduce((acc, r) => {
      acc[r.platform] = (acc[r.platform] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * The read-model: every tracked post with its series, and the analyses.
 *
 * Assembled from rows the sweep wrote. The format comparison is STORY-069's
 * own function, called rather than reimplemented — a second copy of that
 * comparison would be free to disagree with the first, and the mix
 * recommender already acts on the first.
 */
export async function contentPerformance(
  {
    authorId,
    now = new Date(),
    minSample = config.minSamplePerCell,
    maturityHours = config.engagementMaturityHours,
    historyLimit = 12,
  },
  client = pool,
) {
  // Every published post, with its latest reading (if any), its draft's own
  // scores, and whether it went out inside the platform's best hours. Posts
  // with no reading are kept: an unmeasured post is a coverage finding, not
  // something to hide by inner-joining it away.
  const { rows: posts } = await client.query(
    `SELECT sp.id, sp.draft_id, sp.platform, sp.format, sp.published_at, sp.external_id,
            LEFT(d.content, 90) AS excerpt,
            d.theme_alignment, d.voice_score, d.confidence,
            EXTRACT(HOUR FROM sp.published_at AT TIME ZONE 'UTC')::int AS published_hour,
            (EXTRACT(HOUR FROM sp.published_at AT TIME ZONE 'UTC')::int = ANY(pw.best_hours)) AS in_window,
            e.impressions, e.likes, e.shares, e.comments, e.engagement_rate, e.hours_live,
            e.collected_at, e.collections,
            (SELECT COUNT(*)::int FROM content_metrics cm WHERE cm.scheduled_post_id = sp.id) AS readings
       FROM scheduled_posts sp
       JOIN drafts d ON d.id = sp.draft_id
       LEFT JOIN platform_windows pw ON pw.platform = sp.platform
       LEFT JOIN engagement e ON e.scheduled_post_id = sp.id
      WHERE sp.author_id = $1 AND sp.status = 'published' AND sp.published_at IS NOT NULL
      ORDER BY sp.published_at DESC`,
    [authorId],
  );

  // The series for each post, newest last, capped so the payload stays a
  // page and not an export.
  const { rows: series } = await client.query(
    `SELECT scheduled_post_id, collected_at, hours_live, impressions, engagement_rate, source
       FROM (
         SELECT cm.*, ROW_NUMBER() OVER (PARTITION BY scheduled_post_id ORDER BY collected_at DESC) AS rn
           FROM content_metrics cm WHERE cm.author_id = $1
       ) recent
      WHERE rn <= $2
      ORDER BY scheduled_post_id, collected_at`,
    [authorId, historyLimit],
  );
  const seriesFor = new Map();
  for (const r of series) {
    if (!seriesFor.has(Number(r.scheduled_post_id))) seriesFor.set(Number(r.scheduled_post_id), []);
    seriesFor.get(Number(r.scheduled_post_id)).push({
      collectedAt: r.collected_at,
      hoursLive: Number(r.hours_live),
      impressions: r.impressions,
      engagementRate: Number(r.engagement_rate),
      source: r.source,
    });
  }

  const tracked = posts.map((p) => {
    const history = seriesFor.get(Number(p.id)) ?? [];
    const last = history[history.length - 1] ?? null;
    const prev = history.length > 1 ? history[history.length - 2] : null;
    // "Still earning" is a claim about two readings. One reading cannot make
    // it, and says so rather than defaulting to either answer.
    const trajectory =
      !last ? 'unmeasured'
        : !prev ? 'one_reading'
          : last.impressions > prev.impressions * 1.02 ? 'climbing'
            : 'settled';
    return {
      id: Number(p.id),
      draftId: Number(p.draft_id),
      platform: p.platform,
      format: p.format,
      excerpt: p.excerpt,
      publishedAt: p.published_at,
      publishedHour: p.published_hour,
      inWindow: p.in_window,
      scores: {
        themeAlignment: p.theme_alignment === null ? null : Number(p.theme_alignment),
        voice: p.voice_score === null ? null : Number(p.voice_score),
        confidence: p.confidence === null ? null : Number(p.confidence),
      },
      latest: p.engagement_rate === null
        ? null
        : {
            impressions: p.impressions,
            likes: p.likes,
            shares: p.shares,
            comments: p.comments,
            engagementRate: Number(p.engagement_rate),
            hoursLive: Number(p.hours_live),
            collectedAt: p.collected_at,
          },
      mature: p.hours_live !== null && Number(p.hours_live) >= maturityHours,
      readings: p.readings,
      trajectory,
      history,
    };
  });

  const measured = tracked.filter((t) => t.latest);
  const settled = measured.filter((t) => t.mature);

  // --- Totals, by platform. Description, not inference: no verdict here. ---
  const platforms = [...new Set(tracked.map((t) => t.platform))].sort();
  const totals = platforms.map((platform) => {
    const mine = measured.filter((t) => t.platform === platform);
    const impressions = mine.reduce((a, t) => a + t.latest.impressions, 0);
    const engagements = mine.reduce((a, t) => a + t.latest.likes + t.latest.shares + t.latest.comments, 0);
    return {
      platform,
      posts: tracked.filter((t) => t.platform === platform).length,
      measured: mine.length,
      impressions,
      engagements,
      rate: impressions === 0 ? null : Number((engagements / impressions).toFixed(5)),
    };
  });

  // --- Analyses. Each states its sample and what it can and cannot say. ---
  const insights = [];

  // Which platform earns the better rate, for this author. Pairwise against
  // the best-looking one, because "twitter beats instagram" is the sentence a
  // person wants and a four-way ANOVA is not.
  // Only platforms with enough settled posts may be ranked at all. A single
  // post on a fourth platform with a lucky reading would otherwise sit at the
  // top of the list and the comparison would be against it.
  const byPlatform = platforms
    .map((platform) => ({ name: platform, values: settled.filter((t) => t.platform === platform).map((t) => t.latest.engagementRate) }))
    .filter((c) => c.values.length > 0)
    .sort((a, b) => mean(b.values) - mean(a.values));
  const rankable = byPlatform.filter((c) => c.values.length >= minSample);
  const cells = Object.fromEntries(byPlatform.map((c) => [c.name, summarise(confidenceInterval(c.values))]));
  if (rankable.length >= 2) {
    const [top, next] = rankable;
    insights.push({
      id: 'platform.leader',
      question: 'Which platform earns the best engagement rate for this author?',
      ...compareCells('platform', top, next, minSample),
      cells,
      premise: 'Where to put the next post.',
    });
  } else {
    const short = byPlatform.filter((c) => c.values.length < minSample).map((c) => `${c.values.length} ${c.name}`);
    insights.push({
      id: 'platform.leader',
      question: 'Which platform earns the best engagement rate for this author?',
      finding: FINDINGS.INSUFFICIENT,
      because: byPlatform.length === 0
        ? 'no settled posts measured yet'
        : `${rankable.length === 1 ? `only ${rankable[0].name} has ${minSample}+ settled posts` : 'no platform has enough settled posts'}` +
          (short.length ? ` — ${short.join(', ')}; ${minSample} each needed to rank` : ''),
      cells,
      premise: 'Where to put the next post.',
    });
  }

  // Does the scheduler's window matter? STORY-001 posts into "optimal times"
  // taken from generic platform windows, and nothing has ever asked whether a
  // post in the window does better than one outside it.
  //
  // Per platform, the way the format comparison is — and this was wrong
  // first. Pooled across platforms, "in-window" found a lead on the first demo
  // run, on a collector that does not know what time it is. Instagram's
  // window is 16:00 and its mock base rate is twice twitter's, so every
  // instagram post was in-window and better, and the pooled cell was
  // measuring which platform a post was on. The question is only answerable
  // where the platform is held still.
  const timingByPlatform = platforms.map((platform) => ({
    platform,
    ...compareCells(
      'timing',
      { name: 'in-window posts', values: settled.filter((t) => t.platform === platform && t.inWindow === true).map((t) => t.latest.engagementRate) },
      { name: 'out-of-window posts', values: settled.filter((t) => t.platform === platform && t.inWindow === false).map((t) => t.latest.engagementRate) },
      minSample,
    ),
  }));
  const timingFinding = timingByPlatform.some((p) => p.finding === FINDINGS.FOUND)
    ? FINDINGS.FOUND
    : timingByPlatform.some((p) => p.finding === FINDINGS.NONE)
      ? FINDINGS.NONE
      : FINDINGS.INSUFFICIENT;
  const timingLead = timingByPlatform.find((p) => p.finding === FINDINGS.FOUND);
  insights.push({
    id: 'timing.window',
    question: 'Do posts published inside the platform\'s best hours do better than posts outside them?',
    finding: timingFinding,
    because: timingByPlatform.length === 0
      ? 'no measured posts'
      : timingByPlatform.map((p) => `${p.platform}: ${p.because}`).join(' · '),
    leads: timingLead ? `${timingLead.leads} on ${timingLead.platform}` : undefined,
    lift: timingLead?.lift,
    cells: Object.fromEntries(timingByPlatform.map((p) => [p.platform, p.cells])),
    detail: timingByPlatform,
    premise: 'The scheduler has aimed every post at these hours since STORY-001. Compared within each platform.',
  });

  // Do the system's own scores predict anything? These are the numbers it
  // escalates on. If a well-grounded post earns no more than a badly grounded
  // one, the floor is a taste, which is a fine thing to be — but it should be
  // known to be one.
  //
  // Engagement is taken *relative to its platform-and-format cell* before it
  // is correlated with anything, for the reason above: on the first run this
  // reported r = 0.37 (t = 3.2) between theme alignment and engagement on a
  // collector that has never read a draft. The fixtures with the highest
  // scores happened to be on instagram, and the correlation was with the
  // platform. A post is compared to posts like it, and cells too small to
  // have a mean of their own do not vote.
  const cellMeans = new Map();
  for (const t of settled) {
    const k = `${t.platform}:${t.format}`;
    if (!cellMeans.has(k)) cellMeans.set(k, []);
    cellMeans.get(k).push(t.latest.engagementRate);
  }
  const relativeRate = (t) => {
    const cell = cellMeans.get(`${t.platform}:${t.format}`);
    if (!cell || cell.length < 3) return null;
    return t.latest.engagementRate / mean(cell) - 1;
  };
  for (const [key, label, premise] of [
    ['themeAlignment', 'theme alignment', 'Every draft is held to a theme-alignment floor (STORY-006, STORY-009). Engagement is measured relative to posts on the same platform and in the same format.'],
    ['voice', 'voice match', 'Every draft is held to a voice floor (STORY-009). Engagement is measured relative to posts on the same platform and in the same format.'],
  ]) {
    const pairs = settled
      .filter((t) => t.scores[key] !== null && relativeRate(t) !== null)
      .map((t) => [t.scores[key], relativeRate(t)]);
    const c = correlate(pairs);
    let finding;
    let because;
    if (c.n < minSample * 2) {
      finding = FINDINGS.INSUFFICIENT;
      because = `${c.n} settled posts with a ${label} score — ${minSample * 2} needed before a correlation means anything`;
    } else if (c.constant) {
      finding = FINDINGS.NONE;
      because = `every settled post has the same ${label} score, so it cannot explain any difference between them`;
    } else if (!c.significant) {
      finding = FINDINGS.NONE;
      because = `r = ${c.r} over ${c.n} posts (t = ${c.t}) — inside what chance produces at this sample`;
    } else {
      finding = FINDINGS.FOUND;
      because = `r = ${c.r} over ${c.n} posts (t = ${c.t}) — ${c.r > 0 ? 'higher' : 'lower'} ${label} goes with higher engagement`;
    }
    insights.push({
      id: `scores.${key}`,
      question: `Does a higher ${label} score go with higher engagement?`,
      finding,
      because,
      correlation: { n: c.n, r: c.r, t: c.t },
      direction: finding === FINDINGS.FOUND ? (c.r > 0 ? 'positive' : 'negative') : null,
      premise,
    });
  }

  // Memes versus text, from the function that owns it.
  const formats = await compareFormats({ authorId, minSample, maturityHours }, client);
  insights.push({
    id: 'format.meme_vs_text',
    question: 'Do memes outperform text?',
    finding: formats.conclusive ? FINDINGS.FOUND : formats.platforms.some((p) => p.verdict === 'no_measurable_difference') ? FINDINGS.NONE : FINDINGS.INSUFFICIENT,
    because: formats.platforms.length === 0
      ? 'no measured posts'
      : formats.platforms.map((p) => `${p.platform}: ${p.because}`).join(' · '),
    premise: 'Four meme stories rest on this (STORY-066–069).',
    detail: formats.platforms,
  });

  // --- Coverage: what this view is and is not looking at. ---
  const { rows: sweep } = await client.query(
    `SELECT MAX(finished_at) AS at, COUNT(*)::int AS runs
       FROM jobs WHERE kind = 'engagement.collect' AND status = 'done'
        AND (author_id = $1 OR author_id IS NULL)`,
    [authorId],
  );
  const { rows: readings } = await client.query(
    `SELECT COUNT(*)::int AS n, MAX(collected_at) AS at,
            COUNT(*) FILTER (WHERE source = 'platform')::int AS real
       FROM content_metrics WHERE author_id = $1`,
    [authorId],
  );
  const untracked = tracked.filter((t) => !t.latest && (now - new Date(t.publishedAt)) / 3600000 >= maturityHours);

  return {
    posts: tracked,
    totals,
    insights,
    top: [...settled].sort((a, b) => b.latest.engagementRate - a.latest.engagementRate).slice(0, 5),
    coverage: {
      published: tracked.length,
      measured: measured.length,
      settled: settled.length,
      tooYoung: measured.length - settled.length,
      // Matured without ever being measured. The governance check counts the
      // same thing; here it is a number a reader sees beside the chart.
      unmeasuredMature: untracked.length,
      readings: readings[0].n,
      lastReadingAt: readings[0].at,
      // Said beside the chart, not in a README: nothing here came from a platform.
      allMocked: readings[0].real === 0,
      sweep: { kind: 'engagement.collect', lastRunAt: sweep[0].at, runs: sweep[0].runs, everySeconds: config.jobSweepSeconds },
      minSample,
      maturityHours,
    },
  };
}
