/**
 * STORY-067 acceptance tests.
 *
 * The story's three Gherkin clauses are the first three `describe` blocks: at
 * least eight templates with named caption slots and recorded provenance, a
 * template lacking rights rejected *and the attempt logged*, and the same human
 * approval gate as text.
 *
 * The logging half of the second clause is the one that matters. STORY-066
 * filtered unlicensed templates out with a helper that returned an array and
 * said nothing — the same silence STORY-010 found in the opportunity scanner,
 * where the half of a filter nobody can check is the half it hides.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { approveDraft } from '../src/services/approvals.js';
import {
  ACTOR as LIBRARY_ACTOR,
  REJECTIONS,
  addTemplate,
  assessTemplate,
  composeFromTemplate,
  getTemplate,
  listTemplates,
  retireTemplate,
  selectTemplate,
} from '../src/services/memeLibrary.js';
import { scheduleDraft } from '../src/services/scheduler.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];
const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it.',
  'Resilience is what remains when motivation has gone home for the evening.',
].join('\n\n');

const ART = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#111"/></svg>',
  'utf8',
).toString('base64')}`;

const draftTemplate = (key, licence) => ({
  key,
  name: `Fixture ${key}`,
  layout: 'single',
  caption_slots: [{ name: 'statement', role: 'one line', maxChars: 80, x: 200, y: 150, size: 30, anchor: 'middle', wrap: 20 }],
  image_ref: ART,
  source: 'Fixture, drawn for the test',
  licence,
});

const HOUSE = { holder: 'Test House', terms: 'cc0', commercial: true, attribution: null };

let authorId;
let bookId;
/** Keys this suite created, so cleanup never touches the seeded library. */
const created = [];

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    ['Library Test Author', `library-${Date.now()}@example.test`, JSON.stringify({ tone: ['plain'] })],
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
  if (created.length > 0) {
    // Retired, not deleted — which is the rule this very story argues for.
    // These fixtures carry real licences, so the generator can and does pick
    // them; deleting one while another suite is mid-draft violates the
    // drafts.meme_template_id foreign key. `db:reset` clears them between runs.
    await query(
      `UPDATE meme_templates
          SET active = FALSE, retired_at = COALESCE(retired_at, now()),
              retired_reason = 'test fixture'
        WHERE key = ANY($1) AND active`,
      [created],
    );
  }
  await closePool();
});

describe('STORY-067: templates are seeded and reusable', () => {
  let templates;

  before(async () => {
    templates = await listTemplates();
  });

  it('seeds at least eight usable templates', () => {
    const usable = templates.filter((t) => assessTemplate(t).usable);
    assert.ok(usable.length >= 8, `only ${usable.length} usable templates in the library`);
  });

  it('gives every template named caption slots', () => {
    for (const t of templates) {
      assert.ok(Array.isArray(t.captionSlots) && t.captionSlots.length > 0, `${t.key} has slots`);
      for (const slot of t.captionSlots) {
        assert.ok(slot.name, 'each slot is named');
        assert.ok(slot.role, `${t.key}.${slot.name} says what it is for`);
        assert.ok(Number(slot.maxChars) > 0, `${t.key}.${slot.name} has a limit`);
      }
    }
  });

  it('records an image source for every template', () => {
    for (const t of templates) {
      assert.ok(t.source.length > 0, `${t.key} records where the image came from`);
      assert.ok(t.imageRef.startsWith('data:image/svg+xml'), `${t.key} carries real artwork`);
    }
  });

  it('records a licence for every template it is willing to use', () => {
    for (const t of templates.filter((x) => assessTemplate(x).usable)) {
      assert.ok(t.licence, `${t.key} has a licence`);
      assert.ok(t.licence.holder, 'and a holder');
      assert.ok(t.licence.terms, 'and terms');
    }
  });

  it('is reusable: the same template composes different captions', async () => {
    const template = await getTemplate('single-statement');
    const one = composeFromTemplate({ template, captions: { statement: 'Attention is a muscle.' } });
    const two = composeFromTemplate({ template, captions: { statement: 'Craft is slow.' } });
    assert.notEqual(one, two, 'the caption changes the image');
    const svg = Buffer.from(two.split(',')[1], 'base64').toString('utf8');
    assert.ok(svg.includes('Craft is slow.'), 'and the caption is laid into the artwork');
  });

  it('lays a caption into the slot it was drawn for', async () => {
    const template = await getTemplate('two-panel-contrast');
    const uri = composeFromTemplate({
      template,
      captions: { setup: 'SETUP TEXT', turn: 'TURN TEXT' },
    });
    const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    const setupY = Number(svg.match(/y="(\d+)"[^>]*>SETUP TEXT/)[1]);
    const turnY = Number(svg.match(/y="(\d+)"[^>]*>TURN TEXT/)[1]);
    assert.ok(setupY < turnY, 'the setup sits in the upper panel and the turn below it');
  });
});

