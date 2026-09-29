import { createHash } from 'node:crypto';

import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { findAwaitingApproval } from '../agents/approvalNotificationAgent.js';
import { config } from '../config.js';
import { outsideTenantScope, pool } from '../db/pool.js';
import { actionPriority } from './attention.js';
import { governanceScore } from './governanceScore.js';

/**
 * The search index (STORY-055 / REQ-015, REQ-001, REQ-002) — Trust and
 * Monitoring Agent.
 *
 * The trust dashboard's logs and metrics, copied into Elasticsearch so they can
 * be searched and charted at volume. Postgres stays the record; the index is a
 * copy that can be rebuilt from it at any time, and is checked against it.
 *
 * What the index may hold is decided per source, below, and is only what was
 * already stored in the clear. The encrypted part of an audit entry (STORY-049)
 * never leaves Postgres — migration 047's functions read around it.
 *
 * The story names Logstash or Beats for ingestion. This is neither, on purpose:
 * Logstash would need the audit key to read the log at all, and a second place
 * holding the key is the thing STORY-049 exists to prevent; and a JVM beside
 * every deployment is a gigabyte of memory to do what a hundred lines here do
 * inside the worker that already runs every sweep.
 *
 * "No data loss or corruption" is checked, not assumed:
 *  - a batch advances the mark only after every document in it has been read
 *    back from the index and its digest matched the row it came from;
 *  - each run re-reads a window behind the mark, so a row that committed after
 *    a higher id was indexed is not skipped;
 *  - reconciliation compares counts to the mark and, on a difference, walks the
 *    ids to find and fill the gap — and samples digests to catch a document
 *    changed in the index after it was written.
 */

/** Every document carries these; `text` is what free-text search reads. */
const COMMON = {
  '@timestamp': { type: 'date' },
  id: { type: 'long' },
  author_id: { type: 'long' },
  digest: { type: 'keyword' },
  text: { type: 'text', analyzer: 'words' },
};
const kw = (copy = true) => (copy ? { type: 'keyword', copy_to: 'text' } : { type: 'keyword' });
const iso = (d) => new Date(d).toISOString();
const num = (v) => (v == null ? null : Number(v));

export const SOURCES = {
  audit: {
    index: 'ale-audit',
    label: 'Audit log',
    tenantVisible: true,
    // Not before, after or metadata: those are encrypted, and stay where the key is.
    fields: { actor: kw(), action: kw(), entity_type: kw(), entity_id: kw(), priority: kw(false) },
    read: (after, n, upto) => pool.query('SELECT * FROM audit_index_rows($1, $2, $3)', [after, n, upto]),
    count: async (upto) => Number((await pool.query('SELECT audit_index_count($1) AS n', [upto])).rows[0].n),
    toDoc: (r) => ({
      '@timestamp': iso(r.created_at), id: num(r.id), author_id: num(r.author_id),
      actor: r.actor, action: r.action, entity_type: r.entity_type, entity_id: r.entity_id ?? null,
      priority: actionPriority(r.action).priority,
    }),
  },
  access: {
    index: 'ale-access',
    label: 'Data access log',
    tenantVisible: true,
    // Not the email or the address of whoever asked: the user id links back.
    fields: { scope: kw(false), method: kw(), route: kw(), outcome: kw(), status: { type: 'integer' }, user_id: { type: 'long' }, duration_ms: { type: 'float' } },
    read: (after, n, upto) => pool.query(
      `SELECT id, occurred_at, author_id, user_id, scope, method, route, status, outcome, duration_ms
         FROM data_access_events WHERE id > $1 AND ($3::bigint IS NULL OR id <= $3) ORDER BY id LIMIT $2`,
      [after, n, upto],
    ),
    count: async (upto) => Number((await pool.query('SELECT COUNT(*) AS n FROM data_access_events WHERE id <= $1', [upto])).rows[0].n),
    toDoc: (r) => ({
      '@timestamp': iso(r.occurred_at), id: num(r.id), author_id: num(r.author_id), user_id: num(r.user_id),
      scope: r.scope, method: r.method, route: r.route, status: Number(r.status), outcome: r.outcome,
      duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    }),
  },
  security: {
    index: 'ale-security',
    label: 'Security log',
    // Staff only, as the log itself is (STORY-051).
    tenantVisible: false,
    fields: { method: kw(), route: kw(), outcome: kw(), status: { type: 'integer' }, user_id: { type: 'long' } },
    read: (after, n, upto) => pool.query('SELECT * FROM security_index_rows($1, $2, $3)', [after, n, upto]),
    count: async (upto) => Number((await pool.query('SELECT security_index_count($1) AS n', [upto])).rows[0].n),
    toDoc: (r) => ({
      '@timestamp': iso(r.occurred_at), id: num(r.id), author_id: num(r.author_id), user_id: num(r.user_id),
      method: r.method, route: r.route, outcome: r.outcome, status: Number(r.status),
    }),
  },
};

