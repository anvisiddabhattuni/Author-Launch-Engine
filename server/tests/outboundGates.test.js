/**
 * STORY-020 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Approval required for outbound communication" → a drafted communication is
 *       held for human approval and logged once approved.
 *   "Notify stakeholders for approval"             → pending work notifies the
 *       relevant stakeholders.
 *
 * Both were already built — by STORY-001/002/003 (the gates) and STORY-007/012
 * (the notifications). Restating that in new tests would prove nothing, so the
 * tests here are aimed at what those stories left open: `gate.posts`,
 * `gate.outreach` and `gate.press` each join one table that records a send, so
 * all three verify **a gate that exists** and none of them can see an outbound
 * path that shipped without one.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import { closePool, query } from '../src/db/pool.js';
import { emailApi } from '../src/services/emailApi.js';
import { getSocialApi } from '../src/services/socialApis.js';
import { runChecks } from '../src/services/governance.js';
import {
  EXEMPT,
  GATED,
  OUTBOUND_PATHS,
  assertDeclaredPath,
  declaredPaths,
  outboundInventory,
} from '../src/services/outboundPaths.js';

const SRC = new URL('../src/', import.meta.url);

/**
 * Strips comments and string contents before scanning.
 *
 * Without this the scan reads prose *about* code as code: demo.js prints the
 * line `emailApi.send({ to, subject, body })` to show what a missing
 * declaration looks like, and the first version of this test dutifully
 * reported it as a missing declaration. A scanner that cannot tell an example
 * from an instance produces exactly the noise that gets a check switched off.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const codeOnly = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, "''")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, "''");

/** Every .js file under server/src, so the scan cannot miss a new directory. */
async function sourceFiles(dir = SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) files.push(...(await sourceFiles(child)));
    else if (entry.name.endsWith('.js')) files.push(child);
  }
  return files;
}

after(async () => {
  await closePool();
});

describe('Every way out of the system is declared', () => {
  it('names a gate or a reason, never neither', () => {
    for (const p of OUTBOUND_PATHS) {
      assert.ok([GATED, EXEMPT].includes(p.kind), `${p.id} has no kind`);
      assert.ok(p.module, `${p.id} does not say where it lives`);
      assert.ok(p.sends, `${p.id} does not say what it sends`);
      if (p.kind === GATED) {
        assert.ok(p.gate, `${p.id} is gated but names no gate`);
        assert.ok(p.enforcedIn, `${p.id} names no enforcement point`);
      } else {
        // An exemption with no reason is just an ungated path with better
        // manners. STORY-017's lesson: an exclusion nobody can see is
        // indistinguishable from a check that never ran.
        assert.ok(p.why && p.why.length > 40, `${p.id} is exempt without a real reason`);
      }
    }
  });

  it('gives every gated path an invariant that checks it from outside', () => {
    const inventory = outboundInventory();
    assert.deepEqual(inventory.unverified, [], 'a gated path has no invariant behind it');
    // The identities rather than a count: a count assertion breaks on every
    // future addition without saying anything, while this says which paths are
    // meant to carry tenant content to strangers.
    assert.deepEqual(
      OUTBOUND_PATHS.filter((p) => p.kind === GATED).map((p) => p.id).sort(),
      ['outreach.send', 'press.distribute', 'social.publish'],
    );
    assert.equal(inventory.gated + inventory.exempt, inventory.total);
  });

  it('is what the governance invariant reads', async () => {
    const result = (await runChecks({})).find((c) => c.id === 'gate.outbound_declared');
    assert.ok(result, 'the outbound coverage check is not in the list');
    assert.equal(result.passed, true);
    assert.equal(result.severity, 'invariant');
  });
});

describe('An undeclared outbound path cannot send', () => {
  it('refuses an email with no declared path', async () => {
    await assert.rejects(
      () => emailApi.send({ to: 'someone@example.test', subject: 's', body: 'b' }),
      (error) => {
        assert.match(error.message, /no `via` given/);
        return true;
      },
    );
  });

  it('refuses an email naming a path nobody declared', async () => {
    await assert.rejects(
      () =>
        emailApi.send({
          to: 'someone@example.test',
          subject: 's',
          body: 'b',
          via: 'newsletter.blast',
        }),
      (error) => {
        assert.match(error.message, /not a declared outbound path/);
        // The message has to say how to fix it, or the next person works around
        // it by passing an existing id.
        assert.match(error.message, /outboundPaths\.js/);
        return true;
      },
    );
  });

  it('refuses a social publish the same way', async () => {
    await assert.rejects(
      () => getSocialApi('twitter').publish({ content: 'hello', scheduledFor: null }),
      (error) => {
        assert.match(error.message, /no `via` given/);
        return true;
      },
    );
  });

  it('refuses before it validates the message, not after', async () => {
    // An undeclared path is a build error rather than a bad message, and should
    // fail identically whether or not the address happens to be malformed —
    // otherwise a developer fixes the address and believes they fixed the
    // problem.
    await assert.rejects(
      () => emailApi.send({ to: 'not-an-address', subject: '', body: '', via: undefined }),
      (error) => {
        assert.match(error.message, /no `via` given/);
        assert.equal(/Invalid recipient/.test(error.message), false);
        return true;
      },
    );
  });

  it('accepts each declared path', async () => {
    for (const id of declaredPaths()) {
      assert.ok(assertDeclaredPath(id), `${id} was refused`);
    }
  });
});

