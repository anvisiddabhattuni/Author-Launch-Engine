import { withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';
import { findReviewers } from './reviewNotifier.js';

/**
 * Tells someone a post failed to publish (STORY-025).
 *
 * REQ-006's second clause for this story asks the system to log an API failure
 * **and notify the user**. The logging has been thorough since STORY-016 — the
 * attempt, its classification, its duration and its error are all on the
 * record. Nobody was ever told.
 *
 * That is the worst shape an outbound failure can take. The post sits at
 * `status = 'failed'` with the provider's message next to it, visible on the
 * Schedule tab to anyone who happens to open a table they have no reason to
 * open, while the author goes on believing the post went out. A silent failure
 * on the way out is worse than a loud one: the system knows, and the only
 * person who needs to know does not.
 *
 * Announced once per post per reviewer, ever. A failed post stays failed, and a
 * sweep on a timer would otherwise re-announce every past failure until the
 * channel got muted — the rule STORY-012 set for the approval digest and
 * STORY-021 reused for a persisting breach.
 */
export const ACTOR = 'APIIntegrationAgent';

/** Posts that failed and have not been announced to this reviewer yet. */
async function unannouncedFailures({ authorId, reviewerId }, client) {
  const { rows } = await client.query(
    `SELECT sp.*, d.content AS draft_content
       FROM scheduled_posts sp
       JOIN drafts d ON d.id = sp.draft_id
      WHERE sp.author_id = $1
        AND sp.status = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.scheduled_post_id = sp.id AND n.reviewer_id = $2)
      ORDER BY sp.id`,
    [authorId, reviewerId],
  );
  return rows;
}

function compose({ posts, reviewer, author }) {
  const one = posts.length === 1;
  return {
    subject: `${posts.length} post${one ? '' : 's'} failed to publish for ${author.name}`,
    body: [
      `Hello ${reviewer.name},`,
      '',
      `${posts.length} approved post${one ? '' : 's'} did not reach the platform. ` +
        `${one ? 'It was' : 'They were'} approved and scheduled — the failure happened at the ` +
        'platform, after the gate.',
      '',
      ...posts.map(
        (p) =>
          `  ${p.platform} · scheduled ${new Date(p.scheduled_for).toISOString().slice(0, 16).replace('T', ' ')}\n` +
          `    "${String(p.draft_content).replace(/\s+/g, ' ').slice(0, 90)}"\n` +
          `    error: ${p.error ?? 'not recorded'}`,
      ),
      '',
      // The distinction that matters to whoever reads this: nothing was
      // published wrongly. Something failed to publish at all.
      'Nothing was published that should not have been. These did not go out, and',
      'will not retry on their own — a failed post stays failed until a person acts.',
      '',
      'Open the Schedule tab to see them: /schedule',
    ].join('\n'),
  };
}

/**
 * Announces failed publishes to the author's reviewers.
 *
 * Returns what it announced and what it deliberately did not, so a caller can
 * tell "nothing failed" from "everything already announced" from "nobody to
 * tell" — three states that a bare count collapses into one.
 */
export async function notifyFailedPublishes({ authorId, notifier = emailApi }) {
  return withTransaction(async (client) => {
    const { rows: authorRows } = await client.query('SELECT * FROM authors WHERE id = $1', [
      authorId,
    ]);
    const author = authorRows[0];
    if (!author) throw Object.assign(new Error(`Author ${authorId} not found`), { status: 404 });

    const { rows: anyFailed } = await client.query(
      "SELECT COUNT(*)::int AS n FROM scheduled_posts WHERE author_id = $1 AND status = 'failed'",
      [authorId],
    );
    if (anyFailed[0].n === 0) return { notified: [], announced: 0, reason: 'no failed posts' };

    const reviewers = await findReviewers({ authorId }, client);
    if (reviewers.length === 0) {
      // Not silent. A failure nobody can be told about is its own finding —
      // the shape STORY-012 gave an unreachable approval queue and STORY-021
      // gave an unreachable breach.
      await recordAction(
        {
          actor: ACTOR,
          action: 'publish.failure_unreachable',
          entityType: 'author',
          entityId: authorId,
          authorId,
          metadata: {
            failedPosts: anyFailed[0].n,
            reason: 'Posts failed to publish and no active reviewer is configured to be told.',
          },
        },
        client,
      );
      return { notified: [], announced: 0, reason: 'no active reviewer' };
    }

    const notified = [];
    let announced = 0;

    for (const reviewer of reviewers) {
      const posts = await unannouncedFailures({ authorId, reviewerId: reviewer.id }, client);
      if (posts.length === 0) continue;

      const { subject, body } = compose({ posts, reviewer, author });
      const sent = await notifier.send({
        to: reviewer.email,
        subject,
        body,
        authorId,
        via: 'social.notify_failure',
      });

      // One notification row per post, so "was this one announced" is a lookup
      // rather than a guess, and the unique index does the de-duplicating even
      // if two sweeps race.
      for (const post of posts) {
        await client.query(
          `INSERT INTO notifications
             (author_id, reviewer_id, scheduled_post_id, channel, subject, body,
              pending_count, status, external_id, sent_at)
           VALUES ($1,$2,$3,'email',$4,$5,$6,'sent',$7,now())
           ON CONFLICT DO NOTHING`,
          [authorId, reviewer.id, post.id, subject, body, posts.length, sent.externalId],
        );
        announced += 1;
      }

      notified.push({ reviewer: reviewer.email, posts: posts.map((p) => p.id) });
    }

    if (notified.length === 0) {
      return { notified: [], announced: 0, reason: 'already announced' };
    }

    await recordAction(
      {
        actor: ACTOR,
        action: 'publish.failures_announced',
        entityType: 'author',
        entityId: authorId,
        authorId,
        metadata: {
          reviewers: notified.map((n) => n.reviewer),
          posts: [...new Set(notified.flatMap((n) => n.posts))],
        },
      },
      client,
    );

    return { notified, announced, reason: null };
  });
}