describe('STORY-067: only licensed templates can be used', () => {
  it('never offers a template with no licence recorded', async () => {
    const unlicensed = await getTemplate('community-remix');
    const verdict = assessTemplate(unlicensed);
    assert.equal(verdict.usable, false);
    assert.equal(verdict.reason, REJECTIONS.NO_LICENCE);
  });

  it('never offers a template whose licence forbids the use', async () => {
    const editorial = await getTemplate('stock-photo-overlay');
    const verdict = assessTemplate(editorial);
    assert.equal(verdict.usable, false);
    assert.equal(verdict.reason, REJECTIONS.LICENCE_FORBIDS);
  });

  it('logs every rejection individually, not as a count', async () => {
    const { template, rejected } = await selectTemplate({ authorId, seed: 1 });
    assert.ok(template, 'it still chose something usable');
    assert.ok(rejected.length >= 2, 'and refused the two it may not use');

    const { rows } = await query(
      `SELECT entity_id, metadata FROM audit_log
        WHERE author_id = $1 AND action = 'meme_template.rejected'`,
      [authorId],
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.entity_id, r.metadata]));
    assert.equal(byKey['community-remix'].reason, REJECTIONS.NO_LICENCE);
    assert.equal(byKey['stock-photo-overlay'].reason, REJECTIONS.LICENCE_FORBIDS);
    assert.ok(byKey['community-remix'].detail.length > 0, 'in words a person can read');
  });

  it('records which template it chose, and what it was licensed under', async () => {
    await selectTemplate({ authorId, seed: 2 });
    const { rows } = await query(
      `SELECT entity_id, actor, metadata FROM audit_log
        WHERE author_id = $1 AND action = 'meme_template.selected' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.equal(rows[0].actor, LIBRARY_ACTOR);
    assert.ok(rows[0].metadata.licence?.commercial === true);
    assert.ok(rows[0].metadata.rejected >= 2, 'and how many it passed over getting there');
  });

  it('an unlicensed template can never reach a draft', async () => {
    const batch = await draftWeeklyPosts({ authorId, bookId, count: 2, weekOf: '2025-04-07' });
    for (const meme of batch.filter((d) => d.format === 'meme')) {
      const used = await getTemplate(meme.media.template);
      assert.equal(assessTemplate(used).usable, true, `${used.key} was licensed`);
      assert.equal(meme.image_rights, 'cleared');
    }
  });

  it('refuses to add a template nobody can licence', async () => {
    await assert.rejects(
      () => addTemplate(draftTemplate('fixture-unlicensed', null)),
      /Record the image source and licence first/,
    );
    assert.equal(await getTemplate('fixture-unlicensed'), null, 'and it is not in the library');
  });

  it('chooses nothing rather than something unlicensed when nothing is licensed', async () => {
    // A layout only the unusable templates offer.
    const { template, rejected } = await selectTemplate({ authorId, seed: 0, layout: 'nonexistent' });
    assert.equal(template, null);
    assert.deepEqual(rejected, [], 'nothing was even reached for');
  });
});

describe('STORY-067: human approval still applies', () => {
  it('holds a template-composed meme behind the same gate as text', async () => {
    const batch = await draftWeeklyPosts({ authorId, bookId, count: 1, weekOf: '2025-05-05' });
    const meme = batch.find((d) => d.format === 'meme');
    assert.ok(meme, 'a meme was composed from the library');
    assert.ok(['pending_approval', 'escalated'].includes(meme.status));

    await assert.rejects(() => scheduleDraft({ draftId: meme.id }), /not "approved"/);
    await approveDraft({ draftId: meme.id, reviewer: 'Library Reviewer' });
    const scheduled = await scheduleDraft({ draftId: meme.id });
    assert.ok(scheduled.scheduled_for);
  });

  it('links the draft to the template row it came from', async () => {
    const { rows } = await query(
      `SELECT d.meme_template_id, t.key FROM drafts d
         JOIN meme_templates t ON t.id = d.meme_template_id
        WHERE d.author_id = $1 AND d.format = 'meme' LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0], 'which drafts used a template is answerable');
    assert.ok(rows[0].key.length > 0);
  });
});

describe('Adding and retiring, without stranding what already shipped', () => {
  it('adds a licensed template and logs it', async () => {
    created.push('fixture-added');
    const added = await addTemplate(draftTemplate('fixture-added', HOUSE), {
      user: { name: 'Anvi' },
    });
    assert.equal(added.key, 'fixture-added');
    assert.equal(added.active, true);

    const { rows } = await query(
      `SELECT metadata FROM audit_log WHERE action = 'meme_template.added' AND entity_id = $1`,
      ['fixture-added'],
    );
    assert.deepEqual(rows[0].metadata.slots, ['statement']);
    assert.equal(rows[0].metadata.addedBy, 'Anvi');
  });

  it('retires a template instead of deleting it', async () => {
    created.push('fixture-retire');
    await addTemplate(draftTemplate('fixture-retire', HOUSE));
    const retired = await retireTemplate({
      key: 'fixture-retire',
      reason: 'the joke stopped landing',
      user: { name: 'Anvi' },
    });
    assert.equal(retired.active, false);
    assert.ok(retired.retiredAt, 'and says when');
    assert.equal(retired.retiredReason, 'the joke stopped landing');

    // Still present, so a meme drafted from it keeps its provenance.
    assert.ok(await getTemplate('fixture-retire'), 'the row survives');
  });

  it('stops offering a retired template to the generator', async () => {
    const retired = await getTemplate('fixture-retire');
    const verdict = assessTemplate(retired);
    assert.equal(verdict.usable, false);
    assert.equal(verdict.reason, REJECTIONS.RETIRED);
  });

  it('will not retire the same template twice', async () => {
    await assert.rejects(
      () => retireTemplate({ key: 'fixture-retire' }),
      /No active template/,
    );
  });

  it('logs the retirement with its reason', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log WHERE action = 'meme_template.retired' AND entity_id = $1`,
      ['fixture-retire'],
    );
    assert.equal(rows[0].metadata.reason, 'the joke stopped landing');
    assert.equal(rows[0].metadata.retiredBy, 'Anvi');
  });
});
