import { config, PLATFORMS } from '../config.js';
import { getProvider } from '../ai/index.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';

export const ACTOR = 'ContentDraftingAgent';

/** Monday of the ISO week containing `date`, as a YYYY-MM-DD string. */
export function weekStart(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d.toISOString().slice(0, 10);
}

const words = (text) => new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);

/**
 * How well the draft is anchored in the book's actual themes.
 * Scores the theme tokens the draft reuses, not just an exact label match.
 */
function groundingScore(content, bookThemes) {
  if (bookThemes.length === 0) return 0.5;
  const body = words(content);
  const hits = bookThemes.filter((theme) =>
    theme
      .toLowerCase()
      .split(/\s+/)
      .some((token) => body.has(token)),
  );
  return hits.length === 0 ? 0 : Math.min(1, 0.55 + 0.45 * (hits.length / bookThemes.length));
}

/**
 * Vocabulary overlap between the draft and the author's previous posts, used
 * as a proxy for "sounds like the author".
 */
function voiceScore(content, history) {
  if (history.length === 0) return 0.6;
  const corpus = words(history.map((h) => h.content).join(' '));
  const body = [...words(content)].filter((w) => w.length > 3);
  if (body.length === 0) return 0;
  const overlap = body.filter((w) => corpus.has(w)).length / body.length;
  return Math.min(1, 0.4 + overlap * 1.5);
}

/** Penalises drafts that overflow the platform's hard character limit. */
function fitScore(content, maxChars) {
  if (content.length <= maxChars) return 1;
  return Math.max(0, 1 - (content.length - maxChars) / maxChars);
}

export function scoreDraft({ content, themesUsed, bookThemes, history, maxChars }) {
  const grounding = groundingScore(`${content} ${themesUsed.join(' ')}`, bookThemes);
  const voice = voiceScore(content, history);
  const fit = fitScore(content, maxChars);
  const confidence = Number((grounding * 0.45 + voice * 0.35 + fit * 0.2).toFixed(3));

  return {
    confidence,
    rationale:
      `grounding=${grounding.toFixed(2)} (themes reused) · ` +
      `voice=${voice.toFixed(2)} (vocabulary overlap with prior posts) · ` +
      `fit=${fit.toFixed(2)} (${content.length}/${maxChars} chars)`,
  };
}

/**
 * Drafts a week of social posts for one book.
 *
 * Nothing here publishes: every draft lands in `pending_approval`, or in
 * `escalated` when confidence falls below the threshold so a human is pulled
 * in rather than the agent proceeding on a weak draft (TBI: escalation).
 */
export async function draftWeeklyPosts({
  authorId,
  bookId,
  count = config.minPostsPerWeek,
  platforms = PLATFORMS,
  providerName = config.aiProvider,
  weekOf = weekStart(),
}) {
  const provider = getProvider(providerName);

  return withTransaction(async (client) => {
    const { rows: bookRows } = await client.query(
      'SELECT * FROM books WHERE id = $1 AND author_id = $2',
      [bookId, authorId],
    );
    const book = bookRows[0];
    if (!book) throw Object.assign(new Error('Book not found for this author'), { status: 404 });

    const { rows: authorRows } = await client.query('SELECT * FROM authors WHERE id = $1', [authorId]);
    const author = authorRows[0];

    const { rows: history } = await client.query(
      'SELECT platform, content FROM social_history WHERE author_id = $1 ORDER BY posted_at DESC NULLS LAST',
      [authorId],
    );

    const { rows: windows } = await client.query('SELECT * FROM platform_windows');
    const maxCharsFor = new Map(windows.map((w) => [w.platform, w.max_chars]));

    const candidates = await provider.generateCandidates({
      book,
      voiceProfile: author.voice_profile,
      history,
      platforms,
      count,
      weekOf,
    });

    const saved = [];
    for (const candidate of candidates) {
      const maxChars = maxCharsFor.get(candidate.platform) ?? 2000;
      const { confidence, rationale } = scoreDraft({
        content: candidate.content,
        themesUsed: candidate.themesUsed,
        bookThemes: book.themes,
        history,
        maxChars,
      });

      const status = confidence < config.confidenceEscalationThreshold ? 'escalated' : 'pending_approval';

      const { rows } = await client.query(
        `INSERT INTO drafts
           (author_id, book_id, platform, content, themes_used, confidence, rationale, status, week_of, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          authorId,
          bookId,
          candidate.platform,
          candidate.content,
          candidate.themesUsed,
          confidence,
          rationale,
          status,
          weekOf,
          provider.name,
        ],
      );
      const draft = rows[0];

      await recordAction(
        {
          actor: ACTOR,
          action: status === 'escalated' ? 'draft.escalated' : 'draft.created',
          entityType: 'draft',
          entityId: draft.id,
          authorId,
          after: draft,
          metadata: {
            provider: provider.name,
            confidence,
            threshold: config.confidenceEscalationThreshold,
            reason: status === 'escalated' ? 'confidence below threshold' : 'awaiting human approval',
          },
        },
        client,
      );

      saved.push(draft);
    }

    return saved;
  });
}