/** System metrics, one document per tenant per run: what the Grafana trends are drawn from (STORY-056). */
export const METRICS = {
  index: 'ale-metrics',
  fields: {
    governance_score: { type: 'float' },
    governance_capped: { type: 'boolean' },
    pending_approvals: { type: 'integer' },
    pending_high: { type: 'integer' },
    approved_24h: { type: 'integer' },
    rejected_24h: { type: 'integer' },
    approval_rate_24h: { type: 'float' },
    audit_entries_24h: { type: 'integer' },
    jobs_queued: { type: 'integer' },
    jobs_dead_letter: { type: 'integer' },
  },
};

/** The digest of a document: sha256 of its fields in a fixed order, without the digest itself. */
export function digestOf(doc) {
  const { digest, ...rest } = doc; // eslint-disable-line no-unused-vars
  const canonical = JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k] ?? null]));
  return createHash('sha256').update(canonical).digest('hex');
}
const sealDoc = (doc) => ({ ...doc, digest: digestOf(doc) });

/** The mapping for an index: strict, so a field nobody declared is refused rather than guessed at. */
export const mappingFor = (fields) => ({
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: { analyzer: { words: { type: 'pattern', pattern: '[^\\p{L}\\p{N}]+', lowercase: true } } },
  },
  mappings: { dynamic: 'strict', properties: { ...COMMON, ...fields } },
});

/** Bulk body: one index action per document, id from the source row, so re-indexing overwrites rather than duplicates. */
export const bulkBody = (index, docs, idOf = (d) => String(d.id)) =>
  `${docs.map((d) => `${JSON.stringify({ index: { _index: index, _id: idOf(d) } })}\n${JSON.stringify(d)}`).join('\n')}\n`;

/** Compares what was sent with what the index returned. Pure. */
export function compareDocs(sent, returned) {
  const byId = new Map(returned.filter((d) => d.found).map((d) => [d._id, d._source]));
  const missing = [];
  const corrupt = [];
  for (const [id, doc] of sent) {
    const got = byId.get(id);
    if (!got) missing.push(id);
    else if (got.digest !== doc.digest || digestOf(got) !== doc.digest) corrupt.push(id);
  }
  return { missing, corrupt };
}

// ---------------------------------------------------------------------------
// Talking to Elasticsearch
// ---------------------------------------------------------------------------

export class SearchUnavailable extends Error {
  constructor(message = 'The search index is not set up here: ELASTICSEARCH_URL is empty.') {
    super(message);
    this.status = 503;
  }
}

