/**
 * The CI pipeline, run here, step for step (STORY-053).
 *
 * The workflow in .github/workflows/ci.yml ran on GitHub once and failed, and
 * nobody knew for two days. This runs the same steps, in the same order, under
 * the same conditions CI has that a laptop does not — UTC, the app's
 * restricted login with a password, a JWT secret — so a push is not the first
 * time they meet.
 *
 * What it cannot run here, it says so rather than passing it: the RabbitMQ
 * scenario (no broker), the OWASP ZAP scan and the image builds (no Docker). For
 * ZAP it runs a stand-in — the headers .zap/rules.tsv fails on, checked against
 * the same running build — labelled as a stand-in.
 *
 *   npm run ci:local              one pass of the suite
 *   npm run ci:local -- --thorough  three, as CI does
 */
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const thorough = process.argv.includes('--thorough');
const env = {
  ...process.env,
  TZ: 'UTC',
  APP_DB_PASSWORD: process.env.APP_DB_PASSWORD ?? 'ci-app-password',
  JWT_SECRET: process.env.JWT_SECRET ?? 'ci-only-not-a-secret',
};
const results = [];

function run(name, command, { ci = true } = {}) {
  const started = Date.now();
  const r = spawnSync(command, { shell: true, env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 200 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const summary = out.match(/^# (pass|fail|skipped) \d+/gm)?.join(' · ') ?? out.match(/\[(e2e|browser)\] (PASS|FAIL)[^\n]*/)?.[0] ?? '';
  results.push({ name, ok: r.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1), summary, ci });
  if (r.status !== 0) {
    console.log(out.split('\n').filter((l) => /not ok|FAIL|Error|error:/.test(l)).slice(0, 15).join('\n'));
  }
  return r.status === 0;
}

const steps = [
  ['unit tier', 'npm run test:unit'],
  ['dependency scan', 'npm run scan:deps'],
  ['database reset', 'npm run db:reset'],
  ['unit + integration tiers', 'npm test'],
  ...(thorough ? [1, 2, 3].map((i) => [`suite, run ${i} of 3`, 'npm run db:reset && npm test']) : []),
  ['client build', 'npm run build --workspace client'],
  ['demo end to end', 'npm run db:reset && npm run demo'],
  ['end-to-end tier', 'npm run db:reset && npm run test:e2e'],
  ['browser check (CSP, layout)', 'npm run db:reset && npm run demo && npm run check:browser'],
];

for (const [name, command] of steps) {
  console.log(`[ci] ${name} …`);
  if (!run(name, command)) break;
}

// ZAP stand-in: the rules that FAIL the build, checked on the running build.
if (results.every((r) => r.ok)) {
  console.log('[ci] security headers (stand-in for the ZAP scan) …');
  const api = spawn('npm', ['start', '--workspace', 'server'], { env, stdio: 'ignore' });
  const ui = spawn('npx', ['--workspace', 'client', 'vite', 'preview', '--port', '4173', '--strictPort'], { env, stdio: 'ignore' });
  const started = Date.now();
  let findings = [];
  try {
    for (let i = 0; i < 60; i += 1) {
      const up = await fetch('http://localhost:4173/').then((r) => r.ok).catch(() => false)
        && await fetch('http://localhost:4000/api/health').then((r) => r.ok).catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const failRules = readFileSync('.zap/rules.tsv', 'utf8').split('\n').filter((l) => l.split('\t')[1] === 'FAIL').length;
    for (const url of ['http://localhost:4173/', 'http://localhost:4173/api/health']) {
      const h = (await fetch(url)).headers;
      const page = url.endsWith('/');
      if (page && !/frame-ancestors 'none'/.test(h.get('content-security-policy') ?? '') && !h.get('x-frame-options')) findings.push(`${url}: no anti-clickjacking header`);
      if (h.get('x-content-type-options') !== 'nosniff') findings.push(`${url}: X-Content-Type-Options missing`);
      if (page && !h.get('content-security-policy')) findings.push(`${url}: no Content-Security-Policy`);
      if (h.get('x-powered-by')) findings.push(`${url}: X-Powered-By leaks ${h.get('x-powered-by')}`);
      if (/\d/.test(h.get('server') ?? '')) findings.push(`${url}: Server header leaks a version`);
    }
    results.push({
      name: `security headers (stand-in for ZAP, ${failRules} FAIL rules)`,
      ok: findings.length === 0,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      summary: findings.join('; '),
      ci: true,
    });
  } finally {
    api.kill();
    ui.kill();
  }
}

console.log('\n[ci] results');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(46)} ${String(r.seconds).padStart(6)}s  ${r.summary}`);
console.log('\n[ci] not run here, and not claimed:');
console.log('  - the RabbitMQ scenario (no broker on this machine; CI starts one)');
console.log('  - the OWASP ZAP baseline scan and the image builds with Clair (no Docker)');
const ok = results.every((r) => r.ok) && results.length >= steps.length;
console.log(ok ? '\n[ci] PASS' : '\n[ci] FAILED');
process.exit(ok ? 0 : 1);
