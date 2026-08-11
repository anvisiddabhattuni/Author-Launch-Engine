import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { searchAllDirectories } from '../services/directories.js';
import { scoreOpportunity } from '../services/keywordAnalysis.js';

export const ACTOR = 'OpportunityScoutingAgent';

/** First day of the month containing `date`, as YYYY-MM-DD. */
export function monthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Scans the directories and records the listings relevant to this book.
 *
 * Listings below the relevance threshold are rejected rather than stored, so a
 * human is never asked to wade through noise; the rejection is still counted
 * and audited so the filter's behaviour is visible. Re-scanning is idempotent
 * thanks to the unique key on (author_id, source, external_id), which keeps the
 * monthly count honest.
 */
export async function scoutOpportunities({
  authorId,
  bookId,
  from = new Date(),
  threshold = config.relevanceThreshold,
}) {
  return withTransaction(async (client) => {
    const { rows: bookRows } = await client.query(
      'SELECT * FROM books WHERE id = $1 AND author_id = $2',
      [bookId, authorId],
    );
    const book = bookRows[0];
    if (!book) throw Object.assign(new Error('Book not found for this author'), { status: 404 });

    const listings = await searchAllDirectories({ from });
    const discoveredMonth = monthStart(from);

    const identified = [];
    const rejected = [];

    for (const listing of listings) {
      const { relevance, matchedThemes, rationale } = scoreOpportunity({
        listing,
        bookThemes: book.themes,
      });

      if (relevance < threshold) {
        rejected.push({ name: listing.name, relevance });
        continue;
      }

      const { rows } = await client.query(
        `INSERT INTO opportunities
           (author_id, source, external_id, type, name, host, contact_email, url, description,
            topics, audience_size, deadline, relevance, matched_themes, rationale, discovered_month)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
          rationale,
          discoveredMonth,
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
          month: discoveredMonth,
        },
      },
      client,
    );

    return { identified, rejected, scanned: listings.length, month: discoveredMonth };
  });
}
