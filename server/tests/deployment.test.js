/**
 * STORY-015 acceptance tests.
 *
 * The story's clause is "the agent deploys the system to a public demo URL using
 * Docker", and half of it cannot be done from here — there is no cloud account,
 * no credentials, and Docker is not installed on this machine. The Dockerfiles
 * and the CI workflow are written and reviewed and have never been executed,
 * which the README says beside them.
 *
 * These test the half that is real from a laptop, and it is the half the trust
 * clause names: knowing what is running, knowing whether it is safe to send
 * traffic to, and stopping without dropping work.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../src/db/pool.js';
import {
  ACTOR,
  appliedMigrations,
  deploymentHistory,
  expectedMigrations,
  isDraining,
  readiness,
  recordReady,
  recordStart,
  recordStop,
  setDraining,
} from '../src/services/deployment.js';

/** The repo root, resolved from this file — `npm test` runs in the workspace. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

after(async () => {
  await query("DELETE FROM deployments WHERE version LIKE 'test-%'");
  setDraining(false);
  await closePool();
});

describe('STORY-015: readiness is a different question from liveness', () => {
  it('is ready when the database is reachable and the schema is current', async () => {
    const result = await readiness({});
    assert.equal(result.ready, true);
    assert.equal(result.status, 'ready');
    assert.ok(result.checks.find((c) => c.id === 'database').ok);
    assert.ok(result.checks.find((c) => c.id === 'schema').ok);
  });

  it('refuses traffic when the code expects a migration nobody applied', async () => {
    // The specific failure a rolling deploy produces: an instance starts fine,
    // answers /health, and throws on the first request that touches a column
    // that is not there. Readiness is what stops it being routed to.
    const applied = await appliedMigrations();
    const last = applied[applied.length - 1];
    await query('DELETE FROM schema_migrations WHERE filename = $1', [last]);
    try {
      const result = await readiness({});
      assert.equal(result.ready, false);
      assert.equal(result.status, 'not_ready');
      assert.deepEqual(result.missingMigrations, [last]);
      assert.match(result.checks.find((c) => c.id === 'schema').detail, /not applied/);
    } finally {
      await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [last]);
    }
    assert.equal((await readiness({})).ready, true, 'and recovers when it is applied');
  });

  it('stops being ready the moment it starts draining', async () => {
    setDraining(true);
    try {
      const result = await readiness({});
      assert.equal(result.ready, false);
      assert.equal(result.status, 'draining');
      // "Draining" and "broken" are different things: one wants no new traffic,
      // the other wants a restart. A single endpoint conflating them gets an
      // instance restarted mid-drain.
      assert.ok(result.checks.find((c) => c.id === 'database').ok, 'still healthy, just leaving');
    } finally {
      setDraining(false);
    }
    assert.equal(isDraining(), false);
  });

  it('knows what schema this build expects, from the build', async () => {
    const expected = expectedMigrations();
    assert.ok(expected.length > 0);
    assert.ok(expected.every((f) => f.endsWith('.sql')));
    assert.deepEqual([...expected].sort(), expected, 'ordered, so "latest" means something');
  });
});

describe('STORY-015: a release you can identify is a release you can roll back', () => {
  it('records what started, and against which schema', async () => {
    const deployment = await recordStart({ version: 'test-1.0.0', commit: 'abc1234' });
    assert.equal(deployment.version, 'test-1.0.0');
    assert.equal(deployment.commit_sha, 'abc1234');
    assert.equal(deployment.status, 'starting');
    assert.ok(deployment.migrations_expected > 0);
    assert.ok(deployment.instance.includes(String(process.pid)), 'two instances are two rows');
  });

  it('says on the log how far behind the schema is', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE action = 'deployment.started' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok('schemaBehind' in rows[0].metadata, 'the number that matters in an incident');
    assert.equal(rows[0].metadata.commit, 'abc1234');
  });

  it('marks an instance ready only when readiness actually passed', async () => {
    const deployment = await recordStart({ version: 'test-1.0.1' });
    const ready = await recordReady({
      deploymentId: deployment.id,
      readinessResult: await readiness({}),
    });
    assert.equal(ready.status, 'ready');
    assert.ok(ready.ready_at);
  });

  it('marks an instance degraded rather than ready when it is not', async () => {
    const deployment = await recordStart({ version: 'test-1.0.2' });
    const degraded = await recordReady({
      deploymentId: deployment.id,
      readinessResult: {
        ready: false,
        checks: [{ id: 'schema', ok: false, detail: 'behind' }],
        missingMigrations: ['999_future.sql'],
      },
    });
    assert.equal(degraded.status, 'degraded');

    const { rows } = await query(
      `SELECT action, metadata FROM audit_log
        WHERE entity_type = 'deployment' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(deployment.id)],
    );
    assert.equal(rows[0].action, 'deployment.degraded');
    assert.deepEqual(rows[0].metadata.missingMigrations, ['999_future.sql']);
  });

  it('distinguishes stopping on purpose from crashing', async () => {
    const clean = await recordStart({ version: 'test-1.0.3' });
    const stopped = await recordStop({ deploymentId: clean.id, reason: 'SIGTERM', clean: true });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.stop_reason, 'SIGTERM');

    const bad = await recordStart({ version: 'test-1.0.4' });
    const crashed = await recordStop({ deploymentId: bad.id, reason: 'OOM', clean: false });
    // A clean shutdown and a crash look identical in a status column, and an
    // instance that keeps crashing and restarting looks like a healthy deploy
    // history unless the difference is recorded.
    assert.equal(crashed.status, 'crashed');
  });

  it('answers "what is running" with the instance that has not stopped', async () => {
    const running = await recordStart({ version: 'test-1.0.5' });
    const { current, history } = await deploymentHistory({ limit: 50 });
    assert.ok(current, 'something is running');
    assert.ok(history.length > 0);
    assert.equal(current.stopped_at, null);
    await recordStop({ deploymentId: running.id, reason: 'test cleanup', clean: true });
  });

  it('records every deployment event against the agent the story names', async () => {
    const { rows } = await query(
      `SELECT DISTINCT actor FROM audit_log WHERE action LIKE 'deployment.%'`,
    );
    assert.deepEqual(rows.map((r) => r.actor), [ACTOR]);
  });
});

describe('What could not be built here, stated rather than implied', () => {
  it('ships container and CI configuration that has never been executed', () => {
    for (const file of [
      'server/Dockerfile',
      'server/Dockerfile.worker',
      'client/Dockerfile',
      '.github/workflows/ci.yml',
    ]) {
      const text = readRepoFile(file);
      assert.match(
        text,
        /NOT (BUILT|RUN)/,
        `${file} must say plainly that it has not been executed`,
      );
    }
  });

  it('runs the API as PID 1 so SIGTERM reaches the graceful shutdown', () => {
    const dockerfile = readRepoFile('server/Dockerfile');
    // Under a shell wrapper the signal goes to the shell, and the drain this
    // story added never runs — a graceful shutdown defeated by its own CMD.
    assert.match(dockerfile, /CMD \["node", "server\/src\/index\.js"\]/);
    assert.match(dockerfile, /USER app/, 'and not as root');
  });

  it('health-checks the container on liveness, not readiness', () => {
    const dockerfile = readRepoFile('server/Dockerfile');
    assert.match(dockerfile, /api\/health/);
    assert.ok(
      !/HEALTHCHECK[\s\S]*api\/ready/.test(dockerfile),
      'a missing migration is not something a container restart fixes',
    );
  });
});
