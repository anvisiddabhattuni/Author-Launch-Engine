import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { deriveExpertise, scoreExpertise } from '../services/authorExpertise.js';
import { OPPORTUNITY_TYPES, searchAllDirectories } from '../services/directories.js';
import { searchWeb } from '../services/webOpportunities.js';
import { scoreOpportunity } from '../services/keywordAnalysis.js';

export const ACTOR = 'OpportunityScoutingAgent';

/** First day of the month containing `date`, as YYYY-MM-DD. */
export function monthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Which test a lead passed, for the row and for the reviewer.
 *
 * Recorded rather than derived on read because it is the answer to "why is this
 * in my queue", and because it is the only way to notice that a whole category
 * of lead is arriving on one basis alone.
 */
export function qualify({ relevance, expertise, relevanceFloor, expertiseFloor }) {
  const onThemes = relevance >= relevanceFloor;
  const onExpertise = expertise >= expertiseFloor;
  if (onThemes && onExpertise) return 'both';
  if (onThemes) return 'themes';
  if (onExpertise) return 'expertise';
  return null;
}

/**
 * Scans the directories and records the listings worth a human's attention.
 *
 * Two independent tests, because there are two independent reasons to say yes
 * (STORY-010). A listing qualifies on the book's themes — "this event is about
 * your subject" — or on the author's expertise — "this event wants someone like
 * you". Requiring both would make expertise a filter that only ever narrows,
 * and the story's own reason for existing is to *expand* the author's reach.
 *
 * Rejections are now stored rather than counted. STORY-002 threw them away, so
 * the one part of the scan nobody could check was the part that decided what a
 * human would never see — and it was hiding a good lead for four stories.
 *
 * Re-scanning is idempotent thanks to the unique keys on
 * (author_id, source, external_id), which keeps the monthly count honest.
 */
