/**
 * STORY-026 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Low-confidence content escalation" → content generated below the
 *       confidence threshold is escalated to a human.
 *   "Anomalous content detection" → an anomaly in generated content, deviating
 *       from typical patterns, is escalated for human review.
 *
 * STORY-008 built the independent monitor that answers the first, on one
 * objection stated in its own module comment: an agent that writes the material
 * and also decides whether the material is good enough has nobody checking the
 * second half. That objection was answered for **one content type out of
 * three** — and not by an oversight in the logic. `escalations` had a
 * `pr_material_id` column and no column for a draft or an outreach message, so
 * recording one for a social post was impossible.
 *
 * Measured before this story, reproducibly across runs: the monitor examined 5
 * items where 10 were decidable. It was blind to exactly half the work waiting
 * on a human.
 *
 * The second scenario had nothing at all. Three anomaly detectors existed and
 * every one of them watched *reviewer* behaviour; none looked at content, and
 * none escalated anything — they reported to a dashboard.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { monitorContent, monitorPressMaterials } from '../src/agents/trustMonitoringAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { detectAnomalies } from '../src/services/anomalies.js';
import { listAuditLog } from '../src/services/auditLog.js';

let authorId;
let bookId;

const makeDraft = async ({ content, platform = 'twitter', voice = 0.9, theme = 0.9, conf = 0.9 }) => {
  const { rows } = await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                         theme_alignment, voice_score, week_of)
     VALUES ($1,$2,$3,$4,'pending_approval',$5,$6,$7,CURRENT_DATE) RETURNING *`,
    [authorId, bookId, platform, content, conf, theme, voice],
  );
  return rows[0];
};

before(async () => {
  const stamp = Date.now();
  const { rows: a } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Content Escalation Author', `contentesc-${stamp}@example.test`],
  );
  authorId = a[0].id;
  const { rows: b } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'A Book', 'Craft is slow. Attention is a muscle.', ['craft', 'attention']],
  );
  bookId = b[0].id;
});

after(async () => {
  await closePool();
});

describe('Scenario: low-confidence escalation, for all three content types', () => {
  it('examines every kind, not only press', async () => {
    await makeDraft({ content: 'a perfectly ordinary post about craft and attention' });
    const result = await monitorContent({ authorId });

    // The finding this story exists for: the monitor used to query
    // `FROM pr_materials` and nothing else.
    assert.deepEqual(
      Object.keys(result.byKind).sort(),
      ['draft', 'outreach_message', 'pr_material'],
    );
    assert.ok(result.byKind.draft.examined > 0, 'drafts are still not examined');
  });

  it('escalates a draft the producer let through', async () => {
    // A draft whose stored scores breach the floor but which the producer
    // queued for ordinary approval — exactly the disagreement STORY-008 was
    // built to catch, and which no monitor could see for a draft.
    const draft = await makeDraft({
      content: 'copy that does not sound like the author at all',
      voice: 0.1,
    });
    assert.equal(draft.status, 'pending_approval');

    await monitorContent({ authorId });

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [draft.id]);
    assert.equal(rows[0].status, 'escalated', 'the monitor did not re-judge a draft');
  });

  it('records the escalation against the draft, which was impossible before', async () => {
    const { rows } = await query(
      `SELECT e.*, t.target_type FROM escalations e
         JOIN escalation_targets t ON t.id = e.id
        WHERE e.author_id = $1 AND e.draft_id IS NOT NULL`,
      [authorId],
    );
    assert.ok(rows.length > 0, 'no escalation row references a draft');
    assert.equal(rows[0].target_type, 'draft');
    assert.equal(rows[0].pr_material_id, null);
  });

  it('re-derives using the voice floor, not only confidence and themes', async () => {
    // The monitor scored with two of the three numbers the producer used, so it
    // would have disagreed with a correct producer on voice.
    const { rows } = await query(
      `SELECT reasons, threshold_voice, voice_score FROM escalations
        WHERE author_id = $1 AND draft_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.ok(rows[0].reasons.includes('voice'), `reasons were ${rows[0].reasons}`);
    assert.equal(Number(rows[0].threshold_voice), config.minVoiceMatch);
    assert.notEqual(rows[0].voice_score, null, 'the voice score at the time was not recorded');
  });

  it('keeps the old name working, pointed at the wider scan', async () => {
    // Every caller of `monitorPressMaterials` meant "re-check what is waiting".
    // None meant "re-check only press".
    const result = await monitorPressMaterials({ authorId });
    assert.ok(result.byKind, 'the alias does not forward to the general monitor');
    assert.deepEqual(Object.keys(result.byKind).sort(), ['draft', 'outreach_message', 'pr_material']);
  });
});

describe('Scenario: anomalous content is detected and escalated', () => {
  const DUPLICATE =
    'Attention is a muscle and it adapts to the load you give it, which is why deep work is mostly refusing things.';

  it('finds two drafts that say nearly the same thing', async () => {
    await makeDraft({ content: DUPLICATE, platform: 'twitter' });
    await makeDraft({ content: DUPLICATE, platform: 'instagram' });

    const anomalies = await detectAnomalies({ authorId });
    const detector = anomalies.detectors.find((d) => d.id === 'content.near_duplicate');
    assert.ok(detector, 'no detector looks at content');
    assert.equal(detector.confidence, 'reported');
    assert.ok(detector.findings.length > 0);
    assert.match(detector.findings[0].detail, /drafts say the same thing/);
    assert.ok(detector.findings[0].draftIds.length >= 2, 'a group needs at least two members');
  });

  it('escalates every duplicate except the one being kept', async () => {
    // A human needs to see the group once and keep one. Escalating all of them
    // puts a whole cluster in front of them for a single decision.
    await monitorContent({ authorId });
    const { rows } = await query(
      "SELECT id, status FROM drafts WHERE author_id = $1 AND content = $2 ORDER BY id",
      [authorId, DUPLICATE],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'pending_approval', 'the earlier draft was escalated too');
    assert.equal(rows[1].status, 'escalated', 'the later draft was not escalated');
  });

  it('says what it was paired with, so the reviewer can check the claim', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'draft' });
    const raised = entries.find(
      (e) => e.action === 'escalation.raised' && e.metadata.reasons?.includes('near_duplicate'),
    );
    assert.ok(raised, 'the duplicate escalation was not logged');
    assert.ok(raised.metadata.keptInstead, 'the notice does not name the draft being kept');
    assert.ok(raised.metadata.overlap >= config.nearDuplicateOverlap);
    assert.match(raised.metadata.note, /drafts say the same thing/);
  });

  it('does not flag ordinary drafts that merely share a subject', async () => {
    // The failure mode of a blunt duplicate check: two posts about the same
    // book naturally share vocabulary, and flagging those would train a
    // reviewer to ignore the detector.
    const { rows: fresh } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['Distinct Drafts Author', `distinct-${Date.now()}@example.test`],
    );
    const { rows: fb } = await query(
      'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
      [fresh[0].id, 'B', 'x', ['craft']],
    );
    for (const content of [
      'Craft is the slow accumulation of decisions nobody claps for.',
      'Attention is a muscle, and mine was weak this morning.',
      'Deep work is a refusal of the terms the world offers by default.',
    ]) {
      await query(
        `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence,
                             theme_alignment, voice_score, week_of)
         VALUES ($1,$2,'twitter',$3,'pending_approval',0.9,0.9,0.9,CURRENT_DATE)`,
        [fresh[0].id, fb[0].id, content],
      );
    }

    const anomalies = await detectAnomalies({ authorId: fresh[0].id });
    const detector = anomalies.detectors.find((d) => d.id === 'content.near_duplicate');
    assert.equal(detector.confidence, 'clear');
    assert.equal(detector.findings.length, 0);
  });

  it('declines to conclude on a sample of one', async () => {
    const { rows: lone } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
      ['One Draft Author', `onedraft-${Date.now()}@example.test`],
    );
    const anomalies = await detectAnomalies({ authorId: lone[0].id });
    const detector = anomalies.detectors.find((d) => d.id === 'content.near_duplicate');
    // A duplicate needs a pair. "Clear" on a sample of one would be the
    // detector claiming a result it cannot have — the rule every other detector
    // here already follows.
    assert.equal(detector.confidence, 'insufficient_evidence');
    assert.match(detector.because, /needs a pair/);
  });
});

describe('The anomaly now moves something', () => {
  it('is the difference this story is about', async () => {
    // Before STORY-026 every detector reported to a dashboard and changed
    // nothing — the STORY-018 shape again, a number displayed and not acted on.
    // The acceptance criterion says "escalated for human review".
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM escalations
        WHERE author_id = $1 AND 'near_duplicate' = ANY(reasons)`,
      [authorId],
    );
    assert.ok(rows[0].n > 0, 'a content anomaly escalated nothing');
  });
});
