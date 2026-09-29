/**
 * Screenshots for STORY-055 and STORY-056, taken in a browser (CI's `search` job).
 *
 *   1. Trust tab, "Search the logs": a search with a time range, answered in ms.
 *   2. Grafana, the trust dashboard over the last 7 days.
 *   3. Grafana, the same dashboard over a range the user chose.
 *
 * Needs the API and UI running (localhost:4000 / :4173), Grafana on :3000 and
 * an index the aggregation has filled. Writes PNGs to SHOTS_DIR (default ./shots).
 */
import { mkdirSync } from 'node:fs';

import puppeteer from 'puppeteer-core';

const out = process.env.SHOTS_DIR ?? 'shots';
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UI = process.env.UI_URL ?? 'http://localhost:4173';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  // 1 — the app.
  const app = await browser.newPage();
  await app.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await app.goto(UI, { waitUntil: 'networkidle0' });
  await app.type('input[type=email]', 'mira@example.test');
  await app.type('input[type=password]', 'quiet-craft');
  await Promise.all([app.click('button[type=submit]'), app.waitForSelector('nav.tabs')]);
  await app.goto(`${UI}/trust`, { waitUntil: 'networkidle0' });
  await app.waitForSelector('.search-card table', { timeout: 30_000 });
  await app.type('.search-card input[aria-label="Search for"]', 'approved');
  await app.click('.search-card button[type=submit]');
  await pause(1500);
  const card = await app.$('.search-card');
  await card.screenshot({ path: `${out}/trust-search.png` });
  console.log('shot trust-search');

  // 2, 3 — Grafana.
  const g = await browser.newPage();
  await g.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1.5 });
  await g.goto(`${GRAFANA}/login`, { waitUntil: 'networkidle0' });
  await g.type('input[name=user]', 'admin');
  await g.type('input[name=password]', process.env.GRAFANA_ADMIN_PASSWORD);
  await Promise.all([g.click('button[type=submit]'), g.waitForNavigation({ waitUntil: 'networkidle0' })]);
  for (const [name, range] of [['grafana-7d', 'from=now-7d&to=now'], ['grafana-custom-range', 'from=now-6h&to=now']]) {
    await g.goto(`${GRAFANA}/d/ale-trust?orgId=1&${range}`, { waitUntil: 'networkidle0' });
    await pause(4000);
    await g.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(`shot ${name}`);
  }
} finally {
  await browser.close();
}
