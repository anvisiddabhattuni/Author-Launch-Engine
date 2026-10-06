import { Router } from 'express';

import {
  assertOwns,
  authenticate,
  enforceTenant,
  requirePermission,
  tenantParam,
  requireAuditReviewer,
} from '../middleware/auth.js';
import { PERMISSIONS, grantMatrix, holds } from '../services/permissions.js';
import { numericParam, validate } from '../middleware/validate.js';
import { applyTenantScope } from '../middleware/tenantScope.js';
import { SCHEMAS } from './schemas.js';

import { draftWeeklyPosts, weekStart } from '../agents/contentDraftingAgent.js';
import {
  findAwaitingApproval,
  notifyAwaitingApproval,
} from '../agents/approvalNotificationAgent.js';
import { sealAndVerify, verifyAuditLog } from '../agents/auditSecurityAgent.js';
import {
  onboardTenant,
  restoreTenant,
  suspendTenant,
  verifyIsolation,
} from '../agents/tenantManagementAgent.js';
import { integrationHealth } from '../agents/apiIntegrationAgent.js';
import { deploymentHistory, readiness } from '../services/deployment.js';
import { monitorAndAlert, systemStatus } from '../services/healthMonitoring.js';
import { busStatus, redeliver } from '../services/messageBus.js';
import { tenantSchema } from '../services/tenantSchemas.js';
import { accessOverview, decideChange, proposeChange, withdrawChange } from '../services/accessChanges.js';
import { acceptInvite, resendInvite } from '../services/invites.js';
import { accessReport, securityLogReport, setAccountBlocked, tenantAccessEvents } from '../services/dataAccess.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys.js';
import { addMaterial, describeBookModel, fitBookModel, quotedPassages, summarise as summariseModel } from '../services/bookModel.js';
import { requestChanges } from '../services/contentReview.js';
import { auditKeyId } from '../services/auditKey.js';
import { auditAccessPolicy } from '../services/auditAccess.js';
import { generateAuditReport, reportAsCsv } from '../services/auditReports.js';
import { attentionFor } from '../services/attention.js';
import { searchStatus, searchTenant } from '../services/searchIndex.js';
import { smsLog } from '../services/sms.js';
import { listAnomalies, recordPrometheusAlerts, updateAnomaly } from '../services/anomalyEscalation.js';
import { timingSafeEqual } from 'node:crypto';
import { billingFor, chargeSubscription, handleStripeEvent, markReviewed, paymentsToReview, verifyStripeSignature } from '../services/billing.js';
import { governanceScore } from '../services/governanceScore.js';
import { acknowledge, listNotifications } from '../services/securityNotifications.js';
import { applyFeedback, feedbackFor, recordFeedback } from '../services/contentFeedback.js';
import { monthStart, scoutOpportunities } from '../agents/opportunityScoutingAgent.js';
import { OPPORTUNITY_TYPES } from '../services/directories.js';
import { draftPressKit } from '../agents/prMaterialsAgent.js';
import { generatePrMaterials } from '../agents/aiContentGenerationAgent.js';
import {
  listEscalations,
  monitorPressMaterials,
  recommendMix,
  trustDashboard,
} from '../agents/trustMonitoringAgent.js';
import { draftOutreachMessages } from '../agents/prOutreachAgent.js';
import { config, PLATFORMS } from '../config.js';
import { query } from '../db/pool.js';
import {
  approveDraft,
  approveOutreach,
  approvePrMaterial,
  rejectDraft,
  rejectOutreach,
  rejectPrMaterial,
  approveMixRecommendation,
  rejectMixRecommendation,
} from '../services/approvals.js';
import { listAuditLog, recordAction } from '../services/auditLog.js';
import { collectEngagement, compareFormats } from '../services/engagement.js';
import { contentPerformance } from '../services/performanceMetrics.js';
import { recordAwardOutcome } from '../services/awardOutcome.js';
import { AWARD_OUTCOMES, findAwardsAwaitingOutcome, outcomeOf } from '../services/awards.js';
import { anniversaryYears, findApproachingMilestones } from '../services/milestones.js';
import { draftApproachingKits } from '../services/milestoneWatcher.js';
import { sendOutreachMessage } from '../services/outreachSender.js';
import { distributePressKit } from '../services/prDistributor.js';
import {
  findKitsAwaitingReview,
  findReviewers,
  notifyPendingReviews,
} from '../services/reviewNotifier.js';
import { enqueue, retryJob, tick } from '../jobs/queue.js';
import { login, publicUser } from '../services/auth.js';
import { thresholds } from '../services/escalationPolicy.js';
import { assessmentHistory, checkEpisodes } from '../services/trustHistory.js';
import { publishDue, scheduleDraft } from '../services/scheduler.js';
import {
  addTemplate,
  assessTemplate,
  listTemplates,
  retireTemplate,
  themedArtwork,
} from '../services/memeLibrary.js';
import { retrieveThemeGrounding } from '../services/themeRetrieval.js';
import {
  deriveIdentity,
  getActiveIdentity,
  listVersions,
  saveIdentity,
  scoreIdentity,
} from '../services/visualIdentity.js';
import { MIN_POSTS_FOR_TRAIT, deriveVoice } from '../services/voiceProfile.js';

export const router = Router();

/**
 * Wraps a handler so a rejected promise reaches the error middleware.
 *
 * Keeps the handler's source on the wrapper (STORY-032): the input-validation
 * coverage test reads it to find every field a handler reads, and fails when
 * one is read that its schema does not declare — which is what makes it safe
 * for validation to strip undeclared fields.
 */
const asyncRoute = (fn) => {
  const wrapped = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  wrapped.source = fn.toString();
  return wrapped;
};

// Order matters and is the whole point: authenticate answers "is a real person
// behind this", enforceTenant answers "may they touch this data". Mounted here
// rather than per-route so a route added later is protected by default —
// forgetting to opt in is the failure mode this ordering removes (STORY-064).
router.use(authenticate);
router.use(enforceTenant);
// Path tenants are checked here rather than in enforceTenant: router-level
// middleware runs before Express populates req.params, so the check has to hang
// off the parameter itself to see a value at all.
// Numeric before tenant: `/authors/abc/books` used to reach Postgres as the
// string "abc" for any session allowed to read across tenants (STORY-032).
router.param('authorId', numericParam('authorId'));
router.param('authorId', tenantParam);
router.param('bookId', numericParam('bookId'));
router.param('id', numericParam('id'));

// --- Session (STORY-064 / REQ-005) ---

router.post('/auth/login', validate(SCHEMAS.login), asyncRoute(async (req, res) => {
  const { email, password } = req.body ?? {};
  res.json(await login({ email, password }));
}));

/** Who the current token says you are. The client uses it to restore a session. */
/**
 * The author sets their own password from an invitation (STORY-043), and is
 * signed in. Public: the person following the link has no session yet.
 */
router.post('/auth/accept-invite', validate(SCHEMAS.acceptInvite), asyncRoute(async (req, res) => {
  const user = await acceptInvite({ token: req.body.token, password: req.body.password });
  res.json(await login({ email: user.email, password: req.body.password }));
}));

router.get('/auth/me', asyncRoute(async (req, res) => {
  res.json({ user: req.user });
}));

/**
 * Liveness: is this process running and able to reach its database?
 *
 * What a platform restarts on. Kept as it was, because things already depend on
 * it and because "restart me" and "stop sending me traffic" are different
 * answers to different questions — conflating them means a schema mismatch gets
 * treated as a crash and restarted into the same mismatch forever.
 */
router.get('/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, provider: config.aiProvider });
}));

/**
 * Readiness: is it safe to send this instance traffic?
 *
 * 503 when not, because a load balancer reads the status code and not the body.
 * The body is for the person who then has to work out why.
 */
router.get('/ready', asyncRoute(async (_req, res) => {
  const result = await readiness({});
  res.status(result.ready ? 200 : 503).json(result);
}));

/** What every external integration has been doing, and how well (STORY-016). */
router.get('/integrations', validate(SCHEMAS.integrations), asyncRoute(async (req, res) => {
  const sinceHours = Number(req.query.sinceHours ?? 24);
  // An admin sees every tenant; an author sees their own calls and the
  // system-wide ones. `enforceTenant` has already filled in `authorId` for a
  // non-admin, and a route that ignored it would serve everybody's — which is
  // exactly the leak STORY-017 found in two routes written before this one.
  // Asks the capability, not the role: a compliance session reads across
  // tenants and has no authorId of its own, so the old `role === 'admin'`
  // reading would have scoped it to NaN (STORY-019).
  const scope = holds(req.user, PERMISSIONS.TENANT_READ_ALL) ? null : Number(req.query.authorId);
  const services = await integrationHealth({ sinceHours, authorId: scope });
  const { rows: recentFailures } = await query(
    `SELECT service, operation, attempt, outcome, status, duration_ms, error, created_at
       FROM api_interactions
      WHERE outcome <> 'ok' AND created_at > now() - make_interval(hours => $1)
        AND ($2::bigint IS NULL OR author_id = $2 OR author_id IS NULL)
      ORDER BY id DESC LIMIT 20`,
    [sinceHours, scope ?? null],
  );
  res.json({ sinceHours, scopedTo: scope ?? 'all tenants', services, recentFailures });
}));

/** What is running, and what ran before it. The first question of an incident. */
router.get('/deployments', asyncRoute(async (_req, res) => {
  res.json(await deploymentHistory({}));
}));

// --- System health (STORY-027 / REQ-007) ---

/**
 * What the checks found, assembled from the rows they wrote. Readable by
 * anyone signed in, like /deployments: whether the system is up is not a
 * secret from the people using it.
 */
