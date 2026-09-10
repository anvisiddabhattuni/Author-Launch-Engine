/**
 * STORY-018 acceptance tests.
 *
 * The first `describe` block maps onto the single Gherkin scenario on the
 * Basecamp story — "Given the agent has access to the book's themes; When PR
 * material generation is requested; Then the agent drafts materials that align
 * with the book's themes and author's voice". The rest cover the half of that
 * sentence the codebase could not previously fail (voice was never gated), the
 * Trust-Before-Intelligence control the story requires (an approval gate on all
 * generated PR materials), and the queries that would have silently dropped a
 * kit with no milestone.
 *
 * This author is seeded with five prior posts on purpose. Below
 * MIN_POSTS_FOR_TRAIT the voice is not enforceable and every draft scores the
 * neutral 0.6, which would make every assertion here pass for the wrong reason.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  generatePrMaterials,
  proseOf,
  scoreMaterial,
} from '../src/agents/aiContentGenerationAgent.js';
import { trustDashboard } from '../src/agents/trustMonitoringAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { approvePrMaterial } from '../src/services/approvals.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { CHECKS, runChecks } from '../src/services/governance.js';
import { distributePressKit } from '../src/services/prDistributor.js';
import { findKitsAwaitingReview, notifyPendingReviews } from '../src/services/reviewNotifier.js';
import { deriveVoice } from '../src/services/voiceProfile.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

const BOOK_CONTENT = [
  'Attention is a muscle, and like any muscle it adapts to the load you give it. ' +
    'Deep work is a way of refusing the terms the world offers you by default.',
  'Craft is the slow accumulation of decisions nobody claps for and nobody sees. ' +
    'The work is mostly maintenance, and maintenance is where the craft lives.',
  'Resilience is what remains when motivation has gone home for the evening. ' +
    'It is the least romantic of the virtues and the only one that reliably shows up.',
].join('\n\n');

/** Five prior posts: enough to clear MIN_POSTS_FOR_TRAIT, so voice is enforced. */
const HISTORY = [
  'Craft is the slow accumulation of decisions nobody claps for.',
  'Attention is a muscle and mine was weak today. Showed up anyway.',
  'Deep work is mostly refusing things. The refusing is the work.',
  'Resilience looks boring from the outside. It is boring from the inside too.',
  'Spent the morning on one paragraph. The paragraph won.',
];

let authorId;
let bookId;
let otherAuthorId;

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Generation Test Author',
      `generation-${Date.now()}@example.test`,
      JSON.stringify({
        tone: ['plain', 'unsentimental'],
        habits: ['short declarative sentences'],
        avoid: ['exclamation marks', 'growth-hacking language'],
      }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES],
  );
  bookId = bookRows[0].id;

  for (const content of HISTORY) {
    await query(
      'INSERT INTO social_history (author_id, platform, content, posted_at) VALUES ($1,$2,$3,now())',
      [authorId, 'twitter', content],
    );
  }

  // A second tenant, to check the command will not cross between them.
  const { rows: otherRows } = await query(
    'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING *',
    ['Other Generation Author', `generation-other-${Date.now()}@example.test`],
  );
  otherAuthorId = otherRows[0].id;

  await query(
    `INSERT INTO press_contacts (outlet, name, email, beats) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING`,
    ['The Craft Review', 'On Beat', 'generation-onbeat@press.test', ['craft', 'books']],
  );
});

after(async () => {
  await closePool();
});

/**
 * A kit per test: only one on-demand kit may be drafting per book, so each test
 * that wants a fresh one marks the previous kit distributed first.
 */
const clearDraftingKits = async () => {
  await query(
    "UPDATE pr_kits SET status = 'superseded' WHERE book_id = $1 AND status = 'drafting'",
    [bookId],
  );
};

