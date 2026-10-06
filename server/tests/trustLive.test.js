/**
 * STORY-057 and STORY-058 acceptance tests.
 *
 * STORY-057:
 *   Pending approvals and recent actions are displayed with timestamps and
 *   priority levels; a user with pending approvals is notified prominently.
 * STORY-058:
 *   A governance score is calculated with a breakdown of contributing factors,
 *   and reflects the most recent data.
 *
 * Measured before: the dashboard showed pending approvals as counts by kind,
 * recent actions as a time of day, no priorities, no notice to the person who
 * decides; and its "score" was the share of checks passing — whether the rules
 * held, not what the system did.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { prioritise } from '../src/agents/approvalNotificationAgent.js';
import { createApp } from '../src/app.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { actionPriority } from '../src/services/attention.js';
import { recordAction } from '../src/services/auditLog.js';
import { combine, INVARIANT_CAP } from '../src/services/governanceScore.js';

const stamp = Date.now();
let server;
let base;
let tenant;
const as = {};
let book;

const call = async (headers, path) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
const draft = async (status, hoursAgo) => (await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of, created_at)
   VALUES ($1,$2,'twitter','x',$3,0.9,CURRENT_DATE, now() - make_interval(hours => $4)) RETURNING id`,
  [tenant.author.id, book.id, status, hoursAgo],
)).rows[0].id;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Live Author', email: `live-${stamp}@example.test`, password: 'live-password-1' });
  as.author = await bearer(`live-${stamp}@example.test`, 'live-password-1');
  as.compliance = await bearer('auditor@example.test', 'compliance-only');
  book = (await query("INSERT INTO books (author_id, title, content, themes) VALUES ($1,'B','x','{craft}') RETURNING id", [tenant.author.id])).rows[0];
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [tenant.author.id]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('STORY-057: pending approvals and recent actions, with timestamps and priority', () => {
  it('each waiting item carries a timestamp and a priority with its reason, most urgent first', async () => {
    const fresh = await draft('pending_approval', 1);
    const old = await draft('pending_approval', 60);
    const flagged = await draft('escalated', 2);
    const r = await call(as.author, `/authors/${tenant.author.id}/attention`);
    assert.equal(r.status, 200);
    const byId = new Map(r.body.awaiting.items.map((i) => [i.id, i]));
    assert.equal(byId.get(Number(flagged)).priority, 'high');
    assert.match(byId.get(Number(flagged)).priorityReason, /escalated/);
    assert.equal(byId.get(Number(old)).priority, 'high');
    assert.match(byId.get(Number(old)).priorityReason, /two days/);
    assert.equal(byId.get(Number(fresh)).priority, 'normal');
    assert.ok(byId.get(Number(fresh)).createdAt);
    const order = r.body.awaiting.items.map((i) => i.priority);
    assert.deepEqual(order, [...order].sort((a, b) => ['high', 'medium', 'normal'].indexOf(a) - ['high', 'medium', 'normal'].indexOf(b)));
  });

  it('priority rules at their edges', () => {
    const at = (hours, escalated = false) => prioritise({ createdAt: new Date(Date.now() - hours * 3_600_000), escalated }).priority;
    assert.equal(at(23), 'normal');
    assert.equal(at(25), 'medium');
    assert.equal(at(49), 'high');
    assert.equal(at(0, true), 'high');
  });

  it('recent actions carry a full timestamp and a priority by what happened', async () => {
    await recordAction({ actor: 'Live Author', action: 'draft.rejected', entityType: 'draft', entityId: '1', authorId: tenant.author.id });
    await recordAction({ actor: 'TrustMonitoringAgent', action: 'governance.breach', entityType: 'check', authorId: tenant.author.id });
    const r = await call(as.author, `/authors/${tenant.author.id}/attention`);
    // Found by what they are, not by position: a worker tick in another suite
    // can record something for this author in between (seen once in six runs).
    const latest = r.body.recentActions.find((x) => x.action === 'governance.breach');
    const previous = r.body.recentActions.find((x) => x.action === 'draft.rejected');
    assert.match(latest.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(latest.priority, 'high');
    assert.equal(previous.priority, 'medium');
    assert.equal(actionPriority('book.uploaded').priority, 'normal');
  });

  it('the person who decides is told, in words, how much waits and how urgently', async () => {
    const r = await call(as.author, `/authors/${tenant.author.id}/attention`);
    assert.match(r.body.forYou.message, /^3 items waiting for your approval — 2 high priority, oldest 2 days$/);
  });

  it('someone who cannot approve is not told to', async () => {
    const r = await call(as.compliance, `/authors/${tenant.author.id}/attention`);
    assert.equal(r.status, 200);
    assert.equal(r.body.forYou, null);
  });

  it('only the tenant, or those who read across tenants', async () => {
    const other = await onboardTenant({ name: 'Live Other', email: `live-other-${stamp}@example.test`, password: 'live-other-pass' });
    try {
      const otherToken = await bearer(`live-other-${stamp}@example.test`, 'live-other-pass');
      assert.equal((await call(otherToken, `/authors/${tenant.author.id}/attention`)).status, 403);
    } finally {
      await query('DELETE FROM authors WHERE id = $1', [other.author.id]);
    }
  });
});

describe('STORY-058: a governance score, with its breakdown, from the latest data', () => {
  it('the formula: weighted factors, no-data factors left out and their weight shared', () => {
    const r = combine({
      checks: { n: 9, d: 10 }, honoured: { n: 10, d: 10 }, audited: { n: 1, d: 1 },
      reliability: { n: 0, d: 0 }, timeliness: { n: 1, d: 1 }, integrity: { n: 2, d: 2 },
    });
    const reliability = r.factors.find((f) => f.id === 'reliability');
    assert.equal(reliability.noData, true);
    assert.equal(reliability.effectiveWeight, 0);
    const weights = r.factors.reduce((a, f) => a + f.effectiveWeight, 0);
    assert.ok(Math.abs(weights - 1) < 0.01, `weights sum to ${weights}`);
    // checks at 90% with weight 0.25/0.85; everything else perfect
    assert.equal(r.score, Math.round((0.9 * (0.25 / 0.85) + (0.6 / 0.85)) * 100));
  });

  it('a broken invariant caps it, and says which', () => {
    const r = combine({ checks: { n: 10, d: 10 }, honoured: { n: 10, d: 10 } }, { invariantsBroken: ['gate.posts'] });
    assert.equal(r.capped, true);
    assert.equal(r.score, INVARIANT_CAP * 100);
    assert.equal(r.uncapped, 100);
    assert.match(r.capReason, /gate\.posts/);
  });

  it('served with every factor\'s measurement — for the author, of their tenant', async () => {
    const r = await call(as.author, `/authors/${tenant.author.id}/governance-score`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.factors.map((f) => f.id), ['checks', 'honoured', 'audited', 'reliability', 'timeliness', 'integrity']);
    for (const f of r.body.factors) assert.ok('measured' in f && 'effectiveWeight' in f && f.detail.length > 0, f.id);
    const timeliness = r.body.factors.find((f) => f.id === 'timeliness');
    assert.equal(timeliness.measured.d, 3, 'the three drafts above are the tenant\'s waiting items');
    assert.equal(timeliness.measured.n, 2, 'one of them has waited more than two days');
  });

  it('reflects the most recent data: a post published without approval lowers it at once', async () => {
    const before = (await call(as.author, `/authors/${tenant.author.id}/governance-score`)).body;
    const honouredBefore = before.factors.find((f) => f.id === 'honoured');
    // A post that went out with no approval on record — the thing the gate forbids.
    const d = await draft('approved', 1);
    // `sim-`: the house mark for a simulated row (STORY-013). The global
    // gate.posts invariant ignores it, so other suites running alongside do
    // not see this test's deliberate breach (found in CI's third repeated run);
    // the score's own factor counts every published post, so it still sees it.
    await ownerQuery(
      `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status, published_at, external_id)
       VALUES ($1,$2,'twitter', now(), 'published', now(), $3)`,
      [d, tenant.author.id, `sim-trustlive-${stamp}`],
    );
    const afterScore = (await call(as.author, `/authors/${tenant.author.id}/governance-score`)).body;
    const honouredAfter = afterScore.factors.find((f) => f.id === 'honoured');
    assert.equal(honouredAfter.measured.d, honouredBefore.measured.d + 1);
    assert.equal(honouredAfter.measured.n, honouredBefore.measured.n, 'an unapproved post was counted as honoured');
    assert.ok(new Date(afterScore.computedAt) > new Date(before.computedAt));
  });
});
