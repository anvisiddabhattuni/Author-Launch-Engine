import { getPrProvider } from '../ai/index.js';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { assess } from '../services/escalationPolicy.js';
import { isAnnounceable, outcomeOf } from '../services/awards.js';
import { anniversaryYears } from '../services/milestones.js';

import {
  ACTOR as CONTENT_AGENT,
  alignToThemes,
  groundInBookThemes,
} from './contentAlignmentAgent.js';

/**
 * Press materials are a second capability of the PR and Outreach Agent named in
 * STORY-002 and STORY-003, kept in its own module because a press release and a
 * booking pitch share an owner but not a job.
 */
export const ACTOR = 'PROutreachAgent';

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
 * the draft carry the theme's key message — lives in the AI Content Generation
 * Agent, which needs the retrieved evidence this function never had.
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

function voiceScore(text, history) {
  if (history.length === 0) return 0.6;
  const corpus = words(history.map((h) => h.content).join(' '));
  const body = [...words(text)].filter((w) => w.length > 3);
  if (body.length === 0) return 0;
  const overlap = body.filter((w) => corpus.has(w)).length / body.length;
  return Math.min(1, 0.4 + overlap * 1.5);
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
 */
export function scoreMaterial({
  type, headline, body, bookThemes, bookContent, history, grounding = null,
}) {
  const full = `${headline}\n${body}`;
  const alignment = grounding
    ? alignToThemes({ text: full, grounding })
    : verbatimReport(full, bookThemes);
  const completeness = completenessScore(type, full);
  const bookLanguage = groundingScore(full, bookContent);
  const voice = voiceScore(body, history);

  const confidence = Number(
    (alignment.score * 0.45 + completeness * 0.25 + bookLanguage * 0.15 + voice * 0.15).toFixed(3),
  );

  return {
    confidence,
    themeAlignment: Number(alignment.score.toFixed(3)),
    matchedThemes: alignment.matched,
    arguedThemes: alignment.argued,
    perTheme: alignment.perTheme,
    rationale:
      `theme alignment=${alignment.score.toFixed(2)} (${alignment.summary}) · ` +
      `completeness=${completeness.toFixed(2)} (required ${type} elements) · ` +
      `grounding=${bookLanguage.toFixed(2)} (book's own language) · ` +
      `voice=${voice.toFixed(2)} (overlap with prior posts)`,
  };
}

/**
 * Drafts the press kit for a milestone.
 *
 * The pipeline is retrieve → draft → verify (STORY-006). The AI Content
 * Generation Agent pulls what the book argues about each of its themes before a
 * word is written, the provider writes from that evidence, and the same
 * evidence is then used to check what came back. Alignment used to be only the
 * last of those three, which is why a draft could be graded off-message but
 * never written on-message.
 *
 * Nothing is distributed here. Every material lands in `pending_approval`, or
 * `escalated` when confidence is low or theme alignment falls below the floor,
 * so an off-message release reaches a human rather than a newsroom.
 */
export async function draftPressKit({
  milestoneId,
  providerName = config.aiProvider,
  // Injectable so the escalation path can be exercised with a provider that
  // deliberately writes off-message copy; production always resolves by name.
  provider = getPrProvider(providerName),
}) {
  return withTransaction(async (client) => {
    const { rows: milestoneRows } = await client.query(
      'SELECT * FROM milestones WHERE id = $1',
      [milestoneId],
    );
    const milestone = milestoneRows[0];
    if (!milestone) throw Object.assign(new Error('Milestone not found'), { status: 404 });

    // An award the book did not win is not news, so there is nothing to draft.
    // Refused here rather than in the caller so the UI, the watcher and the API
    // all get the same answer (STORY-005).
    if (!isAnnounceable(milestone)) {
      throw Object.assign(
        new Error(
          `Milestone ${milestoneId} has outcome "${outcomeOf(milestone)}": ` +
            'an award that was not won produces no press material',
        ),
        { status: 409 },
      );
    }

    // Only one kit may be *in progress*. A distributed kit is history — a book
    // that was shortlisted and then wins needs a second announcement, not a
    // refusal.
    const { rows: existing } = await client.query(
      "SELECT * FROM pr_kits WHERE milestone_id = $1 AND status = 'drafting'",
      [milestoneId],
    );
    if (existing[0]) {
      throw Object.assign(
        new Error(`Milestone ${milestoneId} already has a press kit (id ${existing[0].id})`),
        { status: 409 },
      );
    }

    const { rows: bookRows } = await client.query('SELECT * FROM books WHERE id = $1', [
      milestone.book_id,
    ]);
    const book = bookRows[0];

    const { rows: authorRows } = await client.query('SELECT * FROM authors WHERE id = $1', [
      milestone.author_id,
    ]);
    const author = authorRows[0];

    const { rows: history } = await client.query(
      'SELECT content FROM social_history WHERE author_id = $1',
      [milestone.author_id],
    );

    const { rows: kitRows } = await client.query(
      `INSERT INTO pr_kits (milestone_id, author_id, book_id, provider)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [milestoneId, milestone.author_id, milestone.book_id, provider.name],
    );
    const kit = kitRows[0];

    // Retrieval, before generation. Attached to the kit so the audit log can
    // say what the drafter was given, not only what it produced.
    const grounding = await groundInBookThemes(
      { bookId: book.id, kitId: kit.id, authorId: milestone.author_id },
      client,
    );

    // Which anniversary this is, when the milestone is one and the publication
    // date makes it knowable. Passed to the provider so the copy can say so
    // instead of assuming the first (STORY-004).
    const years =
      milestone.type === 'anniversary'
        ? anniversaryYears({ publishedOn: book.published_on, eventDate: milestone.event_date })
        : null;

    const awardOutcome = outcomeOf(milestone);

    const produced = await provider.draftKit({
      milestone,
      book,
      author,
      anniversaryYears: years,
      awardOutcome,
      awardName: milestone.award_name ?? null,
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
        rationale,
      } = scoreMaterial({
        type: item.type,
        headline: item.headline,
        body: item.body,
        bookThemes: book.themes,
        bookContent: book.content,
        history,
        grounding,
      });

      // Two independent reasons to escalate. The alignment floor is separate
      // from the confidence threshold so a well-formed but off-message release
      // cannot pass on the strength of its formatting.
      const { status, reasons } = assess({ confidence, themeAlignment: alignment });

      const { rows } = await client.query(
        `INSERT INTO pr_materials
           (kit_id, author_id, book_id, type, headline, body, themes_used,
            theme_alignment, confidence, rationale, status, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          kit.id,
          milestone.author_id,
          milestone.book_id,
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
      // was checked against, which is the half STORY-006 asks for.
      await recordAction(
        {
          actor: CONTENT_AGENT,
          action: 'pr_material.aligned',
          entityType: 'pr_material',
          entityId: material.id,
          authorId: milestone.author_id,
          metadata: {
            materialType: item.type,
            themeAlignment: alignment,
            namedThemes: matchedThemes,
            arguedThemes,
            // Named but not argued: the material mentions the theme and never
            // makes its case. Invisible to the STORY-003 check, which is why
            // this story exists.
            namedOnly: matchedThemes.filter((t) => !arguedThemes.includes(t)),
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
          actor: ACTOR,
          action: status === 'escalated' ? 'pr_material.escalated' : 'pr_material.drafted',
          entityType: 'pr_material',
          entityId: material.id,
          authorId: milestone.author_id,
          after: material,
          metadata: {
            provider: provider.name,
            materialType: item.type,
            confidence,
            themeAlignment: alignment,
            matchedThemes,
            arguedThemes,
            milestone: milestone.title,
            milestoneType: milestone.type,
            escalatedFor: reasons,
          },
        },
        client,
      );

      materials.push(material);
    }

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
        authorId: milestone.author_id,
        after: countedKit,
        metadata: {
          milestone: milestone.title,
          milestoneType: milestone.type,
          materials: materials.map((m) => m.type),
          provider: provider.name,
          anniversaryYears: years,
          awardOutcome,
          awardName: milestone.award_name ?? null,
          groundedThemes: grounding.themes.length,
          groundedPassages: grounding.passageCount,
        },
      },
      client,
    );

    return {
      kit: countedKit,
      milestone,
      materials,
      anniversaryYears: years,
      awardOutcome,
      grounding,
    };
  });
}
