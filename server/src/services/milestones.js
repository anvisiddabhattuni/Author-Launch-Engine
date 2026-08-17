import { config } from '../config.js';
import { query } from '../db/pool.js';

import { isAnnounceable, outcomeOf } from './awards.js';

/**
 * Milestone reads shared by the press-kit agent, the watcher and the API.
 *
 * STORY-004 turns on two questions STORY-003 never had to ask: *which*
 * anniversary a milestone marks, and *when* a milestone is close enough that its
 * press kit should already exist.
 */

/** Postgres DATE values arrive as UTC midnight, so read them in UTC. */
const parts = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
};

/**
 * How many full years the milestone is celebrating.
 *
 * Returns null when it cannot be known — no publication date, or a date that
 * would make this the zeroth anniversary. Null is a real answer here: the copy
 * falls back to wording that claims no specific year, which is preferable to
 * asserting "first" and being wrong.
 */
export function anniversaryYears({ publishedOn, eventDate }) {
  if (!publishedOn || !eventDate) return null;

  const from = parts(publishedOn);
  const to = parts(eventDate);

  let years = to.y - from.y;
  const beforeTheDay = to.m < from.m || (to.m === from.m && to.d < from.d);
  if (beforeTheDay) years -= 1;

  return years >= 1 ? years : null;
}

/**
 * Milestones falling inside the lead-time window, soonest first.
 *
 * A milestone already past is not approaching, and one beyond the window is not
 * yet the agent's business. Each row carries the kit id when one exists, so
 * callers can tell "needs drafting" from "already drafted" without a second
 * query.
 */
export async function findApproachingMilestones({
  authorId,
  now = new Date(),
  leadTimeDays = config.milestoneLeadTimeDays,
  client = null,
} = {}) {
  const run = client ? client.query.bind(client) : query;
  const today = now.toISOString().slice(0, 10);

  // A milestone can carry more than one kit since STORY-005 — a shortlist
  // announcement and then a win — so the join takes the one that matters now
  // rather than multiplying the row. A superseded kit is not it.
  const { rows } = await run(
    `SELECT m.*,
            b.title        AS book_title,
            b.published_on AS book_published_on,
            k.id           AS kit_id,
            k.status       AS kit_status,
            (m.event_date - $2::date) AS days_until
       FROM milestones m
       JOIN books b ON b.id = m.book_id
       LEFT JOIN LATERAL (
            SELECT id, status
              FROM pr_kits
             WHERE milestone_id = m.id AND status <> 'superseded'
             ORDER BY id DESC
             LIMIT 1
       ) k ON true
      WHERE m.author_id = $1
        AND m.event_date >= $2::date
        AND m.event_date <= ($2::date + $3::int)
      ORDER BY m.event_date, m.id`,
    [authorId, today, leadTimeDays],
  );

  return rows
    .map((row) => ({
      ...row,
      anniversaryYears:
        row.type === 'anniversary'
          ? anniversaryYears({ publishedOn: row.book_published_on, eventDate: row.event_date })
          : null,
      awardOutcome: outcomeOf(row),
    }))
    // An award the book did not win has nothing to announce, so it is not work
    // waiting to be done (STORY-005).
    .filter(isAnnounceable);
}
