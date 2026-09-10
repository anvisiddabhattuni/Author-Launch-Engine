import { getPrProvider } from '../ai/index.js';
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

/**
 * The AI Content Generation Agent (STORY-018).
 *
 * The agent map has named this agent since the start and it had never generated
 * anything. It existed only as a scorer — `alignToThemes`, the visual identity
 * check, the meme library — always grading some other agent's output. This is
 * where it writes.
 *
 * It gets the press materials because press materials were the capability with
 * the two matching holes. PR materials could not be *requested*: they existed
 * only as a byproduct of a milestone, so a publicist promoting a book with no
 * launch, anniversary or award in the calendar had no path at all. And press
 * copy was never measured against the author's voice — `assess()` was called
 * without it, so the floor could not act. Both halves are in the acceptance
 * criterion, which asks for materials aligned with "the book's themes and
 * author's voice", drafted "when generation is requested".
 *
 * The pipeline is the one STORY-006 and STORY-009 already established, which is
 * the point of putting it here: retrieve what the book argues → derive how the
 * author writes → hand both to the provider → verify what came back against the
 * same evidence. `composeMaterials` is that middle, shared with the milestone
 * path rather than copied, because `draftPressKit` and `draftWeeklyPosts` were
 * already two parallel implementations of this shape and a third by copy-paste
 * is how the three copies of the escalation rule happened.
 */
export const ACTOR = CONTENT_AGENT;

export const MATERIAL_TYPES = ['press_release', 'author_bio', 'fact_sheet'];

/** Elements a journalist expects; a material missing them is not usable copy. */
const REQUIRED_MARKERS = {
  press_release: ['for immediate release', 'media contact', 'about the book'],
  author_bio: ['contact', '@'],
  fact_sheet: ['title —', 'author —', 'themes —'],
};

const words = (text) => new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);

/**
 * Whether a material names the book's themes at all.
 *
 * A theme counts only when it appears verbatim. Matching loosely would let a
 * material claim a theme it never actually addressed, which is precisely what
 * the criterion is there to catch.
 *
 * STORY-006 demoted this from *the* alignment measure to one half of it. Naming
 * a theme is necessary and not sufficient: copy that says "craft" four times
 * scored 1.00 here while arguing nothing the book argues. The other half — did
 * the draft carry the theme's key message — needs the retrieved evidence this
 * function never had, and lives in `alignToThemes`.
 */
export function themeAlignment(text, bookThemes) {
  if (bookThemes.length === 0) return { score: 0, matched: [] };
  const haystack = text.toLowerCase();
  const matched = bookThemes.filter((theme) => haystack.includes(theme.toLowerCase()));
  return { score: matched.length / bookThemes.length, matched };
}

function completenessScore(type, text) {
  const markers = REQUIRED_MARKERS[type] ?? [];
  if (markers.length === 0) return 1;
  const haystack = text.toLowerCase();
  return markers.filter((marker) => haystack.includes(marker)).length / markers.length;
}

function groundingScore(text, bookContent) {
  // Did the material actually draw on the book, or only talk about it? Looks
  // for a run of the book's own words appearing in the material.
  const bookWords = words(bookContent);
  const materialWords = [...words(text)].filter((w) => w.length > 4);
  if (materialWords.length === 0) return 0;
  const overlap = materialWords.filter((w) => bookWords.has(w)).length / materialWords.length;
  return Math.min(1, overlap * 2.5);
}

/**
 * The prose of a press material, with the format's furniture removed.
 *
 * Voice is measured on what a reader reads, not on what the format requires.
 * "FOR IMMEDIATE RELEASE", "MEDIA CONTACT", "###" and the fact sheet's labelled
 * lines are a press kit's conventions, and `measure()` counts a run of capitals
 * as shouting — correctly, for a social post. Scoring them would fail every
 * press release for being a press release, and a fact sheet, which is almost
 * entirely labels, would score as pure shouting no matter who wrote it. That
 * would not be a voice measurement; it would be a format measurement wearing
 * one's name, and a floor built on it would escalate everything and mean
 * nothing.
 *
 * So: drop lines with no lowercase in them at all (headers, rules, the closing
 * ###) and strip the `LABEL — ` prefix from the rest, keeping the value. What
 * survives is the sentences the author is answerable for.
 */
export function proseOf(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // No lowercase letter anywhere: a header, a kicker, or the ###.
    .filter((line) => /[a-z]/.test(line))
    // "SUMMARY — A book about…" is prose behind a label; the label is furniture.
    .map((line) => line.replace(/^[A-Z][A-Z ]{2,}\s*—\s*/, ''))
    .join('\n');
}