router.get('/system/health', asyncRoute(async (_req, res) => {
  res.json(await systemStatus({}));
}));

/**
 * Perform the checks now. Has side effects — it can open an outage and page
 * the operators — so it is the operators' to run.
 */
router.post('/system/health-check', requirePermission(PERMISSIONS.SYSTEM_OPERATE), asyncRoute(async (req, res) => {
  const result = await monitorAndAlert({ checkedBy: `${req.user.email} (on demand)` });
  res.json(result);
}));

// --- Authors, book content and social history (build step 1's backend) ---

router.get('/authors', asyncRoute(async (req, res) => {
  // The client bootstraps from this list. Before STORY-064 it returned every
  // author in the database and the UI simply took the first one, which is how
  // the masthead came to say "Signed in as" about somebody nobody had signed in
  // as. An author now sees exactly one row: their own.
  if (!holds(req.user, PERMISSIONS.TENANT_READ_ALL)) {
    const { rows } = await query('SELECT * FROM authors WHERE id = $1', [req.user.authorId]);
    return res.json(rows);
  }
  const { rows } = await query('SELECT * FROM authors ORDER BY id');
  res.json(rows);
}));

router.post('/authors', validate(SCHEMAS.createAuthor), asyncRoute(async (req, res) => {
  const { name, email, voiceProfile = {} } = req.body;
  if (!name || !email) throw Object.assign(new Error('name and email are required'), { status: 400 });

  const { rows } = await query(
    `INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name, email, JSON.stringify(voiceProfile)],
  );
  await recordAction({
    actor: req.user.name,
    action: 'author.upserted',
    entityType: 'author',
    entityId: rows[0].id,
    authorId: rows[0].id,
    after: rows[0],
  });
  res.status(201).json(rows[0]);
}));

router.get('/authors/:authorId/books', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM books WHERE author_id = $1 ORDER BY id', [
    req.params.authorId,
  ]);
  res.json(rows);
}));

router.post('/authors/:authorId/books', validate(SCHEMAS.createBook), asyncRoute(async (req, res) => {
  const { title, content, themes = [] } = req.body;
  if (!title || !content) {
    throw Object.assign(new Error('title and content are required'), { status: 400 });
  }

  const { rows } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.authorId, title, content, themes],
  );
  await recordAction({
    actor: req.user.name,
    action: 'book.uploaded',
    entityType: 'book',
    entityId: rows[0].id,
    authorId: Number(req.params.authorId),
    after: { ...rows[0], content: `${content.slice(0, 200)}…` },
    metadata: { contentLength: content.length, themes },
  });
  // A new book is fitted at once (STORY-046), so the first draft is written
  // with a model already in place — and the author sees what it learned.
  const { model } = await fitBookModel({ bookId: rows[0].id, trigger: 'book_uploaded', actor: req.user.name });
  res.status(201).json({ ...rows[0], model: summariseModel(model) });
}));

router.post('/authors/:authorId/social-history', validate(SCHEMAS.socialHistory), asyncRoute(async (req, res) => {
  const { posts } = req.body;
  if (!Array.isArray(posts) || posts.length === 0) {
    throw Object.assign(new Error('posts must be a non-empty array'), { status: 400 });
  }

  const inserted = [];
  for (const post of posts) {
    const { rows } = await query(
      `INSERT INTO social_history (author_id, platform, content, engagement, posted_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        req.params.authorId,
        post.platform,
        post.content,
        JSON.stringify(post.engagement ?? {}),
        post.postedAt ?? null,
      ],
    );
    inserted.push(rows[0]);
  }

  await recordAction({
    actor: req.user.name,
    action: 'social_history.uploaded',
    entityType: 'author',
    entityId: req.params.authorId,
    authorId: Number(req.params.authorId),
    metadata: { count: inserted.length },
  });
  res.status(201).json(inserted);
}));

// --- Drafting (build step 2) ---

router.post('/authors/:authorId/books/:bookId/drafts', validate(SCHEMAS.draftPosts), asyncRoute(async (req, res) => {
  const drafts = await draftWeeklyPosts({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    count: req.body?.count ?? config.minPostsPerWeek,
    platforms: req.body?.platforms ?? PLATFORMS,
    weekOf: req.body?.weekOf ?? weekStart(),
  });
  res.status(201).json(drafts);
}));

router.get('/drafts', validate(SCHEMAS.listDrafts), asyncRoute(async (req, res) => {
  const conditions = [];
  const params = [];
  for (const [column, value] of [
    ['author_id', req.query.authorId],
    ['status', req.query.status],
    ['week_of', req.query.weekOf],
  ]) {
    if (value) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM drafts ${where} ORDER BY created_at DESC, id DESC`, params);

  // Per-theme verdicts (STORY-009), the same shape press materials have carried
  // since STORY-006. The single alignment number tells a reviewer a post is
  // 0.62 aligned; these tell them which theme it named without arguing, which
  // is the only form of the finding they can act on.
  const { rows: draftThemes } = rows.length === 0
    ? { rows: [] }
    : await query(
        `SELECT * FROM draft_themes WHERE draft_id = ANY($1::bigint[]) ORDER BY draft_id, id`,
        [rows.map((d) => d.id)],
      );

  // The comparison with the book (STORY-047), kept when the draft was made.
  const { rows: reviews } = rows.length === 0
    ? { rows: [] }
    : await query('SELECT * FROM content_reviews WHERE draft_id = ANY($1::bigint[])', [rows.map((d) => d.id)]);
  // Ratings already given (STORY-048), latest per draft.
  const { rows: ratings } = rows.length === 0
    ? { rows: [] }
    : await query(
      `SELECT DISTINCT ON (draft_id) draft_id, rating, comment, given_by, created_at
         FROM content_feedback WHERE draft_id = ANY($1::bigint[]) ORDER BY draft_id, id DESC`,
      [rows.map((d) => d.id)],
    );

  res.json(
    rows.map((draft) => ({
      ...draft,
      themes: draftThemes.filter((t) => String(t.draft_id) === String(draft.id)),
      bookReview: reviews.find((r) => String(r.draft_id) === String(draft.id)) ?? null,
      feedback: ratings.find((r) => String(r.draft_id) === String(draft.id)) ?? null,
      floors: {
        confidence: config.confidenceEscalationThreshold,
        themeAlignment: config.minThemeAlignment,
        voice: config.minVoiceMatch,
      },
    })),
  );
}));

/**
 * What the drafter is given before it writes (STORY-009): what the book argues
 * about each theme, and the voice counted off the author's own posts.
 *
 * Served so a reviewer can see the evidence a post was written from rather than
 * only the score it earned against it — the same reason the press grounding is
 * on screen.
 */
router.get('/authors/:authorId/books/:bookId/voice-grounding', asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const bookId = Number(req.params.bookId);

  const { rows: books } = await query('SELECT * FROM books WHERE id = $1 AND author_id = $2', [
    bookId,
    authorId,
  ]);
  if (books.length === 0) return res.status(404).json({ error: 'Book not found for this author' });

  const grounding = await retrieveThemeGrounding({ bookId }, { query });
  const { rows: history } = await query(
    'SELECT platform, content FROM social_history WHERE author_id = $1',
    [authorId],
  );
  const { rows: authors } = await query('SELECT voice_profile FROM authors WHERE id = $1', [authorId]);
  const voice = deriveVoice(history, authors[0]?.voice_profile ?? {});

  return res.json({
    themes: grounding.themes.map((t) => ({
      theme: t.theme,
      keyMessage: t.keyMessage,
      passages: t.passages,
    })),
    passageCount: grounding.passageCount,
    voice: {
      priorPosts: voice.posts,
      enforceable: voice.enforceable,
      minPostsForTrait: MIN_POSTS_FOR_TRAIT,
      meanSentenceWords: Number(voice.meanSentenceWords.toFixed(1)),
      exclamationsPer100: Number(voice.exclamationsPer100.toFixed(2)),
      hypePer100: Number(voice.hypePer100.toFixed(2)),
      shoutedPer100: Number(voice.shoutedPer100.toFixed(2)),
      vocabulary: voice.vocabulary.size,
      statedClaims: voice.stated,
    },
    floors: {
      themeAlignment: config.minThemeAlignment,
      voice: config.minVoiceMatch,
    },
  });
}));

/** Weekly cadence proof for the "at least three posts per week" criterion. */
router.get('/authors/:authorId/weekly-coverage', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT week_of,
            COUNT(*)::int                        AS total,
            COUNT(DISTINCT platform)::int        AS platforms,
            ARRAY_AGG(DISTINCT platform ORDER BY platform) AS platform_list
       FROM drafts
      WHERE author_id = $1
      GROUP BY week_of
      ORDER BY week_of DESC`,
    [req.params.authorId],
  );
  res.json(
    rows.map((row) => ({
      ...row,
      meetsMinimum: row.total >= config.minPostsPerWeek,
      minimum: config.minPostsPerWeek,
    })),
  );
}));

// --- Approval gate (build step 4 precondition) ---

