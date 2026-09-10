import { getPrProvider } from '../ai/index.js';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { isAnnounceable, outcomeOf } from '../services/awards.js';
import { anniversaryYears } from '../services/milestones.js';
import { deriveVoice } from '../services/voiceProfile.js';

import { composeMaterials } from './aiContentGenerationAgent.js';
import { groundInBookThemes } from './contentAlignmentAgent.js';

/**
 * Press materials are a second capability of the PR and Outreach Agent named in
 * STORY-002 and STORY-003, kept in its own module because a press release and a
 * booking pitch share an owner but not a job.
 *
 * What this module owns is the *milestone*: whether an event is announceable,
 * which anniversary it is, what an award outcome does to the angle, and the one
 * kit per milestone rule. Writing the copy and scoring it moved to the AI
 * Content Generation Agent in STORY-018, which is the agent the map always said
 * owned generation and which now has an on-demand path of its own. The scoring
 * functions are re-exported here so callers that have always found them at this
 * address still do.
 */
export const ACTOR = 'PROutreachAgent';

export {
  MATERIAL_TYPES,
  proseOf,
  scoreMaterial,
  themeAlignment,
} from './aiContentGenerationAgent.js';

/**
 * Drafts the press kit for a milestone.
 *
 * The pipeline is retrieve → draft → verify (STORY-006). The AI Content
 * Generation Agent pulls what the book argues about each of its themes before a
 * word is written, the provider writes from that evidence, and the same
 * evidence is then used to check what came back. Alignment used to be only the
 * last of those three, which is why a draft could be graded off-message but
 * never written on-message. STORY-018 added the author's voice to both ends of
 * that same loop.
 *
 * Nothing is distributed here. Every material lands in `pending_approval`, or
 * `escalated` when confidence is low, theme alignment falls below the floor, or
 * the copy does not sound like the author, so an off-message release reaches a
 * human rather than a newsroom.
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
      `INSERT INTO pr_kits (milestone_id, author_id, book_id, provider, occasion, angle)
       VALUES ($1,$2,$3,$4,'milestone',$5) RETURNING *`,
      [milestoneId, milestone.author_id, milestone.book_id, provider.name, milestone.type],
    );
    const kit = kitRows[0];

    // Retrieval, before generation. Attached to the kit so the audit log can
    // say what the drafter was given, not only what it produced.
    const grounding = await groundInBookThemes(
      { bookId: book.id, kitId: kit.id, authorId: milestone.author_id },
      client,
    );

    // The other half of the criterion, measured off the author's own posts.
    // A milestone kit is held to the same voice floor as an on-demand one:
    // "all generated PR materials" is what the story asks for, and two
    // standards for one table is how a gate becomes advisory (STORY-018).
    const voice = deriveVoice(history, author.voice_profile);

    // Which anniversary this is, when the milestone is one and the publication
    // date makes it knowable. Passed to the provider so the copy can say so
    // instead of assuming the first (STORY-004).
    const years =
      milestone.type === 'anniversary'
        ? anniversaryYears({ publishedOn: book.published_on, eventDate: milestone.event_date })
        : null;

    const awardOutcome = outcomeOf(milestone);

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
        milestone,
        angle: milestone.type,
        anniversaryYears: years,
        awardOutcome,
        awardName: milestone.award_name ?? null,
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
        authorId: milestone.author_id,
        after: countedKit,
        metadata: {
          occasion: 'milestone',
          milestone: milestone.title,
          milestoneType: milestone.type,
          materials: materials.map((m) => m.type),
          provider: provider.name,
          anniversaryYears: years,
          awardOutcome,
          awardName: milestone.award_name ?? null,
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
      milestone,
      materials,
      anniversaryYears: years,
      awardOutcome,
      grounding,
    };
  });
}
