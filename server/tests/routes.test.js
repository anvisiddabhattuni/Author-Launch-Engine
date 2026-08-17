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

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';

let server;
let baseUrl;
let authorId;
let bookId;

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
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  return { status: response.status, body };
};

describe('GET /opportunities filters', () => {
  before(async () => {
    await fetch(`${baseUrl}/authors/${authorId}/books/${bookId}/opportunities/scout`, {
      method: 'POST',
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
});
