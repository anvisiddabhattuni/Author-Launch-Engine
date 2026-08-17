/**
 * STORY-003 acceptance tests.
 *
 * The first `describe` block maps onto the single Gherkin scenario on the
 * Basecamp story; the rest cover REQ-003's second acceptance criterion
 * (milestone coverage) and the Trust-Before-Intelligence controls the story
 * requires (approval gate before distribution, audit log, escalation).
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  draftPressKit,
  scoreMaterial,
  themeAlignment,
  MATERIAL_TYPES,
} from '../src/agents/prMaterialsAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial, rejectPrMaterial } from '../src/services/approvals.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { distributePressKit, selectRecipients } from '../src/services/prDistributor.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

let authorId;
let bookId;

/** Milestones are created per test so each one gets its own kit. */
async function createMilestone(type, daysAhead, title) {
  const eventDate = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
  const { rows } = await query(
    `INSERT INTO milestones (author_id, book_id, type, title, event_date, location, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      authorId,
      bookId,
      type,
      title,
      eventDate,
      'Ljubljana',
      'First print run of 8,000 copies, with a launch reading at the city library.',
    ],
  );
  return rows[0];
}

const approveAll = async (materials, reviewer = 'Press Reviewer') => {
  for (const material of materials) {
    await approvePrMaterial({ materialId: material.id, reviewer });
  }
};

before(async () => {
  const { rows: authorRows } = await query(
    `INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *`,
    [
      'Press Test Author',
      `press-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain', 'unsentimental'] }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [
      authorId,
      'The Quiet Craft',
      'Attention is a muscle, and like any muscle it adapts to the load you give it. ' +
        'Craft is the slow accumulation of decisions nobody claps for and nobody sees. ' +
        'Resilience is what remains when motivation has gone home for the evening. ' +
        'Deep work is a way of refusing the terms the world offers you by default.',
      BOOK_THEMES,
    ],
  );
  bookId = bookRows[0].id;

  for (const content of [
    'Craft is the slow accumulation of decisions nobody claps for.',
    'Attention is a muscle and mine was weak today. Showed up anyway.',
  ]) {
    await query(
      'INSERT INTO social_history (author_id, platform, content, posted_at) VALUES ($1,$2,$3,now())',
      [authorId, 'twitter', content],
    );
  }

  // The press list is seeded, but tests must not depend on `npm run db:seed`
  // having been run, so ensure the two contacts these tests assert on exist.
  await query(
    `INSERT INTO press_contacts (outlet, name, email, beats) VALUES
       ('Test Craft Desk', 'On Beat', 'onbeat@press.test', ARRAY['craft','books']),
       ('Test Freight Weekly', 'Off Beat', 'offbeat@press.test', ARRAY['logistics','freight'])
     ON CONFLICT (email) DO NOTHING`,
  );
});

after(async () => {
  await closePool();
});

describe('Scenario: PR draft creation for book launch', () => {
  let milestone;
  let materials;

  before(async () => {
    // Given a book launch event is scheduled
    milestone = await createMilestone('launch', 21, 'The Quiet Craft — hardcover launch');
    // When the PR and Outreach Agent drafts PR material
    ({ materials } = await draftPressKit({ milestoneId: milestone.id }));
  });

  it('drafts a full press kit for the scheduled launch', () => {
    assert.equal(materials.length, MATERIAL_TYPES.length);
    assert.deepEqual(
      [...materials.map((m) => m.type)].sort(),
      [...MATERIAL_TYPES].sort(),
    );
  });

  it('aligns every material with the book themes', () => {
    // Then the draft is aligned with the book's themes
    for (const material of materials) {
      assert.ok(
        Number(material.theme_alignment) > 0,
        `${material.type} referenced none of the book's themes`,
      );
      assert.ok(
        Number(material.theme_alignment) >= config.minThemeAlignment,
        `${material.type} alignment ${material.theme_alignment} is below the floor`,
      );
      assert.ok(material.themes_used.length > 0);
    }
  });

  it('records only themes the material actually contains, not the provider\'s claim', () => {
    for (const material of materials) {
      const haystack = `${material.headline}\n${material.body}`.toLowerCase();
      for (const theme of material.themes_used) {
        assert.ok(haystack.includes(theme.toLowerCase()), `"${theme}" is not in the ${material.type}`);
      }
    }
  });

  it('holds every material for human review rather than distributing it', () => {
    // Then ... held for human review
    for (const material of materials) {
      assert.ok(['pending_approval', 'escalated'].includes(material.status));
    }
  });

  it('creates no distribution rows before review', async () => {
    const { rows } = await query('SELECT * FROM pr_distributions WHERE kit_id = $1', [
      materials[0].kit_id,
    ]);
    assert.equal(rows.length, 0);
  });

  it('writes a press release with the elements a newsroom expects', () => {
    const release = materials.find((m) => m.type === 'press_release');
    const body = release.body.toLowerCase();
    for (const marker of ['for immediate release', 'about the book', 'media contact']) {
      assert.ok(body.includes(marker), `press release is missing "${marker}"`);
    }
    assert.ok(release.headline.length > 0);
  });
});

