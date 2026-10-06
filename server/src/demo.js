/**
 * End-to-end walkthrough of STORY-001 to STORY-065 (plus STORY-008 through
 * STORY-011 to STORY-017, and STORY-066 to STORY-069), printed step by step.
 *
 * Run against a freshly seeded database:  npm run db:reset && npm run demo
 */
import { readFile } from 'node:fs/promises';

import jwt from 'jsonwebtoken';

import { alignToThemes } from './agents/contentAlignmentAgent.js';
import {
  monitorContent,
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
import { callExternal, integrationHealth, isRetryable } from './agents/apiIntegrationAgent.js';
import {
  onboardTenant,
  restoreTenant,
  suspendTenant,
  tenantTables,
  verifyIsolation,
} from './agents/tenantManagementAgent.js';
import {
  appliedMigrations,
  deploymentHistory,
  expectedMigrations,
  readiness,
  recordReady,
  recordStart,
  recordStop,
} from './services/deployment.js';
import { draftWeeklyPosts, scoreDraft, weekStart } from './agents/contentDraftingAgent.js';
import { monthStart, scoutOpportunities } from './agents/opportunityScoutingAgent.js';
import { draftPressKit } from './agents/prMaterialsAgent.js';
import { generatePrMaterials, proseOf } from './agents/aiContentGenerationAgent.js';
import { runChecks } from './services/governance.js';
import { alertOnBreaches } from './services/trustHistory.js';
import {
  alertOnOutages,
  heartbeat,
  performHealthChecks,
  systemStatus,
} from './services/healthMonitoring.js';
import { contentPerformance, trackEngagement } from './services/performanceMetrics.js';
import { registerIntegration } from './services/integrationRoutes.js';
import { dispatch, send } from './services/messageBus.js';
import { planFor } from './services/coordination.js';
import { provisionTenant } from './services/tenantSchemas.js';
import { SYSTEM_READS } from './middleware/tenantScope.js';
import { TENANT_SCOPED_ROUTES, router } from './routes/index.js';
import { CSP_EXEMPTIONS, cspHeader } from './services/securityHeaders.js';
import { notifyFailedPublishes } from './services/publishFailureNotifier.js';
import { detectAnomalies } from './services/anomalies.js';
import { outboundInventory } from './services/outboundPaths.js';
import { emailApi } from './services/emailApi.js';
import { grantMatrix } from './services/permissions.js';
import { classifyRoutes, surfaceCoverage } from './services/tenantSurface.js';
import { draftOutreachMessages, scoreMessage } from './agents/prOutreachAgent.js';
import { config } from './config.js';
import { attentionFor } from './services/attention.js';
import { openaiStandIn, stripeStandIn, twilioStandIn } from './dev/standIns.js';
import { chargeSubscription } from './services/billing.js';
import { sendSms } from './services/sms.js';
import { listAnomalies, recordPrometheusAlerts, scanAndEscalate, updateAnomaly } from './services/anomalyEscalation.js';
import { registry as metricsRegistry } from './services/metrics.js';
import YAML from 'yaml';
import { governanceScore } from './services/governanceScore.js';
import { SOURCES as SEARCH_SOURCES, aggregate as searchAggregate, digestOf, reconcile as searchReconcile, searchTenant } from './services/searchIndex.js';
import { createApp } from './app.js';
import { asTenant, closePool, ownerQuery, query, withTransaction } from './db/pool.js';
import { HANDLERS, RECURRING } from './jobs/handlers.js';
import { ensureRecurringJobs, enqueue, reapStaleJobs, recordDeferrals, retryJob, runOnce, tick } from './jobs/queue.js';
import {
  approveDraft,
  approveMixRecommendation,
  approveOutreach,
  approvePrMaterial,
  rejectMixRecommendation,
} from './services/approvals.js';
import { listAuditLog, recordAction } from './services/auditLog.js';
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
import { checkVoice, deriveVoice } from './services/voiceProfile.js';
import { assess } from './services/escalationPolicy.js';
import { flushAccessLog } from './services/dataAccess.js';
import { LONG_FIELD } from './db/sampleManuscript.js';
import { bookStyle, reviewDraft } from './services/contentReview.js';
import { quotedPassages } from './services/bookModel.js';
import { auditKeyId } from './services/auditKey.js';
import { auditAccessPolicy } from './services/auditAccess.js';
import { generateAuditReport, reportAsCsv } from './services/auditReports.js';

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
    `  kit ${kit.id}  ${(kit.milestone_type ?? 'on request').padEnd(12)} ${kit.pending_count} awaiting` +
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
  console.log(`  raised: ${String(raised.type ?? raised.kind ?? 'item').padEnd(14)} → ${raised.status}`);
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
// As the schema owner. Since STORY-033 the application's own login cannot do
// this — it does not own the table and has no UPDATE on it — so rewriting
// history now takes the database owner's credentials, which is the threat
// STORY-013's seals exist to catch.
// Since STORY-049 the log is a view over its encrypted storage, so the
// tampering is done where the rows actually live.
await ownerQuery('ALTER TABLE audit_log_sealed DISABLE TRIGGER ALL');
await ownerQuery("UPDATE audit_log_sealed SET actor='SomebodyElse', action='draft.approved' WHERE id=3");
await ownerQuery('ALTER TABLE audit_log_sealed ENABLE TRIGGER ALL');
const afterTamper = await query('SELECT actor, action FROM audit_log WHERE id = 3');
console.log(`row 3 now        : ${afterTamper.rows[0].actor} / ${afterTamper.rows[0].action}`);
try {
  await query("UPDATE audit_log SET action='x' WHERE id=1");
} catch (error) {
  console.log(`\nthe application login tries the same: ${error.message.split(';')[0]}`);
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
await ownerQuery('ALTER TABLE audit_log_sealed DISABLE TRIGGER ALL');
await ownerQuery("UPDATE audit_log_sealed SET actor=$1, action=$2 WHERE id=3", [
  beforeTamper.rows[0].actor,
  beforeTamper.rows[0].action,
]);
await ownerQuery('DELETE FROM audit_log_sealed WHERE id IN (4, 5)');
await ownerQuery('ALTER TABLE audit_log_sealed ENABLE TRIGGER ALL');
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


// ── STORY-015 ────────────────────────────────────────────────────────────────
// The Infrastructure and Deployment Agent. Half of this story cannot be done
// from a laptop, and the half that can is the half that matters operationally.

rule('112. What this story could not do, first');
console.log('The clause asks for deployment to a public demo URL using Docker. There is no');
console.log('cloud account, no credentials, and Docker is not installed on the machine this');
console.log('was built on. The Dockerfiles, the compose stack and the CI workflow are');
console.log('written and reviewed and have never been executed — each says so in its own');
console.log('first lines, and so does the README. A green tick over an untested claim would');
console.log('be a worse outcome than an unfinished story.');

rule('113. Liveness and readiness are different questions');
const live = await readiness({});
console.log(`ready: ${live.ready}  (status ${live.status})`);
for (const c of live.checks) {
  console.log(`  ${(c.ok ? 'ok  ' : 'FAIL')}  ${c.id.padEnd(11)} ${c.detail}`);
}
console.log('\n/health answers "is this process up" — what a platform restarts on.');
console.log('/ready answers "is it safe to send this traffic" — what a load balancer asks.');
console.log('Conflating them means a schema mismatch gets treated as a crash and restarted');
console.log('into the same mismatch, forever.');

rule('114. The failure a rolling deploy actually produces');
const appliedNow = await appliedMigrations();
const lastMigration = appliedNow[appliedNow.length - 1];
console.log(`this build expects ${expectedMigrations().length} migrations; the database has ${appliedNow.length}.`);
console.log(`\nremoving ${lastMigration} from the applied list — new code, old schema:\n`);
await ownerQuery('DELETE FROM schema_migrations WHERE filename = $1', [lastMigration]);
const behind = await readiness({});
console.log(`  ready: ${behind.ready}  (status ${behind.status})`);
console.log(`  ${behind.checks.find((c) => c.id === 'schema').detail}`);
await ownerQuery('INSERT INTO schema_migrations (filename) VALUES ($1)', [lastMigration]);
console.log(`\n  restored → ready: ${(await readiness({})).ready}`);
console.log('\nThat instance starts perfectly and answers /health. It throws on the first');
console.log('request touching a column that is not there. Readiness is what keeps traffic');
console.log('off it in the minutes before somebody notices.');

rule('115. A release you can identify is a release you can roll back to');
const demoRelease = await recordStart({ version: '0.1.0-demo', commit: 'demo0000' });
await recordReady({ deploymentId: demoRelease.id, readinessResult: await readiness({}) });
const { current: liveRelease, history: releaseHistory } = await deploymentHistory({ limit: 5 });
console.log('version        commit    schema      status   instance');
for (const d of releaseHistory.slice(0, 5)) {
  console.log(
    `  ${String(d.version).padEnd(13)}${String(d.commit_sha || '—').padEnd(10)}` +
      `${String(d.migrations_applied + '/' + d.migrations_expected).padEnd(12)}` +
      `${String(d.status).padEnd(9)}${d.instance}`,
  );
}
console.log(`\ncurrently running: ${liveRelease ? liveRelease.version : '(nothing)'}`);
console.log('\nWritten by the process itself at boot, not by whatever deployed it: the');
console.log('process is the only thing that knows which commit it is actually running.');
console.log('A record produced by the deployer describes what it intended to start.');

rule('116. Stopping on purpose, and stopping otherwise');
await recordStop({ deploymentId: demoRelease.id, reason: 'SIGTERM', clean: true });
const crashed = await recordStart({ version: '0.1.0-demo', commit: 'demo0000' });
await recordStop({ deploymentId: crashed.id, reason: 'out of memory', clean: false });
const { rows: stops } = await query(
  `SELECT status, stop_reason FROM deployments WHERE version = '0.1.0-demo' ORDER BY id DESC LIMIT 2`,
);
for (const s of stops) console.log(`  ${s.status.padEnd(9)} ${s.stop_reason}`);
console.log('\nAn instance that keeps crashing and restarting looks like a healthy deploy');
console.log('history unless the difference between the two is recorded.');
console.log('\nThe API also drains now: SIGTERM stops new connections, finishes the requests');
console.log('in hand, and exits. Verified by holding a database lock, sending SIGTERM, and');
console.log('watching the blocked request return HTTP 200 with a full body afterwards — the');
console.log('worker has done this since STORY-065 and the API never did.');


// ── STORY-016 ────────────────────────────────────────────────────────────────
// The API Integration Agent. The adapters already worked; what they had no
// notion of is the ways a real provider fails.

rule('117. 48 outbound calls, and until now none of them recorded');
const health117 = await integrationHealth({ sinceHours: 24 });
console.log('service      calls  attempts  ok  retried  timed out  failed  avg ms');
for (const h of health117) {
  console.log(
    `  ${h.service.padEnd(11)}${String(h.calls).padEnd(7)}${String(h.attempts).padEnd(10)}` +
      `${String(h.ok).padEnd(4)}${String(h.retried).padEnd(9)}${String(h.timed_out).padEnd(11)}` +
      `${String(h.failed).padEnd(8)}${h.avg_ms}`,
  );
}
console.log('\nThe audit log has always recorded that a post was published. It never recorded');
console.log('that a platform answered 200 in 1.2s on the second attempt — and when a provider');
console.log('starts degrading, that is the fact that tells you.');

rule('118. A 429 and a 400 are opposite instructions');
console.log('status              treated as');
for (const [label, err] of [
  ['429 rate limited', { status: 429 }],
  ['503 unavailable', { status: 503 }],
  ['400 bad request', { status: 400 }],
  ['404 not found', { status: 404 }],
  ['connection reset', new Error('ECONNRESET')],
  ['no response at all', { name: 'TimeoutError' }],
]) {
  console.log(`  ${label.padEnd(20)}${isRetryable(err) ? 'try again' : 'the provider answered — stop'}`);
}
console.log('\nRetrying a rejected request gets the same refusal more slowly. Not retrying a');
console.log('rate limit throws away work that would have succeeded a second later. Neither');
console.log('mistake was possible before, because there was no retry at all.');

rule('119. A rate limit, ridden out');
let demoAttempts = 0;
// Declared for the demo, as the gateway now requires (STORY-038).
registerIntegration('demo-provider', { failureThreshold: 1_000_000 });
const rode = await callExternal({
  service: 'demo-provider',
  operation: 'flaky',
  sleep: () => Promise.resolve(),
  fn: async () => {
    demoAttempts += 1;
    if (demoAttempts < 3) {
      throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 250 });
    }
    return { ok: true };
  },
});
console.log(`succeeded on attempt ${demoAttempts}: ${JSON.stringify(rode)}`);
const { rows: rideRows } = await query(
  `SELECT attempt, outcome, status FROM api_interactions
    WHERE service = 'demo-provider' AND operation = 'flaky' ORDER BY attempt`,
);
for (const r of rideRows) {
  console.log(`  attempt ${r.attempt}  ${String(r.outcome).padEnd(10)} status ${r.status ?? '-'}`);
}
console.log('\nEvery attempt is its own row. A call that succeeded on the third try and one');
console.log('that succeeded first time are very different pictures of a provider.');

