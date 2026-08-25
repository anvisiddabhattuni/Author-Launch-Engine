/**
 * STORY-010 acceptance tests.
 *
 * The story's Gherkin — "Given the PR and Outreach Agent has access to relevant
 * directories; When a search for speaking opportunities is initiated; Then the
 * agent identifies opportunities that align with the book's themes and author's
 * expertise" — is the first `describe` block.
 *
 * The rest cover what STORY-002 could not. It scored a listing against exactly
 * one thing: whether its topics repeated one of the four theme labels on the
 * book being promoted. Nothing modelled the author at all.
 *
 * The Library Author Nights test is the one that matters. "Evening talks where
 * authors discuss their books with local reading groups" scores exactly 0.000
 * against 'deep work, craft, attention, resilience' — an ideal speaking slot
 * for an author, discarded for four stories with no record that it existed.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { scoutOpportunities, qualify } from '../src/agents/opportunityScoutingAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import {
  AUTHOR_FORMATS,
  MIN_SUBJECT_EVIDENCE,
  deriveExpertise,
  scoreExpertise,
} from '../src/services/authorExpertise.js';
import { OPPORTUNITY_TYPES, searchAllDirectories } from '../src/services/directories.js';
import { scoreOpportunity } from '../src/services/keywordAnalysis.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention,',
  'and attention is the only real currency any of us spend. Deep work is not a productivity trick.',
  'Craft is the slow accumulation of decisions nobody claps for. A carpenter planes a joint that',
  'will be hidden inside a cabinet for a hundred years. Resilience is what remains when motivation',
  'has gone home for the evening, and the people who finish things are rarely the most inspired.',
].join(' ');

/** The lead STORY-002 could not see: it wants an author, not a subject. */
const LIBRARY_NIGHTS = {
  source: 'eventFinder',
  externalId: 'evt-004',
  type: 'event',
  name: 'Library Author Nights',
  description: 'Evening talks where authors discuss their books with local reading groups.',
  topics: ['books', 'reading groups', 'author talks'],
};

/** Genuinely off-topic, and off-author too. Must stay rejected. */
const CRYPTO = {
  source: 'eventFinder',
  externalId: 'evt-003',
  type: 'event',
  name: 'Crypto Builders Meetup',
  description: 'Monthly meetup for protocol engineers and token designers.',
  topics: ['blockchain', 'protocols', 'tokens'],
};