async function es(operation, method, path, body, { ndjson = false } = {}) {
  if (!config.elasticsearchUrl) throw new SearchUnavailable();
  return callExternal({
    service: 'elasticsearch',
    operation,
    fn: (signal) => httpJson(`${config.elasticsearchUrl}${path}`, {
      method,
      signal,
      headers: { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body == null ? undefined : ndjson ? body : JSON.stringify(body),
    }),
  });
}

async function ensureIndex(index, fields, { recreate = false } = {}) {
  // A wildcard, so a missing index is an empty list rather than a 404 the
  // gateway would count against the circuit.
  const listed = await es('index.exists', 'GET', `/_cat/indices/${index}*?format=json&h=index`);
  const exists = listed.some((i) => i.index === index);
  if (exists && !recreate) return false;
  if (exists) await es('index.delete', 'DELETE', `/${index}`);
  await es('index.create', 'PUT', `/${index}`, mappingFor(fields));
  return true;
}

async function writeAndVerify(index, docs, idOf) {
  let pending = docs;
  for (let attempt = 1; attempt <= 2 && pending.length; attempt += 1) {
    const bulk = await es('bulk', 'POST', '/_bulk', bulkBody(index, pending, idOf), { ndjson: true });
    const refused = bulk.errors ? bulk.items.filter((i) => i.index.error).map((i) => `${i.index._id}: ${i.index.error.reason}`) : [];
    if (refused.length && attempt === 2) throw new Error(`index refused ${refused.length} document(s): ${refused.slice(0, 3).join('; ')}`);
    // Read back: _mget is real-time, so no refresh is needed to check the write.
    const got = await es('mget', 'POST', `/${index}/_mget`, { ids: pending.map(idOf) });
    const { missing, corrupt } = compareDocs(
      pending.map((d) => [idOf(d), d]),
      got.docs,
    );
    const bad = new Set([...missing, ...corrupt]);
    pending = pending.filter((d) => bad.has(idOf(d)));
  }
  if (pending.length) throw new Error(`${pending.length} document(s) did not read back as written: ${pending.slice(0, 5).map(idOf).join(', ')}`);
  return docs.length;
}

async function syncRow(source) {
  const { rows } = await pool.query('SELECT * FROM search_sync WHERE source = $1', [source]);
  return rows[0] ?? null;
}

/** Ids the index holds in (from, to]. */
async function indexedIds(index, from, to) {
  const ids = new Set();
  let after = from;
  for (;;) {
    const r = await es('ids', 'POST', `/${index}/_search`, {
      size: 5000, _source: false, sort: [{ id: 'asc' }],
      query: { range: { id: { gt: after, lte: to } } },
    });
    const hits = r.hits.hits;
    for (const h of hits) ids.add(h._id);
    if (hits.length < 5000) return ids;
    after = Number(hits[hits.length - 1]._id);
  }
}

/** Indexes rows in (from, to] that the index does not hold. Returns how many it filled. */
async function fillGaps(src, from, to) {
  const have = await indexedIds(src.index, from, to);
  let filled = 0;
  let after = from;
  for (;;) {
    const { rows } = await src.read(after, 5000, to);
    if (!rows.length) return filled;
    const missing = rows.filter((r) => !have.has(String(r.id))).map((r) => sealDoc(src.toDoc(r)));
    if (missing.length) filled += await writeAndVerify(src.index, missing, (d) => String(d.id));
    after = Number(rows[rows.length - 1].id);
  }
}

/** One source: fill behind the mark, index what is new, verify each batch. */
async function aggregateSource(name, { batchSize, maxBatches }) {
  const src = SOURCES[name];
  const started = Date.now();
  let state = await syncRow(name);
  // A database with no mark has never been indexed. An index already there
  // came from another database (a reset, a restore) and its ids mean other
  // rows — so it is rebuilt, not trusted.
  const created = await ensureIndex(src.index, src.fields, { recreate: !state });
  if (!state) {
    ({ rows: [state] } = await pool.query(
      'INSERT INTO search_sync (source, index_name) VALUES ($1, $2) RETURNING *', [name, src.index],
    ));
  } else if (created) {
    // A mark with no index behind it: the index was lost (a new cluster, a
    // deleted volume). Everything up to the mark is re-indexed, and said so.
    ({ rows: [state] } = await pool.query(
      'UPDATE search_sync SET last_id = 0, indexed_total = 0, rebuilt_at = now() WHERE source = $1 RETURNING *', [name],
    ));
  }
  let mark = Number(state.last_id);
  const repaired = mark > 0 ? await fillGaps(src, Math.max(0, mark - config.searchLookbackIds), mark) : 0;

  let indexed = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const { rows } = await src.read(mark, batchSize, null);
    if (!rows.length) break;
    indexed += await writeAndVerify(src.index, rows.map((r) => sealDoc(src.toDoc(r))), (d) => String(d.id));
    mark = Number(rows[rows.length - 1].id);
    batches += 1;
    // The mark moves only here, after the batch read back intact.
    await pool.query(
      'UPDATE search_sync SET last_id = $2, indexed_total = indexed_total + $3, last_error = NULL WHERE source = $1',
      [name, mark, rows.length],
    );
  }
  await pool.query(
    `UPDATE search_sync SET last_run_at = now(), last_batch = $2, last_took_ms = $3,
            repaired_total = repaired_total + $4 WHERE source = $1`,
    [name, indexed, Date.now() - started, repaired],
  );
  return { source: name, index: src.index, indexed, repaired, mark, more: batches === maxBatches };
}

/**
 * One metrics document per tenant, and one across all of them. The governance
 * score is computed once, across tenants: it re-verifies every seal, and doing
 * that once per tenant per run would make the snapshot the heaviest thing the
 * worker does. Per-tenant documents carry the counts.
 */