describe('The scan that catches a path somebody forgot to declare', () => {
  it('finds every send call site, and every one names a path', async () => {
    // The registry is only as good as its coverage, and coverage is exactly
    // what nothing checked before. This reads the source rather than trusting
    // that a developer remembered — the adapter refuses at runtime, this says
    // so at build time, and the two failures look different on purpose.
    const files = await sourceFiles();
    const offenders = [];
    let sendSites = 0;

    for (const file of files) {
      const name = path.basename(file.pathname);
      // The adapters define `send`/`publish`; they do not call them.
      if (name === 'emailApi.js' || name === 'socialApis.js' || name === 'outboundPaths.js') continue;
      const source = codeOnly(await readFile(file, 'utf8'));

      for (const match of source.matchAll(/\.(send|publish)\(\{([\s\S]{0,400}?)\}\)/g)) {
        sendSites += 1;
        if (!/\bvia:\s*'/.test(match[2])) {
          offenders.push(`${name}: .${match[1]}({...}) with no via`);
        }
      }
    }

    assert.ok(sendSites >= 6, `expected to find the send sites, found ${sendSites}`);
    assert.deepEqual(offenders, [], 'an outbound send does not declare its path');
  });

  it('every via in production code is a declared id', async () => {
    const files = await sourceFiles();
    const declared = new Set(declaredPaths());
    const unknown = [];
    for (const file of files) {
      const name = path.basename(file.pathname);
      // `outboundPaths.js` is the registry itself. `demo.js` names
      // `newsletter.blast` on purpose, to show the refusal happening — a
      // demonstration of a rejected path necessarily contains a rejected path.
      // Excluded by name and said out loud, rather than by a blanket rule that
      // would also hide a real mistake: demo.js sends nothing, it only shows
      // what happens when you try.
      if (name === 'outboundPaths.js' || name === 'demo.js') continue;
      // Comments stripped, string contents kept — this scan needs the *value*
      // of each `via`, so it cannot use the full stripper. A comment in
      // trustHistory.js explaining this very scan contained the pattern it
      // greps for, and the first version reported it as an undeclared path.
      const source = withoutComments(await readFile(file, 'utf8'));
      for (const match of source.matchAll(/\bvia:\s*'([^']+)'/g)) {
        if (!declared.has(match[1])) unknown.push(`${name}: ${match[1]}`);
      }
    }
    assert.deepEqual(unknown, [], 'a send names a path that is not declared');
  });

  it('and the demo really does still demonstrate the refusal', async () => {
    // Paired with the exclusion above, so "excluded from the scan" cannot
    // quietly become "no longer demonstrates anything".
    const demo = await readFile(new URL('demo.js', SRC), 'utf8');
    assert.match(demo, /newsletter\.blast/, 'the demo no longer shows an undeclared path being refused');
  });
});

describe('Scenario: approval required for outbound communication', () => {
  // The gates themselves are covered by the suites that built them. What is
  // asserted here is that each gated path's *claimed* enforcement point and
  // invariant are the real ones — a registry that drifts from the code is worse
  // than no registry, because it reads as assurance.
  it('every claimed invariant exists in the governance checks', async () => {
    const checks = await runChecks({});
    const ids = new Set(checks.map((c) => c.id));
    for (const p of OUTBOUND_PATHS.filter((x) => x.kind === GATED)) {
      assert.ok(ids.has(p.invariant), `${p.id} claims ${p.invariant}, which is not a check`);
    }
  });

  it('every claimed enforcement point exists in its module', async () => {
    for (const p of OUTBOUND_PATHS.filter((x) => x.kind === GATED)) {
      const source = await readFile(new URL(p.module, SRC), 'utf8');
      const fn = p.enforcedIn.split('(')[0];
      assert.ok(source.includes(fn), `${p.id} claims ${fn} in ${p.module}, which is not there`);
    }
  });

  it('every declared module actually sends', async () => {
    for (const p of OUTBOUND_PATHS) {
      const source = await readFile(new URL(p.module, SRC), 'utf8');
      assert.match(
        source,
        new RegExp(`via:\\s*'${p.id.replace('.', '\\.')}'`),
        `${p.module} does not carry a send for ${p.id}`,
      );
    }
  });
});

describe('Scenario: notify stakeholders for approval', () => {
  it('the notification paths are exempt, and say why', () => {
    // Asserted as a property, not a count. The first version of this test
    // hard-coded `length === 3` and broke the moment STORY-025 declared a
    // fourth notifier — a count assertion that fails on every future addition
    // while saying nothing about what is wrong.
    const notifiers = OUTBOUND_PATHS.filter((p) => p.id.includes('notify'));
    assert.ok(notifiers.length >= 3, 'the known notification paths are missing');
    for (const p of notifiers) {
      assert.equal(p.kind, EXEMPT, `${p.id} is a notifier but not exempt`);
      // The circularity is the reason, and it should be stated rather than
      // implied — a reader must not have to reconstruct it.
      assert.match(
        p.why,
        /circular|deadlock|not publishing|announces an absence/i,
        `${p.id} does not explain why a notification needs no gate`,
      );
    }
  });

  it('records notifications in-app as well as by email', async () => {
    // REQ-006's clause is "email or in-app alerts". The notifications table is
    // the in-app half, and it is what makes a missed email recoverable.
    const { rows } = await query(
      // The shared table, in public: since STORY-041 each tenant schema has a
      // view of the same name, which this used to count as extra tables.
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'notifications' AND table_type = 'BASE TABLE'",
    );
    assert.equal(rows[0].n, 1);
  });
});
