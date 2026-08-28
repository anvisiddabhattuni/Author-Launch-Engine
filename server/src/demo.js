/**
 * End-to-end walkthrough of STORY-001 to STORY-065 (plus STORY-008 through
 * STORY-011 to STORY-014, and STORY-066 to STORY-069), printed step by step.
 *
 * Run against a freshly seeded database:  npm run db:reset && npm run demo
 */
import jwt from 'jsonwebtoken';

import { alignToThemes } from './agents/contentAlignmentAgent.js';
import {
  listEscalations,
  monitorPressMaterials,
  recommendMix,
} from './agents/trustMonitoringAgent.js';
import { collectEngagement, compareFormats } from './services/engagement.js';
import {
  findAwaitingApproval,
  notifyAwaitingApproval,
} from './agents/approvalNotificationAgent.js';
import { sealAuditLog, verifyAuditLog } from './agents/auditSecurityAgent.js';
import { trustDashboard } from './agents/trustMonitoringAgent.js';
import { draftWeeklyPosts, scoreDraft, weekStart } from './agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from './agents/opportunityScoutingAgent.js';
import { draftPressKit } from './agents/prMaterialsAgent.js';
import { draftOutreachMessages } from './agents/prOutreachAgent.js';
import { config } from './config.js';
import { createApp } from './app.js';
import { closePool, query } from './db/pool.js';
import { HANDLERS } from './jobs/handlers.js';
import { ensureRecurringJobs, enqueue, reapStaleJobs, retryJob, runOnce, tick } from './jobs/queue.js';
import {
  approveDraft,
  approveMixRecommendation,
  approveOutreach,
  approvePrMaterial,
  rejectMixRecommendation,
} from './services/approvals.js';
import { listAuditLog } from './services/auditLog.js';
import { findApproachingMilestones } from './services/milestones.js';
import { draftApproachingKits } from './services/milestoneWatcher.js';
import { recordAwardOutcome } from './services/awardOutcome.js';
import { findAwardsAwaitingOutcome } from './services/awards.js';
import { sendOutreachMessage } from './services/outreachSender.js';
import { distributePressKit } from './services/prDistributor.js';
import { publishDue, scheduleDraft } from './services/scheduler.js';
import {
  findKitsAwaitingReview,
  notifyPendingReviews,
} from './services/reviewNotifier.js';
import { retrieveThemeGrounding } from './services/themeRetrieval.js';
import { deriveExpertise, scoreExpertise } from './services/authorExpertise.js';
import { resourceFor } from './services/coordination.js';
import { reviewMemeCandidate } from './services/brandSafety.js';
import {
  addTemplate,
  assessTemplate,
  listTemplates,
  retireTemplate,
  selectTemplate,
} from './services/memeLibrary.js';
import {
  getActiveIdentity,
  listVersions,
  saveIdentity,
  scoreIdentity,
} from './services/visualIdentity.js';
import { searchAllDirectories } from './services/directories.js';
import { scoreOpportunity } from './services/keywordAnalysis.js';
import { deriveVoice } from './services/voiceProfile.js';
import { assess } from './services/escalationPolicy.js';

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
  const { rows } = await query(
    `SELECT * FROM pr_kits
      WHERE milestone_id = $1
      ORDER BY CASE status WHEN 'drafting' THEN 0 WHEN 'distributed' THEN 1 ELSE 2 END, id DESC
      LIMIT 1`,
    [milestone.id],
  );
  if (!rows[0] || rows[0].status === 'superseded') {
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
  const when =
    days < 0
      ? `${String(Math.abs(days)).padStart(3)} days ago  already passed     `
      : `in ${String(days).padStart(3)} days  outside the window  `;
  console.log(`  [${m.type.padEnd(11)}] ${when} ${m.title}`);
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

// ── STORY-005 — a recorded win drafts its own kit ────────────────────────────

rule('26. Awards whose result nobody has written down');
const awaiting = await findAwardsAwaitingOutcome({ authorId: author.id });
if (awaiting.length === 0) {
  console.log('  none — the result was already recorded on an earlier run');
} else {
  for (const m of awaiting) {
    console.log(
      `  ${m.award_name ?? m.title} — ceremony ${m.days_since} day${Number(m.days_since) === 1 ? '' : 's'} ago, still marked shortlisted`,
    );
  }
  console.log('\n  the system will not guess. a false win in a press release is unrecoverable.');
}

const awardMilestone = milestones.find((m) => m.type === 'award');
const shortlistKit = kits.find((k) => k.milestone.type === 'award');

rule('27. Recording the win is what drafts the win release');
const win = await recordAwardOutcome({
  milestoneId: awardMilestone.id,
  outcome: 'won',
  actor: 'Anvi Siddabhattuni',
  notes: 'Confirmed at the London ceremony.',
});

if (win.drafted) {
  console.log(`outcome shortlisted → won. kit ${win.kit.id} drafted, held for review.`);
  if (win.supersededKit) {
    console.log(
      `shortlist kit ${win.supersededKit.id} withdrawn: ${win.supersededKit.superseded_reason}`,
    );
  }
  for (const material of win.materials) {
    console.log(
      `  ${material.type.padEnd(14)} alignment=${material.theme_alignment} ` +
        `confidence=${material.confidence} → ${material.status}`,
    );
  }
} else {
  console.log(
    `already recorded as ${win.milestone.outcome} — kit ${win.kit?.id ?? 'none'} ` +
      '(npm run db:reset && npm run demo for a clean pass)',
  );
}

rule('28. The win release states a win, not a shortlisting');
const winRelease =
  win.materials.find((m) => m.type === 'press_release') ??
  (
    await query(
      `SELECT p.* FROM pr_materials p
         JOIN pr_kits k ON k.id = p.kit_id
        WHERE k.milestone_id = $1 AND k.status = 'drafting' AND p.type = 'press_release'
        ORDER BY p.id DESC LIMIT 1`,
      [awardMilestone.id],
    )
  ).rows[0];

if (winRelease) {
  console.log(winRelease.body.split('\n').slice(0, 7).join('\n').replace(/^/gm, '  '));
  if (shortlistKit) {
    const oldHeadline = shortlistKit.materials.find((m) => m.type === 'press_release')?.headline;
    if (oldHeadline && !/wins/i.test(oldHeadline)) {
      console.log(`\n  shortlist headline was: ${oldHeadline}`);
      console.log('  (before this story both would have said "has been shortlisted")');
    }
  }
}

rule('29. Drafting on a recorded win is still not permission to send');
const winKitId = win.kit?.id;
if (winKitId) {
  try {
    await distributePressKit({ kitId: winKitId });
    console.log('UNEXPECTED: an unreviewed win kit was distributed');
  } catch (error) {
    console.log(`blocked as designed: ${error.message}`);
  }
}

rule('30. The withdrawn shortlist kit cannot go out either');
if (shortlistKit && (win.supersededKit || shortlistKit.kit.status === 'superseded')) {
  try {
    await distributePressKit({ kitId: shortlistKit.kit.id });
    console.log('UNEXPECTED: withdrawn shortlist copy was distributed');
  } catch (error) {
    console.log(`blocked as designed: ${error.message}`);
  }
} else {
  console.log('  no shortlist kit left to refuse — it was already withdrawn on an earlier run');
}

rule('31. Award audit trail');
const awardLog = await listAuditLog({ authorId: author.id, limit: 250 });
for (const entry of [...awardLog]
  .reverse()
  .filter(
    (e) =>
      e.action === 'award.outcome_recorded' ||
      e.action === 'award.no_material' ||
      e.action === 'pr_kit.superseded',
  )) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'award.outcome_recorded'
      ? `${meta.from} → ${meta.to} (${meta.award ?? 'unspecified prize'})`
      : entry.action === 'pr_kit.superseded'
        ? meta.reason
        : meta.reason;
  console.log(`${entry.created_at.toISOString()}  ${entry.action.padEnd(28)} ${detail}`);
}

rule('32. STORY-006 — what the drafter is given before it writes a word');
const grounding = await retrieveThemeGrounding({ bookId: book.id }, { query });
console.log(`retrieved ${grounding.passageCount} passages for ${grounding.themes.length} themes\n`);
for (const entry of grounding.themes) {
  console.log(`  ${entry.theme}`);
  console.log(`    key message: ${entry.keyMessage || '(none recorded)'}`);
  for (const passage of entry.passages) {
    console.log(`    evidence:    ${passage.content.slice(0, 88)}...`);
  }
  if (entry.passages.length === 0) console.log('    evidence:    none — the book never argues this');
}

rule('33. Each theme is judged twice: was it named, and was it argued');
const { rows: verdicts } = await query(
  `SELECT p.type, t.theme, t.named, t.message_score, t.carried_terms
     FROM pr_material_themes t
     JOIN pr_materials p ON p.id = t.material_id
    WHERE p.kit_id = $1
    ORDER BY p.id, t.id`,
  [launch.kit.id],
);
let lastType = null;
for (const v of verdicts) {
  if (v.type !== lastType) {
    console.log(`\n[${v.type}]`);
    lastType = v.type;
  }
  const verdict = !v.named ? 'MISSING' : Number(v.message_score) >= 0.5 ? 'argued' : 'named only';
  console.log(
    `  ${v.theme.padEnd(12)} ${verdict.padEnd(11)} ` +
      `message=${Number(v.message_score).toFixed(2)}  ` +
      `carried: ${(v.carried_terms ?? []).slice(0, 5).join(', ') || '—'}`,
  );
}

rule('34. Why this story existed: the same copy under the old measure and the new one');
// Well-formed copy that repeats every theme and makes none of the book's
// arguments. Scored here rather than drafted, so a second demo run does not
// leave an extra milestone behind.
const nameCheck =
  'Deep work, craft, attention and resilience. This is a title about deep work. ' +
  'It is also a title about craft. It concerns attention. Resilience as well.';
const oldScore = book.themes.filter((t) => nameCheck.toLowerCase().includes(t)).length /
  book.themes.length;
const newReport = alignToThemes({ text: nameCheck, grounding });
console.log(`  copy: "${nameCheck.slice(0, 70)}..."\n`);
console.log(`  STORY-003 verbatim check : ${oldScore.toFixed(3)}  → would have passed for review`);
console.log(`  STORY-006 grounded check : ${newReport.score.toFixed(3)}  → ${newReport.summary}`);
console.log(
  `\n  the floor is ${config.minThemeAlignment}, so this now escalates instead of looking approved`,
);

