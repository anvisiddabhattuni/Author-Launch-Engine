import { Router } from 'express';

import { draftWeeklyPosts, weekStart } from '../agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from '../agents/opportunityScoutingAgent.js';
import { draftOutreachMessages } from '../agents/prOutreachAgent.js';
import { config, PLATFORMS } from '../config.js';
import { query } from '../db/pool.js';
import {
  approveDraft,
  approveOutreach,
  rejectDraft,
  rejectOutreach,
} from '../services/approvals.js';
import { listAuditLog, recordAction } from '../services/auditLog.js';
import { sendOutreachMessage } from '../services/outreachSender.js';
import { publishDue, scheduleDraft } from '../services/scheduler.js';

export const router = Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, provider: config.aiProvider });
}));

// --- Authors, book content and social history (build step 1's backend) ---

router.get('/authors', asyncRoute(async (_req, res) => {
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
    actor: req.body.actor ?? 'author',
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
    actor: req.body.actor ?? 'author',
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
    actor: req.body.actor ?? 'author',
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
  res.json(rows);
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
  const draft = await approveDraft({
    draftId: Number(req.params.id),
    reviewer: req.body?.reviewer,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

router.post('/drafts/:id/reject', asyncRoute(async (req, res) => {
  const draft = await rejectDraft({
    draftId: Number(req.params.id),
    reviewer: req.body?.reviewer,
    notes: req.body?.notes ?? '',
  });
  res.json(draft);
}));

// --- Scheduling and mocked publishing (build steps 4 and 5) ---

router.post('/drafts/:id/schedule', asyncRoute(async (req, res) => {
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
  const result = await scoutOpportunities({
    authorId: Number(req.params.authorId),
    bookId: Number(req.params.bookId),
  });
  res.status(201).json(result);
}));

router.get('/opportunities', asyncRoute(async (req, res) => {
  const conditions = [];
  const params = [];
  for (const [column, value] of [
    ['author_id', req.query.authorId],
    ['type', req.query.type],
    ['status', req.query.status],
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
      ORDER BY o.relevance DESC, o.id`,
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
  const message = await approveOutreach({
    messageId: Number(req.params.id),
    reviewer: req.body?.reviewer,
    notes: req.body?.notes ?? '',
  });
  res.json(message);
}));

router.post('/outreach-messages/:id/reject', asyncRoute(async (req, res) => {
  const message = await rejectOutreach({
    messageId: Number(req.params.id),
    reviewer: req.body?.reviewer,
    notes: req.body?.notes ?? '',
  });
  res.json(message);
}));

router.post('/outreach-messages/:id/send', asyncRoute(async (req, res) => {
  const send = await sendOutreachMessage({ messageId: Number(req.params.id) });
  res.status(201).json(send);
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
