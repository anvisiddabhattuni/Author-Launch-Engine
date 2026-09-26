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
  // Two connections, two powers (STORY-033). The application runs as
  // `ale_app_login`, which can read and write rows and cannot change the
  // schema, disable a trigger, or update an audit row. Migrations run as the
  // owner. Setting only DATABASE_URL (as older setups and CI did) makes both
  // the owner — which works, and which /ready and the Trust tab now report.
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ale_app_login@localhost:5432/author_launch_engine',
  migrationDatabaseUrl:
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/author_launch_engine',
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
  // Audit rows allowed to sit unsealed before the governance check complains
  // (STORY-014). Not zero: the sealer runs on an interval, so a handful of
  // unsealed rows is the system working, and a check that fires on one would be
  // a permanent red light nobody looks at.
  maxUnsealedAuditRows: number(process.env.MAX_UNSEALED_AUDIT_ROWS, 50),
  // A decision made faster than this looks like a rubber stamp rather than a
  // review. A signal, never a verdict — some decisions are genuinely obvious.
  fastApprovalSeconds: number(process.env.FAST_APPROVAL_SECONDS, 5),
  // Decisions a reviewer must have made before their pattern means anything.
  // Below it the dashboard says so rather than inferring from three data points.
  minDecisionsForPattern: number(process.env.MIN_DECISIONS_FOR_PATTERN, 10),
  // How long an outbound call may take before it is abandoned (STORY-016). A
  // bare fetch in Node has no timeout at all: against a provider that accepts
  // the connection and never answers, it hangs forever — and since STORY-015
  // added graceful shutdown, it would hang the drain too.
  apiTimeoutMs: number(process.env.API_TIMEOUT_MS, 10000),
  // Attempts in total, not retries after the first. Three is the same shape the
  // job queue uses, and for the same reason: enough to ride out a blip, few
  // enough that a broken provider is noticed rather than hammered.
  apiMaxAttempts: number(process.env.API_MAX_ATTEMPTS, 3),
  // First retry waits this long, then doubles. Overridden by a Retry-After
  // header when the provider sends one — it knows better than we do.
  apiBackoffMs: number(process.env.API_BACKOFF_MS, 500),
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
  // How much two drafts must share before they count as near-duplicates
  // (STORY-026). Readable on purpose: a reviewer seeing "these share 82% of
  // their words" can check the claim by reading them.
  nearDuplicateOverlap: Number(process.env.NEAR_DUPLICATE_OVERLAP ?? 0.7),
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
  // Health monitoring (STORY-027). An instance says it is alive this often;
  // the monitor calls it down once it has been quiet for `instanceStaleSeconds`
  // — four missed beats, so one slow database round-trip is not an outage —
  // and retires the row as presumed dead after `instanceDeadSeconds`, at which
  // point the live set stops listing a process that is not coming back.
  heartbeatSeconds: number(process.env.HEARTBEAT_SECONDS, 15),
  instanceStaleSeconds: number(process.env.INSTANCE_STALE_SECONDS, 60),
  instanceDeadSeconds: number(process.env.INSTANCE_DEAD_SECONDS, 600),
  // How often each running process performs the checks itself, between the
  // worker's sweeps. The API checks so a dead worker is noticed; the worker
  // checks so a dead API is. Neither can notice itself, which is the limit of
  // self-monitoring and the reason the README still asks for an outside probe.
  healthCheckSeconds: number(process.env.HEALTH_CHECK_SECONDS, 30),
  // STORY-031. Redirect/refuse plain http. On by default in production, where
  // the app sits behind a TLS terminator; off in development, where localhost
  // has no certificate. Set ENFORCE_HTTPS=false only if something other than
  // this process is doing the enforcing, and say which in the deploy notes.
  enforceHttps: (process.env.ENFORCE_HTTPS ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  // Browser origins allowed to call the API cross-origin. The UI reaches it
  // same-origin (Vite's proxy in dev, nginx in a container), so production
  // needs none; it was `*` until STORY-031.
  corsOrigins: (process.env.CORS_ORIGINS ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
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
