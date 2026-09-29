import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { measure } from './voiceProfile.js';

/**
 * Reviewing drafts against the book (STORY-047 / REQ-012) — Approval and
 * Notification Agent.
 *
 * When a draft is ready for review it is compared with the book: each theme it
 * claims, in the book's own words for that theme (STORY-046's model), and its
 * style against the book's — measured by the same `measure()` that reads the
 * author's posts (STORY-007), so the two sides are counted the same way. The
 * comparison is kept with the draft and shown to the reviewer beside the
 * approve button. It informs the human decision; it never makes it.
 *
 * And a reviewer can ask for changes: the draft is set aside with their note,
 * and a revision linked to it comes back through the same comparison and the
 * same approval gate.
 */
export const ACTOR = 'ApprovalNotificationAgent';

/** A draft may run this much over the book on a register the book barely uses. */
const REGISTER_ALLOWANCE = 0.5;
/** Posts are expected to be shorter than a book's sentences; much longer is not the book's style. */
const SENTENCE_STRETCH = 1.6;

const round = (n, d = 2) => Number(Number(n).toFixed(d));

/** The style elements taken from the book, measured once per comparison. */
export function bookStyle(book) {
  const m = measure(book.content);
  return {
    meanSentenceWords: round(m.meanSentenceWords, 1),
    exclamationsPer100: round(m.exclamationsPer100),
    hypePer100: round(m.hypePer100),
    shoutedPer100: round(m.shoutedPer100),
    firstPersonPer100: round(m.firstPersonPer100),
  };
}

/** Draft style against book style, element by element — each with what it found and whether it fits. */
export function compareStyle(text, style) {
  const d = measure(text);
  const register = (name, label, draft, book) => ({
    element: name,
    label,
    book,
    draft: round(draft),
    fits: draft <= book + REGISTER_ALLOWANCE,
    note: draft <= book + REGISTER_ALLOWANCE ? null : `${round(draft)} per 100 words; the book uses ${book}`,
  });
  return [
    register('exclamations', 'Exclamation marks', d.exclamationsPer100, style.exclamationsPer100),
    register('hype', 'Marketing words', d.hypePer100, style.hypePer100),
    register('shouting', 'Words in capitals', d.shoutedPer100, style.shoutedPer100),
    {
      element: 'sentence_length',
      label: 'Sentence length',
      book: style.meanSentenceWords,
      draft: round(d.meanSentenceWords, 1),
      fits: d.meanSentenceWords <= style.meanSentenceWords * SENTENCE_STRETCH,
      note: d.meanSentenceWords <= style.meanSentenceWords * SENTENCE_STRETCH
        ? null
        : `sentences average ${round(d.meanSentenceWords, 1)} words; the book's ${style.meanSentenceWords}`,
    },
  ];
}

/**
 * Compares one draft with its book and keeps the result. Idempotent: a draft's
 * text never changes, so a second call returns the first comparison.
 */