describe('Scenario: PR materials are generated', () => {
  let result;

  before(async () => {
    await clearDraftingKits();
    result = await generatePrMaterials({ authorId, bookId, requestedBy: 'Publicist' });
  });

  it('drafts a full kit when generation is requested, with no milestone', async () => {
    assert.equal(result.materials.length, 3);
    assert.deepEqual(
      result.materials.map((m) => m.type).sort(),
      ['author_bio', 'fact_sheet', 'press_release'],
    );
    assert.equal(result.kit.milestone_id, null);
    assert.equal(result.kit.occasion, 'on_demand');
    assert.equal(result.kit.angle, 'evergreen');
    assert.equal(result.kit.requested_by, 'Publicist');
  });

  it('had access to the book\'s themes before it wrote a word', () => {
    // The "Given" of the scenario, as a fact about the run rather than a claim.
    assert.equal(result.grounding.themes.length, BOOK_THEMES.length);
    assert.ok(result.grounding.passageCount > 0);
    assert.equal(result.kit.grounded_themes, BOOK_THEMES.length);
    assert.ok(result.kit.grounded_passages > 0);
  });

  it('aligns the materials with the book\'s themes', () => {
    for (const material of result.materials) {
      assert.ok(
        Number(material.theme_alignment) >= config.minThemeAlignment,
        `${material.type} aligned ${material.theme_alignment}, floor ${config.minThemeAlignment}`,
      );
      assert.ok(material.themes_used.length > 0);
    }
  });

  it('aligns the materials with the author\'s voice', () => {
    for (const material of result.materials) {
      assert.notEqual(material.voice_score, null, `${material.type} has no voice verdict`);
      assert.ok(
        Number(material.voice_score) >= config.minVoiceMatch,
        `${material.type} voice ${material.voice_score}, floor ${config.minVoiceMatch}`,
      );
    }
    // And the verdict is a real measurement, not the neutral score a new author
    // gets — which is the only way the previous assertion means anything.
    assert.equal(result.voice.enforceable, true);
    assert.equal(result.voice.posts, HISTORY.length);
  });

  it('records which passage grounded each theme, per material', async () => {
    const { rows } = await query(
      `SELECT t.* FROM pr_material_themes t
         JOIN pr_materials m ON m.id = t.material_id
        WHERE m.kit_id = $1`,
      [result.kit.id],
    );
    assert.equal(rows.length, BOOK_THEMES.length * 3);
    assert.ok(rows.some((r) => r.passage_ids.length > 0));
  });

  it('leaves every material behind the approval gate', () => {
    for (const material of result.materials) {
      assert.ok(['pending_approval', 'escalated'].includes(material.status));
    }
  });
});

describe('The voice floor can actually fail', () => {
  // Copy that argues the book's themes perfectly, in a register this author has
  // never used. Before STORY-018 this passed: `assess()` was called without a
  // voice number, so there was nothing for the floor to act on.
  const hypeProvider = {
    name: 'test-off-voice',
    async draftKit() {
      const body =
        'FOR IMMEDIATE RELEASE\n\n' +
        'This is an absolutely AMAZING and incredible book about deep work, craft, ' +
        'attention and resilience, and it is guaranteed to transform your entire life ' +
        'in ways you will find frankly unbelievable and completely game-changing!!! ' +
        'Attention is a muscle! Craft is the slow accumulation of decisions nobody ' +
        'claps for! Deep work is a way of refusing the terms the world offers you by ' +
        'default, and resilience is what remains when motivation has gone home, which ' +
        'is honestly just insane and epic and you should grab this massive smash hit ' +
        'immediately before this limited exclusive offer disappears forever!!!\n\n' +
        'ABOUT THE BOOK — an amazing book.\n\n' +
        'MEDIA CONTACT — press@example.test';
      return ['press_release', 'author_bio', 'fact_sheet'].map((type) => ({
        type,
        headline: 'An AMAZING and incredible book about deep work and craft!!!',
        body,
        themesUsed: BOOK_THEMES,
      }));
    },
  };

  let materials;

  before(async () => {
    await clearDraftingKits();
    ({ materials } = await generatePrMaterials({
      authorId,
      bookId,
      provider: hypeProvider,
    }));
  });

  it('escalates copy that does not sound like the author', () => {
    for (const material of materials) {
      assert.equal(material.status, 'escalated', `${material.type} was not escalated`);
      assert.ok(
        Number(material.voice_score) < config.minVoiceMatch,
        `${material.type} scored ${material.voice_score} on voice`,
      );
    }
  });

  it('names voice as the reason, separately from theme alignment', async () => {
    // The point of the separation: this copy names every theme, so alignment is
    // fine. Only the voice floor catches it.
    const release = materials.find((m) => m.type === 'press_release');
    assert.ok(Number(release.theme_alignment) >= config.minThemeAlignment);

    const entries = await listAuditLog({ authorId, entityType: 'pr_material' });
    const escalation = entries.find(
      (e) => e.action === 'pr_material.escalated' && String(e.entity_id) === String(release.id),
    );
    assert.ok(escalation, 'no escalation was recorded');
    assert.ok(escalation.metadata.escalatedFor.includes('voice'));
  });

  it('tells the reviewer which traits failed', () => {
    const release = materials.find((m) => m.type === 'press_release');
    assert.ok(release.voice_violations.length > 0);
    assert.ok(release.voice_violations.includes('hype'));
    assert.match(release.rationale, /voice=0\.\d\d/);
  });
});

