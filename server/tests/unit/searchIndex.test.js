/**
 * STORY-055 — the pure parts of the search index: what a document is, how it
 * is sealed, and how a read-back is judged. No database, no Elasticsearch.
 * The live behaviour (volume, query time, loss and repair) is in
 * tests/searchLive.test.js, which runs where an index exists.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOURCES, bulkBody, compareDocs, digestOf, mappingFor } from '../../src/services/searchIndex.js';

const row = { id: '41', actor: 'Mira', action: 'draft.approved', entity_type: 'draft', entity_id: '7', author_id: '1', created_at: new Date('2026-09-01T10:00:00Z') };

describe('STORY-055: documents for the index', () => {
  it('an audit document holds the clear columns only — never before, after or metadata', () => {
    const doc = SOURCES.audit.toDoc({ ...row, before: { secret: 1 }, after: { secret: 2 }, metadata: { email: 'x@y' } });
    assert.deepEqual(Object.keys(doc).sort(), ['@timestamp', 'action', 'actor', 'author_id', 'entity_id', 'entity_type', 'id', 'priority']);
    assert.equal(doc.id, 41, 'ids as numbers, not the strings pg returns for BIGINT');
    assert.equal(doc['@timestamp'], '2026-09-01T10:00:00.000Z');
    assert.equal(doc.priority, 'medium');
  });

  it('every field a source writes is declared in its mapping, which refuses undeclared ones', () => {
    const samples = {
      audit: row,
      access: { id: 1, occurred_at: new Date(), author_id: 1, user_id: 2, scope: 'tenant', method: 'GET', route: '/x', status: 200, outcome: 'allowed', duration_ms: '1.5' },
      security: { id: 1, occurred_at: new Date(), author_id: 1, user_id: 2, method: 'GET', route: '/x', outcome: 'denied', status: 403 },
    };
    for (const [name, src] of Object.entries(SOURCES)) {
      const m = mappingFor(src.fields);
      assert.equal(m.mappings.dynamic, 'strict', name);
      const declared = Object.keys(m.mappings.properties);
      for (const field of Object.keys(src.toDoc(samples[name]))) assert.ok(declared.includes(field), `${name}.${field} not mapped`);
      assert.ok(declared.includes('digest'));
    }
  });

  it('the security log is not searchable per tenant, as it is not readable per tenant', () => {
    assert.equal(SOURCES.security.tenantVisible, false);
  });
});

describe('STORY-055: digests and read-back', () => {
  const doc = SOURCES.audit.toDoc(row);
  const sealed = { ...doc, digest: digestOf(doc) };

  it('the digest ignores key order and itself, and changes with any field', () => {
    const reordered = Object.fromEntries(Object.entries(sealed).reverse());
    assert.equal(digestOf(reordered), sealed.digest);
    assert.notEqual(digestOf({ ...doc, action: 'draft.rejected' }), sealed.digest);
    assert.notEqual(digestOf({ ...doc, author_id: 2 }), sealed.digest);
  });

  it('a read-back finds what is missing and what came back different', () => {
    const other = { ...sealed, id: 42 };
    const sent = [['41', sealed], ['42', { ...other, digest: digestOf(other) }], ['43', sealed]];
    const returned = [
      { _id: '41', found: true, _source: sealed },
      // Stored with its old digest but a changed field: caught by re-hashing, not by trusting the stored digest.
      { _id: '42', found: true, _source: { ...other, action: 'tampered', digest: digestOf(other) } },
      { _id: '43', found: false },
    ];
    assert.deepEqual(compareDocs(sent, returned), { missing: ['43'], corrupt: ['42'] });
  });

  it('bulk: one action line per document, keyed by the source id, so a re-run overwrites instead of duplicating', () => {
    const body = bulkBody('ale-audit', [sealed]);
    const [action, source] = body.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(action, { index: { _index: 'ale-audit', _id: '41' } });
    assert.equal(source.digest, sealed.digest);
    assert.ok(body.endsWith('\n'), 'the bulk API needs the trailing newline');
  });
});
