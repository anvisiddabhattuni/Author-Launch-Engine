/**
 * STORY-064 acceptance tests.
 *
 * The story's three Gherkin scenarios are the first three `describe` blocks:
 * a real user can sign in and sees only their own tenant; an approval names the
 * person who made it; no session means 401 and nothing happens.
 *
 * The fourth block covers the tenant boundary in the places the URL does not
 * name an author — which is where this story's own first implementation leaked:
 * router-level middleware runs before Express populates `req.params`, so a check
 * written against `req.params.authorId` passed every request, and
 * `GET /authors/2/books` came back 200 for the wrong tenant.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import jwt from 'jsonwebtoken';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial } from '../src/services/approvals.js';
import { hashPassword, upsertUser, verifyPassword } from '../src/services/auth.js';
import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';

let server;
let baseUrl;
let mine = {};
let theirs = {};
let adminToken;

const stamp = Date.now();

const req = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* empty body */
  }
  return { status: response.status, body: payload };
};

const signIn = async (email, password) =>
  req('/auth/login', { method: 'POST', body: { email, password } });

/** A tenant: an author, a book, a login. */
async function makeTenant(label, password) {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [`${label} Author`, `${label}-${stamp}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes)
     VALUES ($1,$2,'Attention is a muscle. Craft is slow and quiet.',$3) RETURNING *`,
    [a[0].id, `${label} Book`, ['deep work', 'craft']],
  );
  const email = `${label}-user-${stamp}@example.test`;
  const user = await upsertUser({
    email,
    name: `${label} Person`,
    password,
    role: 'author',
    authorId: a[0].id,
  });
  const { body } = await signIn(email, password);
  return { author: a[0], book: b[0], user, email, password, token: body.token };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  mine = await makeTenant('Mine', 'mine-password');
  theirs = await makeTenant('Theirs', 'theirs-password');

  await upsertUser({
    email: `admin-${stamp}@example.test`,
    name: 'Operator',
    password: 'admin-password',
    role: 'admin',
  });
  ({ body: { token: adminToken } = {} } = await signIn(
    `admin-${stamp}@example.test`,
    'admin-password',
  ));
});

