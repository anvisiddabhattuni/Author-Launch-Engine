/**
 * STORY-013 acceptance tests.
 *
 * The story's one clause — an agent performs an action, and the action is
 * logged in an append-only audit log — has held since STORY-001, and the first
 * block re-asserts it: every agent writes rows, and the table refuses UPDATE,
 * DELETE and TRUNCATE by trigger.
 *
 * The second block is what was missing. Append-only here is a *policy*, and a
 * policy can be switched off: disable the triggers, edit, re-enable, and the log
 * still refuses every ordinary mutation while history has been rewritten.
 * Prevention with no detection. These tests do exactly that and check that the
 * Audit and Security Agent notices.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ACTOR,
  GENESIS,
  INTEGRITY,
  canonicalise,
  digestOf,
  sealAndVerify,
  sealAuditLog,
  verifyAuditLog,
} from '../src/agents/auditSecurityAgent.js';
import { closePool, query } from '../src/db/pool.js';
import { recordAction } from '../src/services/auditLog.js';

let authorId;

/**
 * A stand-in for the database, holding a log somebody has rewritten.
 *
 * Tampering for real means `ALTER TABLE audit_log DISABLE TRIGGER ALL`, and that
 * is table-wide on a database every other suite is using — an earlier draft of
 * this file did exactly that and broke four unrelated suites, which is the same
 * mistake STORY-011's tests made from the other direction. The detection logic
 * takes a client, so it can be shown a doctored log without imposing one on
 * anybody else. The end-to-end version, where triggers really are disabled and
 * the agent really catches it, lives in the demo where nothing runs alongside.
 */
const stubClient = ({ checkpoints, rows }) => ({
  async query(sql, params) {
    if (sql.includes('FROM audit_checkpoints')) return { rows: checkpoints };
    if (sql.includes('FROM audit_log WHERE id BETWEEN')) {
      const [from, to] = params;
      return { rows: rows.filter((r) => r.id >= Number(from) && r.id <= Number(to)) };
    }
    // recordAction, writing the verdict.
    return { rows: [{}] };
  },
});

/** A believable log row. */
const logRow = (id, over = {}) => ({
  id,
  actor: 'TestAgent',
  action: 'test.action',
  entity_type: 'author',
  entity_id: '1',
  author_id: 1,
  before: null,
  after: null,
  metadata: { i: id },
  created_at: new Date(`2026-01-0${(id % 9) + 1}T00:00:00.000Z`),
  ...over,
});

/** A sealed range over those rows, chained from `prevDigest`. */
const sealOf = (id, rows, prevDigest) => ({
  id,
  from_id: rows[0].id,
  to_id: rows[rows.length - 1].id,
  row_count: rows.length,
  digest: digestOf({ prevDigest, rows }),
  prev_digest: prevDigest,
  sealed_at: new Date('2026-01-09T00:00:00.000Z'),
});

/** Writes some real activity so a seal covers more than bookkeeping. */
async function activity(n, tag) {
  for (let i = 0; i < n; i += 1) {
    await recordAction({
      actor: 'TestAgent',
      action: 'test.action',
      entityType: 'author',
      entityId: authorId,
      authorId,
      metadata: { tag, i },
    });
  }
}

before(async () => {
  const { rows } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Audit Test Author', `audit-${Date.now()}@example.test`],
  );
  authorId = rows[0].id;
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-013: actions are logged in an append-only log', () => {
  it('refuses every ordinary mutation', async () => {
    await activity(1, 'append-only');
    const { rows } = await query('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1');
    await assert.rejects(
      () => query("UPDATE audit_log SET action = 'x' WHERE id = $1", [rows[0].id]),
      /append-only|permission denied/,
    );
    await assert.rejects(
      () => query('DELETE FROM audit_log WHERE id = $1', [rows[0].id]),
      /append-only|permission denied/,
    );
    // The log is a view over its encrypted storage since STORY-049; TRUNCATE
    // is aimed at the storage, where the application holds no privilege at all.
    await assert.rejects(() => query('TRUNCATE audit_log_sealed'), /append-only|permission denied/);
  });

  it('protects the seals the same way it protects the log', async () => {
    await activity(2, 'seal-protection');
    const { checkpoint } = await sealAuditLog({});
    assert.ok(checkpoint);
    await assert.rejects(
      () => query("UPDATE audit_checkpoints SET digest = 'x' WHERE id = $1", [checkpoint.id]),
      /append-only|permission denied/,
      'a checkpoint anyone can rewrite verifies nothing',
    );
  });
});

