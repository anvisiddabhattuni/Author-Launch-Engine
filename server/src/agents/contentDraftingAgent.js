import { config, PLATFORMS } from '../config.js';
import { getProvider } from '../ai/index.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { assess } from '../services/escalationPolicy.js';
import { checkVoice, deriveVoice } from '../services/voiceProfile.js';
import { RIGHTS, reviewMemeCandidate } from '../services/brandSafety.js';
import { provenanceFor, renderMeme, usableTemplates } from '../services/memeTemplates.js';
import {
  ACTOR as CONTENT_AGENT,
  alignToThemes,
  groundInBookThemes,
} from './contentAlignmentAgent.js';

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
 * The pre-STORY-009 grounding measure, kept for the ungrounded path only.
 *
 * It asks whether a theme *label* was reused, which is the same thing
 * STORY-003 asked of press materials and the same reason it could not fail:
 * repeating "craft" four times scored full marks. Retained because a book with
 * no retrievable passages still has to be scored somehow, and a book that
 * predates the theme index should degrade rather than escalate wholesale.
 */
function labelReuseScore(content, bookThemes) {
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
 * The pre-STORY-009 voice measure, kept for the same reason and with the same
 * caveat: vocabulary overlap with the author's prior posts is satisfied by any
 * text about the same book. Hype copy breaking every stated rule scored 0.98 on
 * it. `checkVoice` replaces it wherever there is enough history to derive a
 * baseline from.
 */
function vocabularyOverlapScore(content, history) {
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

/**
 * The post with the book's title removed, for the purpose of deciding which
 * themes it names.
 *
 * "The Quiet Craft" contains one of its own themes, so every post that cited
 * the title was credited with naming `craft` and then scored on how well it
 * argued a theme it had never raised. Only exact occurrences of the title go —
 * a post that says "craft" anywhere else still counts, which is the difference
 * between mentioning the book and making its argument.
 */
export function withoutTitle(content, title) {
  if (!title) return content;
  return content.replaceAll(title, ' ');
}

/**
 * Which themes this post is to be judged on (STORY-009).
 *
 * Not "all the book's themes" — a press release announces the whole book, a
 * tweet makes one point, and holding a tweet to four themes would fail every
 * good post. So a post is judged on the themes it actually engages: the ones it
 * names, plus any the provider *claimed* and did not name.
 *
 * Keeping the overclaimed ones is the point. Dropping them would let a provider
 * assert a theme it never wrote about and lose nothing; carrying them in as
 * unnamed entries scores them zero and pulls the average down, which is what
 * makes `themes_used` a claim the system checks rather than a label it repeats.
 */
export function themesInPlay({ content, claimed = [], grounding, bookTitle = '' }) {
  const haystack = withoutTitle(content, bookTitle).toLowerCase();
  const known = new Map((grounding?.themes ?? []).map((t) => [t.theme.toLowerCase(), t]));
  const entries = new Map();

  for (const entry of grounding?.themes ?? []) {
    if (haystack.includes(entry.theme.toLowerCase())) {
      entries.set(entry.theme.toLowerCase(), { ...entry, known: true });
    }
  }

  for (const claim of claimed) {
    const key = String(claim).toLowerCase();
    if (entries.has(key)) continue;
    const entry = known.get(key);
    entries.set(
      key,
      // A theme the book does not claim at all. It gets an entry with no
      // evidence behind it rather than being ignored: a post inventing a theme
      // for the book is the same failure as inventing an award result, and the
      // system's rule has been not to guess on the book's behalf.
      entry ? { ...entry, known: true } : { theme: String(claim), keyMessage: '', passages: [], known: false },
    );
  }

  return [...entries.values()];
}

/** Roughly one word per this many characters of English prose. */
const CHARS_PER_WORD = 6;

/** One of the book's words about a theme is expected per this many words written. */
const WORDS_PER_TERM = 15;

/**
 * How many of the book's own words about a theme this particular post should
 * carry to count as arguing it rather than name-checking it.
 *
 * Measured off the post's own length, not the platform's limit. The limit is a
 * bad proxy: Instagram allows 2,200 characters and most captions are three
 * lines, so a per-platform target is wrong for every post that does not fill
 * its format. Judging a post by the room it actually took is also the version
 * that cannot be gamed — padding raises the target faster than it raises the
 * count, so a post cannot buy alignment with words that are not the book's.
 *
 * Floored at 3 because below that "carried two words" is a coincidence, and
 * capped at the press-release target because a very long post should not face
 * a harder test than a press release does.
 */
export function termTargetFor(content) {
  const written = String(content).length / CHARS_PER_WORD;
  return Math.max(
    3,
    Math.min(config.themeMessageTermTarget, Math.round(written / WORDS_PER_TERM)),
  );
}

/**
 * Scores one candidate post.
 *
 * Pass `grounding` and `voice` and the post is measured against the same
 * evidence it was written from — the book's retrieved passages, and traits
 * counted off the author's real posts. Both sides of generation, one body of
 * evidence, exactly as STORY-006 did for press materials.
 *
 * Without them it falls back to the STORY-001 heuristics above, which is the
 * degraded path for a book with no theme index or an author with no history.
 * Our code scores in both cases: a provider reporting its own alignment would
 * make REQ-001's criterion unverifiable, which is the one thing it cannot be.
 */
export function scoreDraft({
  content,
  themesUsed,
  bookThemes,
  history,
  maxChars,
  grounding = null,
  voice = null,
  bookTitle = '',
}) {
  const termTarget = termTargetFor(content);
  const inPlay = grounding
    ? themesInPlay({ content, claimed: themesUsed, grounding, bookTitle })
    : [];

  // Scored on the copy minus the title, for the same reason the title is
  // excluded from naming: the book's name is not an argument the book makes.
  const alignment = grounding
    ? alignToThemes({
        text: withoutTitle(content, bookTitle),
        grounding: { themes: inPlay },
        termTarget,
        // The book's whole theme list, not just the ones this post raises: a
        // post naming three themes must not earn credit on one for the others.
        themeVocabulary: (grounding.themes ?? []).map((t) => t.theme),
      })
    : null;

  const themeScore = alignment
    ? alignment.score
    : labelReuseScore(`${content} ${themesUsed.join(' ')}`, bookThemes);

  const voiceResult = voice
    ? checkVoice({ text: content, voice })
    : { score: vocabularyOverlapScore(content, history), violations: [], traits: [], summary: 'vocabulary overlap with prior posts' };

  const fit = fitScore(content, maxChars);
  const confidence = Number(
    (themeScore * 0.45 + voiceResult.score * 0.35 + fit * 0.2).toFixed(3),
  );

  const perTheme = (alignment?.perTheme ?? []).map((t) => ({
    ...t,
    known: inPlay.find((e) => e.theme === t.theme)?.known ?? true,
  }));

  return {
    confidence,
    themeAlignment: Number(themeScore.toFixed(3)),
    voiceScore: Number(voiceResult.score.toFixed(3)),
    voiceViolations: voiceResult.violations,
    voiceTraits: voiceResult.traits,
    matchedThemes: alignment ? alignment.matched : [],
    perTheme,
    rationale: alignment
      ? `themes=${themeScore.toFixed(2)} (${alignment.summary}) · ` +
        `voice=${voiceResult.score.toFixed(2)} (${voiceResult.summary}) · ` +
        `fit=${fit.toFixed(2)} (${content.length}/${maxChars} chars)`
      : `grounding=${themeScore.toFixed(2)} (themes reused) · ` +
        `voice=${voiceResult.score.toFixed(2)} (vocabulary overlap with prior posts) · ` +
        `fit=${fit.toFixed(2)} (${content.length}/${maxChars} chars)`,
  };
}

/**
 * Drafts a week of social posts for one book.
 *
 * The pipeline is retrieve → draft → verify (STORY-009, following STORY-006).
 * The AI Content Generation Agent pulls what the book argues about each theme
 * and the author's voice is derived from their own previous posts, *before* a
 * word is written; the provider writes from both; and the finished post is then
 * checked against the same two bodies of evidence.
 *
 * STORY-001 had both inputs and used neither — it handed them to the provider,
 * which dropped them, and then graded itself on how well it had used them.
 *
 * Nothing here publishes: every draft lands in `pending_approval`, or in
 * `escalated` when confidence, theme alignment or voice falls below its floor
 * so a human is pulled in rather than the agent proceeding (TBI: escalation).
 */
export async function draftWeeklyPosts({
  authorId,
  bookId,
  count = config.minPostsPerWeek,
  platforms = PLATFORMS,
  providerName = config.aiProvider,
  weekOf = weekStart(),
  memeCount = config.minMemesPerBatch,
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
    // Which platforms a meme is worth routing to (STORY-066). Read from the
    // platform row rather than a list in this file, so adding a platform is a
    // seed change and not a code change. Intersected with the platforms this
    // batch was asked for, so a caller naming only LinkedIn still gets memes
    // rather than silently getting none.
    const visualFirst = windows
      .filter((w) => w.visual_first && platforms.includes(w.platform))
      .map((w) => w.platform);

    // Retrieval, before generation. Logged against the book rather than a draft
    // because a week of posts has no row of its own, and the retrieval is a
    // fact about the book either way.
    const grounding = await groundInBookThemes(
      {
        bookId: book.id,
        authorId,
        entityType: 'book',
        entityId: book.id,
        action: 'social.themes_retrieved',
      },
      client,
    );

    // The voice, counted off the author's own posts. `voice_profile` is passed
    // through for the cross-check it now gets, not as the source of truth —
    // what the author writes outranks what the author says they write.
    const voice = deriveVoice(history, author.voice_profile);

    await recordAction(
      {
        actor: CONTENT_AGENT,
        action: 'social.voice_derived',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          priorPosts: voice.posts,
          enforceable: voice.enforceable,
          meanSentenceWords: Number(voice.meanSentenceWords.toFixed(1)),
          exclamationsPer100: Number(voice.exclamationsPer100.toFixed(2)),
          hypePer100: Number(voice.hypePer100.toFixed(2)),
          vocabulary: voice.vocabulary.size,
          // Which hand-written claims the author's own posts actually support.
          statedClaims: voice.stated,
        },
      },
      client,
    );

    const candidates = await provider.generateCandidates({
      book,
      author,
      voiceProfile: author.voice_profile,
      voice,
      grounding,
      history,
      platforms,
      count,
      weekOf,
      // At least one meme per batch is the acceptance criterion, so it is a
      // floor the drafter is asked for rather than an average it may miss.
      memeCount,
      visualFirstPlatforms: visualFirst,
      templates: usableTemplates(),
    });

    const saved = [];
    for (const candidate of candidates) {
      const maxChars = maxCharsFor.get(candidate.platform) ?? 2000;
      const {
        confidence,
        themeAlignment,
        voiceScore,
        voiceViolations,
        voiceTraits,
        matchedThemes,
        perTheme,
        rationale,
      } = scoreDraft({
        content: candidate.content,
        themesUsed: candidate.themesUsed,
        bookThemes: book.themes,
        history,
        maxChars,
        grounding,
        voice,
        bookTitle: book.title,
      });

      // A meme is built and checked here, before it can be queued (STORY-066).
      // The image is rendered from the template the provider chose, provenance
      // is written at generation time rather than reconstructed later, and both
      // checks run before the candidate is allowed near the approval queue.
      const isMeme = candidate.format === 'meme';
      const media = isMeme
        ? {
            imageRef: renderMeme({
              template: candidate.template,
              caption: candidate.content,
              bookTitle: book.title,
            }),
            altText: candidate.altText ?? '',
            template: candidate.template.id,
            layout: candidate.template.layout,
            provenance: provenanceFor(candidate.template),
          }
        : null;

      const review = isMeme
        ? reviewMemeCandidate({ caption: candidate.content, media, maxChars })
        : { findings: [], rights: RIGHTS.NOT_APPLICABLE, rightsReason: '', attribution: null };

      // Four independent reasons to escalate. Theme alignment and voice are
      // separate floors rather than blended into confidence, because REQ-001
      // asks for both specifically: copy that argues the book perfectly in a
      // voice the author has never used must not pass on its themes alone.
      // Brand-safety findings join them — a judgement a human may overrule.
      const { status, reasons } = assess({
        confidence,
        themeAlignment,
        voice: voiceScore,
        safetyFindings: review.findings,
      });

      const { rows } = await client.query(
        `INSERT INTO drafts
           (author_id, book_id, platform, content, themes_used, confidence, rationale, status,
            week_of, provider, theme_alignment, voice_score, voice_violations, grounded_passages,
            format, media, safety_findings, image_rights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          authorId,
          bookId,
          candidate.platform,
          candidate.content,
          // The verified matches, not the provider's own claim about which
          // themes it used — the same reason scoring is not left to the model.
          matchedThemes.length > 0 ? matchedThemes : candidate.themesUsed,
          confidence,
          rationale,
          status,
          weekOf,
          provider.name,
          themeAlignment,
          voiceScore,
          voiceViolations,
          grounding.passageCount,
          candidate.format ?? 'text',
          media ? JSON.stringify(media) : null,
          review.findings,
          review.rights,
        ],
      );
      const draft = rows[0];

      // Per-theme verdicts. The single number says a post is 0.62 aligned;
      // these say which theme it name-checked and failed to argue.
      for (const theme of perTheme) {
        await client.query(
          `INSERT INTO draft_themes
             (draft_id, theme, key_message, named, message_score, score, known,
              passage_ids, carried_terms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (draft_id, theme) DO NOTHING`,
          [
            draft.id,
            theme.theme,
            theme.keyMessage,
            theme.named,
            theme.messageScore,
            theme.score,
            theme.known,
            theme.passageIds,
            theme.carriedTerms,
          ],
        );
      }

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
            themeAlignment,
            voiceScore,
            voiceViolations,
            voiceTraits,
            threshold: config.confidenceEscalationThreshold,
            minThemeAlignment: config.minThemeAlignment,
            minVoiceMatch: config.minVoiceMatch,
            reasons,
            groundedPassages: grounding.passageCount,
            format: candidate.format ?? 'text',
            // The story's trust clause asks for image provenance on the log,
            // not only on the row: a meme whose licence is later questioned has
            // to be answerable from the append-only record.
            ...(isMeme
              ? {
                  template: candidate.template.id,
                  provenance: media.provenance,
                  imageRights: review.rights,
                  imageRightsReason: review.rightsReason,
                  safetyFindings: review.findings,
                  publishable: review.publishable,
                }
              : {}),
            reason:
              status === 'escalated'
                ? `below floor: ${reasons.join(', ')}`
                : 'awaiting human approval',
          },
        },
        client,
      );

      saved.push(draft);
    }

    return saved;
  });
}
