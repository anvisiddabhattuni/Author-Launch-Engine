import { query } from '../db/pool.js';

/**
 * What happened at an award, and what may be said about it.
 *
 * STORY-005 turns on a distinction STORY-003 collapsed: being shortlisted and
 * winning are different news, and the difference is not cosmetic. Announcing a
 * win as a shortlisting understates it; announcing a shortlisting as a win is a
 * false claim in a press release.
 *
 * Semantics and reads only — the command that records an outcome lives in
 * `awardOutcome.js`, which drafts and so must depend on the agent.
 */

export const AWARD_OUTCOMES = ['shortlisted', 'won', 'not_won'];

export const ACTOR = 'PROutreachAgent';

/**
 * A milestone with no recorded outcome reads as `shortlisted`.
 *
 * Scheduling an award milestone is itself the statement that the book is in the
 * running, and that is publishable news. Winning is a further fact somebody has
 * to record.
 */
export function outcomeOf(milestone) {
  if (milestone.type !== 'award') return null;
  return milestone.outcome ?? 'shortlisted';
}

/** A loss is not news. Everything else is. */
export function isAnnounceable(milestone) {
  return milestone.type !== 'award' || outcomeOf(milestone) !== 'not_won';
}

/**
 * Awards whose date has passed with no win or loss on record.
 *
 * The system cannot draft its way out of this one: it does not know whether the
 * book won, and guessing either way puts a false claim in front of a journalist.
 * So it asks. This is the one place the product deliberately stops and waits for
 * a human instead of producing something.
 */
export async function findAwardsAwaitingOutcome({ authorId, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);

  const { rows } = await query(
    `SELECT m.*,
            b.title AS book_title,
            ($2::date - m.event_date) AS days_since
       FROM milestones m
       JOIN books b ON b.id = m.book_id
      WHERE m.author_id = $1
        AND m.type = 'award'
        AND m.event_date < $2::date
        AND coalesce(m.outcome, 'shortlisted') = 'shortlisted'
      ORDER BY m.event_date DESC, m.id`,
    [authorId, today],
  );

  return rows;
}

/** The kit currently in progress for a milestone, if there is one. */
export async function activeKitFor(milestoneId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    "SELECT * FROM pr_kits WHERE milestone_id = $1 AND status = 'drafting' ORDER BY id DESC LIMIT 1",
    [milestoneId],
  );
  return rows[0] ?? null;
}
