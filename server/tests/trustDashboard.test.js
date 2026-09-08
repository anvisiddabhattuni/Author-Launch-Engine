/**
 * STORY-014 acceptance tests.
 *
 * The story's clause — display system health, pending approvals, recent actions
 * and anomalies — is the first block. The rest are about the two things the
 * trust clause adds, which are the two easiest things on this whole project to
 * build dishonestly.
 *
 * A **governance score** is a number people believe because it is a number. The
 * tests below pin that it decomposes into readable checks and that it is never
 * the verdict: a broken invariant means breach whatever the score says.
 *
 * **Anomaly detection** on this data volume would be noise with a decimal point.
 * The detectors state their sample and decline below it, and there are tests for
 * the declining — the STORY-069 rule applied to a different set of small numbers.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { trustDashboard } from '../src/agents/trustMonitoringAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { CONFIDENCE, detectAnomalies } from '../src/services/anomalies.js';
import { CHECKS, SEVERITY, STATUS, runChecks, scoreOf } from '../src/services/governance.js';

let authorId;

before(async () => {
  const { rows } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Trust Test Author', `trust-${Date.now()}@example.test`],
  );
  authorId = rows[0].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-014: the dashboard displays what the story asks for', () => {
  let board;

  before(async () => {
    board = await trustDashboard({ authorId });
  });

  it('shows system health', () => {
    assert.ok(board.health);
    assert.ok('jobs' in board.health);
    // A worker that never ran and one that stopped an hour ago look identical in
    // a status count, and are very different problems.
    assert.equal(typeof board.health.workerSeen, 'boolean');
    assert.ok('auditIntegrity' in board.health);
  });

  it('shows pending approvals', () => {
    assert.ok(board.queue);
    assert.equal(typeof board.queue.total, 'number');
    assert.ok('byKind' in board.queue);
  });

  it('shows recent actions', () => {
    assert.ok(Array.isArray(board.recent));
    assert.ok(board.recent.length > 0);
    assert.ok(board.recent[0].actor && board.recent[0].action);
  });

  it('shows anomalies, including the ones it could not look for', () => {
    assert.ok(Array.isArray(board.anomalies.detectors));
    assert.ok(board.anomalies.detectors.length > 0);
    for (const d of board.anomalies.detectors) {
      assert.ok(Object.values(CONFIDENCE).includes(d.confidence));
      assert.ok(d.because.length > 0, `${d.id} says why it concluded what it did`);
    }
  });

  it('records the assessment on the log, so the score is a series', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND action = 'governance.assessed' ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0]);
    assert.ok('score' in rows[0].metadata);
    assert.ok('failedInvariants' in rows[0].metadata);
  });

  it('does not recompute what another module owns', () => {
    // Audit integrity comes from the Audit and Security Agent, the queue from
    // the Approval and Notification Agent. A second implementation of either
    // would be free to disagree, invisibly.
    assert.ok(['intact', 'altered', 'nothing_sealed_yet'].includes(board.health.auditIntegrity));
  });
});

describe('The governance score is a summary, never the verdict', () => {
  const check = (id, severity, passed) => ({
    id,
    severity,
    label: id,
    why: '',
    passed,
    violations: passed ? 0 : 1,
  });

  it('calls a broken invariant a breach however good the score', () => {
    const results = [
      check('gate.posts', SEVERITY.INVARIANT, false),
      ...Array.from({ length: 19 }, (_, i) => check(`q${i}`, SEVERITY.QUALITY, true)),
    ];
    const scored = scoreOf(results);
    assert.equal(scored.status, STATUS.BREACH);
    assert.ok(scored.score > 0.9, 'a 95% score');
    assert.match(scored.headline, /without the approval this system promises/);
  });

  it('calls a failed quality check degraded, not a breach', () => {
    const scored = scoreOf([
      check('gate.posts', SEVERITY.INVARIANT, true),
      check('approvals.attributable', SEVERITY.QUALITY, false),
    ]);
    assert.equal(scored.status, STATUS.DEGRADED);
    assert.deepEqual(scored.failedQuality, ['approvals.attributable']);
  });

  it('is healthy only when everything passes', () => {
    const scored = scoreOf([
      check('gate.posts', SEVERITY.INVARIANT, true),
      check('q', SEVERITY.QUALITY, true),
    ]);
    assert.equal(scored.status, STATUS.HEALTHY);
    assert.equal(scored.score, 1);
  });

  it('decomposes into checks a person can read', async () => {
    const results = await runChecks({});
    assert.equal(results.length, CHECKS.length);
    for (const r of results) {
      assert.ok(r.label.length > 0, `${r.id} says what it checks`);
      assert.ok(r.why.length > 0, `${r.id} says why it matters`);
      assert.ok(Object.values(SEVERITY).includes(r.severity));
    }
  });

  it('reports every violation count as the same thing the check tested', async () => {
    const results = await runChecks({});
    for (const r of results) {
      assert.equal(r.passed, r.violations === 0, `${r.id}: pass must mean zero violations`);
    }
  });

  it('treats an unverified audit log as neither pass nor fail', async () => {
    const results = await runChecks({
      auditIntegrity: { status: 'nothing_sealed_yet', breaks: [] },
    });
    const integrity = results.find((r) => r.id === 'audit.integrity');
    assert.equal(integrity.passed, true, 'not a failure — nothing was found wrong');
    assert.match(integrity.note, /nothing sealed yet/, 'and not silently a clean bill of health');
  });

  it('fails on a tampered log', async () => {
    const results = await runChecks({
      auditIntegrity: { status: 'altered', breaks: [{ finding: 'row contents changed' }] },
    });
    const integrity = results.find((r) => r.id === 'audit.integrity');
    assert.equal(integrity.passed, false);
    assert.equal(integrity.severity, SEVERITY.INVARIANT, 'a rewritten log is a breach');
  });
});

describe('The gates this dashboard exists to watch', () => {
  it('checks all four outbound paths, not just the one', async () => {
    // Presence, not exhaustiveness. An earlier version asserted the invariant
    // list was exactly these four, which meant adding a fifth invariant — the
    // tenant isolation check in STORY-017 — failed a test about outbound gates.
    // A test should break when its own subject changes, not when the list it
    // happens to live in grows.
    const invariants = CHECKS.filter((c) => c.severity === SEVERITY.INVARIANT).map((c) => c.id);
    for (const gate of ['gate.outreach', 'gate.posts', 'gate.press', 'gate.schedule']) {
      assert.ok(invariants.includes(gate), `${gate} must be an invariant`);
    }
  });

  it('counts one more violation when a post is published without an approval', async () => {
    // A delta, not an absolute. These checks are global by design — that is what
    // makes them worth having in production — but the test database is shared,
    // and other suites legitimately insert published rows as fixtures without
    // going through the gate. Asserting "the whole database is clean" was
    // asserting that no other suite was running.
    const violations = async () =>
      (await runChecks({})).find((r) => r.id === 'gate.posts').violations;

    const { rows: b } = await query(
      `INSERT INTO books (author_id, title, content, themes)
       VALUES ($1,'Gate Test','C',$2) RETURNING id`,
      [authorId, ['x']],
    );
    const { rows: d } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status)
       VALUES ($1,$2,'twitter','ungated',0.9,'2026-07-06','approved') RETURNING id`,
      [authorId, b[0].id],
    );

    const before_ = await violations();
    await query(
      `INSERT INTO scheduled_posts
         (draft_id, author_id, platform, scheduled_for, status, external_id, published_at)
       VALUES ($1,$2,'twitter', now(), 'published', 'ungated-1', now())`,
      [d[0].id, authorId],
    );

    const during = await violations();
    assert.equal(during, before_ + 1, 'a published post with no approval is one more violation');

    await query('DELETE FROM scheduled_posts WHERE external_id = $1', ['ungated-1']);
    assert.equal(await violations(), before_, 'and clears when it is removed');
  });

  it('does not count a post that was properly approved', async () => {
    const violations = async () =>
      (await runChecks({})).find((r) => r.id === 'gate.posts').violations;

    const { rows: b } = await query(
      `INSERT INTO books (author_id, title, content, themes)
       VALUES ($1,'Gated Test','C',$2) RETURNING id`,
      [authorId, ['x']],
    );
    const { rows: d } = await query(
      `INSERT INTO drafts (author_id, book_id, platform, content, confidence, week_of, status)
       VALUES ($1,$2,'twitter','gated',0.9,'2026-07-06','approved') RETURNING id`,
      [authorId, b[0].id],
    );
    await query(
      "INSERT INTO approvals (draft_id, decision, reviewer) VALUES ($1,'approved','Tester')",
      [d[0].id],
    );

    const before_ = await violations();
    await query(
      `INSERT INTO scheduled_posts
         (draft_id, author_id, platform, scheduled_for, status, external_id, published_at)
       VALUES ($1,$2,'twitter', now(), 'published', 'gated-1', now())`,
      [d[0].id, authorId],
    );
    assert.equal(await violations(), before_, 'an approval on record is what the check looks for');
  });
});

describe('Anomaly detection says what it cannot conclude', () => {
  it('declines rather than inferring from too few decisions', async () => {
    const result = await detectAnomalies({});
    const stamping = result.detectors.find((d) => d.id === 'reviewer.rubber_stamping');
    if (stamping.confidence === CONFIDENCE.INSUFFICIENT) {
      assert.match(stamping.because, new RegExp(`${config.minDecisionsForPattern} decisions`));
      assert.deepEqual(stamping.findings, [], 'and reports nothing rather than guessing');
    }
  });

  it('distinguishes "found nothing" from "could not look"', async () => {
    const result = await detectAnomalies({});
    for (const d of result.detectors) {
      assert.notEqual(
        d.confidence,
        undefined,
        'a detector that cannot look must not look like one that found nothing',
      );
      assert.ok('sample' in d, `${d.id} reports the sample it had`);
    }
  });

  it('counts findings, not detectors', async () => {
    const result = await detectAnomalies({});
    const expected = result.detectors.reduce((n, d) => n + d.findings.length, 0);
    assert.equal(result.findings, expected);
    assert.ok(
      result.findings <= result.detectors.length * 100,
      'the headline number is things found, not things looked for',
    );
  });

  it('watches for a gate that has never turned anything away', async () => {
    // An approval gate that never rejects is hard to tell apart from no gate —
    // the thing this dashboard most needs to notice about itself.
    const result = await detectAnomalies({});
    assert.ok(result.detectors.some((d) => d.id === 'reviewer.never_rejects'));
  });
});
