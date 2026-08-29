/**
 * Infrastructure and Deployment Agent (STORY-015).
 *
 * The story asks for deployment to a public URL using Docker. That half is not
 * buildable here — no cloud account, no credentials, and Docker is not
 * installed — and the README says so rather than a Dockerfile standing in for a
 * deployment that was never run.
 *
 * This module is the half that is real from a laptop, and it is the half the
 * trust clause names: knowing what is running, knowing whether it is safe to
 * send traffic to, and stopping without dropping work.
 *
 * The distinction that does the work here is **liveness versus readiness**.
 * `/health` has always answered "is this process up". Nothing has ever answered
 * "is this instance safe to route to", and an instance whose code expects a
 * migration nobody applied is up and must not receive traffic. A load balancer
 * given only the first question will keep sending requests to an instance that
 * cannot serve them.
 */
import { readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';

export const ACTOR = 'InfrastructureDeploymentAgent';

/**
 * Whether this instance is draining.
 *
 * Module state rather than a column: it is a fact about *this process*, and a
 * second instance reading it from the database would conclude it was draining
 * too. Readiness is per-instance, which is the whole reason a load balancer
 * asks each one separately.
 */
let draining = false;
export const setDraining = (value) => {
  draining = value;
};
export const isDraining = () => draining;

const here = dirname(fileURLToPath(import.meta.url));

/** Migration files this build ships, i.e. the schema this code expects. */
export function expectedMigrations() {
  return readdirSync(join(here, '../db/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Migrations the database has actually run. */
export async function appliedMigrations(client = pool) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return rows.map((r) => r.filename);
}

/**
 * Is this instance safe to send traffic to?
 *
 * Three things, and each is a different failure with a different response:
 *
 *   the database is reachable — otherwise every request fails anyway;
 *   the schema is at least what this code expects — an instance running ahead of
 *     its migrations answers requests by throwing on a missing column, and is
 *     the specific failure a rolling deploy produces if readiness ignores it;
 *   the process is not shutting down — an instance draining should stop
 *     receiving new work before it stops being able to do it.
 */
export async function readiness({ draining: override = null } = {}, client = pool) {
  const isDrainingNow = override ?? draining;
  const checks = [];

  let dbOk = false;
  try {
    await client.query('SELECT 1');
    dbOk = true;
  } catch (error) {
    checks.push({ id: 'database', ok: false, detail: error.message });
  }
  if (dbOk) checks.push({ id: 'database', ok: true, detail: 'reachable' });

  let missing = [];
  if (dbOk) {
    const expected = expectedMigrations();
    const applied = new Set(await appliedMigrations(client));
    missing = expected.filter((m) => !applied.has(m));
    checks.push({
      id: 'schema',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${expected.length} migrations applied`
          : `${missing.length} migration(s) this build expects are not applied: ${missing.join(', ')}`,
    });
  }

  checks.push({
    id: 'accepting',
    ok: !isDrainingNow,
    detail: isDrainingNow
      ? 'shutting down, finishing in-flight requests'
      : 'accepting traffic',
  });

  const ready = checks.every((c) => c.ok);
  return {
    ready,
    // A load balancer reads this; a person reads the checks.
    status: ready ? 'ready' : isDrainingNow ? 'draining' : 'not_ready',
    checks,
    missingMigrations: missing,
  };
}

/**
 * Records that an instance started.
 *
 * Written at boot rather than by whatever deploys it: the process that knows
 * which commit it is running is the process itself, and a deployment record
 * produced by the deployer describes what it *intended* to start.
 */
export async function recordStart({ version, commit = '', environment = config.nodeEnv } = {}) {
  const expected = expectedMigrations();
  const applied = await appliedMigrations();

  const { rows } = await pool.query(
    `INSERT INTO deployments
       (version, commit_sha, environment, migrations_expected, migrations_applied,
        status, instance)
     VALUES ($1,$2,$3,$4,$5,'starting',$6)
     RETURNING *`,
    [version, commit, environment, expected.length, applied.length, `${hostname()}:${process.pid}`],
  );

  await recordAction({
    actor: ACTOR,
    action: 'deployment.started',
    entityType: 'deployment',
    entityId: rows[0].id,
    metadata: {
      version,
      commit,
      environment,
      migrationsExpected: expected.length,
      migrationsApplied: applied.length,
      // The number that matters during an incident, said plainly.
      schemaBehind: expected.length - applied.length,
      instance: rows[0].instance,
    },
  });

  return rows[0];
}

/** Marks an instance ready, once readiness actually passes. */
export async function recordReady({ deploymentId, readinessResult }) {
  const status = readinessResult.ready ? 'ready' : 'degraded';
  const { rows } = await pool.query(
    `UPDATE deployments SET status = $2, ready_at = now() WHERE id = $1 RETURNING *`,
    [deploymentId, status],
  );

  await recordAction({
    actor: ACTOR,
    action: readinessResult.ready ? 'deployment.ready' : 'deployment.degraded',
    entityType: 'deployment',
    entityId: deploymentId,
    metadata: {
      status,
      failing: readinessResult.checks.filter((c) => !c.ok).map((c) => c.id),
      missingMigrations: readinessResult.missingMigrations,
    },
  });

  return rows[0];
}

/**
 * Marks an instance stopped, and says whether it meant to.
 *
 * A clean shutdown and a crash look identical in a status column and are very
 * different events — an instance that keeps crashing and restarting looks like a
 * healthy deploy history unless the difference is recorded.
 */
export async function recordStop({ deploymentId, reason = 'signal', clean = true }) {
  const { rows } = await pool.query(
    `UPDATE deployments
        SET status = $2, stopped_at = now(), stop_reason = $3
      WHERE id = $1 RETURNING *`,
    [deploymentId, clean ? 'stopped' : 'crashed', reason],
  );

  await recordAction({
    actor: ACTOR,
    action: clean ? 'deployment.stopped' : 'deployment.crashed',
    entityType: 'deployment',
    entityId: deploymentId,
    metadata: { reason, clean },
  });

  return rows[0];
}

/** What is running, and what ran before it. */
export async function deploymentHistory({ limit = 20 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM deployments ORDER BY started_at DESC LIMIT $1',
    [limit],
  );
  return {
    current: rows.find((r) => r.stopped_at === null) ?? null,
    history: rows,
  };
}
