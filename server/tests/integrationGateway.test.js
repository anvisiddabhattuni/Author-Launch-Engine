/**
 * STORY-038 acceptance tests.
 *
 *   "API gateway monitors external API integrations" → given multiple external
 *       APIs, when the gateway manages requests and responses, the system
 *       ensures reliability and performance of all integrations.
 *   "Handling gateway failures" → when routing fails, the system logs the
 *       failure and alerts the administrator.
 *
 * STORY-016 built `callExternal` and its header said every outbound call went
 * through it — "the social platforms, the email provider, the directory
 * search, and the Anthropic content API". Measured before this story, the
 * directory search did not: three directories, called directly, with no
 * timeout, no retry, no record, and absent from the Trust tab. One policy
 * applied to everything. A failure was logged and nobody was told, and a dead
 * provider was retried on every call for as long as it stayed dead.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { callExternal, integrationHealth } from '../src/agents/apiIntegrationAgent.js';
import { PLATFORMS } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { directories, searchAllDirectories } from '../src/services/directories.js';
import { runChecks } from '../src/services/governance.js';
import { INTEGRATIONS, registerIntegration, routeFor } from '../src/services/integrationRoutes.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const nosleep = () => Promise.resolve();
const stamp = Date.now();

/** Every .js file under src, recursively. */
async function sources(dir = src) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(p)));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const unavailable = () => Object.assign(new Error('503 Service Unavailable'), { status: 503 });

before(async () => {
  // Only this suite's circuits: other suites running alongside keep their own.
  await query(
    "DELETE FROM integration_circuits WHERE service LIKE 'circuit-%' OR service LIKE 'mailish-%' OR service = 'podcastIndex'",
  );
});

after(async () => {
  // Only this suite's circuits: other suites running alongside keep their own.
  await query(
    "DELETE FROM integration_circuits WHERE service LIKE 'circuit-%' OR service LIKE 'mailish-%' OR service = 'podcastIndex'",
  );
  await closePool();
});

