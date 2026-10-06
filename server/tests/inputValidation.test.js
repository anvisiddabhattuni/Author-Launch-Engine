/**
 * STORY-032 acceptance tests.
 *
 *   "Node/Express backend setup with trust controls" → scalable, performant and
 *       secure, with input validation using Joi and JWT authentication.
 *
 * JWT has existed since STORY-064. Input validation had not: no library, no
 * schema, and malformed input sent to every route came back as a 500 on 28 of
 * 77 — raw Postgres errors handed to the caller — while `POST /authors` with
 * `{ name: 123, email: ["x"] }` answered 201 and stored the email as the text
 * `{"x"}`.
 *
 * The test that carries the weight is the coverage one. Validation strips
 * undeclared fields, which is only safe if no handler reads a field its schema
 * forgot; so it reads every handler's source from the live router and fails on
 * the first one that does. Derived from the router, not a list — STORY-024's
 * lesson about hand-maintained coverage.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { router } from '../src/routes/index.js';

let server;
let base;
let admin;
let author;
let auditor;
let authorId;
let bookId;

const login = async (email, password) =>
  (await (await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json()).token;

const call = async (method, path, { token = admin, body, raw } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  admin = await login('ops@example.test', 'ops-password');
  author = await login('mira@example.test', 'quiet-craft');
  auditor = await login('auditor@example.test', 'compliance-only');
  const { rows } = await query("SELECT id, author_id FROM books WHERE author_id = (SELECT id FROM authors WHERE email = 'mira@example.test') LIMIT 1");
  bookId = Number(rows[0].id);
  authorId = Number(rows[0].author_id);
});

after(async () => {
  await query("DELETE FROM authors WHERE email LIKE 'validation-%@example.test'");
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

/** Every route, as the router serves it. */
const ROUTES = router.stack
  .filter((l) => l.route)
  .flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path, layer: l })));

describe('Scenario: malformed input is refused, never crashed on', () => {
  it('no route answers 5xx to garbage', async () => {
    const fill = (p) =>
      p.replace(':authorId', authorId).replace(':bookId', bookId).replace(':id', 'not-a-number').replace(':key', 'no-such-key');
    const garbage = [
      [1, 2, 3],
      { name: 123, email: ['x'], content: { nested: true }, themes: 'no', platforms: 7, limit: 'lots', active: 'maybe', count: -5 },
    ];
    const crashed = [];
    for (const r of ROUTES) {
      if (r.path === '/auth/login') continue;
      // Runs a whole worker cycle across every tenant and reads no input, so
      // garbage proves nothing here — and running it in the middle of the
      // suite claimed jobs and messages other suites were holding (jobs.test,
      // messageBus.test: intermittent failures in CI's triple run).
      if (r.method === 'POST' && r.path === '/jobs/tick') continue;
      if (r.method === 'GET') {
        const res = await call('GET', `${fill(r.path)}?authorId=abc&limit=-1&sinceHours=lots&bookId=zz&status=nope`);
        if (res.status >= 500) crashed.push(`GET ${r.path}: ${res.body?.error}`);
        continue;
      }
      for (const body of garbage) {
        const res = await call(r.method, fill(r.path), { body });
        if (res.status >= 500) crashed.push(`${r.method} ${r.path}: ${res.body?.error}`);
      }
    }
    // Was 28 routes before this story.
    assert.deepEqual(crashed, []);
  });

  it('refuses the author STORY-032 found being stored with an array for an email', async () => {
    const res = await call('POST', '/authors', { body: { name: 123, email: ['x'] } });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.some((d) => d.path === 'email'), 'the email field is not named');
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM authors WHERE email = '{"x"}'`);
    assert.equal(rows[0].n, 0, 'the array was stored as text');
  });

  it('names every wrong field, not just the first', async () => {
    const res = await call('POST', `/authors/${authorId}/books/${bookId}/milestones`, {
      body: { type: 'party', title: '', eventDate: 'next tuesday' },
    });
    assert.equal(res.status, 400);
    const fields = res.body.details.map((d) => d.path).sort();
    assert.deepEqual(fields, ['eventDate', 'title', 'type']);
  });

  it('a non-numeric id is a 400, not a Postgres error', async () => {
    const res = await call('POST', '/drafts/abc/approve', { token: author, body: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /params\.id must be a positive whole number/);
    assert.ok(!/bigint|syntax/.test(res.body.error), 'the database\'s own words reached the caller');
  });

  it('accepts what the product actually sends, converted to the declared type', async () => {
    const email = `validation-${Date.now()}@example.test`;
    const res = await call('POST', '/authors', { body: { name: '  Valid Author  ', email } });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Valid Author', 'strings are trimmed');
    const list = await call('GET', `/audit-log?limit=5&authorId=${authorId}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.length <= 5, 'limit arrived as a string and was not converted');
  });
});