describe('Voice is measured on the prose, not on the format', () => {
  it('drops the furniture a press kit is required to carry', () => {
    const prose = proseOf(
      'FOR IMMEDIATE RELEASE\nNEW RELEASE\n\nTITLE — The Quiet Craft\n' +
        'SUMMARY — Craft is the slow accumulation of decisions nobody claps for.\n###',
    );
    assert.equal(prose.includes('FOR IMMEDIATE RELEASE'), false);
    assert.equal(prose.includes('###'), false);
    // The label goes; the sentence behind it stays, because that is the part
    // the author is answerable for.
    assert.equal(prose.includes('SUMMARY —'), false);
    assert.ok(prose.includes('Craft is the slow accumulation'));
    assert.ok(prose.includes('The Quiet Craft'));
  });

  it('does not fail a fact sheet for being a fact sheet', async () => {
    const { rows: history } = await query(
      'SELECT content FROM social_history WHERE author_id = $1',
      [authorId],
    );
    const voice = deriveVoice(history, {});
    const labels = [
      'TITLE — The Quiet Craft',
      'AUTHOR — Generation Test Author',
      'THEMES — deep work · craft · attention · resilience',
      'SUMMARY — Craft is the slow accumulation of decisions nobody claps for.',
      'MEDIA CONTACT — someone@example.test',
    ].join('\n');

    const scored = scoreMaterial({
      type: 'fact_sheet',
      headline: '"The Quiet Craft" — fact sheet',
      body: labels,
      bookThemes: BOOK_THEMES,
      bookContent: BOOK_CONTENT,
      history,
      voice,
    });

    // Counted raw, the capitalised labels read as sustained shouting and the
    // sheet fails on format alone. That is a format measurement, not a voice
    // one, and a floor built on it would escalate everything.
    assert.ok(scored.voiceScore >= config.minVoiceMatch, `scored ${scored.voiceScore}`);
    assert.equal(scored.voiceViolations.includes('shouting'), false);
  });
});

