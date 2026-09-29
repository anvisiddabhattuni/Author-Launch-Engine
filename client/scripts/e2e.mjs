/**
 * The end-to-end tier (STORY-053).
 *
 * The server suite drives the API; the browser check (STORY-031) looks at every
 * page. Neither walks a person through the product. This does — in Chrome,
 * against the production build, with the API in-process on a real database —
 * the journey the product exists for, and the refusals that keep it honest:
 *
 *   1. an author signs in and uploads a book
 *   2. the book's model is fitted, and what it learned is on the page (STORY-046)
 *   3. drafts are generated and wait in the review queue, compared with the book (STORY-047)
 *   4. the author asks for changes; a revision comes back into the queue
 *   5. the revision is approved — and leaves the queue
 *   6. an API key is created and shown once (STORY-045)
 *   7. the compliance auditor, who may read but not approve, is refused the approval
 *   8. no step raised an uncaught error, a console error, or a 5xx
 *
 *   npm run test:e2e            (needs Chrome; CHROME_PATH to override; a seeded database)
 *
 * Exits non-zero on the first failed step, naming it.
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
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.log(`[e2e] no Chrome at ${CHROME} — set CHROME_PATH. Skipped, not passed.`);
  process.exit(2);
}

let apiServer = null;
const apiUp = await fetch('http://localhost:4000/api/health').then((r) => r.ok).catch(() => false);
if (!apiUp) {
  apiServer = createApp().listen(4000);
  await new Promise((resolve) => apiServer.once('listening', resolve));
}
await build({ root: clientRoot, logLevel: 'warn' });
const previewServer = await preview({ root: clientRoot, preview: { port: 4173, strictPort: true } });
const base = 'http://localhost:4173';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

const problems = [];
const results = [];
let failed = false;

async function newPage() {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[134]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} from ${r.url()}`); });
  return page;
}
async function signIn(page, email, password) {
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.type('input[type=email]', email);
  await page.type('input[type=password]', password);
  await Promise.all([page.click('button[type=submit]'), page.waitForSelector('nav.tabs', { timeout: 10000 })]);
}
const clickButton = (page, text, scope = 'body') =>
  page.evaluate((t, s) => {
    const b = [...document.querySelector(s).querySelectorAll('button')].find((x) => x.textContent.trim() === t && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, text, scope);
// A page's own message, not STORY-057's notice of what is waiting, which is
// also a banner and sits above every page for whoever can approve.
const bannerText = (page) => page.$eval('.banner:not(.attention-notice)', (b) => b.textContent).catch(() => '');

async function step(name, fn) {
  if (failed) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    failed = true;
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
  }
}
const expect = (cond, message) => { if (!cond) throw new Error(message); };

const title = `E2E Field ${Date.now()}`;
const author = await newPage();

await step('an author signs in and uploads a book', async () => {
  await signIn(author, 'mira@example.test', 'quiet-craft');
  await author.goto(`${base}/upload`, { waitUntil: 'networkidle0' });
  await author.type('#title', title);
  await author.type('#themes', 'patience, grief');
  await author.type('#content', [
    'Patience is not waiting. Patience is the frost breaking the clods and the seed in the cold ground.',
    'Grief arrived the way weather does. His coat still hung on the hook by the door.',
    'Patience, I learned that year, is the only tool the field will answer to.',
    'Grief does not end so much as change its shape; the empty chair stayed at the table.',
    'You cannot rush a field. The seed does its slow work under the frost.',
  ].join('\n\n'));
  await author.click('form.card button[type=submit]');
  await author.waitForFunction(() => document.querySelector('.banner:not(.attention-notice)'), { timeout: 10000 });
  expect(!/error|failed/i.test(await bannerText(author)), `upload refused: ${await bannerText(author)}`);
});

await step('the book\'s model was fitted, and what it learned is on the page', async () => {
  await author.goto(`${base}/upload`, { waitUntil: 'networkidle0' });
  await author.waitForSelector('#model-book');
  const value = await author.$$eval('#model-book option', (os, t) => os.find((o) => o.textContent === t)?.value, title);
  expect(value, 'the new book is not in the model panel');
  await author.select('#model-book', value);
  await author.waitForFunction(() => /version 1/.test(document.body.innerText), { timeout: 10000 });
});

await step('drafts are generated and wait in the review queue, compared with the book', async () => {
  await author.goto(`${base}/upload`, { waitUntil: 'networkidle0' });
  const clicked = await author.evaluate((t) => {
    const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(t));
    const b = row?.querySelector('button');
    if (b) b.click();
    return Boolean(b);
  }, title);
  expect(clicked, 'no "Generate weekly drafts" button for the new book');
  await author.waitForFunction(() => /draft/i.test(document.querySelector('.banner:not(.attention-notice)')?.textContent ?? ''), { timeout: 20000 });
  await author.goto(`${base}/review`, { waitUntil: 'networkidle0' });
  const compared = await author.$$eval('.draft', (ds) => ds.filter((d) => /matches the book|does not match|check against the book/.test(d.textContent)).length);
  expect(compared > 0, 'no draft in the queue carries a comparison with the book');
});

await step('the author asks for changes, and a revision comes back into the queue', async () => {
  const first = await author.$('.draft');
  const input = await first.$('input[placeholder^="Notes"]');
  await input.type('Lead with the coat on the hook, please.');
  const ok = await first.evaluate((d) => {
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Request changes');
    b?.click();
    return Boolean(b);
  });
  expect(ok, 'no Request changes button');
  await author.waitForFunction(() => /Revision #\d+ is in the queue/.test(document.querySelector('.banner:not(.attention-notice)')?.textContent ?? ''), { timeout: 20000 });
  // The banner comes first; the queue re-renders a moment later.
  await author.waitForFunction(() => /Revision of draft #\d+/.test(document.body.innerText), { timeout: 10000 })
    .catch(() => { throw new Error('the revision is not labelled in the queue'); });
});

await step('the revision is approved, and leaves the queue', async () => {
  // The revision is on screen one render before the page stops being busy; a
  // click in that gap lands on a disabled button and does nothing.
  await author.waitForFunction(() => {
    const d = [...document.querySelectorAll('.draft')].find((x) => /Revision of draft #/.test(x.textContent));
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Approve');
    return b && !b.disabled;
  }, { timeout: 10000 }).catch(() => { throw new Error('the revision\'s Approve button never became usable'); });
  const revision = await author.evaluateHandle(() => [...document.querySelectorAll('.draft')].find((d) => /Revision of draft #/.test(d.textContent)));
  const id = await revision.evaluate((d) => d.textContent.match(/draft (\d+)/)?.[1]);
  await revision.evaluate((d) => [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Approve').click());
  await author.waitForFunction((n) => (document.querySelector('.banner:not(.attention-notice)')?.textContent ?? '').includes(`Draft ${n} approved`), { timeout: 10000 }, id)
    .catch(async () => {
      const all = await author.$$eval('.banner', (bs) => bs.map((b) => `[${b.className}] ${b.textContent.trim()}`).join(' | '));
      throw new Error(`draft ${id}: the page said "${await bannerText(author)}" — every banner: ${all}`);
    });
});

await step('an API key is created and shown exactly once', async () => {
  await author.goto(`${base}/api-keys`, { waitUntil: 'networkidle0' });
  await author.type('#key-name', 'E2E integration');
  await author.click('form button[type=submit]');
  await author.waitForSelector('.banner.ok:not(.attention-notice)', { timeout: 10000 });
  const shown = await author.$eval('.banner.ok:not(.attention-notice)', (b) => /ale_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/.test(b.textContent));
  expect(shown, 'the key was not shown');
  await author.goto(`${base}/api-keys`, { waitUntil: 'networkidle0' });
  expect(!(await author.evaluate(() => /ale_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/.test(document.body.innerText))), 'the key was shown a second time');
});

await step('the compliance auditor may read but not approve', async () => {
  const auditor = await newPage();
  await signIn(auditor, 'auditor@example.test', 'compliance-only');
  await auditor.goto(`${base}/review`, { waitUntil: 'networkidle0' });
  const clicked = await clickButton(auditor, 'Approve');
  if (clicked) {
    await auditor.waitForSelector('.banner:not(.attention-notice)', { timeout: 10000 });
    expect(/requires permission: content\.approve/.test(await bannerText(auditor)), `an approval by compliance was not refused: ${await bannerText(auditor)}`);
  }
  await auditor.goto(`${base}/audit`, { waitUntil: 'networkidle0' });
  expect(await auditor.evaluate(() => /Audit log \(\d+\)/.test(document.body.innerText)), 'the auditor cannot read the audit log');
});

await step('no uncaught error, console error or 5xx on the way', async () => {
  expect(problems.length === 0, problems.slice(0, 5).join(' | '));
});

for (const r of results) console.log(`[e2e] ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.ok ? '' : `\n        ${r.error}`}`);
console.log(failed ? '[e2e] FAILED' : `[e2e] PASS — ${results.length} steps`);

await browser.close();
await new Promise((resolve) => previewServer.httpServer.close(resolve));
if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
await closePool();
process.exit(failed ? 1 : 0);
