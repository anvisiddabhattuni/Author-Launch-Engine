/**
 * STORY-048 acceptance tests.
 *
 *   "AI models adapt based on feedback" → given feedback is provided on
 *       generated content, when the feedback is processed, then the AI models
 *       adjust to improve future content generation.
 *   Trust: the audit log tracks feedback and model adjustments.
 *
 * Measured before this story: reviewer decisions and notes were recorded and
 * nothing learned from them — a passage turned down on Monday was quoted again
 * on Tuesday. The only adaptation (STORY-069's meme mix) learns from
 * engagement, not from reviewers.
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
import { AVOID_BELOW, learnPreferences, quotedPassages } from '../src/services/bookModel.js';

const stamp = Date.now();
let WEEK = null;
let server;
let base;
let tenant;
let other;
let token;
let otherToken;
let auditor;
let book;
let wall;
let coat;
let passages;

const call = async (tok, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call(null, 'POST', '/auth/login', { email, password })).body.token;

/** A draft on "loss" quoting a passage, with a status and a rating. */
async function judged(passage, status, rating, comment) {
  const sentence = passage.content.split(/(?<=[.!?])\s+/)[0];
  const asked = status === 'changes_requested';
  const { rows: [d] } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, themes_used, status, confidence, week_of, theme_alignment, voice_score,
                         change_request, changes_requested_by)
     VALUES ($1,$2,'twitter',$3,'{loss}',$4,0.9,CURRENT_DATE,0.9,0.9,$5,$6) RETURNING id`,
    [tenant.author.id, book.id, `On loss, from the book: ${sentence}`, status, asked ? comment : null, asked ? 'Feedback Author' : null],
  );
  const r = await call(token, 'POST', `/drafts/${d.id}/feedback`, { rating, comment });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return d.id;
}

const lossQuotes = (drafts, passage) =>
  drafts.filter((d) => (d.themes_used ?? []).includes('loss') && quotedPassages(d.content, [passage]).length > 0).length;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Feedback Author', email: `feedback-${stamp}@example.test`, password: 'feedback-password-1' });
  other = await onboardTenant({ name: 'Feedback Other', email: `feedback-other-${stamp}@example.test`, password: 'other-password-1' });
  token = await login(`feedback-${stamp}@example.test`, 'feedback-password-1');
  otherToken = await login(`feedback-other-${stamp}@example.test`, 'other-password-1');
  auditor = await login('auditor@example.test', 'compliance-only');
  book = (await call(token, 'POST', `/authors/${tenant.author.id}/books`, {
    title: LONG_FIELD.title, content: LONG_FIELD.content, themes: LONG_FIELD.themes,
  })).body;
  for (const m of LONG_FIELD.materials) await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/materials`, m);
  ({ rows: passages } = await query('SELECT id, content FROM book_passages WHERE book_id = $1 ORDER BY ordinal', [book.id]));
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[tenant.author.id, other.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: feedback is provided on generated content', () => {
  // The same week is drafted before and after feedback: the same seeds, so the
  // only thing that differs between the two batches is the model.
  // Which passage a week quotes depends on the book's id (the offline
  // provider's seed), so the one reviewers turn down is whichever this week
  // actually quoted most — never luck.
  it('before any feedback, the week\'s "loss" drafts quote a passage reviewers will turn down', async () => {
    const { rows: [m] } = await query("SELECT parameters FROM book_models WHERE book_id = $1 AND status = 'current'", [book.id]);
    const t = m.parameters.themes.find((x) => x.theme === 'loss');
    const ids = [...t.literalPassages, ...t.foundPassages.map((f) => f.id)].map(Number);
    const candidates = passages.filter((p) => ids.includes(Number(p.id)));
    assert.ok(candidates.length >= 2, 'loss needs two passages for one to be avoided');
    // The first week whose drafts quote one of them.
    for (const week of ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']) {
      const drafts = await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 12, providerName: 'stub', memeCount: 0, weekOf: week });
      candidates.sort((a, b) => lossQuotes(drafts, b) - lossQuotes(drafts, a));
      if (lossQuotes(drafts, candidates[0]) > 0) {
        WEEK = week;
        break;
      }
    }
    [wall, coat] = candidates;
    assert.ok(WEEK, 'no week quoted a loss passage, so avoiding one would prove nothing');
  });

  it('reviewers rate drafts and say why — each rating on the audit log', async () => {
    await judged(wall, 'rejected', 1, 'Not this passage again: too bleak for launch week.');
    await judged(wall, 'changes_requested', 2, 'This passage reads as a eulogy.');
    await judged(coat, 'approved', 5, 'This one is exactly right.');
    const { rows } = await query("SELECT actor, metadata FROM audit_log WHERE action = 'feedback.recorded' AND author_id = $1", [tenant.author.id]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].actor, 'Feedback Author');
  });

  it('only reviewers of this tenant can give it, and it has to say something', async () => {
    const { rows: [d] } = await query('SELECT id FROM drafts WHERE book_id = $1 LIMIT 1', [book.id]);
    assert.equal((await call(token, 'POST', `/drafts/${d.id}/feedback`, { rating: 6 })).status, 400);
    assert.equal((await call(token, 'POST', `/drafts/${d.id}/feedback`, {})).status, 400);
    assert.equal((await call(auditor, 'POST', `/drafts/${d.id}/feedback`, { rating: 3 })).status, 403);
    assert.equal((await call(otherToken, 'POST', `/drafts/${d.id}/feedback`, { rating: 3 })).status, 403);
  });
});

