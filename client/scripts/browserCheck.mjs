/**
 * The browser check (STORY-031).
 *
 * The acceptance clause is about what a browser does — "responsive,
 * interactive, and secure with CSP" — and none of the 670 server tests run a
 * browser. A CSP header string can be asserted in a unit test; whether the
 * page still works under it cannot. So this drives the Chrome already on the
 * machine through every tab, as a signed-in author, at a phone width and a
 * desktop width, against the *production build* served with the enforced
 * policy, and reports:
 *
 *   csp       — every securitypolicyviolation the page raised
 *   overflow  — whether the page itself scrolls sideways (a card may; the page may not)
 *   crushed   — table cells squeezed so narrow that words break every few letters
 *   errors    — uncaught exceptions and console errors
 *   images    — meme previews that failed to load
 *
 * Then it runs a control: the same tabs under the clause's literal
 * `default-src 'self'`, to show the check can see a violation at all. A check
 * that has never been seen to fail is a check nobody knows works.
 *
 *   npm run check:browser        (needs Chrome; CHROME_PATH to override)
 *
 * Exits non-zero on any finding in the real run.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

import { createApp } from '../../server/src/app.js';
import { closePool } from '../../server/src/db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TABS = [
  '/upload', '/review', '/schedule', '/opportunities', '/outreach', '/press',
  '/worker', '/templates', '/performance', '/trust', '/audit', '/api-keys',
];
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];
const LITERAL = "default-src 'self'";

if (!existsSync(CHROME)) {
  console.log(`[browser] no Chrome at ${CHROME} — set CHROME_PATH. Skipped, not passed.`);
  process.exit(2);
}

// The API, in-process, unless one is already listening.
let apiServer = null;
const apiUp = await fetch('http://localhost:4000/api/health').then((r) => r.ok).catch(() => false);
if (!apiUp) {
  apiServer = createApp().listen(4000);
  await new Promise((resolve) => apiServer.once('listening', resolve));
}

// The production build, served by `vite preview` with the enforced policy.
await build({ root: clientRoot, logLevel: 'warn' });
const previewServer = await preview({ root: clientRoot, preview: { port: 4173, strictPort: true } });
const base = 'http://localhost:4173';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

async function signedInPage({ cspOverride = null } = {}) {
  // A fresh context each time: pages in one context share localStorage, so a
  // second page would arrive already signed in and never see the login form.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.effectiveDirective} blocked ${String(e.blockedURI).slice(0, 40)}`);
    });
  });
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) page.__errors.push(m.text());
  });

  if (cspOverride) {
    // The control: replace the document's policy with the clause's literal one.
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.resourceType() !== 'document') return req.continue();
      const r = await fetch(req.url());
      const headers = Object.fromEntries(r.headers.entries());
      headers['content-security-policy'] = cspOverride;
      req.respond({ status: r.status, headers, body: await r.text() });
    });
  }

  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.type('input[type=email]', 'mira@example.test');
  await page.type('input[type=password]', 'quiet-craft');
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('nav.tabs', { timeout: 10000 }),
  ]);
  return page;
}

async function visit(page, tab, viewport) {
  await page.setViewport({ width: viewport.width, height: viewport.height });
  page.__errors.length = 0;
  await page.goto(`${base}${tab}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card, .banner', { timeout: 10000 }).catch(() => {});
  const policy = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
  const found = await page.evaluate(() => ({
    csp: window.__csp.splice(0),
    overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
    images: document.images.length,
    // "Fits" is not "readable". A table can avoid page overflow by crushing
    // its columns until words break every three letters — the first version
    // of the responsive CSS did exactly that and passed the overflow check.
    // A cell narrower than ~5 characters holding a longer word is crushed.
    crushed: [...document.querySelectorAll('td')].filter((td) => {
      const longest = Math.max(0, ...td.textContent.split(/\s+/).map((w) => w.length));
      return longest > 6 && td.getBoundingClientRect().width < 44;
    }).length,
  }));
  return { tab, viewport: viewport.name, policy, ...found, errors: [...page.__errors] };
}

// ── The real run ────────────────────────────────────────────────────────────
const page = await signedInPage();
const results = [];
for (const viewport of WIDTHS) {
  for (const tab of TABS) results.push(await visit(page, tab, viewport));
}
await page.close();

console.log('\n[browser] production build under the enforced policy');
console.log(`[browser] policy: ${results[0].policy}\n`);
console.log('  tab             width    csp  overflow  crushed  images     errors');
let findings = 0;
for (const r of results) {
  const bad = r.csp.length > 0 || r.overflowPx > 1 || r.brokenImages > 0 || r.errors.length > 0 || r.crushed > 0;
  if (bad) findings += 1;
  console.log(
    `  ${r.tab.padEnd(16)}${r.viewport.padEnd(9)}${String(r.csp.length).padEnd(5)}` +
      `${(r.overflowPx > 1 ? `+${r.overflowPx}px` : 'none').padEnd(10)}${String(r.crushed).padEnd(9)}` +
      `${`${r.images - r.brokenImages}/${r.images}`.padEnd(11)}${r.errors.length}${bad ? '   ← ' + [...r.csp, ...r.errors].slice(0, 2).join(' | ') : ''}`,
  );
}

// ── The control: the clause's literal policy ───────────────────────────────
const control = await signedInPage({ cspOverride: LITERAL });
const controlResults = [];
for (const tab of ['/review', '/templates']) controlResults.push(await visit(control, tab, WIDTHS[1]));
await control.close();

console.log(`\n[browser] control — the same build under the clause's literal "${LITERAL}"`);
for (const r of controlResults) {
  console.log(
    `  ${r.tab.padEnd(16)}csp violations ${String(r.csp.length).padEnd(4)} images loaded ${r.images - r.brokenImages}/${r.images}` +
      (r.csp[0] ? `   e.g. ${r.csp[0]}` : ''),
  );
}
const controlSaw = controlResults.some((r) => r.csp.length > 0);
console.log(
  controlSaw
    ? '  → the check sees violations when they happen, so the clean run above means something.'
    : '  → the control saw nothing; the check may be blind. Treat the run above as unproven.',
);

await browser.close();
await new Promise((resolve) => previewServer.httpServer.close(resolve));
if (apiServer) {
  await new Promise((resolve) => apiServer.close(resolve));
  await closePool();
}

console.log(`\n[browser] ${findings === 0 && controlSaw ? 'PASS' : 'FAIL'} — ${results.length} page loads, ${findings} with findings`);
process.exit(findings === 0 && controlSaw ? 0 : 1);
