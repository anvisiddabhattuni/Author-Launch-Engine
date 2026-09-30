/**
 * STORY-056 — the provisioned dashboard agrees with the index it reads.
 *
 * A Grafana panel that names a field the index does not have draws an empty
 * chart and no error: the dashboard looks fine and shows nothing. So every
 * field a panel aggregates or filters on is checked against the mapping the
 * aggregation (STORY-055) writes, and every data source against the ones
 * provisioned. The live test (tests/grafanaLive.test.js) then runs each query.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { METRICS, SOURCES, mappingFor } from '../../src/services/searchIndex.js';

const dir = new URL('../../../deploy/helm/author-launch-engine/files/grafana/', import.meta.url);
const dashboard = JSON.parse(readFileSync(new URL('dashboards/trust.json', dir), 'utf8'));
const allDatasources = YAML.parse(readFileSync(new URL('datasources/elasticsearch.yaml', dir), 'utf8')).datasources;
// The index-backed ones; Prometheus (STORY-062) is checked separately below.
const datasources = allDatasources.filter((d) => d.type === 'elasticsearch');
const provider = YAML.parse(readFileSync(new URL('dashboards/provider.yaml', dir), 'utf8')).providers[0];

const fieldsOf = (index) => {
  const src = Object.values(SOURCES).find((s) => s.index === index) ?? (METRICS.index === index ? METRICS : null);
  return new Set(Object.keys(mappingFor(src.fields).mappings.properties));
};

describe('STORY-056: the trust dashboard, as provisioned', () => {
  it('every data source points at an index the aggregation fills', () => {
    const indices = [...Object.values(SOURCES).map((s) => s.index), METRICS.index].sort();
    assert.deepEqual(datasources.map((d) => d.jsonData.index).sort(), indices);
    for (const d of datasources) assert.equal(d.jsonData.timeField, '@timestamp', d.uid);
  });

  it('every field a panel aggregates, groups or filters on exists in that index', () => {
    const byUid = Object.fromEntries(datasources.map((d) => [d.uid, d.jsonData.index]));
    for (const panel of dashboard.panels) {
      for (const t of panel.targets) {
        const index = byUid[t.datasource.uid];
        assert.ok(index, `${panel.title}: unknown data source ${t.datasource.uid}`);
        const fields = fieldsOf(index);
        const used = [
          ...t.metrics.map((m) => m.field).filter(Boolean),
          ...t.bucketAggs.map((b) => b.field),
          ...[...t.query.matchAll(/(?:_exists_:|\b)([a-z_@][\w@]*):/g)].map((m) => m[1]).filter((f) => f !== '_exists_'),
        ];
        for (const f of used) assert.ok(fields.has(f), `${panel.title}: "${f}" is not a field of ${index}`);
      }
    }
  });

  it('has a time range the user can change, and a tenant filter', () => {
    assert.ok(dashboard.time.from && dashboard.time.to);
    assert.equal(dashboard.templating.list[0].name, 'tenant');
    assert.ok(dashboard.panels.some((p) => p.targets.some((t) => t.query.includes('$tenant'))));
  });

  it('is editable and a saved change is kept, not overwritten from the file', () => {
    assert.equal(dashboard.editable, true);
    assert.equal(provider.allowUiUpdates, true);
    assert.equal(provider.disableDeletion, true);
  });

  it('charts the metrics the story names: approval rates, audit entries, governance scores', () => {
    const titles = dashboard.panels.map((p) => p.title).join(' | ');
    for (const want of [/approval rate/i, /audit log entries/i, /governance score/i]) assert.match(titles, want);
  });

  it('STORY-062: the scalability dashboard reads Prometheus, and only metrics the API exports', async () => {
    const scal = JSON.parse(readFileSync(new URL('dashboards/scalability.json', dir), 'utf8'));
    assert.ok(allDatasources.some((d) => d.uid === 'ale-prometheus' && d.type === 'prometheus'));
    const { registry } = await import('../../src/services/metrics.js');
    const exported = new Set((await registry.getMetricsAsJSON()).map((m) => m.name));
    for (const panel of scal.panels) {
      for (const t of panel.targets) {
        assert.equal(t.datasource.uid, 'ale-prometheus', panel.title);
        for (const name of (t.expr.match(/\bale_[a-z0-9_]+/g) ?? []).map((n) => n.replace(/_(bucket|count|sum)$/, ''))) {
          assert.ok(exported.has(name), `${panel.title}: ${name} is not exported`);
        }
      }
    }
  });
});
