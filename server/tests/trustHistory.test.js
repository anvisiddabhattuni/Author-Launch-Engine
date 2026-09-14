/**
 * STORY-021 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Display system health and metrics" → the dashboard shows health, pending
 *       approvals, recent actions and anomalies.
 *   "Anomaly detection"                 → anomalies are logged and displayed.
 *
 * Both passed before this story started — STORY-014 built them and three
 * detectors were already running. So these tests are aimed at the half of
 * REQ-007 that had nothing behind it: users "monitor and **analyse**" trust
 * metrics, and analysis needs a second reading to compare the first one to.
 * Every load recomputed a snapshot and compared it to nothing, nothing ran the
 * assessment unless a human opened the page, and no check could say when it had
 * started failing.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { trustDashboard } from '../src/agents/trustMonitoringAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { SEVERITY } from '../src/services/governance.js';
import {
  alertOnBreaches,
  assessmentHistory,
  checkEpisodes,
  recordAssessment,
} from '../src/services/trustHistory.js';

let authorId;

/** Captures what would have been emailed, so assertions can read the alert. */
const recorder = () => {
  const sent = [];
  return {
    sent,
    async send({ to, subject, body, via }) {
      sent.push({ to, subject, body, via });
      return { externalId: `rec_${sent.length}`, acceptedAt: new Date().toISOString() };
    },
  };
};

/** A verdict list shaped like `runChecks` output, so the detector sees what it sees. */
const checks = (failing = []) => [
  { id: 'gate.posts', severity: SEVERITY.INVARIANT, label: 'Nothing published unapproved', passed: !failing.includes('gate.posts'), violations: failing.includes('gate.posts') ? 2 : 0 },
  { id: 'gate.press', severity: SEVERITY.INVARIANT, label: 'No kit distributed unapproved', passed: !failing.includes('gate.press'), violations: failing.includes('gate.press') ? 1 : 0 },
  { id: 'approvals.attributable', severity: SEVERITY.QUALITY, label: 'Approvals name a session', passed: !failing.includes('approvals.attributable'), violations: failing.includes('approvals.attributable') ? 5 : 0 },
];

const governanceFor = (list) => ({
  status: list.some((c) => !c.passed && c.severity === SEVERITY.INVARIANT) ? 'breach' : 'healthy',
  score: Number((list.filter((c) => c.passed).length / list.length).toFixed(3)),
  passed: list.filter((c) => c.passed).length,
  total: list.length,
  failedInvariants: list.filter((c) => !c.passed && c.severity === SEVERITY.INVARIANT).map((c) => c.id),
  failedQuality: list.filter((c) => !c.passed && c.severity === SEVERITY.QUALITY).map((c) => c.id),
});

const assess = (failing, anomalies = { findings: 0 }) => {
  const list = checks(failing);
  return recordAssessment({ authorId, governance: governanceFor(list), checks: list, anomalies });
};

before(async () => {
  const { rows } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Trust History Author', `trusthistory-${Date.now()}@example.test`],
  );
  authorId = rows[0].id;
});

after(async () => {
  await closePool();
});

describe('The dashboard has a memory', () => {
  it('stores an assessment rather than only computing one', async () => {
    await assess([]);
    const history = await assessmentHistory({ authorId });
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'healthy');
    assert.equal(Number(history[0].score), 1);
    assert.equal(history[0].total, 3);
  });

  it('keeps the per-check verdict, not just the score', async () => {
    const [latest] = await assessmentHistory({ authorId, limit: 1 });
    // A later reader must be able to ask "what exactly was failing then"
    // without re-deriving it from code that has since changed.
    assert.ok(Array.isArray(latest.checks));
    assert.equal(latest.checks.length, 3);
    assert.ok(latest.checks.every((c) => typeof c.passed === 'boolean'));
  });

  it('makes the score a series', async () => {
    await assess(['approvals.attributable']);
    const history = await assessmentHistory({ authorId });
    assert.ok(history.length >= 2);
    // Newest first, so a chart reads without re-sorting.
    assert.ok(new Date(history[0].assessed_at) >= new Date(history[1].assessed_at));
    assert.notEqual(Number(history[0].score), Number(history[1].score));
  });

  it('counts failing checks rather than storing their ids in an integer column', async () => {
    // `scoreOf` returns failing check *ids*; the columns want how many. The
    // first version passed the array straight through and Postgres refused it.
    const [latest] = await assessmentHistory({ authorId, limit: 1 });
    assert.equal(typeof latest.failed_quality, 'number');
    assert.equal(latest.failed_quality, 1);
  });
});

describe('A check changing state is an event with a time on it', () => {
  it('opens an episode when a check starts failing', async () => {
    const { started } = await assess(['gate.posts']);
    assert.equal(started.length, 1);
    assert.equal(started[0].check_id, 'gate.posts');
    assert.equal(started[0].recovered_at, null);
    assert.ok(started[0].started_at);
  });

  it('does not re-open an episode that is already open', async () => {
    // The sweep runs on a timer. A still-broken check is not a new event, and
    // reporting it as one is how an alert channel becomes noise.
    const { started } = await assess(['gate.posts']);
    assert.deepEqual(started, []);

    const open = (await checkEpisodes({ authorId })).filter((e) => !e.recovered_at);
    assert.equal(open.filter((e) => e.check_id === 'gate.posts').length, 1);
  });

  it('closes the episode when the check recovers', async () => {
    const { recovered } = await assess([]);
    const closed = recovered.find((e) => e.check_id === 'gate.posts');
    assert.ok(closed, 'recovery was not detected');
    assert.ok(closed.recovered_at);
  });

  it('records a second episode when it fails again, rather than forgetting the first', async () => {
    await assess(['gate.posts']);
    const episodes = (await checkEpisodes({ authorId })).filter((e) => e.check_id === 'gate.posts');
    assert.equal(episodes.length, 2, 'the earlier outage was overwritten');
    assert.equal(episodes.filter((e) => e.recovered_at === null).length, 1);
  });

  it('writes both transitions to the audit log', async () => {
    const { rows } = await query(
      `SELECT action, entity_id, metadata FROM audit_log
        WHERE author_id = $1 AND action IN ('governance.check_failed','governance.check_recovered')
        ORDER BY id`,
      [authorId],
    );
    assert.ok(rows.some((r) => r.action === 'governance.check_failed'));
    const recovered = rows.find((r) => r.action === 'governance.check_recovered');
    assert.ok(recovered, 'a recovery was not logged');
    // How long it was broken is the number that says whether anyone was watching.
    assert.equal(typeof recovered.metadata.openForSeconds, 'number');
  });
});