describe('REQ-003: drafts are created for major book milestones', () => {
  it('changes the angle for each milestone type', async () => {
    const headlines = {};
    for (const [type, title] of [
      ['award', 'The Quiet Craft shortlisted for the Vermilion Prize'],
      ['anniversary', 'The Quiet Craft — an anniversary in print'],
    ]) {
      const milestone = await createMilestone(type, 60 + Object.keys(headlines).length, title);
      const { materials } = await draftPressKit({ milestoneId: milestone.id });
      headlines[type] = materials.find((m) => m.type === 'press_release').headline;
    }

    assert.notEqual(headlines.award, headlines.anniversary);
    // This book carries no publication date, so the number of years is unknowable
    // and the copy must not invent one. The counted case is in anniversaries.test.js.
    assert.match(headlines.anniversary, /another year in print/i);
    assert.doesNotMatch(headlines.anniversary, /\bfirst\b|\bone year\b/i);
  });

  it('refuses a second kit for the same milestone', async () => {
    const milestone = await createMilestone('launch', 200, 'Duplicate kit milestone');
    await draftPressKit({ milestoneId: milestone.id });

    await assert.rejects(
      () => draftPressKit({ milestoneId: milestone.id }),
      /already has a press kit/,
    );
  });

  it('rejects an unknown milestone', async () => {
    await assert.rejects(() => draftPressKit({ milestoneId: 99999999 }), /Milestone not found/);
  });
});

describe('Theme alignment scoring', () => {
  it('counts only themes that appear verbatim', () => {
    const { score, matched } = themeAlignment(
      'A book about craft and attention, written slowly.',
      BOOK_THEMES,
    );
    assert.deepEqual(matched, ['craft', 'attention']);
    assert.equal(score, 0.5);
  });

  it('scores an off-message material at zero alignment', () => {
    const { score, matched } = themeAlignment(
      'A thriller about submarines and international finance.',
      BOOK_THEMES,
    );
    assert.equal(score, 0);
    assert.deepEqual(matched, []);
  });

  it('weights alignment above everything else in the confidence score', () => {
    const shared = { bookThemes: BOOK_THEMES, bookContent: 'attention craft', history: [] };

    const aligned = scoreMaterial({
      type: 'fact_sheet',
      headline: 'Fact sheet',
      body: 'TITLE — X\nAUTHOR — Y\nTHEMES — deep work, craft, attention, resilience',
      ...shared,
    });
    const offMessage = scoreMaterial({
      type: 'fact_sheet',
      headline: 'Fact sheet',
      body: 'TITLE — X\nAUTHOR — Y\nTHEMES — submarines, finance, weather, shipping',
      ...shared,
    });

    assert.ok(aligned.confidence > offMessage.confidence);
    assert.equal(aligned.themeAlignment, 1);
    assert.equal(offMessage.themeAlignment, 0);
  });
});

