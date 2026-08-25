/**
 * STORY-006 acceptance tests.
 *
 * The story's Gherkin — "Given a PR draft is generated; When the AI Content
 * Generation Agent aligns the draft with the book's themes; Then the draft
 * reflects the book's key messages and themes" — is the first `describe` block.
 *
 * The rest cover what STORY-003 could not: that retrieval happens *before*
 * drafting rather than scoring happening after it, and that naming a theme is
 * no longer the same as arguing it. The name-checking test is the one that
 * matters — that copy scored a perfect 1.00 under the old measure.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ACTOR as CONTENT_AGENT,
  alignToThemes,
  distinctiveTerms,
} from '../src/agents/contentAlignmentAgent.js';
import {
  MATERIAL_TYPES,
  draftPressKit,
  scoreMaterial,
  themeAlignment,
} from '../src/agents/prMaterialsAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { retrieveThemeGrounding } from '../src/services/themeRetrieval.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

/** Paragraph-separated, because a passage is what retrieval returns. */
const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention, ' +
    'and attention is the only real currency any of us spend.',
  'Deep work is not a productivity trick. It is a way of refusing the terms the world offers ' +
    'you by default, and it is almost entirely invisible to everyone but you.',
  'Craft is the slow accumulation of decisions nobody claps for. A carpenter planes a joint ' +
    'that will be hidden inside a cabinet for a hundred years.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it. Give it ' +
    'fragments and it becomes good at fragments.',
  'Resilience is what remains when motivation has gone home for the evening. The people who ' +
    'finish things are rarely the most inspired people in the room.',
].join('\n\n');

const KEY_MESSAGES = {
  'deep work': 'Deep work is a refusal of interruption as a default condition, not a productivity trick.',
  craft: 'Craft is the slow accumulation of decisions nobody claps for.',
  attention: 'Attention is a muscle that adapts to the load you give it.',
  resilience: 'Resilience is what remains when motivation has gone home for the evening.',
};

let authorId;
let bookId;

const createMilestone = async (title, daysAhead = 40) => {
  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, location, details)
     VALUES ($1,$2,'launch',$3,$4,'Ljubljana','First print run of 8,000 copies.') RETURNING *`,
    [authorId, bookId, title, new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10)],
  );
  return rows[0];
};

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Alignment Test Author',
      `alignment-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain', 'unsentimental'] }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES, '2023-04-01'],
  );
  bookId = bookRows[0].id;

  for (const [theme, message] of Object.entries(KEY_MESSAGES)) {
    await query('UPDATE book_themes SET key_message = $3 WHERE book_id = $1 AND theme = $2', [
      bookId,
      theme,
      message,
    ]);
  }
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-006: PR drafts aligned with the book themes', () => {
  let kit;
  let materials;

  before(async () => {
    const milestone = await createMilestone('The Quiet Craft — publication');
    ({ kit, materials } = await draftPressKit({ milestoneId: milestone.id }));
  });

  it('Given a PR draft is generated, it was grounded before it was written', () => {
    assert.equal(kit.grounded_themes, BOOK_THEMES.length, 'every theme should have been retrieved');
    assert.ok(kit.grounded_passages > 0, 'the drafter was handed no passages at all');
  });

  it('When the agent aligns the draft, every theme gets its own verdict', async () => {
    for (const material of materials) {
      const { rows } = await query(
        'SELECT theme FROM pr_material_themes WHERE material_id = $1 ORDER BY id',
        [material.id],
      );
      assert.deepEqual(
        rows.map((r) => r.theme).sort(),
        [...BOOK_THEMES].sort(),
        `${material.type} was not judged against every theme`,
      );
    }
  });

  it('Then the draft reflects the book key messages, not only its theme names', async () => {
    for (const material of materials) {
      const { rows } = await query(
        'SELECT theme, named, message_score FROM pr_material_themes WHERE material_id = $1',
        [material.id],
      );
      const argued = rows.filter((r) => r.named && Number(r.message_score) > 0);
      assert.ok(
        argued.length >= 2,
        `${material.type} carried the argument for only ${argued.length} themes`,
      );
    }
  });

  it('and every material clears the alignment floor', () => {
    for (const material of materials) {
      assert.ok(
        Number(material.theme_alignment) >= config.minThemeAlignment,
        `${material.type} alignment ${material.theme_alignment} is below the floor`,
      );
    }
  });

  it('and the copy carries the book own language, not a paraphrase of the labels', () => {
    const release = materials.find((m) => m.type === 'press_release');
    assert.match(release.body, /slow accumulation of decisions/, 'no key message reached the copy');
  });
});