router.post('/drafts/:id/approve', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const draft = await approveDraft({
    draftId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

router.post('/drafts/:id/reject', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const draft = await rejectDraft({
    draftId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

/**
 * A reviewer's third answer (STORY-047): not yet. The draft is set aside with
 * the note and a revision, linked to it, comes back through the same gate.
 */
router.post('/drafts/:id/request-changes', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.requestChanges), asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const note = req.body.note;
  res.json(await requestChanges({
    draftId: Number(req.params.id),
    note,
    reviewer: req.user.name,
    user: req.user,
    reviseWith: async (draft) => {
      const { rows: [{ week }] } = await query('SELECT week_of::text AS week FROM drafts WHERE id = $1', [draft.id]);
      // The passage the reviewer saw quoted: a revision writes from another
      // where the book has one. `passage_ids` lists every passage grounding the
      // theme, so the one actually quoted is found in the draft's text.
      const { rows: grounding } = await query(
        `SELECT p.id, p.content FROM book_passages p
          WHERE p.id IN (SELECT unnest(passage_ids) FROM draft_themes WHERE draft_id = $1)`,
        [draft.id],
      );
      const seen = quotedPassages(draft.content, grounding);
      return draftWeeklyPosts({
        authorId: Number(draft.author_id),
        bookId: Number(draft.book_id),
        count: 1,
        platforms: [draft.platform],
        weekOf: week,
        memeCount: 0,
        revisionOf: Number(draft.id),
        revisionNote: note,
        previousContent: draft.content,
        revisionThemes: draft.themes_used,
        avoidPassages: seen.map((r) => Number(r.id)),
      });
    },
  }));
}));

// --- Scheduling and mocked publishing (build steps 4 and 5) ---

router.post('/drafts/:id/schedule', asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const scheduled = await scheduleDraft({ draftId: Number(req.params.id) });
  res.status(201).json(scheduled);
}));

router.get('/scheduled-posts', validate(SCHEMAS.listScheduled), asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.authorId) {
    params.push(req.query.authorId);
    where = 'WHERE sp.author_id = $1';
  }
  const { rows } = await query(
    `SELECT sp.*, d.content, d.confidence
       FROM scheduled_posts sp
       JOIN drafts d ON d.id = sp.draft_id
       ${where}
      ORDER BY sp.scheduled_for`,
    params,
  );
  res.json(rows);
}));

router.post('/scheduled-posts/publish-due', validate(SCHEMAS.publishDue), asyncRoute(async (req, res) => {
  const published = await publishDue({ now: req.body?.now ? new Date(req.body.now) : new Date() });
  res.json(published);
}));

// --- Opportunities (STORY-002 build steps 1 and 2) ---

router.post('/authors/:authorId/books/:bookId/opportunities/scout', validate(SCHEMAS.scout), asyncRoute(async (req, res) => {
  // `types` narrows the scan (STORY-010) — the story asks for a search *for
  // speaking opportunities*, and a podcast is not a speaking engagement.
  const requested = req.body?.types ?? null;
  if (requested !== null) {
    if (!Array.isArray(requested) || requested.length === 0) {
      return res.status(400).json({ error: 'types must be a non-empty array' });
    }
    const unknown = requested.filter((t) => !OPPORTUNITY_TYPES.includes(t));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `unknown opportunity type(s): ${unknown.join(', ')}. Known: ${OPPORTUNITY_TYPES.join(', ')}`,
      });
    }
  }

  const result = await scoutOpportunities({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    types: requested,
  });
  // The derived expertise carries a Set, which JSON.stringify renders as {}.
  // Send the shape a client can actually read rather than an empty object.
  return res.status(201).json({
    ...result,
    expertise: {
      books: result.expertise.books,
      posts: result.expertise.posts,
      themes: result.expertise.themes,
      formats: result.expertise.formats,
      doneTypes: result.expertise.doneTypes,
      subjectEvidence: result.expertise.subjectEvidence,
      enforceable: result.expertise.enforceable,
    },
  });
}));

/**
 * The leads the filter hid (STORY-010).
 *
 * STORY-002 counted rejections and discarded the listings, which left the one
 * part of the scan nobody could check as the part deciding what a human would
 * never see. Sorted by how close each came to qualifying, because a listing
 * sitting just under a floor is the one worth arguing about.
 */
router.get('/authors/:authorId/opportunity-rejections', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT *,
            GREATEST(relevance / NULLIF(relevance_floor, 0),
                     expertise / NULLIF(expertise_floor, 0)) AS closeness
       FROM opportunity_rejections
      WHERE author_id = $1
      ORDER BY closeness DESC NULLS LAST, name`,
    [req.params.authorId],
  );
  res.json(rows);
}));

router.get('/opportunities', validate(SCHEMAS.listOpportunities), asyncRoute(async (req, res) => {
  const conditions = [];
  const params = [];
  // Qualify every column: this query joins outreach_messages, which carries its
  // own author_id and status. Unqualified names are ambiguous to Postgres, and
  // an unqualified status that happened to resolve would filter the wrong table.
  for (const [column, value] of [
    ['o.author_id', req.query.authorId],
    ['o.type', req.query.type],
    ['o.status', req.query.status],
  ]) {
    if (value) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT o.*, m.id AS message_id, m.status AS message_status
       FROM opportunities o
       LEFT JOIN outreach_messages m ON m.opportunity_id = o.id
       ${where}
      -- Ranked on fit, the better of the two scores (STORY-010). Ordering by
      -- theme relevance alone sent every expertise-qualified lead to the bottom
      -- of the queue beneath every theme match, however strong its own claim —
      -- which is the blind spot this story closed, reproduced in the sort.
      ORDER BY o.fit DESC, o.relevance DESC, o.id`,
    params,
  );
  res.json(rows);
}));

/** Monthly cadence proof for the "at least five per month" criterion. */
router.get('/authors/:authorId/monthly-opportunities', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT discovered_month,
            COUNT(*)::int                              AS total,
            COUNT(DISTINCT type)::int                  AS types,
            ARRAY_AGG(DISTINCT type ORDER BY type)     AS type_list
       FROM opportunities
      WHERE author_id = $1 AND status = 'identified'
      GROUP BY discovered_month
      ORDER BY discovered_month DESC`,
    [req.params.authorId],
  );

  const byType = await query(
    `SELECT discovered_month, type, COUNT(*)::int AS total
       FROM opportunities
      WHERE author_id = $1 AND status = 'identified'
      GROUP BY discovered_month, type`,
    [req.params.authorId],
  );

  res.json(
    rows.map((row) => ({
      ...row,
      breakdown: byType.rows
        .filter((r) => String(r.discovered_month) === String(row.discovered_month))
        .reduce((acc, r) => ({ ...acc, [r.type]: r.total }), {}),
      meetsMinimum: row.total >= config.minOpportunitiesPerMonth,
      minimum: config.minOpportunitiesPerMonth,
      currentMonth: monthStart(),
    })),
  );
}));

// --- Outreach messages (STORY-002 build steps 3 to 5) ---

router.post('/authors/:authorId/books/:bookId/outreach/draft', validate(SCHEMAS.draftOutreach), asyncRoute(async (req, res) => {
  const messages = await draftOutreachMessages({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    opportunityIds: req.body?.opportunityIds ?? null,
    limit: req.body?.limit ?? 10,
  });
  res.status(201).json(messages);
}));

router.get('/outreach-messages', validate(SCHEMAS.listOutreach), asyncRoute(async (req, res) => {
  const conditions = [];
  const params = [];
  for (const [column, value] of [
    ['m.author_id', req.query.authorId],
    ['m.status', req.query.status],
  ]) {
    if (value) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT m.*,
            o.name AS opportunity_name, o.type AS opportunity_type,
            o.host AS opportunity_host, o.contact_email, o.relevance,
            s.status AS send_status, s.external_id AS send_external_id, s.sent_at
       FROM outreach_messages m
       JOIN opportunities o ON o.id = m.opportunity_id
       LEFT JOIN outreach_sends s ON s.message_id = m.id
       ${where}
      ORDER BY m.created_at DESC, m.id DESC`,
    params,
  );
  res.json(rows);
}));

router.post('/outreach-messages/:id/approve', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'outreach_messages', Number(req.params.id));
  const message = await approveOutreach({
    messageId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });

  // Approving is what queues the send (STORY-065). The button on the Outreach
  // tab still works and still goes through the same service; this is what makes
  // an approved pitch leave without anyone being at a screen.
  await enqueue({
    kind: 'outreach.send',
    idempotencyKey: `outreach.send:${message.id}`,
    authorId: message.author_id,
    payload: { messageId: Number(message.id) },
  });

  res.json(message);
}));

router.post('/outreach-messages/:id/reject', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'outreach_messages', Number(req.params.id));
  const message = await rejectOutreach({
    messageId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(message);
}));

router.post('/outreach-messages/:id/send', asyncRoute(async (req, res) => {
  await assertOwns(req, 'outreach_messages', Number(req.params.id));
  const send = await sendOutreachMessage({ messageId: Number(req.params.id) });
  res.status(201).json(send);
}));

// --- Milestones and press kits (STORY-003 build steps 1 to 4) ---