describe('TBI: escalation', () => {
  /** Well-formed copy about entirely the wrong book. */
  const offMessageProvider = {
    name: 'test-off-message',
    async draftKit() {
      return MATERIAL_TYPES.map((type) => ({
        type,
        headline: 'A thriller about submarines and international finance',
        body:
          'FOR IMMEDIATE RELEASE\n\nTITLE — Submarines\nAUTHOR — Someone Else\n' +
          'THEMES — sonar, freight, weather\n\nABOUT THE BOOK — naval fiction.\n' +
          'MEDIA CONTACT — press@example.test',
        themesUsed: ['sonar'],
      }));
    },
  };

  let escalated;

  before(async () => {
    const milestone = await createMilestone('launch', 300, 'Off-message milestone');
    ({ materials: escalated } = await draftPressKit({
      milestoneId: milestone.id,
      provider: offMessageProvider,
    }));
  });

  it('escalates polished copy that ignores the book themes', () => {
    for (const material of escalated) {
      assert.equal(Number(material.theme_alignment), 0);
      assert.equal(material.status, 'escalated');
    }
  });

  it('escalates on alignment even when the material is well formed', () => {
    // The press release has every required element, so completeness is high;
    // only the alignment floor catches it.
    const release = escalated.find((m) => m.type === 'press_release');
    assert.match(release.rationale, /completeness=1\.00/);
    assert.equal(Number(release.theme_alignment), 0);
  });

  it('records no themes for a material that referenced none', () => {
    assert.ok(escalated.every((m) => m.themes_used.length === 0));
  });

  it('records why each material was escalated', async () => {
    const { rows } = await query(
      `SELECT * FROM audit_log
        WHERE author_id = $1 AND action = 'pr_material.escalated'
        ORDER BY id DESC LIMIT 1`,
      [authorId],
    );
    assert.deepEqual(rows[0].metadata.escalatedFor, ['confidence', 'theme_alignment']);
    assert.equal(rows[0].metadata.themeAlignment, 0);
  });

  it('an escalated material still blocks distribution until a human clears it', async () => {
    await assert.rejects(
      () => distributePressKit({ kitId: escalated[0].kit_id }),
      /not approved/,
    );
  });
});

describe('TBI: approval gate before distribution', () => {
  it('refuses to distribute a kit where nothing is approved', async () => {
    const milestone = await createMilestone('launch', 400, 'Gate milestone one');
    const { kit } = await draftPressKit({ milestoneId: milestone.id });

    await assert.rejects(() => distributePressKit({ kitId: kit.id }), /cannot be distributed/);

    const { rows } = await query('SELECT * FROM pr_distributions WHERE kit_id = $1', [kit.id]);
    assert.equal(rows.length, 0);
  });

  it('still refuses when only some of the kit is approved', async () => {
    const milestone = await createMilestone('launch', 401, 'Gate milestone two');
    const { kit, materials } = await draftPressKit({ milestoneId: milestone.id });

    await approvePrMaterial({ materialId: materials[0].id, reviewer: 'Press Reviewer' });

    await assert.rejects(
      () => distributePressKit({ kitId: kit.id }),
      /2 of 3 materials are not approved/,
    );
  });

  it('a single rejected material blocks the whole kit', async () => {
    const milestone = await createMilestone('launch', 402, 'Gate milestone three');
    const { kit, materials } = await draftPressKit({ milestoneId: milestone.id });

    await approvePrMaterial({ materialId: materials[0].id, reviewer: 'Press Reviewer' });
    await approvePrMaterial({ materialId: materials[1].id, reviewer: 'Press Reviewer' });
    await rejectPrMaterial({
      materialId: materials[2].id,
      reviewer: 'Press Reviewer',
      notes: 'Reads like a brochure',
    });

    await assert.rejects(() => distributePressKit({ kitId: kit.id }), /not approved/);
  });

  it('logs a blocked distribution even though the transaction rolled back', async () => {
    const milestone = await createMilestone('launch', 403, 'Gate milestone four');
    const { kit } = await draftPressKit({ milestoneId: milestone.id });

    await assert.rejects(() => distributePressKit({ kitId: kit.id }));

    const entries = await listAuditLog({ authorId, limit: 200 });
    const blocked = entries.find(
      (e) => e.action === 'pr_kit.distribute_blocked' && String(e.entity_id) === String(kit.id),
    );
    assert.ok(blocked, 'no pr_kit.distribute_blocked entry was written');
    assert.match(blocked.metadata.reason, /approval gate/);
    assert.ok(blocked.metadata.blocking.length > 0);
  });

  it('distributes once every material is approved', async () => {
    const milestone = await createMilestone('launch', 404, 'Happy path milestone');
    const { kit, materials } = await draftPressKit({ milestoneId: milestone.id });

    await approveAll(materials);
    const { kit: updated, distributions } = await distributePressKit({ kitId: kit.id });

    assert.equal(updated.status, 'distributed');
    assert.ok(distributions.length > 0);
    assert.ok(distributions.every((d) => d.status === 'sent'));
    assert.ok(distributions.every((d) => d.external_id));
  });

  it('marks the materials distributed once the kit goes out', async () => {
    const { rows } = await query(
      `SELECT DISTINCT p.status FROM pr_materials p
         JOIN pr_kits k ON k.id = p.kit_id
        WHERE k.status = 'distributed' AND p.author_id = $1`,
      [authorId],
    );
    assert.deepEqual(rows.map((r) => r.status), ['distributed']);
  });

  it('refuses to distribute the same kit twice', async () => {
    const { rows } = await query(
      "SELECT id FROM pr_kits WHERE author_id = $1 AND status = 'distributed' LIMIT 1",
      [authorId],
    );
    await assert.rejects(
      () => distributePressKit({ kitId: rows[0].id }),
      /already been distributed/,
    );
  });

  it('requires a reviewer name on every decision', async () => {
    const milestone = await createMilestone('launch', 405, 'Reviewer required milestone');
    const { materials } = await draftPressKit({ milestoneId: milestone.id });

    await assert.rejects(
      () => approvePrMaterial({ materialId: materials[0].id, reviewer: '  ' }),
      /reviewer name is required/,
    );
  });

  it('will not re-decide a material that is already approved', async () => {
    const milestone = await createMilestone('launch', 406, 'Re-decide milestone');
    const { materials } = await draftPressKit({ milestoneId: milestone.id });

    await approvePrMaterial({ materialId: materials[0].id, reviewer: 'Press Reviewer' });
    await assert.rejects(
      () => approvePrMaterial({ materialId: materials[0].id, reviewer: 'Press Reviewer' }),
      /can no longer be decided/,
    );
  });
});

