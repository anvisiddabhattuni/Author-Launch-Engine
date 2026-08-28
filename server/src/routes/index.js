import { Router } from 'express';

import { assertOwns, authenticate, enforceTenant, requireRole, tenantParam } from '../middleware/auth.js';

import { draftWeeklyPosts, weekStart } from '../agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from '../agents/opportunityScoutingAgent.js';
import { OPPORTUNITY_TYPES } from '../services/directories.js';
import { draftPressKit } from '../agents/prMaterialsAgent.js';
import { listEscalations, monitorPressMaterials } from '../agents/trustMonitoringAgent.js';
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
} from '../services/approvals.js';
import { listAuditLog, recordAction } from '../services/auditLog.js';
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
import { publishDue, scheduleDraft } from '../services/scheduler.js';
import {
  addTemplate,
  assessTemplate,
  listTemplates,
  retireTemplate,
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

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Order matters and is the whole point: authenticate answers "is a real person
// behind this", enforceTenant answers "may they touch this data". Mounted here
// rather than per-route so a route added later is protected by default —
// forgetting to opt in is the failure mode this ordering removes (STORY-064).
router.use(authenticate);
router.use(enforceTenant);
// Path tenants are checked here rather than in enforceTenant: router-level
// middleware runs before Express populates req.params, so the check has to hang
// off the parameter itself to see a value at all.
router.param('authorId', tenantParam);

// --- Session (STORY-064 / REQ-005) ---

router.post('/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body ?? {};
  res.json(await login({ email, password }));
}));

/** Who the current token says you are. The client uses it to restore a session. */
router.get('/auth/me', asyncRoute(async (req, res) => {
  res.json({ user: req.user });
}));

router.get('/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, provider: config.aiProvider });
}));

// --- Authors, book content and social history (build step 1's backend) ---

router.get('/authors', asyncRoute(async (req, res) => {
  // The client bootstraps from this list. Before STORY-064 it returned every
  // author in the database and the UI simply took the first one, which is how
  // the masthead came to say "Signed in as" about somebody nobody had signed in
  // as. An author now sees exactly one row: their own.
  if (req.user.role !== 'admin') {
    const { rows } = await query('SELECT * FROM authors WHERE id = $1', [req.user.authorId]);
    return res.json(rows);
  }
  const { rows } = await query('SELECT * FROM authors ORDER BY id');
  res.json(rows);
}));