describe('Scenario: authentication comes first, validation second', () => {
  it('an unauthenticated request with a bad body is a 401, not a lesson in the schema', async () => {
    const res = await call('POST', '/authors', { token: null, body: { name: 1 } });
    assert.equal(res.status, 401);
  });

  it('a request the caller may not make is a 403, whatever its body', async () => {
    // The first version validated before checking permission, so a compliance
    // session got a 400 describing the input rules of an action it cannot take.
    const res = await call('POST', '/meme-templates', { token: auditor, body: { key: 'BAD KEY' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.details, undefined);
  });

  it('a forged token is refused', async () => {
    const [h, p] = author.split('.');
    const res = await call('GET', '/drafts', { token: `${h}.${p}.forged-signature` });
    assert.equal(res.status, 401);
  });
});

describe('Coverage, derived from the router', () => {
  /** Fields a handler reads from one part of the request, found in its source. */
  const fieldsRead = (source, part) => {
    const found = new Set();
    for (const m of source.matchAll(new RegExp(`req\\.${part}\\??\\.(\\w+)`, 'g'))) found.add(m[1]);
    for (const m of source.matchAll(new RegExp(`const\\s*\\{([^{}]+)\\}\\s*=\\s*req\\.${part}\\b`, 'g'))) {
      for (const f of m[1].split(',')) {
        const key = f.split(/[=:]/)[0].trim();
        if (key) found.add(key);
      }
    }
    // `const body = req.body ?? {}` then `body.x`.
    // Only a whole-body alias — `const requested = req.body?.types` is a field
    // read, already caught above, and its value's methods are not fields.
    const alias = source.match(new RegExp(`const (\\w+) = req\\.${part}(\\s*\\?\\?\\s*\\{\\})?;`));
    if (alias) for (const m of source.matchAll(new RegExp(`\\b${alias[1]}\\??\\.(\\w+)`, 'g'))) found.add(m[1]);
    // `body[field]` over a literal list.
    if (alias) {
      const loop = source.match(new RegExp(`for \\(const \\w+ of \\[([^\\]]+)\\]\\)[^]*?${alias[1]}\\[`));
      if (loop) for (const k of loop[1].matchAll(/'(\w+)'/g)) found.add(k[1]);
    }
    return found;
  };

  const inspect = (r) => {
    const handlers = r.layer.route.stack.map((s) => s.handle);
    const source = handlers.map((h) => h.source ?? '').join('\n');
    const validator = handlers.find((h) => h.validates);
    return { source, validator };
  };

  it('every route that reads a body or query string validates that part', () => {
    const unguarded = [];
    for (const r of ROUTES) {
      const { source, validator } = inspect(r);
      for (const part of ['body', 'query']) {
        if (new RegExp(`req\\.${part}\\b`).test(source) && !validator?.validates.includes(part)) {
          unguarded.push(`${r.method} ${r.path} reads req.${part}`);
        }
      }
    }
    assert.deepEqual(unguarded, []);
  });

  it('no handler reads a field its schema does not declare — which is what makes stripping safe', () => {
    const undeclared = [];
    for (const r of ROUTES) {
      const { source, validator } = inspect(r);
      if (!validator) continue;
      for (const part of validator.validates) {
        const declared = new Set(Object.keys(validator.schemas[part].describe().keys ?? {}));
        for (const field of fieldsRead(source, part)) {
          if (!declared.has(field)) undeclared.push(`${r.method} ${r.path}: req.${part}.${field}`);
        }
      }
    }
    assert.deepEqual(undeclared, []);
  });

  it('the coverage scan can see a field it has not been told about', () => {
    // A scan that has never been seen to fail is not known to work.
    const src = "async (req) => { const { title, secret } = req.body; if (req.body?.other) {} const body = req.body ?? {}; body.third;";
    assert.deepEqual([...fieldsRead(src, 'body')].sort(), ['other', 'secret', 'third', 'title']);
  });
});
