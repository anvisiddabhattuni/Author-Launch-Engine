/**
 * STORY-025 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Social media API integration" → an approved post is scheduled for
 *       publishing when the system connects to the platform.
 *   "Error handling in API integration" → when an API call fails, the system
 *       logs the error **and notifies the user**.
 *
 * The first has worked since STORY-001, and STORY-016 gave the call real
 * timeout, retry and classification policy. The second was half done, and the
 * missing half is the one that matters: measured before this story, a failed
 * publish set `status = 'failed'`, stored the provider's message, wrote a
 * `post.failed` audit row — and told nobody. No notification, no governance
 * check, no place in any queue. The post was visible on the Schedule tab to
 * anyone who opened a table they had no reason to open, while the author went
 * on believing it had gone out.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { runChecks } from '../src/services/governance.js';
import { notifyFailedPublishes } from '../src/services/publishFailureNotifier.js';
import { OUTBOUND_PATHS } from '../src/services/outboundPaths.js';
import { RECURRING } from '../src/jobs/handlers.js';

let authorId;
let bookId;
let reviewerId;

/** Captures what would have been emailed, so assertions can read the notice. */
const recorder = () => {
  const sent = [];
  return {
    sent,
    async send({ to, subject, body, via }) {
      sent.push({ to, subject, body, via });
      return { externalId: `rec_${sent.length}`, acceptedAt: new Date().toISOString() };
    },
  };
};

/** A post that reached the platform and was refused. */
async function failedPost({ error = 'twitter rejected the post: rate limited' } = {}) {
  const { rows: draft } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                         theme_alignment, week_of)
     VALUES ($1,$2,'twitter','a post that did not make it','approved',0.9,0.9,CURRENT_DATE)
     RETURNING *`,
    [authorId, bookId],
  );
  const { rows } = await query(
    `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status, error, format)
     VALUES ($1,$2,'twitter',now(),'failed',$3,'text') RETURNING *`,
    [draft[0].id, authorId, error],
  );
  return rows[0];
}

before(async () => {
  const stamp = Date.now();
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Publish Failure Author', `publishfail-${stamp}@example.test`],
  );
  authorId = a[0].id;

  const { rows: b } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'A Book', 'Content about craft.', ['craft']],
  );
  bookId = b[0].id;

  const { rows: r } = await query(
    `INSERT INTO reviewers (author_id, name, email, role, active)
     VALUES ($1,$2,$3,'publicist',true) RETURNING *`,
    [authorId, 'Failure Reviewer', `failure-reviewer-${stamp}@example.test`],
  );
  reviewerId = r[0].id;
});

after(async () => {
  await closePool();
});

describe('Scenario: error handling — the failure reaches a person', () => {
  let notifier;
  let post;

  before(async () => {
    notifier = recorder();
    post = await failedPost();
  });

  it('announces a failed publish to the author\'s reviewers', async () => {
    const result = await notifyFailedPublishes({ authorId, notifier });
    assert.equal(result.notified.length, 1);
    assert.equal(result.announced, 1);
    assert.match(notifier.sent[0].subject, /failed to publish/);
  });

  it('says what failed and why, not merely that something did', () => {
    const body = notifier.sent[0].body;
    assert.match(body, /twitter/);
    assert.match(body, /rate limited/, 'the provider\'s own message is not in the notice');
    assert.match(body, /a post that did not make it/, 'the post\'s content is not in the notice');
  });

  it('says nothing was wrongly published, because that is the other fear', () => {
    // A reviewer reading "a post failed" needs to know which way it failed.
    // Something published without approval and something that never published
    // are opposite problems, and only one of them is this.
    assert.match(notifier.sent[0].body, /Nothing was published that should not have been/);
  });

  it('leaves it once, however often the sweep runs', async () => {
    const before_ = notifier.sent.length;
    const again = await notifyFailedPublishes({ authorId, notifier });
    assert.equal(again.announced, 0);
    assert.equal(again.reason, 'already announced');
    assert.equal(notifier.sent.length, before_, 'a failed post was re-announced');
  });

  it('records the announcement against the post, so "was this told" is a lookup', async () => {
    const { rows } = await query(
      'SELECT * FROM notifications WHERE scheduled_post_id = $1',
      [post.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].reviewer_id), Number(reviewerId));
    assert.equal(rows[0].status, 'sent');
  });

  it('sends through a declared outbound path', () => {
    // STORY-020: nothing leaves without naming the path it leaves by.
    assert.equal(notifier.sent[0].via, 'social.notify_failure');
    const declared = OUTBOUND_PATHS.find((p) => p.id === 'social.notify_failure');
    assert.ok(declared, 'the path is not declared');
    assert.match(declared.why, /announces an absence/);
  });

  it('logs the announcement as its own action', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'author' });
    const announced = entries.find((e) => e.action === 'publish.failures_announced');
    assert.ok(announced, 'the announcement was not recorded');
    assert.equal(announced.actor, 'APIIntegrationAgent');
  });
});

describe('The three states a bare count would collapse', () => {
  it('distinguishes "nothing failed" from "already announced"', async () => {
    const { rows: fresh } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['No Failures Author', `nofail-${Date.now()}@example.test`],
    );
    const result = await notifyFailedPublishes({ authorId: fresh[0].id, notifier: recorder() });
    assert.equal(result.reason, 'no failed posts');
  });

  it('records a failure nobody can be told about, rather than staying silent', async () => {
    const { rows: lonely } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['No Reviewer Author', `noreviewer-${Date.now()}@example.test`],
    );
    const { rows: book } = await query(
      'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
      [lonely[0].id, 'B', 'c', ['craft']],
    );
    const { rows: draft } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                           theme_alignment, week_of)
       VALUES ($1,$2,'twitter','orphan','approved',0.9,0.9,CURRENT_DATE) RETURNING *`,
      [lonely[0].id, book[0].id],
    );
    await query(
      `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status, error, format)
       VALUES ($1,$2,'twitter',now(),'failed','boom','text')`,
      [draft[0].id, lonely[0].id],
    );

    const result = await notifyFailedPublishes({ authorId: lonely[0].id, notifier: recorder() });
    assert.equal(result.reason, 'no active reviewer');

    const { rows } = await query(
      "SELECT * FROM audit_log WHERE author_id = $1 AND action = 'publish.failure_unreachable'",
      [lonely[0].id],
    );
    assert.ok(rows[0], 'an unreachable failure must not be silent');
  });
});

