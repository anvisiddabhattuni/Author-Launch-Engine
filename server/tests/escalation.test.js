/**
 * STORY-008 acceptance tests.
 *
 * The story's one Gherkin scenario is the first `describe` block. Escalation
 * itself already worked before this story — what did not exist was the agent it
 * names. The drafting agent decided its own fate, so a producer whose check was
 * wrong, missing, or written against a policy that has since been tightened
 * would never have been noticed by anything.
 *
 * The rest cover what an independent monitor has to get right to be worth
 * having: it raises and never clears, it does not overrule a human, and running
 * it repeatedly changes nothing the first run did not.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { draftPressKit } from '../src/agents/prMaterialsAgent.js';
import {
  ACTOR as TRUST_AGENT,
  listEscalations,
  monitorPressMaterials,
} from '../src/agents/trustMonitoringAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial } from '../src/services/approvals.js';
import { REASONS, assess } from '../src/services/escalationPolicy.js';
import { notifyRaisedEscalations } from '../src/services/reviewNotifier.js';

const stamp = Date.now();
const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];
const BOOK_CONTENT = [
  'Craft is the slow accumulation of decisions nobody claps for.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it.',
  'Resilience is what remains when motivation has gone home for the evening.',
  'Deep work is a way of refusing the terms the world offers you by default.',
].join('\n\n');

const original = {
  confidence: config.confidenceEscalationThreshold,
  alignment: config.minThemeAlignment,
};

let authorId;
let bookId;

const sent = [];
const notifier = {
  name: 'test-escalation-notifier',
  async send({ to, subject, body }) {
    sent.push({ to, subject, body });
    return { externalId: `esc_${sent.length}` };
  },
};

async function freshKit(title, daysAhead) {
  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, location, details)
     VALUES ($1,$2,'launch',$3,$4,'Ljubljana','First print run.') RETURNING *`,
    [authorId, bookId, title, new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10)],
  );
  return draftPressKit({ milestoneId: rows[0].id });
}

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [`Trust Author ${stamp}`, `trust-${stamp}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = a[0].id;

  const { rows: b } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,'The Quiet Craft',$2,$3,'2023-04-01') RETURNING *`,
    [authorId, BOOK_CONTENT, BOOK_THEMES],
  );
  bookId = b[0].id;
});

beforeEach(() => {
  config.confidenceEscalationThreshold = original.confidence;
  config.minThemeAlignment = original.alignment;
});

after(async () => {
  config.confidenceEscalationThreshold = original.confidence;
  config.minThemeAlignment = original.alignment;
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-008: escalation of low-confidence PR drafts', () => {
  let materials;

  before(async () => {
    ({ materials } = await freshKit('Monitored launch', 40));
    // The precondition is constructed rather than hoped for. The stub's
    // confidence for an author bio sits close to the default threshold and
    // moves with the milestone id — which varies with whatever else has run —
    // so leaving it to chance makes this suite fail about one run in three for
    // a reason that has nothing to do with what it is testing.
    await query("UPDATE pr_materials SET status = 'pending_approval' WHERE id = ANY($1)", [
      materials.map((m) => m.id),
    ]);
    materials = materials.map((m) => ({ ...m, status: 'pending_approval' }));
  });

  it('Given drafts the producer queued as fine', async () => {
    assert.ok(materials.length > 0);
    const { rows } = await query('SELECT status FROM pr_materials WHERE id = ANY($1)', [
      materials.map((m) => m.id),
    ]);
    assert.ok(
      rows.every((r) => r.status === 'pending_approval'),
      'this scenario starts with nothing escalated',
    );
  });

  it('When the Trust and Monitoring Agent detects low confidence, Then they are escalated', async () => {
    // The bar moves after the work was drafted — a policy tightened today
    // should catch yesterday's drafts that are still sitting unapproved. This
    // is exactly the case a producer that judges only its own output at draft
    // time can never catch.
    config.confidenceEscalationThreshold = 0.99;

    const scan = await monitorPressMaterials({ authorId });
    assert.equal(scan.examined, materials.length);
    assert.equal(scan.raised.length, materials.length, 'nothing was escalated');

    const { rows } = await query('SELECT status FROM pr_materials WHERE id = ANY($1)', [
      materials.map((m) => m.id),
    ]);
    assert.ok(rows.every((r) => r.status === 'escalated'), 'the drafts are not waiting on a human');
  });

  it('records why, with the scores and the thresholds it judged against', async () => {
    const escalations = await listEscalations({ authorId });
    assert.equal(escalations.length, materials.length);

    for (const escalation of escalations) {
      assert.equal(escalation.detected_by, 'monitor');
      assert.equal(escalation.agreed, false, 'the producer and the monitor disagreed');
      assert.deepEqual(escalation.reasons, [REASONS.CONFIDENCE]);
      assert.equal(Number(escalation.threshold_confidence), 0.99);
      assert.ok(escalation.open, 'it should still be waiting on a human');
    }
  });

  it('audits the raise under the Trust and Monitoring Agent', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'escalation.raised'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0]);
    assert.equal(rows[0].actor, TRUST_AGENT);
    assert.equal(rows[0].metadata.producerStatus, 'pending_approval');
    assert.deepEqual(rows[0].metadata.reasons, [REASONS.CONFIDENCE]);
  });

  it('records the scan itself, so a run that found nothing is still visible', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'trust.scan_completed'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0]);
    assert.equal(rows[0].actor, TRUST_AGENT);
    assert.ok(rows[0].metadata.examined >= 1);
  });
});

describe('The monitor raises, and never clears', () => {
  let materials;

  before(async () => {
    // Drafted under a bar nothing can clear, so the producer escalates
    // everything itself.
    config.confidenceEscalationThreshold = 0.99;
    ({ materials } = await freshKit('Producer-escalated launch', 55));
    config.confidenceEscalationThreshold = original.confidence;
  });

  it('leaves an escalation in place even when current policy would not have raised it', async () => {
    assert.ok(materials.every((m) => m.status === 'escalated'));

    // Back at the normal threshold these would sail through. The monitor must
    // not undo a concern that has already been raised.
    const scan = await monitorPressMaterials({ authorId });
    assert.ok(scan.producerStricter.length > 0);

    const { rows } = await query('SELECT status FROM pr_materials WHERE id = ANY($1)', [
      materials.map((m) => m.id),
    ]);
    assert.ok(
      rows.every((r) => r.status === 'escalated'),
      'the monitor de-escalated something, which it must never do',
    );
  });

  it('says so on the log rather than silently disagreeing', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'escalation.producer_stricter'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0]);
    assert.equal(rows[0].actor, TRUST_AGENT);
    assert.match(rows[0].metadata.note, /never clears/);
  });
});

describe('The monitor does not overrule a human', () => {
  it('leaves alone anything a person has already decided', async () => {
    const { materials } = await freshKit('Already decided launch', 70);
    for (const material of materials) {
      await approvePrMaterial({ materialId: material.id, reviewer: 'A Human' });
    }

    config.confidenceEscalationThreshold = 0.99;
    const scan = await monitorPressMaterials({ authorId });

    const { rows } = await query('SELECT status FROM pr_materials WHERE id = ANY($1)', [
      materials.map((m) => m.id),
    ]);
    assert.ok(
      rows.every((r) => r.status === 'approved'),
      'the monitor reopened something a person had approved',
    );
    assert.ok(
      !scan.raised.some((r) => materials.some((m) => Number(m.id) === Number(r.id))),
      'approved work should not even be examined',
    );
  });

  it('skips withdrawn copy, which nobody can act on anyway', async () => {
    const { kit, materials } = await freshKit('Superseded launch', 85);
    await query("UPDATE pr_kits SET status = 'superseded' WHERE id = $1", [kit.id]);

    config.confidenceEscalationThreshold = 0.99;
    const scan = await monitorPressMaterials({ authorId });

    assert.ok(
      !scan.raised.some((r) => materials.some((m) => Number(m.id) === Number(r.id))),
      'a reviewer should not be sent to copy the system refuses to let them decide',
    );
  });
});

describe('Running the monitor again changes nothing', () => {
  it('records one escalation per material however many scans run', async () => {
    config.confidenceEscalationThreshold = 0.99;
    await monitorPressMaterials({ authorId });
    const first = await listEscalations({ authorId });

    await monitorPressMaterials({ authorId });
    await monitorPressMaterials({ authorId });
    const third = await listEscalations({ authorId });

    assert.equal(third.length, first.length, 'repeat scans piled up duplicate rows');
  });

  it('raises nothing on a second pass, because the first already did', async () => {
    config.confidenceEscalationThreshold = 0.99;
    await monitorPressMaterials({ authorId });
    const again = await monitorPressMaterials({ authorId });
    assert.equal(again.raised.length, 0);
  });
});

describe('The read model', () => {
  it('closes an escalation when the material is decided, without storing a second state', async () => {
    const { materials } = await freshKit('Read model launch', 100);
    config.confidenceEscalationThreshold = 0.99;
    await monitorPressMaterials({ authorId });

    const open = (await listEscalations({ authorId })).filter(
      (e) => materials.some((m) => Number(m.id) === Number(e.pr_material_id)) && e.open,
    );
    assert.ok(open.length > 0);

    await approvePrMaterial({ materialId: materials[0].id, reviewer: 'A Human' });

    const after = (await listEscalations({ authorId })).find(
      (e) => Number(e.pr_material_id) === Number(materials[0].id),
    );
    assert.equal(after.open, false, 'the queue should follow the material, not a copy of its state');
    assert.equal(after.material_status, 'approved');
  });
});

describe('One policy, shared', () => {
  it('is a pure function of the stored scores, which is what makes re-derivation possible', () => {
    config.confidenceEscalationThreshold = 0.7;
    config.minThemeAlignment = 0.5;

    assert.deepEqual(assess({ confidence: 0.9, themeAlignment: 0.9 }), {
      status: 'pending_approval',
      reasons: [],
    });
    assert.deepEqual(assess({ confidence: 0.1, themeAlignment: 0.9 }), {
      status: 'escalated',
      reasons: [REASONS.CONFIDENCE],
    });
    assert.deepEqual(assess({ confidence: 0.1, themeAlignment: 0.1 }), {
      status: 'escalated',
      reasons: [REASONS.CONFIDENCE, REASONS.THEME_ALIGNMENT],
    });
  });

  it('only considers theme alignment where there is one', () => {
    config.confidenceEscalationThreshold = 0.7;
    // Social drafts and outreach have no alignment score; passing null must not
    // silently read as zero and escalate everything.
    assert.deepEqual(assess({ confidence: 0.9 }), { status: 'pending_approval', reasons: [] });
  });
});

describe('Telling someone the monitor caught something', () => {
  it('notifies reviewers about a monitor-raised escalation', async () => {
    await query(
      'INSERT INTO reviewers (author_id, name, email, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [authorId, 'Dana Vogel', `dana-${stamp}@example.test`, 'publisher'],
    );

    config.confidenceEscalationThreshold = 0.99;
    await monitorPressMaterials({ authorId });
    await notifyRaisedEscalations({ authorId, notifier });

    // Asserted against the database rather than this call's return value. The
    // worker sweep in the jobs suite runs `trust.monitor_escalations` for every
    // author, so in a parallel run it may legitimately have sent these first —
    // the requirement is that the reviewer was told, not that this line did it.
    const { rows } = await query(
      `SELECT n.*, e.detected_by
         FROM notifications n
         JOIN escalations e ON e.id = n.escalation_id
        WHERE n.author_id = $1
        ORDER BY n.id DESC`,
      [authorId],
    );

    assert.ok(rows.length > 0, 'nobody was told about the escalation');
    assert.ok(rows.every((r) => r.detected_by === 'monitor'), 'only monitor raises should notify');
    assert.match(rows[0].subject, /Escalated by monitoring/);
    assert.match(rows[0].body, /queued for/);
    assert.equal(rows[0].status, 'sent');
  });

  it('does not tell the same reviewer about the same escalation twice', async () => {
    const { rows: before } = await query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE author_id = $1 AND escalation_id IS NOT NULL',
      [authorId],
    );

    await notifyRaisedEscalations({ authorId, notifier });
    await notifyRaisedEscalations({ authorId, notifier });

    const { rows: after } = await query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE author_id = $1 AND escalation_id IS NOT NULL',
      [authorId],
    );
    assert.equal(after[0].n, before[0].n, 'a repeat run mailed somebody twice');
  });
});