describe('Scenario: every integration is routed through the gateway, with its own policy', () => {
  it('no production code calls out except through the gateway', async () => {
    // The gateway's own HTTP helper, and the health monitor probing *our own*
    // instances (STORY-027) — which is not an external integration and must
    // not be circuit-broken: a probe that stopped probing would hide the outage.
    const EXEMPT = new Set(['agents/apiIntegrationAgent.js', 'services/healthMonitoring.js', 'demo.js']);
    const offenders = [];
    for (const file of await sources()) {
      const rel = file.slice(src.length + 1);
      if (EXEMPT.has(rel)) continue;
      const code = codeOnly(await readFile(file, 'utf8'));
      if (/\bfetch\(|https?\.request\(|axios|\bgot\(/.test(code)) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
  });

  it('every adapter module goes through callExternal', async () => {
    const ADAPTERS = ['services/emailApi.js', 'services/socialApis.js', 'services/directories.js',
      'ai/anthropicProvider.js', 'ai/prAnthropicProvider.js', 'ai/outreachAnthropicProvider.js'];
    for (const rel of ADAPTERS) {
      assert.match(codeOnly(await readFile(join(src, rel), 'utf8')), /callExternal\(/, `${rel} bypasses the gateway`);
    }
  });

  it('every service the code names is declared, and only tests register their own', async () => {
    for (const p of PLATFORMS) assert.ok(INTEGRATIONS[p], `platform ${p} undeclared`);
    for (const d of Object.values(directories)) assert.ok(INTEGRATIONS[d.name], `directory ${d.name} undeclared`);
    const offenders = [];
    for (const file of await sources()) {
      const rel = file.slice(src.length + 1);
      const code = codeOnly(await readFile(file, 'utf8'));
      for (const m of code.matchAll(/callExternal\(\{\s*service:\s*'([^']+)'/g)) {
        if (!INTEGRATIONS[m[1]] && rel !== 'demo.js') offenders.push(`${rel}: ${m[1]}`);
      }
      if (/registerIntegration\(/.test(code) && !['services/integrationRoutes.js', 'demo.js'].includes(rel)) {
        offenders.push(`${rel} registers an integration at runtime`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('refuses an integration nobody declared', async () => {
    await assert.rejects(
      () => callExternal({ service: 'someNewApi', operation: 'x', fn: async () => 1 }),
      /not a declared integration/,
    );
  });

  it('applies each integration\'s own policy', () => {
    // A 10s ceiling suits email and abandons an AI generation that takes 20.
    assert.equal(routeFor('anthropic').timeoutMs, 180_000);
    assert.equal(routeFor('anthropic').maxAttempts, 2);
    assert.ok(routeFor('email').timeoutMs < routeFor('anthropic').timeoutMs);
    assert.equal(routeFor('podcastIndex').kind, 'directory');
  });

  it('the directory search now goes through it, and is on the record', async () => {
    const since = new Date(Date.now() - 1000);
    const listings = await searchAllDirectories({});
    assert.ok(listings.length > 0);
    const { rows } = await query(
      `SELECT DISTINCT service FROM api_interactions WHERE created_at >= $1 AND operation = 'search' ORDER BY service`,
      [since],
    );
    assert.deepEqual(rows.map((r) => r.service), ['eventFinder', 'podcastIndex', 'speakerBureau']);
  });

  it('the dashboard lists every declared integration, called or not', async () => {
    const health = await integrationHealth({ sinceHours: 1 });
    const listed = new Set(health.map((h) => h.service));
    for (const service of Object.keys(INTEGRATIONS)) assert.ok(listed.has(service), `${service} missing from the panel`);
    const anthropic = health.find((h) => h.service === 'anthropic');
    assert.equal(anthropic.policy.timeoutMs, 180_000);
    assert.equal(anthropic.circuit.state, 'closed');
  });
});

describe('Scenario: a failing integration is detected, logged, and the administrator alerted', () => {
  const SERVICE = `circuit-${stamp}`;
  let clock = new Date('2026-09-26T12:00:00Z');
  const now = () => clock;
  let calls = 0;
  const failing = async () => { calls += 1; throw unavailable(); };
  const call = (fn) => callExternal({ service: SERVICE, operation: 'ping', fn, maxAttempts: 1, sleep: nosleep, now });

  before(() => {
    registerIntegration(SERVICE, { failureThreshold: 2, cooldownMs: 60_000 });
  });

  it('one failure is not an outage', async () => {
    await assert.rejects(() => call(failing), /503/);
    const { rows } = await query('SELECT state, consecutive_failures FROM integration_circuits WHERE service = $1', [SERVICE]);
    assert.equal(rows[0].state, 'closed');
    assert.equal(rows[0].consecutive_failures, 1);
  });

  it('repeated failure opens the circuit and alerts the operators once', async () => {
    await assert.rejects(() => call(failing), /503/);
    const { rows } = await query('SELECT state, alerted_at FROM integration_circuits WHERE service = $1', [SERVICE]);
    assert.equal(rows[0].state, 'open');
    assert.notEqual(rows[0].alerted_at, null, 'nobody was told');

    const entries = await listAuditLog({ entityType: 'integration', limit: 50 });
    assert.ok(entries.find((e) => e.action === 'integration.circuit_opened' && e.entity_id === SERVICE));
    const alerted = entries.find((e) => e.action === 'integration.alerted' && e.entity_id === SERVICE);
    assert.ok(alerted, 'the administrator was not alerted');
    assert.ok(alerted.metadata.operators.includes('ops@example.test'));
  });

  it('while open, the provider is not called at all — and that is logged as its own outcome', async () => {
    const before = calls;
    await assert.rejects(() => call(failing), /circuit is open/);
    assert.equal(calls, before, 'the gateway still called a provider it knows is down');
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM api_interactions WHERE service = $1 AND outcome = 'short_circuited'",
      [SERVICE],
    );
    assert.equal(rows[0].n, 1);

    // And it is not counted as a call. The first screenshot of this panel
    // showed a refused call as traffic to a dead provider.
    const panel = (await integrationHealth({ sinceHours: 1 })).find((h) => h.service === SERVICE);
    assert.equal(panel.calls, 2, 'a call that was never made was counted as one');
    assert.equal(panel.short_circuited, 1);
  });

  it('after the cooldown one trial goes through, and a failed trial reopens without paging again', async () => {
    clock = new Date(clock.getTime() + 61_000);
    await assert.rejects(() => call(failing), /503/);
    const entries = await listAuditLog({ entityType: 'integration', limit: 50 });
    const alerts = entries.filter((e) => e.action === 'integration.alerted' && e.entity_id === SERVICE);
    assert.equal(alerts.length, 1, 'a failed trial paged the operators again');
    const { rows } = await query('SELECT state FROM integration_circuits WHERE service = $1', [SERVICE]);
    assert.equal(rows[0].state, 'open');
  });

  it('a successful trial closes it, and says how long it was down', async () => {
    clock = new Date(clock.getTime() + 61_000);
    assert.equal(await call(async () => 'ok'), 'ok');
    const { rows } = await query('SELECT state, consecutive_failures FROM integration_circuits WHERE service = $1', [SERVICE]);
    assert.equal(rows[0].state, 'closed');
    assert.equal(rows[0].consecutive_failures, 0);
    const closed = (await listAuditLog({ entityType: 'integration', limit: 50 }))
      .find((e) => e.action === 'integration.circuit_closed' && e.entity_id === SERVICE);
    assert.ok(closed.metadata.downForSeconds > 0);
  });

  it('a provider answering "no" is not a provider that is down', async () => {
    // A 400 for a post that is too long is the provider working. Counting it
    // would let one bad draft take a platform offline for everybody.
    const rejects = async () => { throw Object.assign(new Error('400 too long'), { status: 400 }); };
    for (let i = 0; i < 5; i += 1) await assert.rejects(() => call(rejects), /400/);
    const { rows } = await query('SELECT state, consecutive_failures FROM integration_circuits WHERE service = $1', [SERVICE]);
    assert.equal(rows[0].state, 'closed');
    assert.equal(rows[0].consecutive_failures, 0);
  });

  it('an email outage cannot be announced by email, and says so instead', async () => {
    const MAIL = `mailish-${stamp}`;
    registerIntegration(MAIL, { failureThreshold: 1, alertable: false });
    await assert.rejects(() => callExternal({ service: MAIL, operation: 'send', fn: failing, maxAttempts: 1, sleep: nosleep }));
    const entry = (await listAuditLog({ entityType: 'integration', limit: 50 }))
      .find((e) => e.action === 'integration.alert_unreachable' && e.entity_id === MAIL);
    assert.ok(entry, 'the unannounceable outage was not recorded');
    assert.equal(routeFor('email').alertable, false, 'the real email route must not try to email about itself');
  });
});

describe('One integration down does not take the feature down', () => {
  it('the scout still returns the other directories\' listings, and the panel shows why there are fewer', async () => {
    await query(
      `INSERT INTO integration_circuits (service, state, consecutive_failures, opened_at, last_error)
       VALUES ('podcastIndex', 'open', 3, now(), '503 from the directory')
       ON CONFLICT (service) DO UPDATE SET state = 'open', opened_at = now()`,
    );
    try {
      const listings = await searchAllDirectories({});
      assert.ok(listings.length > 0, 'one directory down emptied the scout');
      assert.ok(listings.every((l) => l.type !== 'podcast'), 'a short-circuited directory still returned listings');

      const check = (await runChecks({})).find((c) => c.id === 'integrations.circuits_closed');
      assert.equal(check.passed, false, 'the Trust tab did not notice');
      const panel = (await integrationHealth({ sinceHours: 1 })).find((h) => h.service === 'podcastIndex');
      assert.equal(panel.circuit.state, 'open');
    } finally {
      await query("DELETE FROM integration_circuits WHERE service = 'podcastIndex'");
    }
  });
});