router.get('/authors/:authorId/milestones', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT m.*,
            k.id           AS kit_id,
            k.status       AS kit_status,
            b.published_on AS book_published_on,
            (m.event_date - CURRENT_DATE) AS days_until
       FROM milestones m
       JOIN books b ON b.id = m.book_id
       LEFT JOIN LATERAL (
            SELECT id, status
              FROM pr_kits
             WHERE milestone_id = m.id AND status <> 'superseded'
             ORDER BY id DESC
             LIMIT 1
       ) k ON true
      WHERE m.author_id = $1
      ORDER BY m.event_date`,
    [req.params.authorId],
  );
  res.json(
    rows.map((row) => ({
      ...row,
      anniversaryYears:
        row.type === 'anniversary'
          ? anniversaryYears({ publishedOn: row.book_published_on, eventDate: row.event_date })
          : null,
      awardOutcome: outcomeOf(row),
    })),
  );
}));

/** Read model for STORY-005: awards whose result nobody has recorded yet. */
router.get('/authors/:authorId/awards/awaiting-outcome', asyncRoute(async (req, res) => {
  const awaiting = await findAwardsAwaitingOutcome({ authorId: Number(req.params.authorId) });
  res.json({ awaiting, count: awaiting.length });
}));

/**
 * Command for STORY-005. Recording a win is what triggers the win release; the
 * release is still held for review, and recording a loss draws nothing.
 */
router.post('/milestones/:id/award-outcome', validate(SCHEMAS.awardOutcome), asyncRoute(async (req, res) => {
  await assertOwns(req, 'milestones', Number(req.params.id));
  const { outcome, awardName = null, actor = 'author', notes = '' } = req.body ?? {};
  if (!outcome) {
    throw Object.assign(new Error(`outcome is required (${AWARD_OUTCOMES.join(', ')})`), {
      status: 400,
    });
  }

  const result = await recordAwardOutcome({
    milestoneId: Number(req.params.id),
    outcome,
    awardName,
    actor,
    notes,
  });
  res.status(201).json(result);
}));

/** Read model for STORY-004: what is close enough to need a kit already. */
router.get('/authors/:authorId/milestones/approaching', validate(SCHEMAS.approaching), asyncRoute(async (req, res) => {
  const leadTimeDays = req.query.leadTimeDays
    ? Number(req.query.leadTimeDays)
    : config.milestoneLeadTimeDays;

  const approaching = await findApproachingMilestones({
    authorId: Number(req.params.authorId),
    leadTimeDays,
  });

  res.json({
    leadTimeDays,
    approaching,
    needingKit: approaching.filter((m) => !m.kit_id).length,
  });
}));

/** Command for STORY-004: draft a kit for every approaching milestone missing one. */
router.post('/authors/:authorId/milestones/draft-approaching', validate(SCHEMAS.draftApproaching), asyncRoute(async (req, res) => {
  const result = await draftApproachingKits({
    authorId: Number(req.params.authorId),
    leadTimeDays: req.body?.leadTimeDays ?? config.milestoneLeadTimeDays,
    ...(req.body?.now ? { now: new Date(req.body.now) } : {}),
  });
  res.status(201).json(result);
}));

router.post('/authors/:authorId/books/:bookId/milestones', validate(SCHEMAS.createMilestone), asyncRoute(async (req, res) => {
  const { type, title, eventDate, details = '', location = '', awardName = null } = req.body ?? {};
  if (!type || !title || !eventDate) {
    throw Object.assign(new Error('type, title and eventDate are required'), { status: 400 });
  }

  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, details, location, award_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (book_id, type, event_date) DO UPDATE
       SET title = EXCLUDED.title, details = EXCLUDED.details, location = EXCLUDED.location,
           award_name = COALESCE(EXCLUDED.award_name, milestones.award_name)
     RETURNING *`,
    [
      Number(req.params.authorId),
      Number(req.params.bookId),
      type,
      title,
      eventDate,
      details,
      location,
      type === 'award' ? awardName : null,
    ],
  );

  await recordAction({
    actor: req.user.name,
    action: 'milestone.scheduled',
    entityType: 'milestone',
    entityId: rows[0].id,
    authorId: Number(req.params.authorId),
    after: rows[0],
    metadata: { type, eventDate },
  });
  res.status(201).json(rows[0]);
}));

router.post('/milestones/:id/press-kit', asyncRoute(async (req, res) => {
  await assertOwns(req, 'milestones', Number(req.params.id));
  const result = await draftPressKit({ milestoneId: Number(req.params.id) });
  res.status(201).json(result);
}));

// --- PR materials on request (STORY-018 / REQ-011 + REQ-004) ---

/**
 * The command half of the slice: a publicist asks for PR materials, and gets
 * them, with no milestone in the calendar and none invented.
 *
 * `:authorId` is spelled exactly so `tenantParam` guards it; the service scopes
 * the book to the author as well, because the guard checks the address and not
 * the answer.
 */
router.post('/authors/:authorId/books/:bookId/pr-materials', asyncRoute(async (req, res) => {
  // No `angle` parameter. There is exactly one angle a kit with no occasion can
  // take, and accepting a string nothing reads would be a knob that does
  // nothing — the kit records `evergreen` because that is what it is, not
  // because a caller said so.
  const result = await generatePrMaterials({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    requestedBy: req.user?.name ?? null,
  });
  res.status(201).json(result);
}));

router.get('/press-kits', validate(SCHEMAS.listPressKits), asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.authorId) {
    params.push(req.query.authorId);
    where = 'WHERE k.author_id = $1';
  }

  const { rows: kits } = await query(
    // LEFT JOIN, because an on-demand kit has no milestone (STORY-018). An
    // inner join here did not merely lose a column — it dropped the whole kit
    // from the page a publicist approves from, which is the failure mode of
    // making a required thing optional.
    //
    // The counts come from a lateral subquery rather than GROUP BY k.id. On a
    // table Postgres lets `k.*` ride on grouping by the primary key; inside a
    // tenant schema (STORY-041) `pr_kits` is a view, which has no primary key,
    // and the same query is refused.
    `SELECT k.*,
            COALESCE(m.title, 'Requested directly')                  AS milestone_title,
            m.type AS milestone_type,
            m.event_date, m.location, m.details, m.award_name, m.outcome,
            agg.material_count, agg.approved_count, agg.distributed_count,
            agg.min_theme_alignment, agg.min_voice_score
       FROM pr_kits k
       LEFT JOIN milestones m ON m.id = k.milestone_id
       CROSS JOIN LATERAL (
         SELECT COUNT(p.id)::int                                     AS material_count,
                COUNT(*) FILTER (WHERE p.status = 'approved')::int   AS approved_count,
                COUNT(*) FILTER (WHERE p.status = 'distributed')::int AS distributed_count,
                COALESCE(MIN(p.theme_alignment), 0)                  AS min_theme_alignment,
                COALESCE(MIN(p.voice_score), 0)                      AS min_voice_score
           FROM pr_materials p WHERE p.kit_id = k.id) agg
       ${where}
      ORDER BY COALESCE(m.event_date, k.created_at::date), k.id`,
    params,
  );

  const { rows: materials } = await query(
    `SELECT p.* FROM pr_materials p
       ${req.query.authorId ? 'WHERE p.author_id = $1' : ''}
      ORDER BY p.kit_id, p.id`,
    params,
  );

  const { rows: distributions } = await query(
    `SELECT d.* FROM pr_distributions d
       ${req.query.authorId ? 'WHERE d.author_id = $1' : ''}
      ORDER BY d.kit_id, d.id`,
    params,
  );

  // Per-theme alignment (STORY-006). The single number tells a reviewer a draft
  // is 0.87 aligned; these tell them which theme it named without arguing,
  // which is the only form of the finding they can do anything about.
  const { rows: materialThemes } = await query(
    `SELECT t.* FROM pr_material_themes t
       JOIN pr_materials p ON p.id = t.material_id
       ${req.query.authorId ? 'WHERE p.author_id = $1' : ''}
      ORDER BY t.material_id, t.id`,
    params,
  );

  const withThemes = (material) => ({
    ...material,
    themes: materialThemes.filter((t) => t.material_id === material.id),
  });

  res.json(
    kits.map((kit) => ({
      ...kit,
      readyToDistribute:
        kit.status === 'drafting' &&
        kit.material_count > 0 &&
        kit.approved_count === kit.material_count,
      materials: materials.filter((m) => m.kit_id === kit.id).map(withThemes),
      distributions: distributions.filter((d) => d.kit_id === kit.id),
    })),
  );
}));

/**
 * The grounding a draft would be written from (STORY-006 build step 4).
 *
 * Readable before anything is drafted, on purpose: a theme with no key message
 * and no retrievable passage is a theme the next press kit cannot argue, and
 * that is worth knowing while it is still cheap to fix.
 */
router.get('/books/:bookId/themes', asyncRoute(async (req, res) => {
  await assertOwns(req, 'books', Number(req.params.bookId));
  // A book the caller cannot see is a book that does not exist, to them. This
  // used to answer 200 with no themes for any id at all; inside a tenant schema
  // (STORY-041) another author's book is simply absent, and 404 says so without
  // confirming the id belongs to someone.
  const { rows: book } = await query('SELECT 1 FROM books WHERE id = $1', [req.params.bookId]);
  if (book.length === 0) return res.status(404).json({ error: 'Book not found' });
  const { rows } = await query(
    `SELECT t.theme,
            t.key_message,
            t.position,
            COUNT(p.id)::int AS passage_count
       FROM book_themes t
       LEFT JOIN book_passages p
              ON p.book_id = t.book_id
             AND p.tsv @@ plainto_tsquery('english', t.theme)
      WHERE t.book_id = $1
      GROUP BY t.theme, t.key_message, t.position
      ORDER BY t.position, t.theme`,
    [req.params.bookId],
  );

  const { rows: totals } = await query(
    'SELECT COUNT(*)::int AS passages FROM book_passages WHERE book_id = $1',
    [req.params.bookId],
  );

  res.json({
    bookId: Number(req.params.bookId),
    passages: totals[0].passages,
    themes: rows,
    ungrounded: rows.filter((t) => t.passage_count === 0).map((t) => t.theme),
    withoutKeyMessage: rows.filter((t) => !t.key_message).map((t) => t.theme),
  });
}));

router.post('/pr-materials/:id/approve', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'pr_materials', Number(req.params.id));
  const material = await approvePrMaterial({
    materialId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(material);
}));

