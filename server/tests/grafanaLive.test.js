/**
 * STORY-056 acceptance tests — the trust dashboard in Grafana, live.
 *
 *   Given the index is populated, when the dashboard is opened, then
 *   interactive visualisations of metrics and trends are shown for a
 *   user-defined time range.
 *
 *   Given a user on the dashboard, when they customise a panel, then the
 *   change is saved and reflected immediately.
 *
 * Measured before: the Trust tab drew nothing over time — every figure was the
 * value now — and nobody could change what it showed.
 *
 * Needs GRAFANA_URL and GRAFANA_ADMIN_PASSWORD, and an index filled by the
 * aggregation (the `search` job in CI runs tests/searchLive.test.js first).
 * Skipped without them. Run a second time with GRAFANA_AFTER_RESTART=1, after
 * restarting Grafana, to check a saved change outlived the restart.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const G = (process.env.GRAFANA_URL ?? '').replace(/\/+$/, '');
const skip = G && process.env.GRAFANA_ADMIN_PASSWORD ? false : 'GRAFANA_URL is not set — no Grafana to test against';
const afterRestart = process.env.GRAFANA_AFTER_RESTART === '1';
const CUSTOM_TITLE = 'Governance score — customised by the editor';

const basic = (user, pass) => ({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
const admin = () => basic('admin', process.env.GRAFANA_ADMIN_PASSWORD);
const api = async (headers, method, path, body) => {
  const r = await fetch(`${G}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const provisioned = JSON.parse(readFileSync(new URL('../../deploy/helm/author-launch-engine/files/grafana/dashboards/trust.json', import.meta.url), 'utf8'));

/** Runs one panel's queries through Grafana, as the panel would, for a time range. */
const runPanel = (panel, from, to) => api(admin(), 'POST', '/api/ds/query', {
  from: String(from), to: String(to),
  queries: panel.targets.map((t) => ({ ...t, query: t.query.replaceAll('$tenant', '*'), intervalMs: 3600_000, maxDataPoints: 500 })),
});
const points = (res) => Object.values(res.body?.results ?? {}).flatMap((r) => r.frames ?? [])
  .reduce((n, f) => n + (f.data?.values?.[1]?.filter((v) => v != null).length ?? 0), 0);

const users = {};
async function ensureUser(login, role) {
  const password = `${login}-password-1`;
  const made = await api(admin(), 'POST', '/api/admin/users', { name: login, login, email: `${login}@example.test`, password });
  const id = made.body?.id ?? (await api(admin(), 'GET', `/api/users/lookup?loginOrEmail=${login}`)).body.id;
  await api(admin(), 'PATCH', `/api/org/users/${id}`, { role });
  users[login] = basic(login, password);
}

describe('STORY-056: the trust dashboard in Grafana', { skip }, () => {
  before(async () => {
    await ensureUser('ale-editor', 'Editor');
    await ensureUser('ale-viewer', 'Viewer');
  });

  if (afterRestart) {
    it('a saved change outlives a restart of Grafana', async () => {
      const d = await api(users['ale-editor'], 'GET', '/api/dashboards/uid/ale-trust');
      assert.equal(d.body.dashboard.panels.find((p) => p.id === 1).title, CUSTOM_TITLE);
    });
    return;
  }

  it('is provisioned with every panel, and each data source answers', async () => {
    const d = await api(users['ale-viewer'], 'GET', '/api/dashboards/uid/ale-trust');
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.dashboard.panels.map((p) => p.title).sort(), provisioned.panels.map((p) => p.title).sort());
    for (const uid of ['ale-audit', 'ale-access', 'ale-security', 'ale-metrics']) {
      const h = await api(admin(), 'GET', `/api/datasources/uid/${uid}/health`);
      assert.equal(h.body?.status, 'OK', `${uid}: ${JSON.stringify(h.body)}`);
    }
  });

  it('every panel\'s query returns without error, and the trends have points, over a chosen range', async () => {
    const to = Date.now();
    const from = to - 30 * 24 * 3600_000;
    for (const panel of provisioned.panels) {
      const r = await runPanel(panel, from, to);
      assert.equal(r.status, 200, `${panel.title}: ${JSON.stringify(r.body).slice(0, 300)}`);
      for (const [ref, res] of Object.entries(r.body.results)) assert.ok(!res.error, `${panel.title} ${ref}: ${res.error}`);
    }
    const audit = provisioned.panels.find((p) => p.title.startsWith('Audit log entries'));
    assert.ok(points(await runPanel(audit, from, to)) > 0, 'audit entries over the last 30 days');
    const score = provisioned.panels.find((p) => p.title.startsWith('Governance score'));
    assert.ok(points(await runPanel(score, from, to)) > 0, 'governance score snapshots');
  });

  it('the time range is the user\'s: a range before any data shows none', async () => {
    const audit = provisioned.panels.find((p) => p.title.startsWith('Audit log entries'));
    const r = await runPanel(audit, Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 2));
    assert.equal(r.status, 200);
    assert.equal(points(r), 0);
  });

  it('an editor customises a panel and the time range; saved, and reflected at once', async () => {
    const before = (await api(users['ale-editor'], 'GET', '/api/dashboards/uid/ale-trust')).body;
    const dashboard = structuredClone(before.dashboard);
    dashboard.panels.find((p) => p.id === 1).title = CUSTOM_TITLE;
    dashboard.time = { from: 'now-24h', to: 'now' };
    const saved = await api(users['ale-editor'], 'POST', '/api/dashboards/db', {
      dashboard, folderUid: before.meta.folderUid, overwrite: false, message: 'STORY-056 test: customise a panel',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const now = (await api(users['ale-viewer'], 'GET', '/api/dashboards/uid/ale-trust')).body.dashboard;
    assert.equal(now.panels.find((p) => p.id === 1).title, CUSTOM_TITLE, 'another user sees it immediately');
    assert.deepEqual(now.time, { from: 'now-24h', to: 'now' });
    assert.equal(now.version, before.dashboard.version + 1);
  });

  it('a viewer can look and change the time range on screen, but cannot save over the dashboard', async () => {
    const current = (await api(users['ale-viewer'], 'GET', '/api/dashboards/uid/ale-trust')).body;
    const dashboard = { ...current.dashboard, title: 'Viewer was here' };
    const r = await api(users['ale-viewer'], 'POST', '/api/dashboards/db', { dashboard, folderUid: current.meta.folderUid, overwrite: true });
    assert.equal(r.status, 403);
  });

  it('anyone not signed in sees nothing', async () => {
    const r = await api({}, 'GET', '/api/dashboards/uid/ale-trust');
    assert.equal(r.status, 401);
  });
});