describe('When the feedback is processed, the model adjusts', () => {
  let model;

  it('a new version, labelled as feedback, with what moved and by how much on the audit log', async () => {
    const r = await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/feedback/apply`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refitted, true);
    model = r.body.model;
    assert.equal(model.trigger, 'feedback');
    const byId = new Map(model.parameters.preferences.passages.map((p) => [p.id, p]));
    assert.ok(byId.get(Number(wall.id)).weight < AVOID_BELOW, JSON.stringify(byId.get(Number(wall.id))));
    const { rows: [entry] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'book_model.fitted' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [String(book.id)],
    );
    assert.equal(entry.metadata.trigger, 'feedback');
    const moved = entry.metadata.preferencesMoved.passages.find((p) => p.id === Number(wall.id));
    assert.deepEqual([moved.from, moved.good, moved.bad], [1, 0, 2]);
  });

  it('applying it again with nothing new changes nothing', async () => {
    const r = await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/feedback/apply`, {});
    assert.equal(r.body.refitted, false);
  });

  it('the next drafts no longer quote what reviewers turned down — and the log says it was left out', async () => {
    const drafts = await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 12, providerName: 'stub', memeCount: 0, weekOf: WEEK });
    assert.ok(drafts.some((d) => (d.themes_used ?? []).includes('loss')), 'no loss drafts to judge by');
    assert.equal(lossQuotes(drafts, wall), 0);
    const { rows: [applied] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'book_model.applied' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [String(book.id)],
    );
    assert.ok(applied.metadata.avoided.includes(Number(wall.id)));
    assert.equal(applied.metadata.feedbackJudgments, 3);
  });

  it('the Anthropic prompt is told what reviewers said', () => {
    const prompt = buildPrompt({
      book: { title: 'T', themes: ['loss'], content: '' }, voiceProfile: {}, voice: null,
      grounding: { themes: [] }, history: [], platforms: ['twitter'], count: 1, bookModel: model.parameters,
    });
    assert.match(prompt, /turned down\) Not this passage again/);
    assert.match(prompt, /liked\) This one is exactly right/);
  });
});

describe('Bounded: feedback tilts generation, never silences it', () => {
  it('one judgment moves nothing; themes stay between 0.5 and 1.5; passages between 0 and 2', () => {
    const one = learnPreferences([{ draftId: 1, label: -1, themes: ['grief'], passages: [9], notes: [] }]);
    assert.equal(one.passages[0].weight, 1);
    assert.equal(one.themes[0].weight, 1);
    const many = learnPreferences(Array.from({ length: 20 }, (_, i) => ({ draftId: i, label: -1, themes: ['grief'], passages: [9], notes: [] })));
    assert.equal(many.themes[0].weight, 0.5);
    assert.ok(many.passages[0].weight >= 0 && many.passages[0].weight < 0.2);
  });

  it('a theme whose every passage is disfavoured keeps them rather than going silent', async () => {
    const coatPassageOnly = passages.find((p) => Number(p.id) === Number(coat.id));
    await judged(coatPassageOnly, 'rejected', 1, 'Too sad after all.');
    await judged(coatPassageOnly, 'rejected', 1, 'Still too sad.');
    await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/feedback/apply`, {});
    const drafts = await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 12, providerName: 'stub', memeCount: 0, weekOf: '2026-11-16' });
    const loss = drafts.filter((d) => (d.themes_used ?? []).includes('loss'));
    assert.ok(loss.every((d) => d.grounded_passages > 0), 'a theme went silent');
  });
});