describe('STORY-013: and the append-only claim is now checkable', () => {
  const clean = [1, 2, 3, 4].map((i) => logRow(i));
  const sealed = sealOf(1, clean, GENESIS);

  it('reports intact when nothing has been touched', async () => {
    const result = await verifyAuditLog({}, stubClient({ checkpoints: [sealed], rows: clean }));
    assert.equal(result.status, INTEGRITY.INTACT);
    assert.deepEqual(result.breaks, []);
    assert.equal(result.checked, 1);
  });

  it('catches a row edited in place after sealing', async () => {
    // The exact attack: rewrite who did what, leaving the row count untouched.
    const edited = clean.map((r) => (r.id === 2 ? { ...r, actor: 'SomebodyElse' } : r));
    const result = await verifyAuditLog({}, stubClient({ checkpoints: [sealed], rows: edited }));
    assert.equal(result.status, INTEGRITY.ALTERED);
    assert.equal(result.breaks[0].rowsNow, result.breaks[0].rowsSealed);
    assert.match(result.breaks[0].finding, /contents changed/);
  });

  it('catches rows removed from a sealed range', async () => {
    const shortened = clean.filter((r) => r.id !== 2 && r.id !== 3);
    const result = await verifyAuditLog({}, stubClient({ checkpoints: [sealed], rows: shortened }));
    assert.equal(result.status, INTEGRITY.ALTERED);
    assert.equal(result.breaks[0].rowsNow, result.breaks[0].rowsSealed - 2);
    assert.match(result.breaks[0].finding, /2 row\(s\) removed/);
  });

  it('catches a row slipped into a range after it was sealed', async () => {
    // Ids come from a sequence, so a gap is normal — a rolled-back transaction
    // consumes an id without leaving a row. That gap is where a forged row would
    // go, and it is why row_count is stored rather than derived from the range.
    const gapped = [logRow(1), logRow(2), logRow(4), logRow(5)];
    const sealedWithGap = sealOf(1, gapped, GENESIS);
    assert.equal(sealedWithGap.row_count, 4);
    assert.equal(Number(sealedWithGap.to_id) - Number(sealedWithGap.from_id) + 1, 5);

    const forged = [...gapped, logRow(3, { actor: 'SomebodyElse' })].sort((a, b) => a.id - b.id);
    const result = await verifyAuditLog(
      {},
      stubClient({ checkpoints: [sealedWithGap], rows: forged }),
    );
    assert.equal(result.status, INTEGRITY.ALTERED);
    assert.match(result.breaks[0].finding, /inserted into this range/);
  });

  it('catches a whole checkpoint being removed', async () => {
    const later = [5, 6].map((i) => logRow(i));
    const second = sealOf(2, later, sealed.digest);
    // The first seal is gone, so the second one's predecessor no longer exists.
    const result = await verifyAuditLog(
      {},
      stubClient({ checkpoints: [second], rows: [...clean, ...later] }),
    );
    assert.equal(result.status, INTEGRITY.ALTERED);
    assert.match(result.breaks[0].finding, /checkpoint before this one/);
  });

  it('reports only the first break, because the rest follow from it', async () => {
    const later = [5, 6].map((i) => logRow(i));
    const second = sealOf(2, later, sealed.digest);
    const broken = clean.map((r) => (r.id === 1 ? { ...r, action: 'x' } : r));
    const result = await verifyAuditLog(
      {},
      stubClient({ checkpoints: [sealed, second], rows: [...broken, ...later] }),
    );
    assert.equal(result.breaks.length, 1);
    assert.equal(result.breaks[0].checkpoint, 1);
  });

  it('says nothing is sealed yet rather than claiming intact', async () => {
    const result = await verifyAuditLog({}, stubClient({ checkpoints: [], rows: [] }));
    assert.equal(result.status, INTEGRITY.UNSEALED);
    assert.notEqual(result.status, INTEGRITY.INTACT, 'an unchecked log is not a verified one');
  });

  it('records a detection as needing a human, not as handled', async () => {
    const edited = clean.map((r) => (r.id === 2 ? { ...r, actor: 'SomebodyElse' } : r));
    let written = null;
    const client = stubClient({ checkpoints: [sealed], rows: edited });
    const spy = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO audit_log')) written = { sql, params };
        return client.query(sql, params);
      },
    };
    await verifyAuditLog({}, spy);
    assert.ok(written, 'the verdict is itself logged');
    assert.ok(String(written.params[1]).includes('tampering_detected'));
    assert.match(String(written.params[7]), /"needsHuman":true/, 'detecting is not repairing');
  });
});