describe('Retrieval over the book (build step 2)', () => {
  it('grounds each theme in the passages that evidence it', async () => {
    const grounding = await retrieveThemeGrounding({ bookId }, { query });
    assert.equal(grounding.themes.length, BOOK_THEMES.length);
    for (const entry of grounding.themes) {
      assert.ok(entry.passages.length > 0, `${entry.theme} retrieved nothing`);
      assert.ok(
        entry.passages.some((p) => p.content.toLowerCase().includes(entry.theme.split(' ')[0])),
        `${entry.theme} was grounded in passages that never mention it`,
      );
    }
  });

  it('reports a theme the book never argues instead of dropping it', async () => {
    const { rows } = await query(
      `INSERT INTO books (author_id, title, content, themes)
       VALUES ($1,'Thin Book','Attention is a muscle that adapts to the load you give it.',
               $2) RETURNING *`,
      [authorId, ['attention', 'submarine warfare']],
    );
    const grounding = await retrieveThemeGrounding({ bookId: rows[0].id }, { query });

    const unevidenced = grounding.themes.find((t) => t.theme === 'submarine warfare');
    assert.ok(unevidenced, 'the theme should still be reported');
    assert.deepEqual(unevidenced.passages, [], 'the book evidences nothing about it');

    await query('DELETE FROM books WHERE id = $1', [rows[0].id]);
  });

  it('indexes a book written by any path, because the database derives it', async () => {
    // Inserted with raw SQL, the way the tests and the seed both do it. If the
    // index only existed on the API path, a drafter would silently lose its
    // grounding for every book created any other way.
    const { rows } = await query(
      `INSERT INTO books (author_id, title, content, themes)
       VALUES ($1,'Derived','One paragraph about craft.\n\nAnother about attention.',$2)
       RETURNING *`,
      [authorId, ['craft', 'attention']],
    );
    const { rows: themes } = await query(
      'SELECT theme FROM book_themes WHERE book_id = $1 ORDER BY position',
      [rows[0].id],
    );
    const { rows: passages } = await query(
      'SELECT content FROM book_passages WHERE book_id = $1 ORDER BY ordinal',
      [rows[0].id],
    );

    assert.deepEqual(themes.map((t) => t.theme), ['craft', 'attention']);
    assert.equal(passages.length, 2, 'the book should split into two passages');

    await query('DELETE FROM books WHERE id = $1', [rows[0].id]);
  });

  it('rebuilds passages when the book text changes and keeps a surviving key message', async () => {
    const { rows } = await query(
      `INSERT INTO books (author_id, title, content, themes)
       VALUES ($1,'Edited','Only one paragraph here about craft.',$2) RETURNING *`,
      [authorId, ['craft', 'attention']],
    );
    await query("UPDATE book_themes SET key_message = 'Craft is slow.' WHERE book_id = $1 AND theme = 'craft'", [
      rows[0].id,
    ]);

    await query('UPDATE books SET content = $2, themes = $3 WHERE id = $1', [
      rows[0].id,
      'First paragraph about craft.\n\nSecond paragraph about craft.',
      ['craft', 'resilience'],
    ]);

    const { rows: themes } = await query(
      'SELECT theme, key_message FROM book_themes WHERE book_id = $1 ORDER BY position',
      [rows[0].id],
    );
    const { rows: passages } = await query('SELECT id FROM book_passages WHERE book_id = $1', [
      rows[0].id,
    ]);

    assert.deepEqual(themes.map((t) => t.theme), ['craft', 'resilience']);
    assert.equal(
      themes.find((t) => t.theme === 'craft').key_message,
      'Craft is slow.',
      'a theme that survived the edit should keep the message a human wrote',
    );
    assert.equal(passages.length, 2, 'the retrieval corpus should follow the new text');

    await query('DELETE FROM books WHERE id = $1', [rows[0].id]);
  });
});