after(async () => {
  await query('DELETE FROM authors WHERE id = ANY($1)', [[mine.author?.id, theirs.author?.id]]);
  await query('DELETE FROM users WHERE email LIKE $1', [`%-${stamp}@example.test`]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('STORY-064: a real user can sign in', () => {
  it('Given a seeded account, When they sign in, Then they receive a session', async () => {
    const { status, body } = await signIn(mine.email, mine.password);
    assert.equal(status, 200);
    assert.ok(body.token, 'no session token was issued');
    assert.equal(body.user.role, 'author');
    assert.equal(Number(body.user.authorId), Number(mine.author.id));
  });

  it('and the session never carries the password hash', async () => {
    const { body } = await signIn(mine.email, mine.password);
    assert.equal(body.user.password_hash, undefined);
    assert.ok(!JSON.stringify(body).includes('scrypt'));
  });

  it('Then they can only see their own tenant data', async () => {
    const { status, body } = await req('/authors', { token: mine.token });
    assert.equal(status, 200);
    assert.equal(body.length, 1, 'an author should see exactly one author: themselves');
    assert.equal(Number(body[0].id), Number(mine.author.id));
  });

  it('refuses a wrong password and an unknown email identically', async () => {
    const wrong = await signIn(mine.email, 'not-the-password');
    const missing = await signIn(`nobody-${stamp}@example.test`, 'not-the-password');
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(
      wrong.body.error,
      missing.body.error,
      'the response must not reveal which emails have accounts',
    );
  });

  it('records a failed attempt without recording the password', async () => {
    await signIn(mine.email, 'still-not-the-password');
    const { rows } = await query(
      "SELECT * FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(rows[0]);
    assert.equal(rows[0].metadata.reason, 'bad password');
    assert.ok(!JSON.stringify(rows[0]).includes('still-not-the-password'));
  });

  it('refuses a deactivated account', async () => {
    await query('UPDATE users SET active = FALSE WHERE id = $1', [theirs.user.id]);
    const { status } = await signIn(theirs.email, theirs.password);
    assert.equal(status, 401);
    await query('UPDATE users SET active = TRUE WHERE id = $1', [theirs.user.id]);
  });
});

describe('STORY-064: approval is attributable', () => {
  let draft;

  before(async () => {
    const drafts = await draftWeeklyPosts({
      authorId: mine.author.id,
      bookId: mine.book.id,
      count: 1,
    });
    draft = drafts[0];
  });

  it('When a signed-in user approves, Then the log records WHO, not just that', async () => {
    const { status } = await req(`/drafts/${draft.id}/approve`, {
      method: 'POST',
      token: mine.token,
      body: { notes: 'Fine to go.' },
    });
    assert.equal(status, 200);

    const { rows } = await query(
      "SELECT * FROM audit_log WHERE entity_type = 'draft' AND entity_id = $1 AND action = 'draft.approved'",
      [String(draft.id)],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, mine.user.name, 'the actor is the authenticated user');
    assert.equal(Number(rows[0].metadata.userId), Number(mine.user.id));
    assert.equal(rows[0].metadata.role, 'author');
    assert.equal(rows[0].metadata.attributable, true);
  });

  it('and the approvals row points at the account, not just a typed name', async () => {
    const { rows } = await query('SELECT * FROM approvals WHERE draft_id = $1', [draft.id]);
    assert.equal(Number(rows[0].user_id), Number(mine.user.id));
    assert.equal(rows[0].reviewer, mine.user.name);
  });

  it('cannot be spoofed by sending a different name in the body', async () => {
    const drafts = await draftWeeklyPosts({
      authorId: mine.author.id,
      bookId: mine.book.id,
      count: 1,
    });
    const target = drafts.find((d) => d.status !== 'approved') ?? drafts[0];

    await req(`/drafts/${target.id}/approve`, {
      method: 'POST',
      token: mine.token,
      body: { reviewer: 'Somebody Else Entirely', actor: 'Somebody Else Entirely' },
    });

    const { rows } = await query('SELECT * FROM approvals WHERE draft_id = $1', [target.id]);
    assert.equal(
      rows[0].reviewer,
      mine.user.name,
      'the identity comes from the session, never from the request body',
    );
  });

  it('marks a decision made with no session as unattributable rather than hiding it', async () => {
    // Internal callers — the demo, a test — reach the service directly. The
    // decision is still recorded; it just cannot claim an identity it does not
    // have, and the log says so.
    const { rows: material } = await query(
      `SELECT p.* FROM pr_materials p WHERE p.author_id = $1 AND p.status = 'pending_approval'
        ORDER BY p.id LIMIT 1`,
      [mine.author.id],
    );
    if (!material[0]) return;

    await approvePrMaterial({ materialId: material[0].id, reviewer: 'Direct Caller' });
    const { rows } = await query(
      `SELECT * FROM audit_log WHERE entity_type = 'pr_material' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [String(material[0].id)],
    );
    assert.equal(rows[0].metadata.attributable, false);
    assert.equal(rows[0].metadata.userId, null);
  });
});

describe('STORY-064: unauthenticated access is refused', () => {
  it('Given no session, When a protected endpoint is called, Then it returns 401', async () => {
    for (const path of ['/drafts', '/press-kits', '/audit-log', '/authors', '/notifications']) {
      const { status } = await req(path);
      assert.equal(status, 401, `${path} answered without a session`);
    }
  });

  it('and nothing is drafted, published or approved', async () => {
    const countDrafts = async () => {
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM drafts WHERE author_id = $1', [
        mine.author.id,
      ]);
      return rows[0].n;
    };
    const before = await countDrafts();

    const attempts = [
      req(`/authors/${mine.author.id}/books/${mine.book.id}/drafts`, { method: 'POST' }),
      req('/scheduled-posts/publish-due', { method: 'POST' }),
      req(`/drafts/1/approve`, { method: 'POST' }),
    ];
    for (const attempt of attempts) {
      assert.equal((await attempt).status, 401);
    }
    assert.equal(await countDrafts(), before, 'an unauthenticated call changed data');
  });

  it('leaves the health check public, so a deploy can still be probed', async () => {
    const { status } = await req('/health');
    assert.equal(status, 200);
  });

  it('refuses a token that was not signed by this server', async () => {
    const forged = jwt.sign({ sub: '1', role: 'admin', authorId: null }, 'some-other-secret', {
      issuer: 'author-launch-engine',
    });
    assert.equal((await req('/drafts', { token: forged })).status, 401);
  });

  it('refuses an unsigned token claiming alg:none', async () => {
    // The classic JWT forgery: swap the algorithm for "none" and drop the
    // signature. Pinning algorithms at verify time is what stops it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ sub: '1', role: 'admin', authorId: null, iss: 'author-launch-engine' }),
    ).toString('base64url');
    assert.equal((await req('/drafts', { token: `${header}.${claims}.` })).status, 401);
  });

  it('refuses an expired session', async () => {
    const expired = jwt.sign(
      { sub: String(mine.user.id), name: mine.user.name, role: 'author', authorId: Number(mine.author.id) },
      config.jwtSecret,
      { issuer: 'author-launch-engine', expiresIn: '-1s' },
    );
    const { status, body } = await req('/drafts', { token: expired });
    assert.equal(status, 401);
    assert.match(body.error, /expired/);
  });
});

describe('The tenant boundary', () => {
  it('refuses another tenant named in the path', async () => {
    // The regression that shipped in this story's first implementation.
    const { status } = await req(`/authors/${theirs.author.id}/books`, { token: mine.token });
    assert.equal(status, 403, 'a path tenant must be checked, not only a query one');
  });

  it('refuses another tenant named in the query string', async () => {
    const { status } = await req(`/drafts?authorId=${theirs.author.id}`, { token: mine.token });
    assert.equal(status, 403);
  });

  it('refuses a resource whose id names no tenant at all', async () => {
    const { status, body } = await req(`/books/${theirs.book.id}/themes`, { token: mine.token });
    // 403 before STORY-041; 404 since, because inside the caller's tenant
    // schema another author's book does not exist. Either refuses — 404 also
    // declines to confirm the id belongs to somebody. What must never happen
    // is a 200 carrying their themes.
    assert.ok([403, 404].includes(status), `expected a refusal, got ${status}`);
    assert.ok(!body?.themes?.length, 'another tenant\'s themes were served');
  });

  it('refuses to approve work belonging to another tenant', async () => {
    const drafts = await draftWeeklyPosts({
      authorId: theirs.author.id,
      bookId: theirs.book.id,
      count: 1,
    });
    const { status } = await req(`/drafts/${drafts[0].id}/approve`, {
      method: 'POST',
      token: mine.token,
    });
    assert.equal(status, 403);

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [drafts[0].id]);
    assert.notEqual(rows[0].status, 'approved', 'the refusal must also not have acted');
  });

  it('fills in the tenant when a list route omits it, rather than serving everything', async () => {
    const { body } = await req('/drafts', { token: mine.token });
    const authors = new Set(body.map((d) => Number(d.author_id)));
    assert.ok(
      authors.size <= 1 && !authors.has(Number(theirs.author.id)),
      `a bare list route leaked tenants: ${[...authors]}`,
    );
  });

  it('lets an admin read across tenants', async () => {
    const { status, body } = await req(`/authors/${theirs.author.id}/books`, { token: adminToken });
    assert.equal(status, 200);
    assert.ok(body.length > 0);
  });
});

describe('Password storage', () => {
  it('never stores the password itself', async () => {
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [mine.user.id]);
    assert.ok(!rows[0].password_hash.includes(mine.password));
    assert.match(rows[0].password_hash, /^scrypt\$/);
  });

  it('salts, so the same password does not produce the same hash', async () => {
    const [a, b] = await Promise.all([hashPassword('identical'), hashPassword('identical')]);
    assert.notEqual(a, b);
    assert.ok(await verifyPassword('identical', a));
    assert.ok(await verifyPassword('identical', b));
  });

  it('rejects a near miss', async () => {
    const hash = await hashPassword('correct-horse');
    assert.equal(await verifyPassword('correct-hors', hash), false);
    assert.equal(await verifyPassword('Correct-Horse', hash), false);
  });
});