rule('35. The alignment actions on the audit log');
const alignLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of alignLog
  .slice()
  .reverse()
  .filter((e) => e.action === 'pr_kit.themes_retrieved' || e.action === 'pr_material.aligned')
  .slice(0, 8)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'pr_kit.themes_retrieved'
      ? `${meta.themes?.length ?? 0} themes / ${meta.passageCount ?? 0} passages` +
        (meta.ungroundedThemes?.length ? ` · ungrounded: ${meta.ungroundedThemes.join(', ')}` : '')
      : `${meta.materialType} · argued ${meta.arguedThemes?.length ?? 0}/${meta.perTheme?.length ?? 0}` +
        (meta.namedOnly?.length ? ` · named only: ${meta.namedOnly.join(', ')}` : '');
  console.log(
    `${entry.created_at.toISOString()}  ${entry.actor.padEnd(24)} ` +
      `${entry.action.padEnd(24)} ${detail}`,
  );
}

rule('36. STORY-007 — what is sitting on a human right now');
const awaitingReview = await findKitsAwaitingReview({ authorId: author.id }, { query });
const { rows: existingReviewers } = await query(
  'SELECT * FROM reviewers WHERE author_id = $1 AND active ORDER BY id',
  [author.id],
);
console.log(
  `${awaitingReview.reduce((n, k) => n + k.pending_count, 0)} materials across ` +
    `${awaitingReview.length} kits are waiting for a decision`,
);
for (const kit of awaitingReview) {
  console.log(
    `  kit ${kit.id}  ${kit.milestone_type.padEnd(12)} ${kit.pending_count} awaiting` +
      (kit.escalated_count > 0 ? `, ${kit.escalated_count} escalated` : ''),
  );
}
if (existingReviewers.length === 0) {
  console.log('\nreviewers configured: none');
  console.log('the gate is holding drafts that nobody has been asked to look at.');
  const unreachable = await notifyPendingReviews({ authorId: author.id });
  console.log(`notify run → unreachable=${unreachable.unreachable}, nothing sent`);
  console.log('recorded as review.no_reviewers — an unreachable queue must not read as a quiet one');
} else {
  console.log(`\nreviewers already configured: ${existingReviewers.map((r) => r.name).join(', ')}`);
  console.log('(run npm run db:reset to see the "nobody to tell" state from scratch)');
}

rule('37. Naming the stakeholders — an address book, not a permission list');
for (const person of [
  { name: 'Dana Vogel', email: 'dana@example.test', role: 'publisher' },
  { name: 'Sam Iyer', email: 'sam@example.test', role: 'publicist' },
]) {
  const { rows } = await query(
    `INSERT INTO reviewers (author_id, name, email, role)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (author_id, email) DO UPDATE SET name = EXCLUDED.name, active = TRUE
     RETURNING *`,
    [author.id, person.name, person.email, person.role],
  );
  console.log(`  ${rows[0].name.padEnd(12)} ${rows[0].role.padEnd(10)} ${rows[0].email}`);
}
console.log('\nnothing here decides what anyone may approve — approvals.reviewer still records');
console.log('who actually decided, and it is still free text. Knowing who to *tell* is not');
console.log('knowing who someone *is*: login and RBAC remain a named gap.');

rule('38. Telling them — the Approval and Notification Agent');
const notified = await notifyPendingReviews({ authorId: author.id });
if (notified.notified.length === 0) {
  console.log('nothing new to send: every reviewer has already been told about every waiting kit.');
  console.log('(that is stage 39 working — run npm run db:reset for a clean pass)');
} else {
  for (const n of notified.notified) {
    console.log(`  → ${n.status.padEnd(6)} ${n.subject}`);
  }
  console.log(`\n${notified.notified.length} notifications, delivery mocked — no real mail left.`);
}
const sample = notified.notified[0];
if (sample) {
  console.log('\nwhat one of them actually says:');
  console.log(sample.body.replace(/^/gm, '  '));
}

rule('39. Pressing it again does not re-mail anyone');
const again = await notifyPendingReviews({ authorId: author.id });
console.log(`sent this time: ${again.notified.length}`);
for (const s of again.skipped.slice(0, 6)) {
  console.log(`  skipped  kit ${s.kitId} → ${s.reviewer} (${s.reason})`);
}
console.log('\nan alert that repeats on every tick is one people learn to ignore, which spends');
console.log('the exact attention the approval gate exists to spend. The unique constraint is the');
console.log('idempotency — not a check-then-insert two workers could both pass.');

rule('40. Notifying is not deciding');
const { rows: stillWaiting } = await query(
  `SELECT status, COUNT(*)::int AS n FROM pr_materials
    WHERE author_id = $1 GROUP BY status ORDER BY status`,
  [author.id],
);
console.log('press material statuses after every notification went out:');
for (const row of stillWaiting) console.log(`  ${row.status.padEnd(18)} ${row.n}`);
console.log('\nnot one status moved. The agent can read the queue and mail a person about it;');
console.log('it cannot approve, reject or send. The trust boundary is exactly where it was.');

rule('41. The notification trail');
const notifyLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of notifyLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('review.') || e.action.startsWith('reviewer.'))
  .slice(0, 8)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'review.no_reviewers'
      ? `${meta.materialsAwaitingReview} materials waiting, nobody configured`
      : entry.action === 'review.notified' || entry.action === 'review.notification_failed'
        ? `${meta.reviewer} <${meta.recipient}> · kit ${meta.kitId} · ${meta.pendingCount} waiting`
        : JSON.stringify(meta);
  console.log(
    `${entry.created_at.toISOString()}  ${entry.actor.padEnd(26)} ${entry.action.padEnd(28)} ${detail}`,
  );
}

rule('42. STORY-064 — before this story, "signed in as" was a decoration');
// The app is started here for real, on an ephemeral port, because the only
// honest way to show that an endpoint refuses a caller is to call it.
const demoServer = createApp().listen(0);
await new Promise((resolve) => demoServer.once('listening', resolve));
const api = `http://127.0.0.1:${demoServer.address().port}/api`;

const call = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(api + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty */ }
  return { status: response.status, body: payload };
};

console.log('every protected endpoint, called with no session:\n');
for (const path of ['/authors', '/drafts', '/press-kits', '/audit-log']) {
  const { status, body } = await call(path);
  console.log(`  ${String(status).padEnd(4)} GET ${path.padEnd(14)} ${body?.error ?? ''}`);
}
const blocked = await call('/drafts/1/approve', { method: 'POST' });
console.log(`  ${blocked.status}  POST /drafts/1/approve  ${blocked.body?.error ?? ''}`);
console.log('\nnothing was drafted, published or approved — the request never reached a handler.');

rule('43. Signing in, and what the session actually says');
const signedIn = await call('/auth/login', {
  method: 'POST',
  body: { email: 'mira@example.test', password: 'quiet-craft' },
});
const miraToken = signedIn.body.token;
console.log(`POST /auth/login → ${signedIn.status}`);
console.log('user:', JSON.stringify(signedIn.body.user));
console.log('\nclaims carried by the token:');
console.log(JSON.stringify(jwt.decode(miraToken), null, 2).replace(/^/gm, '  '));
console.log('\nno password hash leaves the service, and the token is not a profile —');
console.log('it carries the tenant and the role, and nothing else worth stealing.');

const wrong = await call('/auth/login', {
  method: 'POST',
  body: { email: 'mira@example.test', password: 'not-the-password' },
});
const nobody = await call('/auth/login', {
  method: 'POST',
  body: { email: 'nobody@example.test', password: 'not-the-password' },
});
console.log(`\nwrong password  → ${wrong.status} ${JSON.stringify(wrong.body)}`);
console.log(`unknown email   → ${nobody.status} ${JSON.stringify(nobody.body)}`);
console.log('identical answers, so the endpoint cannot be used to discover who has an account.');

rule('44. A tenant boundary you can actually test');
const tomas = await call('/auth/login', {
  method: 'POST',
  body: { email: 'tomas@example.test', password: 'second-shelf' },
});
const ops = await call('/auth/login', {
  method: 'POST',
  body: { email: 'ops@example.test', password: 'ops-password' },
});

const mineList = await call('/authors', { token: miraToken });
const theirsList = await call('/authors', { token: tomas.body.token });
const opsList = await call('/authors', { token: ops.body.token });
console.log(`Mira sees : ${mineList.body.map((a) => a.name).join(', ')}`);
console.log(`Tomas sees: ${theirsList.body.map((a) => a.name).join(', ')}`);
console.log(`Ops sees  : ${opsList.body.map((a) => a.name).join(', ')}   (admin, all tenants)`);

console.log('\nMira reaching for the other tenant, three different ways:');
for (const [label, path] of [
  ['path parameter ', '/authors/2/books'],
  ['query parameter', '/drafts?authorId=2'],
  ['bare resource id', '/books/2/themes'],
]) {
  const { status, body } = await call(path, { token: miraToken });
  console.log(`  ${status}  ${label}  ${path.padEnd(20)} ${body?.error ?? ''}`);
}
console.log('\nthe third one is the interesting case: /books/2/themes names no author at all,');
console.log('so the tenant has to be read off the row. The first one is where this story\'s');
console.log('own first implementation leaked — router-level middleware runs before Express');
console.log('fills in req.params, so the check saw undefined and waved everything through.');

rule('45. An approval now names a person');
// Must not be a material on a withdrawn kit: STORY-005 refuses those decisions
// outright, so picking one would demo the wrong refusal.
const { rows: reviewable } = await query(
  `SELECT p.* FROM pr_materials p
     JOIN pr_kits k ON k.id = p.kit_id
    WHERE p.author_id = $1
      AND p.status IN ('pending_approval','escalated')
      AND k.status = 'drafting'
    ORDER BY p.id LIMIT 1`,
  [author.id],
);
if (reviewable[0]) {
  const spoofed = await call(`/pr-materials/${reviewable[0].id}/approve`, {
    method: 'POST',
    token: miraToken,
    body: { reviewer: 'Somebody Else Entirely', notes: 'Approved during the demo.' },
  });
  console.log(`POST /pr-materials/${reviewable[0].id}/approve → ${spoofed.status}`);
  console.log('(the request body claimed the reviewer was "Somebody Else Entirely")\n');

  const { rows: recorded } = await query(
    `SELECT a.reviewer, a.user_id, u.email, u.role
       FROM approvals a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.pr_material_id = $1 ORDER BY a.id DESC LIMIT 1`,
    [reviewable[0].id],
  );
  if (recorded[0]) {
    console.log('what was actually recorded:');
    console.log(`  reviewer : ${recorded[0].reviewer}`);
    console.log(`  user_id  : ${recorded[0].user_id}  (${recorded[0].email}, ${recorded[0].role})`);
    console.log('\nthe identity comes from the session. A name in the request body is a claim,');
    console.log('and claims are what this story replaced.');
  } else {
    console.log(`the gate refused this one first: ${spoofed.body?.error ?? 'no decision recorded'}`);
  }
} else {
  console.log('nothing left awaiting review — run npm run db:reset for a clean pass.');
}

