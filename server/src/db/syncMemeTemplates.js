/**
 * Adds any template in the seed that a database does not have yet.
 *
 * `db:reset` seeds the whole library; a live database is never reset, so new
 * formats reach it through this instead. Existing rows — including a template
 * someone retired — are left exactly as they are.
 */
import { closePool, query } from './pool.js';
import { TEMPLATE_SEED } from './memeTemplateSeed.js';
import { addTemplate } from '../services/memeLibrary.js';

const { rows } = await query('SELECT key FROM meme_templates');
const have = new Set(rows.map((r) => r.key));
const missing = TEMPLATE_SEED.filter((t) => !have.has(t.key));
for (const template of missing) await addTemplate(template, { force: true });
console.log(`meme templates: ${missing.length} added (${missing.map((t) => t.key).join(', ') || 'none'}), ${have.size} already present`);
await closePool();
