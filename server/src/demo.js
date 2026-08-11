/**
 * End-to-end walkthrough of STORY-001, printed step by step.
 *
 * Run against a freshly seeded database:  npm run db:reset && npm run demo
 */
import { draftWeeklyPosts, weekStart } from './agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from './agents/opportunityScoutingAgent.js';
import { draftOutreachMessages } from './agents/prOutreachAgent.js';
import { config } from './config.js';
import { closePool, query } from './db/pool.js';
import { approveDraft, approveOutreach } from './services/approvals.js';
import { listAuditLog } from './services/auditLog.js';
import { sendOutreachMessage } from './services/outreachSender.js';
import { publishDue, scheduleDraft } from './services/scheduler.js';

const rule = (title) => console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);

const { rows: authors } = await query('SELECT * FROM authors ORDER BY id LIMIT 1');
const author = authors[0];
const { rows: books } = await query('SELECT * FROM books WHERE author_id = $1 LIMIT 1', [author.id]);
const book = books[0];

rule('1. Inputs (uploaded by the author)');
console.log(`author : ${author.name} (id ${author.id})`);
console.log(`book   : "${book.title}" — themes: ${book.themes.join(', ')}`);
const { rows: history } = await query(
  'SELECT count(*)::int AS n FROM social_history WHERE author_id = $1',
  [author.id],
);
console.log(`history: ${history[0].n} prior posts used for voice matching`);

rule(`2. Content Drafting Agent generates a week of posts (provider: ${config.aiProvider})`);
const drafts = await draftWeeklyPosts({ authorId: author.id, bookId: book.id, count: 4 });
for (const d of drafts) {
  console.log(`\n[${d.platform}] draft ${d.id} — confidence ${d.confidence} → ${d.status}`);
  console.log(`  themes: ${d.themes_used.join(', ')}`);
  console.log(`  ${d.rationale}`);
  console.log(`  ${d.content.replace(/\n/g, '\n  ')}`);
}

rule('3. Weekly cadence check (acceptance: at least 3 posts per week)');
const { rows: coverage } = await query(
  `SELECT week_of, COUNT(*)::int AS total, COUNT(DISTINCT platform)::int AS platforms
     FROM drafts WHERE author_id = $1 GROUP BY week_of`,
  [author.id],
);
for (const week of coverage) {
  const ok = week.total >= config.minPostsPerWeek ? 'PASS' : 'FAIL';
  console.log(
    `week of ${week.week_of.toISOString().slice(0, 10)}: ${week.total} posts across ${week.platforms} platforms — ${ok}`,
  );
}

rule('4. Approval gate — scheduling is refused before approval');
const target = drafts.find((d) => d.status === 'pending_approval') ?? drafts[0];
try {
  await scheduleDraft({ draftId: target.id });
  console.log('UNEXPECTED: scheduling succeeded without approval');
} catch (error) {
  console.log(`blocked as designed: ${error.message}`);
}

rule('5. Human approves, then the post is queued at an optimal time');
await approveDraft({ draftId: target.id, reviewer: 'Anvi Siddabhattuni', notes: 'Reads like me.' });
const scheduled = await scheduleDraft({ draftId: target.id });
console.log(`draft ${target.id} (${scheduled.platform}) queued for ${scheduled.scheduled_for.toISOString()}`);

rule('6. Publishing through the mocked platform adapters');
const published = await publishDue({ now: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
for (const post of published) {
  console.log(`${post.platform}: ${post.status} — external id ${post.external_id ?? post.error}`);
}

rule('7. Audit trail (append-only)');
const log = await listAuditLog({ authorId: author.id, limit: 20 });
for (const entry of [...log].reverse()) {
  console.log(`${entry.created_at.toISOString()}  ${entry.actor.padEnd(22)} ${entry.action}`);
}

rule('8. Append-only enforcement');
try {
  await query("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [log[0].id]);
  console.log('UNEXPECTED: audit log accepted an UPDATE');
} catch (error) {
  console.log(`rejected as designed: ${error.message}`);
}

console.log(`\nweek of ${weekStart()} — STORY-001 complete\n`);

// ── STORY-002 — opportunities and outreach ──────────────────────────────────

rule('9. Opportunity Scouting Agent scans the directories');
const scan = await scoutOpportunities({ authorId: author.id, bookId: book.id });
console.log(
  `scanned ${scan.scanned} listings → ${scan.identified.length} identified, ` +
    `${scan.rejected.length} rejected as off-topic`,
);
for (const o of scan.identified) {
  console.log(`  [${o.type.padEnd(8)}] ${o.name.padEnd(30)} rel=${o.relevance}  ${o.matched_themes.join(', ')}`);
}
console.log('\nrejected:');
for (const r of scan.rejected) console.log(`  ${r.name.padEnd(30)} rel=${r.relevance}`);

rule(`10. Monthly cadence check (acceptance: at least ${config.minOpportunitiesPerMonth} per month)`);
const { rows: monthly } = await query(
  `SELECT discovered_month, COUNT(*)::int AS total, COUNT(DISTINCT type)::int AS types
     FROM opportunities WHERE author_id = $1 GROUP BY discovered_month`,
  [author.id],
);
for (const month of monthly) {
  const ok = month.total >= config.minOpportunitiesPerMonth ? 'PASS' : 'FAIL';
  console.log(
    `${month.discovered_month.toISOString().slice(0, 7)}: ${month.total} opportunities across ${month.types} types — ${ok}`,
  );
}
const { rows: breakdown } = await query(
  `SELECT type, COUNT(*)::int AS total FROM opportunities WHERE author_id = $1 GROUP BY type ORDER BY type`,
  [author.id],
);
console.log(`by type: ${breakdown.map((b) => `${b.type} ${b.total}`).join(' · ')}`);

rule('11. PR and Outreach Agent drafts personalized messages');
const outreach = await draftOutreachMessages({ authorId: author.id, bookId: book.id, limit: 3 });
for (const m of outreach) {
  console.log(`\n[${m.opportunity.type}] message ${m.id} — confidence ${m.confidence} → ${m.status}`);
  console.log(`  to: ${m.opportunity.host} <${m.opportunity.contact_email}>`);
  console.log(`  subject: ${m.subject}`);
  console.log(`  ${m.rationale}`);
  console.log(`  ${m.body.replace(/\n/g, '\n  ')}`);
}

rule('12. Approval gate — sending is refused before approval');
const pitch = outreach.find((m) => m.status === 'pending_approval') ?? outreach[0];
try {
  await sendOutreachMessage({ messageId: pitch.id });
  console.log('UNEXPECTED: the message was sent without approval');
} catch (error) {
  console.log(`blocked as designed: ${error.message}`);
}

rule('13. Human approves, then the message goes out through the mocked email provider');
await approveOutreach({ messageId: pitch.id, reviewer: 'Anvi Siddabhattuni', notes: 'Good fit.' });
const sent = await sendOutreachMessage({ messageId: pitch.id });
console.log(`message ${pitch.id} → ${sent.status}, provider id ${sent.external_id}, to ${sent.recipient}`);

rule('14. Outreach audit trail');
const outreachLog = await listAuditLog({ authorId: author.id, limit: 60 });
for (const entry of [...outreachLog].reverse().filter((e) => e.action.startsWith('outreach.') || e.action.startsWith('opportunity.'))) {
  console.log(`${entry.created_at.toISOString()}  ${entry.actor.padEnd(26)} ${entry.action}`);
}

console.log(`\nmonth of ${monthStart()} — STORY-002 complete\n`);
await closePool();