let authorId;
let bookId;
let expertise;

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    ['Speaking Test Author', `speaking-${Date.now()}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES, '2023-04-01'],
  );
  bookId = bookRows[0].id;

  for (const content of [
    'Attention is a muscle and mine was weak today. Showed up anyway.',
    'Craft is the slow accumulation of decisions nobody claps for.',
  ]) {
    await query(
      `INSERT INTO social_history (author_id, platform, content, posted_at)
       VALUES ($1,'twitter',$2, now())`,
      [authorId, content],
    );
  }

  const { rows: books } = await query(
    'SELECT title, themes, content FROM books WHERE author_id = $1',
    [authorId],
  );
  const { rows: posts } = await query('SELECT content FROM social_history WHERE author_id = $1', [
    authorId,
  ]);
  expertise = deriveExpertise({ books, posts, trackRecord: [] });
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-010: speaking opportunities aligned with themes and expertise', () => {
  let scan;

  before(async () => {
    scan = await scoutOpportunities({ authorId, bookId, types: ['speaking'] });
  });

  it('searches only the speaking directories when speaking is what was asked for', () => {
    assert.deepEqual(scan.searchedTypes, ['speaking']);
    assert.ok(
      scan.identified.every((o) => o.type === 'speaking'),
      'a podcast is not a speaking engagement',
    );
    assert.ok(scan.identified.length > 0, 'and it still finds some');
  });

  it('identifies opportunities that align with the book themes', () => {
    const onThemes = scan.identified.filter((o) => Number(o.relevance) >= config.relevanceThreshold);
    assert.ok(onThemes.length > 0, 'subject-matched leads still qualify');
  });

  it('scores every lead against the author as well as the book', () => {
    for (const o of scan.identified) {
      assert.ok(o.expertise !== null, `${o.name} carries an expertise score`);
      assert.ok(['themes', 'expertise', 'both'].includes(o.qualified_by));
    }
  });
});

describe('The lead the book themes could not see', () => {
  it('scores Library Author Nights at exactly zero on the book themes', () => {
    const scored = scoreOpportunity({ listing: LIBRARY_NIGHTS, bookThemes: BOOK_THEMES });
    assert.equal(scored.relevance, 0, 'it never repeats a theme label');
    assert.deepEqual(scored.matchedThemes, []);
  });

  it('and above the expertise floor, because it wants an author', () => {
    const scored = scoreExpertise({ listing: LIBRARY_NIGHTS, expertise });
    assert.ok(
      scored.score >= config.expertiseThreshold,
      `expertise scored ${scored.score}, below the ${config.expertiseThreshold} floor`,
    );
    assert.equal(scored.standingFit, 1, 'multiple author-shaped cues');
    assert.ok(scored.matched.includes('author talk'));
  });

  it('reaches a human, labelled with the test it passed', async () => {
    const scan = await scoutOpportunities({ authorId, bookId, types: ['event'] });
    const rescued = scan.identified.find((o) => o.name === LIBRARY_NIGHTS.name);
    assert.ok(rescued, 'the lead is now identified');
    assert.equal(rescued.qualified_by, 'expertise');
    assert.equal(Number(rescued.relevance), 0, 'on zero theme relevance');
  });

  it('does not rescue a listing that is off-topic and off-author both', () => {
    const themes = scoreOpportunity({ listing: CRYPTO, bookThemes: BOOK_THEMES });
    const author = scoreExpertise({ listing: CRYPTO, expertise });
    assert.equal(themes.relevance, 0);
    assert.equal(author.score, 0, 'a protocol meetup wants neither the subject nor the author');
    assert.equal(
      qualify({
        relevance: themes.relevance,
        expertise: author.score,
        relevanceFloor: config.relevanceThreshold,
        expertiseFloor: config.expertiseThreshold,
      }),
      null,
    );
  });

  it('opens no floodgate: every listing rejected before is still rejected unless it wants an author', async () => {
    const listings = await searchAllDirectories({});
    const rescued = listings.filter((listing) => {
      const themes = scoreOpportunity({ listing, bookThemes: BOOK_THEMES });
      const author = scoreExpertise({ listing, expertise });
      return themes.relevance < config.relevanceThreshold
        && author.score >= config.expertiseThreshold;
    });
    assert.deepEqual(
      rescued.map((l) => l.name),
      [LIBRARY_NIGHTS.name],
      'exactly one lead is recovered, and it is the author-shaped one',
    );
  });
});

describe('Expertise is derived, not declared', () => {
  it('reads subjects from every book the author has written', () => {
    assert.equal(expertise.books, 1);
    assert.ok(expertise.enforceable, 'a full book is enough evidence');
    assert.ok(expertise.subjects.has('carpenter'), 'the book text, not only its four labels');
    assert.deepEqual([...expertise.themes].sort(), [...BOOK_THEMES].sort());
  });

  it('treats being a published author as standing in its own right', () => {
    assert.equal(expertise.isPublishedAuthor, true);
    assert.deepEqual(expertise.formats, AUTHOR_FORMATS);
  });

  it('gives an unpublished author no standing to trade on', () => {
    const nobody = deriveExpertise({ books: [], posts: [], trackRecord: [] });
    assert.equal(nobody.isPublishedAuthor, false);
    assert.deepEqual(nobody.formats, []);
    const scored = scoreExpertise({ listing: LIBRARY_NIGHTS, expertise: nobody });
    assert.equal(scored.score, 0);
  });

  it('will not match subjects on evidence too thin to mean anything', () => {
    const thin = deriveExpertise({
      books: [{ title: 'A', themes: ['maps'], content: 'A book about maps.' }],
      posts: [],
    });
    assert.equal(thin.enforceable, false);
    assert.ok(thin.subjectEvidence < MIN_SUBJECT_EVIDENCE);
    const scored = scoreExpertise({ listing: LIBRARY_NIGHTS, expertise: thin });
    assert.equal(scored.subjectFit, 0, 'no subject credit without evidence');
    assert.ok(scored.standingFit > 0, 'but being an author still counts');
  });

  it('counts engagements the author has actually been approved for', () => {
    const withRecord = deriveExpertise({
      books: [{ title: 'T', themes: BOOK_THEMES, content: BOOK_CONTENT }],
      posts: [],
      trackRecord: [{ type: 'podcast', topics: ['craft'] }],
    });
    assert.deepEqual(withRecord.doneTypes, ['podcast']);
    const podcast = { type: 'podcast', topics: ['craft'], description: 'Talking craft.' };
    const scored = scoreExpertise({ listing: podcast, expertise: withRecord });
    assert.ok(scored.score > 0, 'a track record is evidence too');
  });
});

describe('A search can be asked for one kind of engagement', () => {
  it('exposes the types the directories cover', () => {
    assert.deepEqual([...OPPORTUNITY_TYPES].sort(), ['event', 'podcast', 'speaking']);
  });

  it('returns only the listings of the requested type', async () => {
    const speaking = await searchAllDirectories({ types: ['speaking'] });
    assert.ok(speaking.length > 0);
    assert.ok(speaking.every((l) => l.type === 'speaking'));
  });

  it('scans everything when no type is named, as STORY-002 always did', async () => {
    const all = await searchAllDirectories({});
    assert.ok(new Set(all.map((l) => l.type)).size === OPPORTUNITY_TYPES.length);
  });
});

describe('TBI: what the filter hid is on the record', () => {
  let scan;

  before(async () => {
    scan = await scoutOpportunities({ authorId, bookId });
  });

  it('stores every rejected listing rather than counting it', async () => {
    const { rows } = await query(
      'SELECT * FROM opportunity_rejections WHERE author_id = $1 ORDER BY name',
      [authorId],
    );
    assert.ok(rows.length > 0, 'STORY-002 kept only a count');
    assert.equal(rows.length, scan.rejected.length);
    assert.ok(
      rows.some((r) => r.name === CRYPTO.name),
      'the off-topic meetup is visible as a decision, not a silence',
    );
  });

  it('records both floors it failed, so the call can be re-derived later', async () => {
    const { rows } = await query(
      'SELECT * FROM opportunity_rejections WHERE author_id = $1 LIMIT 1',
      [authorId],
    );
    assert.equal(Number(rows[0].relevance_floor), config.relevanceThreshold);
    assert.equal(Number(rows[0].expertise_floor), config.expertiseThreshold);
    assert.ok(rows[0].rationale.includes('expertise:'), 'and why, on both dimensions');
  });

  it('does not re-record the same listing on a second scan', async () => {
    const before = await query('SELECT COUNT(*)::int AS n FROM opportunity_rejections WHERE author_id = $1', [authorId]);
    await scoutOpportunities({ authorId, bookId });
    const after = await query('SELECT COUNT(*)::int AS n FROM opportunity_rejections WHERE author_id = $1', [authorId]);
    assert.equal(after.rows[0].n, before.rows[0].n, 'a re-scan updates the verdict, it does not pile up');
  });

  it('logs how the identified leads qualified, so a dead test is visible', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'opportunity.scan_completed'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    const meta = rows[0].metadata;
    assert.ok(meta.byQualification, 'the scan says how many arrived on each basis');
    assert.equal(meta.expertiseFloor, config.expertiseThreshold);
    assert.deepEqual(meta.searchedTypes, OPPORTUNITY_TYPES);
  });

  it('records the expertise it derived before it judged anything', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'opportunity.expertise_derived'
        ORDER BY id LIMIT 1`,
      [authorId],
    );
    assert.equal(rows[0].metadata.books, 1);
    assert.equal(rows[0].metadata.enforceable, true);
  });
});