rule('46. The identity trail');
const authLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of authLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('auth.') || e.metadata?.attributable !== undefined)
  .slice(0, 8)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action.startsWith('auth.')
      ? `${meta.email ?? ''} ${meta.reason ? `(${meta.reason})` : `role=${meta.role}`}`
      : `attributable=${meta.attributable} user_id=${meta.userId ?? 'none'} role=${meta.role ?? 'none'}`;
  console.log(
    `${entry.created_at.toISOString()}  ${String(entry.actor).padEnd(22)} ${entry.action.padEnd(22)} ${detail}`,
  );
}
console.log('\nan approval made by internal code with no session is marked attributable=false');
console.log('rather than looking identical to one a real person stands behind.');

rule('47. STORY-065 — the worker, doing the work nobody clicked a button for');
// Give it something real to find: approve a draft, queue it, and put its slot in
// the past. This is the STORY-001 path exactly as a person would leave it — the
// only thing missing has always been someone to come back and press publish.
const { rows: spare } = await query(
  `SELECT * FROM drafts
    WHERE author_id = $1 AND status = 'pending_approval'
      AND id NOT IN (SELECT draft_id FROM scheduled_posts)
    ORDER BY id LIMIT 1`,
  [author.id],
);
if (spare[0]) {
  await approveDraft({ draftId: spare[0].id, reviewer: author.name });
  const queued = await scheduleDraft({ draftId: spare[0].id });
  await query("UPDATE scheduled_posts SET scheduled_for = now() - interval '2 minutes' WHERE id = $1", [
    queued.id,
  ]);
  console.log(
    `a human approved draft ${spare[0].id} and queued it for ${queued.platform}; its slot has passed.`,
  );
  console.log('nobody is at a screen. The worker ticks:\n');
}

const cycle = await tick();
console.log(`scheduled ${cycle.scheduled.length} jobs · ran ${cycle.ran.length}\n`);
for (const job of cycle.ran) {
  console.log(
    `  ${job.kind.padEnd(26)} ${job.status.padEnd(6)} ${JSON.stringify(job.result ?? {})}`,
  );
}
console.log('\nfour functions were written as "what a cron would call" and nothing called them.');
console.log('this is that caller. Note it publishes and drafts — it never approves.');

rule('48. Running it again does not do the work twice');
const second = await tick();
console.log(`scheduled ${second.scheduled.length} · ran ${second.ran.length}`);
console.log('\nthe idempotency key buckets the current time into the sweep window, so every');
console.log('worker on every tick computes the same key and the unique constraint keeps the');
console.log('second one out. "Every five minutes" means once per five minutes, not once per tick.');

rule('49. A failure is retried, backed off, then handed to a person');
// A handler that always fails, registered for the demo only.
HANDLERS['demo.always_fails'] = async () => {
  throw new Error('the outbound provider refused the connection');
};
const failKey = `demo.always_fails:${Date.now()}`;
const { job: failing } = await enqueue({
  kind: 'demo.always_fails',
  idempotencyKey: failKey,
  authorId: author.id,
  maxAttempts: 3,
});

let attempt = failing;
for (let i = 1; i <= 3; i += 1) {
  await query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [attempt.id]);
  attempt = await runOnce({ jobId: attempt.id });
  const next = attempt.status === 'queued' ? `retry at ${new Date(attempt.run_at).toISOString()}` : '';
  console.log(
    `  attempt ${attempt.attempts}/${attempt.max_attempts} → ${attempt.status.padEnd(11)} ${next}`,
  );
}
console.log(`\n  last error kept: "${attempt.last_error}"`);
console.log('\nnot silently dropped, and not retried forever. It is now on a list a human reads.');

rule('50. A human puts it back');
const revived = await retryJob({ jobId: attempt.id, user: { id: 1, name: 'Mira Kovač' } });
console.log(`job ${revived.id} → ${revived.status}, attempts reset to ${revived.attempts}`);
console.log('recorded as job.retried_by_human, attributable to the account that did it (STORY-064).');
await query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [revived.id]);

rule('51. A worker that dies mid-job does not lose the work');
const { job: abandoned } = await enqueue({
  kind: 'posts.publish_due',
  idempotencyKey: `demo.abandoned:${Date.now()}`,
});
await query(
  `UPDATE jobs SET status = 'running', attempts = 1, claimed_at = now() - interval '1 hour'
    WHERE id = $1`,
  [abandoned.id],
);
console.log(`job ${abandoned.id} was claimed by a worker that never came back`);
const reclaimed = await reapStaleJobs();
console.log(`reaped ${reclaimed.length} → ${reclaimed[0]?.status}: "${reclaimed[0]?.last_error}"`);
console.log('\nthe attempt was already counted on claim, so a job that reliably kills its worker');
console.log('walks to the dead letter instead of being retried forever.');

rule('52. Run health, and the trail');
const { rows: health } = await query(
  'SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status ORDER BY status',
);
for (const row of health) console.log(`  ${row.status.padEnd(12)} ${row.n}`);

const jobLog = await listAuditLog({ authorId: author.id, limit: 200 });
console.log('');
for (const entry of jobLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('job.'))
  .slice(0, 8)) {
  const meta = entry.metadata ?? {};
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(22)} ` +
      `${String(meta.kind ?? '').padEnd(22)} ${meta.needsHuman ? 'NEEDS A HUMAN' : ''}` +
      `${meta.error ? ` ${meta.error}` : ''}`,
  );
}

rule('53. STORY-008 — who checks the agent that grades its own work?');
const { rows: judged } = await query(
  `SELECT p.type, p.confidence, p.theme_alignment, p.status
     FROM pr_materials p JOIN pr_kits k ON k.id = p.kit_id
    WHERE p.author_id = $1 AND p.status IN ('pending_approval','escalated')
      AND k.status <> 'superseded'
    ORDER BY p.id LIMIT 6`,
  [author.id],
);
console.log(`policy in force: confidence >= ${config.confidenceEscalationThreshold}, ` +
  `theme alignment >= ${config.minThemeAlignment}\n`);
for (const m of judged) {
  console.log(
    `  ${m.type.padEnd(14)} conf ${m.confidence} align ${m.theme_alignment} → ${m.status}`,
  );
}
console.log('\nuntil this story, the agent that wrote each of these also decided whether it was');
console.log('good enough. The same objection this project already raised to a model scoring');
console.log('itself — one level up. A producer with a broken check had nothing watching it.');

rule('54. The bar moves, and yesterday\'s drafts are re-judged');
const wasThreshold = config.confidenceEscalationThreshold;
config.confidenceEscalationThreshold = 0.97;
console.log(`confidence floor raised ${wasThreshold} → ${config.confidenceEscalationThreshold}`);
console.log('these drafts were written under the old floor and are still awaiting a human.\n');

const trustScan = await monitorPressMaterials({ authorId: author.id });
console.log(`examined ${trustScan.examined} · raised ${trustScan.raised.length} · ` +
  `already escalated by the drafter ${trustScan.confirmed.length} · ` +
  `drafter was stricter than policy ${trustScan.producerStricter.length}`);
for (const raised of trustScan.raised) {
  console.log(`  raised: ${raised.type.padEnd(14)} → ${raised.status}`);
}
console.log('\nnothing re-drafted and nothing sent. Work already waiting was re-judged against');
console.log('the policy in force now, which is something a draft-time check can never do.');

rule('55. It raises concerns and never clears them');
config.confidenceEscalationThreshold = wasThreshold;
console.log(`floor dropped back to ${config.confidenceEscalationThreshold}`);
const relaxed = await monitorPressMaterials({ authorId: author.id });
console.log(`examined ${relaxed.examined} · raised ${relaxed.raised.length} · ` +
  `drafter stricter than policy ${relaxed.producerStricter.length}`);
const { rows: stillEscalated } = await query(
  `SELECT COUNT(*)::int AS n FROM pr_materials p JOIN pr_kits k ON k.id = p.kit_id
    WHERE p.author_id = $1 AND p.status = 'escalated' AND k.status <> 'superseded'`,
  [author.id],
);
console.log(`\nstill escalated: ${stillEscalated[0].n}`);
console.log('the floor came back down and not one concern was withdrawn. A monitor that can');
console.log('clear its own findings is a monitor that can be wrong in the direction that matters.');

rule('56. The escalation queue — what was raised, why, and by whom');
for (const e of (await listEscalations({ authorId: author.id })).slice(0, 8)) {
  console.log(
    `  ${e.type.padEnd(14)} by ${e.detected_by.padEnd(8)} ` +
      `agreed=${String(e.agreed).padEnd(5)} ` +
      `${(e.reasons.join(',') || 'policy since relaxed').padEnd(24)} ` +
      `${e.open ? 'awaiting a human' : e.material_status}`,
  );
}
console.log('\n"open" is read from the material\'s own status, so approving one closes its');
console.log('escalation without a second copy of the state to keep in step.');

rule('57. The monitoring trail');
const trustLog = await listAuditLog({ authorId: author.id, limit: 200 });
for (const entry of trustLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('escalation.') || e.action === 'trust.scan_completed')
  .slice(0, 8)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'trust.scan_completed'
      ? `examined ${meta.examined}, raised ${meta.raised}, stricter ${meta.producerStricter}`
      : `${meta.materialType ?? ''} ${(meta.reasons ?? []).join(',')}`;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.actor.padEnd(24)} ${entry.action.padEnd(30)} ${detail}`,
  );
}


// ── STORY-009 ────────────────────────────────────────────────────────────────
// The Content Drafting Agent drafts from the book's themes and the author's
// previous posts. STORY-001 had both inputs and used neither.

