/**
 * STORY-005 acceptance tests.
 *
 * The story's one Gherkin scenario — "Given a book has won an award, When the
 * PR and Outreach Agent drafts a PR material, Then the draft is aligned with
 * the book's themes and held for human review" — is the first `describe` block.
 * The rest cover what the scenario leaves implicit: that a win and a
 * shortlisting are different news, that a loss is not announced, and that
 * drafting on a recorded win does not quietly bypass the approval gate.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftPressKit } from '../src/agents/prMaterialsAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial } from '../src/services/approvals.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { recordAwardOutcome } from '../src/services/awardOutcome.js';
import { findAwardsAwaitingOutcome, outcomeOf } from '../src/services/awards.js';
import { distributePressKit } from '../src/services/prDistributor.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];
const PRIZE = 'Vermilion Prize for Nonfiction';

let authorId;
let bookId;

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function createAward({ daysAhead, title, awardName = PRIZE, outcome = 'shortlisted' }) {
  const { rows } = await query(
    `INSERT INTO milestones
       (author_id, book_id, type, title, event_date, location, details, award_name, outcome)
     VALUES ($1,$2,'award',$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      authorId,
      bookId,
      title,
      isoIn(daysAhead),
      'London',
      'One of six titles shortlisted.',
      awardName,
      outcome,
    ],
  );
  return rows[0];
}

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Award Test Author',
      `award-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain', 'unsentimental'] }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      authorId,
      'The Quiet Craft',
      'Attention is a muscle, and like any muscle it adapts to the load you give it. ' +
        'Craft is the slow accumulation of decisions nobody claps for and nobody sees. ' +
        'Resilience is what remains when motivation has gone home for the evening. ' +
        'Deep work is a way of refusing the terms the world offers you by default.',
      BOOK_THEMES,
      '2024-09-10',
    ],
  );
  bookId = bookRows[0].id;

  await query(
    `INSERT INTO social_history (author_id, platform, content, engagement, posted_at)
     VALUES ($1,$2,$3,$4,now())`,
    [
      authorId,
      'twitter',
      'Craft is attention you keep spending after the interesting part is over.',
      JSON.stringify({ likes: 40 }),
    ],
  );
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-005: PR draft creation for book awards', () => {
  let result;
  let materials;

  before(async () => {
    const award = await createAward({
      daysAhead: -2,
      title: 'The Quiet Craft wins the Vermilion Prize',
    });
    result = await recordAwardOutcome({
      milestoneId: award.id,
      outcome: 'won',
      actor: 'Press Reviewer',
    });
    materials = result.materials;
  });

  it('Given a recorded win, the agent drafts without a separate "please draft" step', () => {
    assert.equal(result.drafted, true);
    assert.equal(materials.length, 3, 'a kit is a release, a bio and a fact sheet');
    assert.equal(result.milestone.outcome, 'won');
  });

  it('Then the draft is aligned with the book themes', () => {
    for (const material of materials) {
      assert.ok(
        Number(material.theme_alignment) >= config.minThemeAlignment,
        `${material.type} alignment ${material.theme_alignment} is below the floor`,
      );
      assert.ok(material.themes_used.length > 0, `${material.type} referenced no themes`);
    }
  });

  it('and is held for human review rather than sent', () => {
    for (const material of materials) {
      assert.equal(
        material.status,
        'pending_approval',
        `${material.type} should be waiting on a human`,
      );
    }
  });

  it('refuses to distribute a kit drafted from a recorded win', async () => {
    await assert.rejects(
      () => distributePressKit({ kitId: result.kit.id }),
      /not approved/,
      'recording a win must not imply approval',
    );
  });
});

describe('a win and a shortlisting are different news', () => {
  it('says the book won, using the prize name as data rather than scraping the title', async () => {
    const award = await createAward({
      daysAhead: 10,
      title: 'Ceremony night for the Vermilion Prize',
      outcome: 'won',
    });
    const { materials, awardOutcome } = await draftPressKit({ milestoneId: award.id });
    const release = materials.find((m) => m.type === 'press_release');
    const factSheet = materials.find((m) => m.type === 'fact_sheet');

    assert.equal(awardOutcome, 'won');
    assert.match(release.headline, /wins the Vermilion Prize/i);
    assert.match(release.body, /has won the Vermilion Prize/i);
    assert.doesNotMatch(release.body, /has been shortlisted/i);
    assert.match(factSheet.body, /AWARD STATUS — Winner/);
    assert.match(factSheet.body, /AWARD — Vermilion Prize/);
  });

  it('does not upgrade a shortlisting into a win', async () => {
    const award = await createAward({
      daysAhead: 12,
      title: 'The Quiet Craft shortlisted for the Vermilion Prize',
    });
    const { materials, awardOutcome } = await draftPressKit({ milestoneId: award.id });
    const release = materials.find((m) => m.type === 'press_release');

    assert.equal(awardOutcome, 'shortlisted');
    assert.match(release.body, /has been shortlisted/i);
    assert.doesNotMatch(release.headline, /\bwins\b/i);
    assert.doesNotMatch(release.body, /has won/i);
  });

  it('treats a missing outcome as a shortlisting, not a win', () => {
    assert.equal(outcomeOf({ type: 'award', outcome: null }), 'shortlisted');
    assert.equal(outcomeOf({ type: 'launch', outcome: null }), null);
  });
});

describe('a loss is not announced', () => {
  it('drafts nothing when the outcome is recorded as not_won', async () => {
    const award = await createAward({
      daysAhead: -1,
      title: 'A prize the book did not win',
    });
    const result = await recordAwardOutcome({
      milestoneId: award.id,
      outcome: 'not_won',
      actor: 'Press Reviewer',
    });

    assert.equal(result.drafted, false);
    assert.equal(result.kit, null);
    assert.equal(result.materials.length, 0);
  });

  it('refuses to draft a kit for an award that was not won', async () => {
    const award = await createAward({
      daysAhead: -4,
      title: 'Already lost, no kit',
      outcome: 'not_won',
    });
    await assert.rejects(() => draftPressKit({ milestoneId: award.id }), /not won/);
  });
});

describe('winning withdraws the shortlist copy', () => {
  it('supersedes the shortlist kit and drafts a win kit in its place', async () => {
    const award = await createAward({
      daysAhead: -5,
      title: 'Shortlisted, then won',
    });
    const shortlist = await draftPressKit({ milestoneId: award.id });
    assert.match(
      shortlist.materials.find((m) => m.type === 'press_release').body,
      /has been shortlisted/i,
    );

    const win = await recordAwardOutcome({
      milestoneId: award.id,
      outcome: 'won',
      actor: 'Press Reviewer',
    });

    assert.equal(win.drafted, true);
    assert.ok(win.supersededKit);
    assert.equal(Number(win.supersededKit.id), Number(shortlist.kit.id));
    assert.equal(win.supersededKit.status, 'superseded');
    assert.notEqual(Number(win.kit.id), Number(shortlist.kit.id));
    assert.match(win.materials.find((m) => m.type === 'press_release').headline, /wins/i);
  });

  it('will not distribute the withdrawn shortlist kit, even if it was approved', async () => {
    const award = await createAward({
      daysAhead: -6,
      title: 'Approved shortlist, then a win',
    });
    const shortlist = await draftPressKit({ milestoneId: award.id });
    for (const material of shortlist.materials) {
      await approvePrMaterial({ materialId: material.id, reviewer: 'Press Reviewer' });
    }

    await recordAwardOutcome({
      milestoneId: award.id,
      outcome: 'won',
      actor: 'Press Reviewer',
    });

    await assert.rejects(
      () => distributePressKit({ kitId: shortlist.kit.id }),
      /superseded/,
      'approved copy that now states the wrong news must not go out',
    );
  });

  it('will not accept a review of withdrawn copy', async () => {
    const award = await createAward({
      daysAhead: -7,
      title: 'Unreviewed shortlist, then a win',
    });
    const shortlist = await draftPressKit({ milestoneId: award.id });
    await recordAwardOutcome({
      milestoneId: award.id,
      outcome: 'won',
      actor: 'Press Reviewer',
    });

    await assert.rejects(
      () =>
        approvePrMaterial({
          materialId: shortlist.materials[0].id,
          reviewer: 'Press Reviewer',
        }),
      /superseded/,
    );
  });
});

describe('the system asks instead of guessing', () => {
  it('lists a past award that is still shortlisted as awaiting an outcome', async () => {
    const past = await createAward({
      daysAhead: -8,
      title: 'Ceremony last week, result unknown',
    });
    const future = await createAward({
      daysAhead: 20,
      title: 'Ceremony still ahead',
    });

    const awaiting = await findAwardsAwaitingOutcome({ authorId });
    const ids = awaiting.map((m) => Number(m.id));

    assert.ok(ids.includes(Number(past.id)), 'a past shortlisting is waiting on a result');
    assert.ok(!ids.includes(Number(future.id)), 'a future shortlisting is not yet a result to record');
  });

  it('drops an award from the waiting list once a result is recorded', async () => {
    const award = await createAward({
      daysAhead: -9,
      title: 'Waiting, then resolved',
    });
    await recordAwardOutcome({ milestoneId: award.id, outcome: 'won', actor: 'Press Reviewer' });

    const awaiting = await findAwardsAwaitingOutcome({ authorId });
    assert.ok(!awaiting.map((m) => Number(m.id)).includes(Number(award.id)));
  });
});

describe('TBI: recording an outcome is on the record', () => {
  it('logs the recorded outcome, any withdrawn kit, and the resulting draft', async () => {
    const log = await listAuditLog({ authorId, limit: 300 });
    const actions = log.map((entry) => entry.action);

    assert.ok(actions.includes('award.outcome_recorded'));
    assert.ok(actions.includes('pr_kit.superseded'));
    assert.ok(actions.includes('pr_kit.drafted'));
    assert.ok(actions.includes('award.no_material'));
  });

  it('attributes the withdrawn kit to the agent, the recorded result to the person', async () => {
    const log = await listAuditLog({ authorId, limit: 300 });
    const recorded = log.find((entry) => entry.action === 'award.outcome_recorded');
    const superseded = log.find((entry) => entry.action === 'pr_kit.superseded');

    assert.equal(recorded.actor, 'Press Reviewer');
    assert.equal(superseded.actor, 'PROutreachAgent');
    assert.equal(recorded.metadata.to, 'won');
  });
});
