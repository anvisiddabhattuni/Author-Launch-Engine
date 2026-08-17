/**
 * End-to-end walkthrough of STORY-001 to STORY-004, printed step by step.
 *
 * Run against a freshly seeded database:  npm run db:reset && npm run demo
 */
import { draftWeeklyPosts, weekStart } from './agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from './agents/opportunityScoutingAgent.js';
import { draftPressKit } from './agents/prMaterialsAgent.js';
import { draftOutreachMessages } from './agents/prOutreachAgent.js';
import { config } from './config.js';
import { closePool, query } from './db/pool.js';
import { approveDraft, approveOutreach, approvePrMaterial } from './services/approvals.js';
import { listAuditLog } from './services/auditLog.js';
import { findApproachingMilestones } from './services/milestones.js';
import { draftApproachingKits } from './services/milestoneWatcher.js';
import { sendOutreachMessage } from './services/outreachSender.js';
import { distributePressKit } from './services/prDistributor.js';
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
// On a re-run every opportunity may already carry a message, so fall back to
// one still waiting on a human rather than dropping the gate demonstration.
const { rows: waiting } = await query(
  "SELECT * FROM outreach_messages WHERE author_id = $1 AND status = 'pending_approval' ORDER BY id LIMIT 1",
  [author.id],
);
const pitch = outreach.find((m) => m.status === 'pending_approval') ?? outreach[0] ?? waiting[0];
if (!pitch) {
  console.log('skipped: every drafted message has already been approved and sent.');
  console.log('run npm run db:reset && npm run demo to watch the gate refuse from scratch.');
} else {
  try {
    await sendOutreachMessage({ messageId: pitch.id });
    console.log('UNEXPECTED: the message was sent without approval');
  } catch (error) {
    console.log(`blocked as designed: ${error.message}`);
  }
}

rule('13. Human approves, then the message goes out through the mocked email provider');
if (!pitch) {
  console.log('skipped: nothing is waiting on a reviewer.');
} else {
  await approveOutreach({ messageId: pitch.id, reviewer: 'Anvi Siddabhattuni', notes: 'Good fit.' });
  const sent = await sendOutreachMessage({ messageId: pitch.id });
  console.log(`message ${pitch.id} → ${sent.status}, provider id ${sent.external_id}, to ${sent.recipient}`);
}

rule('14. Outreach audit trail');
const outreachLog = await listAuditLog({ authorId: author.id, limit: 60 });
for (const entry of [...outreachLog].reverse().filter((e) => e.action.startsWith('outreach.') || e.action.startsWith('opportunity.'))) {
  console.log(`${entry.created_at.toISOString()}  ${entry.actor.padEnd(26)} ${entry.action}`);
}

console.log(`\nmonth of ${monthStart()} — STORY-002 complete\n`);

// ── STORY-003 — press materials for book milestones ─────────────────────────

rule('15. Scheduled milestones (the trigger for a press kit)');
const { rows: milestones } = await query(
  'SELECT * FROM milestones WHERE author_id = $1 ORDER BY event_date',
  [author.id],
);
for (const m of milestones) {
  console.log(`  [${m.type.padEnd(11)}] ${m.event_date.toISOString().slice(0, 10)}  ${m.title}`);
}

/**
 * A milestone can only hold one kit, so on a re-run without `db:reset` the
 * existing kit is shown instead of failing. The demo is documentation; it has
 * to survive being run twice.
 */
async function kitFor(milestone) {
  const { rows } = await query('SELECT * FROM pr_kits WHERE milestone_id = $1', [milestone.id]);
  if (!rows[0]) {
    return { ...(await draftPressKit({ milestoneId: milestone.id })), reused: false };
  }
  const { rows: materials } = await query(
    'SELECT * FROM pr_materials WHERE kit_id = $1 ORDER BY id',
    [rows[0].id],
  );
  return { kit: rows[0], milestone, materials, reused: true };
}

rule('16. PR and Outreach Agent drafts a press kit on request');
// The anniversary is deliberately left alone here. STORY-003 drafts when a
// person asks; STORY-004 drafts when the date approaches, and stage 21 has to
// find something to do.
const kits = [];
for (const milestone of milestones.filter((m) => m.type !== 'anniversary')) {
  const { kit, materials, reused } = await kitFor(milestone);
  kits.push({ kit, milestone, materials });
  const note = reused ? '  (existing kit — run npm run db:reset for a clean pass)' : '';
  console.log(`\n[${milestone.type}] kit ${kit.id} — ${milestone.title}${note}`);
  for (const material of materials) {
    console.log(
      `  ${material.type.padEnd(14)} alignment=${material.theme_alignment} ` +
        `confidence=${material.confidence} → ${material.status}`,
    );
    console.log(`    themes: ${material.themes_used.join(', ') || 'none'}`);
    console.log(`    ${material.headline}`);
  }
}

rule('17. The launch press release in full (acceptance: aligned with the book themes)');
const launch = kits.find((k) => k.milestone.type === 'launch') ?? kits[0];
const release = launch.materials.find((m) => m.type === 'press_release');
console.log(release.body.replace(/^/gm, '  '));

const alreadyDistributed = launch.kit.status === 'distributed';

rule('18. Approval gate — distribution is refused while any material is unapproved');
if (alreadyDistributed) {
  console.log('skipped: this kit was already distributed on an earlier run.');
  console.log('run npm run db:reset && npm run demo to watch the gate refuse from scratch.');
} else {
  try {
    await distributePressKit({ kitId: launch.kit.id });
    console.log('UNEXPECTED: the kit was distributed without approval');
  } catch (error) {
    console.log(`blocked as designed: ${error.message}`);
  }

  console.log('\napproving one material of three, then trying again:');
  await approvePrMaterial({
    materialId: launch.materials[0].id,
    reviewer: 'Anvi Siddabhattuni',
    notes: 'Release reads well.',
  });
  try {
    await distributePressKit({ kitId: launch.kit.id });
    console.log('UNEXPECTED: a partially approved kit was distributed');
  } catch (error) {
    console.log(`still blocked as designed: ${error.message}`);
  }
}