/**
 * The STORY-003 measure, in the shape the STORY-006 one returns.
 *
 * Used when a material is scored without grounding — a book whose themes were
 * never indexed still gets the verbatim check rather than a zero it has not
 * earned. Degrading to the older, weaker measure is the right failure here;
 * refusing to score would block the draft entirely.
 */
function verbatimReport(text, bookThemes) {
  const { score, matched } = themeAlignment(text, bookThemes);
  return {
    score,
    matched,
    argued: [],
    perTheme: [],
    summary: `named ${matched.length}/${bookThemes.length} (${matched.join(', ') || 'none'})`,
  };
}

/**
 * Scores one press material.
 *
 * Theme alignment dominates because it is the acceptance criterion; a polished
 * release that never mentions what the book is about is the failure this story
 * exists to prevent.
 *
 * Pass `grounding` and alignment is measured against the retrieved evidence the
 * draft was written from — the same evidence, both sides of generation. Our code
 * scores either way: asking the provider to report its own alignment would make
 * the criterion unverifiable, which is the one thing it cannot be.
 *
 * Pass `voice` (STORY-018) and the voice number becomes the same measurement
 * social posts get — counted traits against the author's own posts — rather
 * than the vocabulary overlap it used to be, which any text about the same book
 * passed. The weights are unchanged on purpose: this story makes the number
 * true and makes it gate, and re-tuning confidence at the same time would make
 * it impossible to say which change moved a score.
 */
export function scoreMaterial({
  type, headline, body, bookThemes, bookContent, history, grounding = null, voice = null,
}) {
  const full = `${headline}\n${body}`;
  const alignment = grounding
    ? alignToThemes({ text: full, grounding })
    : verbatimReport(full, bookThemes);
  const completeness = completenessScore(type, full);
  const bookLanguage = groundingScore(full, bookContent);

  // No derived voice passed means an older caller; derive from the history it
  // did pass, so there is one measure rather than two.
  const profile = voice ?? deriveVoice(history ?? [], {});
  const voiceCheck = checkVoice({ text: proseOf(`${headline}\n${body}`), voice: profile });

  const confidence = Number(
    (alignment.score * 0.45 + completeness * 0.25 + bookLanguage * 0.15 + voiceCheck.score * 0.15)
      .toFixed(3),
  );

  return {
    confidence,
    themeAlignment: Number(alignment.score.toFixed(3)),
    matchedThemes: alignment.matched,
    arguedThemes: alignment.argued,
    perTheme: alignment.perTheme,
    voiceScore: Number(voiceCheck.score.toFixed(3)),
    voiceViolations: voiceCheck.violations,
    voiceTraits: voiceCheck.traits,
    rationale:
      `theme alignment=${alignment.score.toFixed(2)} (${alignment.summary}) · ` +
      `completeness=${completeness.toFixed(2)} (required ${type} elements) · ` +
      `grounding=${bookLanguage.toFixed(2)} (book's own language) · ` +
      `voice=${voiceCheck.score.toFixed(2)} (${voiceCheck.summary})`,
  };
}

/**
 * Generates, scores and stores the materials of one kit.
 *
 * The middle of both press paths — the milestone one in `draftPressKit` and the
 * on-demand one below. Everything specific to *why* the kit exists is decided by
 * the caller and arrives as arguments; what happens to a material once it has
 * been written is the same either way, and it is the part with the gate in it.
 *
 * Nothing is distributed here. Every material lands in `pending_approval`, or
 * `escalated` when confidence is low, theme alignment falls below the floor, or
 * the copy does not sound like the author — so an off-message or off-voice
 * release reaches a human rather than a newsroom.
 *
 * @param {string} actor The agent that asked for the kit, for the audit row.
 *   The alignment entry is always this agent's; the drafting entry belongs to
 *   whoever commanded it — the PR and Outreach Agent for a milestone it watches,
 *   this agent for a direct request.
 */