rule('58. What the social drafter is handed, before it writes a word');
const socialGrounding = await retrieveThemeGrounding({ bookId: book.id }, { query });
for (const theme of socialGrounding.themes) {
  console.log(
    `${theme.theme.padEnd(12)} ${theme.passages.length} passage(s)  ` +
      `${(theme.keyMessage || '(no key message recorded)').slice(0, 72)}`,
  );
}
const { rows: priorPosts } = await query(
  'SELECT platform, content FROM social_history WHERE author_id = $1',
  [author.id],
);
const socialVoice = deriveVoice(priorPosts, author.voice_profile);
console.log(`\nvoice, counted from ${socialVoice.posts} of the author's own posts:`);
console.log(
  `  sentences average ${socialVoice.meanSentenceWords.toFixed(1)} words · ` +
    `exclamations ${socialVoice.exclamationsPer100.toFixed(2)}/100w · ` +
    `hype ${socialVoice.hypePer100.toFixed(2)}/100w · ` +
    `shouting ${socialVoice.shoutedPer100.toFixed(2)}/100w`,
);
console.log('\nthe hand-written voice profile, checked against the writing:');
for (const claim of socialVoice.stated) {
  const verdict =
    claim.supported === true
      ? 'supported by the posts'
      : claim.supported === false
        ? 'NOT in the writing'
        : 'not measurable';
  console.log(`  ${claim.kind.padEnd(6)} ${claim.claim.padEnd(30)} ${verdict}`);
}

rule('59. A week of posts, written from that evidence');
const groundedWeek = await draftWeeklyPosts({
  authorId: author.id,
  bookId: book.id,
  count: 4,
  weekOf: weekStart(new Date(Date.now() + 7 * 86400000)),
});
for (const draft of groundedWeek) {
  console.log(
    `${draft.platform.padEnd(10)} ${draft.status.padEnd(17)} ` +
      `conf ${draft.confidence}  themes ${draft.theme_alignment}  voice ${draft.voice_score}  ` +
      `[${draft.themes_used.join(', ')}]`,
  );
}
const { rows: themeVerdicts } = await query(
  `SELECT dt.theme, dt.named, dt.score, dt.carried_terms
     FROM draft_themes dt
    WHERE dt.draft_id = ANY($1::bigint[])
    ORDER BY dt.draft_id, dt.id`,
  [groundedWeek.map((d) => d.id)],
);
console.log('\nper-theme verdicts — which of the book\'s own words each post carried:');
for (const v of themeVerdicts) {
  console.log(
    `  ${v.theme.padEnd(12)} score ${v.score}  ${(v.carried_terms.join(' ') || 'none').slice(0, 56)}`,
  );
}

rule('60. The draft STORY-001 called its best');
const hype =
  'craft attention Attention is a muscle!!! UNLOCK your craft attention RIGHT NOW!!! ' +
  '10X your writing attention with this ONE WEIRD TRICK!!! Smash that follow button, ' +
  'growth-hack your craft today!!!';
console.log(hype);
console.log(
  '\nEverything the author\'s own voice profile says to avoid: exclamation marks,',
);
console.log('growth-hacking language, hype. Scored two ways:\n');

const oldWay = scoreDraft({
  content: hype,
  themesUsed: ['craft', 'attention'],
  bookThemes: book.themes,
  history: priorPosts,
  maxChars: 280,
});
const newWay = scoreDraft({
  content: hype,
  themesUsed: ['craft', 'attention'],
  bookThemes: book.themes,
  history: priorPosts,
  maxChars: 280,
  grounding: socialGrounding,
  voice: socialVoice,
  bookTitle: book.title,
});
console.log(`  STORY-001  confidence ${oldWay.confidence}   ${oldWay.rationale}`);
console.log(`  STORY-009  confidence ${newWay.confidence}   ${newWay.rationale}`);
const hypeVerdict = assess({
  confidence: newWay.confidence,
  themeAlignment: newWay.themeAlignment,
  voice: newWay.voiceScore,
});
console.log(
  `\n  → ${hypeVerdict.status}  (${hypeVerdict.reasons.join(', ') || 'no floor breached'})`,
);
console.log(
  '\nThe old measure could not fail: "grounding" asked whether a theme label was reused,',
);
console.log('and "voice" measured vocabulary overlap, which any text about this book shares.');

const overclaimed = scoreDraft({
  content: hype,
  themesUsed: book.themes,
  bookThemes: book.themes,
  history: priorPosts,
  maxChars: 280,
});
console.log(
  `\nWorse: the same copy claiming all four themes scored ${overclaimed.confidence} under STORY-001,`,
);
console.log(
  `up from ${oldWay.confidence} — the gain comes entirely from claiming "deep work" and`,
);
console.log('"resilience", neither of which it mentions. The drafter\'s own claim about which');
console.log('themes it used was concatenated onto the text before that text was scored for');
console.log('theme reuse, so the measure paid out for the assertion rather than the writing.');
console.log('themes_used is now the verified matches, and a claimed-but-unnamed theme scores 0.');

rule('61. Naming a theme is not arguing it — sideways either');
const cases = [
  ['name-checks every theme', 'craft craft craft. attention attention. resilience and craft again.', ['craft', 'attention', 'resilience']],
  ['claims a theme it never wrote', 'Attention is a muscle that adapts to the load you give it.', ['attention', 'resilience']],
  ['claims a theme the book lacks', 'Maps and memory are what I care about most.', ['maps']],
  ['argues one theme honestly', 'On resilience: what remains when motivation has gone home for the evening. The people who finish are rarely the most inspired.', ['resilience']],
];
for (const [label, content, claimed] of cases) {
  const scored = scoreDraft({
    content,
    themesUsed: claimed,
    bookThemes: book.themes,
    history: priorPosts,
    maxChars: 280,
    grounding: socialGrounding,
    voice: socialVoice,
    bookTitle: book.title,
  });
  const decided = assess({
    confidence: scored.confidence,
    themeAlignment: scored.themeAlignment,
    voice: scored.voiceScore,
  });
  console.log(
    `${label.padEnd(30)} themes ${String(scored.themeAlignment).padEnd(6)} ` +
      `voice ${String(scored.voiceScore).padEnd(6)} → ${decided.status.padEnd(17)} ` +
      `${decided.reasons.join(',') || '—'}`,
  );
}
console.log(
  '\nThe book\'s passages discuss its themes together, so "attention" is one of craft\'s',
);
console.log('own evidence words. Every theme label is excluded, or naming your neighbours');
console.log('would count as arguing your own point.');

rule('62. The drafting trail');
const socialLog = await listAuditLog({ authorId: author.id, limit: 300 });
for (const entry of socialLog
  .slice()
  .reverse()
  .filter((e) => e.action === 'social.themes_retrieved' || e.action === 'social.voice_derived')
  .slice(0, 4)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'social.voice_derived'
      ? `${meta.priorPosts} prior posts, enforceable=${meta.enforceable}, ${meta.vocabulary} words`
      : `${meta.passageCount} passages over ${(meta.themes ?? []).length} themes`;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.actor.padEnd(24)} ${entry.action.padEnd(26)} ${detail}`,
  );
}
console.log('\nRetrieval and voice derivation are logged before anything is written, so a post');
console.log('that reads well but was grounded in nothing is visible as such.');


// ── STORY-010 ────────────────────────────────────────────────────────────────
// The PR and Outreach Agent identifies speaking opportunities that fit the
// book's themes *and the author's expertise*. STORY-002 modelled only the book.

rule('63. A search for speaking opportunities, not for everything');
const speakingScan = await scoutOpportunities({
  authorId: author.id,
  bookId: book.id,
  types: ['speaking'],
});
const { rows: speakingOnFile } = await query(
  "SELECT COUNT(*)::int AS n FROM opportunities WHERE author_id = $1 AND type = 'speaking'",
  [author.id],
);
console.log(
  `searched ${speakingScan.searchedTypes.join(', ')} only → ${speakingScan.scanned} listings scanned · ` +
    `${speakingOnFile[0].n} speaking opportunities on file · ${speakingScan.rejected.length} rejected`,
);
console.log(
  `(${speakingScan.identified.length} newly recorded — stage 9 already scanned every directory, ` +
    'and re-scanning is idempotent)',
);
for (const o of speakingScan.identified) console.log(`  new: ${o.name}`);
console.log('\nA podcast is not a speaking engagement. STORY-002 could only scan all three at');
console.log('once, which meant "find me speaking slots" was not a question you could ask.');

rule('64. What the agent knows about the author, as opposed to the book');
const { rows: authorBooks } = await query(
  'SELECT title, themes, content FROM books WHERE author_id = $1',
  [author.id],
);
const { rows: authorPosts } = await query(
  'SELECT content FROM social_history WHERE author_id = $1',
  [author.id],
);
const expertise = deriveExpertise({ books: authorBooks, posts: authorPosts, trackRecord: [] });
console.log(
  `published author: ${expertise.isPublishedAuthor} · ${expertise.books} book(s) · ` +
    `${expertise.posts} posts · ${expertise.subjectEvidence} words of subject evidence`,
);
console.log(`declared subjects : ${expertise.themes.join(', ')}`);
console.log(`qualifies for     : ${expertise.formats.slice(0, 6).join(', ')}, …`);
console.log('\nStanding is the half STORY-002 had no way to represent: not what the author');
console.log('writes about, but what the author *is*. An author panel is looking for an author.');

rule('65. The lead the book\'s themes scored at exactly zero');
const allListings = await searchAllDirectories({});
const library = allListings.find((l) => l.externalId === 'evt-004');
console.log(`${library.name} — ${library.description}`);
console.log(`topics: ${library.topics.join(', ')}\n`);
const libThemes = scoreOpportunity({ listing: library, bookThemes: book.themes });
const libExpertise = scoreExpertise({ listing: library, expertise });
console.log(`  themes    ${libThemes.relevance.toFixed(3)}  ${libThemes.rationale}`);
console.log(`  expertise ${libExpertise.score.toFixed(3)}  ${libExpertise.rationale}`);
console.log(
  `\n  → qualifies on expertise (floor ${config.expertiseThreshold}), not on themes ` +
    `(floor ${config.relevanceThreshold})`,
);
console.log('\nIt never repeats a theme label, so STORY-002 scored it 0.000 and threw it away —');
console.log('four stories running. It does not want a lecture on attention. It wants an author.');

rule('66. Every listing, scored on both dimensions');
console.log('listing'.padEnd(30) + 'themes  author  verdict');
for (const listing of allListings) {
  const t = scoreOpportunity({ listing, bookThemes: book.themes });
  const e = scoreExpertise({ listing, expertise });
  const onThemes = t.relevance >= config.relevanceThreshold;
  const onExpertise = e.score >= config.expertiseThreshold;
  const verdict = onThemes && onExpertise
    ? 'both'
    : onThemes
      ? 'themes'
      : onExpertise
        ? 'EXPERTISE — new'
        : 'rejected';
  console.log(
    listing.name.padEnd(30) +
      `${t.relevance.toFixed(3)}   ${e.score.toFixed(3)}   ${verdict}`,
  );
}
console.log('\nExactly one lead is recovered, and the four genuinely off-topic listings score');
console.log('0.000 on expertise too. A second test that qualified everything would be no test.');

rule('67. What the filter hid is now on the record');
const fullScan = await scoutOpportunities({ authorId: author.id, bookId: book.id });
const { rows: onFile } = await query(
  'SELECT COUNT(*)::int AS n FROM opportunities WHERE author_id = $1',
  [author.id],
);
console.log(
  `scanned ${fullScan.scanned} → ${onFile[0].n} on file, ${fullScan.rejected.length} rejected ` +
    `(${fullScan.identified.length} new this pass — every one was already found at stage 9)\n`,
);
const { rows: hidden } = await query(
  `SELECT name, type, relevance, expertise, relevance_floor, expertise_floor
     FROM opportunity_rejections WHERE author_id = $1 ORDER BY name`,
  [author.id],
);
for (const r of hidden) {
  console.log(
    `  ${r.type.padEnd(9)} ${r.name.padEnd(30)} ` +
      `themes ${Number(r.relevance).toFixed(3)}/${Number(r.relevance_floor).toFixed(2)}  ` +
      `author ${Number(r.expertise).toFixed(3)}/${Number(r.expertise_floor).toFixed(2)}`,
  );
}
console.log('\nSTORY-002 kept a count and discarded the listings, so the one part of the scan');
console.log('nobody could check was the part deciding what a human would never see. Both floors');
console.log('are stored with each verdict, so a call made under an older policy is re-derivable.');

rule('68. The scouting trail');
const scoutLog = await listAuditLog({ authorId: author.id, limit: 300 });
for (const entry of scoutLog
  .slice()
  .reverse()
  .filter((e) => e.action === 'opportunity.expertise_derived' || e.action === 'opportunity.scan_completed')
  .slice(-4)) {
  const meta = entry.metadata ?? {};
  const detail =
    entry.action === 'opportunity.expertise_derived'
      ? `${meta.books} book(s), ${meta.formats} formats, searched ${(meta.searchedTypes ?? []).join('/')}`
      : `scanned ${meta.scanned}, identified ${meta.identified}, rejected ${meta.rejected}, ` +
        `by ${JSON.stringify(meta.byQualification ?? {})}`;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.actor.padEnd(26)} ${entry.action.padEnd(32)} ${detail}`,
  );
}
console.log('\n"byQualification" is there so a test that never qualifies anything is visible as');
console.log('a dead test rather than trusted as a strict one.');


