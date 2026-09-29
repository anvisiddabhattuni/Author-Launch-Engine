import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { fitBookModel, summarise } from './bookModel.js';

/**
 * The feedback loop (STORY-048 / REQ-012) — Trust and Monitoring Agent.
 *
 * Reviewers rate a draft and say why; their decisions count too (see
 * `loadFeedback` in bookModel.js). Processing refits the book's model with the
 * feedback, so the next drafts quote less of what reviewers kept turning down
 * and write more about what they liked. Every rating, and every adjustment it
 * caused, is on the audit log.
 */
export const ACTOR = 'TrustMonitoringAgent';

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function recordFeedback({ draftId, rating = null, comment = null, user }) {
  const { rows: [draft] } = await pool.query('SELECT id, author_id, book_id, status FROM drafts WHERE id = $1', [draftId]);
  if (!draft) throw fail(404, 'No such draft');
  const text = comment?.trim() || null;
  if (rating == null && !text) throw fail(400, 'Give a rating, a comment, or both');
  const { rows: [row] } = await pool.query(
    `INSERT INTO content_feedback (draft_id, author_id, book_id, rating, comment, given_by, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [draftId, draft.author_id, draft.book_id, rating, text, user.name, user.id ?? null],
  );
  await recordAction({
    actor: user.name,
    action: 'feedback.recorded',
    entityType: 'draft',
    entityId: draftId,
    authorId: Number(draft.author_id),
    metadata: { rating, comment: text, draftStatus: draft.status, bookId: Number(draft.book_id) },
  });
  return row;
}

/** Processes the feedback now, rather than before the next draft. */
export async function applyFeedback({ bookId, authorId, user }) {
  const { rows: [book] } = await pool.query('SELECT id FROM books WHERE id = $1 AND author_id = $2', [bookId, authorId]);
  if (!book) throw fail(404, 'Book not found for this author');
  const { model, refitted } = await fitBookModel({ bookId, trigger: 'manual', actor: user?.name ?? ACTOR });
  return { refitted, model: summarise(model) };
}

/** What reviewers have said about this book's drafts, newest first. */
export async function feedbackFor({ bookId, authorId }) {
  const { rows } = await pool.query(
    `SELECT f.id, f.draft_id, f.rating, f.comment, f.given_by, f.created_at, left(d.content, 120) AS draft_preview, d.status
       FROM content_feedback f JOIN drafts d ON d.id = f.draft_id
      WHERE f.book_id = $1 AND f.author_id = $2 ORDER BY f.id DESC LIMIT 50`,
    [bookId, authorId],
  );
  return rows;
}
