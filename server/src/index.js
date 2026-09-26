import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import {
  readiness,
  recordReady,
  recordStart,
  recordStop,
  setDraining,
} from './services/deployment.js';
import { startHeartbeat, startMonitor } from './services/healthMonitoring.js';
import { snapshot as requestStats } from './services/requestStats.js';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));

/**
 * How long to let in-flight requests finish before giving up on them.
 *
 * A deploy sends SIGTERM and then SIGKILL after its own grace period — 30s on
 * most platforms — so this has to be comfortably under that or the platform
 * kills the process mid-request anyway and the graceful path was decoration.
 */
const DRAIN_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 10000);

const app = createApp();
const server = app.listen(config.port, async () => {
  console.log(`Author Launch Engine API on http://localhost:${config.port}`);
  console.log(`content provider: ${config.aiProvider}`);

  try {
    const register = () =>
      recordStart({
        version,
        commit: process.env.GIT_COMMIT ?? '',
        component: 'api',
        // Where a monitor can probe this instance from outside it. Overridable
        // because behind a container network "localhost" is the monitor, not us.
        url: process.env.PUBLIC_URL ?? `http://localhost:${config.port}`,
      });
    const deployment = await register();
    server.deploymentId = deployment.id;

    // Say we are alive on a timer, and check whether everything else is
    // (STORY-027). Both unref'd, so neither keeps a draining process open.
    server.stopHeartbeat = startHeartbeat({
      deploymentId: deployment.id,
      stats: requestStats,
      reregister: register,
    });
    server.stopMonitor = startMonitor({});

    // Readiness is checked rather than assumed. An instance whose code expects
    // a migration nobody applied starts perfectly well and cannot serve a
    // request — saying "ready" here because `listen` succeeded is exactly the
    // mistake that keeps a rolling deploy routing to a broken instance.
    const ready = await readiness({});
    await recordReady({ deploymentId: deployment.id, readinessResult: ready });

    if (!ready.ready) {
      console.error('[deploy] NOT READY — this instance should not receive traffic:');
      for (const check of ready.checks.filter((c) => !c.ok)) {
        console.error(`[deploy]   ${check.id}: ${check.detail}`);
      }
    } else {
      console.log(`[deploy] ready · version ${version} · ${ready.checks.length} checks passing`);
    }
  } catch (error) {
    // A release record that cannot be written must not stop the API serving.
    // Losing the deployment log is bad; refusing to start because of it is worse.
    console.error(`[deploy] could not record this release: ${error.message}`);
  }
});

let shuttingDown = false;

/**
 * Stop taking new work, finish what is in hand, then exit.
 *
 * The worker has done this since STORY-065 — "so a deploy does not create a
 * stale claim" — and the API never did. Without it, SIGTERM terminates the
 * process and every request still awaiting the database is severed mid-response:
 * a client sees a dropped connection rather than an answer, on every deploy.
 *
 * The order matters. Readiness flips first so a load balancer stops sending new
 * requests while the old ones are still finishing; closing the socket first
 * would refuse traffic that has nowhere else to go yet.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[deploy] ${signal} received — draining, ${DRAIN_MS}ms grace`);
  setDraining(true);

  const forced = setTimeout(() => {
    console.error('[deploy] in-flight requests did not finish in time — exiting anyway');
    process.exit(1);
  }, DRAIN_MS);
  // Do not let the timer itself hold the process open once everything is done.
  forced.unref();

  server.stopHeartbeat?.();
  server.stopMonitor?.();

  server.close(async () => {
    try {
      // The id may have moved if the record was recreated under us.
      const deploymentId = server.stopHeartbeat?.currentDeploymentId?.() ?? server.deploymentId;
      if (deploymentId) {
        await recordStop({ deploymentId, reason: signal, clean: true });
      }
    } catch (error) {
      console.error(`[deploy] could not record the stop: ${error.message}`);
    }
    await closePool();
    clearTimeout(forced);
    console.log('[deploy] drained cleanly');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