// ── STORY-011 ────────────────────────────────────────────────────────────────
// The Coordination and Governance Agent manages tasks across agents. STORY-065
// built the queue that runs them; nothing decided the order.

rule('69. Multiple agents, one queue, and nothing that ordered them');
await query('DELETE FROM jobs');
const window = await ensureRecurringJobs({ now: new Date() });
await enqueue({
  kind: 'outreach.send',
  idempotencyKey: `demo.coordination:${Date.now()}`,
  authorId: author.id,
  payload: { messageId: 1 },
});
const { rows: fifo } = await query(
  "SELECT kind, author_id, priority, resource FROM jobs WHERE status='queued' ORDER BY run_at, id",
);
console.log(`one sweep window queued ${window.length} jobs, plus one approved email to send.\n`);
console.log('STORY-065 claimed them in this order — arrival order:');
fifo.forEach((j, i) =>
  console.log(`  ${String(i + 1).padStart(2)} ${j.kind.padEnd(28)} author ${String(j.author_id ?? '-').padEnd(4)}`),
);
console.log('\nThe last row is the only outbound, time-sensitive, human-authorised work in the');
console.log('queue, and it is behind every internal sweep. With more authors it is behind more.');

rule('70. What the coordinator decides, and why');
const { rows: ranked } = await query(
  "SELECT kind, author_id, priority, resource, coordination FROM jobs WHERE status='queued' ORDER BY priority DESC, run_at, id",
);
console.log('priority  job                          holds                      because');
for (const j of ranked) {
  console.log(
    `  ${String(j.priority).padEnd(7)} ${j.kind.padEnd(28)} ${String(j.resource ?? '-').padEnd(26)} ${j.coordination?.reason ?? ''}`,
  );
}
console.log('\nThe bands are the argument, not the numbers: work a human authorised outranks');
console.log('work that produces, which outranks the agents that react to what was produced.');

rule('71. The bug two workers had and one worker hid');
console.log('press.draft_approaching PRODUCES the materials that trust.monitor_escalations');
console.log('CONSUMES. Nothing said so. With one worker the order was right by accident —');
console.log('RECURRING is declared producer-first and the ids ascend. With two workers:\n');
console.log('  before STORY-011:  6 materials created, monitor examined 0');
console.log('  (it read pr_materials while the drafter\'s transaction was still open)\n');
await query('DELETE FROM jobs');
await ensureRecurringJobs({ now: new Date() });
const drainWorker = async () => {
  const ran = [];
  for (;;) {
    const job = await runOnce({});
    if (!job) break;
    ran.push(job.kind);
  }
  return ran;
};
const [wa, wb] = await Promise.all([drainWorker(), drainWorker()]);
console.log(`  two workers ran ${wa.length} and ${wb.length} jobs, no errors`);
const { rows: examined } = await query(
  "SELECT author_id, result FROM jobs WHERE kind='trust.monitor_escalations' ORDER BY author_id",
);
for (const e of examined) {
  console.log(`  after  STORY-011:  monitor for author ${e.author_id} examined ${e.result?.examined ?? 0}`);
}
console.log('\nExclusion is what makes the priority mean anything: the monitor cannot start');
console.log('until the drafter has committed and let go of author:N:press.');

rule('72. Serialised per tenant, not per queue');
console.log('The resource is scoped to one author, so this orders one pipeline and not the');
console.log('whole system. Two authors draft, monitor and notify in parallel with each other:\n');
for (const kind of ['press.draft_approaching', 'trust.monitor_escalations']) {
  const keys = [1, 2].map((id) => resourceFor({ kind, author_id: id }));
  console.log(`  ${kind.padEnd(28)} ${keys.join('   vs   ')}`);
}
console.log('\nSame resource down a column — the three stages of one author\'s pipeline.');
console.log('Different resource across a row — two tenants, never waiting on each other.');

rule('73. A dead heat is settled by the database, not by the query that preceded it');
console.log('The claim query checks that a resource is free, then writes. Under READ');
console.log('COMMITTED two workers can both see it free. A unique partial index on');
console.log('(resource) WHERE status = \'running\' makes the second write fail, and the');
console.log('loser reports an idle pass rather than an error.\n');
await query('DELETE FROM jobs');
await ensureRecurringJobs({ now: new Date() });
const eight = await Promise.all(Array.from({ length: 8 }, drainWorker));
console.log(`  8 workers racing the same queue → ${eight.flat().length} jobs run, 0 errors`);
const { rows: leftover } = await query(
  "SELECT status, COUNT(*)::int n FROM jobs GROUP BY status ORDER BY status",
);
console.log(`  final state: ${leftover.map((r) => `${r.status} ${r.n}`).join(' · ')}`);

