/**
 * STORY-031 acceptance tests — the server half.
 *
 *   "React frontend setup with trust controls" → responsive, interactive and
 *       secure, with CSP `default-src 'self'` and HTTPS enforced.
 *
 * Measured before this story: no security header on any response from the
 * API, the Vite server or the nginx config; `cors()` accepted every origin on
 * the internet; nothing redirected or refused plain http; and no media query
 * in the stylesheet, so 10 of 11 tabs scrolled the whole page sideways on a
 * phone.
 *
 * What a browser does under the policy — whether the pages still work, and
 * whether they fit — cannot be asserted from here. `npm run check:browser`
 * drives Chrome through every tab for that, and includes a control run under
 * the clause's literal policy to show the check can see a violation at all.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import {
  CSP_DIRECTIVES,
  CSP_EXEMPTIONS,
  PLAIN_HTTP_ALLOWED,
  cspHeader,
  uiHeaders,
} from '../src/services/securityHeaders.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const servers = [];
async function start(options) {
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let dev;
let prod;

before(async () => {
  dev = await start({ httpsRequired: false, corsOrigins: ['http://localhost:5173'] });
  prod = await start({ httpsRequired: true, corsOrigins: [] });
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('Scenario: every response carries the policy', () => {
  it('sends default-src \'self\', as the clause asks, on API responses', async () => {
    const r = await fetch(`${dev}/api/health`);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, 'no CSP header on the API');
    assert.match(csp, /(^|; )default-src 'self'(;|$)/);
    // Parsed, not compared as bytes: helmet joins with ";" and the shared
    // string with "; ", and those are the same policy to a browser.
    const parse = (h) => h.split(';').map((d) => d.trim()).filter(Boolean).sort();
    assert.deepEqual(parse(csp), parse(cspHeader()), 'the API is not sending the shared policy');
  });

  it('carries the other headers a browser needs to not be tricked', async () => {
    const r = await fetch(`${dev}/api/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    // helmet removes it; saying "Express" to every scanner is free reconnaissance.
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('is on error responses too, not only successful ones', async () => {
    const r = await fetch(`${dev}/api/no-such-route`);
    assert.equal(r.status, 401);
    assert.ok(r.headers.get('content-security-policy'));
  });

  it('widens default-src in exactly one place, and says why', () => {
    // Every source beyond 'self' / 'none' in any directive must be a declared
    // exemption. A widening without a reason is how a policy erodes.
    const widenings = Object.entries(CSP_DIRECTIVES).flatMap(([d, sources]) =>
      sources.filter((s) => s !== "'self'" && s !== "'none'").map((s) => `${d} ${s}`),
    );
    assert.deepEqual(widenings, Object.keys(CSP_EXEMPTIONS));
    assert.ok(!cspHeader().includes('unsafe-inline'), 'no inline scripts or styles');
    assert.ok(!cspHeader().includes('unsafe-eval'));
  });
});

describe('Scenario: HTTPS is enforced', () => {
  it('redirects a plain-http GET to https', async () => {
    const r = await fetch(`${prod}/api/authors`, { redirect: 'manual' });
    assert.equal(r.status, 308);
    assert.match(r.headers.get('location'), /^https:\/\/127\.0\.0\.1:\d+\/api\/authors$/);
  });

  it('refuses a plain-http POST rather than redirecting its body', async () => {
    const r = await fetch(`${prod}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mira@example.test', password: 'quiet-craft' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /HTTPS required/);
  });

  it('serves a request the TLS terminator says was https', async () => {
    const r = await fetch(`${prod}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  });

  it('lets the load balancer probe over plain http', async () => {
    // Redirecting the probe fails it and takes a healthy instance out.
    for (const path of PLAIN_HTTP_ALLOWED) {
      const r = await fetch(`${prod}${path}`, { redirect: 'manual' });
      assert.notEqual(r.status, 308, `${path} was redirected`);
    }
  });

  it('does not send HSTS where the connection is not https', async () => {
    const r = await fetch(`${dev}/api/health`);
    assert.equal(r.headers.get('strict-transport-security'), null);
  });

  it('does not believe X-Forwarded-Proto when nothing is in front', async () => {
    // In development there is no proxy, and `trust proxy` is off — a client
    // claiming https changes nothing, which is the point.
    const r = await fetch(`${dev}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.headers.get('strict-transport-security'), null);
  });
});

describe('Cross-origin access is narrowed from everyone to the UI', () => {
  it('answers the dev UI\'s origin', async () => {
    const r = await fetch(`${dev}/api/health`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  it('does not answer any other origin', async () => {
    const r = await fetch(`${dev}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'was `*` before STORY-031');
  });
});

describe('One policy, three senders', () => {
  it('nginx sends byte-for-byte the same policy and headers', () => {
    // The container serves the UI through nginx, which cannot import JS. So
    // the config carries a copy, and this is what stops the copy drifting.
    const conf = readFileSync(join(repoRoot, 'client/nginx.conf'), 'utf8');
    const sent = Object.fromEntries(
      [...conf.matchAll(/add_header\s+(\S+)\s+"([^"]+)"\s+always;/g)].map((m) => [m[1], m[2]]),
    );
    assert.deepEqual(sent, uiHeaders({ enforce: true, https: true }));
  });

  it('the Vite config imports the policy rather than restating it', () => {
    const vite = readFileSync(join(repoRoot, 'client/vite.config.js'), 'utf8');
    assert.match(vite, /from '\.\.\/server\/src\/services\/securityHeaders\.js'/);
    assert.ok(!vite.includes("default-src"), 'vite.config.js restates the policy instead of importing it');
  });
});

describe('Responsive, measured', () => {
  it('the stylesheet has a narrow-screen layout and wide content scrolls inside its card', () => {
    // The browser check measures the result on every tab; this pins the rules
    // that produced it, so deleting them fails here and not only there.
    const css = readFileSync(join(repoRoot, 'client/src/styles.css'), 'utf8');
    assert.match(css, /@media \(max-width: 720px\)/);
    assert.match(css, /\.card\s*\{\s*overflow-x: auto;/);
  });
});