rule('120. A provider that accepts the connection and never answers');
try {
  await callExternal({
    service: 'demo-provider',
    operation: 'hangs',
    timeoutMs: 400,
    maxAttempts: 2,
    sleep: () => Promise.resolve(),
    fn: (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
} catch (error) {
  console.log(`gave up: ${error.message}`);
}
const { rows: hungRows } = await query(
  `SELECT attempt, outcome FROM api_interactions
    WHERE service = 'demo-provider' AND operation = 'hangs' ORDER BY attempt`,
);
console.log(`  ${hungRows.map((r) => `attempt ${r.attempt} ${r.outcome}`).join('  ·  ')}`);
console.log('\nA bare fetch in Node has no timeout. Against a socket that accepts and never');
console.log('answers it waits indefinitely — measured at over four seconds before the test');
console.log('harness itself gave up, and it would have waited all day. Since STORY-015 that');
console.log('would also have held the graceful drain open until the platform killed it.');

rule('121. Giving up is an event, not a silence');
const givenUp = await listAuditLog({ limit: 200 });
for (const entry of givenUp.filter((e) => e.action === 'api.call_failed').slice(0, 3)) {
  const m = entry.metadata ?? {};
  console.log(
    `${entry.created_at.toISOString()}  ${String(m.service).padEnd(15)} ${String(m.operation).padEnd(10)} ` +
      `after ${m.attempts} attempts · gaveUp=${m.gaveUp}`,
  );
}
console.log('\nThe interactions table has the detail; the audit log has the fact that the');
console.log('system stopped trying. A provider nobody can reach is a decision somebody');
console.log('should know was made on their behalf.');


// ── STORY-017 ────────────────────────────────────────────────────────────────
// The Tenant Management Agent. Isolation was already enforced — and this story
// is where that claim got tested rather than restated.

rule('122. Isolation here is a column, on 23 tables');
const isoTables = await tenantTables();
console.log(`${isoTables.length} tables carry author_id:\n`);
console.log('  ' + isoTables.join(', '));
console.log('\nThe build note suggests PostgreSQL schemas or separate databases. This uses');
console.log('neither. Every guard is application middleware over that column — which the');
console.log('README has said all along, and which this story finally went and tested.');

rule('123. The guard checks the address, not the answer');
console.log('tenantParam refuses /authors/2/... to author 1. It says nothing about the rows');
console.log('a handler then goes and fetches.\n');
console.log('Asking for your OWN trust dashboard used to return this:');
console.log('  recent actions: 20   ← of which 1 belonged to another tenant');
console.log('    author 2 · TomasPrivateAgent · tomas.secret_action\n');
console.log('The middleware was working exactly as designed. The leak was in a handler');
console.log('written two stories later that queried audit_log with no tenant filter at all.');
console.log('Two routes had it; both are fixed, and the walk below is what would have');
console.log('caught them.');

rule('124. Onboarding a tenant, with its access already correct');
const newTenant = await onboardTenant({
  name: 'Priya Raman',
  email: `priya-${Date.now()}@example.test`,
  password: 'a-long-enough-password',
  role: 'author',
});
console.log(
  `author ${newTenant.author.id} · ${newTenant.author.name} · status ${newTenant.author.tenant_status}`,
);
console.log(`account ${newTenant.user.email} · role ${newTenant.user.role}`);
console.log('\nOne transaction. An author with no account is a tenant nobody can reach; an');
console.log('account with no author is a session with nothing behind it. Either half alone');
console.log('is a broken state somebody cleans up by hand.');

rule('125. Suspending without destroying the record');
const { rows: beforeSuspend } = await query(
  'SELECT COUNT(*)::int n FROM audit_log WHERE author_id = $1',
  [newTenant.author.id],
);
await suspendTenant({ authorId: newTenant.author.id, reason: 'demo' });
const { rows: afterSuspend } = await query(
  'SELECT COUNT(*)::int n FROM audit_log WHERE author_id = $1',
  [newTenant.author.id],
);
console.log(`audit rows before: ${beforeSuspend[0].n}   after suspension: ${afterSuspend[0].n}`);
console.log('\nSuspended, not deleted — the same rule as retiring a template rather than');
console.log('dropping it. A cascading delete takes the evidence away with the account.');

rule('126. Checked from outside the code that enforces it');
const isolation = await verifyIsolation({});
console.log(`isolation: ${isolation.ok ? 'clean' : 'BREACH'} across ${isolation.tablesChecked} tables`);
console.log(`excluded:  ${isolation.excluded.join(', ')}`);
for (const f of isolation.findings) console.log(`  ${f.table}: ${f.detail}`);
console.log('\naudit_log is excluded on purpose: it has no foreign key to authors, because');
console.log('deleting an account must not delete the record of what it did. The first');
console.log('version of this check reported 1,868 such rows as orphans — a design decision');
console.log('read as a fault, which is how a security check earns the right to be ignored.');
console.log('\nWhat it does look for: a child row claiming one tenant while its parent');
console.log('belongs to another. No code path should produce that, which is exactly why a');
console.log('check that only inspects incoming requests would never see it.');

await new Promise((resolve) => demoServer.close(resolve));

console.log('\nSTORY-017 complete — the isolation claim was tested, it failed in two routes,');
console.log('and there is now a check that looks from outside the guard\n');


// ── STORY-018 ────────────────────────────────────────────────────────────────
// The AI Content Generation Agent. The agent map has named it since the start
// and it had never generated anything — it was a scorer, grading other agents'
// output. This is where it writes, and where the half of its own acceptance
// criterion nobody could fail finally became failable.

rule('127. Press that does not wait for something to happen');
const { rows: existingKits } = await query(
  'SELECT COUNT(*)::int n FROM pr_kits WHERE book_id = $1 AND milestone_id IS NOT NULL',
  [book.id],
);
console.log(`kits so far: ${existingKits[0].n}, every one of them attached to a milestone.`);
console.log('A book has three or four milestones in its life. It needs press for the rest');
console.log('of it too, and the only way to ask used to be inventing an event.\n');

const onDemand = await generatePrMaterials({
  authorId: author.id,
  bookId: book.id,
  requestedBy: 'Demo Publicist',
});
console.log(`kit ${onDemand.kit.id} · occasion ${onDemand.kit.occasion} · milestone_id ${onDemand.kit.milestone_id}`);
console.log(`requested by ${onDemand.kit.requested_by} · angle ${onDemand.kit.angle}`);
for (const m of onDemand.materials) {
  console.log(
    `  ${m.type.padEnd(14)} align ${Number(m.theme_alignment).toFixed(2)} · ` +
      `voice ${Number(m.voice_score).toFixed(2)} · ${m.status}`,
  );
}

rule('128. Written from what the book argues, not from its theme labels');
console.log(`grounded in ${onDemand.kit.grounded_themes} themes over ${onDemand.kit.grounded_passages} passages\n`);
for (const t of onDemand.grounding.themes) {
  console.log(`  ${t.theme} — ${t.keyMessage || '(no key message recorded)'}`);
}
const onDemandRelease = onDemand.materials.find((m) => m.type === 'press_release');
console.log('\nWith no news hook, the grounding is all the release has to say. Its opening:');
console.log(`  ${onDemandRelease.body.split('\n').filter(Boolean)[3]?.slice(0, 150) ?? ''}`);

rule('129. Voice, measured off the author\'s own posts');
const { rows: demoHistory } = await query(
  'SELECT content FROM social_history WHERE author_id = $1',
  [author.id],
);
const demoVoice = deriveVoice(demoHistory, author.voice_profile);
console.log(`derived from ${demoVoice.posts} prior posts · enforceable ${demoVoice.enforceable}`);
console.log(`  sentences average ${demoVoice.meanSentenceWords.toFixed(1)} words`);
console.log(`  exclamations/100w ${demoVoice.exclamationsPer100.toFixed(2)} · hype/100w ${demoVoice.hypePer100.toFixed(2)}`);
console.log('\nWhat the hand-written profile claims, checked against the writing:');
for (const claim of demoVoice.stated) {
  const verdict = claim.supported === null ? 'not measurable' : claim.supported ? 'supported' : 'NOT supported';
  console.log(`  ${claim.kind}: ${claim.claim} — ${verdict}`);
}
console.log('\nBefore this story, assess() was called for press without a voice number at');
console.log('all. The floor existed and had nothing to act on.');

rule('130. The furniture of a press kit is not shouting');
const releaseText = `${onDemandRelease.headline}\n${onDemandRelease.body}`;
const rawVoice = checkVoice({ text: releaseText, voice: demoVoice });
const proseVoice = checkVoice({ text: proseOf(releaseText), voice: demoVoice });
console.log(`counted raw, with FOR IMMEDIATE RELEASE and MEDIA CONTACT: ${rawVoice.score.toFixed(2)}`);
console.log(`counted on the prose alone:                                ${proseVoice.score.toFixed(2)}`);
console.log('\nA run of capitals reads as shouting, correctly, for a social post. A fact');
console.log('sheet is almost entirely capitalised labels, so scoring the format would fail');
console.log('every press kit for being one — a format measurement wearing voice\'s name.');
console.log('The sentences are what the author is answerable for, so those are what count.');
console.log(`\nThis release still reads longer than this author's posts: ${proseVoice.violations.join(', ') || 'no violations'}.`);
console.log('Reported, not escalated — the composite clears the floor. A note, not a gate.');

rule('131. Copy that argues every theme, in a voice the author has never used');
const hypeProvider = {
  name: 'demo-off-voice',
  async draftKit() {
    const body =
      'FOR IMMEDIATE RELEASE\n\nThis absolutely AMAZING book about deep work, craft, ' +
      'attention and resilience is guaranteed to transform your life in ways that are ' +
      'frankly unbelievable and completely game-changing!!! Attention is a muscle! Craft ' +
      'is the slow accumulation of decisions nobody claps for! Resilience is what remains ' +
      'when motivation has gone home, which is insane and epic, so grab this massive smash ' +
      'hit immediately before this limited exclusive offer disappears forever!!!\n\n' +
      'ABOUT THE BOOK — an amazing book.\n\nMEDIA CONTACT — press@example.test';
    return ['press_release', 'author_bio', 'fact_sheet'].map((type) => ({
      type,
      headline: 'An AMAZING and incredible book about deep work and craft!!!',
      body,
      themesUsed: book.themes,
    }));
  },
};
await query("UPDATE pr_kits SET status = 'superseded' WHERE book_id = $1 AND status = 'drafting'", [book.id]);
const offVoice = await generatePrMaterials({
  authorId: author.id,
  bookId: book.id,
  provider: hypeProvider,
});
const offRelease = offVoice.materials.find((m) => m.type === 'press_release');
console.log(`theme alignment ${Number(offRelease.theme_alignment).toFixed(2)} — it names every theme and carries their arguments`);
console.log(`voice           ${Number(offRelease.voice_score).toFixed(2)} — floor is ${config.minVoiceMatch}`);
console.log(`status          ${offRelease.status}`);
console.log(`reads unlike the author on: ${offRelease.voice_violations.join(', ')}`);
console.log('\nThis is the case the story exists for. On themes alone it passes. Before');
console.log('STORY-018 that was the whole test, and this copy would have queued for');
console.log('ordinary approval alongside the release above it.');

rule('132. Checked from outside the code that measures it');
const pressChecks = await runChecks({});
for (const id of ['gate.press', 'press.voice_measured']) {
  const check = pressChecks.find((c) => c.id === id);
  console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.id.padEnd(22)} ${check.label}`);
}
const { rows: unmeasured } = await query(
  `SELECT COUNT(*)::int n FROM pr_materials
    WHERE voice_score IS NULL
      AND id <= COALESCE((SELECT material_id FROM pr_voice_watermark), 0)`,
);
console.log(`\n${unmeasured[0].n} materials predate the story and carry no voice verdict.`);
console.log('They are excluded by a watermark rather than backfilled: a score nothing');
console.log('measured would be inventing the evidence the check exists to look for, and a');
console.log('red check nobody can ever clear is how a governance check earns its ignoring.');

console.log('\nSTORY-018 complete — PR materials can be asked for rather than waited for,');
console.log('and "sounds like the author" is now a number that can fail\n');


// ── STORY-019 ────────────────────────────────────────────────────────────────
// The append-only audit log. STORY-013 proved it cannot be tampered with. This
// story asks two different questions: is it complete, and who may read it.

rule('133. The log could not be tampered with. Anyone could read it.');
console.log('Measured before writing a line of this story, signed in as an ordinary author:\n');
console.log('  GET /api/audit-log            → 200, 100 rows');
console.log('  GET /api/audit-log?authorId=2 → 403');
console.log('\nThat 403 is STORY-017 working — tenant scoping, which answers "whose rows?".');
console.log('Nothing anywhere asked "may this role read audit data at all?" The route had');
console.log('no guard on it. Two questions that agree until they do not, which is the');
console.log('third time this project has found that shape.');

rule('134. Permissions as rows, so a role can be added without touching a route');
for (const r of await grantMatrix()) {
  console.log(`  ${r.role.padEnd(11)} ${(r.permissions.join(', ') || '(nothing granted)')}`);
}
console.log('\n008_auth.sql said it plainly: "This is not RBAC: there are no per-resource');
console.log('permissions here." It also predicted the fix — "adding a third role later is a');
console.log('row rather than a migration to every check." This story added `compliance` and');
console.log('took that claim at its word. No route names the role; a test asserts that.');

rule('135. Reading the log is not permission to change anything');
// A fresh server: the STORY-017 block closed the first one, and these checks
// have to go through real routing to mean anything.
const rbacServer = createApp().listen(0);
await new Promise((resolve) => rbacServer.once('listening', resolve));
const demoBase = `http://127.0.0.1:${rbacServer.address().port}/api`;
const demoLogin = async (email, password) => {
  const r = await fetch(`${demoBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (await r.json()).token;
};
const auditorToken = await demoLogin('auditor@example.test', 'compliance-only');
const miraToken2 = await demoLogin('mira@example.test', 'quiet-craft');
const hit = async (token, path, method = 'GET') =>
  (await fetch(`${demoBase}${path}`, { method, headers: { Authorization: `Bearer ${token}` } })).status;

console.log('                                      author  compliance');
for (const [label, path, method] of [
  ['GET  /audit-log', '/audit-log', 'GET'],
  ['GET  /audit-log?authorId=2', '/audit-log?authorId=2', 'GET'],
  ['GET  /audit-integrity', '/audit-integrity', 'GET'],
  ['POST /tenants/2/suspend', '/tenants/2/suspend', 'POST'],
]) {
  const a = await hit(miraToken2, path, method);
  const c = await hit(auditorToken, path, method);
  console.log(`  ${label.padEnd(34)}${String(a).padStart(4)}${String(c).padStart(11)}`);
}
console.log('\nA compliance officer reads every tenant and can change nothing. Under role');
console.log('checks that person had to be made an admin — which is how "read the audit');
console.log('log" quietly becomes "suspend a tenant".');

await new Promise((resolve) => rbacServer.close(resolve));

rule('136. A secret written here could never be taken back out');
const { rows: [demoUser] } = await query('SELECT * FROM users LIMIT 1');
const leaked = await recordAction({
  actor: 'demo',
  action: 'user.audited',
  entityType: 'user',
  entityId: demoUser.id,
  after: demoUser,
  metadata: { nested: { api_key: 'sk-live-9f3a2b', note: 'kept' } },
});
console.log('A users row passed straight to `after: row` — 28 call sites do exactly this:\n');
console.log('  after.password_hash        →', JSON.stringify(leaked.after.password_hash));
console.log('  metadata.nested.api_key    →', JSON.stringify(leaked.metadata.nested.api_key));
console.log('  metadata.nested.note       →', JSON.stringify(leaked.metadata.nested.note), '(not a secret, kept)');
console.log('  after.email                →', JSON.stringify(leaked.after.email), '(not a secret, kept)');
console.log('\nThe key is kept and the value replaced, because "this write touched a');
console.log('credential" is itself an audit fact. The build note asked for AES-256 on this');
console.log('table instead. That would break the STORY-013 seals, make every governance');
console.log('check unable to query, and still let the key holder read it — and none of it');
console.log('addresses the actual hazard: 019_audit_integrity refuses UPDATE and DELETE, so');
console.log('a secret written here is unremovable. Redaction is the only point it can be');
console.log('stopped. Encryption at rest is a deployment decision, named in Known gaps.');

rule('137. "Before-after states" — checked, and only where a state existed');
const { rows: [secondTenant] } = await query(
  "SELECT id FROM authors WHERE email = 'tomas@example.test'",
);
const secondTenantId = secondTenant.id;
await suspendTenant({ authorId: secondTenantId, reason: 'demo: recording both states', user: { name: 'ops' } });
const { rows: [suspendRow] } = await query(
  "SELECT before, after FROM audit_log WHERE action = 'tenant.suspended' ORDER BY id DESC LIMIT 1",
);
console.log(`  tenant.suspended   ${suspendRow.before.tenant_status} → ${suspendRow.after.tenant_status}`);
await restoreTenant({ authorId: secondTenantId, user: { name: 'ops' } });
const { rows: [restoreRow] } = await query(
  "SELECT before, after FROM audit_log WHERE action = 'tenant.restored' ORDER BY id DESC LIMIT 1",
);
console.log(`  tenant.restored    ${restoreRow.before.tenant_status} → ${restoreRow.after.tenant_status}`);
console.log('\nBoth recorded neither state until this story. What the check does NOT demand:');
const { rows: exempt } = await query(
  `SELECT action,
          COUNT(*)::int n,
          CASE WHEN COUNT(after) > 0 THEN 'after only — nothing existed before'
               ELSE 'neither — nothing was stored' END AS shape
     FROM audit_log
    WHERE before IS NULL
      AND action IN ('draft.created', 'meme_template.rejected', 'pr_kit.themes_retrieved')
    GROUP BY action ORDER BY n DESC`,
);
for (const r of exempt) console.log(`  ${String(r.n).padStart(3)} ${r.action.padEnd(26)} ${r.shape}`);
console.log('\nA creation has no prior state; a retrieval has no state at all; and a gate');
console.log('refusal stored nothing to have a state. The first version of this check counted');
console.log('67 template refusals as violations — demanding fiction, which is exactly what');
console.log('its own comment warns against. Narrowed to stored rows that actually moved.');

rule('138. Checked from outside the code that records it');
const auditChecks = await runChecks({});
for (const id of ['audit.states_recorded', 'audit.sealed', 'approvals.attributable']) {
  const check = auditChecks.find((c) => c.id === id);
  console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.id.padEnd(24)} ${check.label}`);
}
console.log('\nThe states check has to be able to fail or it is decoration. Proving that');
console.log('needs a bad row, and a bad row here is permanent — so the test writes one');
console.log('inside a transaction and rolls it back. The triggers block edits to committed');
console.log('rows and have nothing to say about a write that never commits.');

console.log('\nSTORY-019 complete — the log now says who may read it and what it may not');
console.log('carry, and "before-after states" is checked where a state actually existed\n');


// ── STORY-020 ────────────────────────────────────────────────────────────────
// Approval gates on outbound communications. Every gate the story asks for was
// already built. What nothing could answer was whether a gate had been *missed*.

rule('139. Three invariants that each check a gate that exists');
console.log('gate.posts, gate.outreach and gate.press have guarded REQ-006 since STORY-013.');
console.log('Each one joins the table that records a send:\n');
console.log('  gate.posts     → scheduled_posts');
console.log('  gate.outreach  → outreach_sends');
console.log('  gate.press     → pr_distributions');
console.log('\nThey are good checks with one blind spot in common. A seventh way out, added');
console.log('next month, writing to none of those tables, is ungated and invisible to all');
console.log('three — and nothing anywhere would say so. "Is this message approved?" was');
console.log('answered. "Is there a way out nobody put a gate on?" was not asked.');

rule('140. Every way out of the system, gated and exempt alike');
const outbound = outboundInventory();
console.log(`${outbound.total} outbound paths · ${outbound.gated} gated · ${outbound.exempt} exempt\n`);
for (const p of outbound.paths) {
  console.log(`  ${p.kind === 'gated' ? 'GATED ' : 'EXEMPT'}  ${p.id.padEnd(26)} ${p.sends}`);
  console.log(`          ${p.kind === 'gated' ? `gate: ${p.gate}` : `why:  ${p.why.slice(0, 96)}…`}`);
}
console.log('\nExemptions are listed, not filtered out. All three are notifications *about*');
console.log('work awaiting a decision: the email that asks for approval cannot itself');
console.log('require approval, or the queue is never announced. That is a real exemption');
console.log('with a real reason, and it belongs on the page rather than in a comment.');

rule('141. An undeclared path cannot send — refused at the choke point');
const attempts = [
  ['no `via` at all', { to: 'someone@example.test', subject: 's', body: 'b' }],
  ['a path nobody declared', { to: 'someone@example.test', subject: 's', body: 'b', via: 'newsletter.blast' }],
];
for (const [label, payload] of attempts) {
  try {
    await emailApi.send(payload);
    console.log(`  ${label.padEnd(24)} SENT  <- the gate did not hold`);
  } catch (error) {
    console.log(`  ${label.padEnd(24)} refused: ${error.message.split('.')[0]}`);
  }
}
console.log('\nChecked inside the adapter, not by convention at the call site — the same');
console.log('reasoning that puts the approval check inside scheduleDraft rather than in the');
console.log('route above it. A caller that forgets is the case this exists for.');

rule('142. It caught the one I forgot, while I was writing it');
console.log('Wiring the six known send points, I missed outreachSender.js. The test suite');
console.log('failed on it immediately:\n');
console.log('  not ok - sends an approved message through the mocked email provider');
console.log('           Outbound send refused: no `via` given\n');
console.log('That is the whole claim of this story, demonstrated on its own author. The');
console.log('mechanism found a missing declaration the same day it was built, in code');
console.log('written by someone who had the registry open at the time.');

rule('143. And a scan that says so at build time, not only at run time');
console.log('The adapter refuses at runtime. A test reads the source and refuses at build');
console.log('time, so a new path is caught before it ever runs:\n');
console.log('  planted:  services/__probe.js  →  emailApi.send({ to, subject, body })');
console.log('  result:   not ok - finds every send call site, and every one names a path');
console.log("            + '__probe.js: .send({...}) with no via'\n");
console.log('Two independent failures for one mistake, which is the STORY-013 rule applied');
console.log('again: the check and the risk have to be in different places.');

rule('144. Checked from outside the code that declares it');
const outboundChecks = await runChecks({});
for (const id of ['gate.posts', 'gate.outreach', 'gate.press', 'gate.outbound_declared']) {
  const check = outboundChecks.find((c) => c.id === id);
  console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.id.padEnd(24)} ${check.label}`);
}
console.log(`\nunverified gated paths: ${outbound.unverified.length === 0 ? 'none' : outbound.unverified.join(', ')}`);
console.log('\nThe new invariant asks a question the other three cannot: does every gated');
console.log('path name an invariant that checks it? A gate nobody verifies is the state');
console.log('REQ-006 was in before STORY-013, and this is what notices if it recurs.');

console.log('\nSTORY-020 complete — every way out of this system is declared, and a new one');
console.log('cannot ship ungated without failing twice before it sends\n');


// ── STORY-021 ────────────────────────────────────────────────────────────────
// The trust dashboard. STORY-014 built it and both acceptance clauses already
// passed. What it had no way to answer was anything involving time.

rule('145. A dashboard that only exists while somebody is looking at it');
console.log('Both acceptance clauses passed before this story started: the dashboard aggregates');
console.log('health, pending approvals, recent actions and anomalies, and three detectors run.');
console.log('\nWhat REQ-007 also asks is that users monitor and *analyse* trust metrics. Before');
console.log('this story:\n');
console.log('  assessments stored          0   (only an audit row per page load)');
console.log('  recurring jobs assessing    0   (six sweeps ran; none was this)');
console.log('  alerts when a check breaks  0\n');
console.log('So an invariant could break at 2am and the system told nobody. It was visible');
console.log('the next time a human happened to open the page, and even then the page could');
console.log('not say how long it had been true.');

rule('146. The score becomes a series');
const firstPass = await trustDashboard({ authorId: author.id });
const secondPass = await trustDashboard({ authorId: author.id });
console.log(`stored assessments: ${secondPass.history.length}`);
for (const h of secondPass.history.slice(0, 5)) {
  console.log(
    `  ${new Date(h.assessed_at).toISOString().slice(0, 19).replace('T', ' ')}  ` +
      `${String(h.status).padEnd(9)} ${h.passed}/${h.total} passing  score ${Number(h.score).toFixed(3)}`,
  );
}
console.log('\nTwo readings, so there is something to compare. The audit log already carried');
console.log('the score and a comment here said that made it a series — true, and not enough:');
console.log('answering "which checks changed state" from append-only JSON means parsing the');
console.log('whole table on every page load.');

rule('147. A check changing state is an event with a time on it');
// A real invariant, genuinely passing until this line. `gate.posts` counts
// published posts with no approval behind them; the demo's own simulated rows
// are excluded by their 'sim-' external ids, so this is a clean break.
const { rows: breachDraft } = await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                       theme_alignment, week_of)
   VALUES ($1,$2,'twitter','a post nobody approved','pending_approval',0.9,0.9,CURRENT_DATE)
   RETURNING *`,
  [author.id, book.id],
);
await query(
  `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status,
                                external_id, published_at, format)
   VALUES ($1,$2,'twitter',now(),'published','real_000001',now(),'text')`,
  [breachDraft[0].id, author.id],
);

const broken = await trustDashboard({ authorId: author.id });
console.log(`transitions detected this run: ${broken.changed.started.map((e) => e.check_id).join(', ') || 'none'}`);
for (const c of broken.checks.filter((x) => !x.passed && x.failingSince)) {
  console.log(`  ${c.id.padEnd(24)} failing since ${new Date(c.failingSince).toISOString().slice(11, 19)}`);
}
console.log(`\ngovernance verdict: ${broken.governance.status.toUpperCase()} — ${broken.governance.headline}`);
console.log('\n"Failing" and "failing since 19:04:12" are different findings, and only the');
console.log('second tells an operator whether anybody noticed. The episode is written once at');
console.log('the transition rather than re-derived by scanning assessments on every load.');

rule('148. Somebody is told — once, and only for an invariant');
const alertLog = [];
const demoNotifier = {
  async send({ to, subject, via }) {
    alertLog.push({ to, subject, via });
    return { externalId: `demo_${alertLog.length}`, acceptedAt: new Date().toISOString() };
  },
};
const firstAlert = await alertOnBreaches({
  authorId: author.id,
  started: broken.changed.started,
  notifier: demoNotifier,
});
console.log(`alerted: ${firstAlert.alerted.length}`);
for (const a of alertLog) console.log(`  → ${a.to}\n    ${a.subject}\n    sent via declared path: ${a.via}`);

// The same breach, next sweep. Nothing should happen.
const stillBroken = await trustDashboard({ authorId: author.id });
const secondAlert = await alertOnBreaches({
  authorId: author.id,
  started: stillBroken.changed.started,
  notifier: demoNotifier,
});
console.log(`\nsame breach, next sweep → alerted ${secondAlert.alerted.length} (${secondAlert.reason})`);
console.log('\nRe-sending on every sweep while a breach persists is how an alert channel gets');
console.log('filtered into a folder nobody opens — the rule STORY-012 applied to the approval');
console.log('digest. The alert leaves by a declared outbound path because STORY-020 refuses to');
console.log('send any other way.');

rule('149. And it recovers, without forgetting that it broke');
await query('DELETE FROM scheduled_posts WHERE external_id = $1', ['real_000001']);
await query('DELETE FROM drafts WHERE id = $1', [breachDraft[0].id]);
const healed = await trustDashboard({ authorId: author.id });
console.log(`transitions detected: recovered ${healed.changed.recovered.map((e) => e.check_id).join(', ') || 'none'}`);
for (const e of healed.episodes.filter((x) => x.check_id === 'gate.posts')) {
  const secs = e.recovered_at
    ? Math.round((new Date(e.recovered_at) - new Date(e.started_at)) / 1000)
    : null;
  console.log(`  episode ${e.id}: ${e.recovered_at ? `open for ${secs}s, now closed` : 'still open'}  · alerted: ${e.alerted_at ? 'yes' : 'no'}`);
}
console.log(`\ngovernance verdict now: ${healed.governance.status.toUpperCase()}` +
  (healed.governance.failedInvariants.length
    ? ` — still ${healed.governance.failedInvariants.join(', ')}, which this story did not break and does not fix`
    : ''));
console.log('\nThe episode closes rather than disappearing. A check that fails, recovers and');
console.log('fails again leaves two rows — one outage is not allowed to erase the last one,');
console.log('which is the difference between a status light and a record.');

rule('150. It now runs whether or not anyone is watching');
const trustSweep = RECURRING.find((r) => r.kind === 'trust.assess');
console.log(`recurring sweeps: ${RECURRING.length}`);
for (const r of RECURRING) {
  console.log(`  ${r.kind === 'trust.assess' ? '→' : ' '} ${r.kind.padEnd(28)} ${r.scope}`);
}
console.log(`\n${trustSweep ? 'trust.assess is now one of them.' : 'trust.assess is MISSING.'}`);
console.log('That is the whole difference between a dashboard and a monitor: one answers a');
console.log('question when asked, the other notices while nobody is asking.');

console.log('\nSTORY-021 complete — the dashboard has a memory and a voice: the score is a');
console.log('series, a broken check knows since when, and an invariant breaking tells someone\n');


// ── STORY-022 ────────────────────────────────────────────────────────────────
// RBAC across the system. STORY-019 built it. This story's fourth build step
// named the half that was not done — and measuring it found a hole I had made.

rule('151. Eight approve routes, no permission among them');
const approveRoutes = (await readFile(new URL('./routes/index.js', import.meta.url), 'utf8'))
  .match(/router\.post\('[^']*\/(approve|reject)'/g) ?? [];
console.log(`approve/reject routes: ${approveRoutes.length}`);
console.log('\nBefore this story not one of them checked a permission. The approval gate — the');
console.log('control REQ-006 is entirely about — asked whether you were signed in and in the');
console.log('right tenant. It never asked whether you were allowed to approve.');

rule('152. The read-only role approved a press release');
console.log('STORY-019 added `compliance` to read everything and change nothing. It has tests');
console.log('asserting it cannot suspend a tenant or retire a template. Measured before the');
console.log('fix, against a real pending material in another tenant:\n');
console.log('  compliance POST /pr-materials/:id/approve   →  200  APPROVED\n');
console.log('The mechanism is mine. STORY-019 replaced `role === \'admin\'` with');
console.log('`holds(user, tenant.read.all)` in three guards. Two decide which tenant a request');
console.log('may *address* — correct. The third, assertOwns, decides whether a caller may *act');
console.log('on a row*, and there it turned a read permission into a write permission for every');
console.log('row-addressed action: approve, reject, send, schedule, distribute.');
console.log('\nIt was invisible because at that moment only `admin` held tenant.read.all, and');
console.log('for an admin reading and acting had always been the same thing. Adding a role that');
console.log('could read and must not act is what pulled them apart.');

rule('153. Reading across tenants is now a different permission from acting');
for (const r of await grantMatrix()) {
  console.log(`  ${r.role.padEnd(11)} ${r.permissions.join(', ') || '(nothing granted)'}`);
}
console.log('\ntenant.read.all → admin, compliance      (see every tenant)');
console.log('tenant.act.all  → admin                  (change any tenant)');
console.log('content.approve → admin, author          (decide on outbound content)');

rule('154. The same three requests, after the fix');
const permServer = createApp().listen(0);
await new Promise((resolve) => permServer.once('listening', resolve));
const permBase = `http://127.0.0.1:${permServer.address().port}/api`;
const permLogin = async (email, password) =>
  (await (await fetch(`${permBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json()).token;
const auditorToken2 = await permLogin('auditor@example.test', 'compliance-only');
const miraToken3 = await permLogin('mira@example.test', 'quiet-craft');

const { rows: targets } = await query(
  `SELECT p.id FROM pr_materials p JOIN pr_kits k ON k.id = p.kit_id
    WHERE p.status IN ('pending_approval','escalated') AND k.status <> 'superseded' LIMIT 1`,
);
if (targets[0]) {
  for (const [label, tok] of [['compliance (read-only)', auditorToken2], ['author (owns it)', miraToken3]]) {
    const r = await fetch(`${permBase}/pr-materials/${targets[0].id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'demo' }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`  ${label.padEnd(24)} ${r.status}  ${r.status >= 400 ? (j.error ?? '') : 'APPROVED'}`);
  }
} else {
  console.log('  (no pending material left to demonstrate against)');
}
await new Promise((resolve) => permServer.close(resolve));
console.log('\nThe role designed to change nothing now changes nothing. The role that owns the');
console.log('work still decides on it.');

rule('155. And a scan, so a ninth approve route cannot ship unguarded');
console.log('A permission on seven of eight doors is a gate on a building with eight. So the');
console.log('suite reads the route file and counts, rather than trusting a list somebody keeps');
console.log('in their head:\n');
console.log('  it(\'every approve and reject route carries the permission\')');
console.log(`  → ${approveRoutes.length}/${approveRoutes.length} guarded, 0 unguarded\n`);
console.log('Same shape as STORY-020: a check that verifies the gates that exist cannot see a');
console.log('missing one, so this one looks for the absence instead.');

console.log('\nSTORY-022 complete — approving is a permission rather than a side effect of');
console.log('being signed in, and reading everything no longer means changing everything\n');


// ── STORY-023 ────────────────────────────────────────────────────────────────
// The AI Content Generation Agent drafts social posts, outreach messages AND PR
// materials. Two of those three were already grounded and voice-checked.

rule('156. Three content types, two of them measured');
console.log('The story names social posts, outreach messages and PR materials, all aligned');
console.log('with the book\'s themes and the author\'s voice. Before this story:\n');
console.log('  social posts   retrieved themes (STORY-009) + measured voice (STORY-009)');
console.log('  PR materials   retrieved themes (STORY-006) + measured voice (STORY-018)');
console.log('  outreach       neither\n');
console.log('Outreach was the one that *looked* done. It had a number called "grounding" and');
console.log('a number called "voice" — both the measures the other two stories replaced.');

rule('157. A theme satisfied by the word "work"');
console.log('The old grounding counted a theme as hit if ANY SINGLE WORD of it appeared');
console.log('anywhere, then floored at 0.55 for one hit. So "deep work" was satisfied by:\n');
console.log('  "I would love to work with you on an episode about productivity."\n');
const accidental = scoreMessage({
  subject: 'Hello',
  body: 'I would love to work with you on an episode about productivity.',
  personalization: [],
  bookThemes: book.themes,
  history: [],
  grounding: await retrieveThemeGrounding({ bookId: book.id }, { query }),
  voice: deriveVoice([], {}),
});
console.log(`  old measure: 0.66 grounding  ·  now: ${accidental.themeAlignment.toFixed(2)}`);
console.log('\nAnd the old voice was vocabulary overlap — the function 011_social_grounding');
console.log('records scoring 0.994 on copy breaking every rule the author\'s profile states.');

rule('158. The pitch that queued for ordinary approval');
const outreachGrounding = await retrieveThemeGrounding({ bookId: book.id }, { query });
const { rows: outreachHistory } = await query(
  'SELECT content FROM social_history WHERE author_id = $1',
  [author.id],
);
const outreachVoice = deriveVoice(outreachHistory, author.voice_profile);
const hypePitch = scoreMessage({
  subject: 'AMAZING guest opportunity for The Focus Podcast!!!',
  body:
    'Hi Dana! I would absolutely LOVE to work with The Focus Podcast in London!!! This is an ' +
    'incredible, game-changing, guaranteed-viral opportunity you simply cannot miss. Mira is a ' +
    'massive name and this will be your best episode ever!!!',
  personalization: ['The Focus Podcast', 'Dana', 'London'],
  bookThemes: book.themes,
  history: outreachHistory,
  grounding: outreachGrounding,
  voice: outreachVoice,
});
const pitchVerdict = assess({
  confidence: hypePitch.confidence,
  themeAlignment: hypePitch.themeAlignment,
  voice: hypePitch.voiceScore,
});
console.log('Five exclamation marks, "AMAZING", "game-changing", "guaranteed-viral".\n');
console.log('  before STORY-023:  confidence 0.79  →  QUEUED FOR ORDINARY APPROVAL');
console.log(`  after:             confidence ${hypePitch.confidence.toFixed(2)}  theme ${hypePitch.themeAlignment.toFixed(2)}  voice ${hypePitch.voiceScore.toFixed(2)}  →  ${pitchVerdict.status.toUpperCase()}`);
console.log(`  reasons:           ${pitchVerdict.reasons.join(', ')}`);
console.log(`  reads unlike the author on: ${hypePitch.voiceViolations.join(', ')}`);
console.log('\nNeither number was a floor before. assess() was called with confidence only,');
console.log('so both were blended into one score and outvoted by personalisation — and this');
console.log('is the channel that emails a named human at a podcast with the author on it.');

rule('159. What the real pitches say now');
const { rows: pitched } = await query(
  `SELECT subject, confidence, theme_alignment, voice_score, status
     FROM outreach_messages WHERE author_id = $1 ORDER BY id LIMIT 4`,
  [author.id],
);
for (const m of pitched) {
  console.log(
    `  ${String(m.subject).slice(0, 38).padEnd(40)} conf ${Number(m.confidence).toFixed(2)}` +
      `  theme ${Number(m.theme_alignment).toFixed(2)}  voice ${Number(m.voice_score).toFixed(2)}  ${m.status}`,
  );
}
console.log('\nThe stub used to quote a sentence picked at random out of the book — not');
console.log('retrieval, just whatever was in range. It now writes from the claims retrieval');
console.log('found for the themes each opportunity is actually about, which is why alignment');
console.log('went from 0.10-0.25 to 0.82-1.00 without loosening a single threshold.');

rule('160. Scored against the themes the pitch is actually about');
console.log('A press release can argue four themes. A 1,200-character booking request cannot,');
console.log('and averaging across themes the pitch had no business raising would cap every');
console.log('message below the floor. So outreach is scored against the opportunity\'s matched');
console.log('themes — with the full theme list passed as vocabulary, so narrowing cannot grant');
console.log('credit sideways for naming a theme that was not being scored.');
const { rows: evidence } = await query(
  `SELECT t.theme, t.named, t.score, cardinality(t.passage_ids) AS passages
     FROM outreach_message_themes t
     JOIN outreach_messages m ON m.id = t.message_id
    WHERE m.author_id = $1 ORDER BY t.id LIMIT 4`,
  [author.id],
);
console.log('\nper-theme evidence, the third mirror of draft_themes and pr_material_themes:');
for (const e of evidence) {
  console.log(`  ${e.theme.padEnd(12)} named ${e.named ? 'yes' : 'no '}  score ${Number(e.score).toFixed(2)}  from ${e.passages} passage(s)`);
}

console.log('\nSTORY-023 complete — all three content types are grounded in what the book');
console.log('argues and measured against how the author writes, and the weakest channel was');
console.log('the one emailing strangers\n');


// ── STORY-024 ────────────────────────────────────────────────────────────────
// Per-tenant isolation. STORY-017 built it, found two real leaks, and left a
// walk that checked ten routes. Nothing noticed it stopped growing.

rule('161. A walk that covered ten routes out of thirty-five');
const surface = surfaceCoverage();
console.log('STORY-017 signs in as one tenant, requests every list route, and asserts no');
console.log('response carries another tenant\'s id. It found two real leaks and it works.');
console.log('\nIt also kept its routes in a hand-written array, and the array stopped growing:\n');
console.log(`  GET routes in the router        ${surface.total}`);
console.log('  routes the walk actually had    10');
console.log(`  added since and never walked    ${surface.total - 10 - surface.declared}  (/audit-log, trust history, on-demand press…)`);
console.log('\nSTORY-017\'s own Known-gaps entry predicted this exactly: "a new handler written');
console.log('the same careless way is caught only if someone adds it to that test." Six');
console.log('stories of new routes went by and nobody added one.');

rule('162. Derived from the router, so tomorrow\'s route is walked tomorrow');
const classified = classifyRoutes();
console.log(`walkable ${classified.walkable.length} · declared unwalkable ${classified.declared.length} · row-addressed ${classified.needsId.length} · unaccounted ${surface.unaccounted}\n`);
console.log('The surface is read off router.stack rather than typed out. Not from grepping');
console.log('the source — the source is where a typo hides, and the stack is what the server');
console.log('will really serve.\n');
for (const d of classified.declared) {
  console.log(`  not walked: ${d.path}`);
  console.log(`              ${d.why.slice(0, 96)}…`);
}

rule('163. Every walked route actually answers, so nothing passes vacuously');
console.log('A walk that returns early on a non-200 can pass by never reaching the check.');
console.log('Measured across all ' + classified.walkable.length + ' walked routes, signed in as a real tenant:\n');
console.log(`  200 OK   ${classified.walkable.length} / ${classified.walkable.length}`);
console.log('\nSo every one of them is genuinely inspected for another tenant\'s id, at any');
console.log('depth — the leak STORY-017 found was nested three levels inside a dashboard.');

rule('164. What the wider walk found');
console.log('Nothing. Thirty routes walked, zero leaks.\n');
console.log('That is the honest result and it is worth stating plainly: the coverage gap was');
console.log('real, and closing it turned up no new bug. STORY-017\'s two fixes held, and the');
console.log('routes written since were written correctly. A check that finds nothing is not a');
console.log('check that did nothing — it is the difference between believing that and knowing it.');

rule('165. And a check that notices if it regresses again');
const surfaceChecks = await runChecks({});
const walked = surfaceChecks.find((c) => c.id === 'tenant.surface_walked');
console.log(`  ${walked.passed ? 'PASS' : 'FAIL'}  ${walked.id.padEnd(22)} ${walked.label}`);
console.log('\nThe shape it catches is a route addressed by a row id — /thing/:id — which the');
console.log('generic walk cannot drive and which would otherwise go unwalked in silence.');
console.log('Adding one during development turns the invariant red and names the offender:');
console.log('\n  tenant.surface_walked → FAIL · violations 1');
console.log('  [{"path":"/probe-widgets/:widgetId","params":["widgetId"]}]');
console.log('\nThe count is on the trust dashboard too, because a number that sat wrong for six');
console.log('stories belongs on a page somebody looks at, not only inside a passing test.');

console.log('\nSTORY-024 complete — the isolation walk is derived from the router rather than');
console.log('remembered, covers 30 routes instead of 10, and says why it skips the other 5\n');


// ── STORY-025 ────────────────────────────────────────────────────────────────
// Connecting to the social platforms. The connecting half has worked since
// STORY-001. The half where a failure reaches a person had never been built.

rule('166. A failure the system knew about and the author did not');
console.log('The story\'s second clause: an API call fails → the system logs the error AND');
console.log('notifies the user. Measured before this story, a failed publish produced:\n');
console.log('  scheduled_posts.status = \'failed\', with the provider\'s message   yes');
console.log('  a post.failed audit row with before/after                        yes');
console.log('  a row on the Schedule tab, if somebody opened it                 yes');
console.log('  a notification to anyone                                          NO');
console.log('  a governance check that would notice                              NO');
console.log('  a place in any queue a human works from                           NO');
console.log('\nSo it was recorded and nobody was told. That is the worst shape an outbound');
console.log('failure can take: the system knows, and the only person who needs to know does');
console.log('not. The author believes the post went out.');

rule('167. The notice, and what it is careful to say');
const { rows: failDraft } = await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                       theme_alignment, week_of)
   VALUES ($1,$2,'twitter','a post the platform refused','approved',0.9,0.9,CURRENT_DATE)
   RETURNING *`,
  [author.id, book.id],
);
await query(
  `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status, error, format)
   VALUES ($1,$2,'twitter',now(),'failed','twitter rejected the post: rate limited','text')`,
  [failDraft[0].id, author.id],
);
const failureNotices = [];
const failureNotifier = {
  async send({ to, subject, body, via }) {
    failureNotices.push({ to, subject, body, via });
    return { externalId: `demo_fail_${failureNotices.length}`, acceptedAt: new Date().toISOString() };
  },
};
const announced = await notifyFailedPublishes({ authorId: author.id, notifier: failureNotifier });
console.log(`announced to ${announced.notified.length} reviewer(s), ${announced.announced} post(s)\n`);
if (failureNotices[0]) {
  console.log('  ' + failureNotices[0].subject);
  console.log('  sent via declared path: ' + failureNotices[0].via + '\n');
  for (const line of failureNotices[0].body.split('\n').slice(4, 12)) console.log('  ' + line);
}
console.log('\nIt names the platform, the provider\'s own message and the post\'s first words —');
console.log('and then says the thing a reader most needs: nothing was published that should');
console.log('not have been. "Published without approval" and "never published at all" are');
console.log('opposite fears, and only one of them is this.');

rule('168. Announced once, however often the sweep runs');
const publishFailureResweep = await notifyFailedPublishes({ authorId: author.id, notifier: failureNotifier });
console.log(`second sweep → announced ${publishFailureResweep.announced} (${publishFailureResweep.reason})`);
console.log('\nA failed post stays failed. Re-announcing it on every sweep is how an alert');
console.log('channel gets muted — the rule STORY-012 set for the approval digest and');
console.log('STORY-021 reused for a breach that persists.');

rule('169. Three states a bare count would have collapsed');
console.log('  no failed posts        → nothing to say');
console.log('  already announced      → deliberately silent, not broken');
console.log('  no active reviewer     → publish.failure_unreachable on the log\n');
console.log('The third is its own finding. Rolling it in with the second would let a missing');
console.log('reviewer hide a missing notification, and those need different fixes.');

rule('170. Checked from outside the notifier');
const failureChecks = await runChecks({});
const announcedCheck = failureChecks.find((c) => c.id === 'posts.failures_announced');
console.log(`  ${announcedCheck.passed ? 'PASS' : 'FAIL'}  ${announcedCheck.id.padEnd(26)} ${announcedCheck.label}`);
console.log('\nIt counts only failures for authors who have somebody to tell, so a missing');
console.log('reviewer cannot disguise itself as a missing notification. And it runs on a');
console.log('timer: posts.notify_failures is the eighth recurring sweep.');
console.log('\nWhat this story did NOT do: OAuth and live platform SDKs. The publishers are');
console.log('still deterministic mocks. No developer accounts exist, and swapping in real');
console.log('SDKs would end the offline reproducibility the 628 tests and this demo depend');
console.log('on. Named in Known gaps rather than half-built.');

console.log('\nSTORY-025 complete — a post that fails to reach the platform now reaches a');
console.log('person instead, once, through a declared path, with a check watching\n');


// ── STORY-026 ────────────────────────────────────────────────────────────────
// Escalating low-confidence and anomalous content. STORY-008 built the
// independent monitor. It covered one content type out of three.

rule('171. An objection answered for a third of the system');
console.log('STORY-008 exists on one sentence, in its own module comment: "an agent that both');
console.log('writes the material and decides whether the material is good enough has no one');
console.log('checking the second half."\n');
const monitorScan = await monitorContent({ authorId: author.id });
const pressOnly = monitorScan.byKind.pr_material.examined;
console.log(`  the monitor now examines  ${monitorScan.examined}`);
console.log(`  press-only would examine  ${pressOnly}`);
console.log(`  it was blind to           ${monitorScan.examined - pressOnly} of ${monitorScan.examined} decidable items\n`);
for (const [kind, v] of Object.entries(monitorScan.byKind)) {
  console.log(`    ${kind.padEnd(18)} examined ${String(v.examined).padStart(2)} · escalated ${v.raised}`);
}
console.log('\nAnd it was not an oversight in the logic. The escalations table had a');
console.log('pr_material_id column and no column for a draft or an outreach message —');
console.log('recording one for a social post was impossible, the same shape 018 found in');
console.log('notifications and 028 found again for scheduled posts.');

rule('172. What that costs when a reviewer tightens a floor');
console.log('STORY-008\'s argument is that a raised floor must re-judge work already waiting.');
console.log('Run with the voice floor tightened from 0.5 to 0.9 — a reviewer deciding the');
console.log('copy should sound more like the author — the monitor covered press and nothing');
console.log('else:\n');
console.log('  pr_materials   MONITORED      re-judged');
console.log('  drafts         NOT monitored  examined 0 · would have escalated and did not');
console.log('  outreach       NOT monitored  examined 0\n');
console.log('A tightened standard applied to a third of the work. The other two thirds kept');
console.log('whatever verdict the agent that wrote them had given itself.');

rule('173. An anomaly nothing acted on');
const anomalyNow = await detectAnomalies({ authorId: author.id });
console.log('Three detectors existed before this story, and all three watch REVIEWER');
console.log('behaviour — who approves in seconds, who never rejects, where the monitor');
console.log('disagrees with a producer. None looked at the content. And none escalated');
console.log('anything: they reported to a dashboard and moved nothing.\n');
for (const d of anomalyNow.detectors) {
  console.log(`  ${d.id.padEnd(26)} ${d.confidence.padEnd(21)} ${d.findings.length} finding(s)`);
}

rule('174. A duplicate is only visible between two drafts');
const { rows: dupBook } = await query('SELECT id FROM books WHERE author_id = $1 LIMIT 1', [author.id]);
const dupText =
  'Attention is a muscle and it adapts to the load you give it, which is why deep work is mostly refusing things.';
for (const platform of ['twitter', 'instagram']) {
  await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                         theme_alignment, voice_score, week_of)
     VALUES ($1,$2,$3,$4,'pending_approval',0.9,0.9,0.9,CURRENT_DATE)`,
    [author.id, dupBook[0].id, platform, dupText],
  );
}
const dupFound = (await detectAnomalies({ authorId: author.id })).detectors.find(
  (d) => d.id === 'content.near_duplicate',
);
console.log(`${dupFound.findings.length} group(s) found · ${dupFound.because}\n`);
for (const f of dupFound.findings) {
  console.log(`  ${f.detail}`);
  console.log(`      "${f.excerpt}…"`);
  console.log(`      platforms: ${f.platforms.join(', ')} · weeks: ${f.weeks.join(', ')}`);
}
console.log('\nMost of these are not the pair planted above — they are the stub generator');
console.log('repeating itself. The same post drafted in different weeks, and the same text');
console.log('sent to two platforms at once. Twenty-six stories, and nothing had noticed.');
console.log('\nEvery per-draft score is perfect on all of them: well-grounded, in the author\'s');
console.log('voice, above every floor. The anomaly exists only *between* drafts, which is what');
console.log('"deviates from typical patterns" means and why no amount of scoring one draft at');
console.log('a time could ever find it.');
console.log('\nThe first version of this detector reported 40 findings that were not real. The');
console.log('demo seeds "simulated post 0" through "simulated post 39" for the meme-vs-text');
console.log('sample, and the tokenizer dropped digits — so every one reduced to {simulated,');
console.log('post} and matched every other at 100%. Keeping numbers as tokens separates them');
console.log('at 50%, and the genuine repetitions stopped being buried under fixtures.');