rule('74. Every distribution is on the log');
const coordLog = await listAuditLog({ authorId: author.id, limit: 300 });
for (const entry of coordLog
  .slice()
  .reverse()
  .filter((e) => e.actor === 'CoordinationGovernanceAgent')
  .slice(0, 6)) {
  const meta = entry.metadata ?? {};
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(16)} ` +
      `p${String(meta.priority).padEnd(4)} ${String(meta.kind).padEnd(28)} ${meta.resource ?? '-'}`,
  );
}
console.log('\nThe coordinator does not re-check approval. That gate has lived inside the');
console.log('services since STORY-001 so a new caller cannot route around it, and a second');
console.log('copy of the rule is exactly what STORY-008 existed to remove.');


// ── STORY-066 ────────────────────────────────────────────────────────────────
// Memes as a content format alongside text posts. Added after Ram's review:
// "On platforms like X, memes might get more traction than text."

rule('75. A meme is a draft, not a second content system');
const memeBatch = await draftWeeklyPosts({
  authorId: author.id,
  bookId: book.id,
  count: 3,
  weekOf: weekStart(new Date(Date.now() + 14 * 86400000)),
});
for (const d of memeBatch) {
  console.log(
    `${d.format.padEnd(5)} ${d.platform.padEnd(10)} ${d.status.padEnd(17)} ` +
      `rights ${d.image_rights.padEnd(15)} ${d.media?.template ?? ''}`,
  );
}
console.log('\nSame table, same status column, same approval gate, same audit trail. A memes');
console.log('table would have needed its own gate, and a second gate is a gate with a hole.');

const demoMeme = memeBatch.find((d) => d.format === 'meme');
rule('76. The caption is the book\'s argument, and the image is real');
console.log(`platform : ${demoMeme.platform} (routed here because the row says visual_first)`);
console.log(`template : ${demoMeme.media.template} — ${demoMeme.media.layout}`);
console.log(`caption  : ${demoMeme.content}`);
console.log(`alt text : ${demoMeme.media.altText}`);
console.log(`image    : ${demoMeme.media.imageRef.slice(0, 64)}…  (${demoMeme.media.imageRef.length} bytes, SVG data URI)`);
console.log(`licence  : ${JSON.stringify(demoMeme.media.provenance.licence)}`);
console.log('\nRendered offline and deterministically, so the demo and the tests can assert on');
console.log('an image without a network call — the same constraint that kept retrieval lexical.');

rule('77. What the drafter is allowed to build from');
const libraryTemplates = await listTemplates();
console.log('template                  slots                      terms            offered?');
for (const t of libraryTemplates) {
  const verdict = assessTemplate(t);
  console.log(
    `  ${t.key.padEnd(24)} ${t.captionSlots.map((s) => s.name).join('/').padEnd(26)} ` +
      `${String(t.licence?.terms ?? 'none recorded').padEnd(16)} ` +
      `${verdict.usable ? 'yes' : `NO — ${verdict.reason}`}`,
  );
}
console.log('\nTwo are withheld before generation even starts. The rights check exists to catch');
console.log('what gets past this, not to be the only guard.');

rule('78. A judgement escalates; a licence refuses');
const safetyCases = [
  ['clean caption, cc0 template', 'single-statement', 'Attention is a muscle that adapts to the load you give it.', 'Caption on a dark field'],
  ['no alt text', 'single-statement', 'Attention is a muscle.', ''],
  ['register the author never uses', 'single-statement', 'This one weird trick is a guaranteed cure. Only idiots miss it.', 'x'],
  ['editorial-only licence', 'stock-photo-overlay', 'Attention is a muscle.', 'A photograph'],
  ['no licence recorded', 'community-remix', 'Attention is a muscle.', 'A remix'],
];
console.log('case                            rights      publishable  findings');
for (const [label, id, caption, altText] of safetyCases) {
  const tmpl = libraryTemplates.find((t) => t.key === id);
  const review = reviewMemeCandidate({
    caption,
    media: {
      imageRef: 'x',
      altText,
      provenance: { source: 'template', templateId: tmpl.key, licence: tmpl.licence },
    },
    maxChars: 280,
  });
  console.log(
    `  ${label.padEnd(30)} ${review.rights.padEnd(11)} ${String(review.publishable).padEnd(12)} ` +
      `${review.findings.join(',') || '—'}`,
  );
}
console.log('\nBrand safety is a judgement a reviewer may overrule, so a finding escalates.');
console.log('Rights are a fact nobody here can overrule, so they are enforced at publication.');

rule('79. Approval is necessary to publish, and not always sufficient');
const { rows: blockedMeme } = await query(
  "SELECT * FROM drafts WHERE format = 'meme' ORDER BY id DESC LIMIT 1",
);
await query("UPDATE drafts SET image_rights = 'unresolved' WHERE id = $1", [blockedMeme[0].id]);
await approveDraft({
  draftId: blockedMeme[0].id,
  reviewer: 'Anvi Siddabhattuni',
  notes: 'Reads well, ship it.',
});
try {
  await scheduleDraft({ draftId: blockedMeme[0].id });
  console.log('UNEXPECTED: an uncleared image was scheduled');
} catch (error) {
  console.log(`blocked as designed: ${error.message}`);
}
const { rows: stillApproved } = await query('SELECT status FROM drafts WHERE id = $1', [
  blockedMeme[0].id,
]);
console.log(`\nthe human decision stands — status is still "${stillApproved[0].status}" — it is`);
console.log('simply not enough. A reviewer can accept a risk for the author. They cannot');
console.log('accept a licence on the rights-holder\'s behalf. Same rule a superseded press kit');
console.log('has followed since STORY-005.');

rule('80. The meme trail, with provenance');
const memeLog = await listAuditLog({ authorId: author.id, limit: 400 });
for (const entry of memeLog
  .slice()
  .reverse()
  .filter((e) => e.metadata?.format === 'meme')
  .slice(0, 5)) {
  const m = entry.metadata;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(16)} ` +
      `${String(m.template).padEnd(22)} rights=${String(m.imageRights).padEnd(11)} ` +
      `licence=${m.provenance?.licence?.terms ?? 'none'}`,
  );
}
console.log('\nProvenance is on the append-only log, not only on the row: a meme whose licence');
console.log('is questioned later has to be answerable from the record.');


// ── STORY-067 ────────────────────────────────────────────────────────────────
// The template library. STORY-066's five templates were an array in a source
// file; these are rows an author can browse, add to and retire.

rule('81. A library, not an array in a source file');
const lib = await listTemplates();
console.log(`${lib.length} templates · ${lib.filter((t) => assessTemplate(t).usable).length} the generator may use\n`);
console.log('template                  layout        slots                       licence');
for (const t of lib) {
  console.log(
    `  ${t.key.padEnd(24)} ${t.layout.padEnd(13)} ` +
      `${t.captionSlots.map((sl) => sl.name).join('/').padEnd(27)} ` +
      `${t.licence?.terms ?? 'none recorded'}`,
  );
}
console.log('\nEach slot is named and says what it is for, so a template can be added without a');
console.log('code change to go with it. STORY-066 had a hardcoded caption function per layout.');

rule('82. The refusals are on the log, not swallowed by a filter');
const pick = await selectTemplate({ authorId: author.id, seed: 3 });
console.log(`chose: ${pick.template.key} (${pick.template.licence.terms}, ${pick.template.licence.holder})`);
console.log(`refused ${pick.rejected.length} on the way there:\n`);
for (const r of pick.rejected) {
  console.log(`  ${r.key.padEnd(24)} ${r.reason.padEnd(32)} ${r.detail ?? ''}`);
}
console.log('\nSTORY-066 filtered these out with a helper that returned an array and said');
console.log('nothing — the same silence STORY-010 found in the opportunity scanner. The half');
console.log('of a filter nobody can check is the half it hides.');

rule('83. Adding one nobody can licence');
try {
  await addTemplate({
    key: 'demo-unlicensed',
    name: 'Found on the internet',
    layout: 'single',
    caption_slots: [{ name: 'statement', role: 'one line', maxChars: 80, x: 200, y: 150, size: 30 }],
    image_ref: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    source: 'Someone sent it to me',
    licence: null,
  });
  console.log('UNEXPECTED: an unlicensed template was accepted');
} catch (error) {
  console.log(`refused at the door: ${error.message}`);
}
console.log('\nRefused when it is added, not filtered later. A library that accepts unusable');
console.log('templates and hides them at selection is a library whose count means nothing.');

rule('84. Retiring one, without stranding what already shipped');
const retiredTemplate = await retireTemplate({
  key: 'quiet-field',
  reason: 'the layout reads as empty at thumbnail size',
  user: { name: 'Anvi Siddabhattuni' },
});
console.log(`retired ${retiredTemplate.key} — "${retiredTemplate.retiredReason}"`);
const afterRetire = assessTemplate(await listTemplates().then((all) => all.find((t) => t.key === 'quiet-field')));
console.log(`generator may use it now? ${afterRetire.usable} (${afterRetire.reason})`);
const { rows: usedIt } = await query(
  `SELECT COUNT(*)::int n FROM drafts d JOIN meme_templates t ON t.id = d.meme_template_id
    WHERE t.key = 'quiet-field'`,
);
console.log(`drafts still pointing at it: ${usedIt[0].n} — the row survives so their provenance does`);

rule('85. The library trail');
const libLog = await listAuditLog({ limit: 400 });
for (const entry of libLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('meme_template.'))
  .slice(-8)) {
  const m = entry.metadata ?? {};
  const detail =
    entry.action === 'meme_template.rejected'
      ? m.reason
      : entry.action === 'meme_template.selected'
        ? `${m.licence?.terms} · passed over ${m.rejected}`
        : entry.action === 'meme_template.retired'
          ? m.reason
          : `${(m.slots ?? []).join('/')} · ${m.licence?.terms ?? 'none'}`;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(26)} ${String(entry.entity_id).padEnd(24)} ${detail}`,
  );
}
console.log('\nEvery template added, selected, refused and retired. "An unlicensed image can');
console.log('never reach a draft" is now something you can check rather than take on trust.');


// ── STORY-068 ────────────────────────────────────────────────────────────────
// A running visual identity the memes are generated against and scored against.

rule('86. Eight licensed templates, five accent colours');
const identityGuide = await getActiveIdentity({ bookId: book.id });
console.log(
  `identity v${identityGuide.version}: ground ${identityGuide.palette.ground} · ` +
    `accent ${identityGuide.palette.accent} · ${identityGuide.palette.mode}`,
);
console.log(`derived: ${identityGuide.derivedFrom.confidence}\n`);
console.log('template                  accent(s)          score  verdict');
for (const t of (await listTemplates()).filter((x) => x.licence?.commercial === true)) {
  const scored = scoreIdentity({ imageRef: t.imageRef, caption: 'Attention is a muscle.', identity: identityGuide });
  const accents = [...new Set((Buffer.from(t.imageRef.split(',')[1], 'base64').toString('utf8').match(/#[0-9a-f]{6}/gi) ?? []))]
    .filter((h) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      return Math.max(r, g, b) - Math.min(r, g, b) >= 40;
    });
  console.log(
    `  ${t.key.padEnd(24)} ${(accents.join(' ') || '—').padEnd(18)} ` +
      `${String(scored.score).padEnd(6)} ${scored.findings.join(',') || 'on identity'}`,
  );
}
console.log('\nSTORY-067 gave every one of these a licence and a slot structure and nothing');
console.log('more. Every template legal, on-message and reusable. Together, a feed.');

rule('87. The guide shapes what gets made, not only what gets caught');
const chosen = await selectTemplate({ authorId: author.id, seed: 7, identity: identityGuide });
console.log(`chose ${chosen.template.key} — on identity, so nothing needed a human`);
console.log('\nSelection prefers on-identity templates and the score gates what slips past:');
console.log('the same evidence on both sides of generation that STORY-009 used for themes.');
console.log('Without it the library\'s off-accent templates would send most memes to a');
console.log('person for a fault the system itself chose.');

rule('88. The author disagrees, and the guide is versioned');
const revised = await saveIdentity({
  authorId: author.id,
  bookId: book.id,
  guide: {
    palette: { ...identityGuide.palette, accent: '#5fbf95' },
    typography: identityGuide.typography,
    tone_words: identityGuide.toneWords,
    do_not_use: identityGuide.doNotUse,
    derived_from: { ...identityGuide.derivedFrom, confidence: 'set by the author' },
  },
  createdBy: 'Anvi Siddabhattuni',
  note: 'the cover is green; blue was inferred from the text',
});
console.log(`v${revised.version} saved by ${revised.createdBy} — "${revised.note}"`);
const afterRevision = await selectTemplate({ authorId: author.id, seed: 7, identity: revised });
console.log(`the same seed now chooses ${afterRevision.template.key}, because the accent moved`);

rule('89. A revision applies to later memes and reinterprets no earlier one');
const memeAfter = await draftWeeklyPosts({
  authorId: author.id,
  bookId: book.id,
  count: 1,
  weekOf: weekStart(new Date(Date.now() + 28 * 86400000)),
});
const newMeme = memeAfter.find((d) => d.format === 'meme');
console.log(`new meme judged against v${newMeme.identity_version}, score ${newMeme.identity_score}`);
const { rows: byVersion } = await query(
  `SELECT identity_version v, COUNT(*)::int n, ARRAY_AGG(DISTINCT media->>'template') t
     FROM drafts WHERE format = 'meme' AND identity_version IS NOT NULL
    GROUP BY identity_version ORDER BY identity_version`,
);
for (const r of byVersion) {
  console.log(`  v${r.v}: ${r.n} meme(s) — ${r.t.join(', ')}`);
}
console.log('\nThe rules a human approved something under do not change underneath them.');
console.log('Same instinct as retiring a template instead of deleting it (STORY-067).');

rule('90. The identity trail');
for (const v of await listVersions({ bookId: book.id })) {
  console.log(
    `  v${v.version}${v.active ? ' (active)' : '        '}  ${v.palette.accent}  ` +
      `${String(v.createdBy).padEnd(22)} ${v.note || v.derivedFrom.confidence}`,
  );
}
const identityLog = await listAuditLog({ authorId: author.id, limit: 400 });
console.log();
for (const entry of identityLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('visual_identity.'))) {
  const m = entry.metadata ?? {};
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(26)} v${m.version} ` +
      `${m.palette?.accent ?? ''} by ${m.createdBy}`,
  );
}