describe('It runs whether or not anyone is looking', () => {
  it('is a recurring sweep, not something a human has to remember', () => {
    const sweep = RECURRING.find((r) => r.kind === 'posts.notify_failures');
    assert.ok(sweep, 'nothing announces publish failures on a timer');
    assert.equal(sweep.scope, 'author');
  });
});

describe('Checked from outside the notifier', () => {
  it('has a governance check for an unannounced failure', async () => {
    const result = (await runChecks({})).find((c) => c.id === 'posts.failures_announced');
    assert.ok(result, 'no check counts unannounced failures');
    assert.equal(result.passed, true, `${result.violations} failures nobody was told about`);
  });

  it('and the check can fail', async () => {
    // A bad row that is cleaned up, rather than a permanent fixture: the point
    // of this test is that the check is not decoration.
    const post = await failedPost({ error: 'deliberate, for the check' });
    const failing = (await runChecks({})).find((c) => c.id === 'posts.failures_announced');
    assert.equal(failing.passed, false, 'an unannounced failure slipped past the check');
    assert.ok(failing.violations >= 1);

    await notifyFailedPublishes({ authorId, notifier: recorder() });
    const recovered = (await runChecks({})).find((c) => c.id === 'posts.failures_announced');
    assert.equal(recovered.passed, true, 'announcing it did not clear the check');
    void post;
  });

  it('does not count a failure for an author with nobody to tell', async () => {
    // Otherwise a missing reviewer would hide a missing notification, and the
    // two are different findings with different fixes.
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM scheduled_posts sp
        WHERE sp.status = 'failed'
          AND NOT EXISTS (SELECT 1 FROM reviewers r WHERE r.author_id = sp.author_id AND r.active)`,
    );
    assert.ok(rows[0].n > 0, 'expected the unreachable fixture to still exist');
    const check = (await runChecks({})).find((c) => c.id === 'posts.failures_announced');
    assert.equal(check.passed, true, 'an unreachable failure was counted as unannounced');
  });
});
