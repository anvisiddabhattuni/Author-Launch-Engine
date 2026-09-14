/**
 * STORY-017 acceptance tests.
 *
 * The clause: multiple authors are using the platform, a new tenant is
 * onboarded, and the agent ensures data isolation and role-based access.
 *
 * The second block is the one that matters, and it exists because this story
 * found a real leak in code written two stories earlier. `tenantParam` guards
 * the *address* of a route — /authors/1/... is refused to author 2 — and says
 * nothing about the rows the handler then fetches. Signing in as one author and
 * asking for that author's own trust dashboard returned the last twenty audit
 * rows across every tenant.
 *
 * So the test walks the real API as one tenant and looks for another tenant's
 * data in the answers. It goes through HTTP for the same reason `routes.test.js`
 * does: a query a handler assembles itself is only exercised by a request.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ACTOR,
  onboardTenant,
  restoreTenant,
  suspendTenant,
  tenantTables,
  verifyIsolation,
} from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import {
  authorIdsIn,
  classifyRoutes,
  fillPath,
  surfaceCoverage,
} from '../src/services/tenantSurface.js';
import { closePool, query } from '../src/db/pool.js';

let server;
let baseUrl;
let mine;
let theirs;
let myToken;
let myBookId;
let stamp;

const asMe = (path) =>
  fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${myToken}` } });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  stamp = Date.now();

  const a = await onboardTenant({
    name: 'Isolation Mine',
    email: `iso-mine-${stamp}@example.test`,
    password: 'a-long-enough-password',
  });
  mine = a.author.id;

  const b = await onboardTenant({
    name: 'Isolation Theirs',
    email: `iso-theirs-${stamp}@example.test`,
    password: 'a-long-enough-password',
  });
  theirs = b.author.id;

  // Data that belongs unmistakably to the other tenant, in the tables the
  // routes below actually read.
  const { rows: book } = await query(
    `INSERT INTO books (author_id, title, content, themes) VALUES ($1,'Their Book','x',$2)
     RETURNING id`,
    [theirs, ['secret']],
  );
  await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status)
     VALUES ($1,$2,'twitter','THEIR PRIVATE DRAFT',0.9,'2026-07-06','pending_approval')`,
    [theirs, book[0].id],
  );
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, author_id, metadata)
     VALUES ('TheirAgent','their.private_action','draft','1',$1,'{}')`,
    [theirs],
  );
  await query(
    `INSERT INTO api_interactions
       (service, operation, call_id, attempt, outcome, duration_ms, author_id, error)
     VALUES ('their-provider','secret','c-${'' + Date.now()}',1,'failed',5,$1,'THEIR PRIVATE ERROR')`,
    [theirs],
  );

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `iso-mine-${stamp}@example.test`, password: 'a-long-enough-password' }),
  });
  myToken = (await login.json()).token;

  // The walk fills :bookId with a book this tenant owns, so a route scoped to a
  // book is exercised rather than skipped.
  const { rows: mineBook } = await query(
    `INSERT INTO books (author_id, title, content, themes) VALUES ($1,'My Book','y',$2)
     RETURNING id`,
    [mine, ['craft']],
  );
  myBookId = mineBook[0].id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await query('DELETE FROM authors WHERE id = ANY($1)', [[mine, theirs]]);
  await closePool();
});

describe('STORY-017: a tenant is onboarded with its isolation and role in place', () => {
  it('creates the author, the account and the role together', async () => {
    const email = `iso-new-${stamp}@example.test`;
    const { author, user } = await onboardTenant({
      name: 'Newly Onboarded',
      email,
      password: 'a-long-enough-password',
      role: 'author',
    });
    try {
      assert.equal(author.tenant_status, 'active');
      assert.ok(author.onboarded_at, 'and records when');
      assert.equal(user.role, 'author');
      assert.equal(Number(user.author_id ?? user.authorId), Number(author.id));
    } finally {
      await query('DELETE FROM authors WHERE id = $1', [author.id]);
    }
  });

  it('refuses a second tenant on the same address', async () => {
    await assert.rejects(
      () =>
        onboardTenant({
          name: 'Duplicate',
          email: `iso-mine-${stamp}@example.test`,
          password: 'a-long-enough-password',
        }),
      /already exists/,
    );
  });

  it('refuses a tenant nobody could sign in to', async () => {
    await assert.rejects(
      () => onboardTenant({ name: 'No Password', email: `np-${stamp}@example.test`, password: 'x' }),
      /at least 8 characters/,
    );
  });

  it('suspends without destroying what the tenant did', async () => {
    const { rows: before_ } = await query('SELECT COUNT(*)::int n FROM drafts WHERE author_id = $1', [
      theirs,
    ]);
    await suspendTenant({ authorId: theirs, reason: 'test' });
    const { rows: after_ } = await query('SELECT COUNT(*)::int n FROM drafts WHERE author_id = $1', [
      theirs,
    ]);
    assert.equal(after_[0].n, before_[0].n, 'the audit trail outlives the account');
    await restoreTenant({ authorId: theirs });
  });

  it('records onboarding against the agent the story names', async () => {
    const { rows } = await query(
      `SELECT actor, metadata FROM audit_log
        WHERE action = 'tenant.onboarded' AND author_id = $1`,
      [mine],
    );
    assert.equal(rows[0].actor, ACTOR);
    assert.equal(rows[0].metadata.accountCreated, true);
  });
});

describe('STORY-024: the walk is derived from the router, not a list', () => {
  /**
   * STORY-017 built this walk and it found two real leaks. It also kept its
   * routes in a hand-written array, and the array did not grow: measured at the
   * start of STORY-024, **10 of 35 GET routes were in it**. Everything added
   * since — /audit-log, the trust history, the on-demand press route — went
   * unwalked, which is exactly what STORY-017's own Known-gaps entry predicted
   * would happen.
   *
   * So the surface is read off `router.stack` now. A route added tomorrow is
   * walked tomorrow, and a route that cannot be walked has to say why in
   * `UNWALKABLE` where somebody can disagree with it.
   */
  const { walkable, declared, needsId, total } = classifyRoutes();

  it('accounts for every GET route, with nothing silently dropped', () => {
    const coverage = surfaceCoverage();
    assert.equal(coverage.unaccounted, 0, 'a route is neither walked nor explained');
    assert.equal(walkable.length + declared.length + needsId.length, total);
    // The number that regressed before: if this walk ever covers a smaller
    // share of the surface than it does today, something was added and not
    // accounted for.
    assert.ok(walkable.length >= 30, `only ${walkable.length} of ${total} routes are walkable`);
  });

  it('gives every unwalkable route a reason a person can argue with', () => {
    for (const { path, why } of declared) {
      assert.ok(why && why.length > 40, `${path} is excluded without a real reason`);
    }
  });

  for (const path of walkable) {
    it(`GET ${path} returns nothing belonging to another tenant`, async () => {
      const response = await asMe(fillPath(path, { authorId: mine, bookId: myBookId }));
      assert.ok(response.status < 500, `${path} answered ${response.status}`);
      if (response.status !== 200) return;

      const ids = authorIdsIn(await response.json());
      assert.ok(
        !ids.has(Number(theirs)),
        `${path} leaked tenant ${theirs}; saw ${[...ids].join(', ')}`,
      );
    });
  }

  it('GET /authors/:id/trust-dashboard returns nothing belonging to another tenant', async () => {
    // The exact route the leak was in. It was guarded — the path parameter is
    // checked — and it leaked anyway, because the handler queried audit_log
    // with no tenant filter at all.
    const response = await asMe(`/authors/${mine}/trust-dashboard`);
    assert.equal(response.status, 200);
    const body = await response.json();

    const foreign = body.recent.filter(
      (r) => r.author_id !== null && Number(r.author_id) !== Number(mine),
    );
    assert.deepEqual(foreign, [], 'recent actions must be this tenant’s or system-wide');
    assert.ok(!authorIdsIn(body).has(Number(theirs)), 'and nothing nested may name another tenant');
  });

  it('GET /authors/:id/awaiting-approval never shows another tenant’s queue', async () => {
    const response = await asMe(`/authors/${mine}/awaiting-approval`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(
      !body.items.some((i) => i.detail?.includes('THEIR PRIVATE DRAFT')),
      'the other tenant has a draft waiting and it is not this tenant’s business',
    );
  });

  it('still refuses to address another tenant directly', async () => {
    const byPath = await asMe(`/authors/${theirs}/books`);
    assert.equal(byPath.status, 403, 'the path parameter guard still works');
    const byQuery = await asMe(`/drafts?authorId=${theirs}`);
    assert.equal(byQuery.status, 403, 'and so does the query guard');
  });
});

