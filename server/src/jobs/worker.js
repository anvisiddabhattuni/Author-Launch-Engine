import { config } from '../config.js';
import { closePool } from '../db/pool.js';

import { tick } from './queue.js';

/**
 * The background worker (STORY-065).
 *
 * Its own process, on purpose. Run inside the API it would die with every
 * restart and double-run every job the moment a second API instance existed;
 * polling Postgres instead means the database is the queue, two workers are
 * safe, and `tick()` stays a plain function the tests can call directly rather
 * than a timer they have to wait on.
 *
 *   npm run worker
 */
const poll = config.workerPollSeconds * 1000;
let stopping = false;
let current = null;

async function loop() {
  while (!stopping) {
    try {
      current = tick();
      const { reclaimed, scheduled, ran } = await current;
      if (reclaimed.length || scheduled.length || ran.length) {
        const done = ran.filter((j) => j.status === 'done').length;
        const dead = ran.filter((j) => j.status === 'dead_letter').length;
        const retry = ran.filter((j) => j.status === 'queued').length;
        console.log(
          `[worker] ${new Date().toISOString()} ` +
            `scheduled=${scheduled.length} ran=${ran.length} ` +
            `done=${done} retrying=${retry} dead=${dead}` +
            (reclaimed.length ? ` reclaimed=${reclaimed.length}` : ''),
        );
        for (const job of ran.filter((j) => j.status === 'dead_letter')) {
          console.error(`[worker] job ${job.id} (${job.kind}) needs a human: ${job.last_error}`);
        }
      }
    } catch (error) {
      // A tick that throws is the worker's own problem — a lost connection,
      // say. Log it and keep polling: exiting would turn a transient fault into
      // an outage, and the jobs themselves are already safe to re-run.
      console.error(`[worker] tick failed: ${error.message}`);
    } finally {
      current = null;
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

/** Finish the job in hand before exiting, so a deploy does not create a stale claim. */
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received — finishing the job in hand`);
  try {
    await current;
  } catch {
    /* already logged */
  }
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  `[worker] polling every ${config.workerPollSeconds}s · sweeps every ` +
    `${config.jobSweepSeconds}s · ${config.jobMaxAttempts} attempts then a human`,
);
await loop();
