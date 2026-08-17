import { getPrProvider } from '../ai/index.js';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { isAnnounceable, outcomeOf } from '../services/awards.js';
import { anniversaryYears } from '../services/milestones.js';

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
 * The acceptance criterion for this story is that a draft is "aligned with the
 * book's themes", so alignment is measured on its own and stored on its own
 * rather than being blended away inside a single confidence number.
 *
 * A theme counts only when it appears verbatim. Matching loosely would let a
 * material claim a theme it never actually addressed, which is precisely what
 * the criterion is there to catch.
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
 * Scores one press material.
 *
 * Theme alignment dominates because it is the acceptance criterion; a polished
 * release that never mentions what the book is about is the failure this story
 * exists to prevent.
 */
export function scoreMaterial({ type, headline, body, bookThemes, bookContent, history }) {
  const full = `${headline}\n${body}`;
  const alignment = themeAlignment(full, bookThemes);
  const completeness = completenessScore(type, full);
  const grounding = groundingScore(full, bookContent);
  const voice = voiceScore(body, history);

  const confidence = Number(
    (alignment.score * 0.45 + completeness * 0.25 + grounding * 0.15 + voice * 0.15).toFixed(3),
  );

  return {
    confidence,
    themeAlignment: Number(alignment.score.toFixed(3)),
    matchedThemes: alignment.matched,
    rationale:
      `theme alignment=${alignment.score.toFixed(2)} ` +
      `(${alignment.matched.length}/${bookThemes.length}: ${alignment.matched.join(', ') || 'none'}) · ` +
      `completeness=${completeness.toFixed(2)} (required ${type} elements) · ` +
      `grounding=${grounding.toFixed(2)} (book's own language) · ` +
      `voice=${voice.toFixed(2)} (overlap with prior posts)`,
  };
}

/**
 * Drafts the press kit for a milestone.
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
    });

    const materials = [];
    for (const item of produced) {
      const { confidence, themeAlignment: alignment, matchedThemes, rationale } = scoreMaterial({
        type: item.type,
        headline: item.headline,
        body: item.body,
        bookThemes: book.themes,
        bookContent: book.content,
        history,
      });

      // Two independent reasons to escalate. The alignment floor is separate
      // from the confidence threshold so a well-formed but off-message release
      // cannot pass on the strength of its formatting.
      const belowConfidence = confidence < config.confidenceEscalationThreshold;
      const belowAlignment = alignment < config.minThemeAlignment;
      const status = belowConfidence || belowAlignment ? 'escalated' : 'pending_approval';

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
            milestone: milestone.title,
            milestoneType: milestone.type,
            escalatedFor: [
              belowConfidence ? 'confidence' : null,
              belowAlignment ? 'theme_alignment' : null,
            ].filter(Boolean),
          },
        },
        client,
      );

      materials.push(material);
    }

    await recordAction(
      {
        actor: ACTOR,
        action: 'pr_kit.drafted',
        entityType: 'pr_kit',
        entityId: kit.id,
        authorId: milestone.author_id,
        after: kit,
        metadata: {
          milestone: milestone.title,
          milestoneType: milestone.type,
          materials: materials.map((m) => m.type),
          provider: provider.name,
          anniversaryYears: years,
          awardOutcome,
          awardName: milestone.award_name ?? null,
        },
      },
      client,
    );

    return { kit, milestone, materials, anniversaryYears: years, awardOutcome };
  });
}