router.post('/pr-materials/:id/reject', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  await assertOwns(req, 'pr_materials', Number(req.params.id));
  const material = await rejectPrMaterial({
    materialId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(material);
}));

router.post('/press-kits/:id/distribute', asyncRoute(async (req, res) => {
  await assertOwns(req, 'pr_kits', Number(req.params.id));
  const result = await distributePressKit({ kitId: Number(req.params.id) });
  res.status(201).json(result);
}));

router.get('/press-contacts', asyncRoute(async (_req, res) => {
  const { rows } = await query('SELECT * FROM press_contacts ORDER BY id');
  res.json(rows);
}));

// --- Human review of PR drafts (STORY-007 / REQ-006) ---

/**
 * Who hears about pending work. An address book, not an access list — nothing
 * here decides what anyone may approve, and `approvals.reviewer` is still the
 * record of who actually decided.
 */
router.get('/authors/:authorId/reviewers', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM reviewers WHERE author_id = $1 ORDER BY id',
    [req.params.authorId],
  );
  res.json(rows);
}));

router.post('/authors/:authorId/reviewers', validate(SCHEMAS.addReviewer), asyncRoute(async (req, res) => {
  const { name, email, role = 'reviewer', phone = null } = req.body ?? {};
  if (!name?.trim() || !email?.trim()) {
    throw Object.assign(new Error('name and email are required'), { status: 400 });
  }

  const { rows } = await query(
    `INSERT INTO reviewers (author_id, name, email, role, phone)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (author_id, email) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, phone = EXCLUDED.phone, active = TRUE
     RETURNING *`,
    [Number(req.params.authorId), name.trim(), email.trim(), role, phone || null],
  );

  await recordAction({
    actor: req.user.name,
    action: 'reviewer.added',
    entityType: 'reviewer',
    entityId: rows[0].id,
    authorId: Number(req.params.authorId),
    after: rows[0],
    metadata: { role },
  });
  res.status(201).json(rows[0]);
}));

/** Deactivating keeps the notifications already sent, and the log pointing at them. */
router.post('/reviewers/:id/active', validate(SCHEMAS.reviewerActive), asyncRoute(async (req, res) => {
  await assertOwns(req, 'reviewers', Number(req.params.id));
  const active = req.body?.active !== false;
  const { rows } = await query(
    'UPDATE reviewers SET active = $2 WHERE id = $1 RETURNING *',
    [req.params.id, active],
  );
  if (!rows[0]) throw Object.assign(new Error('Reviewer not found'), { status: 404 });

  await recordAction({
    actor: req.user.name,
    action: active ? 'reviewer.reactivated' : 'reviewer.deactivated',
    entityType: 'reviewer',
    entityId: rows[0].id,
    authorId: rows[0].author_id,
    after: rows[0],
    metadata: {},
  });
  res.json(rows[0]);
}));

/** The read model: what is sitting on a human right now. */
router.get('/authors/:authorId/pending-review', asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const kits = await findKitsAwaitingReview({ authorId }, { query });
  const reviewers = await findReviewers({ authorId }, { query });

  const { rows: notified } = await query(
    `SELECT pr_kit_id, COUNT(*)::int AS sent
       FROM notifications
      WHERE author_id = $1 AND status = 'sent'
      GROUP BY pr_kit_id`,
    [authorId],
  );

  res.json({
    reviewers: reviewers.length,
    kits: kits.map((kit) => ({
      ...kit,
      notified: notified.find((n) => Number(n.pr_kit_id) === Number(kit.id))?.sent ?? 0,
    })),
    materialsAwaitingReview: kits.reduce((n, k) => n + k.pending_count, 0),
    // Work waiting with nobody to tell is the state this story exists to make
    // visible, so the read model says it rather than leaving a reader to notice.
    unreachable: kits.length > 0 && reviewers.length === 0,
  });
}));

/** What a scheduled worker would call. Nothing runs on a timer yet (known gap). */
router.post('/authors/:authorId/notify-pending', asyncRoute(async (req, res) => {
  const result = await notifyPendingReviews({ authorId: Number(req.params.authorId) });
  res.status(201).json(result);
}));

router.get('/notifications', validate(SCHEMAS.listNotifications), asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.authorId) {
    params.push(req.query.authorId);
    where = 'WHERE n.author_id = $1';
  }
  const { rows } = await query(
    `SELECT n.*, r.name AS reviewer_name, r.email AS reviewer_email, r.role AS reviewer_role,
            m.title AS milestone_title
       FROM notifications n
       JOIN reviewers r ON r.id = n.reviewer_id
       LEFT JOIN pr_kits k ON k.id = n.pr_kit_id
       LEFT JOIN milestones m ON m.id = k.milestone_id
       ${where}
      ORDER BY n.id DESC`,
    params,
  );
  res.json(rows);
}));

// --- Trust history and breach episodes (STORY-021 / REQ-007) ---

/**
 * The score as a series, and every episode of a check being broken.
 *
 * Served separately from the dashboard so "is this getting worse" can be asked
 * without recomputing every check — the dashboard's own assessment is the
 * expensive part, and a chart should not pay for it.
 */
// STORY-050: audit data, so audit.read — authors hold it for their own trail;
// an API key, holding nothing, read all three of these before.
router.get('/authors/:authorId/trust-history', requirePermission(PERMISSIONS.AUDIT_READ), validate(SCHEMAS.trustHistory), asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const [history, episodes] = await Promise.all([
    assessmentHistory({ authorId, limit: Number(req.query.limit ?? 30) }),
    checkEpisodes({ authorId }),
  ]);
  const open = episodes.filter((e) => e.recovered_at === null);
  res.json({
    history,
    episodes,
    open: open.length,
    // The headline an operator wants: not "something is broken" but "this has
    // been broken since Tuesday and nobody was told".
    unalerted: open.filter((e) => e.severity === 'invariant' && !e.alerted_at).map((e) => e.check_id),
  });
}));

// --- Escalation of low-confidence drafts (STORY-008 / REQ-003) ---

/** The read-model: what was escalated, why, and whether it is still open. */
router.get('/authors/:authorId/escalations', asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const all = await listEscalations({ authorId });
  const open = all.filter((e) => e.open);

  res.json({
    escalations: all,
    open: open.length,
    thresholds: thresholds(),
    // The number worth reading: escalations an independent check had to raise
    // because the drafting agent had queued them as fine.
    raisedByMonitor: all.filter((e) => e.detected_by === 'monitor').length,
    disagreements: all.filter((e) => !e.agreed).length,
  });
}));

/** Runs the monitor on demand. The worker runs it on a schedule regardless. */
router.post('/authors/:authorId/escalations/scan', asyncRoute(async (req, res) => {
  const result = await monitorPressMaterials({ authorId: Number(req.params.authorId) });
  res.status(201).json({
    examined: result.examined,
    raised: result.raised,
    confirmed: result.confirmed.length,
    producerStricter: result.producerStricter.length,
  });
}));

// --- Background worker (STORY-065 / REQ-004) ---

// --- Access changes (STORY-042 / REQ-011) ---

/**
 * Who holds what, what is waiting for a decision, and how each privileged
 * account got its role. Readable by whoever may change access, and by
 * compliance — reviewing who approved whose access is their job.
 */
// Not `audit.read` alone: authors hold that, to read their own trail, and the
// first version of this gate showed an author every staff account in the
// system. Reviewing access is for whoever manages it, or reads across tenants.
router.get('/access', requireAuditReviewer, asyncRoute(async (req, res) => {
  const [overview, matrix] = await Promise.all([accessOverview(), grantMatrix()]);
  return res.json({ ...overview, matrix, you: req.user.id });
}));

router.post('/access/changes', requirePermission(PERMISSIONS.ACCESS_MANAGE), validate(SCHEMAS.proposeAccessChange), asyncRoute(async (req, res) => {
  const { kind, role, permission, userId, newRole, reason } = req.body;
  res.status(201).json(await proposeChange({ kind, role, permission, userId, newRole, reason, user: req.user }));
}));

router.post('/access/changes/:id/approve', requirePermission(PERMISSIONS.ACCESS_MANAGE), validate(SCHEMAS.decideAccessChange), asyncRoute(async (req, res) => {
  res.json(await decideChange({ id: req.params.id, user: req.user, approve: true, note: req.body.note }));
}));

router.post('/access/changes/:id/reject', requirePermission(PERMISSIONS.ACCESS_MANAGE), validate(SCHEMAS.decideAccessChange), asyncRoute(async (req, res) => {
  res.json(await decideChange({ id: req.params.id, user: req.user, approve: false, note: req.body.note }));
}));

router.post('/access/changes/:id/withdraw', requirePermission(PERMISSIONS.ACCESS_MANAGE), asyncRoute(async (req, res) => {
  res.json(await withdrawChange({ id: req.params.id, user: req.user }));
}));

// --- Tenant schema (STORY-041 / REQ-011) ---

/**
 * The caller's own schema, and the database role this very request ran as.
 * The second is the proof: for an author it is `ale_tenant_<id>`, which can
 * read nothing outside their schema — not the shared login.
 */
router.get('/authors/:authorId/tenant-schema', asyncRoute(async (req, res) => {
  const [{ rows: [who] }, schema] = await Promise.all([
    query("SELECT current_user AS role, current_setting('search_path') AS search_path"),
    tenantSchema(Number(req.params.authorId)),
  ]);
  res.json({ ...schema, thisRequestRanAs: who.role, searchPath: who.search_path });
}));

// --- Messages between agents (STORY-039 / REQ-010) ---

