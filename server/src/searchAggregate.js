/**
 * One aggregation run and a reconciliation, from the command line (STORY-055).
 *
 *   npm run search:aggregate
 *
 * The worker does the same every sweep when ELASTICSEARCH_URL is set; this is
 * for filling an index by hand — after a restore, or before taking screenshots.
 */
import { closePool } from './db/pool.js';
import { aggregate, reconcile } from './services/searchIndex.js';

try {
  let run;
  do {
    run = await aggregate({});
    for (const s of run.sources) console.log(`${s.source.padEnd(9)} indexed ${s.indexed}, repaired ${s.repaired}, through id ${s.mark}`);
  } while (run.sources.some((s) => s.more));
  console.log(`metrics   ${run.metrics} snapshot document(s)`);
  for (const c of await reconcile({})) {
    console.log(`${c.source.padEnd(9)} ${c.inSync ? 'in sync' : 'NOT IN SYNC'}: ${c.sourceCount} rows, ${c.indexCount} documents; filled ${c.filled}, rewritten ${c.rewritten}`);
  }
} finally {
  await closePool();
}