export async function reviewDraft(draftId, client = pool) {
  const { rows: [existing] } = await client.query('SELECT * FROM content_reviews WHERE draft_id = $1', [draftId]);
  if (existing) return existing;

  const { rows: [draft] } = await client.query('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft) return null;
  const { rows: [book] } = await client.query(
    "SELECT id, content, array_to_json(tsvector_to_array(to_tsvector('english', title))) AS title_lexemes FROM books WHERE id = $1",
    [draft.book_id],
  );
  const { rows: [model] } = await client.query(
    "SELECT version, parameters FROM book_models WHERE book_id = $1 AND status = 'current'", [draft.book_id],
  );
  const { rows: themeRows } = await client.query('SELECT * FROM draft_themes WHERE draft_id = $1 ORDER BY id', [draftId]);
  const readerText = draft.format === 'meme' ? [draft.content, ...(draft.media?.panels ?? [])].join(' ') : draft.content;
  const { rows: [{ lexemes }] } = await client.query(
    "SELECT array_to_json(tsvector_to_array(to_tsvector('english', $1))) AS lexemes", [readerText],
  );
  // The title's words don't count: every post names the book, so "field" in
  // "The Long Field" would credit any draft with the book's language.
  const title = new Set(book.title_lexemes);
  const inDraft = new Set(lexemes.filter((l) => !title.has(l)));

  const claimed = draft.themes_used ?? [];
  const themes = claimed.map((theme) => {
    const scored = themeRows.find((t) => t.theme === theme);
    const fitted = model?.parameters.themes.find((t) => t.theme === theme);
    const bookWords = (fitted?.lexicon ?? []).filter((l) => inDraft.has(l.term)).map((l) => l.word ?? l.term);
    const alignment = scored ? Number(scored.score) : 0;
    const learned = Boolean(fitted?.lexicon.length);
    return {
      theme,
      alignment: round(alignment),
      aligned: alignment >= config.minThemeAlignment,
      named: Boolean(scored?.named),
      bookWords,
      learned,
      // Uses the book's own language for this theme — or the model had none to check against.
      inBookLanguage: !learned || bookWords.length > 0 || Boolean(scored?.named),
      keyMessage: scored?.key_message ?? '',
      evidence: scored?.passage_ids ?? [],
    };
  });

  const style = compareStyle(readerText, bookStyle(book));
  const styleMisses = style.filter((s) => !s.fits);
  const themeMisses = themes.filter((t) => !t.aligned);
  const languageMisses = themes.filter((t) => t.aligned && !t.inBookLanguage);
  const verdict = themeMisses.length > 0 || themes.length === 0 || styleMisses.length >= 2 ? 'misaligned'
    : styleMisses.length === 1 || languageMisses.length > 0 ? 'check'
      : 'aligned';

  const notes = [
    ...(themes.length === 0 ? ['claims none of the book\'s themes'] : []),
    ...themeMisses.map((t) => `"${t.theme}" is claimed but not argued (alignment ${t.alignment})`),
    ...languageMisses.map((t) => `"${t.theme}" is argued without the book's own words for it`),
    ...styleMisses.map((s) => `${s.label}: ${s.note}`),
  ];
  const comparison = { themes, style, notes, floors: { themeAlignment: config.minThemeAlignment } };

  const { rows: [saved] } = await client.query(
    `INSERT INTO content_reviews (draft_id, author_id, book_id, model_version, verdict, comparison)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (draft_id) DO UPDATE SET draft_id = EXCLUDED.draft_id
     RETURNING *`,
    [draftId, draft.author_id, draft.book_id, model?.version ?? null, verdict, JSON.stringify(comparison)],
  );
  await recordAction(
    {
      actor: ACTOR,
      action: 'draft.compared_with_book',
      entityType: 'draft',
      entityId: draftId,
      authorId: Number(draft.author_id),
      metadata: { verdict, modelVersion: model?.version ?? null, notes },
    },
    client,
  );
  return saved;
}

/** The comparisons for a set of drafts, computing any that are missing (drafts made before this story). */
export async function reviewsFor(draftIds) {
  const ids = draftIds.map(Number);
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query('SELECT * FROM content_reviews WHERE draft_id = ANY($1::bigint[])', [ids]);
  const byDraft = new Map(rows.map((r) => [Number(r.draft_id), r]));
  return byDraft;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Sets a draft aside with the reviewer's note, and asks for a revision.
 * The revision is a new draft, linked to this one, and goes through the same
 * comparison and the same approval gate as any other.
 */
export async function requestChanges({ draftId, note, reviewer, user, reviseWith }) {
  if (!note || note.trim().length < 10) throw fail(400, 'Say what should change, in at least ten characters');
  const draft = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [draftId]);
    if (!row) throw fail(404, 'No such draft');
    if (!['pending_approval', 'escalated'].includes(row.status)) {
      throw fail(409, `A draft that is ${row.status.replace('_', ' ')} is not waiting for a decision`);
    }
    const { rows: [updated] } = await client.query(
      `UPDATE drafts SET status = 'changes_requested', change_request = $2, changes_requested_by = $3, changes_requested_at = now()
        WHERE id = $1 RETURNING *`,
      [draftId, note.trim(), reviewer],
    );
    await recordAction(
      {
        actor: user?.name ?? reviewer,
        action: 'draft.changes_requested',
        entityType: 'draft',
        entityId: draftId,
        authorId: Number(row.author_id),
        before: { status: row.status },
        after: { status: 'changes_requested' },
        metadata: { reviewer, note: note.trim(), userId: user?.id ?? null },
      },
      client,
    );
    return updated;
  });

  // The revision after the request is committed: a failed revision leaves the
  // request standing — and says so — rather than undoing the reviewer's decision.
  let revision = null;
  let revisionError = null;
  try {
    [revision] = await reviseWith(draft);
  } catch (error) {
    revisionError = error.message;
    await recordAction({
      actor: ACTOR,
      action: 'draft.revision_failed',
      entityType: 'draft',
      entityId: draftId,
      authorId: Number(draft.author_id),
      metadata: { error: error.message },
    });
  }
  return { draft, revision: revision ?? null, revisionError };
}