/** What agents have told each other, how fast, and what is stuck. */
router.get('/messages', asyncRoute(async (req, res) => {
  const scope = holds(req.user, PERMISSIONS.TENANT_READ_ALL) ? null : req.user.authorId;
  res.json(await busStatus({ authorId: scope }));
}));

/** Put a dead letter back in the queue. An operator's decision, on the record. */
router.post('/messages/:id/redeliver', requirePermission(PERMISSIONS.SYSTEM_OPERATE), asyncRoute(async (req, res) => {
  res.json(await redeliver({ id: req.params.id, user: req.user }));
}));

/** Run health. What ran, what is waiting, and what has stopped waiting for a robot. */
router.get('/jobs', asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  // Global sweeps have no author. An author sees their own work and the global
  // runs that act on it; a session that reads across tenants sees everything.
  if (!holds(req.user, PERMISSIONS.TENANT_READ_ALL)) {
    params.push(req.user.authorId);
    where = 'WHERE (author_id = $1 OR author_id IS NULL)';
  }

  const { rows: jobs } = await query(
    `SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT 100`,
    params,
  );
  const { rows: health } = await query(
    `SELECT status, COUNT(*)::int AS n FROM jobs ${where} GROUP BY status`,
    params,
  );

  res.json({
    jobs,
    health: Object.fromEntries(health.map((h) => [h.status, h.n])),
    // The number that matters: work the system has stopped trying to do.
    needsHuman: jobs.filter((j) => j.status === 'dead_letter').length,
    pollSeconds: config.workerPollSeconds,
    sweepSeconds: config.jobSweepSeconds,
    maxAttempts: config.jobMaxAttempts,
  });
}));

// --- Tenants (STORY-017 / REQ-010) ---

/**
 * Onboarding a tenant is an operator action.
 *
 * It creates an author, an account and a role in one transaction — a tenant
 * with no account is unreachable and an account with no tenant is a session
 * with nothing behind it, and either half alone is a broken state somebody
 * cleans up by hand.
 */
router.post('/tenants', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(SCHEMAS.onboardTenant), asyncRoute(async (req, res) => {
  // No password through the API (STORY-043): the author sets their own from
  // the emailed link. And the admin who did it goes on the record.
  const { name, email, role, voiceProfile } = req.body ?? {};
  res.status(201).json(await onboardTenant({ name, email, role, voiceProfile, onboardedBy: req.user }));
}));

/** Every tenant, whether they have signed in yet, and their schema — the admin's onboarding view. */
router.get('/tenants', requirePermission(PERMISSIONS.TENANT_READ_ALL), asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.name, a.email, a.tenant_status, a.onboarded_at,
            u.id AS user_id, (u.password_hash IS NOT NULL) AS activated,
            to_regnamespace('tenant_' || a.id) IS NOT NULL AS has_schema,
            i.expires_at AS invite_expires_at, i.created_at AS invited_at,
            (i.expires_at < now()) AS invite_expired,
            (SELECT actor FROM audit_log l WHERE l.action = 'tenant.onboarded' AND l.author_id = a.id ORDER BY l.id DESC LIMIT 1) AS onboarded_by
       FROM authors a
       LEFT JOIN users u ON u.author_id = a.id
       LEFT JOIN LATERAL (
         SELECT * FROM tenant_invites t WHERE t.author_id = a.id AND t.used_at IS NULL AND t.revoked_at IS NULL
          ORDER BY t.id DESC LIMIT 1) i ON TRUE
      ORDER BY a.id DESC LIMIT 100`,
  );
  res.json(rows);
}));

/** "I never got the email": a fresh link, and the old one stops working. */
router.post('/tenants/:authorId/invite', requirePermission(PERMISSIONS.TENANT_MANAGE), asyncRoute(async (req, res) => {
  res.json(await resendInvite({ authorId: req.params.authorId, user: req.user }));
}));

router.post('/tenants/:authorId/suspend', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(SCHEMAS.suspendTenant), asyncRoute(async (req, res) => {
  res.json(
    await suspendTenant({
      authorId: Number(req.params.authorId),
      reason: req.body?.reason ?? '',
      user: req.user,
    }),
  );
}));

router.post('/tenants/:authorId/restore', requirePermission(PERMISSIONS.TENANT_MANAGE), asyncRoute(async (req, res) => {
  res.json(await restoreTenant({ authorId: Number(req.params.authorId), user: req.user }));
}));

/**
 * Checks isolation by asking the database directly, table by table.
 *
 * Deliberately not routed through the middleware it is checking: a check that
 * went through the tenant guard would only ever confirm the guard agrees with
 * itself.
 */
router.get('/tenants/isolation', requirePermission(PERMISSIONS.TENANT_READ_ALL), asyncRoute(async (_req, res) => {
  res.json(await verifyIsolation({}));
}));

// --- Trust dashboard (STORY-014 / REQ-007) ---

/**
 * System health, pending approvals, recent actions and anomalies, in one place.
 *
 * Every number is produced by the module that owns it. A dashboard that
 * recomputed what it displays would be a second implementation free to disagree
 * with the first, and the disagreement would be invisible.
 */
router.get('/authors/:authorId/trust-dashboard', requirePermission(PERMISSIONS.AUDIT_READ), asyncRoute(async (req, res) => {
  res.json(await trustDashboard({ authorId: Number(req.params.authorId) }));
}));

// --- Audit integrity (STORY-013 / REQ-006) ---

/**
 * Whether the log still says what it said when it was written.
 *
 * Read-only, and available to anyone signed in: the point of an audit log is
 * that its integrity is checkable, and a check only an administrator can run is
 * a check most people have to take on trust.
 */
router.get('/audit-integrity', requirePermission(PERMISSIONS.AUDIT_VERIFY), asyncRoute(async (_req, res) => {
  const verification = await verifyAuditLog({});
  const { rows: checkpoints } = await query(
    `SELECT id, from_id, to_id, row_count, LEFT(digest, 16) AS digest, sealed_at
       FROM audit_checkpoints ORDER BY id DESC LIMIT 20`,
  );
  const { rows: unsealed } = await query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE id > COALESCE((SELECT MAX(to_id) FROM audit_checkpoints), 0)`,
  );
  // Encryption at rest (STORY-049): counted by the storage, which this login cannot read.
  const { rows: [encryption] } = await query('SELECT * FROM audit_encryption_status()');
  res.json({
    ...verification,
    checkpoints,
    unsealed: unsealed[0].n,
    encryption: { ...encryption, cipher: 'AES-256 (OpenPGP symmetric, with integrity check)', keyId: auditKeyId },
  });
}));

/** Seals what is new and re-checks every seal. Detects; it cannot repair. */
router.post('/audit-integrity/verify', requirePermission(PERMISSIONS.AUDIT_VERIFY), asyncRoute(async (_req, res) => {
  res.status(201).json(await sealAndVerify({}));
}));

// --- Everything waiting on a human (STORY-012 / REQ-005) ---

/**
 * One queue across all four things a human decides.
 *
 * A read-model, not a table: "what is waiting" is a question the status columns
 * already answer, and a second copy of that state would be free to disagree
 * with them.
 */
router.get('/authors/:authorId/awaiting-approval', asyncRoute(async (req, res) => {
  res.json(await findAwaitingApproval({ authorId: Number(req.params.authorId) }));
}));

/** Runs the notification sweep on demand. Tells people; decides nothing. */
router.post('/authors/:authorId/awaiting-approval/notify', asyncRoute(async (req, res) => {
  const result = await notifyAwaitingApproval({ authorId: Number(req.params.authorId) });
  res.status(201).json({
    notified: result.notified,
    alreadyKnown: result.skipped.length,
    unreachable: result.unreachable,
    waiting: result.queue.total,
  });
}));

// --- Meme vs text performance (STORY-069 / REQ-001) ---

/**
 * The comparison, and the open recommendations behind it.
 *
 * Returned together because a reader looking at "memes lead on twitter" needs
 * to see in the same breath whether anything has been proposed off the back of
 * it — and whether it was approved.
 */