describe('Naming a theme is not arguing it', () => {
  let grounding;

  before(async () => {
    grounding = await retrieveThemeGrounding({ bookId }, { query });
  });

  it('excludes the theme own words from what counts as its argument', () => {
    const craft = grounding.themes.find((t) => t.theme === 'craft');
    const terms = distinctiveTerms(craft);
    assert.ok(!terms.has('craft'), 'repeating the label must not count as making its case');
    assert.ok(terms.has('accumulation'), 'the key message vocabulary should count');
  });

  it('scores copy that repeats every theme and argues none below the floor', () => {
    const nameCheck =
      'Deep work, craft, attention and resilience. This is a title about deep work. ' +
      'It is also a title about craft. It concerns attention. Resilience as well. ' +
      'Deep work, craft, attention, resilience.';

    // The measure this story replaced gave exactly this copy a perfect score.
    assert.equal(themeAlignment(nameCheck, BOOK_THEMES).score, 1);

    const report = alignToThemes({ text: nameCheck, grounding });
    assert.equal(report.matched.length, 4, 'it does name every theme');
    assert.deepEqual(report.argued, [], 'and argues none of them');
    assert.ok(
      report.score < config.minThemeAlignment,
      `name-checking scored ${report.score}, which would clear the floor`,
    );
  });

  it('scores off-message copy at exactly zero', () => {
    const report = alignToThemes({
      text: 'A thriller about submarines and international finance.',
      grounding,
    });
    assert.equal(report.score, 0);
    assert.deepEqual(report.matched, []);
  });

  it('gives no message credit to a draft that never names the theme', () => {
    // The book's own words about craft, with the word "craft" removed. It
    // cannot be reflecting a theme it does not mention, and letting it score
    // would let generic book vocabulary earn alignment for another book.
    const report = alignToThemes({
      text: 'The slow accumulation of decisions nobody claps for.',
      grounding,
    });
    const entry = report.perTheme.find((t) => t.theme === 'craft');
    assert.equal(entry.named, false);
    assert.equal(entry.score, 0);
  });

  it('falls back to the verbatim check when there is no grounding at all', () => {
    // A book whose themes were never indexed still gets the STORY-003 measure
    // rather than a zero it has not earned.
    const scored = scoreMaterial({
      type: 'fact_sheet',
      headline: 'Fact sheet',
      body: 'TITLE — X\nAUTHOR — Y\nTHEMES — deep work, craft, attention, resilience',
      bookThemes: BOOK_THEMES,
      bookContent: BOOK_CONTENT,
      history: [],
    });
    assert.equal(scored.themeAlignment, 1);
  });
});