// ── STORY-069 ────────────────────────────────────────────────────────────────
// Does a meme actually outperform a text post? The story that makes the premise
// the other three rest on falsifiable.

rule('91. The honest answer, on the data we actually have');
await collectEngagement({ authorId: author.id });
const realComparison = await compareFormats({ authorId: author.id });
console.log(
  `${realComparison.totalMeasured} posts measured · ` +
    `${realComparison.excludedTooYoung} excluded as too young (< ${realComparison.maturityHours}h) · ` +
    `needs ${realComparison.minSample} of each format per platform\n`,
);
const { rows: publishedSoFar } = await query(
  "SELECT COUNT(*)::int n FROM scheduled_posts WHERE status = 'published' AND author_id = $1",
  [author.id],
);
if (realComparison.platforms.length === 0) {
  console.log(
    `nothing to compare: ${publishedSoFar[0].n} post(s) have been published in this run and ` +
      `every one is younger than the ${realComparison.maturityHours}h window.`,
  );
  console.log('An empty table is the right output here — it is what a new account looks like.');
} else {
  console.log('platform    memes          text           verdict');
  for (const p of realComparison.platforms) {
    console.log(
      `  ${p.platform.padEnd(10)} n=${String(p.meme.n).padEnd(12)} n=${String(p.text.n).padEnd(12)} ${p.verdict}`,
    );
    console.log(`             ${p.because}`);
  }
}
console.log(`\nconclusive: ${realComparison.conclusive}`);
console.log('\nFour stories rest on the premise that memes earn more traction. This is the');
console.log('first thing that can check it, and on real data it says "not yet" — which is');
console.log('the correct output, not a failure of the dashboard.');

rule('92. What it takes to make it say anything at all');
// A constructed history, in a simulated world where memes really do lead. Said
// out loud: the collector is format-blind by default, and this is asking it to
// pretend otherwise so the recommendation path has something to act on.
const simBase = Date.now() - 200 * 86400000;
for (let i = 0; i < 40; i += 1) {
  const fmt = i % 2 ? 'meme' : 'text';
  const { rows: sd } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status,
                         format, media, image_rights)
     VALUES ($1,$2,'twitter',$3,0.9,'2026-07-06','approved',$4,$5,$6) RETURNING id`,
    [
      author.id,
      book.id,
      `simulated post ${i}`,
      fmt,
      fmt === 'meme' ? JSON.stringify({ imageRef: 'x', altText: 'y' }) : null,
      fmt === 'meme' ? 'cleared' : 'not_applicable',
    ],
  );
  await query(
    `INSERT INTO scheduled_posts
       (draft_id, author_id, platform, scheduled_for, status, external_id, published_at, format)
     VALUES ($1,$2,'twitter',$3,'published',$4,$3,$5)`,
    [sd[0].id, author.id, new Date(simBase + i * 3600000).toISOString(), `sim-${i}`, fmt],
  );
}
console.log('added 20 memes and 20 text posts on twitter, and asked the mocked collector');
console.log('to simulate a world where memes do 60% better. The collector does not do this');
console.log('on its own — a generator quietly tilted would make this demo a lie.\n');
await collectEngagement({ authorId: author.id, formatEffect: 0.6 });
const simulated = await compareFormats({ authorId: author.id });
const tw = simulated.platforms.find((p) => p.platform === 'twitter');
console.log(`twitter  memes n=${tw.meme.n} ${(tw.meme.mean * 100).toFixed(2)}% [${(tw.meme.low * 100).toFixed(2)}–${(tw.meme.high * 100).toFixed(2)}]`);
console.log(`         text  n=${tw.text.n} ${(tw.text.mean * 100).toFixed(2)}% [${(tw.text.low * 100).toFixed(2)}–${(tw.text.high * 100).toFixed(2)}]`);
console.log(`         → ${tw.verdict}, lift ${(tw.lift * 100).toFixed(0)}% — ${tw.because}`);
console.log('\nOnly now does it report a number. Below eight of each, or with the intervals');
console.log('overlapping, there is no lift to report and it says so instead.');

rule('93. A recommendation is a proposal, and nothing else');
const mix = await recommendMix({ authorId: author.id });
console.log(`proposed ${mix.proposed.length}, stayed quiet on ${mix.skipped.length} platform(s)`);
for (const skip of mix.skipped) {
  console.log(`  ${skip.platform.padEnd(10)} silent — ${skip.verdict}`);
}
const proposal = mix.proposed[0];
console.log(
  `\n  ${proposal.platform}: favours ${proposal.favours}, ` +
    `${proposal.current_memes} → ${proposal.suggested_memes} memes per batch  [${proposal.status}]`,
);
const { rows: beforeApproval } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
  author.id,
]);
console.log(`  author's mix right now: ${beforeApproval[0].memes_per_batch ?? '(default)'} — unchanged`);
console.log('\nThe drafter reads authors.memes_per_batch. A pending recommendation is a row in');
console.log('a table nothing consults, which is how "never silently changes what gets');
console.log('published" is enforced rather than merely intended.');

rule('94. Rejecting one changes nothing; approving one changes the mix');
await rejectMixRecommendation({
  recommendationId: proposal.id,
  reviewer: 'Anvi Siddabhattuni',
  notes: 'not yet — one platform is not the whole strategy',
});
const { rows: afterReject } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
  author.id,
]);
console.log(`rejected → mix is ${afterReject[0].memes_per_batch ?? '(default)'}`);

const secondScan = await recommendMix({ authorId: author.id });
const reproposed = secondScan.proposed[0];
await approveMixRecommendation({
  recommendationId: reproposed.id,
  reviewer: 'Anvi Siddabhattuni',
  notes: 'the evidence holds; try it for a month',
});
const { rows: afterApprove } = await query('SELECT memes_per_batch FROM authors WHERE id = $1', [
  author.id,
]);
console.log(`approved → mix is ${afterApprove[0].memes_per_batch} memes per batch`);
const nextBatch = await draftWeeklyPosts({
  authorId: author.id,
  bookId: book.id,
  count: 3,
  weekOf: weekStart(new Date(Date.now() + 42 * 86400000)),
});
console.log(
  `the next batch drafted ${nextBatch.filter((d) => d.format === 'meme').length} meme(s) — ` +
    'the approval is what moved it',
);

rule('95. The measurement trail');
const perfLog = await listAuditLog({ authorId: author.id, limit: 500 });
for (const entry of perfLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('engagement.') || e.action.startsWith('mix.'))
  .slice(-8)) {
  const m = entry.metadata ?? {};
  const detail =
    entry.action === 'engagement.collected'
      ? `${m.posts} posts · ${m.source} · formatEffect=${m.formatEffect}`
      : entry.action === 'mix.recommended'
        ? `${m.platform} ${m.from}→${m.to} applied=${m.applied}`
        : `proposed ${m.proposed}, skipped ${m.skipped}, conclusive=${m.conclusive}`;
  console.log(
    `${entry.created_at.toISOString()}  ${entry.action.padEnd(24)} ${detail}`,
  );
}
console.log('\n"formatEffect" is on the log because a reader of these numbers is entitled to');
console.log('know they came from a mock, and whether that mock had a thumb on the scale.');


// ── STORY-012 ────────────────────────────────────────────────────────────────
// The Approval and Notification Agent. Half of this shipped with STORY-001; the
// other half is the word "and".

rule('96. Held, in every case — that half has worked since STORY-001');
const approvalQueue = await findAwaitingApproval({ authorId: author.id });
console.log(`${approvalQueue.total} items are waiting on a human right now, ${approvalQueue.escalated} of them escalated\n`);
for (const [kind, n] of Object.entries(approvalQueue.byKind)) {
  console.log(`  ${String(n).padStart(3)} ${kind}`);
}
console.log('\nFour kinds of work, one gate. scheduleDraft, sendOutreachMessage and');
console.log('distributePressKit each refuse unapproved work, and the gate has grown to four');
console.log('targets without being forked once.');

const notifiableNow = approvalQueue.items.filter((i) => i.notifiable).length;
rule(`97. And nobody could ever be told about ${notifiableNow} of them`);
console.log('Until this story the notifications table could not reference a draft. Its own');
console.log('constraint said so:\n');
console.log("    CHECK (num_nonnulls(pr_kit_id) = 1)\n");
console.log('Not a bug in the notifier — an absence in the schema. A social post could sit');
console.log('in pending_approval for a week and there was no mechanism by which anyone');
console.log('could be told.');
const { rows: reviewerCount } = await query(
  'SELECT COUNT(*)::int n FROM reviewers WHERE author_id = $1 AND active',
  [author.id],
);
console.log(`\nactive reviewers configured: ${reviewerCount[0].n}`);

rule('98. Work waiting, and nobody to tell');
await query('UPDATE reviewers SET active = FALSE WHERE author_id = $1', [author.id]);
const unreachable = await notifyAwaitingApproval({ authorId: author.id });
console.log(`unreachable: ${unreachable.unreachable} — ${unreachable.queue.total} items waiting`);
console.log('\nRecorded on the audit log rather than passed over in silence. A queue with');
console.log('nobody to tell is a different state from an empty queue, and STORY-007 made');
console.log('that distinction for press kits; it is no less true here.');