rule('19. Human approves the rest, then the kit goes to the matching press contacts');
let distributions;
if (alreadyDistributed) {
  ({ rows: distributions } = await query(
    'SELECT * FROM pr_distributions WHERE kit_id = $1 ORDER BY id',
    [launch.kit.id],
  ));
  console.log('already approved and distributed on an earlier run; showing what was sent.');
} else {
  for (const material of launch.materials.slice(1)) {
    await approvePrMaterial({
      materialId: material.id,
      reviewer: 'Anvi Siddabhattuni',
      notes: 'Approved for distribution.',
    });
  }
  ({ distributions } = await distributePressKit({ kitId: launch.kit.id }));
}
const { rows: allContacts } = await query('SELECT COUNT(*)::int AS n FROM press_contacts');
console.log(
  `distributed to ${distributions.length} of ${allContacts[0].n} press contacts ` +
    '(the rest cover unrelated beats):',
);
for (const d of distributions) {
  console.log(`  ${d.outlet.padEnd(22)} ${d.status.padEnd(6)} ${d.recipient.padEnd(34)} ${d.external_id ?? d.error}`);
}

rule('20. Press audit trail');
const pressLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of [...pressLog]
  .reverse()
  .filter((e) => e.action.startsWith('pr_') || e.action.startsWith('milestone.'))) {
  console.log(`${entry.created_at.toISOString()}  ${entry.actor.padEnd(26)} ${entry.action}`);
}

console.log('\nSTORY-003 complete — press kits drafted, reviewed and distributed\n');

// ── STORY-004 — an approaching anniversary drafts its own kit ────────────────

rule(`21. What is approaching (lead time: ${config.milestoneLeadTimeDays} days)`);
const { rows: bookRow } = await query('SELECT published_on FROM books WHERE id = $1', [book.id]);
console.log(`"${book.title}" was published ${bookRow[0].published_on.toISOString().slice(0, 10)}\n`);

const approaching = await findApproachingMilestones({ authorId: author.id });
for (const m of approaching) {
  const which = m.anniversaryYears ? ` (anniversary no. ${m.anniversaryYears})` : '';
  console.log(
    `  [${m.type.padEnd(11)}] in ${String(m.days_until).padStart(3)} days  ` +
      `${(m.kit_id ? 'kit already drafted' : 'NEEDS A KIT').padEnd(19)}  ${m.title}${which}`,
  );
}
const beyond = milestones.filter((m) => !approaching.some((a) => a.id === m.id));
for (const m of beyond) {
  const days = Math.round((m.event_date - Date.now()) / 86400000);
  console.log(`  [${m.type.padEnd(11)}] in ${String(days).padStart(3)} days  outside the window   ${m.title}`);
}

rule('22. The agent drafts for the approaching anniversary without being asked');
const watch = await draftApproachingKits({ authorId: author.id });
console.log(
  `${watch.approaching.length} approaching → ${watch.drafted.length} drafted, ` +
    `${watch.alreadyDrafted.length} already had a kit, ${watch.failed.length} failed`,
);

const anniversaryKit =
  watch.drafted.find((d) => d.milestone.type === 'anniversary') ??
  watch.alreadyDrafted.find((m) => m.type === 'anniversary');

if (watch.drafted.length === 0) {
  console.log('\nnothing new to draft on this run — npm run db:reset && npm run demo for a clean pass');
}

for (const d of watch.drafted) {
  console.log(`\n[${d.milestone.type}] kit ${d.kit.id} — ${d.milestone.title}`);
  if (d.anniversaryYears) console.log(`  counted as anniversary no. ${d.anniversaryYears}`);
  for (const material of d.materials) {
    console.log(
      `  ${material.type.padEnd(14)} alignment=${material.theme_alignment} ` +
        `confidence=${material.confidence} → ${material.status}`,
    );
  }
}

rule('23. The anniversary release states which anniversary it is');
const anniversaryRelease = watch.drafted
  .find((d) => d.milestone.type === 'anniversary')
  ?.materials.find((m) => m.type === 'press_release');

if (anniversaryRelease) {
  console.log(anniversaryRelease.body.split('\n').slice(0, 7).join('\n').replace(/^/gm, '  '));
  console.log('\n  (before this story the copy said "first anniversary" regardless of the year)');
} else {
  console.log('  the anniversary kit already existed; reset the database to watch it drafted');
}

rule('24. Drafting on detection is still not permission to send');
if (anniversaryKit) {
  const kitId = anniversaryKit.kit?.id ?? anniversaryKit.kit_id;
  try {
    await distributePressKit({ kitId });
    console.log('UNEXPECTED: an unreviewed kit was distributed');
  } catch (error) {
    console.log(`blocked as designed: ${error.message}`);
  }
}

rule('25. Detection audit trail');
const watchLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of [...watchLog]
  .reverse()
  .filter((e) => e.action === 'milestone.approaching' || e.action === 'milestone.scan_completed')) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'milestone.approaching'
      ? `${meta.milestone} — ${meta.daysUntil} days out (window ${meta.leadTimeDays})`
      : `${meta.approaching} approaching, ${meta.drafted} drafted, window ends ${meta.windowEndsOn}`;
  console.log(`${entry.created_at.toISOString()}  ${entry.action.padEnd(28)} ${detail}`);
}

console.log('\nSTORY-004 complete — an approaching anniversary drafts its own kit, still held for review\n');
await closePool();