router.get('/authors/:authorId/format-performance', asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const comparison = await compareFormats({ authorId });
  const { rows: recommendations } = await query(
    `SELECT * FROM mix_recommendations WHERE author_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [authorId],
  );
  const { rows: authors } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
    authorId,
  ]);
  res.json({
    ...comparison,
    recommendations,
    // What the drafter is actually doing right now, so the page can show that an
    // unapproved recommendation has changed nothing.
    memesPerBatch: authors[0]?.memes_per_batch ?? config.minMemesPerBatch,
  });
}));

/**
 * Every published post with its series, and what the numbers can and cannot
 * say (STORY-029). Assembled from the rows the sweep wrote.
 */
router.get('/authors/:authorId/content-performance', asyncRoute(async (req, res) => {
  res.json(await contentPerformance({ authorId: Number(req.params.authorId) }));
}));

/** Runs a collection pass. Mocked adapters; the audit log says so. */
router.post('/authors/:authorId/engagement/collect', validate(SCHEMAS.collectEngagement), asyncRoute(async (req, res) => {
  const collected = await collectEngagement({
    authorId: Number(req.params.authorId),
    // Exposed so the demo can simulate a world where memes lead, out loud. It
    // defaults to 0 and the audit log records whatever was used.
    formatEffect: Number(req.body?.formatEffect ?? 0),
  });
  res.status(201).json({ collected: collected.length });
}));

/** Asks the Trust and Monitoring Agent for a proposal. It proposes; it does not apply. */
router.post('/authors/:authorId/mix-recommendations/scan', asyncRoute(async (req, res) => {
  res.status(201).json(await recommendMix({ authorId: Number(req.params.authorId) }));
}));

router.post('/mix-recommendations/:id/approve', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  res.json(
    await approveMixRecommendation({
      recommendationId: Number(req.params.id),
      reviewer: req.body?.reviewer,
      notes: req.body?.notes,
      user: req.user,
    }),
  );
}));

router.post('/mix-recommendations/:id/reject', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.decision), asyncRoute(async (req, res) => {
  res.json(
    await rejectMixRecommendation({
      recommendationId: Number(req.params.id),
      reviewer: req.body?.reviewer,
      notes: req.body?.notes,
      user: req.user,
    }),
  );
}));

// --- Visual identity (STORY-068 / REQ-001) ---

/**
 * The guide in force, and every version behind it.
 *
 * History is returned alongside the active version rather than on its own
 * endpoint, because the useful question is almost always "what changed and who
 * changed it" rather than "what is version 2".
 */
router.get('/authors/:authorId/books/:bookId/visual-identity', asyncRoute(async (req, res) => {
  const bookId = Number(req.params.bookId);
  const versions = await listVersions({ bookId });
  res.json({
    active: versions.find((v) => v.active) ?? null,
    versions,
    floor: config.minIdentityMatch,
  });
}));

/**
 * Revise the guide. Always a new version, never an edit in place.
 *
 * The author is the authority on what their book looks like, so this takes
 * whatever they send rather than re-deriving — but it records that a human set
 * it, which is the difference between a guide with evidence behind it and one
 * with an opinion behind it, and the UI shows which.
 */
router.post('/authors/:authorId/books/:bookId/visual-identity', validate(SCHEMAS.visualIdentity), asyncRoute(async (req, res) => {
  const authorId = Number(req.params.authorId);
  const bookId = Number(req.params.bookId);
  const current = await getActiveIdentity({ bookId });

  const { rows: books } = await query('SELECT * FROM books WHERE id = $1 AND author_id = $2', [
    bookId,
    authorId,
  ]);
  if (books.length === 0) return res.status(404).json({ error: 'Book not found for this author' });

  const body = req.body ?? {};
  const base = current ?? deriveIdentity({ book: books[0] });

  const palette = { ...(current?.palette ?? base.palette), ...(body.palette ?? {}) };
  for (const key of ['ground', 'ink', 'accent']) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(palette[key] ?? ''))) {
      return res.status(400).json({ error: `palette.${key} must be a #rrggbb colour` });
    }
  }

  return res.status(201).json(
    await saveIdentity({
      authorId,
      bookId,
      guide: {
        palette,
        typography: body.typography ?? current?.typography ?? base.typography,
        tone_words: body.toneWords ?? current?.toneWords ?? base.tone_words,
        do_not_use: body.doNotUse ?? current?.doNotUse ?? base.do_not_use,
        derived_from: {
          ...(current?.derivedFrom ?? base.derived_from),
          confidence: 'set by the author',
        },
      },
      createdBy: req.user?.name ?? 'author',
      note: body.note ?? '',
    }),
  );
}));

// --- Meme template library (STORY-067 / REQ-001) ---

/**
 * Browse the library, with the verdict on each template rather than only the row.
 *
 * `usable` is computed here rather than stored, so the answer always reflects
 * the rule in force now: a licence that stops permitting commercial use is a
 * change to the row, and every reader should see the consequence immediately.
 */
router.get('/meme-templates', validate(SCHEMAS.listTemplates), asyncRoute(async (req, res) => {
  const templates = await listTemplates();
  // With a book in scope, say how each template sits against that book's
  // identity too (STORY-068). Licensed and on-brand are different questions and
  // an author browsing the library needs both — a template can be perfectly
  // licensed and still not look like their book.
  const identity = req.query.bookId
    ? await getActiveIdentity({ bookId: Number(req.query.bookId) })
    : null;

  res.json(
    templates.map((template) => {
      const verdict = assessTemplate(template);
      // A meme format is shown, and judged, in this book's colours.
      const imageRef = themedArtwork(template.imageRef, identity);
      const fit = identity
        ? scoreIdentity({ imageRef, identity })
        : null;
      return {
        ...template,
        imageRef,
        usable: verdict.usable,
        reason: verdict.reason,
        detail: verdict.detail,
        identityScore: fit?.score ?? null,
        identityFindings: fit?.findings ?? [],
        identityFloor: config.minIdentityMatch,
      };
    }),
  );
}));

/**
 * Adding and retiring are admin-only.
 *
 * The library is global rather than per-author: one tenant retiring a template
 * changes what every other tenant's generator can reach for, which is exactly
 * the kind of decision the operator role exists for. Browsing stays open.
 */
router.post('/meme-templates', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), validate(SCHEMAS.addTemplate), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  for (const field of ['key', 'name', 'layout', 'image_ref']) {
    if (!body[field]) return res.status(400).json({ error: `${field} is required` });
  }
  if (!Array.isArray(body.caption_slots) || body.caption_slots.length === 0) {
    return res.status(400).json({ error: 'caption_slots must be a non-empty array' });
  }
  // The service refuses a template nobody can licence; the route does not
  // second-guess it, and does not offer a way around it either.
  return res.status(201).json(await addTemplate(body, { user: req.user }));
}));

router.post('/meme-templates/:key/retire', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), validate(SCHEMAS.retireTemplate), asyncRoute(async (req, res) => {
  res.json(
    await retireTemplate({
      key: req.params.key,
      reason: req.body?.reason ?? '',
      user: req.user,
    }),
  );
}));

/** Put a dead letter back in the queue. The only thing a human does to a job. */
router.post('/jobs/:id/retry', asyncRoute(async (req, res) => {
  await assertOwns(req, 'jobs', Number(req.params.id));
  res.json(await retryJob({ jobId: Number(req.params.id), user: req.user }));
}));

/**
 * Runs one worker cycle on demand.
 *
 * The worker is a separate process; this exists so the demo and the UI can show
 * a cycle happening without waiting on a poll interval. It does exactly what the
 * worker's loop does, once.
 */
router.post('/jobs/tick', asyncRoute(async (_req, res) => {
  const { reclaimed, scheduled, ran } = await tick();
  res.status(201).json({
    reclaimed: reclaimed.length,
    scheduled: scheduled.length,
    ran: ran.map((j) => ({ id: j.id, kind: j.kind, status: j.status, result: j.result })),
  });
}));

// --- Audit trail (REQ-005) ---

router.get('/audit-log', requirePermission(PERMISSIONS.AUDIT_READ), validate(SCHEMAS.auditLog), asyncRoute(async (req, res) => {
  const rows = await listAuditLog({
    authorId: req.query.authorId,
    entityType: req.query.entityType,
    limit: Number(req.query.limit ?? 100),
  });
  res.json(rows);
}));

// STORY-041: every GET route declared above runs inside the caller's tenant
// schema, except the ones `middleware/tenantScope.js` declares with a reason.
// Applied last so it covers every route, including ones added later.
// --- Tenant data access audit (STORY-044 / REQ-011) ---


/** Every recorded access, filtered — the security officer's report. */
router.get('/security/access', requireAuditReviewer, validate(SCHEMAS.accessReport), asyncRoute(async (req, res) => {
  const { tenant, user, outcome, hours } = req.query;
  res.json(await accessReport({ authorId: tenant || null, userId: user || null, outcome: outcome || null, hours }));
}));

/** Who has read this tenant's data. Through the tenant's own view when an author asks. */
router.get('/authors/:authorId/access-events', requirePermission(PERMISSIONS.AUDIT_READ), asyncRoute(async (req, res) => {
  res.json(await tenantAccessEvents(req.params.authorId));
}));

/** Mitigation: an account that keeps trying doors stops on its next request. */
router.post('/security/accounts/:id/block', requirePermission(PERMISSIONS.ACCESS_MANAGE), validate(SCHEMAS.blockAccount), asyncRoute(async (req, res) => {
  res.json(await setAccountBlocked({ userId: req.params.id, blocked: true, reason: req.body.reason, user: req.user }));
}));

router.post('/security/accounts/:id/unblock', requirePermission(PERMISSIONS.ACCESS_MANAGE), asyncRoute(async (req, res) => {
  res.json(await setAccountBlocked({ userId: req.params.id, blocked: false, user: req.user }));
}));

// --- Per-tenant API keys (STORY-045 / REQ-011) ---

/** This tenant's keys: prefix, name, access, who made it, last use. Never the key. */
router.get('/authors/:authorId/api-keys', asyncRoute(async (req, res) => {
  res.json(await listApiKeys({ authorId: req.params.authorId, user: req.user }));
}));

/** A new key, shown once in this response and stored only as a hash. */
router.post('/authors/:authorId/api-keys', validate(SCHEMAS.createApiKey), asyncRoute(async (req, res) => {
  const { name, access, expiresInDays } = req.body;
  res.status(201).json(await createApiKey({ authorId: req.params.authorId, name, access, expiresInDays, user: req.user }));
}));

router.post('/authors/:authorId/api-keys/:id/revoke', asyncRoute(async (req, res) => {
  res.json(await revokeApiKey({ authorId: req.params.authorId, keyId: req.params.id, user: req.user }));
}));

// --- A model fitted to each book (STORY-046 / REQ-012) ---

/** What was fitted to this book: lexicons, lines, style, its held-out score, and every version. */
router.get('/authors/:authorId/books/:bookId/model', asyncRoute(async (req, res) => {
  res.json(await describeBookModel({ bookId: req.params.bookId, authorId: req.params.authorId }));
}));