rule('99. One digest, not one email per item');
await query('UPDATE reviewers SET active = TRUE WHERE author_id = $1', [author.id]);
const firstSweep = await notifyAwaitingApproval({ authorId: author.id });
for (const n of firstSweep.notified) {
  console.log(`  ${n.reviewer.padEnd(34)} ${n.items} items in one email  (${n.externalId ?? n.failed})`);
}
if (firstSweep.skipped.length > 0) {
  console.log(
    `\n  (${firstSweep.skipped.length} item/reviewer pairs were already announced — the background ` +
      'worker\n   ran this same sweep earlier in the demo, which is REQ-004 doing its job)',
  );
}
const { rows: digest } = await query(
  `SELECT subject, body FROM notifications
    WHERE author_id = $1 AND draft_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
  [author.id],
);
if (digest[0]) {
  console.log(`\n  subject: ${digest[0].subject}`);
  console.log(digest[0].body.split('\n').slice(0, 8).map((l) => `  ${l}`).join('\n'));
}
console.log('\nSTORY-007 mails once per press kit, which is right for a kit: they are rare and');
console.log('each is its own decision. Social drafts arrive four at a time every week, and');
console.log('that model there is four emails a week — which a reviewer stops reading.');

rule('100. Told once, ever');
const secondSweep = await notifyAwaitingApproval({ authorId: author.id });
console.log(`second sweep → notified ${secondSweep.notified.length}, already known ${secondSweep.skipped.length}`);
const { rows: statuses } = await query(
  `SELECT status, COUNT(*)::int n FROM drafts WHERE author_id = $1 GROUP BY status ORDER BY status`,
  [author.id],
);
console.log(`draft statuses unchanged by notifying: ${statuses.map((r) => `${r.status} ${r.n}`).join(' · ')}`);
console.log('\nRows are per item, so the guarantee is per item: announced once to a reviewer,');
console.log('never again however often the sweep runs. And notifying is not deciding — not');
console.log('one status moved.');

rule('101. The approval trail');
const approvalLog = await listAuditLog({ authorId: author.id, limit: 500 });
for (const entry of approvalLog
  .slice()
  .reverse()
  .filter((e) => e.action.startsWith('approval.'))
  .slice(-6)) {
  const m = entry.metadata ?? {};
  const detail =
    entry.action === 'approval.notified'
      ? `${m.reviewer} · ${m.items} items · decided=${m.decided}`
      : entry.action === 'approval.unreachable'
        ? `${m.waiting} waiting · ${m.reason}`
        : `waiting ${m.waiting}, notified ${m.notified}, already known ${m.alreadyKnown}`;
  console.log(`${entry.created_at.toISOString()}  ${entry.action.padEnd(28)} ${detail}`);
}


// ── STORY-013 ────────────────────────────────────────────────────────────────
// The Audit and Security Agent. "Logs all actions" was already true; the other
// half of that name had nothing behind it.

rule('102. Every action is logged, and the log refuses to be rewritten');
const { rows: logSize } = await query('SELECT COUNT(*)::int n FROM audit_log');
const { rows: actors } = await query(
  'SELECT actor, COUNT(*)::int n FROM audit_log GROUP BY actor ORDER BY n DESC LIMIT 6',
);
console.log(`${logSize[0].n} rows written by every agent in the system:\n`);
for (const a of actors) console.log(`  ${String(a.n).padStart(4)}  ${a.actor}`);
console.log();
for (const [label, sql] of [
  ['UPDATE', "UPDATE audit_log SET action='x' WHERE id=1"],
  ['DELETE', 'DELETE FROM audit_log WHERE id=1'],
  ['TRUNCATE', 'TRUNCATE audit_log'],
]) {
  try {
    await query(sql);
    console.log(`  ${label.padEnd(9)} UNEXPECTEDLY ALLOWED`);
  } catch (error) {
    console.log(`  ${label.padEnd(9)} rejected — ${error.message.split(';')[0]}`);
  }
}

rule('103. But append-only here is a policy, and a policy can be switched off');
await sealAuditLog({});
console.log('sealed the log so far.\n');
const beforeTamper = await query('SELECT actor, action FROM audit_log WHERE id = 3');
console.log(`row 3 as written : ${beforeTamper.rows[0].actor} / ${beforeTamper.rows[0].action}`);
await query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
await query("UPDATE audit_log SET actor='SomebodyElse', action='draft.approved' WHERE id=3");
await query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
const afterTamper = await query('SELECT actor, action FROM audit_log WHERE id = 3');
console.log(`row 3 now        : ${afterTamper.rows[0].actor} / ${afterTamper.rows[0].action}`);
try {
  await query("UPDATE audit_log SET action='x' WHERE id=1");
} catch (error) {
  console.log(`\ntriggers are back on: ${error.message.split(';')[0]}`);
}
console.log('The log still refuses every ordinary write, and history has been rewritten.');
console.log('Before this story, nothing in the system could tell.');

rule('104. Now it can');
const caught = await verifyAuditLog({});
console.log(`status: ${caught.status}`);
for (const b of caught.breaks) {
  console.log(`  checkpoint ${b.checkpoint}, rows ${b.range[0]}–${b.range[1]}`);
  console.log(`  sealed ${b.rowsSealed} rows, ${b.rowsNow} there now`);
  console.log(`  ${b.finding}`);
}
console.log('\nThe digest covers metadata too — the thresholds a decision was judged against,');
console.log('whose session stood behind it. A seal that ignored those would be believed.');

rule('105. Rows removed are caught the same way');
await query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
await query("UPDATE audit_log SET actor=$1, action=$2 WHERE id=3", [
  beforeTamper.rows[0].actor,
  beforeTamper.rows[0].action,
]);
await query('DELETE FROM audit_log WHERE id IN (4, 5)');
await query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
const removed = await verifyAuditLog({});
console.log(`status: ${removed.status}`);
console.log(
  `  sealed ${removed.breaks[0].rowsSealed} rows, ${removed.breaks[0].rowsNow} there now — ${removed.breaks[0].finding}`,
);
console.log('\nRow counts are stored at seal time rather than derived from the id range:');
console.log('sequence gaps are normal, so (to_id - from_id + 1) never was the count.');

rule('106. What it cannot do, said plainly');
console.log('Anyone who can disable the log\'s triggers can disable the checkpoints\' triggers');
console.log('too, and re-seal a doctored range into a consistent chain. What this buys is that');
console.log('tampering now takes rewriting two structures in step instead of one, and that');
console.log('anything short of that is caught. Publishing digests somewhere this database');
console.log('cannot reach is the next step, and it is a deployment decision, not a schema one.');
console.log('\nAnd a detection is not a repair: the verdict is logged with needsHuman.');


// ── STORY-014 ────────────────────────────────────────────────────────────────
// The trust dashboard. Everything it shows already existed, and existed
// separately — which meant nobody could answer "is this behaving" in one place.

rule('107. The dashboard opens by reporting the damage this demo did');
const board = await trustDashboard({ authorId: author.id });
console.log(`STATUS: ${board.governance.status.toUpperCase()}   score ${board.governance.score} (${board.governance.passed}/${board.governance.total})`);
console.log(board.governance.headline);
console.log();
console.log('The tampering three stages ago was never repaired, so the audit-integrity');
console.log('invariant is failing. The dashboard reporting a breach against its own system');
console.log('is the check working, not the dashboard misbehaving.');

rule('108. Invariants, and why they outrank the score');
console.log('result  severity   check');
for (const c of board.checks) {
  console.log(
    `  ${(c.passed ? 'pass' : 'FAIL').padEnd(6)}${c.severity.padEnd(11)}${c.label}`,
  );
  if (!c.passed) console.log(`         ${c.violations} violation(s) — ${c.why}`);
}
console.log('\nA broken invariant is a breach whatever the score says. "94% compliant" printed');
console.log('above content that went out unapproved would be worse than showing nothing.');

rule('109. The four gates, checked from outside the code that enforces them');
for (const c of board.checks.filter((x) => x.severity === 'invariant' && x.id.startsWith('gate.'))) {
  console.log(`  ${(c.passed ? 'pass' : 'FAIL').padEnd(6)} ${c.label}`);
}
console.log('\nThe gates live inside scheduleDraft, sendOutreachMessage and distributePressKit.');
console.log('These queries ask the database the same question independently — a gate that');
console.log('checks only itself is the arrangement STORY-008 spent a story removing.');
console.log('\n(The demo injects 40 published posts directly at stage 92 to build a sample for');
console.log('the meme comparison. Those are genuinely ungated and the check is right to see');
console.log('them, so they are excluded by external id — named here rather than hidden.)');

rule('110. Anomalies, and the ones it will not guess at');
console.log(`${board.anomalies.findings} finding(s) across ${board.anomalies.detectors.length} detectors\n`);
for (const d of board.anomalies.detectors) {
  console.log(`  ${d.confidence.padEnd(22)} ${d.label}`);
  console.log(`  ${''.padEnd(22)} ${d.because}`);
  for (const f of d.findings) console.log(`  ${''.padEnd(22)} → ${f.detail}`);
}
console.log('\nA "spike" over four data points is noise, and a dashboard that reports one will');
console.log('be believed. Each detector states the sample it had and declines below it.');

rule('111. Health, and the queue, from the modules that own them');
console.log(`worker: ${board.health.workerSeen ? `last ran ${board.health.minutesSinceRun} min ago` : 'has never run'}`);
console.log(`jobs  : ${Object.entries(board.health.jobs).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
console.log(`audit : ${board.health.auditIntegrity} (sealed through row ${board.health.sealedThrough})`);
console.log(`queue : ${board.queue.total} waiting on a human, ${board.queue.escalated} escalated`);
console.log(`        ${Object.entries(board.queue.byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
console.log('\nNone of these numbers are computed here. Audit integrity comes from the Audit');
console.log('and Security Agent, the queue from the Approval and Notification Agent — a');
console.log('dashboard that recomputed them could disagree with them, invisibly.');

await new Promise((resolve) => demoServer.close(resolve));

console.log('\nSTORY-014 complete — one place to ask whether the system is behaving, and a');
console.log('score that is never allowed to outrank a broken promise\n');
await closePool();

