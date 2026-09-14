import { getOutreachProvider } from '../ai/index.js';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { assess } from '../services/escalationPolicy.js';
import { checkVoice, deriveVoice } from '../services/voiceProfile.js';
import {
  ACTOR as CONTENT_AGENT,
  alignToThemes,
  groundInBookThemes,
} from './contentAlignmentAgent.js';

export const ACTOR = 'PROutreachAgent';

/** Emails run long; past this a pitch stops being read. */
export /**
 * The book's grounding, narrowed to the themes an opportunity is about.
 *
 * Falls back to everything when the scout matched no themes — a pitch with no
 * thematic connection should be scored against the whole book and fail, rather
 * than being scored against nothing and passing vacuously.
 */
function relevantGrounding(grounding, opportunity) {
  if (!grounding) return null;
  const wanted = opportunity.matched_themes ?? [];
  if (wanted.length === 0) return grounding;
  const themes = grounding.themes.filter((t) => wanted.includes(t.theme));
  return themes.length > 0 ? { ...grounding, themes } : grounding;
}

const MAX_BODY_CHARS = 1200;

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

// `voiceScore` was here — vocabulary overlap with prior posts, 0.4 + overlap *
// 1.5. Deleted rather than deprecated: it is the measure 011_social_grounding
// records as scoring 0.994 on copy breaking every rule the author's voice
// profile states, and leaving it exported leaves the easy wrong answer beside
// `checkVoice` (STORY-023).

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
export function scoreMessage({
  subject, body, personalization, bookThemes, history, grounding = null, voice = null,
}) {
  const full = `${subject}\n${body}`;
  const personal = personalizationScore(full, personalization);

  // Retrieved evidence when the caller has it, the STORY-002 word-match when it
  // does not. Degrading to the weaker measure is the right failure for a book
  // whose themes were never indexed; scoring it zero would block a draft that
  // has not earned it. Same fallback shape `scoreMaterial` uses (STORY-023).
  const alignment = grounding
    ? alignToThemes({
        text: full,
        grounding,
        // The full theme list, even when `grounding` is narrowed to the themes
        // this opportunity is about. Without it, naming an unscored theme earns
        // credit sideways on the ones being scored.
        themeVocabulary: bookThemes,
      })
    : { score: groundingScore(full, bookThemes), matched: [], argued: [], perTheme: [],
        summary: 'no retrieval; matched theme words only' };

  // The counted voice, not vocabulary overlap. The old measure scored 0.46 on a
  // pitch the real check scores 0.16 with four violations — which is the whole
  // reason this story exists.
  const profile = voice ?? deriveVoice(history ?? [], {});
  const voiceCheck = checkVoice({ text: body, voice: profile });

  const fit = fitScore(body);

  const confidence = Number(
    (personal * 0.4 + alignment.score * 0.3 + voiceCheck.score * 0.2 + fit * 0.1).toFixed(3),
  );

  return {
    confidence,
    themeAlignment: Number(alignment.score.toFixed(3)),
    matchedThemes: alignment.matched,
    arguedThemes: alignment.argued,
    perTheme: alignment.perTheme,
    voiceScore: Number(voiceCheck.score.toFixed(3)),
    voiceViolations: voiceCheck.violations,
    rationale:
      `personalisation=${personal.toFixed(2)} (opportunity specifics referenced) · ` +
      `grounding=${alignment.score.toFixed(2)} (${alignment.summary}) · ` +
      `voice=${voiceCheck.score.toFixed(2)} (${voiceCheck.summary}) · ` +
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

    // Retrieval before generation, and the voice before that — the order
    // STORY-006 and STORY-009 established for the other two content types.
    // Done once per run rather than per message: the book's themes and the
    // author's voice do not change between two pitches in the same sweep.
    const grounding = await groundInBookThemes(
      {
        bookId,
        authorId,
        entityType: 'book',
        entityId: bookId,
        action: 'outreach.themes_retrieved',
      },
      client,
    );
    const voice = deriveVoice(history, author.voice_profile);
    await recordAction(
      {
        actor: CONTENT_AGENT,
        action: 'outreach.voice_derived',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          priorPosts: voice.posts,
          enforceable: voice.enforceable,
          meanSentenceWords: Number(voice.meanSentenceWords.toFixed(2)),
          exclamationsPer100: Number(voice.exclamationsPer100.toFixed(2)),
          hypePer100: Number(voice.hypePer100.toFixed(2)),
          // A Set, so the size — the object is not serialisable.
          vocabulary: voice.vocabulary.size,
        },
      },
      client,
    );

    const drafted = [];
    for (const opportunity of opportunities) {
      const { subject, body, personalization } = await provider.draftMessage({
        opportunity,
        book,
        author,
        grounding,
        voice,
      });

      const {
        confidence,
        themeAlignment,
        matchedThemes,
        arguedThemes,
        perTheme,
        voiceScore,
        voiceViolations,
        rationale,
      } = scoreMessage({
        subject,
        body,
        personalization,
        bookThemes: book.themes,
        history,
        // Scored against the themes this opportunity is actually about, not all
        // of them. A pitch is 1,200 characters; a press release can argue four
        // themes and a booking request cannot, and averaging across themes the
        // pitch had no business raising would cap every message at the floor.
        // `themeVocabulary` above keeps the narrowing from granting credit
        // sideways.
        grounding: relevantGrounding(grounding, opportunity),
        voice,
      });

      // Three floors, not one. Before this the alignment and voice numbers were
      // computed, blended into confidence, and outvoted by personalisation —
      // so a hype-filled pitch that merely named the venue passed at 0.79.
      const { status, reasons } = assess({ confidence, themeAlignment, voice: voiceScore });

      const { rows } = await client.query(
        `INSERT INTO outreach_messages
           (opportunity_id, author_id, book_id, subject, body, personalization,
            confidence, rationale, status, provider,
            theme_alignment, voice_score, voice_violations, themes_used, grounded_passages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
          themeAlignment,
          voiceScore,
          voiceViolations,
          // The verified matches, not the provider's claim about which themes
          // it used — the same reason scoring is not left to the model.
          matchedThemes,
          grounding.passageCount,
        ],
      );
      const message = rows[0];

      // Per-theme verdicts, the third mirror of draft_themes and
      // pr_material_themes.
      for (const theme of perTheme) {
        await client.query(
          `INSERT INTO outreach_message_themes
             (message_id, theme, key_message, named, message_score, score,
              passage_ids, carried_terms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (message_id, theme) DO NOTHING`,
          [
            message.id,
            theme.theme,
            theme.keyMessage,
            theme.named,
            theme.messageScore,
            theme.score,
            theme.passageIds,
            theme.carriedTerms,
          ],
        );
      }

      // The alignment act, logged by the agent that performed it — the same
      // split the press path uses: this records what the draft was checked
      // against, the entry below records what was produced (STORY-023).
      await recordAction(
        {
          actor: CONTENT_AGENT,
          action: 'outreach.aligned',
          entityType: 'outreach_message',
          entityId: message.id,
          authorId,
          metadata: {
            themeAlignment,
            namedThemes: matchedThemes,
            arguedThemes,
            namedOnly: matchedThemes.filter((t) => !arguedThemes.includes(t)),
            voiceScore,
            voiceViolations,
            voiceEnforceable: voice.enforceable,
            priorPosts: voice.posts,
          },
        },
        client,
      );

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
            themeAlignment,
            voiceScore,
            voiceViolations,
            escalatedFor: reasons,
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