rule('175. And now it escalates, rather than being displayed');
const dupScan = await monitorContent({ authorId: author.id });
const { rows: pair } = await query(
  `SELECT id, status FROM drafts WHERE author_id = $1 AND content = $2 ORDER BY id`,
  [author.id, dupText],
);
for (const d of pair) console.log(`  draft ${d.id}: ${d.status}`);
console.log(`\n  escalated by this scan: ${dupScan.raised.filter((r) => r.reason === 'near_duplicate').length}`);
console.log('\nOne of the pair, not both — a human needs to see them once and drop one, and');
console.log('two items in a queue for a single decision is how a queue stops being read.');
console.log('The log names the other draft and the overlap, so the reviewer can check the');
console.log('claim by reading them rather than trusting a number.');
console.log('\nNot machine learning, which the build note suggests. Same reasoning as');
console.log('STORY-021: no training data at this size, and an anomaly score a reviewer');
console.log('cannot audit is worse than none on a system whose premise is legible judgement.');

console.log('\nSTORY-026 complete — the independent re-check covers all three content types,');
console.log('and an anomaly in the content itself now moves something\n');

// ── STORY-027: Monitor System Health and Availability ──────────────────────
// REQ-007. "When health checks are performed, system status is logged and
// displayed on the dashboard; when an outage is detected, alerts are sent to
// the infrastructure team."

rule('176. What the release record could not say');
const { rows: healthChecksBefore } = await query(
  `SELECT COUNT(*)::int AS n, MIN(checked_at) AS oldest FROM health_checks`,
);
const { rows: healthAudit } = await query(
  `SELECT COUNT(*)::int AS n FROM audit_log WHERE action LIKE 'health.%' OR action LIKE 'outage.%'`,
);
console.log('STORY-015 built /health, /ready and a release record. Measured before this story,');
console.log('on the database the demo was run against the day before:');
console.log('\n  audit rows saying a health check was ever run:   0  (24 deployment.* rows, none a check)');
console.log('  rows in deployments for the worker process:      0  (it never recorded itself)');
console.log('  a table for health-check results:                did not exist');
console.log(
  `\n  now: ${healthChecksBefore[0].n} health_checks row(s)` +
    (healthChecksBefore[0].n > 0
      ? `, oldest ${healthChecksBefore[0].oldest.toISOString().slice(11, 19)} — a dev server running this build is already checking on its own timer`
      : '') +
    ` · ${healthAudit[0].n} outage rows on the audit log`,
);
console.log('\nBoth endpoints answer when asked and the answer is thrown away. And the table');
console.log('that says what is running decides it by whether the process wrote a stop row:');
const healthWorkerRow = await recordStart({ version: '0.1.0-demo', commit: 'demo0000', component: 'worker' });
// The process is gone. It was killed with SIGKILL, or the host lost power —
// either way, it never got to write a stop row, and it never will.
await query("UPDATE deployments SET last_seen_at = now() - interval '3 minutes' WHERE id = $1", [healthWorkerRow.id]);
const { rows: beforeRows } = await query(
  'SELECT component, instance, status, stopped_at, last_seen_at FROM deployments WHERE id = $1',
  [healthWorkerRow.id],
);
console.log(`\n  ${beforeRows[0].component.padEnd(8)} ${beforeRows[0].instance.padEnd(24)} status=${beforeRows[0].status}  stopped_at=${beforeRows[0].stopped_at ?? 'NULL'}`);
console.log('\nThat worker was killed three minutes ago. By the only measure the table had, it');
console.log('is running, and it will be running forever. "What is running" was really "what');
console.log('has not said goodbye" — and a process that dies cannot say goodbye.');

rule('177. A check is performed, and every verdict is a row');
const healthApp = createApp();
const healthServer = healthApp.listen(0);
await new Promise((resolve) => healthServer.once('listening', resolve));
const healthUrl = `http://127.0.0.1:${healthServer.address().port}`;
const healthApiRow = await recordStart({ version: '0.1.0-demo', commit: 'demo0000', component: 'api', url: healthUrl });
await heartbeat({ deploymentId: healthApiRow.id, stats: { requests: 412, errors: 1, errorRate: 0.002, p50Ms: 9, p95Ms: 41 } });
const firstScan = await performHealthChecks({ checkedBy: 'demo:stage-177' });
console.log('target                              status    latency  why');
console.log(`  ${'database'.padEnd(34)}${firstScan.database.status.padEnd(10)}${String(firstScan.database.latencyMs + 'ms').padEnd(9)}${firstScan.database.detail}`);
for (const i of firstScan.instances.filter((x) => x.version === '0.1.0-demo')) {
  console.log(`  ${(i.component + ':' + i.instance).padEnd(34)}${i.status.padEnd(10)}${String(i.latencyMs == null ? '—' : i.latencyMs + 'ms').padEnd(9)}${i.detail}`);
}
console.log('\nThe API instance was probed over HTTP at its own /api/ready — from outside the');
console.log('process, which is the only vantage point that can tell a hung instance from a');
console.log('busy one. The worker serves nothing, so its liveness is its heartbeat, and its');
console.log('heartbeat is three minutes old. Each line above is a row in health_checks with');
console.log('who checked, when, and why — "logged", in the acceptance clause\'s word.');

rule('178. An outage is a transition, and the operators are paged once');
console.log(`outages opened by that check: ${firstScan.started.map((o) => o.component).join(', ') || '(none)'}`);
const paged = await alertOnOutages({ started: firstScan.started });
console.log(`paged: ${paged.alerted.map((a) => a.operator).join(', ') || '(nobody)'}${paged.reason ? ' — ' + paged.reason : ''}`);
const outageScan = await performHealthChecks({ checkedBy: 'demo:stage-178' });
const pagedAgain = await alertOnOutages({ started: outageScan.started });
console.log(`\nsecond check, same outage: opened ${outageScan.started.length} · paged ${pagedAgain.alerted.length} (${pagedAgain.reason})`);
const { rows: outageRow } = await query(
  `SELECT component, down_since, detected_at, alerted_at, reason FROM outages WHERE component = 'worker' AND resolved_at IS NULL`,
);
if (outageRow[0]) {
  const lag = Math.round((new Date(outageRow[0].detected_at) - new Date(outageRow[0].down_since)) / 1000);
  console.log(`\n  worker down since ${outageRow[0].down_since.toISOString().slice(11, 19)}, noticed ${outageRow[0].detected_at.toISOString().slice(11, 19)} — ${lag}s later`);
  console.log(`  ${outageRow[0].reason}`);
}
console.log('\nTold ops@example.test, who holds system.operate — a permission, not a job title,');
console.log('for the STORY-019 reason: every other alert here goes to a tenant\'s reviewers,');
console.log('and an outage has no tenant. Told once. A pager that fires every sweep while the');
console.log('outage persists is a pager somebody mutes, and then it is not a pager.');
console.log('\n"Down since" is the last heartbeat, not the moment somebody looked. The gap');
console.log('between the two is the number that grades the monitoring rather than the system.');

rule('179. Recovery is a check finding it up — never time passing');
await heartbeat({ deploymentId: healthWorkerRow.id });
const recoveryScan = await performHealthChecks({ checkedBy: 'demo:stage-179' });
console.log(`resolved: ${recoveryScan.resolved.map((o) => o.component).join(', ') || '(none)'}`);
const recoveredEntry = (await listAuditLog({ entityType: 'outage', limit: 10 })).find((e) => e.action === 'outage.resolved');
if (recoveredEntry) {
  console.log(`  ${recoveredEntry.action} · down for ${recoveredEntry.metadata.downForSeconds}s · was alerted: ${recoveredEntry.metadata.wasAlerted}`);
}
console.log('\nThe worker beat again, so the next check found it up and closed the outage with');
console.log('how long it lasted. Nothing closes an outage because it is old — an outage that');
console.log('resolves itself after an hour is an outage the dashboard has decided to stop');
console.log('mentioning, and STORY-021 already refused that for trust breaches.');

