/**
 * HTTP-layer tests.
 *
 * The other test files exercise the agents and services directly, which is why
 * a query built only in a route handler could ship broken: `GET /opportunities`
 * filtered on unqualified column names while joining two tables that both carry
 * `author_id` and `status`, so Postgres rejected it as ambiguous. Anything a
 * route assembles itself needs a test that goes through the route.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp, errorMessage } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { upsertUser } from '../src/services/auth.js';

let server;
let baseUrl;
let authorId;
let bookId;
/** Every request below is made as a signed-in author (STORY-064). */
let token;

/** Starts the real app on an ephemeral port so the tests use actual routing. */
before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    ['Routes Test Author', `routes-${Date.now()}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'The Quiet Craft', 'Attention is a muscle. Craft is slow.', ['deep work', 'craft']],
  );
  bookId = bookRows[0].id;

  await upsertUser({
    email: `routes-user-${Date.now()}@example.test`,
    name: 'Routes Test User',
    password: 'routes-password',
    role: 'author',
    authorId,
  });
  const { rows: userRows } = await query(
    'SELECT email FROM users WHERE author_id = $1 ORDER BY id DESC LIMIT 1',
    [authorId],
  );
  const signIn = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: userRows[0].email, password: 'routes-password' }),
  });
  ({ token } = await signIn.json());
  assert.ok(token, 'the routes suite could not sign in');
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: auth() });
  const body = await response.json();
  return { status: response.status, body };
};

describe('the API never answers with an empty error', () => {
  // A dropped database connection arrives as an AggregateError whose message is
  // the empty string. Sent verbatim it rendered as no message at all, so a dead
  // Postgres looked like a Sign in button that simply did nothing.
  it('falls back to a code when the error carries no message', () => {
    const dropped = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    assert.equal(errorMessage(dropped), 'ECONNREFUSED');
  });

  it('falls back to a name, then to a generic message, before ever returning nothing', () => {
    assert.equal(errorMessage(new Error('')), 'Error');
    assert.equal(errorMessage(Object.assign(new Error(''), { name: '' })), 'Internal server error');
    assert.equal(errorMessage({}), 'Internal server error');
    assert.equal(errorMessage(null), 'Internal server error');
  });

  it('leaves a real message exactly as it was written', () => {
    assert.equal(
      errorMessage(new Error('Email or password is incorrect')),
      'Email or password is incorrect',
    );
  });

  it('trims a message that is only whitespace rather than passing it through', () => {
    assert.equal(errorMessage(Object.assign(new Error('   '), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
  });
});

describe('GET /opportunities filters', () => {
  before(async () => {
    await fetch(`${baseUrl}/authors/${authorId}/books/${bookId}/opportunities/scout`, {
      method: 'POST',
      headers: auth(),
    });
  });

  it('filters by author without an ambiguous column reference', async () => {
    const { status, body } = await get(`/opportunities?authorId=${authorId}`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0, 'the scout should have identified opportunities to filter');
    assert.ok(body.every((o) => String(o.author_id) === String(authorId)));
  });

  it('filters by status against the opportunity, not the joined message', async () => {
    const { status, body } = await get(`/opportunities?authorId=${authorId}&status=identified`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.length > 0);
    assert.ok(body.every((o) => o.status === 'identified'));
  });

  it('filters by type', async () => {
    const { status, body } = await get(`/opportunities?authorId=${authorId}&type=podcast`);
    assert.equal(status, 200);
    assert.ok(body.every((o) => o.type === 'podcast'));
  });

  it('accepts every filter at once', async () => {
    const { status, body } = await get(
      `/opportunities?authorId=${authorId}&type=podcast&status=identified`,
    );
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.every((o) => o.type === 'podcast' && o.status === 'identified'));
  });
});

describe('the other list routes respond', () => {
  for (const path of [
    '/health',
    '/deployments',
    '/system/health',
    '/authors',
    '/drafts',
    '/outreach-messages',
    '/press-kits',
    '/press-contacts',
    '/audit-log',
    '/scheduled-posts',
  ]) {
    it(`GET ${path} returns 200`, async () => {
      const { status, body } = await get(path);
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    });
  }

  // Every list route accepts authorId, and each one is a chance to repeat the
  // ambiguity mistake.
  for (const path of [
    '/drafts',
    '/outreach-messages',
    '/press-kits',
    '/audit-log',
    '/scheduled-posts',
  ]) {
    it(`GET ${path} accepts an authorId filter`, async () => {
      const { status, body } = await get(`${path}?authorId=${authorId}`);
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    });
  }

  for (const path of [
    '/weekly-coverage',
    '/monthly-opportunities',
    '/milestones',
    '/milestones/approaching',
    '/awards/awaiting-outcome',
  ]) {
    it(`GET /authors/:id${path} returns 200`, async () => {
      const { status, body } = await get(`/authors/${authorId}${path}`);
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    });
  }

  // STORY-007: the review read model and the address book. Driven over HTTP for
  // the same reason as the one below — both assemble their own aggregate query,
  // and that is exactly where the ambiguous-column and missing-GROUP-BY
  // mistakes have both landed on this project.
  it('GET /authors/:id/pending-review returns what is sitting on a human', async () => {
    const { status, body } = await get(`/authors/${authorId}/pending-review`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.kits));
    assert.equal(typeof body.materialsAwaitingReview, 'number');
    assert.equal(typeof body.unreachable, 'boolean');
  });

  for (const path of ['/reviewers']) {
    it(`GET /authors/:id${path} returns 200`, async () => {
      const { status, body } = await get(`/authors/${authorId}${path}`);
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body));
    });
  }

  it('GET /notifications accepts an authorId filter', async () => {
    const { status, body } = await get(`/notifications?authorId=${authorId}`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body));
  });

  // STORY-006: the grounding read model. Driven over HTTP because the route
  // assembles its own aggregate query, which is where the ambiguous-column
  // mistake lived last time.
  it('GET /books/:id/themes returns the grounding a draft would use', async () => {
    const { status, body } = await get(`/books/${bookId}/themes`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.bookId, Number(bookId));
    assert.ok(Array.isArray(body.themes) && body.themes.length > 0, 'no themes were indexed');
    assert.ok(
      body.themes.every((t) => typeof t.passage_count === 'number'),
      'each theme should report how much evidence backs it',
    );
    assert.ok(Array.isArray(body.ungrounded));
    assert.ok(Array.isArray(body.withoutKeyMessage));
  });
});

// STORY-018: the on-demand command and the read model it feeds. `GET
// /press-kits` assembles its own aggregate over a LEFT JOIN that only matters
// for kits with no milestone, so the kit created here is the only thing that
// would catch the join going back to an inner one.
describe('POST /authors/:authorId/books/:bookId/pr-materials', () => {
  let created;

  it('generates PR materials on request, with no milestone', async () => {
    const response = await fetch(
      `${baseUrl}/authors/${authorId}/books/${bookId}/pr-materials`,
      {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    created = await response.json();
    assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(created)}`);
    assert.equal(created.kit.milestone_id, null);
    assert.equal(created.kit.occasion, 'on_demand');
    assert.equal(created.kit.requested_by, 'Routes Test User');
    assert.equal(created.materials.length, 3);
    assert.ok(created.materials.every((m) => m.voice_score !== null));
  });

  it('shows the milestone-less kit in GET /press-kits', async () => {
    const { status, body } = await get(`/press-kits?authorId=${authorId}`);
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const kit = body.find((k) => Number(k.id) === Number(created.kit.id));
    assert.ok(kit, 'the on-demand kit was dropped by the press-kits query');
    assert.equal(kit.milestone_title, 'Requested directly');
    assert.equal(kit.material_count, 3);
    assert.ok(typeof kit.min_voice_score === 'string' || typeof kit.min_voice_score === 'number');
  });

  it('refuses a book belonging to another tenant', async () => {
    const { rows } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Routes Other Author', `routes-other-${Date.now()}@example.test`],
    );
    const { rows: otherBook } = await query(
      'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
      [rows[0].id, 'Not Yours', 'Some content.', ['maps']],
    );

    const response = await fetch(
      `${baseUrl}/authors/${rows[0].id}/books/${otherBook[0].id}/pr-materials`,
      { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(response.status, 403, 'a signed-in author reached another tenant\'s book');

    await query('DELETE FROM authors WHERE id = $1', [rows[0].id]);
  });
});