describe('Isolation checked from outside the code that enforces it', () => {
  it('discovers the tenant tables from the schema, not from a list', async () => {
    const tables = await tenantTables();
    assert.ok(tables.length > 20, `${tables.length} tables carry author_id`);
    assert.ok(tables.includes('drafts'));
    // A hand-written list goes stale the first time somebody adds a table and
    // forgets — which is precisely the failure this check exists to catch.
    assert.ok(tables.includes('api_interactions'), 'including tables added late');
  });

  it('reports clean when nothing has escaped', async () => {
    const result = await verifyIsolation({});
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.leaked, 0);
    assert.ok(result.tablesChecked > 18);
  });

  it('does not call the audit log outliving a tenant a breach', async () => {
    // audit_log has no foreign key to authors on purpose: deleting an account
    // must not delete the record of what it did. The first version of this
    // check reported 1,868 such rows as orphans — a design decision read as a
    // fault, which is how a security check earns the right to be ignored.
    const result = await verifyIsolation({});
    assert.ok(result.excluded.includes('audit_log'));
    assert.ok(
      !result.findings.some((f) => f.table === 'audit_log'),
      'an exclusion nobody can see is indistinguishable from a check that never ran',
    );
  });

  it('records the check so "has this ever failed" is answerable', async () => {
    const { rows } = await query(
      'SELECT leaked_rows, tables_checked FROM isolation_checks ORDER BY id DESC LIMIT 1',
    );
    assert.equal(rows[0].leaked_rows, 0);
    assert.ok(rows[0].tables_checked > 18);
  });

  it('catches a child row claiming a different tenant than its parent', async () => {
    const { rows: book } = await query(
      `INSERT INTO books (author_id, title, content, themes) VALUES ($1,'Mine','x',$2) RETURNING id`,
      [mine, ['x']],
    );
    // A draft that says it is one tenant's while its book belongs to another.
    // No code path should produce this, which is why a check that only reads
    // requests would never see it.
    const { rows: draft } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status)
       VALUES ($1,$2,'twitter','crossed',0.9,'2026-07-06','pending_approval') RETURNING id`,
      [theirs, book[0].id],
    );
    try {
      const result = await verifyIsolation({});
      assert.equal(result.ok, false);
      const finding = result.findings.find((f) => f.kind === 'cross_tenant_parent');
      assert.ok(finding, JSON.stringify(result.findings));
      assert.match(finding.detail, /claim a different tenant/);
    } finally {
      await query('DELETE FROM drafts WHERE id = $1', [draft[0].id]);
      await query('DELETE FROM books WHERE id = $1', [book[0].id]);
    }
    assert.equal((await verifyIsolation({})).ok, true, 'and clears once removed');
  });
});