export async function composeMaterials({
  kit,
  book,
  author,
  voice,
  grounding,
  provider,
  actor,
  history = [],
  milestone = null,
  angle = 'evergreen',
  anniversaryYears = null,
  awardOutcome = null,
  awardName = null,
}, client) {
  // `angle` is not passed to the provider: the occasion already carries it —
  // a milestone's type, or its absence — and a second copy of the same fact is
  // a second thing that can disagree. It is recorded on the kit and in the log,
  // where it is a description rather than an instruction.
  const produced = await provider.draftKit({
    milestone,
    book,
    author,
    voice,
    anniversaryYears,
    awardOutcome,
    awardName,
    grounding,
  });

  const materials = [];
  for (const item of produced) {
    const {
      confidence,
      themeAlignment: alignment,
      matchedThemes,
      arguedThemes,
      perTheme,
      voiceScore,
      voiceViolations,
      rationale,
    } = scoreMaterial({
      type: item.type,
      headline: item.headline,
      body: item.body,
      bookThemes: book.themes,
      bookContent: book.content,
      history,
      grounding,
      voice,
    });

    // Three independent reasons to escalate. The alignment floor is separate
    // from the confidence threshold so a well-formed but off-message release
    // cannot pass on the strength of its formatting; the voice floor is
    // separate from both so copy that argues the book's themes perfectly in a
    // register the author has never used cannot pass on the strength of its
    // themes (STORY-018).
    const { status, reasons } = assess({
      confidence,
      themeAlignment: alignment,
      voice: voiceScore,
    });

    const { rows } = await client.query(
      `INSERT INTO pr_materials
         (kit_id, author_id, book_id, type, headline, body, themes_used,
          theme_alignment, confidence, rationale, status, provider,
          voice_score, voice_violations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        kit.id,
        kit.author_id,
        kit.book_id,
        item.type,
        item.headline,
        item.body,
        // The verified matches, not the provider's own claim about which
        // themes it used — the same reason scoring is not left to the model.
        matchedThemes,
        alignment,
        confidence,
        rationale,
        status,
        provider.name,
        voiceScore,
        voiceViolations,
      ],
    );
    const material = rows[0];

    // Per-theme verdicts. The single number says a draft is 0.62 aligned;
    // these say *which* theme it named and failed to argue, which is the only
    // form of the finding a reviewer can act on.
    for (const theme of perTheme) {
      await client.query(
        `INSERT INTO pr_material_themes
           (material_id, theme, key_message, named, message_score, score,
            passage_ids, carried_terms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          material.id,
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

    // The alignment act itself, logged by the agent that performed it. The
    // drafting entry below records what was produced; this records what it
    // was checked against, which is the half STORY-006 asks for — now with the
    // voice verdict, which is the half STORY-018 asks for.
    await recordAction(
      {
        actor: CONTENT_AGENT,
        action: 'pr_material.aligned',
        entityType: 'pr_material',
        entityId: material.id,
        authorId: kit.author_id,
        metadata: {
          materialType: item.type,
          themeAlignment: alignment,
          namedThemes: matchedThemes,
          arguedThemes,
          // Named but not argued: the material mentions the theme and never
          // makes its case. Invisible to the STORY-003 check, which is why
          // this story exists.
          namedOnly: matchedThemes.filter((t) => !arguedThemes.includes(t)),
          voiceScore,
          voiceViolations,
          // The voice a draft was held to, so a later reader can tell an
          // enforced verdict from the neutral score a new author gets.
          voiceEnforceable: voice.enforceable,
          priorPosts: voice.posts,
          perTheme: perTheme.map((t) => ({
            theme: t.theme,
            named: t.named,
            argued: t.argued,
            messageScore: t.messageScore,
            passages: t.passageIds.length,
          })),
        },
      },
      client,
    );

    await recordAction(
      {
        actor,
        action: status === 'escalated' ? 'pr_material.escalated' : 'pr_material.drafted',
        entityType: 'pr_material',
        entityId: material.id,
        authorId: kit.author_id,
        after: material,
        metadata: {
          provider: provider.name,
          materialType: item.type,
          confidence,
          themeAlignment: alignment,
          matchedThemes,
          arguedThemes,
          voiceScore,
          voiceViolations,
          occasion: kit.occasion,
          angle,
          milestone: milestone?.title ?? null,
          milestoneType: milestone?.type ?? null,
          escalatedFor: reasons,
        },
      },
      client,
    );

    materials.push(material);
  }

  return materials;
}

/**
 * Generates PR materials for a book on request — the STORY-018 command.
 *
 * No milestone. That is the whole difference and it is the point: a book's
 * press needs are not confined to the three days a year something happens to
 * it, and requiring a milestone meant inventing one, which put a fiction in the
 * table the schedule reads from.
 *
 * What replaces the milestone as the reason for the copy is the book itself —
 * the evergreen angle, "why this book, now" rather than "this happened". So the
 * grounding matters more here than anywhere: with no news hook, what the book
 * argues is the only thing the release has to say.
 */
export async function generatePrMaterials({
  authorId,
  bookId,
  angle = 'evergreen',
  requestedBy = null,
  providerName = config.aiProvider,
  // Injectable so the escalation paths can be exercised with a provider that
  // deliberately writes off-message or off-voice copy; production resolves by
  // name.
  provider = getPrProvider(providerName),
}) {
  return withTransaction(async (client) => {
    // Scoped to the author, not just looked up by id. `tenantParam` guards the
    // address; a handler that assembles its own SQL filters on author_id
    // itself (STORY-017).
    const { rows: bookRows } = await client.query(
      'SELECT * FROM books WHERE id = $1 AND author_id = $2',
      [bookId, authorId],
    );
    const book = bookRows[0];
    if (!book) {
      throw Object.assign(
        new Error(`Book ${bookId} not found for author ${authorId}`),
        { status: 404 },
      );
    }

    // Only one kit may be *in progress*, the rule milestone kits already
    // follow. A distributed kit is history; a second request after that is a
    // new round of press, not a duplicate.
    const { rows: existing } = await client.query(
      `SELECT * FROM pr_kits
        WHERE book_id = $1 AND milestone_id IS NULL AND status = 'drafting'`,
      [bookId],
    );
    if (existing[0]) {
      throw Object.assign(
        new Error(
          `Book ${bookId} already has PR materials in progress (kit ${existing[0].id})`,
        ),
        { status: 409 },
      );
    }

    const { rows: authorRows } = await client.query('SELECT * FROM authors WHERE id = $1', [
      authorId,
    ]);
    const author = authorRows[0];

    const { rows: history } = await client.query(
      'SELECT content FROM social_history WHERE author_id = $1',
      [authorId],
    );

    const { rows: kitRows } = await client.query(
      `INSERT INTO pr_kits
         (milestone_id, author_id, book_id, provider, occasion, angle, requested_by)
       VALUES (NULL,$1,$2,$3,'on_demand',$4,$5) RETURNING *`,
      [authorId, bookId, provider.name, angle, requestedBy],
    );
    const kit = kitRows[0];

    // Retrieval, before generation. Attached to the kit so the audit log can
    // say what the drafter was given, not only what it produced.
    const grounding = await groundInBookThemes(
      { bookId, kitId: kit.id, authorId },
      client,
    );

    // And the other input the criterion names. Derived from the author's own
    // posts rather than read off the hand-written profile, for the reason
    // STORY-009 gives: a profile the drafter cannot fail is not a constraint.
    const voice = deriveVoice(history, author.voice_profile);
    await recordAction(
      {
        actor: ACTOR,
        action: 'pr.voice_derived',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          kitId: kit.id,
          priorPosts: voice.posts,
          enforceable: voice.enforceable,
          meanSentenceWords: Number(voice.meanSentenceWords.toFixed(2)),
          exclamationsPer100: Number(voice.exclamationsPer100.toFixed(2)),
          hypePer100: Number(voice.hypePer100.toFixed(2)),
          shoutedPer100: Number(voice.shoutedPer100.toFixed(2)),
          // A Set, so the size — the object itself is not serialisable and the
          // words themselves are not the finding.
          vocabulary: voice.vocabulary.size,
          statedClaims: voice.stated,
        },
      },
      client,
    );

    const materials = await composeMaterials(
      {
        kit,
        book,
        author,
        voice,
        grounding,
        provider,
        actor: ACTOR,
        history,
        milestone: null,
        angle,
      },
      client,
    );

    // Readable on the kit rather than only in the log: a kit whose copy looks
    // fine but was grounded in zero passages is a kit to be suspicious of.
    const { rows: countedRows } = await client.query(
      `UPDATE pr_kits SET grounded_themes = $2, grounded_passages = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [kit.id, grounding.themes.length, grounding.passageCount],
    );
    const countedKit = countedRows[0];

    await recordAction(
      {
        actor: ACTOR,
        action: 'pr_kit.drafted',
        entityType: 'pr_kit',
        entityId: kit.id,
        authorId,
        after: countedKit,
        metadata: {
          occasion: 'on_demand',
          angle,
          requestedBy,
          materials: materials.map((m) => m.type),
          provider: provider.name,
          groundedThemes: grounding.themes.length,
          groundedPassages: grounding.passageCount,
          voiceEnforceable: voice.enforceable,
          priorPosts: voice.posts,
        },
      },
      client,
    );

    return {
      kit: countedKit,
      materials,
      grounding,
      voice: {
        posts: voice.posts,
        enforceable: voice.enforceable,
        meanSentenceWords: Number(voice.meanSentenceWords.toFixed(2)),
        vocabulary: voice.vocabulary.size,
        stated: voice.stated,
      },
    };
  });
}
