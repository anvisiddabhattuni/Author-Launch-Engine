/**
 * STORY-066 acceptance tests.
 *
 * The story's three Gherkin clauses are the first three `describe` blocks:
 * a meme candidate per batch grounded in the book, the same approval gate text
 * posts have, and a brand-safety and image-rights check that withholds a
 * failing candidate and routes it to a human.
 *
 * The rights tests are the ones that matter. Brand safety is a judgement a
 * reviewer may overrule, so it escalates. Image rights are a fact nobody here
 * can overrule, so an unresolved or refused image is refused at publication
 * *even after a human approves it* — the rule a superseded press kit has
 * followed since STORY-005.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approveDraft } from '../src/services/approvals.js';
import {
  RIGHTS,
  SAFETY_FINDINGS,
  checkBrandSafety,
  checkImageRights,
  reviewMemeCandidate,
} from '../src/services/brandSafety.js';
import { REASONS, assess } from '../src/services/escalationPolicy.js';
import {
  TEMPLATES,
  provenanceFor,
  renderMeme,
  templateById,
  usableTemplates,
} from '../src/services/memeTemplates.js';
import { scheduleDraft } from '../src/services/scheduler.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention, ' +
    'and attention is the only real currency any of us spend.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it. Give it ' +
    'fragments and it becomes good at fragments.',
  'Resilience is what remains when motivation has gone home for the evening. The people who ' +
    'finish things are rarely the most inspired people in the room.',
].join('\n\n');

const KEY_MESSAGES = {
  'deep work': 'Deep work is a refusal of interruption as a default condition.',
  craft: 'Craft is the slow accumulation of decisions nobody claps for.',
  attention: 'Attention is a muscle that adapts to the load you give it.',
  resilience: 'Resilience is what remains when motivation has gone home for the evening.',
};

const mediaFrom = (templateId, altText = 'A caption over a dark field') => ({
  imageRef: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  altText,
  template: templateId,
  provenance: provenanceFor(templateById(templateId)),
});

let authorId;
let bookId;

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    ['Meme Test Author', `meme-${Date.now()}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = a[0].id;

  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES, '2023-04-01'],
  );
  bookId = b[0].id;

  for (const [theme, message] of Object.entries(KEY_MESSAGES)) {
    await query('UPDATE book_themes SET key_message = $3 WHERE book_id = $1 AND theme = $2', [
      bookId,
      theme,
      message,
    ]);
  }
  for (const content of [
    'Attention is a muscle and mine was weak today. Showed up anyway.',
    'Craft is the slow accumulation of decisions nobody claps for.',
    'The desk at 6am. No inspiration in sight, just practice.',
  ]) {
    await query(
      `INSERT INTO social_history (author_id, platform, content, posted_at)
       VALUES ($1,'twitter',$2, now())`,
      [authorId, content],
    );
  }
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-066: meme drafting grounded in the book', () => {
  let batch;

  before(async () => {
    batch = await draftWeeklyPosts({ authorId, bookId, count: 4 });
  });

  it('produces at least one meme candidate per batch', () => {
    const memes = batch.filter((d) => d.format === 'meme');
    assert.ok(
      memes.length >= config.minMemesPerBatch,
      `${memes.length} memes against a floor of ${config.minMemesPerBatch}`,
    );
  });

  it('pairs an image with a caption, as one unit', () => {
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      assert.ok(meme.media?.imageRef?.startsWith('data:image/svg+xml'), 'the image is real');
      assert.ok(meme.content.length > 0, 'and the caption is the draft content');
      assert.ok(meme.media.altText.length > 0, 'with alt text written at generation');
    }
  });

  it('draws the caption from the book themes, not from a theme label', () => {
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      assert.ok(meme.themes_used.length > 0);
      const claims = Object.values(KEY_MESSAGES);
      const carried = claims.some((claim) =>
        claim
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 5)
          .some((word) => meme.content.toLowerCase().includes(word)),
      );
      assert.ok(carried, `caption carries the book's own words: ${meme.content}`);
    }
  });

  it('keeps the panel text out of the caption that gets posted', () => {
    // Joining the panels into the caption with a separator put a literal "|"
    // in the tweet and repeated in the post text the words the picture was
    // already showing. The panels are in the image; the caption sits beside it.
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      assert.ok(!meme.content.includes('|'), `caption carries a separator: ${meme.content}`);
      assert.ok(Array.isArray(meme.media.panels) && meme.media.panels.length > 0);
    }
  });

  it('scores a meme on the caption and the picture together', () => {
    // A meme's argument is laid into the panels, so scoring the caption alone
    // measures half the post — and escalated every good meme when it was.
    const memes = batch.filter((d) => d.format === 'meme');
    for (const meme of memes) {
      assert.ok(
        Number(meme.theme_alignment) >= config.minThemeAlignment,
        `${meme.media.template} aligned ${meme.theme_alignment} on caption "${meme.content}"`,
      );
    }
  });

  it('routes memes to a visual-first platform', async () => {
    const { rows } = await query('SELECT platform FROM platform_windows WHERE visual_first');
    const visual = rows.map((r) => r.platform);
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      assert.ok(visual.includes(meme.platform), `${meme.platform} is visual-first`);
    }
  });

  it('scores a meme the same way a text post is scored', () => {
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      assert.ok(Number(meme.confidence) > 0);
      assert.ok(Number(meme.theme_alignment) >= 0);
      assert.ok(Number(meme.voice_score) >= 0);
    }
  });
});

describe('STORY-066: the same approval gate as text', () => {
  let meme;

  before(async () => {
    const batch = await draftWeeklyPosts({
      authorId,
      bookId,
      count: 1,
      weekOf: '2025-01-06',
    });
    meme = batch.find((d) => d.format === 'meme');
    assert.ok(meme, 'a meme was drafted');
  });

  it('never creates a meme that is already publishable', () => {
    assert.ok(['pending_approval', 'escalated'].includes(meme.status));
  });

  it('refuses to schedule a meme before a human approves it', async () => {
    await assert.rejects(() => scheduleDraft({ draftId: meme.id }), /not "approved"/);
  });

  it('is the same gate, not a copy of it', async () => {
    // The meme goes through `drafts` and `scheduleDraft` — the identical path a
    // text post takes. A separate memes table would have needed its own gate,
    // and a second gate is a gate with a hole in it.
    const { rows } = await query('SELECT format FROM drafts WHERE id = $1', [meme.id]);
    assert.equal(rows[0].format, 'meme');
    await approveDraft({ draftId: meme.id, reviewer: 'Meme Reviewer' });
    const scheduled = await scheduleDraft({ draftId: meme.id });
    assert.ok(scheduled.scheduled_for, 'and once approved it schedules like anything else');
  });
});

describe('STORY-066: brand-safety and image-rights checks', () => {
  it('clears a template whose licence permits commercial use', () => {
    const result = checkImageRights({ media: mediaFrom('tmpl-single-caption') });
    assert.equal(result.rights, RIGHTS.CLEARED);
  });

  it('refuses an editorial-only licence outright', () => {
    const result = checkImageRights({ media: mediaFrom('tmpl-stock-photo') });
    assert.equal(result.rights, RIGHTS.REFUSED);
    assert.match(result.reason, /does not permit commercial use/);
  });

  it('leaves an image with no licence unresolved rather than assuming one', () => {
    const result = checkImageRights({ media: mediaFrom('tmpl-community-remix') });
    assert.equal(result.rights, RIGHTS.UNRESOLVED);
  });

  it('leaves an image with no provenance at all unresolved', () => {
    const result = checkImageRights({ media: { imageRef: 'x', altText: 'y' } });
    assert.equal(result.rights, RIGHTS.UNRESOLVED);
    assert.match(result.reason, /no provenance/);
  });

  it('will not clear a cc-by licence that names nobody to attribute', () => {
    const media = mediaFrom('tmpl-quote-card');
    media.provenance.licence = { ...media.provenance.licence, attribution: null };
    assert.equal(checkImageRights({ media }).rights, RIGHTS.UNRESOLVED);
  });

  it('flags a caption in a register the author would not use', () => {
    const { findings } = checkBrandSafety({
      caption: 'This one weird trick is a guaranteed cure. Only idiots miss it.',
      media: mediaFrom('tmpl-single-caption'),
    });
    assert.ok(findings.includes(SAFETY_FINDINGS.UNSAFE_REGISTER));
  });

  it('flags an image nobody can describe', () => {
    const { findings } = checkBrandSafety({
      caption: 'Attention is a muscle.',
      media: mediaFrom('tmpl-single-caption', ''),
    });
    assert.ok(findings.includes(SAFETY_FINDINGS.NO_ALT_TEXT));
  });

  it('passes a grounded caption on a licensed template with no findings', () => {
    const review = reviewMemeCandidate({
      caption: 'Attention is a muscle that adapts to the load you give it.',
      media: mediaFrom('tmpl-single-caption'),
      maxChars: 280,
    });
    assert.deepEqual(review.findings, []);
    assert.equal(review.rights, RIGHTS.CLEARED);
    assert.equal(review.publishable, true);
  });
});

describe('A judgement escalates; a licence refuses', () => {
  it('escalates a brand-safety finding, because a person may overrule it', () => {
    const { status, reasons } = assess({
      confidence: 0.95,
      themeAlignment: 1,
      voice: 0.9,
      safetyFindings: [SAFETY_FINDINGS.UNSAFE_REGISTER],
    });
    assert.equal(status, 'escalated');
    assert.deepEqual(reasons, [REASONS.BRAND_SAFETY]);
  });

  it('keeps image rights out of the escalation policy on purpose', () => {
    // Rights are not a threshold anyone can tune, and not a reason a reviewer
    // can clear. They are enforced at publication instead.
    const { status } = assess({ confidence: 0.95, themeAlignment: 1, voice: 0.9 });
    assert.equal(status, 'pending_approval');
    assert.ok(!Object.values(REASONS).includes('image_rights'));
  });

  it('refuses to schedule an uncleared image even after a human approves it', async () => {
    const batch = await draftWeeklyPosts({ authorId, bookId, count: 1, weekOf: '2025-02-03' });
    const meme = batch.find((d) => d.format === 'meme');
    assert.ok(meme);

    await query("UPDATE drafts SET image_rights = 'unresolved' WHERE id = $1", [meme.id]);
    await approveDraft({ draftId: meme.id, reviewer: 'Meme Reviewer' });

    await assert.rejects(
      () => scheduleDraft({ draftId: meme.id }),
      /image rights are "unresolved".*Approval does not grant a licence/s,
    );

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [meme.id]);
    assert.equal(rows[0].status, 'approved', 'the human decision stands; it just is not enough');
  });

  it('refuses a licence that is known and forbids the use', async () => {
    const batch = await draftWeeklyPosts({ authorId, bookId, count: 1, weekOf: '2025-03-03' });
    const meme = batch.find((d) => d.format === 'meme');
    await query("UPDATE drafts SET image_rights = 'refused' WHERE id = $1", [meme.id]);
    await approveDraft({ draftId: meme.id, reviewer: 'Meme Reviewer' });
    await assert.rejects(() => scheduleDraft({ draftId: meme.id }), /image rights are "refused"/);
  });
});

describe('The template library and its images', () => {
  it('offers only commercially licensed templates to the drafter', () => {
    const usable = usableTemplates();
    assert.ok(usable.length > 0);
    assert.ok(usable.every((t) => t.licence?.commercial === true));
    assert.ok(!usable.some((t) => t.id === 'tmpl-stock-photo'), 'editorial-only is not offered');
    assert.ok(!usable.some((t) => t.id === 'tmpl-community-remix'), 'unlicensed is not offered');
  });

  it('shrinks the type to fit rather than dropping lines', () => {
    // Silent truncation was the first thing the rendered preview exposed: a
    // long panel simply stopped mid-sentence and nothing said so.
    const long =
      'Resilience is what remains when motivation has gone home for the evening, and the ' +
      'people who finish things are the ones who showed up on the unremarkable Tuesday.';
    const uri = renderMeme({
      template: templateById('tmpl-two-panel'),
      caption: 'On resilience.',
      panels: ['What everyone thinks resilience is', long],
      bookTitle: 'The Quiet Craft',
    });
    const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    const lastWord = long.split(' ').pop().replace('.', '');
    assert.ok(svg.includes(lastWord), 'the end of the sentence is in the picture');
  });

  it('renders the same bytes for the same inputs', () => {
    const args = { template: TEMPLATES[0], caption: 'a | b', bookTitle: 'The Quiet Craft' };
    assert.equal(renderMeme(args), renderMeme(args));
  });

  it('escapes caption text into the image rather than injecting it', () => {
    const uri = renderMeme({
      template: TEMPLATES[1],
      caption: '<script>alert(1)</script>',
      bookTitle: 'T',
    });
    const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    assert.ok(!svg.includes('<script>'), 'the tag is escaped, not embedded');
    assert.ok(svg.includes('&lt;script&gt;'));
  });

  it('records provenance at generation, carrying the licence with it', () => {
    const p = provenanceFor(templateById('tmpl-quote-card'));
    assert.equal(p.source, 'template');
    assert.equal(p.templateId, 'tmpl-quote-card');
    assert.equal(p.licence.terms, 'cc-by');
  });
});

describe('TBI: a meme is on the audit log with its provenance', () => {
  it('records the image provenance and the rights verdict', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action LIKE 'draft.%' AND metadata->>'format' = 'meme'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows.length > 0, 'a meme reached the log');
    const meta = rows[0].metadata;
    assert.equal(meta.format, 'meme');
    assert.ok(meta.template, 'which template it used');
    assert.ok(meta.provenance?.licence, 'and the licence that came with it');
    assert.ok(['cleared', 'unresolved', 'refused'].includes(meta.imageRights));
  });
});