export async function metricsDocs({ now = new Date() } = {}) {
  const { rows: authors } = await pool.query('SELECT id FROM authors ORDER BY id');
  const overall = await governanceScore({});
  const docs = [];
  for (const tenant of [...authors.map((a) => Number(a.id)), null]) {
    const t = (col) => (tenant ? `AND ${col} = ${tenant}` : '');
    const { rows: [a] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE a.decision = 'approved') AS approved,
              COUNT(*) FILTER (WHERE a.decision = 'rejected') AS rejected
         FROM approvals a
         LEFT JOIN drafts d ON d.id = a.draft_id
         LEFT JOIN outreach_messages o ON o.id = a.outreach_message_id
         LEFT JOIN pr_materials p ON p.id = a.pr_material_id
        WHERE a.created_at > $1::timestamptz - interval '24 hours' ${t('COALESCE(d.author_id, o.author_id, p.author_id)')}`,
      [now],
    );
    const { rows: [l] } = await pool.query(
      'SELECT audit_entries_since($1::timestamptz - interval \'24 hours\', $2) AS n',
      [now, tenant],
    );
    const { rows: [j] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued, COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead
         FROM jobs WHERE TRUE ${t('author_id')}`,
    );
    let waiting = { total: 0, byPriority: { high: 0 } };
    if (tenant) waiting = await findAwaitingApproval({ authorId: tenant });
    const decided = Number(a.approved) + Number(a.rejected);
    docs.push(sealDoc({
      '@timestamp': iso(now),
      id: null,
      author_id: tenant,
      governance_score: tenant ? null : overall.score,
      governance_capped: tenant ? null : overall.capped,
      pending_approvals: tenant ? waiting.total : null,
      pending_high: tenant ? waiting.byPriority.high : null,
      approved_24h: Number(a.approved),
      rejected_24h: Number(a.rejected),
      approval_rate_24h: decided ? Number((Number(a.approved) / decided).toFixed(3)) : null,
      audit_entries_24h: Number(l.n),
      jobs_queued: Number(j.queued),
      jobs_dead_letter: Number(j.dead),
    }));
  }
  return docs;
}
const metricId = (d) => `${d.author_id ?? 'all'}@${d['@timestamp']}`;

/**
 * The aggregation run: every log source, then a metrics snapshot, then a
 * refresh so searches see it. Run by the worker (`search.aggregate`).
 */
export async function aggregate({ batchSize = config.searchBatchSize, maxBatches = 100, now = new Date() } = {}) {
  return outsideTenantScope(async () => {
    const started = Date.now();
    const sources = [];
    for (const name of Object.keys(SOURCES)) {
      try {
        sources.push(await aggregateSource(name, { batchSize, maxBatches }));
      } catch (error) {
        // Any failure — the index unreachable, a batch that did not read back —
        // is on the record, and the mark stays where the last verified batch left it.
        await pool.query(
          `INSERT INTO search_sync (source, index_name, last_error, last_run_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (source) DO UPDATE SET last_error = EXCLUDED.last_error, last_run_at = now()`,
          [name, SOURCES[name].index, error.message],
        );
        throw error;
      }
    }
    await ensureIndex(METRICS.index, METRICS.fields);
    const metrics = await metricsDocs({ now });
    await writeAndVerify(METRICS.index, metrics, metricId);
    await es('refresh', 'POST', `/${[...Object.values(SOURCES).map((s) => s.index), METRICS.index].join(',')}/_refresh`);
    return { sources, metrics: metrics.length, tookMs: Date.now() - started };
  });
}

/**
 * Reconciliation: for each source, the rows Postgres holds up to the mark
 * against the documents the index holds up to it. A difference is found and
 * filled; a sample of documents is re-read and any that no longer match their
 * row is rewritten. Everything found is counted on `search_sync`.
 */
