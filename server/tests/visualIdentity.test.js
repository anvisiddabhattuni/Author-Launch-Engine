/**
 * STORY-068 acceptance tests.
 *
 * The story's three Gherkin clauses are the first three `describe` blocks: a
 * guide that exists and is applied, off-identity output caught before queueing,
 * and a guide a human can revise with the change versioned.
 *
 * The finding behind the story is in the fourth block. STORY-067 shipped eight
 * licensed templates carrying five different accent colours, one of them light
 * while the rest are dark — every template legal and reusable, and together a
 * feed rather than a book. The library is the fixture.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { REASONS, assess } from '../src/services/escalationPolicy.js';
import { listTemplates, selectTemplate, themedArtwork } from '../src/services/memeLibrary.js';
import {
  ACTOR as IDENTITY_ACTOR,
  IDENTITY_FINDINGS,
  accentColours,
  colourDistance,
  colourfulness,
  deriveIdentity,
  getActiveIdentity,
  listVersions,
  luminance,
  saveIdentity,
  scoreIdentity,
} from '../src/services/visualIdentity.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];
const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it.',
  'Resilience is what remains when motivation has gone home for the evening.',
].join('\n\n');

const VOICE = {
  tone: ['plain', 'unsentimental'],
  avoid: ['exclamation marks', 'growth-hacking language'],
};

let authorId;
let bookId;

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    ['Identity Test Author', `identity-${Date.now()}@example.test`, JSON.stringify(VOICE)],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES, '2023-04-01'],
  );
  bookId = b[0].id;
  await query(
    `INSERT INTO social_history (author_id, platform, content, posted_at)
     VALUES ($1,'twitter','Attention is a muscle and mine was weak today.', now()),
            ($1,'twitter','Craft is the slow accumulation of decisions nobody claps for.', now()),
            ($1,'twitter','The desk at 6am, just practice.', now())`,
    [authorId],
  );
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-068: a visual identity exists and is applied', () => {
  let batch;

  before(async () => {
    batch = await draftWeeklyPosts({ authorId, bookId, count: 2 });
  });

  it('derives a guide on first use rather than requiring onboarding to have run', async () => {
    const active = await getActiveIdentity({ bookId });
    assert.ok(active, 'a guide exists');
    assert.equal(active.version, 1);
    assert.equal(active.createdBy, 'system');
  });

  it('records palette, typography, tone words and do-not-use rules', async () => {
    const g = await getActiveIdentity({ bookId });
    for (const key of ['ground', 'ink', 'accent', 'mode']) {
      assert.ok(g.palette[key], `palette records ${key}`);
    }
    assert.ok(g.typography.family, 'typography names a family');
    assert.ok(g.toneWords.length > 0, 'and the identity has tone words');
    assert.ok(g.doNotUse.length > 0, 'and rules with teeth');
  });

  it('says an inferred palette is inferred', async () => {
    // No cover art was supplied, so the palette is a guess. A guide that
    // presented it with the confidence of an observation would be the failure
    // STORY-009 found in the hand-written voice profile.
    const g = await getActiveIdentity({ bookId });
    assert.equal(g.derivedFrom.coverArt, false);
    assert.match(g.derivedFrom.confidence, /inferred/);
  });

  it('inherits what the author already said they avoid', async () => {
    const g = await getActiveIdentity({ bookId });
    assert.ok(
      g.doNotUse.includes('exclamation marks'),
      'the verbal identity and the visual one should not contradict each other',
    );
  });

  it('every generated meme references the guide', () => {
    const memes = batch.filter((d) => d.format === 'meme');
    assert.ok(memes.length > 0);
    for (const meme of memes) {
      assert.equal(meme.identity_version, 1, 'and says which version it was judged against');
      assert.ok(Number(meme.identity_score) > 0);
    }
  });

  it('logs the derivation against the agent that made it', async () => {
    const { rows } = await query(
      `SELECT actor, metadata FROM audit_log
        WHERE author_id = $1 AND action = 'visual_identity.derived'`,
      [authorId],
    );
    assert.equal(rows[0].actor, IDENTITY_ACTOR);
    assert.equal(rows[0].metadata.version, 1);
  });
});

describe('STORY-068: off-identity output is caught', () => {
  let guide;

  before(async () => {
    guide = await getActiveIdentity({ bookId });
  });

  it('catches a light picture in a dark identity', async () => {
    const light = (await listTemplates()).find((t) => t.key === 'margin-note');
    const result = scoreIdentity({ imageRef: light.imageRef, caption: 'Attention.', identity: guide });
    assert.ok(result.findings.includes(IDENTITY_FINDINGS.WRONG_MODE));
    assert.ok(result.score < config.minIdentityMatch, `scored ${result.score}`);
  });

  it('catches an accent the identity does not use', async () => {
    const purple = (await listTemplates()).find((t) => t.key === 'three-beat');
    const result = scoreIdentity({ imageRef: purple.imageRef, caption: 'Attention.', identity: guide });
    assert.ok(result.findings.includes(IDENTITY_FINDINGS.OFF_PALETTE));
    assert.ok(result.score < config.minIdentityMatch);
  });

  it('catches a caption breaking a written rule', async () => {
    const onBrand = (await listTemplates()).find((t) => t.key === 'two-panel-contrast');
    const result = scoreIdentity({
      imageRef: onBrand.imageRef,
      caption: 'Attention is a muscle!',
      identity: guide,
    });
    assert.ok(result.findings.includes(IDENTITY_FINDINGS.FORBIDDEN_TERM));
  });

  it('passes a template that is actually on identity', async () => {
    const onBrand = (await listTemplates()).find((t) => t.key === 'two-panel-contrast');
    const result = scoreIdentity({
      imageRef: onBrand.imageRef,
      caption: 'Attention is a muscle.',
      identity: guide,
    });
    assert.equal(result.score, 1);
    assert.deepEqual(result.findings, []);
  });

  it('routes a drifting meme to a human rather than the publish queue', () => {
    const { status, reasons } = assess({
      confidence: 0.95,
      themeAlignment: 1,
      voice: 0.9,
      identity: 0.7,
    });
    assert.equal(status, 'escalated');
    assert.deepEqual(reasons, [REASONS.IDENTITY]);
  });

  it('is a judgement the author may overrule, unlike image rights', () => {
    // Identity escalates. Rights refuse at publication even after approval
    // (STORY-066). The author is the authority on what their book looks like;
    // they are not the authority on whether we hold a licence.
    assert.ok(Object.values(REASONS).includes('visual_identity'));
    assert.ok(!Object.values(REASONS).includes('image_rights'));
  });

  it('prefers an on-identity template rather than making a human fix its choice', async () => {
    const { template } = await selectTemplate({ authorId, seed: 4, identity: guide });
    // Judged as it will be drawn: meme formats are coloured per book.
    const scored = scoreIdentity({ imageRef: themedArtwork(template.imageRef, guide), identity: guide });
    assert.equal(scored.score, 1, `${template.key} was chosen off-identity`);
  });
});

describe('STORY-068: the guide is revisable by a human', () => {
  it('writes a new version rather than editing in place', async () => {
    const before_ = await getActiveIdentity({ bookId });
    const saved = await saveIdentity({
      authorId,
      bookId,
      guide: {
        palette: { ...before_.palette, accent: '#5fbf95' },
        typography: before_.typography,
        tone_words: before_.toneWords,
        do_not_use: before_.doNotUse,
        derived_from: { ...before_.derivedFrom, confidence: 'set by the author' },
      },
      createdBy: 'Anvi Siddabhattuni',
      note: 'the cover is green; blue was a guess',
    });

    assert.equal(saved.version, before_.version + 1);
    assert.equal(saved.active, true);

    const versions = await listVersions({ bookId });
    assert.equal(versions.filter((v) => v.active).length, 1, 'exactly one active version');
    assert.equal(versions.find((v) => v.version === before_.version).active, false);
  });

  it('generates later memes against the new version', async () => {
    const batch = await draftWeeklyPosts({ authorId, bookId, count: 1, weekOf: '2025-07-07' });
    const meme = batch.find((d) => d.format === 'meme');
    assert.equal(meme.identity_version, 2, 'judged against the revision');

    const active = await getActiveIdentity({ bookId });
    const scored = scoreIdentity({ imageRef: meme.media.imageRef, identity: active });
    assert.equal(scored.score, 1, 'and composed from a template that fits the new accent');
  });

  it('leaves memes drafted under the old version pointing at it', async () => {
    const { rows } = await query(
      `SELECT DISTINCT identity_version FROM drafts
        WHERE author_id = $1 AND format = 'meme' ORDER BY identity_version`,
      [authorId],
    );
    assert.deepEqual(
      rows.map((r) => r.identity_version),
      [1, 2],
      'a revision applies to later memes and does not reinterpret earlier ones',
    );
  });

  it('records who revised it and why', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'visual_identity.revised' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.equal(rows[0].metadata.createdBy, 'Anvi Siddabhattuni');
    assert.equal(rows[0].metadata.note, 'the cover is green; blue was a guess');
    assert.equal(rows[0].metadata.supersedes, 1);
  });

  it('refuses to hold two active versions, in the database', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO visual_identity (author_id, book_id, version, palette)
           VALUES ($1,$2,99,'{"accent":"#000000"}'::jsonb)`,
          [authorId, bookId],
        ),
      /visual_identity_one_active/,
      '"the rules in force" must have exactly one answer',
    );
  });
});

describe('The library STORY-067 shipped, measured', () => {
  it('finds an accent however small it is drawn', async () => {
    // The first version of this check looked only at large filled rectangles
    // and caught almost nothing: a template's accent is usually a hairline
    // rule, a stroke or a line. Size is not what makes a colour deliberate.
    const purple = (await listTemplates()).find((t) => t.key === 'three-beat');
    const accents = accentColours(purple.imageRef, '#101014');
    assert.ok(accents.includes('#a78bfa'), 'a 6px rule is still the brand colour');
  });

  it('does not mistake a near-black field for an accent', () => {
    assert.ok(colourfulness('#161b22') < 40, 'a dark neutral is a ground, not a choice');
    assert.ok(colourfulness('#a78bfa') >= 40, 'a purple is a choice');
  });

  it('reads mode from the largest field', () => {
    assert.ok(luminance('#f4f1e8') > 140, 'cream is light');
    assert.ok(luminance('#0d1117') < 140, 'near-black is dark');
  });

  it('shows the library is not yet one identity', async () => {
    const guide = await getActiveIdentity({ bookId });
    const templates = (await listTemplates()).filter((t) => t.licence?.commercial === true);
    const scored = templates.map((t) => ({
      key: t.key,
      score: scoreIdentity({ imageRef: t.imageRef, identity: guide }).score,
    }));
    const off = scored.filter((s) => s.score < config.minIdentityMatch);
    assert.ok(
      off.length > 0,
      'eight licensed templates in five accent colours is a feed, not a book',
    );
    assert.ok(scored.some((s) => s.score === 1), 'and some of them do fit');
  });

  it('measures distance in a way an author could check by eye', () => {
    assert.equal(colourDistance('#000000', '#000000'), 0);
    assert.ok(colourDistance('#4a9eff', '#5fbf95') > 60, 'blue and green are different colours');
    assert.ok(colourDistance('#4a9eff', '#4a9dfe') < 5, 'and a rounding error is not');
  });
});
