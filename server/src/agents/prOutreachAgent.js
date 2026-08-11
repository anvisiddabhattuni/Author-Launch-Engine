import { getOutreachProvider } from '../ai/index.js';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';

export const ACTOR = 'PROutreachAgent';

/** Emails run long; past this a pitch stops being read. */
export const MAX_BODY_CHARS = 1200;

const words = (text) => new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);

/**
 * Did the message actually use the opportunity's specifics, or is it a form
 * letter? Each recorded token must appear in the subject or body to count.
 */
function personalizationScore(text, tokens) {
  if (tokens.length === 0) return 0;
  const haystack = text.toLowerCase();
  const hits = tokens.filter((token) => token && haystack.includes(token.toLowerCase()));
  return hits.length / tokens.length;
}

function groundingScore(text, bookThemes) {
  if (bookThemes.length === 0) return 0.5;
  const body = words(text);
  const hits = bookThemes.filter((theme) =>
    theme
      .toLowerCase()
      .split(/\s+/)
      .some((token) => body.has(token)),
  );
  return hits.length === 0 ? 0 : Math.min(1, 0.55 + 0.45 * (hits.length / bookThemes.length));
}

function voiceScore(text, history) {
  if (history.length === 0) return 0.6;
  const corpus = words(history.map((h) => h.content).join(' '));
  const body = [...words(text)].filter((w) => w.length > 3);
  if (body.length === 0) return 0;
  const overlap = body.filter((w) => corpus.has(w)).length / body.length;
  return Math.min(1, 0.4 + overlap * 1.5);
}

function fitScore(body, maxChars = MAX_BODY_CHARS) {
  if (body.length <= maxChars) return 1;
  return Math.max(0, 1 - (body.length - maxChars) / maxChars);
}

/**
 * Scores an outreach message.
 *
 * Personalisation carries the most weight because a generic pitch is the
 * specific failure mode this story exists to avoid.
 */
export function scoreMessage({ subject, body, personalization, bookThemes, history }) {
  const full = `${subject}\n${body}`;
  const personal = personalizationScore(full, personalization);
  const grounding = groundingScore(full, bookThemes);
  const voice = voiceScore(body, history);
  const fit = fitScore(body);

  const confidence = Number(
    (personal * 0.4 + grounding * 0.3 + voice * 0.2 + fit * 0.1).toFixed(3),
  );

  return {
    confidence,
    rationale:
      `personalisation=${personal.toFixed(2)} (opportunity specifics referenced) · ` +
      `grounding=${grounding.toFixed(2)} (book themes) · ` +
      `voice=${voice.toFixed(2)} (overlap with prior posts) · ` +
      `fit=${fit.toFixed(2)} (${body.length}/${MAX_BODY_CHARS} chars)`,
  };
}

/**
 * Drafts outreach messages for identified opportunities that do not have one.
 *
 * Nothing is sent here. Messages land in `pending_approval`, or `escalated`
 * when confidence falls short, so a weak or generic pitch reaches a human
 * rather than a booker.
 */
export async function draftOutreachMessages({
  authorId,
  bookId,
  opportunityIds = null,
  providerName = config.aiProvider,
  limit = 10,
}) {
  const provider = getOutreachProvider(providerName);

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
      'SELECT content FROM social_history WHERE author_id = $1',
      [authorId],
    );

    // Only opportunities still awaiting a message, newest and most relevant
    // first, so a partial run covers the best prospects.
    const params = [authorId];
    let filter = '';
    if (opportunityIds && opportunityIds.length > 0) {
      params.push(opportunityIds);
      filter = `AND o.id = ANY($${params.length}::bigint[])`;
    }
    params.push(limit);

    const { rows: opportunities } = await client.query(
      `SELECT o.* FROM opportunities o
        WHERE o.author_id = $1
          AND o.status = 'identified'
          AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.opportunity_id = o.id)
          ${filter}
        ORDER BY o.relevance DESC, o.id
        LIMIT $${params.length}`,
      params,
    );

    const drafted = [];
    for (const opportunity of opportunities) {
      const { subject, body, personalization } = await provider.draftMessage({
        opportunity,
        book,
        author,
      });

      const { confidence, rationale } = scoreMessage({
        subject,
        body,
        personalization,
        bookThemes: book.themes,
        history,
      });

      const status =
        confidence < config.confidenceEscalationThreshold ? 'escalated' : 'pending_approval';

      const { rows } = await client.query(
        `INSERT INTO outreach_messages
           (opportunity_id, author_id, book_id, subject, body, personalization,
            confidence, rationale, status, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          opportunity.id,
          authorId,
          bookId,
          subject,
          body,
          personalization,
          confidence,
          rationale,
          status,
          provider.name,
        ],
      );
      const message = rows[0];

      await recordAction(
        {
          actor: ACTOR,
          action: status === 'escalated' ? 'outreach.escalated' : 'outreach.drafted',
          entityType: 'outreach_message',
          entityId: message.id,
          authorId,
          after: message,
          metadata: {
            provider: provider.name,
            confidence,
            threshold: config.confidenceEscalationThreshold,
            opportunity: opportunity.name,
            opportunityType: opportunity.type,
          },
        },
        client,
      );

      drafted.push({ ...message, opportunity });
    }

    return drafted;
  });
}
