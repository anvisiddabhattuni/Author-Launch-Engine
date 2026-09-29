/**
 * Checks a deployed demo against STORY-030's two clauses (STORY-030).
 *
 *   "Stakeholders can access the demo"        — it answers over valid HTTPS,
 *                                               the app and API are up, http redirects.
 *   "Protected against unauthorized access"   — no data without a session, the
 *                                               published demo passwords do not
 *                                               work, the login page does not
 *                                               print them, the security headers
 *                                               are set, no other origin is let in.
 *
 *   npm run smoke:deployed -- https://demo.example.com
 *   npm run smoke:deployed -- http://localhost:4173 --rehearsal
 *
 * --rehearsal skips what needs a real certificate (TLS, the http→https
 * redirect, HSTS) and says so; everything else is checked the same way.
 * Exits non-zero on any failure.
 */
const [target, ...flags] = process.argv.slice(2);
if (!target) {
  console.log('usage: npm run smoke:deployed -- <https://demo-url> [--rehearsal]');
  process.exit(2);
}
const rehearsal = flags.includes('--rehearsal');
const base = target.replace(/\/$/, '');
const results = [];
const check = async (name, fn, { needsTls = false } = {}) => {
  if (needsTls && rehearsal) {
    results.push({ name, status: 'SKIP', detail: 'needs the real certificate' });
    return;
  }
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: detail ?? '' });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error.message });
  }
};
const must = (cond, message) => { if (!cond) throw new Error(message); };

// Reachable
await check('the demo answers over HTTPS with a valid certificate', async () => {
  must(base.startsWith('https://'), 'the URL is not https');
  const r = await fetch(`${base}/`);
  must(r.ok, `status ${r.status}`);
  return `status ${r.status}`;
}, { needsTls: true });
await check('plain http redirects to https', async () => {
  const r = await fetch(base.replace(/^https:/, 'http:'), { redirect: 'manual' });
  must([301, 302, 307, 308].includes(r.status) && (r.headers.get('location') ?? '').startsWith('https://'), `status ${r.status}, location ${r.headers.get('location')}`);
  return `${r.status} → ${r.headers.get('location')}`;
}, { needsTls: true });
await check('the app is served', async () => {
  const html = await (await fetch(`${base}/`)).text();
  must(/<div id="root">/.test(html), 'no app root in the page');
});
await check('the API is up and ready', async () => {
  const h = await fetch(`${base}/api/health`);
  const r = await fetch(`${base}/api/ready`);
  must(h.ok && r.ok, `health ${h.status}, ready ${r.status}`);
  return `health ${h.status}, ready ${r.status}`;
});

// Protected
await check('no data without a session', async () => {
  const statuses = await Promise.all(['/api/authors', '/api/audit-log', '/api/drafts', '/api/tenants'].map(async (p) => [p, (await fetch(`${base}${p}`)).status]));
  const open = statuses.filter(([, s]) => s !== 401);
  must(open.length === 0, `answered without a session: ${open.map(([p, s]) => `${p} ${s}`).join(', ')}`);
  return statuses.map(([p, s]) => `${p} ${s}`).join(', ');
});
await check('the published demo passwords do not work', async () => {
  const published = [['ops@example.test', 'ops-password'], ['security@example.test', 'second-pair-of-eyes'], ['mira@example.test', 'quiet-craft'], ['auditor@example.test', 'compliance-only']];
  const worked = [];
  for (const [email, password] of published) {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (r.ok) worked.push(email);
  }
  must(worked.length === 0, `signed in with the README's password: ${worked.join(', ')}`);
});
await check('the login page does not print the demo passwords', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  for (const s of scripts) {
    const js = await (await fetch(new URL(s, `${base}/`))).text();
    must(!js.includes('ops-password'), `${s} contains the published admin password`);
  }
  return `${scripts.length} script(s) checked`;
});
await check('security headers on the page', async () => {
  const h = (await fetch(`${base}/`)).headers;
  const csp = h.get('content-security-policy') ?? '';
  must(csp.includes("default-src 'self'"), 'no Content-Security-Policy');
  must(csp.includes("frame-ancestors 'none'") || h.get('x-frame-options'), 'no anti-clickjacking header');
  must(h.get('x-content-type-options') === 'nosniff', 'no X-Content-Type-Options');
  must(!h.get('x-powered-by'), `X-Powered-By: ${h.get('x-powered-by')}`);
  must(!/\d/.test(h.get('server') ?? ''), `Server header leaks a version: ${h.get('server')}`);
});
await check('HSTS on https', async () => {
  const h = (await fetch(`${base}/`)).headers;
  must(/max-age=\d{7,}/.test(h.get('strict-transport-security') ?? ''), 'no Strict-Transport-Security');
}, { needsTls: true });
await check('no other origin is let in (CORS)', async () => {
  const r = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
  must(!r.headers.get('access-control-allow-origin'), `Access-Control-Allow-Origin: ${r.headers.get('access-control-allow-origin')}`);
});

for (const r of results) console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(52)} ${r.detail}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${failed ? 'FAILED' : 'PASS'} — ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped${rehearsal ? ' (rehearsal: no certificate to check)' : ''}`);
process.exit(failed ? 1 : 0);
