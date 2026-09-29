/**
 * STORY-046 acceptance tests.
 *
 *   "AI models are fine-tuned on book-specific data" → given a new book is
 *       onboarded, when the system initializes the AI content generation
 *       process, then the models are fine-tuned using the book's text and
 *       supplementary materials.
 *   Trust: the fine-tuning is on the audit log, and its parameters are stored
 *       securely and transparently.
 *
 * Claude cannot be fine-tuned through the public API, and the offline provider
 * is templates, so what is fitted is a model of the book — per-theme lexicons
 * learned from the passages that name each theme — judged on held-out
 * passages with the theme's word masked, and used by generation.
 *
 * Measured before this story: nothing ran when a book was uploaded, nothing
 * learned about a book was kept, there was nowhere to give supplementary
 * material, and retrieval found a theme only where the book used its word.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { buildPrompt } from '../src/ai/anthropicProvider.js';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { LONG_FIELD } from '../src/db/sampleManuscript.js';
import { fitBookModel } from '../src/services/bookModel.js';

const stamp = Date.now();
let server;
let base;
let tenant;
let other;
let token;
let otherToken;
let book;

const call = async (tok, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call(null, 'POST', '/auth/login', { email, password })).body.token;
const themeOf = (model, name) => model.parameters.themes.find((t) => t.theme === name);

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Model Author', email: `model-${stamp}@example.test`, password: 'model-password-1' });
  other = await onboardTenant({ name: 'Model Other', email: `model-other-${stamp}@example.test`, password: 'other-password-1' });
  token = await login(`model-${stamp}@example.test`, 'model-password-1');
  otherToken = await login(`model-other-${stamp}@example.test`, 'other-password-1');
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[tenant.author.id, other.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: a new book is onboarded, and a model is fitted to it', () => {
  it('uploading the book fits version 1 at once, from the book\'s own text', async () => {
    const r = await call(token, 'POST', `/authors/${tenant.author.id}/books`, {
      title: LONG_FIELD.title, content: LONG_FIELD.content, themes: LONG_FIELD.themes,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    book = r.body;
    assert.equal(book.model.version, 1);
    assert.equal(book.model.trigger, 'book_uploaded');
    assert.equal(book.model.parameters.sources.passages, 18);
    assert.ok(themeOf(book.model, 'patience').lexicon.some((l) => ['walk', 'ground'].includes(l.term)),
      'patience learned nothing from the passages that name it');
  });

  it('the parameters are stored in PostgreSQL, and the fitting is on the audit log with the tenant', async () => {
    const { rows } = await query('SELECT * FROM book_models WHERE book_id = $1', [book.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'current');
    assert.equal(rows[0].input_digest.length, 64);
    const { rows: [entry] } = await query("SELECT metadata FROM audit_log WHERE action = 'book_model.fitted' AND entity_id = $1", [String(book.id)]);
    assert.equal(entry.metadata.version, 1);
    assert.ok(entry.metadata.lexicons.patience.length > 0);
    assert.match(entry.metadata.evidence, /→/);
  });

  it('with one passage naming "loss", there is nothing to learn it from — and the model says so', () => {
    const loss = themeOf(book.model, 'loss');
    assert.equal(loss.examples.passages, 1);
    assert.equal(loss.lexicon.length, 0);
    assert.deepEqual(book.model.metrics.themesWithoutExamples, ['loss']);
    assert.equal(book.model.metrics.literalEvidence, 7);
  });
});

describe('Supplementary materials', () => {
  let v2;

  it('adding the author\'s notes refits: loss is learned from them, and the model finds what literal search cannot', async () => {
    for (const m of LONG_FIELD.materials) {
      const r = await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/materials`, m);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      v2 = r.body.model;
    }
    assert.equal(v2.trigger, 'material_added');
    const loss = themeOf(v2, 'loss');
    assert.ok(loss.lexicon.some((l) => l.term === 'chair'), 'loss learned nothing from the notes');
    // Matched on stems, shown as the book's own word: "empti" reads as "empty".
    assert.ok(loss.lexicon.some((l) => l.term === 'empti' && l.word === 'empty'));
    assert.equal(loss.foundPassages.length, 1);
    const { rows: [found] } = await query('SELECT content FROM book_passages WHERE id = $1', [loss.foundPassages[0].id]);
    assert.match(found.content, /empty chair/);
    assert.doesNotMatch(found.content, /\bloss\b/i, 'that is not a passage literal search would miss');
    assert.equal(v2.metrics.modelEvidence, 8);
    assert.equal(v2.metrics.literalEvidence, 7);
  });

  it('it is judged on held-out passages with the theme\'s word masked — where literal search scores zero', () => {
    assert.ok(v2.metrics.heldOut >= 6);
    assert.ok(v2.metrics.maskedRecall > book.model.metrics.maskedRecall, 'materials did not help');
    assert.ok(v2.metrics.maskedRecall > 0);
  });

  it('only the book is evidence: a material is learned from, never cited', () => {
    const passageIds = new Set();
    for (const t of v2.parameters.themes) {
      for (const f of t.foundPassages) passageIds.add(f.id);
      for (const a of t.anchorLines) passageIds.add(a.passageId);
    }
    return query('SELECT COUNT(*)::int AS n FROM book_passages WHERE book_id = $1 AND id = ANY($2::bigint[])', [book.id, [...passageIds]])
      .then(({ rows }) => assert.equal(rows[0].n, passageIds.size));
  });

  it('versions: the old one superseded, never rewritten; the same inputs never refit', async () => {
    const { rows } = await query('SELECT version, status FROM book_models WHERE book_id = $1 ORDER BY version', [book.id]);
    assert.deepEqual(rows.map((r) => `${r.version}:${r.status}`), ['1:superseded', '2:superseded', '3:current'],
      'one version per material added');
    await assert.rejects(
      () => query("UPDATE book_models SET parameters = '{}' WHERE book_id = $1 AND version = 1", [book.id]),
      /never rewritten/,
    );
    const again = await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/model/refit`, {});
    assert.equal(again.body.refitted, false);
    assert.equal(again.body.model.version, 3);
  });
});

describe('When the AI content generation process runs', () => {
  it('drafting uses the model: the passage it found for "loss" reaches the drafter, and that is logged', async () => {
    await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 3, providerName: 'stub', memeCount: 0 });
    const { rows: [applied] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'book_model.applied' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [String(book.id)],
    );
    assert.ok(applied, 'generation did not use the model');
    assert.equal(applied.metadata.version, 3);
    assert.equal(applied.metadata.byTheme.loss.length, 1);
  });

  it('the Anthropic prompt carries the lexicon, the lines, and marks what the model found', () => {
    const model = { parameters: { themes: [{ theme: 'loss', lexicon: [{ term: 'chair' }, { term: 'coat' }], anchorLines: [{ sentence: 'His coat still hung on the hook.' }] }], style: { meanSentenceWords: 17 } } };
    const prompt = buildPrompt({
      book: { title: 'T', themes: ['loss'], content: '' },
      voiceProfile: {},
      voice: null,
      grounding: { themes: [{ theme: 'loss', keyMessage: '', passages: [{ id: 1, content: 'The empty chair.', source: 'book model' }] }] },
      history: [],
      platforms: ['twitter'],
      count: 1,
      bookModel: model.parameters,
    });
    assert.match(prompt, /loss: chair, coat/);
    assert.match(prompt, /His coat still hung/);
    assert.match(prompt, /found by the book model/);
  });

  it('a changed book is refitted before its next draft', async () => {
    await query('UPDATE books SET content = content || $2 WHERE id = $1', [book.id, '\n\nThe frost went in April that year, the way it always does.']);
    await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 1, providerName: 'stub', memeCount: 0 });
    const { rows: [current] } = await query("SELECT version, trigger FROM book_models WHERE book_id = $1 AND status = 'current'", [book.id]);
    assert.equal(current.version, 4);
    assert.equal(current.trigger, 'inputs_changed');
  });
});

describe('Transparent to its tenant, and to nobody else', () => {
  it('the author reads the model, through their own schema; another tenant cannot', async () => {
    const r = await call(token, 'GET', `/authors/${tenant.author.id}/books/${book.id}/model`);
    assert.equal(r.status, 200);
    assert.equal(r.body.current.version, 4);
    assert.equal(r.body.versions.length, 4);
    assert.equal(r.body.materials.length, 2);
    assert.equal((await call(otherToken, 'GET', `/authors/${tenant.author.id}/books/${book.id}/model`)).status, 403);
  });

  it('a book too short to learn from is fitted anyway, and says it learned nothing', async () => {
    const { rows: [tiny] } = await query(
      "INSERT INTO books (author_id, title, content, themes) VALUES ($1, 'Tiny', 'Craft is slow and quiet.', '{craft,attention}') RETURNING id",
      [other.author.id],
    );
    const { model } = await fitBookModel({ bookId: tiny.id, trigger: 'manual' });
    assert.equal(model.metrics.maskedRecall, null);
    assert.deepEqual(model.metrics.themesWithoutExamples.sort(), ['attention', 'craft']);
  });
});
