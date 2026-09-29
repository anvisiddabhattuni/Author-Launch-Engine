/**
 * STORY-055 acceptance tests — the search index, live.
 *
 *   Given multiple sources of audit logs and system metrics,
 *   when the aggregation runs,
 *   then the data is indexed and searchable in under a second.
 *
 *   Given data ingested from PostgreSQL,
 *   when the aggregation completes,
 *   then no data is lost or corrupted.
 *
 * Measured before: the trust dashboard read its logs straight from Postgres,
 * twenty rows at a time, with no search and no time range; nothing was indexed
 * anywhere.
 *
 * The live scenarios need an Elasticsearch: set ELASTICSEARCH_URL (the `search`
 * job in CI starts one). Without it they are skipped — said, not passed — and
 * only the "not set up here" behaviour is tested.
 *
 * SEARCH_VOLUME sets how many audit rows the volume test writes (default 2000;
 * CI uses 20000).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, pool, query } from '../src/db/pool.js';
import { recordAction } from '../src/services/auditLog.js';
import { SOURCES, aggregate, reconcile, searchStatus } from '../src/services/searchIndex.js';

const ES = config.elasticsearchUrl;
const live = ES ? false : 'ELASTICSEARCH_URL is not set — no index to test against';
const VOLUME = Number(process.env.SEARCH_VOLUME ?? 2000);
const stamp = Date.now();

let server;
let base;
let tenant;
let other;
const as = {};

const call = async (headers, path) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
const raw = async (method, path, body) => {
  const r = await fetch(`${ES}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
};
const sync = async (source) => (await ownerQuery('SELECT * FROM search_sync WHERE source = $1', [source])).rows[0];
const maxAuditId = async () => Number((await ownerQuery('SELECT MAX(id) AS m FROM audit_log_sealed')).rows[0].m);
const resetCircuit = () => ownerQuery("DELETE FROM integration_circuits WHERE service = 'elasticsearch'");

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Search Author', email: `search-${stamp}@example.test`, password: 'search-password-1' });
  other = await onboardTenant({ name: 'Search Other', email: `search-other-${stamp}@example.test`, password: 'search-password-2' });
  as.author = await bearer(`search-${stamp}@example.test`, 'search-password-1');
  as.other = await bearer(`search-other-${stamp}@example.test`, 'search-password-2');
  if (ES) await resetCircuit();
});

after(async () => {
  for (const t of [tenant, other]) await query('DELETE FROM authors WHERE id = $1', [t.author.id]);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('STORY-055: where no index is set up', () => {
  it('searching says so — 503 with the reason — rather than returning nothing', async () => {
    const saved = config.elasticsearchUrl;
    config.elasticsearchUrl = '';
    try {
      const r = await call(as.author, `/authors/${tenant.author.id}/search?q=approved`);
      assert.equal(r.status, 503);
      assert.match(r.body.error, /ELASTICSEARCH_URL/);
      const s = await call(as.author, `/authors/${tenant.author.id}/search/status`);
      assert.equal(s.status, 200);
      assert.equal(s.body.configured, false);
    } finally {
      config.elasticsearchUrl = saved;
    }
  });

  it('only the tenant, or those who read across tenants', async () => {
    assert.equal((await call(as.other, `/authors/${tenant.author.id}/search`)).status, 403);
  });
});

describe('STORY-055: aggregated from several sources, searchable in under a second', { skip: live }, () => {
  it(`indexes the audit log (${VOLUME} new rows), the data access log, the security log and a metrics snapshot`, async () => {
    const id = tenant.author.id;
    // Volume, written the way the application writes: through the encrypting view.
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, author_id, metadata, created_at)
       SELECT 'Search Author', (ARRAY['draft.approved','draft.rejected','post.published','outreach.sent','governance.breach'])[1 + g % 5],
              'draft', (g % 97)::text, $1, jsonb_build_object('n', g), now() - make_interval(mins => g % 10080)
         FROM generate_series(1, $2) g`,
      [id, VOLUME],
    );
    const { rows: [user] } = await ownerQuery('SELECT id FROM users WHERE author_id = $1 LIMIT 1', [id]);
    await query(
      `INSERT INTO data_access_events (user_id, author_id, scope, method, route, path, status, outcome, duration_ms)
       SELECT $2, $1, 'tenant', 'GET', '/authors/:authorId/drafts', '/x', CASE WHEN g % 10 = 0 THEN 403 ELSE 200 END,
              CASE WHEN g % 10 = 0 THEN 'denied' ELSE 'allowed' END, 1 + g % 40 FROM generate_series(1, 200) g`,
      [id, user.id],
    );

    const newest = await maxAuditId();
    let run;
    do {
      run = await aggregate({});
    } while (run.sources.some((s) => s.more));

    for (const name of Object.keys(SOURCES)) {
      const s = await sync(name);
      assert.ok(s, `${name} has a mark`);
      assert.equal(s.last_error, null, `${name}: ${s.last_error}`);
    }
    // The run writes audit rows of its own (the score's seal check), so the mark
    // is compared with the newest row from before it started.
    assert.ok(Number((await sync('audit')).last_id) >= newest, 'the audit mark reached the newest row');
    assert.ok(run.metrics >= 3, 'a metrics document per tenant and one overall');

    const checked = await reconcile({});
    for (const c of checked) assert.equal(c.inSync, true, `${c.source}: ${c.sourceCount} rows, ${c.indexCount} documents`);
  });

  it('the index holds no encrypted field — no before, after or metadata', async () => {
    const mapping = await raw('GET', '/ale-audit/_mapping');
    const fields = Object.keys(mapping['ale-audit'].mappings.properties);
    for (const f of ['before', 'after', 'metadata']) assert.ok(!fields.includes(f), f);
  });

  it('finds the right rows: every approval of this tenant, and only this tenant\'s', async () => {
    const expected = Number((await ownerQuery(
      "SELECT COUNT(*) AS n FROM audit_log_sealed WHERE tenant_id = $1 AND action = 'draft.approved'", [tenant.author.id],
    )).rows[0].n);
    const r = await call(as.author, `/authors/${tenant.author.id}/search?q=draft%20approved&source=audit&size=200`);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, expected);
    assert.ok(r.body.hits.every((h) => h.author_id === Number(tenant.author.id) && h.action === 'draft.approved'));
    const theirs = await call(as.other, `/authors/${other.author.id}/search?q=draft%20approved`);
    assert.equal(theirs.body.total, 0, 'another tenant sees none of it');
  });

  it('with a time range', async () => {
    const from = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = await call(as.author, `/authors/${tenant.author.id}/search?source=audit&from=${from}`);
    const expected = Number((await ownerQuery(
      'SELECT COUNT(*) AS n FROM audit_log_sealed WHERE tenant_id = $1 AND created_at >= $2', [tenant.author.id, from],
    )).rows[0].n);
    assert.equal(r.body.total, expected);
    assert.ok(r.body.hits.every((h) => h['@timestamp'] >= from));
  });

  it('answers in under a second — every one of 40 varied queries, end to end through the API', async () => {
    const queries = ['', 'approved', 'rejected', 'breach', 'post published', 'outreach', 'draft 42', 'nothing-matches-this'];
    const ranges = [null, 1, 24, 24 * 7];
    const timings = [];
    for (let i = 0; i < 40; i += 1) {
      const q = queries[i % queries.length];
      const hours = ranges[i % ranges.length];
      const from = hours ? `&from=${new Date(Date.now() - hours * 3600_000).toISOString()}` : '';
      const started = Date.now();
      const r = await call(as.author, `/authors/${tenant.author.id}/search?q=${encodeURIComponent(q)}${from}`);
      timings.push({ q, hours, wall: Date.now() - started, took: r.body.took });
      assert.equal(r.status, 200);
    }
    timings.sort((a, b) => b.wall - a.wall);
    console.log(`# search timings over ${VOLUME}+ documents: slowest ${timings[0].wall} ms (index ${timings[0].took} ms), median ${timings[20].wall} ms`);
    for (const t of timings) assert.ok(t.wall < 1000, `"${t.q}" over ${t.hours ?? 'all'} h took ${t.wall} ms`);
  });
});

describe('STORY-055: no data lost or corrupted', { skip: live }, () => {
  it('documents deleted from the index are found missing and restored', async () => {
    const ids = (await ownerQuery('SELECT id FROM audit_log_sealed WHERE tenant_id = $1 ORDER BY id LIMIT 5', [tenant.author.id])).rows.map((r) => String(r.id));
    for (const id of ids) await raw('DELETE', `/ale-audit/_doc/${id}?refresh=true`);
    const before = (await reconcile({})).find((c) => c.source === 'audit');
    assert.equal(before.filled, 5);
    assert.equal(before.inSync, true);
    const back = await raw('POST', '/ale-audit/_mget', { ids });
    assert.ok(back.docs.every((d) => d.found));
  });

  it('a document changed in the index is caught by its digest and rewritten from Postgres', async () => {
    const id = String((await sync('audit')).last_id);
    await raw('POST', `/ale-audit/_update/${id}?refresh=true`, { doc: { action: 'draft.approved', actor: 'someone else' } });
    const r = (await reconcile({})).find((c) => c.source === 'audit');
    assert.ok(r.rewritten >= 1);
    const doc = await raw('GET', `/ale-audit/_doc/${id}`);
    const row = (await ownerQuery('SELECT actor FROM audit_log_sealed WHERE id = $1', [id])).rows[0];
    assert.equal(doc._source.actor, row.actor);
  });

  it('a row that commits after a higher one was indexed is not skipped', async () => {
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      const { rows: [late] } = await slow.query(
        "INSERT INTO audit_log (actor, action, entity_type, author_id) VALUES ('late', 'draft.approved', 'draft', $1) RETURNING id", [tenant.author.id],
      );
      await recordAction({ actor: 'early', action: 'draft.approved', entityType: 'draft', authorId: tenant.author.id });
      await aggregate({}); // the mark passes the late row's id while it is still uncommitted
      assert.ok(Number((await sync('audit')).last_id) > Number(late.id));
      await slow.query('COMMIT');
      await aggregate({});
      const doc = await raw('GET', `/ale-audit/_doc/${late.id}`);
      assert.equal(doc.found, true, 'the late row was skipped');
    } finally {
      slow.release();
    }
  });

  it('an index that is lost entirely is rebuilt from the start, not resumed from the mark', async () => {
    await raw('DELETE', '/ale-access');
    await aggregate({});
    const s = await sync('access');
    assert.ok(s.rebuilt_at, 'the rebuild is on the record');
    const count = await raw('POST', '/ale-access/_count', {});
    const rows = Number((await ownerQuery('SELECT COUNT(*) AS n FROM data_access_events')).rows[0].n);
    assert.equal(count.count, rows);
  });

  it('when the index is down, the mark does not move and the failure is recorded', async () => {
    const saved = config.elasticsearchUrl;
    const markBefore = Number((await sync('audit')).last_id);
    await recordAction({ actor: 'while down', action: 'draft.approved', entityType: 'draft', authorId: tenant.author.id });
    config.elasticsearchUrl = 'http://127.0.0.1:9';
    try {
      await assert.rejects(aggregate({}));
    } finally {
      config.elasticsearchUrl = saved;
      await resetCircuit();
    }
    const s = await sync('audit');
    assert.equal(Number(s.last_id), markBefore);
    assert.ok(s.last_error);
    const newest = await maxAuditId();
    await aggregate({});
    assert.ok(Number((await sync('audit')).last_id) >= newest, 'and it catches up once back');
  });

  it('the status shows each source in sync, with what was repaired', async () => {
    await reconcile({});
    const status = await searchStatus();
    assert.equal(status.configured, true);
    for (const s of status.sources) assert.equal(s.inSync, true, s.source);
    assert.ok(status.sources.find((s) => s.source === 'audit').repairedTotal >= 6);
    const author = await call(as.author, `/authors/${tenant.author.id}/search/status`);
    assert.equal(author.body.sources[0].indexCount, undefined, 'counts across tenants are not shown to an author');
  });
});