export async function scoutOpportunities({
  authorId,
  bookId,
  from = new Date(),
  threshold = config.relevanceThreshold,
  expertiseFloor = config.expertiseThreshold,
  types = null,
}) {
  return withTransaction(async (client) => {
    const { rows: bookRows } = await client.query(
      'SELECT * FROM books WHERE id = $1 AND author_id = $2',
      [bookId, authorId],
    );
    const book = bookRows[0];
    if (!book) throw Object.assign(new Error('Book not found for this author'), { status: 404 });

    // Every book by this author, not only the one being promoted: an author is
    // not only their latest title, and the story asks about *their* expertise.
    const { rows: allBooks } = await client.query(
      'SELECT title, themes, content FROM books WHERE author_id = $1',
      [authorId],
    );
    const { rows: posts } = await client.query(
      'SELECT content FROM social_history WHERE author_id = $1',
      [authorId],
    );
    // What they have actually been through the gate for. An approved outreach
    // message is the system's own evidence that this kind of engagement suits
    // this author — a stronger claim than anything we could infer from text.
    const { rows: trackRecord } = await client.query(
      `SELECT DISTINCT o.type, o.topics
         FROM opportunities o
         JOIN outreach_messages m ON m.opportunity_id = o.id
        WHERE o.author_id = $1 AND m.status IN ('approved', 'sent')`,
      [authorId],
    );

    const expertise = deriveExpertise({ books: allBooks, posts, trackRecord });

    // Real search when configured; the fixed catalogue otherwise (demo, tests).
    let listings;
    if (config.opportunitySources === 'web') {
      const web = await searchWeb({ book, types: types ?? OPPORTUNITY_TYPES, expertise, from, authorId });
      listings = web.listings;
      await recordAction(
        {
          actor: ACTOR,
          action: 'opportunity.web_searched',
          entityType: 'book',
          entityId: String(book.id),
          authorId,
          metadata: {
            searches: web.searches,
            found: web.listings.length,
            // What was thrown away and why — a link the search never returned
            // is the one Claude may have made up.
            dropped: web.dropped,
            types: types ?? OPPORTUNITY_TYPES,
          },
        },
        client,
      );
    } else {
      listings = await searchAllDirectories({ from, types, authorId });
    }
    const discoveredMonth = monthStart(from);

    await recordAction(
      {
        actor: ACTOR,
        action: 'opportunity.expertise_derived',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          books: expertise.books,
          posts: expertise.posts,
          subjectEvidence: expertise.subjectEvidence,
          enforceable: expertise.enforceable,
          themes: expertise.themes,
          formats: expertise.formats.length,
          doneTypes: expertise.doneTypes,
          searchedTypes: types ?? OPPORTUNITY_TYPES,
        },
      },
      client,
    );

    const identified = [];
    const rejected = [];

    for (const listing of listings) {
      const { relevance, matchedThemes, rationale } = scoreOpportunity({
        listing,
        bookThemes: book.themes,
      });
      const expertiseFit = scoreExpertise({ listing, expertise });

      const qualifiedBy = qualify({
        relevance,
        expertise: expertiseFit.score,
        relevanceFloor: threshold,
        expertiseFloor,
      });

      // Ranked on both, weighted towards whichever test it actually passed, so
      // a strong theme match and a strong standing match can sit in one queue
      // without the weaker dimension dragging either down.
      const fit = Number(Math.max(relevance, expertiseFit.score).toFixed(3));
      const fullRationale = `${rationale} · expertise: ${expertiseFit.rationale}`;

      if (qualifiedBy === null) {
        await client.query(
          `INSERT INTO opportunity_rejections
             (author_id, source, external_id, type, name, url, topics, relevance, expertise,
              relevance_floor, expertise_floor, rationale, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (author_id, source, external_id) DO UPDATE
             SET relevance = EXCLUDED.relevance,
                 expertise = EXCLUDED.expertise,
                 relevance_floor = EXCLUDED.relevance_floor,
                 expertise_floor = EXCLUDED.expertise_floor,
                 rationale = EXCLUDED.rationale,
                 last_seen = now()`,
          [
            authorId,
            listing.source,
            listing.externalId,
            listing.type,
            listing.name,
            listing.url,
            listing.topics,
            relevance,
            expertiseFit.score,
            threshold,
            expertiseFloor,
            fullRationale,
          ],
        );
        rejected.push({
          name: listing.name,
          type: listing.type,
          relevance,
          expertise: expertiseFit.score,
        });
        continue;
      }

      const { rows } = await client.query(
        `INSERT INTO opportunities
           (author_id, source, external_id, type, name, host, contact_email, url, description,
            topics, audience_size, deadline, relevance, matched_themes, rationale, discovered_month,
            expertise, expertise_matched, qualified_by, fit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (author_id, source, external_id) DO NOTHING
         RETURNING *`,
        [
          authorId,
          listing.source,
          listing.externalId,
          listing.type,
          listing.name,
          listing.host,
          listing.contactEmail,
          listing.url,
          listing.description,
          listing.topics,
          listing.audienceSize ?? null,
          listing.deadline,
          relevance,
          matchedThemes,
          fullRationale,
          discoveredMonth,
          expertiseFit.score,
          expertiseFit.matched,
          qualifiedBy,
          fit,
        ],
      );

      // No row means we had already recorded this listing on an earlier scan.
      if (rows.length === 0) continue;
      const opportunity = rows[0];

      await recordAction(
        {
          actor: ACTOR,
          action: 'opportunity.identified',
          entityType: 'opportunity',
          entityId: opportunity.id,
          authorId,
          after: opportunity,
          metadata: {
            source: listing.source,
            type: listing.type,
            relevance,
            threshold,
            matchedThemes,
            expertise: expertiseFit.score,
            expertiseFloor,
            expertiseMatched: expertiseFit.matched,
            standingFit: expertiseFit.standingFit,
            subjectFit: expertiseFit.subjectFit,
            qualifiedBy,
          },
        },
        client,
      );

      identified.push(opportunity);
    }

    await recordAction(
      {
        actor: ACTOR,
        action: 'opportunity.scan_completed',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          scanned: listings.length,
          identified: identified.length,
          rejected: rejected.length,
          threshold,
          expertiseFloor,
          month: discoveredMonth,
          searchedTypes: types ?? OPPORTUNITY_TYPES,
          // How many leads arrived on each basis. A scan where nothing ever
          // qualifies on expertise means the second test is doing no work and
          // should be questioned rather than trusted.
          byQualification: identified.reduce((counts, o) => {
            counts[o.qualified_by] = (counts[o.qualified_by] ?? 0) + 1;
            return counts;
          }, {}),
        },
      },
      client,
    );

    return {
      identified,
      rejected,
      scanned: listings.length,
      month: discoveredMonth,
      expertise,
      searchedTypes: types ?? OPPORTUNITY_TYPES,
    };
  });
}