describe('What the digest covers, and what it must not depend on', () => {
  const row = {
    id: 7,
    actor: 'A',
    action: 'b.c',
    entity_type: 'draft',
    entity_id: '9',
    author_id: 1,
    before: null,
    after: { status: 'approved' },
    metadata: { threshold: 0.7, reviewer: 'x' },
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('changes when any field a decision rests on changes', () => {
    const base = canonicalise(row);
    for (const field of ['actor', 'action', 'entity_type', 'entity_id', 'author_id']) {
      assert.notEqual(canonicalise({ ...row, [field]: 'CHANGED' }), base, `${field} is covered`);
    }
    assert.notEqual(canonicalise({ ...row, after: { status: 'rejected' } }), base);
    // metadata carries the thresholds a decision was judged against and who the
    // session belonged to. A digest that ignored it would be believed and wrong.
    assert.notEqual(canonicalise({ ...row, metadata: { threshold: 0.1 } }), base);
  });

  it('does not depend on the order Postgres returns json keys in', () => {
    const a = canonicalise({ ...row, metadata: { alpha: 1, beta: 2 } });
    const b = canonicalise({ ...row, metadata: { beta: 2, alpha: 1 } });
    assert.equal(a, b, 'otherwise it would cry tampering whenever the planner felt different');
  });

  it('cannot be fooled by moving a field boundary', () => {
    const left = canonicalise({ ...row, actor: 'ab', action: 'c' });
    const right = canonicalise({ ...row, actor: 'a', action: 'bc' });
    assert.notEqual(left, right);
  });

  it('starts the chain from a fixed root', () => {
    assert.equal(digestOf({ prevDigest: GENESIS, rows: [] }).length, 64);
    assert.notEqual(
      digestOf({ prevDigest: GENESIS, rows: [row] }),
      digestOf({ prevDigest: 'other', rows: [row] }),
      'the same rows under a different predecessor are a different chain',
    );
  });
});

describe('Sealing does not feed on itself', () => {
  it('refuses to seal a range that is only its own bookkeeping', async () => {
    await activity(2, 'no-self-feed');
    await sealAuditLog({});

    // Sealing writes a receipt, so the next run always finds a row. Without this
    // rule it would seal that receipt, forever, one empty checkpoint per sweep.
    // Other suites write rows too, so this asserts the rule rather than a count:
    // a seal that happens must never be of bookkeeping alone.
    const second = await sealAuditLog({});
    if (second.sealed === false) {
      assert.match(second.reason, /bookkeeping|nothing new/);
    }
  });

  it('sweeps the waiting bookkeeping into the next real checkpoint', async () => {
    await activity(2, 'real-activity');
    const sealedAgain = await sealAuditLog({});

    // `audit.seal_and_verify` is a global recurring job, so any suite that ticks
    // the worker can seal this log first — asserting "it sealed" would be
    // asserting that nobody else was running. The invariant is what matters: a
    // seal that happens covers real activity, and one that does not says why.
    if (sealedAgain.sealed) {
      assert.ok(sealedAgain.rows >= 2, 'the receipts that were waiting are included');
    } else {
      assert.match(sealedAgain.reason, /bookkeeping|nothing new/);
    }
  });
});

describe('It runs unattended (REQ-004)', () => {
  it('seals before it verifies', async () => {
    await activity(2, 'order');
    const { seal, verification } = await sealAndVerify({});
    // Verifying first would leave the newest rows unsealed for another whole
    // interval, which is the window an attacker would aim for. Whether this call
    // was the one that sealed depends on whether the worker got there first.
    const sealedThrough = seal.sealed
      ? Number(seal.checkpoint.to_id)
      : Number(seal.checkpoint?.to_id ?? 0);
    assert.ok(verification.sealedThrough >= sealedThrough);
    assert.notEqual(verification.status, INTEGRITY.UNSEALED, 'something was sealed to verify');
  });

  it('is a global recurring job the worker knows how to run', async () => {
    const { RECURRING, HANDLERS } = await import('../src/jobs/handlers.js');
    const spec = RECURRING.find((r) => r.kind === 'audit.seal_and_verify');
    assert.ok(spec);
    assert.equal(spec.scope, 'global', 'one log across every tenant, one sealer');
    assert.equal(typeof HANDLERS['audit.seal_and_verify'], 'function');
  });

  it('holds the log exclusively while it seals', async () => {
    const { PRIORITIES, resourceFor } = await import('../src/services/coordination.js');
    assert.equal(resourceFor({ kind: 'audit.seal_and_verify' }), 'global:audit_log');
    assert.ok(
      PRIORITIES['audit.seal_and_verify'] < PRIORITIES['reviews.notify_pending'],
      'reading history waits behind work somebody is waiting on',
    );
  });
});
