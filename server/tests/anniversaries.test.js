/**
 * STORY-004 acceptance tests.
 *
 * The story's one Gherkin scenario — "Given a book anniversary is approaching,
 * When the PR and Outreach Agent drafts a PR material, Then the draft is aligned
 * with the book's themes and held for human review" — is the first `describe`
 * block. The rest cover what the scenario leaves implicit: that "approaching"
 * has an edge, that an anniversary knows which one it is, and that drafting on
 * detection does not quietly bypass the approval gate.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftPressKit } from '../src/agents/prMaterialsAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { anniversaryYears, findApproachingMilestones } from '../src/services/milestones.js';
import { draftApproachingKits } from '../src/services/milestoneWatcher.js';
import { distributePressKit } from '../src/services/prDistributor.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

let authorId;
let bookId;
let publishedOn;

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** Same calendar day, N years earlier — day arithmetic drifts across leap years. */
function minusYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y - years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function createMilestone(type, daysAhead, title) {
  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, location, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [authorId, bookId, type, title, isoIn(daysAhead), '', 'Details for the record.'],
  );
  return rows[0];
}

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Anniversary Test Author',
      `anniversary-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain', 'unsentimental'] }),
    ],
  );
  authorId = authorRows[0].id;

  // The anniversary under test falls 10 days out, and the book was published
  // exactly three years before that day, so this is unambiguously the third.
  publishedOn = minusYears(isoIn(10), 3);

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
      publishedOn,
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

describe('STORY-004: PR draft creation for book anniversary', () => {
  let result;
  let materials;

  before(async () => {
    await createMilestone('anniversary', 10, 'The Quiet Craft — three years in print');
    result = await draftApproachingKits({ authorId });
    materials = result.drafted[0]?.materials ?? [];
  });

  it('Given an approaching anniversary, the agent drafts without being asked', async () => {
    assert.equal(result.drafted.length, 1, 'the approaching anniversary should have been drafted');
    assert.equal(result.drafted[0].milestone.type, 'anniversary');
    assert.equal(materials.length, 3, 'a kit is a release, a bio and a fact sheet');
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

  it('refuses to distribute a kit the watcher drafted', async () => {
    await assert.rejects(
      () => distributePressKit({ kitId: result.drafted[0].kit.id }),
      /not approved/,
      'drafting on detection must not imply approval',
    );
  });
});

describe('which anniversary it is', () => {
  it('counts full years from publication', () => {
    assert.equal(anniversaryYears({ publishedOn: '2020-06-15', eventDate: '2023-06-15' }), 3);
    assert.equal(anniversaryYears({ publishedOn: '2020-06-15', eventDate: '2021-06-15' }), 1);
    assert.equal(anniversaryYears({ publishedOn: '2020-02-29', eventDate: '2024-02-29' }), 4);
  });

  it('does not round a day early up to the next year', () => {
    assert.equal(anniversaryYears({ publishedOn: '2020-06-15', eventDate: '2023-06-14' }), 2);
  });

  it('returns null when it cannot be known', () => {
    assert.equal(anniversaryYears({ publishedOn: null, eventDate: '2023-06-15' }), null);
    assert.equal(anniversaryYears({ publishedOn: '2020-06-15', eventDate: null }), null);
    // Same year as publication is not an anniversary at all.
    assert.equal(anniversaryYears({ publishedOn: '2020-06-15', eventDate: '2020-11-01' }), null);
  });

  it('says the right anniversary in the copy instead of assuming the first', async () => {
    const milestone = await createMilestone(
      'anniversary',
      400,
      'The Quiet Craft — a later anniversary',
    );
    // 400 days out, published 4 years before that day, so this one is the fourth.
    await query('UPDATE books SET published_on = $1 WHERE id = $2', [
      minusYears(isoIn(400), 4),
      bookId,
    ]);

    const { materials, anniversaryYears: years } = await draftPressKit({
      milestoneId: milestone.id,
    });
    const release = materials.find((m) => m.type === 'press_release');
    const factSheet = materials.find((m) => m.type === 'fact_sheet');

    assert.equal(years, 4);
    assert.match(release.headline, /four years in print/i);
    assert.match(release.body, /fourth anniversary/i);
    assert.doesNotMatch(release.body, /first anniversary/i);
    assert.match(factSheet.body, /ANNIVERSARY — fourth/);

    await query('UPDATE books SET published_on = $1 WHERE id = $2', [publishedOn, bookId]);
  });
});

describe('the lead-time window has an edge', () => {
  it('excludes a milestone beyond the window and includes one inside it', async () => {
    const inside = await createMilestone('award', 5, 'Award inside the window');
    const outside = await createMilestone(
      'award',
      config.milestoneLeadTimeDays + 15,
      'Award beyond the window',
    );

    const approaching = await findApproachingMilestones({ authorId });
    const ids = approaching.map((m) => Number(m.id));

    assert.ok(ids.includes(Number(inside.id)), 'a milestone inside the window is approaching');
    assert.ok(!ids.includes(Number(outside.id)), 'a milestone beyond the window is not yet due');
  });

  it('does not treat a milestone that has already passed as approaching', async () => {
    const past = await createMilestone('launch', -3, 'Launch that already happened');
    const approaching = await findApproachingMilestones({ authorId });
    assert.ok(!approaching.map((m) => Number(m.id)).includes(Number(past.id)));
  });

  it('reports days remaining, soonest first', async () => {
    const approaching = await findApproachingMilestones({ authorId });
    const days = approaching.map((m) => Number(m.days_until));
    assert.deepEqual(days, [...days].sort((a, b) => a - b));
    assert.ok(days.every((d) => d >= 0 && d <= config.milestoneLeadTimeDays));
  });
});

describe('running the watcher twice does not duplicate work', () => {
  it('reports an approaching milestone as already drafted the second time', async () => {
    const first = await draftApproachingKits({ authorId });
    const second = await draftApproachingKits({ authorId });

    assert.equal(second.drafted.length, 0, 'nothing should be drafted twice');
    assert.ok(
      second.alreadyDrafted.length >= first.drafted.length,
      'kits from the first pass should be reported as already drafted',
    );
  });

  it('drafts nothing when no milestone is approaching', async () => {
    const { rows: quietAuthor } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Quiet Author', `quiet-${Date.now()}@example.test`],
    );

    const result = await draftApproachingKits({ authorId: quietAuthor[0].id });
    assert.equal(result.approaching.length, 0);
    assert.equal(result.drafted.length, 0);

    await query('DELETE FROM authors WHERE id = $1', [quietAuthor[0].id]);
  });
});

describe('TBI: the detection itself is on the record', () => {
  it('logs the detection, the draft and the scan summary', async () => {
    const log = await listAuditLog({ authorId, limit: 200 });
    const actions = log.map((entry) => entry.action);

    assert.ok(actions.includes('milestone.approaching'), 'detection must be audited');
    assert.ok(actions.includes('pr_kit.drafted'), 'the resulting kit must be audited');
    assert.ok(actions.includes('milestone.scan_completed'), 'the scan itself must be audited');
  });

  it('records why the milestone was picked up', async () => {
    const log = await listAuditLog({ authorId, limit: 200 });
    const detection = log.find((entry) => entry.action === 'milestone.approaching');

    assert.ok(detection.metadata.daysUntil <= detection.metadata.leadTimeDays);
    assert.equal(detection.metadata.leadTimeDays, config.milestoneLeadTimeDays);
    assert.ok(detection.metadata.milestone.length > 0);
  });

  it('attributes the draft to the agent, not to a person', async () => {
    const log = await listAuditLog({ authorId, limit: 200 });
    const detection = log.find((entry) => entry.action === 'milestone.approaching');
    assert.equal(detection.actor, 'PROutreachAgent');
  });
});