export async function reconcile({ sample = 200 } = {}) {
  return outsideTenantScope(async () => {
    const out = [];
    for (const [name, src] of Object.entries(SOURCES)) {
      const state = await syncRow(name);
      if (!state) continue;
      const mark = Number(state.last_id);
      const sourceCount = await src.count(mark);
      const countIn = async () => (await es('count', 'POST', `/${src.index}/_count`, { query: { range: { id: { lte: mark } } } })).count;
      let indexCount = await countIn();
      let filled = 0;
      if (indexCount < sourceCount) {
        filled = await fillGaps(src, 0, mark);
        await es('refresh', 'POST', `/${src.index}/_refresh`);
        indexCount = await countIn();
      }
      // Changed after it was written: re-read the latest `sample` rows and compare.
      const { rows } = await src.read(Math.max(0, mark - sample * 5), sample * 5, mark);
      const expected = rows.slice(-sample).map((r) => sealDoc(src.toDoc(r)));
      let rewritten = 0;
      if (expected.length) {
        const got = await es('mget', 'POST', `/${src.index}/_mget`, { ids: expected.map((d) => String(d.id)) });
        const { missing, corrupt } = compareDocs(expected.map((d) => [String(d.id), d]), got.docs);
        const bad = new Set([...missing, ...corrupt]);
        if (bad.size) rewritten = await writeAndVerify(src.index, expected.filter((d) => bad.has(String(d.id))), (d) => String(d.id));
      }
      await pool.query(
        `UPDATE search_sync SET reconciled_at = now(), source_count = $2, index_count = $3,
                repaired_total = repaired_total + $4 WHERE source = $1`,
        [name, sourceCount, indexCount, filled + rewritten],
      );
      out.push({ source: name, mark, sourceCount, indexCount, filled, rewritten, inSync: sourceCount === indexCount });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/**
 * Searches one tenant's logs. The tenant filter is added here, not taken from
 * the caller: the index has no tenant roles of its own, so this function is
 * where the tenant rule (STORY-017) holds for it.
 */
export async function searchTenant({ authorId, q = '', source = null, from = null, to = null, size = 50 }) {
  const names = source ? [source] : Object.keys(SOURCES).filter((s) => SOURCES[s].tenantVisible);
  for (const s of names) {
    if (!SOURCES[s]?.tenantVisible) throw Object.assign(new Error(`Not searchable per tenant: ${s}`), { status: 400 });
  }
  const filter = [{ term: { author_id: Number(authorId) } }];
  if (from || to) filter.push({ range: { '@timestamp': { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } });
  const started = Date.now();
  // The call runs outside the tenant's read-only transaction: the gateway's
  // record of it (api_interactions, the circuit) is a system write. What is
  // searched is still this tenant's, by the filter above.
  const r = await outsideTenantScope(() => es('search', 'POST', `/${names.map((s) => SOURCES[s].index).join(',')}/_search`, {
    size: Math.min(Number(size) || 50, 200),
    track_total_hits: true,
    sort: [{ '@timestamp': 'desc' }, { id: 'desc' }],
    query: {
      bool: {
        filter,
        ...(q.trim() ? { must: [{ simple_query_string: { query: q, fields: ['text'], default_operator: 'and' } }] } : {}),
      },
    },
    aggs: { bySource: { terms: { field: '_index' } } },
  }));
  const indexToSource = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [v.index, k]));
  return {
    query: { q, sources: names, from, to },
    took: r.took,
    elapsedMs: Date.now() - started,
    total: r.hits.total.value,
    bySource: Object.fromEntries(r.aggregations.bySource.buckets.map((b) => [indexToSource[b.key] ?? b.key, b.doc_count])),
    hits: r.hits.hits.map((h) => {
      const { digest, text, ...doc } = h._source; // eslint-disable-line no-unused-vars
      return { source: indexToSource[h._index], ...doc };
    }),
  };
}

/** Where the index has got, per source, and whether it matched at the last reconciliation. */
export async function searchStatus({ counts = true } = {}) {
  const { rows } = await outsideTenantScope(() => pool.query('SELECT * FROM search_sync ORDER BY source'));
  const sync = rows.map((r) => ({
    source: r.source,
    label: SOURCES[r.source]?.label ?? r.source,
    index: r.index_name,
    indexedThrough: Number(r.last_id),
    indexedTotal: Number(r.indexed_total),
    lastRunAt: r.last_run_at,
    lastBatch: r.last_batch,
    lastTookMs: r.last_took_ms,
    reconciledAt: r.reconciled_at,
    sourceCount: r.source_count == null ? null : Number(r.source_count),
    indexCount: r.index_count == null ? null : Number(r.index_count),
    inSync: r.source_count == null ? null : Number(r.source_count) === Number(r.index_count),
    repairedTotal: Number(r.repaired_total),
    rebuiltAt: r.rebuilt_at,
    lastError: r.last_error,
  })).map((s) => (counts ? s : {
    source: s.source, label: s.label, lastRunAt: s.lastRunAt, reconciledAt: s.reconciledAt, inSync: s.inSync, lastError: s.lastError ? 'failed' : null,
  }));
  if (!config.elasticsearchUrl) return { configured: false, sources: sync };
  const health = await outsideTenantScope(() => es('health', 'GET', '/_cluster/health')).catch((e) => ({ status: 'unreachable', error: e.message }));
  return { configured: true, cluster: { status: health.status, error: health.error ?? null }, sources: sync };
}