describe('TBI: name-checking copy reaches a human', () => {
  /** Every required element, every theme named, no argument anywhere. */
  const nameCheckingProvider = {
    name: 'test-name-checking',
    async draftKit() {
      return MATERIAL_TYPES.map((type) => ({
        type,
        headline: 'Deep work, craft, attention and resilience',
        body:
          'FOR IMMEDIATE RELEASE\n\nTITLE — Something\nAUTHOR — Someone\n' +
          'THEMES — deep work, craft, attention, resilience\n\n' +
          'A title about deep work. Also about craft. It concerns attention. Resilience too.\n\n' +
          'ABOUT THE BOOK — deep work, craft, attention and resilience.\n' +
          'MEDIA CONTACT — press@example.test',
        themesUsed: BOOK_THEMES,
      }));
    },
  };

  let escalated;

  before(async () => {
    const milestone = await createMilestone('Name-checked milestone', 90);
    ({ materials: escalated } = await draftPressKit({
      milestoneId: milestone.id,
      provider: nameCheckingProvider,
    }));
  });

  it('escalates a well-formed release that names every theme and argues none', () => {
    const release = escalated.find((m) => m.type === 'press_release');
    assert.match(release.rationale, /completeness=1\.00/, 'the copy is well formed');
    assert.ok(
      Number(release.theme_alignment) < config.minThemeAlignment,
      `alignment ${release.theme_alignment} cleared the floor`,
    );
    assert.equal(release.status, 'escalated');
  });

  it('still records which themes it named, so the reviewer sees the gap', async () => {
    const release = escalated.find((m) => m.type === 'press_release');
    const { rows } = await query(
      'SELECT theme, named, message_score FROM pr_material_themes WHERE material_id = $1',
      [release.id],
    );
    assert.ok(rows.every((r) => r.named), 'every theme was named');
    assert.ok(
      rows.every((r) => Number(r.message_score) < 0.5),
      'and none of them was argued',
    );
  });
});

describe('TBI: the alignment act is on the audit log', () => {
  let kitId;
  let materialId;

  before(async () => {
    const milestone = await createMilestone('Audited milestone', 120);
    const result = await draftPressKit({ milestoneId: milestone.id });
    kitId = result.kit.id;
    materialId = result.materials.find((m) => m.type === 'press_release').id;
  });

  it('records the retrieval, with what it pulled', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE action = 'pr_kit.themes_retrieved' AND entity_id = $1`,
      [String(kitId)],
    );
    assert.equal(rows.length, 1, 'retrieval should be logged exactly once per kit');
    assert.equal(rows[0].actor, CONTENT_AGENT, 'logged by the agent that owns alignment');
    assert.deepEqual(rows[0].metadata.themes.sort(), [...BOOK_THEMES].sort());
    assert.ok(rows[0].metadata.passageCount > 0);
    assert.deepEqual(rows[0].metadata.ungroundedThemes, []);
  });

  it('records the alignment of each material under the content agent', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE action = 'pr_material.aligned' AND entity_id = $1`,
      [String(materialId)],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, CONTENT_AGENT);
    assert.equal(rows[0].metadata.perTheme.length, BOOK_THEMES.length);
    assert.ok(Array.isArray(rows[0].metadata.namedOnly));
  });

  it('logs retrieval before the material it grounded', async () => {
    const { rows } = await query(
      `SELECT action FROM audit_log
        WHERE actor = $1 AND author_id = $2
        ORDER BY id`,
      [CONTENT_AGENT, authorId],
    );
    assert.equal(rows[0].action, 'pr_kit.themes_retrieved', 'grounding comes first, not last');
  });
});

describe('API: theme alignment status', () => {
  it('serves the grounding a draft would be written from', async () => {
    const { rows } = await query(
      `SELECT t.theme, t.key_message, COUNT(p.id)::int AS passage_count
         FROM book_themes t
         LEFT JOIN book_passages p
                ON p.book_id = t.book_id
               AND p.tsv @@ plainto_tsquery('english', t.theme)
        WHERE t.book_id = $1
        GROUP BY t.theme, t.key_message
        ORDER BY t.theme`,
      [bookId],
    );
    assert.equal(rows.length, BOOK_THEMES.length);
    assert.ok(rows.every((r) => r.key_message.length > 0), 'every theme has a key message');
    assert.ok(rows.every((r) => r.passage_count > 0), 'every theme has evidence');
  });
});