/** Supplementary material — a synopsis, notes — which the model learns from; the book stays the evidence. */
router.post('/authors/:authorId/books/:bookId/materials', validate(SCHEMAS.addMaterial), asyncRoute(async (req, res) => {
  res.status(201).json(await addMaterial({
    bookId: req.params.bookId, authorId: req.params.authorId, kind: req.body.kind, content: req.body.content, user: req.user,
  }));
}));

/** Refit on demand. Refused as a no-op when nothing it learns from has changed. */
router.post('/authors/:authorId/books/:bookId/model/refit', asyncRoute(async (req, res) => {
  const { rows: [book] } = await query('SELECT id FROM books WHERE id = $1 AND author_id = $2', [req.params.bookId, req.params.authorId]);
  if (!book) throw Object.assign(new Error('Book not found for this author'), { status: 404 });
  const { model, refitted } = await fitBookModel({ bookId: book.id, trigger: 'manual', actor: req.user.name });
  res.json({ refitted, model: summariseModel(model) });
}));

// --- The feedback loop (STORY-048 / REQ-012) ---

/** A reviewer's rating and comment on a draft — whatever its status. */
router.post('/drafts/:id/feedback', requirePermission(PERMISSIONS.CONTENT_APPROVE), validate(SCHEMAS.feedback), asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  res.status(201).json(await recordFeedback({ draftId: Number(req.params.id), rating: req.body.rating ?? null, comment: req.body.comment ?? null, user: req.user }));
}));

router.get('/authors/:authorId/books/:bookId/feedback', asyncRoute(async (req, res) => {
  res.json(await feedbackFor({ bookId: req.params.bookId, authorId: req.params.authorId }));
}));

/** Process it now: the book's model refitted with every judgment so far. */
router.post('/authors/:authorId/books/:bookId/feedback/apply', requirePermission(PERMISSIONS.CONTENT_APPROVE), asyncRoute(async (req, res) => {
  res.json(await applyFeedback({ bookId: req.params.bookId, authorId: req.params.authorId, user: req.user }));
}));

// --- What needs attention (STORY-057 / REQ-015) ---

/** Pending approvals and recent actions, with timestamps and priority; and what waits for this person. */
router.get('/authors/:authorId/attention', requirePermission(PERMISSIONS.AUDIT_READ), asyncRoute(async (req, res) => {
  res.json(await attentionFor({ authorId: req.params.authorId, user: req.user }));
}));

/**
 * The governance score (STORY-058): a formula over what the system did, with
 * every factor's measurement and weight, capped when an invariant is broken.
 */
router.get('/authors/:authorId/governance-score', requirePermission(PERMISSIONS.AUDIT_READ), validate(SCHEMAS.governanceScore), asyncRoute(async (req, res) => {
  res.json(await governanceScore({ authorId: req.params.authorId, days: req.query.days }));
}));

// --- Anomalies, escalated to a person (STORY-059 / REQ-015, REQ-006) ---

/** A tenant's anomalies with their status; system-wide ones too for those who read every tenant. */
router.get('/authors/:authorId/anomalies', requirePermission(PERMISSIONS.AUDIT_READ), asyncRoute(async (req, res) => {
  res.json(await listAnomalies({ authorId: req.params.authorId, user: req.user }));
}));

/** Acknowledge, resolve or dismiss — the service decides who may. */
router.post('/anomalies/:id/:action(acknowledge|resolve|dismiss)', validate(SCHEMAS.anomalyAction), asyncRoute(async (req, res) => {
  res.json(await updateAnomaly({ id: req.params.id, action: req.params.action, note: req.body.note ?? '', user: req.user }));
}));

/**
 * Alertmanager's webhook (STORY-062). No session: Alertmanager sends the shared
 * ALERTMANAGER_TOKEN as a bearer token, and nothing is believed without it.
 */
router.post('/alerts/prometheus', validate(SCHEMAS.prometheusAlerts), asyncRoute(async (req, res) => {
  const given = Buffer.from(String(req.get('authorization') ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(config.alertmanagerToken);
  if (!config.alertmanagerToken || given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Alert refused: missing or wrong ALERTMANAGER_TOKEN' });
  }
  res.json(await recordPrometheusAlerts(req.body));
}));

// --- Text messages through Twilio (STORY-037 / REQ-009, REQ-013) ---

/** Every text sent for this tenant, with its attempts and outcome. Numbers are masked. */
router.get('/authors/:authorId/sms', asyncRoute(async (req, res) => {
  res.json(await smsLog(Number(req.params.authorId)));
}));

// --- Subscription payments through Stripe (STORY-036 / REQ-009, REQ-012) ---

/** An author's subscription and payments — their own, by the tenant rule. */
router.get('/authors/:authorId/billing', asyncRoute(async (req, res) => {
  res.json(await billingFor(Number(req.params.authorId)));
}));

/** Charge the subscription with a Stripe PaymentMethod. Admins only: it moves money. */
router.post('/authors/:authorId/billing/charge', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(SCHEMAS.chargeSubscription), asyncRoute(async (req, res) => {
  const result = await chargeSubscription({ authorId: Number(req.params.authorId), paymentMethod: req.body.paymentMethod, requestedBy: req.user.name });
  // A declined card is a completed request with a failed payment, not a server error.
  res.status(201).json(result);
}));

/** Failed payments no one has looked at yet (the story's escalation). */
router.get('/billing/review', requirePermission(PERMISSIONS.TENANT_MANAGE), asyncRoute(async (_req, res) => {
  res.json({ payments: await paymentsToReview() });
}));

router.post('/billing/payments/:id/review', requirePermission(PERMISSIONS.TENANT_MANAGE), asyncRoute(async (req, res) => {
  res.json(await markReviewed({ paymentId: req.params.id, reviewer: req.user.name }));
}));

/** Stripe's webhook. No session: believed only if Stripe's signature over the raw body checks out. */
router.post('/webhooks/stripe', validate(SCHEMAS.stripeWebhook), asyncRoute(async (req, res) => {
  const check = verifyStripeSignature(req.rawBody ?? '', req.get('stripe-signature'));
  if (!check.ok) return res.status(400).json({ error: `Webhook refused: ${check.reason}` });
  // Acted on as signed: the raw bytes Stripe signed, not a re-parsed copy.
  res.json(await handleStripeEvent(JSON.parse(req.rawBody)));
}));

// --- The search index (STORY-055 / REQ-015) ---

/**
 * Searches a tenant's audit and data access logs in the index, with a time
 * range. The tenant filter is added by searchTenant itself. 503 where no index
 * is set up — said, not an empty result.
 */
router.get('/authors/:authorId/search', requirePermission(PERMISSIONS.AUDIT_READ), validate(SCHEMAS.search), asyncRoute(async (req, res) => {
  const { q, source, from, to, size } = req.query;
  res.json(await searchTenant({
    authorId: req.params.authorId, q, source: source || null, size,
    from: from ? new Date(from).toISOString() : null, to: to ? new Date(to).toISOString() : null,
  }));
}));

/** How far the index has got, per source, and what the last reconciliation found. */
router.get('/authors/:authorId/search/status', requirePermission(PERMISSIONS.AUDIT_READ), asyncRoute(async (req, res) => {
  // Counts span every tenant, so only those who read across tenants see them.
  res.json(await searchStatus({ counts: holds(req.user, PERMISSIONS.TENANT_READ_ALL) }));
}));

// --- Audit log reports (STORY-028 / REQ-005) ---

/**
 * A report for a period: every action with its time and who did it, summarised,
 * with a digest and the seal status. `format=csv` downloads it. An author's
 * report is their own tenant's (the tenant rule fills authorId); across
 * tenants needs tenant.read.all.
 */
router.get('/audit-reports', requirePermission(PERMISSIONS.AUDIT_READ), validate(SCHEMAS.auditReport), asyncRoute(async (req, res) => {
  const { from, to, authorId, actor, action, format } = req.query;
  const report = await generateAuditReport({ from, to, authorId, actor, action, user: req.user });
  if (format === 'csv') {
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', `attachment; filename="audit-report-${report.period.from.slice(0, 10)}-to-${report.period.to.slice(0, 10)}.csv"`);
    return res.send(reportAsCsv(report));
  }
  return res.json(report);
}));

// --- Who may read and manage the audit logs (STORY-050 / REQ-013) ---

/**
 * The security log (STORY-051): every attempt on an audit log, with who and how
 * it ended. Reviewers only — and reading it is itself recorded there.
 */
router.get('/security/audit-access', requireAuditReviewer, validate(SCHEMAS.securityLog), asyncRoute(async (req, res) => {
  res.json(await securityLogReport({ hours: req.query.hours, outcome: req.query.outcome || null }));
}));

/** Alerts about refused attempts on the audit logs (STORY-052). For those who verify the logs. */
router.get('/security/notifications', requirePermission(PERMISSIONS.AUDIT_VERIFY), validate(SCHEMAS.notifications), asyncRoute(async (req, res) => {
  res.json(await listNotifications({ open: req.query.open === 'true' ? true : req.query.open === 'false' ? false : null }));
}));

router.post('/security/notifications/:id/acknowledge', requirePermission(PERMISSIONS.AUDIT_VERIFY), validate(SCHEMAS.acknowledge), asyncRoute(async (req, res) => {
  res.json(await acknowledge({ id: req.params.id, note: req.body.note ?? '', user: req.user }));
}));

/** The policy, derived from the live grant table: every audit route, and which roles may use it. */
router.get('/security/audit-access-policy', requireAuditReviewer, asyncRoute(async (_req, res) => {
  res.json(await auditAccessPolicy());
}));

export const TENANT_SCOPED_ROUTES = applyTenantScope(router);