describe('TBI: the approval gate covers materials nobody scheduled', () => {
  let kit;
  let materials;

  before(async () => {
    await clearDraftingKits();
    ({ kit, materials } = await generatePrMaterials({ authorId, bookId }));
  });

  it('refuses to distribute an on-demand kit until every material is approved', async () => {
    await assert.rejects(
      () => distributePressKit({ kitId: kit.id }),
      (error) => {
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  it('distributes once a human has approved them', async () => {
    for (const material of materials) {
      await approvePrMaterial({ materialId: material.id, reviewer: 'Press Reviewer' });
    }
    const { distributions } = await distributePressKit({ kitId: kit.id });
    assert.ok(distributions.length > 0);
  });

  it('holds the governance invariant that the gate was not routed around', async () => {
    const results = await runChecks({});
    const gate = results.find((r) => r.id === 'gate.press');
    assert.equal(gate.passed, true, gate.detail ?? 'gate.press failed');
  });

  it('checks from outside that every new material was measured for voice', async () => {
    assert.ok(CHECKS.some((c) => c.id === 'press.voice_measured'));
    const results = await runChecks({});
    const measured = results.find((r) => r.id === 'press.voice_measured');
    assert.equal(measured.passed, true, `${measured.violations} materials carry no voice verdict`);
  });
});

describe('A kit with no milestone is still visible to the people who gate it', () => {
  let kit;

  before(async () => {
    await clearDraftingKits();
    ({ kit } = await generatePrMaterials({ authorId, bookId }));
  });

  it('reaches the review queue', async () => {
    const waiting = await findKitsAwaitingReview({ authorId }, { query });
    const found = waiting.find((k) => Number(k.id) === Number(kit.id));
    assert.ok(found, 'the on-demand kit was not in the review queue');
    // No milestone to name it, so it says what it is rather than showing a hole.
    assert.equal(found.milestone_title, 'PR materials requested directly');
    assert.equal(found.milestone_type, null);
  });

  it('can be described in the mail that asks a human to look at it', async () => {
    // Found by running the demo twice. `announces()` fell through to
    // `a ${kit.milestone_type}` and the body did
    // `new Date(kit.event_date)` — and `new Date(null)` is the epoch rather
    // than an error, so the reviewer would have been told this kit announces
    // "a null" on 1 January 1970.
    const sent = [];
    const notifier = {
      async send({ to, subject, body }) {
        sent.push({ to, subject, body });
        return { externalId: `rec_${sent.length}`, acceptedAt: new Date().toISOString() };
      },
    };
    await query(
      `INSERT INTO reviewers (author_id, name, email, role, active)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,
      [authorId, 'Kit Reviewer', `kit-reviewer-${Date.now()}@example.test`, 'publicist'],
    );

    await notifyPendingReviews({ authorId, notifier });

    const about = sent.find((m) => m.body.includes('requested directly'));
    assert.ok(about, 'no mail described the on-demand kit');
    assert.equal(about.subject.includes('null'), false);
    assert.equal(about.body.includes('1970'), false);
    assert.equal(about.body.includes('null'), false);
  });

  it('reaches the trust dashboard', async () => {
    const dashboard = await trustDashboard({ authorId });
    assert.ok(dashboard.governance);
    // The dashboard's own queue counts this kit's materials. `pr_materials` is
    // read by author rather than through the milestone, so this is the half
    // that already worked — asserted so it stays that way.
    assert.ok((dashboard.queue.byKind.prMaterial ?? 0) >= 3);
    assert.ok(dashboard.queue.items.some((i) => i.kind === 'prMaterial'));
  });
});

describe('What it refuses', () => {
  it('refuses a second kit while one is still in progress', async () => {
    await clearDraftingKits();
    await generatePrMaterials({ authorId, bookId });
    await assert.rejects(
      () => generatePrMaterials({ authorId, bookId }),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /already has PR materials in progress/);
        return true;
      },
    );
  });

  it('refuses to generate for another tenant\'s book', async () => {
    await assert.rejects(
      () => generatePrMaterials({ authorId: otherAuthorId, bookId }),
      (error) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  it('escalates rather than inventing themes for a book that has none', async () => {
    const { rows } = await query(
      'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
      [authorId, 'The Unindexed', 'A book with no themes recorded against it.', []],
    );

    const { materials, grounding } = await generatePrMaterials({
      authorId,
      bookId: rows[0].id,
    });

    assert.equal(grounding.themes.length, 0);
    for (const material of materials) {
      assert.equal(material.status, 'escalated');
      assert.equal(Number(material.theme_alignment), 0);
    }
  });
});

describe('TBI: the record says who generated what, and from what', () => {
  let kit;

  before(async () => {
    await clearDraftingKits();
    ({ kit } = await generatePrMaterials({ authorId, bookId, requestedBy: 'Publicist' }));
  });

  it('names the AI Content Generation Agent as the actor', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'pr_kit' });
    const drafted = entries.find(
      (e) => e.action === 'pr_kit.drafted' && String(e.entity_id) === String(kit.id),
    );
    assert.ok(drafted);
    assert.equal(drafted.actor, 'AIContentGenerationAgent');
    assert.equal(drafted.metadata.occasion, 'on_demand');
    assert.equal(drafted.metadata.requestedBy, 'Publicist');
  });

  it('records the themes it was given before it wrote', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'pr_kit' });
    const retrieved = entries.find(
      (e) => e.action === 'pr_kit.themes_retrieved' && String(e.entity_id) === String(kit.id),
    );
    assert.ok(retrieved, 'no retrieval was recorded');
    assert.equal(retrieved.actor, 'AIContentGenerationAgent');
    assert.ok(retrieved.metadata.passageCount > 0);
  });

  it('records the voice it derived, and from how many posts', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'author' });
    const derived = entries.find((e) => e.action === 'pr.voice_derived');
    assert.ok(derived, 'no voice derivation was recorded');
    assert.equal(derived.metadata.enforceable, true);
    assert.equal(derived.metadata.priorPosts, HISTORY.length);
    // A Set is not serialisable; the size is the finding worth keeping.
    assert.equal(typeof derived.metadata.vocabulary, 'number');
  });
});