router.post('/authors', asyncRoute(async (req, res) => {
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

router.post('/authors/:authorId/books', asyncRoute(async (req, res) => {
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
  res.status(201).json(rows[0]);
}));

router.post('/authors/:authorId/social-history', asyncRoute(async (req, res) => {
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

router.post('/authors/:authorId/books/:bookId/drafts', asyncRoute(async (req, res) => {
  const drafts = await draftWeeklyPosts({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    count: req.body?.count ?? config.minPostsPerWeek,
    platforms: req.body?.platforms ?? PLATFORMS,
    weekOf: req.body?.weekOf ?? weekStart(),
  });
  res.status(201).json(drafts);
}));

router.get('/drafts', asyncRoute(async (req, res) => {
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

  res.json(
    rows.map((draft) => ({
      ...draft,
      themes: draftThemes.filter((t) => String(t.draft_id) === String(draft.id)),
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

router.post('/drafts/:id/approve', asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const draft = await approveDraft({
    draftId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

router.post('/drafts/:id/reject', asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const draft = await rejectDraft({
    draftId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

// --- Scheduling and mocked publishing (build steps 4 and 5) ---

router.post('/drafts/:id/schedule', asyncRoute(async (req, res) => {
  await assertOwns(req, 'drafts', Number(req.params.id));
  const scheduled = await scheduleDraft({ draftId: Number(req.params.id) });
  res.status(201).json(scheduled);
}));

router.get('/scheduled-posts', asyncRoute(async (req, res) => {
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

router.post('/scheduled-posts/publish-due', asyncRoute(async (req, res) => {
  const published = await publishDue({ now: req.body?.now ? new Date(req.body.now) : new Date() });
  res.json(published);
}));

// --- Opportunities (STORY-002 build steps 1 and 2) ---

router.post('/authors/:authorId/books/:bookId/opportunities/scout', asyncRoute(async (req, res) => {
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

router.get('/opportunities', asyncRoute(async (req, res) => {
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

router.post('/authors/:authorId/books/:bookId/outreach/draft', asyncRoute(async (req, res) => {
  const messages = await draftOutreachMessages({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
    opportunityIds: req.body?.opportunityIds ?? null,
    limit: req.body?.limit ?? 10,
  });
  res.status(201).json(messages);
}));

router.get('/outreach-messages', asyncRoute(async (req, res) => {
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

router.post('/outreach-messages/:id/approve', asyncRoute(async (req, res) => {
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

router.post('/outreach-messages/:id/reject', asyncRoute(async (req, res) => {
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
router.post('/milestones/:id/award-outcome', asyncRoute(async (req, res) => {
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
router.get('/authors/:authorId/milestones/approaching', asyncRoute(async (req, res) => {
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
router.post('/authors/:authorId/milestones/draft-approaching', asyncRoute(async (req, res) => {
  const result = await draftApproachingKits({
    authorId: Number(req.params.authorId),
    leadTimeDays: req.body?.leadTimeDays ?? config.milestoneLeadTimeDays,
    ...(req.body?.now ? { now: new Date(req.body.now) } : {}),
  });
  res.status(201).json(result);
}));

router.post('/authors/:authorId/books/:bookId/milestones', asyncRoute(async (req, res) => {
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

router.get('/press-kits', asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.authorId) {
    params.push(req.query.authorId);
    where = 'WHERE k.author_id = $1';
  }

  const { rows: kits } = await query(
    `SELECT k.*,
            m.title AS milestone_title, m.type AS milestone_type,
            m.event_date, m.location, m.details, m.award_name, m.outcome,
            COUNT(p.id)::int                                        AS material_count,
            COUNT(*) FILTER (WHERE p.status = 'approved')::int      AS approved_count,
            COUNT(*) FILTER (WHERE p.status = 'distributed')::int   AS distributed_count,
            COALESCE(MIN(p.theme_alignment), 0)                     AS min_theme_alignment
       FROM pr_kits k
       JOIN milestones m ON m.id = k.milestone_id
       LEFT JOIN pr_materials p ON p.kit_id = k.id
       ${where}
      GROUP BY k.id, m.title, m.type, m.event_date, m.location, m.details, m.award_name, m.outcome
      ORDER BY m.event_date, k.id`,
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

router.post('/pr-materials/:id/approve', asyncRoute(async (req, res) => {
  await assertOwns(req, 'pr_materials', Number(req.params.id));
  const material = await approvePrMaterial({
    materialId: Number(req.params.id),
    user: req.user,
    notes: req.body?.notes ?? '',
  });
  res.json(material);
}));

router.post('/pr-materials/:id/reject', asyncRoute(async (req, res) => {
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

router.post('/authors/:authorId/reviewers', asyncRoute(async (req, res) => {
  const { name, email, role = 'reviewer' } = req.body ?? {};
  if (!name?.trim() || !email?.trim()) {
    throw Object.assign(new Error('name and email are required'), { status: 400 });
  }

  const { rows } = await query(
    `INSERT INTO reviewers (author_id, name, email, role)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (author_id, email) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, active = TRUE
     RETURNING *`,
    [Number(req.params.authorId), name.trim(), email.trim(), role],
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
router.post('/reviewers/:id/active', asyncRoute(async (req, res) => {
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

router.get('/notifications', asyncRoute(async (req, res) => {
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

/** Run health. What ran, what is waiting, and what has stopped waiting for a robot. */
router.get('/jobs', asyncRoute(async (req, res) => {
  const params = [];
  let where = '';
  // Global sweeps have no author. An author sees their own work and the global
  // runs that act on it; an admin sees everything.
  if (req.user.role !== 'admin') {
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
router.post('/authors/:authorId/books/:bookId/visual-identity', asyncRoute(async (req, res) => {
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
router.get('/meme-templates', asyncRoute(async (req, res) => {
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
      const fit = identity
        ? scoreIdentity({ imageRef: template.imageRef, identity })
        : null;
      return {
        ...template,
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
router.post('/meme-templates', requireRole('admin'), asyncRoute(async (req, res) => {
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

router.post('/meme-templates/:key/retire', requireRole('admin'), asyncRoute(async (req, res) => {
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

router.get('/audit-log', asyncRoute(async (req, res) => {
  const rows = await listAuditLog({
    authorId: req.query.authorId,
    entityType: req.query.entityType,
    limit: Number(req.query.limit ?? 100),
  });
  res.json(rows);
}));