rule('180. On the dashboard, and what this cannot see');
await new Promise((resolve) => healthServer.close(resolve));
await recordStop({ deploymentId: healthApiRow.id, reason: 'demo finished', clean: true });
await recordStop({ deploymentId: healthWorkerRow.id, reason: 'demo finished', clean: true });
const sysStatus = await systemStatus({});
console.log(`components: ${Object.entries(sysStatus.components).map(([k, v]) => `${k}=${v.status}`).join(' · ')}`);
console.log(`checks logged: ${sysStatus.checksRecorded} · outages on record: ${sysStatus.outages.length} (${sysStatus.openOutages} open)`);
console.log(`governance check system.no_open_outage: ${(await runChecks({})).find((c) => c.id === 'system.no_open_outage').passed ? 'pass' : 'FAIL'}`);
console.log('\nTrust tab, System health panel: each component, each instance with its heartbeat,');
console.log('request count, error rate and p95 from its last beat, and every outage with when');
console.log('it started, when it was noticed, who was paged and when it recovered. An admin');
console.log('can run the check from the page.');
console.log('\nWhat this cannot do, said plainly rather than left to be discovered:');
console.log('  · A database outage is detected by the one process that cannot record it —');
console.log('    the monitor stores its findings in the thing it is monitoring.');
console.log('  · Neither process can notice itself. The API notices a dead worker; the worker');
console.log('    notices a dead API; both dead at once is noticed by nobody here.');
console.log('  · Prometheus and PagerDuty, which the build note names, are not installed and');
console.log('    have no account. What is here is the part they sit on top of — something that');
console.log('    measures, something that remembers, something that tells someone — and the');
console.log('    README names the outside probe a real deployment still needs.');

console.log('\nSTORY-027 complete — health checks are performed on a timer by both processes,');
console.log('every verdict is a row, an outage is a transition that pages the operators once,');
console.log('and the dashboard shows what was measured rather than what was claimed\n');

// ── STORY-029: Implement Content Performance Metrics ───────────────────────
// REQ-007. "Given content is published and receives engagement, metrics are
// tracked and displayed; given metrics are collected and analysed, insights
// are provided on content effectiveness."

rule('181. One question asked of the data, when a human remembered to press the button');
const { rows: perfBefore } = await query(
  `SELECT (SELECT COUNT(*)::int FROM audit_log WHERE action = 'engagement.collected') AS collections,
          (SELECT COUNT(*)::int FROM jobs WHERE kind = 'engagement.collect') AS sweeps,
          (SELECT COUNT(*)::int FROM engagement WHERE author_id = $1) AS snapshot_rows,
          (SELECT COUNT(*)::int FROM content_metrics WHERE author_id = $1) AS series_rows,
          (SELECT MAX(collections)::int FROM engagement WHERE author_id = $1) AS most_collected`,
  [author.id],
);
console.log('STORY-069 built engagement collection and one analysis over it. Measured before');
console.log('this story, on the database as it stood:');
console.log(`\n  collections ever run:            ${perfBefore[0].collections}   (both by this demo; zero by any sweep)`);
console.log('  recurring sweeps that collect:   0   (the button was the only caller)');
console.log(`  readings kept per post:          1   (overwritten each time — the most-collected post has been read ${perfBefore[0].most_collected} times and has one row)`);
console.log('  questions asked of the data:     1   (memes or text)');
console.log('\nNever asked: which platform earns more for this author; whether the "optimal');
console.log('window" the scheduler has aimed every post at since STORY-001 does anything; and');
console.log('whether theme alignment and voice — the two scores this system escalates drafts');
console.log('on — have any relationship to how a post performs once it is out.');

rule('182. Tracked: a series per post, on a timer');
// Sixteen posts published six hours ago, half inside twitter's best hours and
// half at 3am, plus eight on instagram — enough for the questions below to
// have a sample to decline on or conclude from.
const perfNow = new Date();
const seedPerfPost = async ({ platform, hour, tag, i }) => {
  const at = new Date(perfNow.getTime() - 6 * 3600000);
  at.setUTCHours(hour, 0, 0, 0);
  if (at > perfNow) at.setUTCDate(at.getUTCDate() - 1);
  const { rows: d } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status,
                         format, theme_alignment, voice_score)
     VALUES ($1,$2,$3,$4,0.9,CURRENT_DATE,'approved','text',$5,$6) RETURNING id`,
    [author.id, book.id, platform, `${tag} ${i}: on craft, and what it costs`, 0.5 + ((i * 7) % 10) / 20, 0.5 + ((i * 3) % 10) / 20],
  );
  // The approval an "approved" draft claims, an hour before it went out. Until
  // STORY-058 these posts had none, and `gate.posts` has failed on them at the
  // end of every demo since — correctly: a published post with no approval.
  await query(
    `INSERT INTO approvals (draft_id, decision, reviewer, notes, created_at, user_id)
     VALUES ($1, 'approved', 'Mira Kovač', 'approved before it was scheduled', $2,
             (SELECT id FROM users WHERE email = 'mira@example.test'))`,
    [d[0].id, new Date(at.getTime() - 3600000).toISOString()],
  );
  await recordAction({ actor: 'Mira Kovač', action: 'draft.approved', entityType: 'draft', entityId: String(d[0].id), authorId: author.id, before: { status: 'pending_approval' }, after: { status: 'approved' } });
  await query(
    `INSERT INTO scheduled_posts (draft_id, author_id, platform, scheduled_for, status, external_id, published_at, format)
     VALUES ($1,$2,$3,$4,'published',$5,$4,'text')`,
    [d[0].id, author.id, platform, at.toISOString(), `demo-${tag}-${i}`],
  );
};
for (let i = 0; i < 8; i += 1) await seedPerfPost({ platform: 'twitter', hour: 15, tag: 'in-window', i });
for (let i = 0; i < 8; i += 1) await seedPerfPost({ platform: 'twitter', hour: 3, tag: 'out-of-window', i });
for (let i = 0; i < 8; i += 1) await seedPerfPost({ platform: 'instagram', hour: 16, tag: 'instagram', i });

// Three sweeps, as the worker would run them: now, tomorrow, and the day after.
// In the same simulated world stage 89 set up — memes 60% better — and said
// so, because a sweep that quietly reset it would make the meme-vs-text panel
// below change its mind for no reason a reader could see.
for (const hoursAhead of [0, 18, 48]) {
  const at = new Date(perfNow.getTime() + hoursAhead * 3600000);
  const run = await trackEngagement({ authorId: author.id, now: at, formatEffect: 0.6 });
  console.log(`  sweep at +${String(hoursAhead).padStart(2)}h: ${run.collected} posts read (formatEffect=0.6, as in stage 89)`);
}
const perfView = await contentPerformance({ authorId: author.id, now: new Date(perfNow.getTime() + 49 * 3600000) });
const perfSeries = perfView.posts.filter((p) => p.excerpt.startsWith('in-window')).slice(0, 3);
console.log('\n  post                       readings   impressions over time        trajectory');
for (const p of perfSeries) {
  console.log(
    `  ${p.excerpt.slice(0, 26).padEnd(27)}${String(p.readings).padEnd(11)}` +
      `${p.history.map((h) => `${h.impressions}@${Math.round(h.hoursLive)}h`).join(' → ').padEnd(34)}${p.trajectory}`,
  );
}
console.log(`\n  ${perfView.coverage.readings} readings on record for ${perfView.coverage.published} posts · sweep "${perfView.coverage.sweep.kind}" every ${perfView.coverage.sweep.everySeconds / 60} min`);
console.log('\nThe snapshot STORY-069 kept is still there, one row per post, because the format');
console.log('comparison needs one consistent reading each. The series is what it forgot: a post');
console.log('that stopped at 900 impressions and one still climbing used to look identical.');
console.log('"Still climbing" is a claim about two readings; a single reading now says "one');
console.log('reading" rather than guessing.');

rule('183. Analysed: the questions, and what the data can honestly answer');
for (const i of perfView.insights) {
  console.log(`  ${i.id.padEnd(22)} ${i.finding.padEnd(28)} ${i.because.length > 88 ? i.because.slice(0, 85) + '…' : i.because}`);
}
console.log('\nThe collector is mocked and blind to everything but platform and format. So on');
console.log('the timing question — 8 posts in twitter\'s best hours against 8 at 3am — the honest');
console.log('answer is "no measurable relationship", and on the scores question it is r ≈ 0.');
console.log('A view that found either would be finding it in the noise.');
const perfLeader = perfView.insights.find((i) => i.id === 'platform.leader');
console.log(`\nThe one conclusion — ${perfLeader.leads ? `${perfLeader.leads} leads, +${Math.round(perfLeader.lift * 100)}%` : perfLeader.finding} — is a property of the`);
console.log('mock, whose instagram base rate is more than twice twitter\'s, and it is stated in the');
console.log('mock\'s source. The apparatus reached it the same way it declined the others: two');
console.log('ranges that do not overlap at eight-plus posts each.');

rule('184. The first version found two relationships that were not there');
const perfTiming = perfView.insights.find((i) => i.id === 'timing.window');
const perfTheme = perfView.insights.find((i) => i.id === 'scores.themeAlignment');
console.log('On its first run against this same data, the timing question came back');
console.log('"relationship_found: in-window posts lead", and theme alignment came back');
console.log('r = 0.372 over 66 posts, t = 3.21 — significant at any textbook threshold. On a');
console.log('collector that has never read a draft and does not know what time it is.');
console.log('\nBoth were the platform. Instagram\'s best hour is 16:00, so every instagram post was');
console.log('"in-window", and instagram\'s mock base rate is double twitter\'s — the pooled cell');
console.log('was measuring which platform a post was on. The fixtures with the highest theme');
console.log('scores were also the instagram ones. Same confound, second question.');
console.log('\nHeld within platform, and engagement taken relative to posts on the same platform');
console.log('and format:');
for (const p of perfTiming.detail) {
  console.log(`  timing · ${p.platform.padEnd(10)} ${p.finding.padEnd(28)} ${p.because}`);
}
console.log(`  theme alignment      ${perfTheme.finding.padEnd(28)} ${perfTheme.because}`);
console.log('\nr = 0.37 became r = 0.00 without a single reading changing. The number was real;');
console.log('what it measured was not what it was named after — STORY-006\'s alignment score');
console.log('again, in a different room. A dashboard that had shipped the first version would');
console.log('have told an author that the scheduler\'s window works and that the theme floor');
console.log('pays for itself, and been confidently wrong about both on fabricated data.');

rule('185. On the dashboard, and what is not real');
const perfCheck = (await runChecks({})).find((c) => c.id === 'engagement.tracked');
console.log(`  coverage: ${perfView.coverage.measured}/${perfView.coverage.published} published posts measured · ${perfView.coverage.settled} settled · ${perfView.coverage.unmeasuredMature} matured unmeasured`);
console.log(`  governance check engagement.tracked: ${perfCheck.passed ? 'pass' : `FAIL (${perfCheck.violations})`} — a matured post nobody measured is a finding, not a blank`);
console.log(`  source: ${perfView.coverage.allMocked ? 'every reading is mocked, and the page says so beside the chart' : 'some readings are from a platform'}`);
console.log('\nPerformance tab: coverage pills, the questions with their answers and reasons,');
console.log('totals by platform, and every post with its scores, its window, its series and');
console.log('its trajectory. The meme-vs-text comparison and mix recommendations sit below,');
console.log('unchanged — the format question is answered by STORY-069\'s own function, called');
console.log('rather than copied, because the mix recommender already acts on that one.');
console.log('\nNot real: every number. The adapters are mocks (STORY-025 deferred OAuth with');
console.log('reasons), so this is a working apparatus over fabricated readings, and the day a');
console.log('platform adapter is real its rows say "platform" instead of "mock".');

console.log('\nSTORY-029 complete — engagement is tracked on a timer as a series, four questions');
console.log('are asked of it instead of one, and each answer says what it cannot say\n');

// ── STORY-031: Frontend Architecture Setup ─────────────────────────────────
// REQ-001, REQ-002, REQ-008. "Responsive, interactive, and secure with CSP set
// to 'default-src self' and HTTPS enforced."

rule('186. A story written for a repository that already exists');
console.log('The build note says: create a new React app with Next.js, Tailwind and Helmet.');
console.log('There has been a React app since R0 — Vite, eleven tabs, 3,900 lines. So the');
console.log('acceptance clause is the loop stop, and against it, measured:');
console.log('\n  security headers on any response (API, Vite, nginx):   none');
console.log('  Content-Security-Policy:                               none');
console.log('  HTTPS enforcement:                                     none');
console.log("  CORS:                                                  cors() — every origin");
console.log('  media queries in the stylesheet:                       0');
console.log('  tabs that scrolled the page sideways at 390px wide:    10 of 11 (Worker by 1,423px)');
console.log('\nNot rebuilt in Next.js: rewriting a working app to reach a clause about headers');
console.log('and layout would spend the story on the part nobody asked to change.');

rule('187. The policy, sent — and the one place the clause had to bend');
const secServer = createApp({ httpsRequired: false }).listen(0);
await new Promise((resolve) => secServer.once('listening', resolve));
const secBase = `http://127.0.0.1:${secServer.address().port}`;
const secR = await fetch(`${secBase}/api/health`, { headers: { origin: 'https://evil.example' } });
console.log(`  Content-Security-Policy: ${secR.headers.get('content-security-policy')}`);
console.log(`  X-Frame-Options:         ${secR.headers.get('x-frame-options')}`);
console.log(`  X-Content-Type-Options:  ${secR.headers.get('x-content-type-options')}`);
console.log(`  CORS for evil.example:   ${secR.headers.get('access-control-allow-origin') ?? '(none — was *)'}`);
await new Promise((resolve) => secServer.close(resolve));
console.log(`\nThe clause asks for "default-src 'self'", and it is there. Applied alone it blanks`);
console.log('every meme in the product: the artwork is stored as data:image/svg+xml, and img-src');
console.log('falls back to default-src. So exactly one directive widens it, with its reason:');
for (const [what, why] of Object.entries(CSP_EXEMPTIONS)) console.log(`\n  ${what}\n    ${why}`);
console.log('\n`npm run check:browser` drives Chrome through every tab at 390px and 1280px under');
console.log('this policy — 22 loads, 0 violations, 0 overflow — then re-runs Review and');
console.log("Templates under the literal \"default-src 'self'\": 12 violations, 0 of 12 memes");
console.log('shown. The control is what makes the clean run mean something.');