describe('Somebody is told when an invariant breaks', () => {
  let notifier;

  before(async () => {
    await query(
      `INSERT INTO reviewers (author_id, name, email, role, active)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,
      [authorId, 'Trust Reviewer', `trust-reviewer-${Date.now()}@example.test`, 'publicist'],
    );
    notifier = recorder();
  });

  it('alerts on a newly-broken invariant', async () => {
    await assess([]);
    const { started } = await assess(['gate.press']);
    const result = await alertOnBreaches({ authorId, started, notifier });

    assert.equal(result.alerted.length, 1);
    assert.match(notifier.sent[0].subject, /Trust breach/);
    assert.match(notifier.sent[0].body, /gate\.press/);
  });

  it('sends through a declared outbound path', () => {
    // STORY-020: nothing leaves this system without naming the path it leaves
    // by, alerts included.
    assert.equal(notifier.sent[0].via, 'trust.alert_breach');
  });

  it('does not alert again while the same breach persists', async () => {
    const before = notifier.sent.length;
    const { started } = await assess(['gate.press']);
    const result = await alertOnBreaches({ authorId, started, notifier });
    assert.deepEqual(result.alerted, []);
    assert.equal(notifier.sent.length, before, 'a persisting breach re-alerted');
  });

  it('does not alert for a quality check dipping', async () => {
    await assess([]);
    const { started } = await assess(['approvals.attributable']);
    const result = await alertOnBreaches({ authorId, started, notifier });
    assert.deepEqual(result.alerted, []);
    assert.equal(result.reason, 'no new invariant breach');
  });

  it('records a breach nobody can be told about, rather than staying silent', async () => {
    const { rows: lonely } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['No Reviewers Author', `noreviewers-${Date.now()}@example.test`],
    );
    const list = checks(['gate.posts']);
    const { started } = await recordAssessment({
      authorId: lonely[0].id,
      governance: governanceFor(list),
      checks: list,
      anomalies: { findings: 0 },
    });

    const result = await alertOnBreaches({ authorId: lonely[0].id, started, notifier });
    assert.deepEqual(result.alerted, []);
    assert.equal(result.reason, 'no active reviewer');

    const { rows } = await query(
      "SELECT * FROM audit_log WHERE author_id = $1 AND action = 'governance.breach_unreachable'",
      [lonely[0].id],
    );
    assert.ok(rows[0], 'an unreachable breach must not be silent');
  });
});

describe('Scenario: display system health and metrics', () => {
  it('still shows all four things the criterion names', async () => {
    const dashboard = await trustDashboard({ authorId });
    assert.ok(dashboard.health);
    assert.ok(dashboard.queue);
    assert.ok(Array.isArray(dashboard.recent));
    assert.ok(dashboard.anomalies);
    // And now the dimension that was missing.
    assert.ok(Array.isArray(dashboard.history));
    assert.ok(Array.isArray(dashboard.episodes));
  });

  it('tells each failing check how long it has been failing', async () => {
    // A *real* failure, not a synthetic episode. `trustDashboard` assesses
    // reality and closes any episode whose check is actually passing — which is
    // correct, and is what caught the first version of this test feeding it a
    // fabricated one.
    //
    // `approvals.attributable` counts approvals with no authenticated session
    // behind them, so one such row makes it genuinely fail.
    const { rows: book } = await query(
      'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
      [authorId, 'Trust History Book', 'Some content about craft.', ['craft']],
    );
    const { rows: draft } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                           theme_alignment, week_of)
       VALUES ($1,$2,'twitter','a draft to approve','approved',0.9,0.9,CURRENT_DATE) RETURNING *`,
      [authorId, book[0].id],
    );
    await query(
      `INSERT INTO approvals (draft_id, decision, reviewer, notes, user_id)
       VALUES ($1,'approved','Unattributed Reviewer','',NULL)`,
      [draft[0].id],
    );

    const dashboard = await trustDashboard({ authorId });
    const failing = dashboard.checks.find((c) => c.id === 'approvals.attributable');
    assert.equal(failing.passed, false, 'the fixture did not make the check fail');
    assert.ok(failing.failingSince, 'a failing check does not say since when');

    const open = dashboard.episodes.filter((e) => !e.recovered_at);
    assert.ok(
      open.some((e) => e.check_id === 'approvals.attributable'),
      'no open episode for the failing check',
    );
  });

  it('assesses on a schedule, not only when somebody looks', async () => {
    // The gap this story exists for: six recurring sweeps ran and not one of
    // them was this, so a breach waited to be noticed.
    const { RECURRING } = await import('../src/jobs/handlers.js');
    const sweep = RECURRING.find((r) => r.kind === 'trust.assess');
    assert.ok(sweep, 'nothing assesses trust on a timer');
    assert.equal(sweep.scope, 'author');
  });
});
