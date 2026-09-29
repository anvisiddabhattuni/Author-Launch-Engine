/**
 * STORY-047 acceptance tests.
 *
 *   "Generated content is reviewed for thematic alignment" → given content is
 *       generated, when it is ready for review, then it is compared with key
 *       themes and stylistic elements extracted from the book.
 *   Build step 3: reviewers approve or request modifications.
 *   Trust: an approval gate — all generated content approved by a human
 *       before publication.
 *
 * Measured before this story: drafts were scored against the book's themes and
 * against the author's social posts for voice — never against the book's own
 * style — and a reviewer could only approve or reject.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { LONG_FIELD } from '../src/db/sampleManuscript.js';
import { bookStyle, reviewDraft } from '../src/services/contentReview.js';

const stamp = Date.now();
let server;
let base;
let tenant;
let other;
let token;
let otherToken;
let auditor;
let book;
let drafts;

const call = async (tok, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await call(null, 'POST', '/auth/login', { email, password })).body.token;

/** A draft written by hand, then reviewed exactly as a generated one is. */
async function handDraft(content, themes) {
  const { rows: [d] } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, themes_used, status, confidence, week_of, theme_alignment, voice_score)
     VALUES ($1,$2,'twitter',$3,$4,'pending_approval',0.9,CURRENT_DATE,0.9,0.9) RETURNING id`,
    [tenant.author.id, book.id, content, themes],
  );
  for (const theme of themes) {
    await query(
      `INSERT INTO draft_themes (draft_id, theme, key_message, named, message_score, score, known, passage_ids, carried_terms)
       VALUES ($1,$2,'',$3,0,$4,true,'{}','{}')`,
      [d.id, theme, content.toLowerCase().includes(theme), content.toLowerCase().includes(theme) ? 0.8 : 0.1],
    );
  }
  return reviewDraft(d.id);
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Review Author', email: `review-${stamp}@example.test`, password: 'review-password-1' });
  other = await onboardTenant({ name: 'Review Other', email: `review-other-${stamp}@example.test`, password: 'other-password-1' });
  token = await login(`review-${stamp}@example.test`, 'review-password-1');
  otherToken = await login(`review-other-${stamp}@example.test`, 'other-password-1');
  auditor = await login('auditor@example.test', 'compliance-only');
  book = (await call(token, 'POST', `/authors/${tenant.author.id}/books`, {
    title: LONG_FIELD.title, content: LONG_FIELD.content, themes: LONG_FIELD.themes,
  })).body;
  for (const m of LONG_FIELD.materials) await call(token, 'POST', `/authors/${tenant.author.id}/books/${book.id}/materials`, m);
  drafts = await draftWeeklyPosts({ authorId: tenant.author.id, bookId: book.id, count: 4, providerName: 'stub', memeCount: 0 });
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1::bigint[])', [[tenant.author.id, other.author.id]]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: generated content is compared with the book when it is ready for review', () => {
  it('every new draft has a comparison, made with the book\'s current model, and it is on the audit log', async () => {
    const { rows } = await query('SELECT * FROM content_reviews WHERE draft_id = ANY($1::bigint[])', [drafts.map((d) => d.id)]);
    assert.equal(rows.length, drafts.length);
    const { rows: [model] } = await query("SELECT version FROM book_models WHERE book_id = $1 AND status = 'current'", [book.id]);
    assert.ok(rows.every((r) => r.model_version === model.version));
    assert.ok(rows.every((r) => r.comparison.themes.length > 0 && r.comparison.style.length === 4));
    const { rows: logged } = await query("SELECT 1 FROM audit_log WHERE action = 'draft.compared_with_book' AND entity_id = ANY($1::text[])", [drafts.map((d) => String(d.id))]);
    assert.equal(logged.length, drafts.length);
  });

  it('the stylistic elements come from the book, counted the way the author\'s posts are', () => {
    const style = bookStyle({ content: LONG_FIELD.content });
    assert.equal(style.exclamationsPer100, 0, 'the sample book has no exclamation marks');
    assert.ok(style.meanSentenceWords > 12);
  });

  it('a draft in a register the book never uses is misaligned, and each element says why', async () => {
    const r = await handDraft('AMAZING news!!! The Long Field is a GAME-CHANGER about patience, a must-read bestseller! Buy it NOW!', ['patience']);
    assert.equal(r.verdict, 'misaligned');
    const misses = r.comparison.style.filter((s) => !s.fits).map((s) => s.element).sort();
    assert.deepEqual(misses, ['exclamations', 'hype', 'shouting']);
    assert.ok(r.comparison.notes.some((n) => /Exclamation marks: .* the book uses 0/.test(n)));
    // "field" is in the title; naming the book is not using its language.
    assert.ok(!r.comparison.themes[0].bookWords.includes('field'));
  });

  it('a theme claimed but not argued is misaligned', async () => {
    const r = await handDraft('A quiet book about a farm and the people on it.', ['grief']);
    assert.equal(r.verdict, 'misaligned');
    assert.match(r.comparison.notes.join(' '), /"grief" is claimed but not argued/);
  });

  it('a theme argued in the book\'s own words is aligned — the model\'s words, found in the draft', async () => {
    const r = await handDraft('His coat still hangs on the hook, and the empty chair is still at the table. That is what loss looks like in The Long Field.', ['loss']);
    assert.equal(r.verdict, 'aligned');
    const loss = r.comparison.themes.find((t) => t.theme === 'loss');
    assert.ok(loss.bookWords.includes('empty') && loss.bookWords.includes('chair'), JSON.stringify(loss.bookWords));
  });

  it('the review queue shows the comparison beside each draft', async () => {
    const r = await call(token, 'GET', `/drafts?authorId=${tenant.author.id}`);
    const shown = r.body.find((d) => Number(d.id) === Number(drafts[0].id));
    assert.ok(shown.bookReview, 'no comparison in the review queue');
    assert.ok(['aligned', 'check', 'misaligned'].includes(shown.bookReview.verdict));
  });
});

describe('Scenario: a reviewer requests modifications', () => {
  let target;
  let result;

  it('the draft is set aside with the note, and a revision comes back linked to it — reviewed like any other', async () => {
    target = drafts.find((d) => d.status === 'pending_approval') ?? drafts[0];
    const r = await call(token, 'POST', `/drafts/${target.id}/request-changes`, { note: 'Lead with the empty chair, not the wall by the road.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    result = r.body;
    assert.equal(result.draft.status, 'changes_requested');
    assert.equal(result.draft.change_request, 'Lead with the empty chair, not the wall by the road.');
    assert.equal(result.draft.changes_requested_by, 'Review Author');
    assert.ok(result.revision, result.revisionError);
    assert.equal(Number(result.revision.revision_of), Number(target.id));
    assert.ok(['pending_approval', 'escalated'].includes(result.revision.status), 'a revision skipped the gate');
    assert.notEqual(result.revision.content, target.content, 'the revision is the same draft again');
    const { rows } = await query('SELECT verdict FROM content_reviews WHERE draft_id = $1', [result.revision.id]);
    assert.equal(rows.length, 1, 'the revision was not compared with the book');
  });

  it('who asked and why is on the audit log', async () => {
    const { rows: [entry] } = await query("SELECT actor, metadata, before, after FROM audit_log WHERE action = 'draft.changes_requested' AND entity_id = $1", [String(target.id)]);
    assert.equal(entry.actor, 'Review Author');
    assert.match(entry.metadata.note, /empty chair/);
    assert.equal(entry.after.status, 'changes_requested');
  });

  it('a draft set aside cannot be approved, asked about twice, or scheduled', async () => {
    assert.equal((await call(token, 'POST', `/drafts/${target.id}/approve`, {})).status, 409);
    assert.equal((await call(token, 'POST', `/drafts/${target.id}/request-changes`, { note: 'and again, please change it' })).status, 409);
    assert.notEqual((await call(token, 'POST', `/drafts/${target.id}/schedule`, { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() })).status, 200);
  });

  it('the gate is unchanged: only a person with content.approve on this tenant can ask, and must say what', async () => {
    const d = drafts.find((x) => Number(x.id) !== Number(target.id));
    assert.equal((await call(token, 'POST', `/drafts/${d.id}/request-changes`, { note: 'short' })).status, 400);
    assert.equal((await call(auditor, 'POST', `/drafts/${d.id}/request-changes`, { note: 'compliance cannot do this' })).status, 403);
    assert.equal((await call(otherToken, 'POST', `/drafts/${d.id}/request-changes`, { note: 'another tenant cannot do this' })).status, 403);
  });

  it('the database refuses a draft set aside without a note', async () => {
    const d = drafts.find((x) => Number(x.id) !== Number(target.id));
    await assert.rejects(
      () => query("UPDATE drafts SET status = 'changes_requested' WHERE id = $1", [d.id]),
      /drafts_change_request_explained/,
    );
  });
});