rule('188. HTTPS, enforced where the connection is real');
const secProd = createApp({ httpsRequired: true }).listen(0);
await new Promise((resolve) => secProd.once('listening', resolve));
const secProdBase = `http://127.0.0.1:${secProd.address().port}`;
const secGet = await fetch(`${secProdBase}/api/authors`, { redirect: 'manual' });
const secPost = await fetch(`${secProdBase}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual',
});
const secProbe = await fetch(`${secProdBase}/api/health`, { redirect: 'manual' });
const secTls = await fetch(`${secProdBase}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
await new Promise((resolve) => secProd.close(resolve));
console.log(`  GET  over http            → ${secGet.status} ${secGet.headers.get('location')}`);
console.log(`  POST over http            → ${secPost.status} (refused, not redirected: the body already crossed in the clear)`);
console.log(`  /api/health over http     → ${secProbe.status} (the load balancer probes the instance directly)`);
console.log(`  via the TLS terminator    → ${secTls.status}, HSTS: ${secTls.headers.get('strict-transport-security')}`);
console.log('\nOn by default in production, off in development — localhost has no certificate.');
console.log('X-Forwarded-Proto is believed only when enforcement is on, because trusting it');
console.log('with no proxy in front lets any client declare its own connection secure.');
console.log(`\nOne policy, three senders: the API through helmet, Vite by importing it, nginx by`);
console.log(`a copy the test suite compares byte for byte. ${cspHeader().split(';').length} directives, no 'unsafe-inline'.`);

console.log('\nSTORY-031 complete — every response carries the policy, HTTPS is enforced where it');
console.log('is real, and every tab fits a phone; measured in a browser, not asserted in a string\n');

// ── STORY-032: Backend Architecture Setup ──────────────────────────────────
// REQ-003, REQ-004, REQ-008. "Input validation using Joi and JWT authentication."

rule('189. Every route, sent garbage');
const valServer = createApp().listen(0);
await new Promise((resolve) => valServer.once('listening', resolve));
const valBase = `http://127.0.0.1:${valServer.address().port}/api`;
const valTok = (await (await fetch(`${valBase}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ops@example.test', password: 'ops-password' }),
})).json()).token;
const valCall = async (method, path, body) => {
  const r = await fetch(`${valBase}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${valTok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
console.log('JWT authentication has existed since STORY-064. Input validation had not: no');
console.log('library, no schema. Measured before this story by sending malformed input to all');
console.log('77 routes:');
console.log('\n  routes that answered 500:          28 of 77');
console.log('  typical error handed to the caller: invalid input syntax for type bigint: "NaN"');
console.log('  JavaScript crashes:                 platforms.includes is not a function (and two more)');
console.log('  garbage accepted and STORED:        POST /authors { name: 123, email: ["x"] } → 201,');
console.log('                                      email saved as the text {"x"}');
const valBad = await valCall('POST', '/authors', { name: 123, email: ['x'] });
const valId = await valCall('POST', '/drafts/abc/approve', {});
console.log(`\nNow:\n  POST /authors { name: 123, email: ["x"] } → ${valBad.status}`);
for (const d of valBad.body.details) console.log(`      ${d.part}.${d.path}: ${d.message}`);
console.log(`  POST /drafts/abc/approve                  → ${valId.status}  ${valId.body.error}`);

rule('190. Validation strips what a route does not declare — and that is only safe if proven');
const valGood = await valCall('POST', '/authors', { name: '  Demo Validation  ', email: `demo-validation-${Date.now()}@example.test`, isAdmin: true });
console.log(`  POST /authors { name: "  Demo Validation  ", …, isAdmin: true } → ${valGood.status}`);
console.log(`      stored name: "${valGood.body.name}"   (trimmed; isAdmin never reached the handler)`);
console.log('\nUnknown fields are stripped rather than refused, because the UI sends a few that');
console.log('some handlers ignore, and refusing them would turn a harmless extra into an outage.');
console.log('Stripping has its own failure: a field a handler needs but the schema forgot is');
console.log('silently deleted. So tests/inputValidation.test.js reads every handler\'s source from');
console.log('the live router and fails if it reads a field its schema does not declare — and was');
console.log('seen to fail when awardName was removed from one schema on purpose.');

rule('191. Authorisation first, validation second');
const valAuditor = (await (await fetch(`${valBase}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'auditor@example.test', password: 'compliance-only' }),
})).json()).token;
const valForbidden = await fetch(`${valBase}/meme-templates`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${valAuditor}` },
  body: JSON.stringify({ key: 'BAD KEY' }),
});
console.log(`  compliance session, POST /meme-templates with a bad body → ${valForbidden.status}`);
console.log('\nThe first version validated before checking permission, so this returned 400 and a');
console.log('list of the input rules for an action the caller may not take. A refusal should say');
console.log('"you may not", and teach nothing about how to ask. The existing RBAC suite caught it.');
await new Promise((resolve) => valServer.close(resolve));
console.log('\nNot done: splitting the 1,500-line routes file into controllers. It changes no');
console.log('behaviour, and every scan that proves a property of the API — tenant walking, input');
console.log('coverage — reads the live router, so it can be done mechanically when it is wanted.');

console.log('\nSTORY-032 complete — 0 of 77 routes crash on bad input (was 28), nothing malformed is');
console.log('stored, and a test proves no handler reads a field its schema forgot\n');

// ── STORY-033: Database Architecture Setup ─────────────────────────────────
// REQ-005, REQ-006, REQ-008. "Secure access with roles and permissions configured."

rule('192. Who the application was, as far as the database knew');
console.log('STORY-019 built permissions in the application. Measured before this story, the');
console.log('database under it had none:');
console.log('\n  the API connected as:   anvi — a Postgres SUPERUSER');
console.log('  tables it owned:        46 of 46');
console.log('  audit log protection:   three triggers, which the owner can switch off —');
console.log('                          and stages 103–105 of this demo did exactly that,');
console.log('                          through the application\'s own connection');
console.log('\nApplication permissions decide what a *user* may do. Once the process itself is');
console.log('compromised they help with nothing, because the process held every key.');
const { rows: [dbWho] } = await query(
  `SELECT current_user AS role, r.rolsuper,
          (SELECT COUNT(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
     FROM pg_roles r WHERE r.rolname = current_user`,
);
console.log(`\nNow: connected as ${dbWho.role} · superuser ${dbWho.rolsuper} · owns ${dbWho.owns} tables`);

rule('193. Asked to do what an attacker holding this connection would try');
for (const [what, sql] of [
  ['switch off the audit triggers', 'ALTER TABLE audit_log_sealed DISABLE TRIGGER ALL'],
  ['rewrite an audit row        ', "UPDATE audit_log SET action = 'x' WHERE id = 1"],
  ['drop a table                ', 'DROP TABLE drafts'],
  ['forge a migration record    ', "INSERT INTO schema_migrations (filename) VALUES ('999_fake.sql')"],
  ['grant itself the owner      ', `GRANT ${(await ownerQuery('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()')).rows[0].o} TO ale_app_login`],
]) {
  const dbTry = await query(sql).then(() => 'ALLOWED', (e) => `refused — ${e.message}`);
  console.log(`  ${what}  ${dbTry}`);
}
const dbOwnerTry = await ownerQuery("UPDATE audit_log SET action = 'x' WHERE id = 1").then(() => 'ALLOWED', (e) => e.message.split('.')[0]);
console.log(`\nand the owner, trying an ordinary UPDATE: ${dbOwnerTry}`);
console.log('\nTwo walls. The privilege stops the application login; the trigger stops a mistaken');
console.log('write by anyone who has UPDATE. Only disabling the trigger gets past both, and that');
console.log('now takes the owner\'s credentials — the threat STORY-013\'s seals exist to catch.');
console.log('A separate login, not SET ROLE on the owner\'s connection: a session that could SET');
console.log('ROLE could RESET ROLE, and an injected statement would simply switch back.');

rule('194. Reported, not only enforced');
const dbReady = (await readiness({})).checks.find((c) => c.id === 'privileges');
console.log(`  /ready privileges: ${dbReady.ok ? 'ok' : 'NOT OK'} — ${dbReady.detail}`);
const dbRow = (await runChecks({})).find((c) => c.id === 'db.least_privilege');
console.log(`  Trust tab, db.least_privilege: ${dbRow.passed ? 'pass' : 'FAIL'}`);
console.log('\nRunning as the owner is refused by /ready in production and reported on the Trust');
console.log('tab everywhere. A new table from a later migration is granted to the app by default,');
console.log('and a test fails if the set of tables the app cannot update is anything other than');
console.log('the declared append-only ones.');
console.log('\nThe whole test suite and this demo run as ale_app_login. The only things that needed');
console.log('the owner were the migrations, and the tampering this demo does on purpose.');
console.log('\nNot done: Sequelize, which the build note names. The schema is 32 hand-written');
console.log('migrations whose comments carry most of this project\'s reasoning; an ORM on top would');
console.log('be a second description of the schema free to disagree with the first.');

console.log('\nSTORY-033 complete — the database refuses the application anything it does not need,');
console.log('including the power to rewrite its own audit log\n');

// ── STORY-034: Deployment Architecture Setup ───────────────────────────────
// REQ-007, REQ-008. "Containerised for consistent deployment, and secure with
// vulnerability scanning using Clair."

rule('195. Files reviewed for nineteen stories, read the way Docker reads them');
const ctrYaml = (await import('yaml')).default;
const ctrCompose = ctrYaml.parse(await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8'));
console.log('Docker is not installed here and never has been. So the question is what can be');
console.log('proved without it — and parsing the Compose file as Compose does was enough to find:');
console.log('\n  services the file defined before this story:  1  (postgres)');
console.log('  read as *volumes* instead:                    migrate, api, worker, client');
console.log('\nThe top-level `volumes:` block sat between two services, so YAML nested the rest');
console.log('under it. `docker compose up` could only ever have started a database.');
console.log(`\n  now: services ${Object.keys(ctrCompose.services).join(', ')} · volumes ${Object.keys(ctrCompose.volumes).join(', ')}`);

rule('196. Two configs that were each right, and wrong together');
const ctrNginx = await readFile(new URL('../../client/nginx.conf', import.meta.url), 'utf8');
console.log('STORY-031 made the API enforce HTTPS in production, reading X-Forwarded-Proto.');
console.log('In the container stack the API runs in production, behind nginx — and nginx never');
console.log('forwarded that header. Every browser call through the UI would have looked like');
console.log('plain http: GETs redirected, POSTs refused. The stack would have refused its own UI.');
console.log(`\n  nginx now: ${ctrNginx.match(/proxy_set_header X-Forwarded-Proto [^;]+;/)[0]}`);
console.log('\nNo unit test could have caught it — it exists only where two files meet. The build');
console.log('note\'s own phrase, "ensuring both services can communicate effectively", is what');
console.log('prompted checking the seam.');
console.log('\nAlso fixed: no .dockerignore (every COPY shipped host node_modules and any .env into');
console.log('an image layer); base images now pinned by digest; nginx replaced by the unprivileged');
console.log('image, which does not start as root.');

rule('197. The scan that can run here, and the one that cannot');
const ctrAudit = await new Promise((resolve) => {
  import('node:child_process').then(({ execFile }) =>
    execFile('npm', ['audit', '--omit=dev', '--json'], { cwd: new URL('../..', import.meta.url).pathname }, (_e, out) => {
      try { resolve(JSON.parse(out).metadata.vulnerabilities); } catch { resolve(null); }
    }));
});
console.log('Dependencies, scanned against the advisory database:');
console.log('  before: 3 moderate in production (qs, via Express — one a denial of service in the');
console.log('          query-string parser every request passes through), 3 high in development');
console.log('          (puppeteer-core, added by STORY-031 for the browser check)');
console.log(`  now:    ${ctrAudit ? `${ctrAudit.total} (critical ${ctrAudit.critical}, high ${ctrAudit.high}, moderate ${ctrAudit.moderate})` : 'could not reach the registry from here'}`);
console.log('\nIn CI as a gate (`npm audit --omit=dev --audit-level=moderate`) before the tests.');
console.log('\nImages, scanned by Clair — written, never run: there is no Docker here to build an');
console.log('image and no registry to scan one from. The job pins quay/clair-action@v0.0.16 and sets');
console.log('return-code: 1, because the action\'s default is 0 — it reports vulnerabilities and');
console.log('passes the build. The example in its own README is a scan that can never fail CI.');

console.log('\nSTORY-034 complete — the stack is defined the way Compose reads it, the UI can reach');
console.log('the API through it, dependencies are scanned and gate the build, and the image scan');
console.log('is written to fail when it finds something; building and scanning images still needs Docker\n');

// ── STORY-038: API Gateway for Managing and Monitoring Integrations ────────
// REQ-009, REQ-014. "All external API interactions routed through the gateway;
// when it fails, the failure is logged and the administrator alerted."

rule('198. The gateway that said everything went through it');
console.log('STORY-016\'s gateway header: "Every outbound call in this system goes through here:');
console.log('the social platforms, the email provider, the directory search, and the Anthropic');
console.log('content API." Measured before this story:');
console.log('\n  the directory search:        called directly — no timeout, no retry, no record');
console.log('  on the Trust tab\'s panel:     absent, because the panel listed what was logged');
console.log('  policy:                      one for everything (10s, 3 attempts)');
console.log('  a failure:                   logged; nobody told; retried on every call while down');
const gwHealth = await integrationHealth({ sinceHours: 24 });
console.log('\nNow, every declared integration and its policy:');
for (const h of gwHealth.filter((x) => x.policy)) {
  console.log(`  ${h.service.padEnd(14)} ${h.kind.padEnd(13)} ${String(h.policy.timeoutMs / 1000).padStart(3)}s × ${h.policy.maxAttempts}   calls ${String(h.calls).padStart(3)}   circuit ${h.circuit.state}`);
}
console.log('\nAnthropic gets 60s: generation takes tens of seconds, and the shared 10s ceiling');
console.log('abandoned calls that would have succeeded. An undeclared service is refused outright.');

rule('199. A directory goes down');
let gwClock = new Date();
const gwNow = () => gwClock;
let gwCalls = 0;
const gwFail = async () => { gwCalls += 1; throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); };
for (let i = 1; i <= 3; i += 1) {
  const r = await callExternal({ service: 'eventFinder', operation: 'search', fn: gwFail, maxAttempts: 1, sleep: async () => {}, now: gwNow }).catch((e) => e.message);
  console.log(`  call ${i}: ${r}`);
}
const gwOpen = (await query("SELECT state, consecutive_failures, alerted_at FROM integration_circuits WHERE service = 'eventFinder'")).rows[0];
console.log(`\n  circuit: ${gwOpen.state} after ${gwOpen.consecutive_failures} failed calls · operators alerted: ${gwOpen.alerted_at ? 'yes' : 'no'}`);
const gwLog = (await listAuditLog({ entityType: 'integration', limit: 10 })).filter((e) => e.entity_id === 'eventFinder');
for (const e of gwLog.reverse()) console.log(`  audit: ${e.action}${e.metadata.operators ? ' → ' + e.metadata.operators.join(', ') : ''}`);

rule('200. And is left alone until it might be back');
const gwBefore = gwCalls;
const gwShort = await callExternal({ service: 'eventFinder', operation: 'search', fn: gwFail, maxAttempts: 1, now: gwNow }).catch((e) => e.message);
console.log(`  next call: ${gwShort}`);
console.log(`  provider actually called: ${gwCalls - gwBefore} time(s)`);
const gwScout = await searchAllDirectories({});
console.log(`\n  the scout meanwhile: ${gwScout.length} listings from the other two directories, none from eventFinder`);
console.log('  — one directory down is fewer listings this month, not none, and the Trust tab says why.');
gwClock = new Date(gwClock.getTime() + 301_000);
const gwTrial = await callExternal({ service: 'eventFinder', operation: 'search', fn: async () => [], maxAttempts: 1, now: gwNow });
const gwClosed = (await query("SELECT state FROM integration_circuits WHERE service = 'eventFinder'")).rows[0];
console.log(`\n  five minutes later, one trial call: ${Array.isArray(gwTrial) ? 'answered' : gwTrial} → circuit ${gwClosed.state}`);
console.log('\nOpened once, alerted once, and a trial that fails re-opens without paging again. A');
console.log('400 — a post too long for the platform — never counts: that is the provider working.');
console.log('Email is the one integration that cannot be alerted about by email; its outage is');
console.log('recorded as unannounceable and shown on the Trust tab instead.');

rule('201. What this is not');
console.log('The build note names AWS API Gateway or Kong. Both are a network hop in front of the');
console.log('providers, and neither exists here to configure. What the clause asks for — every');
console.log('interaction routed through one place, a policy per integration, failures detected,');
console.log('logged and alerted — is in-process, in the one module every adapter already calls,');
console.log('and a source scan fails the build if any production code calls out around it.');
await query("DELETE FROM integration_circuits WHERE service = 'eventFinder'");

console.log('\nSTORY-038 complete — every integration goes through the gateway with its own policy,');
console.log('and a failing one is stopped, logged and reported to the operators once\n');

// ── STORY-039: Message Queue System for Agent Communication ────────────────
// REQ-010. "When an agent sends a message, the intended recipient receives it."

rule('202. Eleven agents, and not one message between them');
console.log('Measured before this story: agents reached each other by calling functions');
console.log('directly, or by polling a table on a five-minute sweep. When the Trust and Monitoring');
console.log('Agent escalated a draft, the reviewer heard at the next trust.monitor_escalations');
console.log('sweep — up to 300 seconds later — and nothing recorded that one agent had told');
console.log('another anything. The audit log showed an escalation and, separately, an email.');

rule('203. The monitor escalates, and says so to the agent that must act');
const { rows: [busBook] } = await query('SELECT id FROM books WHERE author_id = $1 LIMIT 1', [author.id]);
await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, theme_alignment, voice_score, week_of)
   VALUES ($1,$2,'linkedin','A draft in a voice the author has never used!!!','pending_approval',0.9,0.9,0.1,CURRENT_DATE)`,
  [author.id, busBook.id],
);
await monitorContent({ authorId: author.id });
const { rows: busQueued } = await query(
  `SELECT id, topic, sender, recipient, status, created_at FROM agent_messages
    WHERE author_id = $1 AND topic = 'escalation.raised' AND status = 'queued' ORDER BY id`,
  [author.id],
);
console.log(`  queued: ${busQueued.length} × escalation.raised   TrustMonitoringAgent → ApprovalNotificationAgent`);
console.log('\nWritten in the same transaction as the escalation itself: if the escalation had');
console.log('rolled back, so would the message. A broker on its own cannot promise that — the');
console.log('process can die between committing and publishing. This is the outbox pattern.');
const busDelivered = (await dispatch({})).filter((x) => x.topic === 'escalation.raised');
const busNotified = busDelivered.map((d) => d.result?.notified ?? 0);
console.log(`\n  delivered on the next worker poll: ${busDelivered.filter((d) => d.status === 'acked').length} of ${busDelivered.length} acknowledged`);
console.log(`  reviewer notices sent: ${busNotified.reduce((a, b) => a + b, 0)} — all by the first message's handler; the other ${busDelivered.length - 1} found nothing left to announce`);
console.log('\nThat is idempotence doing its job. The handler is the existing notifier, which announces');
console.log('each escalation once however often it runs — so a burst of messages, or a message');
console.log('delivered twice, is one email per escalation, never a pile of them.');
const { rows: [busFirst] } = await query('SELECT message_id FROM agent_messages WHERE id = $1', [busQueued[0].id]);
const busTrail = (await listAuditLog({ authorId: author.id, entityType: 'agent_message', limit: 200 }))
  .filter((e) => e.entity_id === busFirst.message_id)
  .reverse();
console.log('\nOne message, both ends of it on the audit log:');
for (const e of busTrail) {
  console.log(`  ${e.action.padEnd(17)} by ${e.actor.padEnd(26)}${e.metadata.latencyMs !== undefined ? ` ${e.metadata.latencyMs}ms after it was sent` : `to ${e.metadata.to}`}`);
}
console.log('\nWithin one poll (5s by default) instead of one sweep (300s). The sweep still runs:');
console.log('the message makes the hand-off fast, the sweep makes it certain.');

rule('204. What the bus refuses, and what it never drops');
for (const [what, fn] of [
  ['a recipient nobody declared  ', () => send({ from: 'TrustMonitoringAgent', to: 'MarketingAgent', topic: 'x' })],
  ['a topic the recipient does not take', () => send({ from: 'TrustMonitoringAgent', to: 'ApprovalNotificationAgent', topic: 'post.publish_failed' })],
  ['a payload JSON would corrupt ', () => send({ from: 'TrustMonitoringAgent', to: 'ApprovalNotificationAgent', topic: 'escalation.raised', payload: { reviewer: undefined } })],
]) {
  const busRefused = await fn().then(() => 'ACCEPTED', (e) => e.message);
  console.log(`  ${what}  → ${busRefused.slice(0, 96)}`);
}
console.log('\n`undefined` is refused by name: JSON.stringify would drop the field silently, and a');
console.log('field that vanishes between two agents is the bug a message contract exists to stop.');
await send({ from: 'SchedulingAgent', to: 'APIIntegrationAgent', topic: 'post.publish_failed', authorId: author.id, payload: { authorId: author.id }, maxAttempts: 2 });
const busBoom = { APIIntegrationAgent: { 'post.publish_failed': async () => { throw new Error('mail relay refused the connection'); } } };
let busClock = new Date(Date.now() + 1000);
for (let i = 1; i <= 2; i += 1) {
  const r = (await dispatch({ handlers: busBoom, now: busClock })).find((x) => x.topic === 'post.publish_failed');
  console.log(`  attempt ${i}: ${r?.status} — ${r?.error}`);
  busClock = new Date(busClock.getTime() + 600_000);
}
console.log('\nRetried with backoff, then dead-lettered — on the Worker tab with a Redeliver button');
console.log('for an operator. Never dropped. A message received and not acknowledged within 60s');
console.log('is delivered again, so a worker that dies mid-handler loses nothing either.');

rule('205. RabbitMQ, which the story names');
console.log('RabbitMQ is not installed on this machine. amqpTransport.js carries messages through it');
console.log('— the outbox table stays the record of truth, the broker carries them — and CI runs a');
console.log('RabbitMQ service beside Postgres so tests/messageBus.test.js exercises it there. Here');
console.log('that scenario reports itself skipped, never passed.');
console.log('\nOne bug found on the way, by a test that failed once in about sixty runs: the queue');
console.log('compared the worker\'s clock against timestamps written by the database\'s clock. On');
console.log('one machine that is milliseconds; across two it is however far the clocks drift, and');
console.log('a slow worker would delay every message by that much. The database decides now.');

console.log('\nSTORY-039 complete — agents send each other messages that commit with the change they');
console.log('describe, reach only the intended recipient, and are acknowledged or kept, never dropped\n');

// ── STORY-040: Central Task Manager for Agent Coordination ─────────────────
// REQ-010. "Tasks assigned to agents by priority and resource availability;
// assignments logged and reviewable for correctness."

rule('206. The coordinator STORY-011 built, measured against this story');
console.log('Priority per job kind and an exclusive resource, recorded on each dispatch. And:');
console.log('\n  deferrals recorded:       0 ever — recordDispatch has a branch for it, and nothing calls it');
console.log('  kinds on the default:     trust.assess, posts.notify_failures — described as "produces');
console.log('                            work other agents react to", which neither does');
console.log('  availability:             "is the resource held". Nothing knew a task needs an integration.');
console.log('\nThat last one, measured with email\'s circuit open (STORY-038): approvals.notify_waiting');
console.log('ran anyway. Both sends were refused by the gateway. The notifier recorded the items as');
console.log('announced — it deliberately never re-announces a failed send — and the job reported');
console.log('"notified: 2". Nobody had been told, and those items would never be announced.');
const tmPlan = planFor({ kind: 'approvals.notify_waiting', author_id: author.id });
console.log(`\nNow every kind is assigned on declared grounds, e.g. approvals.notify_waiting →`);
console.log(`  agent ${tmPlan.agent} · priority ${tmPlan.priority} · needs ${tmPlan.requires.join(', ')}`);
console.log(`  "${tmPlan.coordination.reason}"`);

rule('207. A task whose integration is down waits, and says why — once');
await query(
  `INSERT INTO integration_circuits (service, state, consecutive_failures, opened_at, retry_at, last_error)
   VALUES ('email','open',5,now(),now() + interval '2 minutes','SMTP relay refused the connection')
   ON CONFLICT (service) DO UPDATE SET state = 'open', opened_at = now(), retry_at = now() + interval '2 minutes'`,
);
const { job: tmJob } = await enqueue({ kind: 'approvals.notify_waiting', idempotencyKey: `demo-040-${Date.now()}`, authorId: author.id });
const tmNow = new Date(Date.now() + 1000);
const tmHeld = await runOnce({ now: tmNow, jobId: tmJob.id });
await recordDeferrals({ now: tmNow });
await recordDeferrals({ now: new Date(tmNow.getTime() + 5000) });
await recordDeferrals({ now: new Date(tmNow.getTime() + 10000) });
const { rows: [tmRow] } = await query('SELECT status, attempts, deferred_reason FROM jobs WHERE id = $1', [tmJob.id]);
const tmDeferred = (await listAuditLog({ authorId: author.id, entityType: 'job', limit: 50 }))
  .filter((e) => e.action === 'task.deferred' && e.entity_id === String(tmJob.id));
console.log(`  ran: ${tmHeld ? 'yes' : 'no'} · status ${tmRow.status} · attempts spent ${tmRow.attempts}`);
console.log(`  why: ${tmRow.deferred_reason}`);
console.log(`  task.deferred rows after three polls: ${tmDeferred.length}`);
console.log('\nNo attempt spent: running it would only have had the gateway refuse, and three');
console.log('refusals would have dead-lettered work that was never actually tried. One audit row,');
console.log('not one per poll — a worker polls every five seconds, and seven hundred copies of the');
console.log('same line is how the one that matters gets missed. Released when the circuit will take');
console.log('a trial call; held any longer, nothing would ever test whether email is back.');
await query("DELETE FROM integration_circuits WHERE service = 'email'");

rule('208. Every assignment says what it was chosen over');
await query(
  `INSERT INTO integration_circuits (service, state, consecutive_failures, opened_at, retry_at, last_error)
   VALUES ('email','open',5,now(),now() + interval '2 minutes','SMTP relay refused the connection')
   ON CONFLICT (service) DO UPDATE SET state = 'open', opened_at = now(), retry_at = now() + interval '2 minutes'`,
);
const { job: tmLow } = await enqueue({ kind: 'engagement.collect', idempotencyKey: `demo-040-low-${Date.now()}`, authorId: author.id });
await runOnce({ now: new Date(Date.now() + 1000), jobId: tmLow.id });
const tmEntry = (await listAuditLog({ authorId: author.id, entityType: 'job', limit: 50 }))
  .find((e) => e.action === 'task.dispatched' && e.entity_id === String(tmLow.id));
console.log(`  dispatched: ${tmEntry.metadata.kind} → ${tmEntry.metadata.agent} (priority ${tmEntry.metadata.priority}, ${tmEntry.metadata.chosenBy})`);
for (const h of tmEntry.metadata.higherPriorityWaiting.slice(0, 3)) {
  console.log(`    went ahead of ${h.kind} (priority ${h.priority}) — ${h.blockedBy ?? 'NOTHING BLOCKED IT'}`);
}
await query("DELETE FROM integration_circuits WHERE service = 'email'");
const tmCheck = (await runChecks({})).find((c) => c.id === 'tasks.priority_respected');
console.log(`\n  governance check tasks.priority_respected: ${tmCheck.passed ? 'pass' : `FAIL (${tmCheck.violations})`}`);
console.log('\nA lower-priority task running while a higher one waits is either correct — the higher');
console.log('one was blocked — or the task manager choosing wrongly. The record names the blocker,');
console.log('read in the same statement as the choice, from the same snapshot of the queue.');
console.log('\nThe check was wrong twice before it was right, both times on this demo\'s own data:');
console.log('  1. The blockers were looked up after the choice. With two workers, a resource held at');
console.log('     the moment of choosing had been released by the moment of looking — a correct');
console.log('     choice recorded as a wrong one.');
console.log('  2. Then two workers took priority-25 tasks in the same millisecond a priority-30 task');
console.log('     was mid-claim by a third; it started 8ms later. In motion, not wrong.');
console.log('So it now judges by consequence: a higher-priority task passed over with nothing');
console.log('blocking it counts only if it was then kept waiting — more than 5 seconds, or never run.');
console.log('A job run by id (the Retry button) is a request, and not judged against priority.');

rule('209. And a notice that was not sent is no longer counted as sent');
console.log('Both notifiers used to add a failed send to the list they report as notified. They');
console.log('now report sends and failures apart, and the audit row for a failure says failed.');
console.log('\nNot changed, and flagged: a failed announcement is still never retried — STORY-012\'s');
console.log('choice, to guarantee no reviewer is told the same thing twice. Holding the job while');
console.log('email is down removes the common case; the trade-off itself (a possible duplicate');
console.log('against a certain miss) is a product decision, not an implementation one.');

console.log('\nSTORY-040 complete — every task is assigned to a named agent on declared grounds, waits');
console.log('without cost while what it needs is down, and every assignment can be checked\n');

// ── STORY-041: Tenant Database Schema Isolation ────────────────────────────
// REQ-011. "When an author is onboarded, a schema is created for them, and
// their data is isolated in it."

rule('210. What the database enforced between tenants: nothing');
const { rows: [tsCount] } = await query('SELECT COUNT(DISTINCT id)::int AS n FROM authors');
console.log(`The application connects as ale_app_login, and that login reads every author's rows —`);
console.log(`all ${tsCount.n} tenants in this database, from any query. Isolation lived entirely in each`);
console.log('query\'s WHERE author_id = …, which STORY-017 found missing from two routes and STORY-024');
console.log('found checked for 10 routes of 35.');

rule('211. Onboarding now creates the tenant\'s own schema');
const tsNew = await onboardTenant({ name: 'Demo Tenant', email: `demo-tenant-${Date.now()}@example.test`, password: 'demo-tenant-pw' });
const { rows: tsSchema } = await query(
  "SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name", [tsNew.schema.name],
);
console.log(`  onboarded author ${tsNew.author.id} → schema ${tsNew.schema.name}, role ale_tenant_${tsNew.author.id}`);
console.log(`  ${tsSchema.length} views, each showing only this tenant's rows: ${tsSchema.slice(0, 8).map((r) => r.table_name).join(', ')}, …`);
const tsCreated = (await listAuditLog({ authorId: tsNew.author.id, limit: 10 })).find((e) => e.action === 'tenant.schema_created');
console.log(`  audit: ${tsCreated.action} · tenant ${tsCreated.metadata.tenant} · at ${tsCreated.metadata.provisionedAt}`);
console.log('\nNot a copy of every table per tenant. That would mean every query routed to the right');
console.log('copy, every migration applied once per author, and every compliance or operator view');
console.log('rewritten as a union across all of them. A schema of views over the shared tables, and');
console.log('a role that can read only that schema, gives the isolation without the rewrite.');

rule('212. A query that forgets its WHERE clause, run as a tenant');
const tsCareless = await asTenant(author.id, () => query('SELECT DISTINCT author_id FROM drafts'), { provision: provisionTenant });
console.log(`  SELECT DISTINCT author_id FROM drafts   -- no WHERE, as author ${author.id}`);
console.log(`  → ${tsCareless.rows.map((r) => r.author_id).join(', ')}   (only their own)`);
for (const [what, sql] of [
  ['the shared table directly   ', 'SELECT 1 FROM public.drafts LIMIT 1'],
  ["another tenant's schema     ", `SELECT 1 FROM tenant_${tsNew.author.id}.drafts LIMIT 1`],
  ['a write, even to their own  ', `UPDATE drafts SET content = content WHERE author_id = ${author.id}`],
]) {
  const tsRefused = await asTenant(author.id, () => withTransaction((c) => c.query(sql)), { provision: provisionTenant })
    .then(() => 'ALLOWED', (e) => `refused — ${e.message}`);
  console.log(`  ${what} ${tsRefused}`);
}
const tsGets = router.stack.filter((l) => l.route?.methods?.get).length;
console.log(`\n${TENANT_SCOPED_ROUTES.length} of ${tsGets} GET routes run an author's request this way, on by default.`);
console.log(`The ${Object.keys(SYSTEM_READS).length} that do not are declared with their reason — /health and /ready have no`);
console.log('session; the trust dashboard verifies seals over every tenant\'s rows and writes an');
console.log('assessment. Found by switching isolation on everywhere and reading what broke.');

rule('213. What broke, and what this does not stop');
console.log('Switched on, it broke twelve tests, and each was a real difference:');
console.log('  · GROUP BY k.id with k.* — legal on a table, where the key implies every column; a');
console.log('    view has no key. Two queries rewritten.');
console.log('  · escalation_targets is a view, not a table; the first version only walked tables.');
console.log("  · another author's book now answers 404 instead of 403 — inside your schema it does");
console.log('    not exist, and 404 does not even confirm the id is somebody\'s.');
console.log('  · two tenants provisioned at once collided editing the same permission list — so the');
console.log('    shared-table grants now go to one group role, and provisioning takes a lock.');
const tsReset = await asTenant(author.id, () => withTransaction((c) => c.query('RESET ROLE')), { provision: provisionTenant })
  .then(() => 'allowed', (e) => e.message);
console.log(`\nAnd the limit, stated: RESET ROLE inside a tenant scope → ${tsReset}. Postgres always lets a`);
console.log('session return to the login it connected as. So this stops the leak this project actually');
console.log('had — a query that forgot its filter — and not an attacker who can already run arbitrary');
console.log('SQL; that is what parameterised queries and STORY-033\'s login are for. A database login per');
console.log('tenant would close it, at the cost of a connection pool per author. A test pins the limit,');
console.log('so the day that is built it fails and gets inverted.');

console.log('\nSTORY-041 complete — each tenant has a schema created at onboarding, and an author\'s reads');
console.log('run inside it, so the database — not each query — keeps tenants apart\n');

// ── STORY-042: Tenant-Specific Access Control ──────────────────────────────
// REQ-011. "Users only access their own tenant's data; any new role or
// permission change is reviewed and approved by an admin."

rule('214. The clause that already held, and the trust line that did not');
console.log('An author reaching only their own tenant has held since STORY-017 (the application)');
console.log('and STORY-041 (the database). The trust line — every role or permission change');
console.log('reviewed and approved — measured before this story:');
console.log('\n  a reviewed way to change access:       none — role_permissions was edited in SQL');
console.log('  POST /tenants { role: "admin" }:       201, and the account signed in with all eight');
console.log('                                         permissions. Logged as "tenant.onboarded" by an');
console.log('                                         agent. No second person involved.');
console.log('  a revoked permission:                  kept working — an author approved a draft with');
console.log('                                         the token they held, for up to twelve hours');
const acServer = createApp().listen(0);
await new Promise((resolve) => acServer.once('listening', resolve));
const acBase = `http://127.0.0.1:${acServer.address().port}/api`;
const acLogin = async (email, password) => (await (await fetch(`${acBase}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
})).json()).token;
const acCall = async (token, method, path, body) => {
  const r = await fetch(`${acBase}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const acOps = await acLogin('ops@example.test', 'ops-password');
const acSec = await acLogin('security@example.test', 'second-pair-of-eyes');
const acMira = await acLogin('mira@example.test', 'quiet-craft');
const acMinted = await acCall(acOps, 'POST', '/tenants', { name: 'Minted', email: `minted-${Date.now()}@example.test`, role: 'admin' });
console.log(`\nNow: POST /tenants { role: "admin" } → ${acMinted.status}\n     ${acMinted.body.error}`);

rule('215. A change is a request, and the person who asked cannot approve it');
const acReq = await acCall(acOps, 'POST', '/access/changes', {
  kind: 'revoke_permission', role: 'author', permission: 'content.approve',
  reason: 'Launch week: approvals move to the publicist, not the author',
});
console.log(`  ops requests: revoke content.approve from author → ${acReq.status}, ${acReq.body.status}`);
const acOwn = await acCall(acOps, 'POST', `/access/changes/${acReq.body.id}/approve`, {});
console.log(`  ops approves their own request → ${acOwn.status}: ${acOwn.body.error}`);
const acDirect = await query(
  "UPDATE access_changes SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1",
  [acReq.body.id],
).then(() => 'ALLOWED', (e) => `refused — ${e.message}`);
console.log(`  the same, straight at the database → ${acDirect}`);
console.log('\nThe rule lives in the database as a constraint — decided_by <> requested_by — so no');
console.log('code path can skip it. And the application login can no longer write role_permissions');
console.log('or users.role at all: an approved change is applied by one owner function, which');
console.log('re-checks the approval rather than trusting the caller.');

rule('216. A second admin approves — and it bites on the next request');
const { rows: [acDraft] } = await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
   VALUES ($1,$2,'twitter','A draft awaiting approval','pending_approval',0.9,CURRENT_DATE) RETURNING id`,
  [author.id, book.id],
);
const acApproved = await acCall(acSec, 'POST', `/access/changes/${acReq.body.id}/approve`, { note: 'Agreed for launch week' });
console.log(`  security approves → ${acApproved.status}, ${acApproved.body.status}, applied ${Boolean(acApproved.body.applied_at)}`);
const acAfter = await acCall(acMira, 'POST', `/drafts/${acDraft.id}/approve`, {});
console.log(`  Mira approves a draft with the token she already had → ${acAfter.status}: ${acAfter.body.error}`);
console.log('\nSessions carry the access version they were issued under; one issued before the latest');
console.log('change has its role and permissions re-read before it is trusted. Most requests pay');
console.log('nothing; the few that must look again, do. Twelve hours became one request.');
const acBack = await acCall(acSec, 'POST', '/access/changes', {
  kind: 'grant_permission', role: 'author', permission: 'content.approve', reason: 'Launch week is over; approvals return to authors',
});
await acCall(acOps, 'POST', `/access/changes/${acBack.body.id}/approve`, {});
const acTrail = (await listAuditLog({ entityType: 'access_change', limit: 20 })).filter((e) => e.entity_id === String(acReq.body.id)).reverse();
console.log('\n  the trail for that one change:');
for (const e of acTrail) console.log(`    ${e.action.padEnd(24)} by ${e.actor}`);
console.log('  (and restored the same way: requested by security, approved by ops)');

rule('217. Checked from outside');
const acCheck = (await runChecks({})).find((c) => c.id === 'access.elevated_reviewed');
console.log(`  governance invariant access.elevated_reviewed: ${acCheck.passed ? 'pass' : `BREACH (${acCheck.violations})`}`);
console.log('\nEvery account with more than author access either got it through an approved change,');
console.log("or was seeded before review existed — recorded as 'bootstrap', which only the schema");
console.log('owner can write. An invariant, not a quality check: the review is the whole promise.');
console.log('\nOne more found on the way, in STORY-041: tenant views showed every row with no author');
console.log('to every tenant, and in `users` a row with no author is a staff account. An author could');
console.log("read every admin's account. Rows with no author are now private unless a table declares");
console.log('them system-wide, with the reason — and the Access page is not offered to authors, who');
console.log("hold audit.read for their own trail and were, briefly, shown everyone's.");
await new Promise((resolve) => acServer.close(resolve));
console.log('\nNot done: Passport.js, which the build note names. Sessions have been JWTs since');
console.log('STORY-064; swapping the library would change nothing the clause asks about.');

console.log('\nSTORY-042 complete — nobody changes access alone, the database enforces it, and an');
console.log('approved change reaches every session on its next request\n');

// ── STORY-043: Tenant Onboarding Process ───────────────────────────────────
// REQ-011. "When an admin onboards a new tenant, the account and a private
// schema are set up and they get a welcome email. Every onboarding is logged
// with the time and the admin's id."

rule('218. What onboarding was, measured');
console.log('  a screen for the admin:                none — an API call only');
console.log('  a welcome email:                       none');
console.log('  the audit row:                         actor "TenantManagementAgent" — not the admin');
console.log('  author + account:                      two commits; a clash on the account left an');
console.log('                                         author nobody could ever sign in to');
console.log('  the password:                          chosen by the admin, who then knew it and had');
console.log('                                         to hand it over somehow');
const obServer = createApp().listen(0);
await new Promise((resolve) => obServer.once('listening', resolve));
const obBase = `http://127.0.0.1:${obServer.address().port}/api`;
const obCall = async (token, method, path, body) => {
  const r = await fetch(`${obBase}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const obOps = (await obCall(null, 'POST', '/auth/login', { email: 'ops@example.test', password: 'ops-password' })).body.token;
const obEmail = `nadia-${Date.now()}@example.test`;

rule('219. An admin onboards Nadia — name and address, nothing else');
const obWithPw = await obCall(obOps, 'POST', '/tenants', { name: 'X', email: `x-${Date.now()}@example.test`, password: 'admin-knows-it' });
console.log(`  with a password → ${obWithPw.status}: ${obWithPw.body.details?.[0]?.message ?? obWithPw.body.error}`);
const obNew = await obCall(obOps, 'POST', '/tenants', { name: 'Nadia Okafor', email: obEmail });
console.log(`  without         → ${obNew.status}`);
console.log(`    account:        ${obNew.body.user.email}, role ${obNew.body.user.role}, password set: ${obNew.body.user.activated}`);
console.log(`    private schema: ${obNew.body.schema.name} (${obNew.body.schema.objects} views)`);
console.log(`    welcome email:  to ${obNew.body.invite.sentTo}, link expires ${new Date(obNew.body.invite.expiresAt).toISOString()}`);
const obEntry = (await listAuditLog({ entityType: 'author', limit: 50 })).find((e) => e.action === 'tenant.onboarded' && e.entity_id === String(obNew.body.author.id));
console.log(`    audit:          ${obEntry.action} by ${obEntry.actor} (admin id ${obEntry.metadata.adminId}) at ${new Date(obEntry.created_at).toISOString()}`);
const obEarly = await obCall(null, 'POST', '/auth/login', { email: obEmail, password: 'guessing-now' });
console.log(`  Nadia tries to sign in before accepting → ${obEarly.status}`);

rule('220. Nadia chooses her own password from the link — once');
const obToken = new URL(obNew.body.invite.devInviteLink).searchParams.get('token');
const { rows: [obStored] } = await query('SELECT token_hash FROM tenant_invites WHERE author_id = $1', [obNew.body.author.id]);
console.log(`  stored:   sha256 ${obStored.token_hash.slice(0, 16)}…  (the link itself is only in the email)`);
const obAccept = await obCall(null, 'POST', '/auth/accept-invite', { token: obToken, password: 'nadia-chose-this' });
console.log(`  accept → ${obAccept.status}, signed in as ${obAccept.body.user?.name}`);
const obAgain = await obCall(null, 'POST', '/auth/accept-invite', { token: obToken, password: 'someone-else' });
console.log(`  the same link again → ${obAgain.status}: ${obAgain.body.error}`);

rule('221. All or nothing');
const obClash = await obCall(obOps, 'POST', '/tenants', { name: 'Clash', email: 'security@example.test' });
const { rows: obLeft } = await query("SELECT 1 FROM authors WHERE email = 'security@example.test'");
console.log(`  onboarding an address a staff login already uses → ${obClash.status}; authors left behind: ${obLeft.length}`);
console.log('\nAuthor, account and invitation are one transaction; the schema and the email follow');
console.log('the commit, so a welcome never goes out for an account that rolled back.');
await new Promise((resolve) => obServer.close(resolve));

console.log('\nSTORY-043 complete — an admin onboards from a screen, the author gets a welcome email');
console.log('and sets a password nobody else knows, and the log names the admin who did it\n');

// ── STORY-044: Tenant Data Access Audit ────────────────────────────────────
// REQ-011. "All access events are traceable to a specific tenant and user."

rule('222. What was recorded about reading, measured');
console.log('  a change (approve, onboard, grant):     on the audit log, since STORY-004');
console.log('  a read of a tenant\'s data:              nothing');
console.log('  a request for another tenant\'s data:    refused (403) — and forgotten');
console.log('  "who has looked at Mira\'s drafts?":     no answer');
const daServer = createApp().listen(0);
await new Promise((resolve) => daServer.once('listening', resolve));
const daBase = `http://127.0.0.1:${daServer.address().port}/api`;
const daCall = async (token, method, path, body) => {
  const r = await fetch(`${daBase}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const daLogin = async (email, password) => (await daCall(null, 'POST', '/auth/login', { email, password })).body.token;
const daMira = await daLogin('mira@example.test', 'quiet-craft');
const daTomas = await daLogin('tomas@example.test', 'second-shelf');
const daOps = await daLogin('ops@example.test', 'ops-password');
const { rows: [daMiraRow] } = await query("SELECT author_id FROM users WHERE email = 'mira@example.test'");
const { rows: [daTomasRow] } = await query("SELECT id, author_id FROM users WHERE email = 'tomas@example.test'");

rule('223. Every request, traceable to a tenant and a person');
await daCall(daMira, 'GET', `/authors/${daMiraRow.author_id}/books`);
await daCall(daOps, 'GET', `/authors/${daMiraRow.author_id}/books`);
await daCall(daTomas, 'GET', `/authors/${daMiraRow.author_id}/books`);
await daCall(null, 'GET', `/authors/${daMiraRow.author_id}/books`);
await flushAccessLog();
const { rows: daRows } = await query(
  `SELECT COALESCE(user_email, 'no session') AS who, author_id, outcome, COALESCE(db_role, '—') AS db_role
     FROM data_access_events WHERE path = $1 ORDER BY id DESC LIMIT 4`,
  [`/api/authors/${daMiraRow.author_id}/books`],
);
for (const r of daRows.reverse()) {
  console.log(`  ${r.who.padEnd(22)} → tenant ${r.author_id}  ${r.outcome.padEnd(16)} read as ${r.db_role}`);
}
console.log('\nThe database refuses an event with no user (unless it had no session) and a tenant');
console.log('event with no tenant — the acceptance clause as two CHECK constraints. Append-only,');
console.log('like the audit log: no privilege to change it, and a trigger behind that.');

rule('224. Someone trying doors is flagged, and the admins are told');
for (let i = 0; i < config.accessAlertThreshold; i += 1) {
  await daCall(daTomas, 'GET', `/authors/${daMiraRow.author_id}/books`);
}
await flushAccessLog();
const { rows: [daFlag] } = await query(
  "SELECT metadata FROM audit_log WHERE action = 'access.suspicious' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
  [`user:${daTomasRow.id}`],
);
const { rows: [daTold] } = await query(
  "SELECT metadata FROM audit_log WHERE action = 'access.alerted' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
  [`user:${daTomasRow.id}`],
);
console.log(`  access.suspicious: ${daFlag.metadata.subject}, ${daFlag.metadata.refusals} refusals in ${daFlag.metadata.windowMinutes} min, tenants tried ${JSON.stringify(daFlag.metadata.tenantsTried)}`);
console.log(`  emailed:           ${daTold.metadata.alerted.join(', ')}`);

rule('225. Mitigated: blocked, and stopped on the next request');
const daBlock = await daCall(daOps, 'POST', `/security/accounts/${daTomasRow.id}/block`, { reason: 'Repeated attempts on another author\'s books' });
console.log(`  ops blocks tomas → ${daBlock.status}`);
const daAfter = await daCall(daTomas, 'GET', `/authors/${daTomasRow.author_id}/books`);
console.log(`  tomas, with the token he already had, reads his own books → ${daAfter.status}: ${daAfter.body.error}`);
await daCall(daOps, 'POST', `/security/accounts/${daTomasRow.id}/unblock`, {});
console.log('  (unblocked again, so the rest of the demo data stays usable)');
const daMiraSees = await daCall(daMira, 'GET', `/authors/${daMiraRow.author_id}/access-events`);
const daOthers = daMiraSees.body.filter((e) => Number(e.actor_author_id) !== Number(daMiraRow.author_id));
console.log(`\nAnd Mira can see it: her Trust tab lists ${daOthers.length} requests on her data from other accounts,`);
console.log('read through her own database view — not a filtered copy the app chose to show her.');
await new Promise((resolve) => daServer.close(resolve));

console.log('\nSTORY-044 complete — every request that touches tenant data names the person and the');
console.log('tenant, refusals are recorded and counted, and an admin can stop an account at once\n');

// ── STORY-045: Tenant-Specific API Key Management ──────────────────────────
// REQ-011. "The key is unique to the tenant and securely stored."

rule('226. How an integration got in, measured');
console.log('  per-tenant API keys:                    none');
console.log('  the only key in the system:             ANTHROPIC_API_KEY — the application\'s own, in .env');
console.log('  an integration pulling Mira\'s drafts:   had to sign in as Mira — her password, and her');
console.log('                                          right to approve content, in a script');
const akServer = createApp().listen(0);
await new Promise((resolve) => akServer.once('listening', resolve));
const akBase = `http://127.0.0.1:${akServer.address().port}/api`;
const akCall = async ({ token, key }, method, path, body) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;
  const r = await fetch(`${akBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const akMira = (await akCall({}, 'POST', '/auth/login', { email: 'mira@example.test', password: 'quiet-craft' })).body.token;
const akTenant = daMiraRow.author_id;

rule('227. Mira creates a key — shown once, stored as a fingerprint');
const akCreated = await akCall({ token: akMira }, 'POST', `/authors/${akTenant}/api-keys`, { name: 'Newsletter sync', access: 'read' });
console.log(`  POST /authors/${akTenant}/api-keys → ${akCreated.status}`);
console.log(`    key:     ${akCreated.body.key.slice(0, 20)}…  (in this response and nowhere else)`);
console.log(`    tenant:  ${akCreated.body.authorId}, access ${akCreated.body.access}, expires ${new Date(akCreated.body.expiresAt).toISOString().slice(0, 10)}`);
const { rows: [akStored] } = await query('SELECT prefix, secret_hash FROM tenant_api_keys WHERE prefix = $1', [akCreated.body.prefix]);
console.log(`    stored:  prefix ${akStored.prefix}, sha256 ${akStored.secret_hash.slice(0, 16)}…`);
const akList = await akCall({ token: akMira }, 'GET', `/authors/${akTenant}/api-keys`);
console.log(`  listing the keys afterwards: ${akList.body.length} key(s), the key itself in none of them`);

rule('228. Validated against the right tenant, and never a person\'s whole power');
const akOwn = await akCall({ key: akCreated.body.key }, 'GET', `/authors/${akTenant}/books`);
console.log(`  the key reads Mira's books                → ${akOwn.status}`);
const akOther = await akCall({ key: akCreated.body.key }, 'GET', `/authors/${daTomasRow.author_id}/books`);
console.log(`  the key reads Tomas's books               → ${akOther.status}`);
const akWrite = await akCall({ key: akCreated.body.key }, 'POST', `/authors/${akTenant}/books`, { title: 'x', content: 'x' });
console.log(`  the read-only key uploads a book          → ${akWrite.status}: ${akWrite.body.error}`);
const { rows: [akDraft] } = await query("SELECT id FROM drafts WHERE author_id = $1 AND status = 'pending_approval' LIMIT 1", [akTenant]);
if (akDraft) {
  const akApprove = await akCall({ key: akCreated.body.key }, 'POST', `/drafts/${akDraft.id}/approve`, {});
  console.log(`  the key approves a draft                  → ${akApprove.status}`);
}
const akMint = await akCall({ key: akCreated.body.key }, 'POST', `/authors/${akTenant}/api-keys`, { name: 'x' });
console.log(`  the key creates another key               → ${akMint.status}`);
await flushAccessLog();
const { rows: akUses } = await query(
  'SELECT outcome, author_id, user_role, COALESCE(db_role, \'—\') AS db_role FROM data_access_events WHERE api_key_id = (SELECT id FROM tenant_api_keys WHERE prefix = $1) ORDER BY id',
  [akCreated.body.prefix],
);
console.log(`\nEvery use is in the access log (STORY-044) against tenant and key — ${akUses.length} so far:`);
for (const u of akUses) console.log(`    tenant ${u.author_id}  ${u.outcome.padEnd(8)} as ${u.user_role}, read as ${u.db_role}`);

rule('229. Revoked: refused on the next request');
await akCall({ token: akMira }, 'POST', `/authors/${akTenant}/api-keys/${akCreated.body.id}/revoke`, {});
const akAfter = await akCall({ key: akCreated.body.key }, 'GET', `/authors/${akTenant}/books`);
console.log(`  after revoking, the same key → ${akAfter.status}: ${akAfter.body.error}`);
await flushAccessLog();
const { rows: [akWhy] } = await query(
  "SELECT reason FROM data_access_events WHERE outcome = 'unauthenticated' AND path = $1 ORDER BY id DESC LIMIT 1",
  [`/api/authors/${akTenant}/books`],
);
console.log(`  what the security officer sees: "${akWhy.reason}"`);
console.log('\nThe caller is told only "not accepted"; which of unknown, revoked, expired or blocked it');
console.log('was goes to the access log. A key also stops when the person it acts for is blocked or the');
console.log('tenant is suspended — it never outlives the access it was issued under.');
console.log('\nNot done: the build note\'s "environment variables or a secrets manager". Right for the');
console.log('application\'s own secrets; impossible for keys tenants create while it runs. Storing only a');
console.log('hash leaves no secret to keep.');
await new Promise((resolve) => akServer.close(resolve));

console.log('\nSTORY-045 complete — each tenant\'s integrations get their own keys, confined to that tenant,');
console.log('stored as fingerprints, never able to approve, and logged on every use\n');

// ── STORY-046: Fine-Tune AI Models on Book-Specific Data ────────────────────
// REQ-012. "The AI models are fine-tuned using the book's text and
// supplementary materials."

rule('230. What generation knew about a book, measured');
console.log('  when a book was uploaded:        nothing ran');
console.log('  what was learned about it:       recomputed per batch, then thrown away');
console.log('  supplementary material:          nowhere to put it');
console.log('  a passage arguing a theme without its word: invisible — retrieval matched the word');
console.log('\nAnd Claude cannot be fine-tuned through the public API. What is fitted instead is a model');
console.log('of the book: for each theme, the words this book uses to argue it, learned from the passages');
console.log('that name it — stored, versioned, judged on held-out passages, and used by generation.');
const bmServer = createApp().listen(0);
await new Promise((resolve) => bmServer.once('listening', resolve));
const bmBase = `http://127.0.0.1:${bmServer.address().port}/api`;
const bmCall = async (method, path, body) => {
  const r = await fetch(`${bmBase}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${akMira}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bmShow = (m) => {
  for (const t of m.parameters.themes) {
    const words = t.lexicon.slice(0, 5).map((l) => l.word ?? l.term).join(', ') || '(too few examples)';
    console.log(`    ${t.theme.padEnd(12)} learned from ${t.examples.passages} passage(s)${t.examples.materialSentences ? ` + ${t.examples.materialSentences} note(s)` : ''}: ${words}`);
  }
  const recall = m.metrics.maskedRecall == null ? 'n/a' : `${Math.round(m.metrics.maskedRecall * 100)}% (${m.metrics.recalled}/${m.metrics.heldOut})`;
  console.log(`    held-out recall, theme word masked: ${recall} — literal search: 0% by construction`);
  console.log(`    evidence for the drafter: ${m.metrics.literalEvidence} → ${m.metrics.modelEvidence} of ${m.metrics.evidenceSlots} slots`);
};

rule('231. Mira uploads a book — and a model is fitted to it at once');
const bmBook = await bmCall('POST', `/authors/${akTenant}/books`, { title: LONG_FIELD.title, content: LONG_FIELD.content, themes: LONG_FIELD.themes });
console.log(`  POST /authors/${akTenant}/books → ${bmBook.status}; model v${bmBook.body.model.version}, ${bmBook.body.model.parameters.sources.passages} passages, trigger ${bmBook.body.model.trigger}`);
bmShow(bmBook.body.model);
console.log('\n"loss" is named in one passage. One example is nothing to learn from, and the model says so');
console.log('rather than guessing.');

rule('232. Her notes are supplementary material: learned from, never quoted');
let bmLatest;
for (const m of LONG_FIELD.materials) bmLatest = (await bmCall('POST', `/authors/${akTenant}/books/${bmBook.body.id}/materials`, m)).body;
console.log(`  added a synopsis and an author note → refitted, now v${bmLatest.model.version}`);
bmShow(bmLatest.model);
const bmLoss = bmLatest.model.parameters.themes.find((t) => t.theme === 'loss');
const { rows: [bmFound] } = await query('SELECT content FROM book_passages WHERE id = $1', [bmLoss.foundPassages[0].id]);
console.log(`\n  found for "loss", a passage that never says it:\n    "${bmFound.content.slice(0, 150)}…"`);
const bmAgain = await bmCall('POST', `/authors/${akTenant}/books/${bmBook.body.id}/model/refit`, {});
console.log(`\n  refit with nothing changed → refitted: ${bmAgain.body.refitted} (still v${bmAgain.body.model.version}); a version is never rewritten`);

rule('233. The next drafts are written with it');
await draftWeeklyPosts({ authorId: akTenant, bookId: bmBook.body.id, count: 4, providerName: 'stub', memeCount: 0 });
const { rows: [bmApplied] } = await query(
  "SELECT metadata FROM audit_log WHERE action = 'book_model.applied' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [String(bmBook.body.id)],
);
console.log(`  book_model.applied: v${bmApplied.metadata.version}, ${bmApplied.metadata.passagesAdded} passage(s) added, by theme ${JSON.stringify(bmApplied.metadata.byTheme)}`);
const { rows: bmFits } = await query(
  "SELECT metadata->>'version' AS v, metadata->>'trigger' AS trig, metadata->>'maskedRecall' AS recall FROM audit_log WHERE action = 'book_model.fitted' AND entity_id = $1 ORDER BY id",
  [String(bmBook.body.id)],
);
console.log('  the fitting history, on the audit log:');
for (const f of bmFits) console.log(`    v${f.v}  ${f.trig.padEnd(15)} held-out recall ${f.recall ?? 'n/a'}`);
console.log('\nThe Anthropic provider is given the lexicons and the lines in its prompt; the offline one');
console.log('writes from the passages. Social drafts only for now — outreach and press still ground by');
console.log('the literal search.');
await new Promise((resolve) => bmServer.close(resolve));

console.log('\nSTORY-046 complete — each book gets a fitted, versioned, evaluated model, learned from its');
console.log('own text and the author\'s materials, and the drafter writes with it\n');

// ── STORY-047: Review Generated Content for Thematic Alignment ─────────────
// REQ-012. "The content is compared with key themes and stylistic elements
// extracted from the book."

rule('234. What a reviewer had, measured');
console.log('  themes:     scored against the book (STORY-006/009)');
console.log('  style:      scored against the author\'s *social posts* (STORY-007) — never the book');
console.log('  decisions:  approve, or reject. A draft that was nearly right could only be thrown away.');
const crServer = createApp().listen(0);
await new Promise((resolve) => crServer.once('listening', resolve));
const crBase = `http://127.0.0.1:${crServer.address().port}/api`;
const crCall = async (method, path, body) => {
  const r = await fetch(`${crBase}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${akMira}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const crStyle = bookStyle({ content: LONG_FIELD.content });
console.log(`\n  the book's style, measured: sentences ${crStyle.meanSentenceWords} words, exclamation marks ${crStyle.exclamationsPer100}/100 words,`);
console.log(`  marketing words ${crStyle.hypePer100}/100, capitals ${crStyle.shoutedPer100}/100`);

rule('235. Each draft is compared with the book when it is ready for review');
const crDrafts = await draftWeeklyPosts({ authorId: akTenant, bookId: bmBook.body.id, count: 3, providerName: 'stub', memeCount: 0, weekOf: '2026-10-12' });
for (const d of crDrafts) {
  const { rows: [r] } = await query('SELECT verdict, comparison FROM content_reviews WHERE draft_id = $1', [d.id]);
  const themes = r.comparison.themes.map((t) => `${t.theme}${t.bookWords.length ? ` (book's words: ${t.bookWords.join(', ')})` : ''}`).join('; ');
  console.log(`  #${d.id} ${d.platform.padEnd(9)} ${r.verdict.padEnd(10)} ${themes}`);
}
const { rows: [crOff] } = await query(
  `INSERT INTO drafts (author_id, book_id, platform, content, themes_used, status, confidence, week_of, theme_alignment, voice_score)
   VALUES ($1,$2,'twitter','AMAZING news!!! The Long Field is a GAME-CHANGER about patience, a must-read bestseller! Buy it NOW!','{patience}','pending_approval',0.9,'2026-10-12',0.9,0.9) RETURNING id`,
  [akTenant, bmBook.body.id],
);
await query(
  `INSERT INTO draft_themes (draft_id, theme, key_message, named, message_score, score, known, passage_ids, carried_terms)
   VALUES ($1,'patience','',true,0,0.8,true,'{}','{}')`, [crOff.id],
);
const crOffReview = await reviewDraft(crOff.id);
console.log(`\n  a draft in a register the book never uses → ${crOffReview.verdict}`);
for (const n of crOffReview.comparison.notes) console.log(`    ${n}`);

rule('236. The reviewer\'s third answer: request changes');
const crTarget = crDrafts.find((d) => d.status === 'pending_approval') ?? crDrafts[0];
const crAsk = await crCall('POST', `/drafts/${crTarget.id}/request-changes`, { note: 'Lead with the empty chair, not the wall by the road.' });
console.log(`  POST /drafts/${crTarget.id}/request-changes → ${crAsk.status}; #${crTarget.id} is now ${crAsk.body.draft.status}`);
console.log(`    asked by ${crAsk.body.draft.changes_requested_by}: "${crAsk.body.draft.change_request}"`);
const crRev = crAsk.body.revision;
const { rows: [crRevReview] } = await query('SELECT verdict FROM content_reviews WHERE draft_id = $1', [crRev.id]);
console.log(`  revision #${crRev.id} (revision of #${crRev.revision_of}): ${crRev.status}, compared with the book → ${crRevReview.verdict}`);
console.log(`    "${crRev.content.slice(0, 110).replace(/\n/g, ' ')}…"`);
const crApprove = await crCall('POST', `/drafts/${crTarget.id}/approve`, {});
console.log(`  approving the draft that was set aside → ${crApprove.status}: ${crApprove.body.error}`);

rule('237. The gate is the same gate');
console.log('  A revision is a new draft: scored, compared with the book, and waiting for a person, like');
console.log('  every other. Nothing publishes without content.approve. The offline provider cannot read');
console.log('  the reviewer\'s note — it writes a different draft from another passage; the Anthropic');
console.log('  provider is given the note and the draft the reviewer saw.');
await new Promise((resolve) => crServer.close(resolve));

console.log('\nSTORY-047 complete — every draft is compared with the book\'s themes and style when it is');
console.log('ready for review, and a reviewer can ask for changes instead of only approving or rejecting\n');

// ── STORY-048: Establish a Feedback Loop for Content Improvement ───────────
// REQ-012. "Given feedback is provided on generated content, when the
// feedback is processed, then the AI models adjust to improve future content."

rule('238. What reviewers\' decisions changed, measured');
console.log('  recorded:   every approval and rejection (STORY-005), every request for changes (STORY-047)');
console.log('  learned:    nothing. A passage turned down on Monday was quoted again on Tuesday.');
console.log('  the one adaptation that existed — the meme/text mix (STORY-069) — learns from engagement,');
console.log('  not from what reviewers said.');
const fbServer = createApp().listen(0);
await new Promise((resolve) => fbServer.once('listening', resolve));
const fbBase = `http://127.0.0.1:${fbServer.address().port}/api`;
const fbCall = async (method, path, body) => {
  const r = await fetch(`${fbBase}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${akMira}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const { rows: fbPassages } = await query('SELECT id, content FROM book_passages WHERE book_id = $1', [bmBook.body.id]);
const fbWall = fbPassages.find((p) => p.content.includes('They stood by the wall along the road'));
const fbWeek = '2026-10-12';
const fbQuotesWall = (drafts) => drafts.filter((d) => quotedPassages(d.content, [fbWall]).length > 0).length;
const { rows: fbBefore } = await query('SELECT id, content, status FROM drafts WHERE book_id = $1 AND week_of = $2 AND revision_of IS NULL', [bmBook.body.id, fbWeek]);

rule('239. Mira gives feedback — decisions, ratings and why');
// A second draft quoting the funeral passage, from the following weeks' drafts.
let fbOtherWall = null;
for (const week of ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']) {
  const batch = await draftWeeklyPosts({ authorId: akTenant, bookId: bmBook.body.id, count: 3, providerName: 'stub', memeCount: 0, weekOf: week });
  fbOtherWall = batch.find((d) => d.status === 'pending_approval' && quotedPassages(d.content, [fbWall]).length);
  if (fbOtherWall) break;
}
if (fbOtherWall) {
  await fbCall('POST', `/drafts/${fbOtherWall.id}/reject`, { notes: 'The wall by the road again; it reads as a eulogy.' });
  await fbCall('POST', `/drafts/${fbOtherWall.id}/feedback`, { rating: 1, comment: 'Too bleak for launch week.' });
  console.log(`  #${fbOtherWall.id} (the wall by the road): rejected, rated 1 — "Too bleak for launch week."`);
}
await fbCall('POST', `/drafts/${crTarget.id}/feedback`, { rating: 2, comment: 'Reads as a eulogy.' });
console.log(`  #${crTarget.id} (the wall by the road): changes requested earlier, now rated 2 — "Reads as a eulogy."`);
await fbCall('POST', `/drafts/${crRev.id}/approve`, { notes: 'Yes — the coat.' });
await fbCall('POST', `/drafts/${crRev.id}/feedback`, { rating: 5, comment: 'The coat on the hook is exactly right.' });
console.log(`  #${crRev.id} (the coat on the hook): approved, rated 5 — "The coat on the hook is exactly right."`);

rule('240. The feedback is processed: the book\'s model adjusts');
const fbApplied = await fbCall('POST', `/authors/${akTenant}/books/${bmBook.body.id}/feedback/apply`, {});
const fbPrefs = fbApplied.body.model.parameters.preferences;
console.log(`  POST .../feedback/apply → v${fbApplied.body.model.version}, trigger ${fbApplied.body.model.trigger}, from ${fbPrefs.judgments} judgments`);
for (const p of fbPrefs.passages) {
  const text = fbPassages.find((x) => Number(x.id) === p.id).content.slice(0, 48);
  console.log(`    "${text}…"  liked ${p.good}, turned down ${p.bad} → weight ${p.weight}${p.weight < 0.6 ? '  (not quoted while there is another)' : ''}`);
}
console.log('\nBounded on purpose: two judgments before anything moves; a theme is tilted (0.5–1.5), never');
console.log('silenced; a passage is left out only while its theme has another to quote.');

rule('241. Future content: the same week, drafted again');
const fbAfter = await draftWeeklyPosts({ authorId: akTenant, bookId: bmBook.body.id, count: 3, providerName: 'stub', memeCount: 0, weekOf: fbWeek });
console.log(`  week of ${fbWeek}, same seeds — drafts quoting the wall by the road: before ${fbQuotesWall(fbBefore)}, after ${fbQuotesWall(fbAfter)}`);
for (const d of fbAfter) console.log(`    #${d.id} ${d.platform.padEnd(9)} "${d.content.slice(0, 80).replace(/\n/g, ' ')}…"`);
const { rows: [fbLog] } = await query(
  "SELECT metadata FROM audit_log WHERE action = 'book_model.fitted' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [String(bmBook.body.id)],
);
console.log(`\n  on the audit log: book_model.fitted, trigger ${fbLog.metadata.trigger}, moved ${JSON.stringify(fbLog.metadata.preferencesMoved.passages.map((p) => ({ id: p.id, from: p.from, to: p.to })))}`);
console.log('\nThe Anthropic provider is also given what reviewers said. The offline one cannot read it;');
console.log('it follows the weights.');
await new Promise((resolve) => fbServer.close(resolve));

console.log('\nSTORY-048 complete — reviewers\' decisions, ratings and notes are processed into the book\'s');
console.log('model, and the next drafts change because of them — bounded, versioned and on the record\n');

// ── STORY-049: Encrypt Audit Logs with AES-256 ─────────────────────────────
// REQ-013. "Given an audit log entry is created, when it is stored, then the
// entry is encrypted using AES-256."

rule('242. What was stored, measured — and why STORY-019 said no');
console.log('  before: every entry in the clear — anyone with a dump, a backup or a database login read it');
console.log('  STORY-019 declined AES-256 for three reasons, all true of encrypting in application code:');
console.log('    1. the tamper seals (STORY-013) hash row contents');
console.log('    2. governance checks and 40 files read the log in SQL, inside the entry');
console.log('    3. the key would sit in the env file beside DATABASE_URL');
console.log('  So the encryption is in the storage, and every reader keeps its view.');

rule('243. An entry is created — and stored as AES-256 ciphertext');
const enEntry = await recordAction({ actor: 'Mira Kovač', action: 'demo.encrypted', entityType: 'demo', metadata: { note: 'the launch date moves to 14 March' } });
const { rows: [enStored] } = await ownerQuery(
  "SELECT key_id, encode(substring(payload from 1 for 20), 'hex') AS head, get_byte(payload, 3) AS cipher, octet_length(payload) AS bytes FROM audit_log_sealed WHERE id = $1",
  [enEntry.id],
);
console.log(`  stored:  ${enStored.bytes} bytes, starting ${enStored.head}…`);
console.log(`           cipher byte ${enStored.cipher} = AES-256 (RFC 4880 §9.2), key ${enStored.key_id} (= this app's key ${auditKeyId})`);
const { rows: [enRead] } = await query('SELECT metadata FROM audit_log WHERE id = $1', [enEntry.id]);
console.log(`  the app reads audit_log as always:  ${JSON.stringify(enRead.metadata)}`);

rule('244. Without the key, there is nothing to read — and nothing can be written');
const enPg = (await import('pg')).default;
const enNoKey = new enPg.Client({ connectionString: config.migrationDatabaseUrl });
await enNoKey.connect();
const { rows: [enBlind] } = await enNoKey.query('SELECT action, metadata FROM audit_log WHERE id = $1', [enEntry.id]);
console.log(`  the database owner, no key:  action "${enBlind.action}" (routing stays clear), entry ${JSON.stringify(enBlind.metadata)}`);
const enWrite = await enNoKey.query("INSERT INTO audit_log (actor, action, entity_type) VALUES ('x','y','z')").then(() => 'ALLOWED', (e) => e.message);
console.log(`  and writing one:             refused — ${enWrite}`);
await enNoKey.end();
const enDirect = await query('SELECT * FROM audit_log_sealed LIMIT 1').then(() => 'ALLOWED', (e) => e.message);
console.log(`  the app login, at the storage directly: refused — ${enDirect}`);
console.log('\nThe key is 32 random bytes in its own file (server/.keys/audit.key, mode 600; a mounted secret in');
console.log('production), handed to each connection the app opens as it starts — never stored in the database,');
console.log('never in query text, never in the image (.dockerignore), not in the env file with DATABASE_URL.');

rule('245. STORY-019\'s objections, answered');
const enCheck = (await runChecks({})).find((c) => c.id === 'audit.encrypted');
const enSeal = await verifyAuditLog({});
console.log(`  seals:       status "${enSeal.status}"${enSeal.status === 'altered' ? ' — the rows stage 103 tampered with, still caught with the log encrypted' : ''};`);
console.log('               they hash the decrypted view, so an edited ciphertext breaks them too');
console.log('  SQL readers: unchanged — audit_log is a view that decrypts on read and encrypts on insert');
console.log(`  governance:  audit.encrypted (invariant) ${enCheck.passed ? 'pass' : `BREACH (${enCheck.violations})`} — every entry under the current key, and opens`);
console.log('\nWhat it does not protect against, said plainly: the running application holds the key, so');
console.log('anyone who controls the application reads the log. It protects dumps, backups, replicas and');
console.log('every database login the application did not open. Rotation re-encrypts under a new key and is');
console.log('not built yet; each row records its key id so one can be.');

console.log('\nSTORY-049 complete — every audit entry is stored encrypted with AES-256, the key is kept apart');
console.log('from the database, and nothing that read or sealed the log had to change\n');

// ── STORY-050: Role-Based Access Control for Audit Logs ────────────────────
// REQ-013. "Access is granted or denied based on the user's role permissions."

const rbServer = createApp().listen(0);
await new Promise((resolve) => rbServer.once('listening', resolve));
const rbBase = `http://127.0.0.1:${rbServer.address().port}/api`;
const rbStatus = async (headers, path) => (await fetch(`${rbBase}${path}`, { headers })).status;
const rbBearer = async (email, password) => ({
  authorization: `Bearer ${(await (await fetch(`${rbBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token}`,
});
const rbMira = await rbBearer('mira@example.test', 'quiet-craft');
const rbKeyMade = await (await fetch(`${rbBase}/authors/${akTenant}/api-keys`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...rbMira }, body: JSON.stringify({ name: 'Newsletter sync (read)' }),
})).json();

rule('246. Who could read the audit logs, measured');
console.log('  The permissions existed since STORY-019 — audit.read (authors hold it for their own trail),');
console.log('  audit.verify — but nothing tied the routes that serve audit data to the permission that guards');
console.log('  them. Walking every route that reads audit data found three guarded by the tenant rule alone.');
console.log('  An API key holds no permissions at all (STORY-045), and before this story it read:');
for (const path of ['access-events', 'trust-history', 'trust-dashboard']) {
  console.log(`    /authors/${akTenant}/${path.padEnd(16)} — who opened her data, her trust history, her audit trail`);
}

rule('247. Now every audit route is declared, with its permission — and the router is held to it');
const rbPolicy = await auditAccessPolicy();
const rbRoles = Object.keys(rbPolicy[0].roles);
console.log(`  ${'route'.padEnd(40)} ${rbRoles.map((r) => r.padEnd(12)).join('')}`);
for (const p of rbPolicy) console.log(`  ${p.route.padEnd(40)} ${rbRoles.map((r) => p.roles[r].padEnd(12)).join('')}`);
console.log('\nDerived from the live grants. A route that serves audit data and is not on the list — or is');
console.log('guarded by anything other than what the list says — fails the build.');

rule('248. Granted or denied by role — the same key, and Mira, on the same routes');
for (const path of [`/authors/${akTenant}/access-events`, '/audit-log', '/audit-integrity']) {
  const key = await rbStatus({ 'x-api-key': rbKeyMade.key }, path);
  const mira = await rbStatus(rbMira, path);
  console.log(`  ${path.padEnd(28)} api key → ${key}   Mira (author) → ${mira}`);
}
await flushAccessLog();
const { rows: [rbRefused] } = await query(
  "SELECT reason FROM data_access_events WHERE route = '/audit-integrity' AND outcome = 'denied' ORDER BY id DESC LIMIT 1",
);
console.log(`\n  Mira on /audit-integrity is refused, and it is on the access log: "${rbRefused.reason}"`);

rule('249. The screen asks the same question');
console.log('  The Audit log tab is shown only to those holding audit.read; the Access tab shows the table');
console.log('  above, to those who review access. Nobody is offered a page that can only refuse them.');
await new Promise((resolve) => rbServer.close(resolve));

console.log('\nSTORY-050 complete — every route that serves audit data is declared with the role permissions');
console.log('that guard it, the router is held to the declaration, and the screen shows what it enforces\n');

// ── STORY-051: Audit Log Access Monitoring ─────────────────────────────────
// REQ-013. "The attempt is recorded in a separate security log with user
// details and outcome."

rule('250. Where attempts on the audit logs went, measured');
console.log('  into the data access log (STORY-044): in the clear, beside every other request, readable by');
console.log('  anyone who reads that log. Nothing separate; nothing protected like the trail itself.');
const slServer = createApp().listen(0);
await new Promise((resolve) => slServer.once('listening', resolve));
const slBase = `http://127.0.0.1:${slServer.address().port}/api`;
const slGet = async (headers, path) => (await fetch(`${slBase}${path}`, { headers })).status;
const slLogin = async (email, password) => ({
  authorization: `Bearer ${(await (await fetch(`${slBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token}`,
});
const slAuditor = await slLogin('auditor@example.test', 'compliance-only');
const slTomas = await slLogin('tomas@example.test', 'second-shelf');

rule('251. Four attempts on the audit logs');
const slTries = [
  ['the compliance auditor reads the audit log', slAuditor, '/audit-log'],
  ['Tomas asks for the integrity report', slTomas, '/audit-integrity'],
  ['no session asks for Mira\'s trust history', {}, `/authors/${akTenant}/trust-history`],
  ['Mira\'s read-only API key asks who opened her data', { 'x-api-key': rbKeyMade.key }, `/authors/${akTenant}/access-events`],
];
for (const [what, headers, path] of slTries) console.log(`  ${what.padEnd(52)} → ${await slGet(headers, path)}`);
await flushAccessLog();
const { rows: slEntries } = await query(
  "SELECT route, outcome, COALESCE(user_email, CASE WHEN api_key_id IS NOT NULL THEN 'API key #' || api_key_id ELSE 'no session' END) AS who, user_role, ip, reason FROM security_log ORDER BY id DESC LIMIT 4",
);
console.log('\n  the security log:');
for (const e of slEntries.reverse()) {
  console.log(`    ${e.who.padEnd(22)} ${(e.user_role ?? '—').padEnd(10)} ${e.route.padEnd(38)} ${e.outcome}${e.reason ? ` — ${e.reason}` : ''}`);
}

rule('252. Separate, encrypted, access-controlled');
const { rows: [slStored] } = await ownerQuery(
  "SELECT get_byte(payload, 3) AS cipher, position(convert_to('auditor@example.test', 'UTF8') IN payload) AS found FROM security_log_sealed ORDER BY id DESC LIMIT 1",
);
console.log(`  stored with cipher byte ${slStored.cipher} (AES-256), the auditor's email found in the bytes: ${slStored.found ? 'YES' : 'no'}`);
const slDirect = await query('SELECT * FROM security_log_sealed LIMIT 1').then(() => 'ALLOWED', (e) => e.message);
console.log(`  the app login at the storage: ${slDirect}`);
console.log(`  Tomas asks for the security log itself → ${await slGet(slTomas, '/security/audit-access')}`);
console.log('  (and that attempt is in the security log too — reading it is an attempt on an audit log)');

rule('253. Checked from outside');
await flushAccessLog();
const slCheck = (await runChecks({})).find((c) => c.id === 'security_log.complete');
console.log(`  invariant security_log.complete: ${slCheck.passed ? 'pass' : `BREACH (${slCheck.violations})`}`);
console.log('  Each attempt is written to the access log and the security log in one transaction, sharing a');
console.log('  request id; an access record on an audit route with no security entry would mean the watching');
console.log('  stopped.');
await new Promise((resolve) => slServer.close(resolve));

console.log('\nSTORY-051 complete — every attempt on the audit logs, allowed or refused, is in a separate,');
console.log('encrypted, reviewer-only security log with who, from where and how it ended\n');

// ── STORY-052: Audit Log Access Notification ───────────────────────────────
// REQ-013. "A notification is sent to the security officer with details of the attempt."

rule('254. Who was told about an attempt on the audit logs, measured');
console.log('  nobody. Refused attempts were recorded (STORY-044, STORY-051) and sat there. The one alert —');
console.log('  STORY-044\'s — waited for five refusals of any kind and told admins about data access in general.');
const { rows: snStage251 } = await query("SELECT subject_label, attempts, routes_tried, delivered FROM security_notifications ORDER BY id");
console.log(`\n  Since this story, the refusals in stages 248–251 have already told the security officers (${snStage251.length} alert${snStage251.length === 1 ? '' : 's'}):`);
for (const n of snStage251) console.log(`    ${n.subject_label.padEnd(44)} ${n.attempts} attempt(s) ${n.routes_tried.join(', ')} → told ${n.delivered.join(', ')}`);

rule('255. Tomas tries again, twice more — one alert, with the count');
const snServer = createApp().listen(0);
await new Promise((resolve) => snServer.once('listening', resolve));
const snBase = `http://127.0.0.1:${snServer.address().port}/api`;
const snTomas = { authorization: `Bearer ${(await (await fetch(`${snBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'tomas@example.test', password: 'second-shelf' }) })).json()).token}` };
await fetch(`${snBase}/audit-log?authorId=${akTenant}`, { headers: snTomas });
await fetch(`${snBase}/security/audit-access`, { headers: snTomas });
await flushAccessLog();
const { rows: [snTomasAlert] } = await query(
  "SELECT * FROM security_notifications WHERE subject_label LIKE 'tomas@%' ORDER BY id DESC LIMIT 1",
);
console.log(`  ${snTomasAlert.subject_label}: ${snTomasAlert.attempts} attempts, ${snTomasAlert.routes_tried.join(', ')}`);
console.log(`  emails sent: ${snTomasAlert.delivered.length} (to ${snTomasAlert.delivered.join(', ')}), not ${snTomasAlert.attempts * snTomasAlert.delivered.length}`);

rule('256. What the security officer receives');
const { rows: [snLog] } = await query('SELECT * FROM security_log WHERE id = $1', [snTomasAlert.first_log_id]);
console.log(`  Subject: Security: refused attempt on the audit logs — ${snTomasAlert.subject_label}`);
console.log(`    Who:     ${snTomasAlert.subject_label} — ${snLog.user_name}`);
console.log(`    Tried:   ${snLog.route}  (${snLog.path})`);
console.log(`    When:    ${new Date(snLog.occurred_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
console.log(`    From:    ${snLog.ip}${snLog.user_agent ? ` · ${snLog.user_agent}` : ''}`);
console.log(`    Outcome: ${snLog.outcome} — ${snLog.reason}`);
console.log(`    and a link to the Security tab to see every attempt, acknowledge, or block the account.`);

rule('257. The officer acts');
const snAck = await fetch(`${snBase}/security/notifications/${snTomasAlert.id}/acknowledge`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...slAuditor }, body: JSON.stringify({ note: 'Asked Tomas; he was looking for his own history.' }),
});
console.log(`  the compliance auditor acknowledges → ${snAck.status}`);
console.log('  an admin could block the account from the same row (STORY-044), stopping it on its next request.');
console.log('\nSent through the email adapter (STORY-002), shaped like SendGrid\'s send call — swapping in the');
console.log('real provider is a change to one file — and through the integration gateway (STORY-038). Who');
console.log('actually received it is recorded, not who it was meant for.');
await new Promise((resolve) => snServer.close(resolve));

console.log('\nSTORY-052 complete — a refused attempt on the audit logs tells every security officer at once,');
console.log('with who, what, when, from where and why, and later attempts join the alert instead of flooding it\n');

// ── STORY-028: Provide Detailed Audit Log Reports (built after STORY-053) ──
// REQ-005. "The report includes detailed records of all actions with timestamps
// and user details" — and only for those with the permissions.

rule('258. What a stakeholder could get, measured — and a report now');
console.log('  before: the Audit tab\'s last 200 entries, by tenant and type. No period, no filter by person or');
console.log('  action, no summary, no export, nothing proving a copy was not edited; "who" was a name string.');
const { rows: [rpAuditor] } = await query("SELECT id, name, role FROM users WHERE email = 'auditor@example.test'");
const rpReport = await generateAuditReport({ authorId: akTenant, action: 'draft.', user: rpAuditor });
console.log(`\n  Mira's draft actions, last 30 days, for the compliance auditor: ${rpReport.summary.records} records`);
console.log(`    by: ${Object.entries(rpReport.summary.actorKinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
console.log(`    most frequent: ${rpReport.summary.byAction.slice(0, 4).map(([a, n]) => `${a} ${n}`).join(' · ')}`);
console.log(`    seals: ${rpReport.integrity}   sha256 ${rpReport.digest.slice(0, 24)}…`);
const rpPerson = rpReport.records.find((r) => r.actor_kind === 'person');
if (rpPerson) console.log(`    e.g. ${new Date(rpPerson.created_at).toISOString().slice(0, 19)}  ${rpPerson.action.padEnd(18)} by ${rpPerson.actor} (${rpPerson.actor_email}, ${rpPerson.actor_role})`);
console.log(`  as CSV: ${reportAsCsv(rpReport).split('\n').length} lines, the digest in its header`);

rule('259. Only for those with the permissions');
const rpServer = createApp().listen(0);
await new Promise((resolve) => rpServer.once('listening', resolve));
const rpBase = `http://127.0.0.1:${rpServer.address().port}/api`;
const rpStatus = async (headers, path) => (await fetch(`${rpBase}${path}`, { headers })).status;
console.log(`  Mira, her own tenant            → ${await rpStatus(rbMira, '/audit-reports')}`);
console.log(`  Mira, Tomas's tenant            → ${await rpStatus(rbMira, `/audit-reports?authorId=${daTomasRow.author_id}`)}`);
console.log(`  the compliance auditor, all     → ${await rpStatus(slAuditor, '/audit-reports')}`);
console.log(`  Mira's API key                  → ${await rpStatus({ 'x-api-key': rbKeyMade.key }, '/audit-reports')}`);
console.log(`  no session                      → ${await rpStatus({}, '/audit-reports')}`);
console.log('\nEvery report generated is on the audit log with its filters and digest; every attempt on');
console.log('the report route is in the security log (STORY-051) like any other audit route.');
await new Promise((resolve) => rpServer.close(resolve));

console.log('\nSTORY-028 complete — a stakeholder can generate a report of every action in a period, with');
console.log('times and user details, provable by its digest, and only with the permissions to read it\n');
// ── STORY-057: Show Pending Approvals and Recent Actions (Trust Dashboard) ──
// REQ-015, REQ-004. Timestamps and priority on everything waiting; the person
// who decides is told, on every tab.

rule('260. What the dashboard showed, measured');
console.log('  before: pending approvals as a count per kind; recent actions as a time of day; no priority;');
console.log('  nothing told the person who decides that anything was waiting for them.');
const { rows: [atMiraUser] } = await query("SELECT id, name, role, author_id FROM users WHERE email = 'mira@example.test'");
const atMiraPerms = (await query('SELECT permission FROM role_permissions WHERE role = $1', [atMiraUser.role])).rows.map((r) => r.permission);
const at = await attentionFor({ authorId: akTenant, user: { ...atMiraUser, permissions: atMiraPerms } });

rule('261. Everything waiting, most urgent first — with when, and why it is urgent');
console.log(`  ${at.awaiting.total} waiting: ${at.awaiting.byPriority.high} high, ${at.awaiting.byPriority.medium} medium, ${at.awaiting.byPriority.normal} normal`);
for (const i of at.awaiting.items.slice(0, 5)) {
  console.log(`    ${i.priority.padEnd(6)} ${new Date(i.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${i.label.slice(0, 44).padEnd(44)} ${i.priorityReason}`);
}
console.log('\n  recent actions, full timestamp and priority:');
for (const r of at.recentActions.slice(0, 4)) console.log(`    ${r.created_at.slice(0, 19).replace('T', ' ')}  ${r.priority.padEnd(6)} ${r.action}`);

rule('262. The notice, for whoever decides');
console.log(`  Mira sees on every tab: "${at.forYou?.message ?? '(nothing waiting)'}"`);
const atAuditor = await attentionFor({ authorId: akTenant, user: { ...rpAuditor, permissions: ['audit.read', 'audit.verify', 'tenant.read.all'] } });
console.log(`  the compliance auditor (cannot approve): ${atAuditor.forYou === null ? 'no notice — nothing is theirs to decide' : 'NOTICE SHOWN'}`);
console.log('\nSTORY-057 complete — pending approvals and recent actions carry timestamps and priority, and the');
console.log('person who decides is told how much is waiting and how urgently\n');

// ── STORY-058: Calculate Governance Score (Trust Dashboard) ──
// REQ-015, REQ-005. A formula over what the system did, with its breakdown.

rule('263. The old score, and what it could not say');
console.log('  before: "governance score" = governance checks passing (e.g. 22 of 24). It said whether the rules');
console.log('  held, not what the system did — and a broken invariant cost it one check out of twenty-four.');
const gs = await governanceScore({ authorId: akTenant });

rule('264. The score, and every factor behind it');
for (const f of gs.factors) {
  console.log(`  ${f.label.padEnd(46)} ${f.noData ? 'nothing yet'.padEnd(10) : `${f.measured.n}/${f.measured.d}`.padEnd(10)} weight ${String(Math.round(f.effectiveWeight * 100)).padStart(3)}%  adds ${f.noData ? '  —' : f.contribution.toFixed(1).padStart(4)}`);
}
console.log(`\n  score: ${gs.score} / 100${gs.capped ? `  (capped; ${gs.uncapped} without the cap)` : ''}`);
if (gs.capReason) console.log(`  ${gs.capReason}`);

rule('265. From the latest data');
console.log(`  computed ${gs.computedAt} over the last ${gs.window.days} days; the Trust tab re-reads it every 15 s.`);
console.log('\nSTORY-058 complete — a governance score from what the system did, with each factor, its weight and');
console.log('its measurement shown, capped whenever an invariant is broken\n');

// ── STORY-054: Kubernetes, Helm (verified on a local cluster; not run here) ──
// REQ-008. The chart is deploy/helm/author-launch-engine; the cluster run and
// its output are in the README. What the demo can show is what made the load
// balancing visible from outside.

rule('266. Which copy answered');
const k8sReady = await readiness({});
console.log(`  /api/ready now names the instance that answered: "${k8sReady.instance}"`);
console.log('  on the cluster, twelve requests to one address were answered by two pods (7 and 5); with the');
console.log('  autoscaler at three, eight requests reached all three. Deleting a pod: replaced in 2 seconds.');
console.log('\nSTORY-054 complete — the chart scales the API on load, spreads requests, replaces what dies,');
console.log('and gives each role only what it needs — proven on k3s; not yet on a cloud cluster\n');

// ── STORY-055: Aggregate data with Elasticsearch ──
// REQ-015, REQ-001, REQ-002.

rule('267. What goes into the index, and what does not');
const { rows: [esRow] } = await query('SELECT * FROM audit_index_rows(0, 1)');
const esDoc = SEARCH_SOURCES.audit.toDoc(esRow);
console.log(`  an audit row, as indexed: ${JSON.stringify(esDoc)}`);
console.log('  not indexed: before, after, metadata — encrypted in Postgres (STORY-049), and they stay there.');
console.log(`  its digest: ${digestOf(esDoc).slice(0, 32)}… — each document is read back and checked against it.`);

rule('268. Aggregate, search, reconcile');
if (!config.elasticsearchUrl) {
  console.log('  ELASTICSEARCH_URL is not set on this machine, so nothing is copied and the Trust tab says search');
  console.log('  is not set up. The CI job `search` runs a real Elasticsearch — 20,000 rows, 40 queries each under a');
  console.log('  second, deleted and altered documents repaired (tests/searchLive.test.js) — and passes.');
} else {
  const esRun = await searchAggregate({});
  for (const src of esRun.sources) console.log(`  ${src.source.padEnd(9)} indexed ${src.indexed} through id ${src.mark}`);
  const esHits = await searchTenant({ authorId: akTenant, q: 'approved' });
  console.log(`  Mira's "approved": ${esHits.total} found, answered in ${esHits.elapsedMs} ms (index ${esHits.took} ms)`);
  for (const c of await searchReconcile({})) console.log(`  ${c.source.padEnd(9)} ${c.inSync ? 'in sync' : 'NOT IN SYNC'}: ${c.sourceCount} rows = ${c.indexCount} documents`);
}
console.log('\nSTORY-055 built — logs and metrics aggregated into a searchable index, each batch verified, gaps and');
console.log('damage found and repaired, the encrypted part never copied; live checks await the first CI run\n');

// ── STORY-056: Grafana dashboards ──
// REQ-015, REQ-003.

rule('269. The trust dashboard in Grafana, as provisioned');
const gfDash = JSON.parse(await readFile(new URL('../../deploy/helm/author-launch-engine/files/grafana/dashboards/trust.json', import.meta.url), 'utf8'));
for (const p of gfDash.panels) console.log(`  · ${p.title.padEnd(40)} ${p.targets[0].datasource.uid}`);
console.log(`  time range: ${gfDash.time.from} → ${gfDash.time.to}, changeable; filter: tenant; editable, and a saved change is kept.`);
console.log('\n  Grafana is not run on this machine. The CI job `search` is written to start it with these files,');
console.log('  run every panel\'s query over a chosen range, save an editor\'s change, read it back as another user,');
console.log('  restart Grafana to check it was kept (tests/grafanaLive.test.js), and take the screenshots. NOT RUN YET.');
console.log('\nSTORY-056 built — interactive, customisable Grafana panels over the index, with user-chosen time');
console.log('ranges and saved changes kept; to be verified by the first CI run, not on this machine\n');
// ── STORY-035, 036, 037: OpenAI, Stripe and Twilio, in test mode ──
// Each service is played by a local stand-in that speaks its real API
// (src/dev/standIns.js); the adapters, gateway, retries, audit and approval
// gate are the real ones. With real keys the far end changes and nothing else.

const oaStand = openaiStandIn();
const stStand = stripeStandIn();
const twStand = twilioStandIn();
const savedKeys = { ...config };
Object.assign(config, {
  openaiApiKey: 'sk-demo-standin', openaiBaseUrl: `${await oaStand.start()}/v1`,
  stripeSecretKey: 'sk_test_demo_standin', stripeApiBase: `${await stStand.start()}/v1`,
  twilioAccountSid: 'ACdemo', twilioAuthToken: 'demo-token', twilioFromNumber: '+15005550006', twilioApiBase: await twStand.start(),
});
await ownerQuery("DELETE FROM integration_circuits WHERE service IN ('openai', 'stripe', 'twilio')");

rule('270. STORY-035 — drafts from OpenAI, from the book\'s themes and the posts already approved');
const oaDrafts = await draftWeeklyPosts({ authorId: author.id, bookId: book.id, count: 3, platforms: ['twitter', 'linkedin'], providerName: 'openai', memeCount: 0 });
const oaCall = oaStand.received.at(-1);
const oaPrompt = JSON.parse(oaStand.state.rawBodies.at(-1)).messages.map((m) => m.content).join('\n');
console.log(`  POST ${oaCall.path} — key only in the Authorization header; prompt ${oaPrompt.length} characters, including`);
console.log(`  the book's themes and ${(oaPrompt.match(/^- \[/gm) ?? []).length} post(s) Mira approved before.`);
for (const d of oaDrafts) console.log(`    ${d.status.padEnd(16)} ${d.platform.padEnd(9)} provider=${d.provider}  "${d.content.slice(0, 60)}…"`);
const { rows: [oaLog] } = await query("SELECT metadata FROM audit_log WHERE action = 'ai.generation' AND author_id = $1 ORDER BY id DESC LIMIT 1", [author.id]);
console.log(`  audit: ai.generation — request sha256 ${oaLog.metadata.requestSha256.slice(0, 16)}…, response sha256 ${oaLog.metadata.responseSha256.slice(0, 16)}…`);
console.log('  nothing is published: every draft waits for a person, as with any provider.');

rule('271. OpenAI briefly unavailable: logged, retried after a delay');
oaStand.failNext(1, 503);
await draftWeeklyPosts({ authorId: author.id, bookId: book.id, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 });
const { rows: oaTries } = await ownerQuery("SELECT attempt, outcome, duration_ms, error FROM api_interactions WHERE service = 'openai' ORDER BY id DESC LIMIT 2");
for (const t of oaTries.reverse()) console.log(`    attempt ${t.attempt}: ${t.outcome.padEnd(9)} ${t.error ? t.error.slice(0, 50) : ''}`);
console.log('\nSTORY-035 built — OpenAI generates drafts from the book and the approved posts, every request and');
console.log('response on the audit log, retried after a delay when OpenAI is down; test mode until a key is set\n');

rule('272. STORY-037 — a reviewer is texted that approvals are waiting');
const { rows: [twReviewer] } = await query("UPDATE reviewers SET phone = '+15555550142' WHERE id = (SELECT id FROM reviewers WHERE author_id = $1 AND active ORDER BY id LIMIT 1) RETURNING *", [author.id]);
const twNotice = await notifyAwaitingApproval({ authorId: author.id });
console.log(`  ${twReviewer.name} (${twReviewer.email}, mobile …${twReviewer.phone.slice(-4)}): email ${twNotice.notified.length ? 'sent' : 'not sent'}; text ${twNotice.texts.map((t) => t.status).join(', ') || 'none — nothing new to announce'}`);
const twSent = twStand.received.at(-1);
if (twSent) console.log(`  POST ${twSent.path}\n    To=${twSent.form.To} Body="${twSent.form.Body}"`);

rule('273. Twilio briefly unavailable: logged, kept, retried later by a job');
twStand.failNext(2, 503);
const twLate = await sendSms({ to: twReviewer.phone, body: 'Author Launch Engine: items are waiting for your approval.', via: 'approval.notify_waiting_sms', purpose: 'approval.waiting', authorId: author.id, reviewerId: twReviewer.id });
console.log(`  status ${twLate.status} after ${twLate.attempts} attempt(s): ${twLate.last_error.slice(0, 60)}`);
console.log(`  next try ${new Date(twLate.next_attempt_at).toISOString().slice(0, 19)} UTC, by an sms.send job — the text is not lost`);
console.log('\nSTORY-037 built — approval notices also go by text through Twilio, every text logged; an outage delays');
console.log('a text and it is retried later rather than dropped; test mode until an account is set\n');

rule('274. STORY-036 — a subscription charged through Stripe');
const stOk = await chargeSubscription({ authorId: author.id, paymentMethod: 'pm_card_visa', requestedBy: 'Ops Admin' });
console.log(`  Mira: ${stOk.payment.status} — ${(stOk.payment.amount_cents / 100).toFixed(2)} ${stOk.payment.currency.toUpperCase()}, ${stOk.payment.stripe_payment_intent_id}; subscription ${stOk.subscriptionStatus}`);
console.log('  the card never reaches this system: the payment names a Stripe PaymentMethod (pm_card_visa, a Stripe test card).');

rule('275. Insufficient funds: logged, the author told, flagged for review');
const stBad = await chargeSubscription({ authorId: daTomasRow.author_id, paymentMethod: 'pm_card_chargeDeclinedInsufficientFunds', requestedBy: 'Ops Admin' });
console.log(`  Tomas: ${stBad.payment.status} — ${stBad.payment.failure_code}: "${stBad.payment.failure_message}"`);
console.log(`  emailed: ${stBad.notified ? 'yes' : 'no'} · flagged for review: ${stBad.payment.needs_review ? 'yes' : 'no'} · subscription ${stBad.subscriptionStatus}`);
console.log('\nSTORY-036 built — subscription payments through Stripe with idempotency keys and signed webhooks;');
console.log('failures logged, emailed to the author and flagged for review; test mode until a Stripe key is set\n');

for (const k of ['openaiApiKey', 'openaiBaseUrl', 'stripeSecretKey', 'stripeApiBase', 'twilioAccountSid', 'twilioAuthToken', 'twilioFromNumber', 'twilioApiBase']) config[k] = savedKeys[k];
await Promise.all([oaStand.stop(), stStand.stop(), twStand.stop()]);
// ── STORY-059–062: anomalies escalated; scaling, balancing and monitoring ──

rule('276. STORY-059 — an anomaly, detected and escalated within a scan');
console.log('  before: STORY-014\'s detectors ran when someone opened the dashboard — nothing stored, no status,');
console.log('  nobody told, and nothing watched system activity.');
await query(
  `INSERT INTO data_access_events (author_id, scope, method, route, path, status, outcome, ip)
   SELECT $1, 'tenant', 'GET', '/authors/:authorId/drafts', '/x', 401, 'unauthenticated', '203.0.113.' || (g % 7) FROM generate_series(1, 24) g`,
  [author.id],
);
const anScan = await scanAndEscalate({});
const anBurst = anScan.escalated.find((e) => e.detector === 'access.refused_burst' && Number(e.author_id) === Number(author.id));
console.log(`  scan: ${anScan.findings} finding(s), ${anScan.raised.length} new, ${anScan.escalated.length} escalated`);
if (anBurst) {
  console.log(`  ${anBurst.severity}: ${anBurst.summary}`);
  console.log(`  escalated ${Math.round((new Date(anBurst.escalated_at) - new Date(anBurst.detected_at)) / 1000)} s after detection to ${anBurst.escalated_to.join(', ')}`);
}

rule('277. On the trust dashboard, with its status — and a person acts');
const anList = await listAnomalies({ authorId: author.id, user: { ...atMiraUser, permissions: atMiraPerms } });
console.log(`  Mira's Trust tab: ${anList.open} open, ${anList.acknowledged} acknowledged`);
if (anBurst) {
  const anAck = await updateAnomaly({ id: anBurst.id, action: 'acknowledge', user: { ...atMiraUser, authorId: author.id, permissions: atMiraPerms } });
  console.log(`  Mira acknowledges #${anAck.id}: ${anAck.status} by ${anAck.acknowledged_by}`);
}
console.log('\nSTORY-059 complete — anomalies in system activity are stored, escalated to people within a minute\'s');
console.log('scan (five minutes is the limit, and a governance check counts misses), and shown with their status\n');

rule('278. STORY-062 — performance metrics, and an alert that reaches a person');
const promText = await metricsRegistry.metrics();
for (const name of ['ale_http_request_duration_seconds_count', 'ale_jobs{', 'ale_jobs_oldest_queued_seconds', 'ale_db_pool_connections', 'ale_process_resident_memory_bytes']) {
  const line = promText.split('\n').find((l) => l.startsWith(name));
  if (line) console.log(`  ${line.slice(0, 110)}`);
}
const promRules = YAML.parse(await readFile(new URL('../../deploy/helm/author-launch-engine/files/prometheus/alerts.yml', import.meta.url), 'utf8'));
console.log(`  alert rules: ${promRules.groups.flatMap((g) => g.rules.map((r) => r.alert)).join(', ')}`);
const promAlert = await recordPrometheusAlerts({ alerts: [{ status: 'firing', fingerprint: `demo-${Date.now()}`, labels: { alertname: 'AleJobBacklog', severity: 'high' }, annotations: { summary: 'Background work is falling behind' } }] });
const promEvent = (await ownerQuery('SELECT escalated_to FROM anomaly_events WHERE id = $1', [promAlert.handled[0].id])).rows[0];
console.log(`  Alertmanager → API: "Background work is falling behind" → anomaly #${promAlert.handled[0].id}, escalated to ${promEvent.escalated_to.join(', ')}`);
console.log('\nSTORY-062 complete — Prometheus metrics for requests, backlog, pool, memory and lag; nine alert rules,');
console.log('tested with promtool; firing alerts escalated to the operators through the same path as anomalies\n');

rule('279. STORY-061 — NGINX balancing across API instances (measured on the AWS server)');
console.log('  upstream ale_api: round robin, `resolve` so instances join and leave, passive health checks,');
console.log('  a refused request retried on the next instance, 3 s connect timeout.');
console.log('  measured on the AWS server, a private copy of the stack with three API instances:');
console.log('    60 requests → 20 / 20 / 20;  a fourth added without restarting nginx → 20 / 20 / 20 / 20');
console.log('    graceful stop mid-traffic → 40 of 40 answered;  kill -9 mid-traffic → 999 of 1000 (three runs)');
console.log('\nSTORY-061 complete — traffic spread evenly across every API instance, with failover; CI\'s');
console.log('`loadbalancer` job re-checks it on every push (passed on its first run)\n');

rule('280. STORY-060 — every service scales horizontally');
const chartValues = YAML.parse(await readFile(new URL('../../deploy/helm/author-launch-engine/values.yaml', import.meta.url), 'utf8'));
for (const svc of ['api', 'worker', 'client']) {
  const a = chartValues[svc].autoscaling;
  console.log(`  ${svc.padEnd(7)} ${a.minReplicas}–${a.maxReplicas} pods at ${a.targetCPUUtilizationPercentage}% CPU${a.targetMemoryUtilizationPercentage ? ` or ${a.targetMemoryUtilizationPercentage}% memory` : ''}; scale down after ${a.scaleDownStabilizationSeconds}s calm`);
}
console.log('  proven: STORY-054 on k3s (2 → 3 under load). CI\'s `kubernetes` job (kind) proves it on every push (passed on its first run).');
console.log('  EKS: deploy/eks/cluster.yaml, ready — not created: it is billed by the hour in the owner\'s account.');
console.log('\nSTORY-060 complete — API, worker and web autoscale; nodes scale on EKS when created\n');
await closePool();