describe('Press list targeting', () => {
  it('sends only to contacts whose beat matches a book theme', () => {
    const contacts = [
      { id: 1, outlet: 'On', email: 'a@t.test', beats: ['craft', 'books'] },
      { id: 2, outlet: 'Off', email: 'b@t.test', beats: ['logistics'] },
      { id: 3, outlet: 'Also on', email: 'c@t.test', beats: ['attention'] },
    ];
    const selected = selectRecipients(contacts, BOOK_THEMES);

    assert.deepEqual(selected.map((s) => s.contact.id), [1, 3]);
    assert.deepEqual(selected[0].matchedBeats, ['craft']);
  });

  it('excluded the off-beat outlet from a real distribution', async () => {
    const { rows } = await query(
      `SELECT DISTINCT recipient FROM pr_distributions WHERE author_id = $1`,
      [authorId],
    );
    const recipients = rows.map((r) => r.recipient);
    assert.ok(recipients.includes('onbeat@press.test'));
    assert.ok(!recipients.includes('offbeat@press.test'));
  });
});

describe('TBI: audit trail', () => {
  it('records drafting, approval and distribution in order', async () => {
    const entries = await listAuditLog({ authorId, limit: 400 });
    const actions = entries.map((e) => e.action);

    for (const action of [
      'pr_material.drafted',
      'pr_kit.drafted',
      'pr_material.approved',
      'pr_kit.distribute_blocked',
      'pr_kit.distributed_to',
      'pr_kit.distributed',
    ]) {
      assert.ok(actions.includes(action), `audit log is missing "${action}"`);
    }
  });

  it('names the human on every approval', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'pr_material', limit: 200 });
    const approvals = entries.filter((e) => e.action === 'pr_material.approved');

    assert.ok(approvals.length > 0);
    assert.ok(approvals.every((e) => e.actor && e.actor !== 'PROutreachAgent'));
  });

  it('keeps the press-material audit entries append-only', async () => {
    const { rows } = await query(
      "SELECT id FROM audit_log WHERE action = 'pr_kit.distributed' LIMIT 1",
    );
    await assert.rejects(
      () => query('UPDATE audit_log SET actor = $1 WHERE id = $2', ['tamper', rows[0].id]),
      /append-only/,
    );
  });
});

describe('Approvals table integrity', () => {
  it('accepts a press material as a third approval target', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total FROM approvals
        WHERE pr_material_id IS NOT NULL AND draft_id IS NULL AND outreach_message_id IS NULL`,
    );
    assert.ok(rows[0].total > 0);
  });

  it('still refuses an approval pointing at two things at once', async () => {
    const { rows } = await query('SELECT id FROM pr_materials LIMIT 1');
    await assert.rejects(
      () =>
        query(
          `INSERT INTO approvals (draft_id, pr_material_id, decision, reviewer)
           VALUES (1, $1, 'approved', 'Nobody')`,
          [rows[0].id],
        ),
      /approvals_exactly_one_target/,
    );
  });
});
