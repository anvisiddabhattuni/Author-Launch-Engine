import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(here, '../../.env') });

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/author_launch_engine',
  port: number(process.env.PORT, 4000),
  aiProvider: process.env.AI_PROVIDER ?? 'stub',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
  confidenceEscalationThreshold: number(process.env.CONFIDENCE_ESCALATION_THRESHOLD, 0.7),
  minPostsPerWeek: number(process.env.MIN_POSTS_PER_WEEK, 3),
  // At least this many meme candidates per batch (STORY-066). The acceptance
  // criterion is "at least one meme candidate is produced per batch", so one is
  // a floor the drafter has to meet rather than an average it may miss.
  minMemesPerBatch: number(process.env.MIN_MEMES_PER_BATCH, 1),
  // How close a meme has to sit to the book's recorded visual identity
  // (STORY-068). Set so a single wrong accent is caught: the library's eight
  // licensed templates carry five different accents, and an identity that
  // tolerated that would not be an identity.
  minIdentityMatch: number(process.env.MIN_IDENTITY_MATCH, 0.75),
  // Posts of each format, on one platform, before the comparison will say
  // anything at all (STORY-069). The number doing the real work in that story:
  // below this, the ratio of two averages is noise wearing a decimal point.
  minSamplePerCell: number(process.env.MIN_SAMPLE_PER_CELL, 8),
  // How long a post must have been live before its metrics count. A meme
  // measured an hour after publishing against a three-week-old text post is
  // measuring age, not format.
  engagementMaturityHours: number(process.env.ENGAGEMENT_MATURITY_HOURS, 48),
  relevanceThreshold: number(process.env.RELEVANCE_THRESHOLD, 0.5),
  // How well a listing has to fit the *author* — as opposed to the book — to be
  // worth a human's attention (STORY-010). Its own floor because it is an
  // independent reason to say yes: a library author night wants an author, not
  // a lecture on the book's subject, and scored against the book's themes alone
  // it lands at exactly 0.000.
  expertiseThreshold: number(process.env.EXPERTISE_THRESHOLD, 0.5),
  minOpportunitiesPerMonth: number(process.env.MIN_OPPORTUNITIES_PER_MONTH, 5),
  minThemeAlignment: number(process.env.MIN_THEME_ALIGNMENT, 0.5),
  // How many of the book's own words about a theme a draft has to carry
  // before it counts as arguing that theme rather than name-checking it.
  // A press release cannot quote a whole passage, so full marks is a
  // handful of the right words, not the passage back (STORY-006).
  themeMessageTermTarget: number(process.env.THEME_MESSAGE_TERM_TARGET, 8),
  // The same target for a social post (STORY-009). Lower because the format is
  // smaller: a tweet has 280 characters and cannot carry eight of the book's
  // words about a theme, so holding it to the press-release target would
  // escalate every good short post and train a reviewer to ignore the queue.
  socialMessageTermTarget: number(process.env.SOCIAL_MESSAGE_TERM_TARGET, 3),
  // How close a post has to sit to how the author actually writes, measured
  // against their previous posts. Its own floor rather than folded into
  // confidence, because REQ-001 asks for the author's voice specifically.
  minVoiceMatch: number(process.env.MIN_VOICE_MATCH, 0.5),
  // How far ahead a milestone counts as "approaching". A press kit needs to sit
  // with a reviewer, and journalists need lead time of their own, so detection
  // has to fire well before the date rather than on it.
  milestoneLeadTimeDays: number(process.env.MILESTONE_LEAD_TIME_DAYS, 30),
  // Signing key for session tokens (STORY-064). The fallback exists so a fresh
  // clone runs with no .env, and is refused outside development by the check
  // below — a default secret in production is not a session, it is an invitation.
  // Background worker (STORY-065). Poll interval is how often a worker looks for
  // due work; sweep interval is how often each recurring job is *supposed* to
  // run, and is what the idempotency key buckets on — so the two can differ
  // without a sweep firing twice.
  workerPollSeconds: number(process.env.WORKER_POLL_SECONDS, 5),
  jobSweepSeconds: number(process.env.JOB_SWEEP_SECONDS, 300),
  jobMaxAttempts: number(process.env.JOB_MAX_ATTEMPTS, 3),
  // First retry waits this long, then doubles. A failing outbound provider gets
  // backed away from rather than hammered.
  jobBackoffSeconds: number(process.env.JOB_BACKOFF_SECONDS, 30),
  // A job still 'running' after this long belongs to a worker that died.
  jobStaleSeconds: number(process.env.JOB_STALE_SECONDS, 300),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
  jwtTtl: process.env.JWT_TTL ?? '12h',
  nodeEnv: process.env.NODE_ENV ?? 'development',
};

if (config.nodeEnv === 'production' && !process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET must be set when NODE_ENV=production. Refusing to sign sessions with the ' +
      'development default, which is published in .env.example and in the repository.',
  );
}

export const PLATFORMS = ['twitter', 'instagram', 'facebook', 'linkedin'];
