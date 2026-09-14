/**
 * STORY-023 acceptance tests.
 *
 * Two Gherkin scenarios:
 *
 *   "Draft content generation"      → a content request produces a draft ready
 *       for human review.
 *   "Content alignment with themes" → the AI uses the book's themes and the
 *       author's voice, so the draft aligns with the intended style and message.
 *
 * The story names three content types: social posts, outreach messages and PR
 * materials. Two of them already had both halves — social since STORY-009, press
 * since STORY-006 and STORY-018. Outreach had neither, while *appearing* to:
 * `scoreMessage` had a number called "grounding" and a number called "voice",
 * and both were the measures the other two stories replaced.
 *
 *   grounding counted a theme as hit if any single word of it appeared
 *   anywhere — "deep work" satisfied by the word "work", including in "I would
 *   love to work with you" — then floored at 0.55 for one hit.
 *
 *   voice was vocabulary overlap with prior posts, the function
 *   011_social_grounding.sql records scoring 0.994 on copy breaking every rule
 *   the author's voice profile states.
 *
 * Neither was a floor: `assess({ confidence })` was called with no
 * themeAlignment and no voice, so both were blended into one score and outvoted
 * by personalisation. A hype-filled pitch that merely named the venue scored
 * 0.79 and queued for ordinary approval — on the channel that emails a named
 * stranger with the author's name on it.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { draftOutreachMessages, scoreMessage } from '../src/agents/prOutreachAgent.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import { assess } from '../src/services/escalationPolicy.js';
import { listAuditLog } from '../src/services/auditLog.js';
import { retrieveThemeGrounding } from '../src/services/themeRetrieval.js';
import { deriveVoice } from '../src/services/voiceProfile.js';

const THEMES = ['deep work', 'craft', 'attention', 'resilience'];

const CONTENT = [
  'Attention is a muscle, and like any muscle it adapts to the load you give it. ' +
    'Deep work is a way of refusing the terms the world offers you by default.',
  'Craft is the slow accumulation of decisions nobody claps for and nobody sees.',
  'Resilience is what remains when motivation has gone home for the evening.',
].join('\n\n');

const HISTORY = [
  'Craft is the slow accumulation of decisions nobody claps for.',
  'Attention is a muscle and mine was weak today. Showed up anyway.',
  'Deep work is mostly refusing things. The refusing is the work.',
  'Resilience looks boring from the outside. It is boring from the inside too.',
];

let authorId;
let bookId;
let grounding;
let voice;

before(async () => {
  const { rows: a } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Outreach Grounding Author',
      `outreachgrounding-${Date.now()}@example.test`,
      JSON.stringify({ tone: ['plain'], avoid: ['exclamation marks', 'hype'] }),
    ],
  );
  authorId = a[0].id;

  const { rows: b } = await query(
    'INSERT INTO books (author_id, title, content, themes) VALUES ($1,$2,$3,$4) RETURNING *',
    [authorId, 'The Quiet Craft', CONTENT, THEMES],
  );
  bookId = b[0].id;

  for (const content of HISTORY) {
    await query(
      'INSERT INTO social_history (author_id, platform, content, posted_at) VALUES ($1,$2,$3,now())',
      [authorId, 'twitter', content],
    );
  }

  // Key messages are written by a person, never inferred — the same rule the
  // seed follows. Without them the claims come from retrieved passages.
  await query(
    `UPDATE book_themes SET key_message = $3 WHERE book_id = $1 AND theme = $2`,
    [bookId, 'craft', 'Craft is the slow accumulation of decisions nobody claps for.'],
  );

  const { rows: history } = await query(
    'SELECT content FROM social_history WHERE author_id = $1',
    [authorId],
  );
  grounding = await retrieveThemeGrounding({ bookId }, { query });
  voice = deriveVoice(history, {});
});

after(async () => {
  await closePool();
});

/** The pitch that used to pass. Personalised, on-topic by accident, and hype. */
const HYPE = {
  subject: 'AMAZING guest opportunity for The Focus Podcast!!!',
  body:
    'Hi Dana! I would absolutely LOVE to work with The Focus Podcast in London!!! ' +
    'This is an incredible, game-changing, guaranteed-viral opportunity you simply ' +
    'cannot miss. Mira is a massive name and this will be your best episode ever!!!',
  personalization: ['The Focus Podcast', 'Dana', 'London'],
};

/** A pitch that carries what the book actually argues, in a plain register. */
const ON_MESSAGE = {
  subject: 'Guest pitch for The Focus Podcast: The Quiet Craft',
  body:
    'Hi Dana,\n\nI have been listening to The Focus Podcast. I wrote "The Quiet Craft".\n\n' +
    'On craft — craft is the slow accumulation of decisions nobody claps for and nobody sees.\n' +
    'On attention — attention is a muscle, and like any muscle it adapts to the load you give it.\n\n' +
    'Would you be open to having me on this season?',
  personalization: ['The Focus Podcast', 'Dana'],
};

describe('Scenario: content alignment with themes and voice', () => {
  it('escalates the hype pitch that used to queue for ordinary approval', () => {
    const scored = scoreMessage({
      ...HYPE,
      bookThemes: THEMES,
      history: HISTORY.map((content) => ({ content })),
      grounding,
      voice,
    });
    const verdict = assess({
      confidence: scored.confidence,
      themeAlignment: scored.themeAlignment,
      voice: scored.voiceScore,
    });

    assert.equal(verdict.status, 'escalated');
    // All three floors catch it, and each says something different.
    assert.ok(verdict.reasons.includes('theme_alignment'));
    assert.ok(verdict.reasons.includes('voice'));
    assert.ok(scored.voiceViolations.includes('hype'));
    assert.ok(scored.voiceViolations.includes('exclamations'));
  });

  it('does not escalate a pitch that carries the book\'s argument', () => {
    const scored = scoreMessage({
      ...ON_MESSAGE,
      bookThemes: THEMES,
      history: HISTORY.map((content) => ({ content })),
      // Narrowed the way the agent narrows it: this pitch is about two themes.
      grounding: { ...grounding, themes: grounding.themes.filter((t) => ['craft', 'attention'].includes(t.theme)) },
      voice,
    });
    const verdict = assess({
      confidence: scored.confidence,
      themeAlignment: scored.themeAlignment,
      voice: scored.voiceScore,
    });

    assert.ok(
      scored.themeAlignment >= config.minThemeAlignment,
      `aligned ${scored.themeAlignment}, floor ${config.minThemeAlignment}`,
    );
    assert.ok(scored.voiceScore >= config.minVoiceMatch, `voice ${scored.voiceScore}`);
    assert.equal(verdict.status, 'pending_approval');
  });

  it('no longer credits a theme for one accidental word', () => {
    // "deep work" used to be satisfied by the word "work" anywhere in the text,
    // then floored at 0.55. This is the exact sentence that did it.
    const scored = scoreMessage({
      subject: 'Hello',
      body: 'I would love to work with you on an episode about productivity.',
      personalization: [],
      bookThemes: THEMES,
      history: HISTORY.map((content) => ({ content })),
      grounding,
      voice,
    });
    assert.equal(scored.themeAlignment, 0, 'an accidental word still scores as a theme');
  });

  it('keeps the old measure only as the no-retrieval fallback', () => {
    // A book whose themes were never indexed still gets the weak check rather
    // than a zero it has not earned — the same degradation `scoreMaterial` uses.
    const scored = scoreMessage({
      ...ON_MESSAGE,
      bookThemes: THEMES,
      history: HISTORY.map((content) => ({ content })),
      grounding: null,
      voice,
    });
    assert.ok(scored.themeAlignment > 0);
    assert.match(scored.rationale, /no retrieval/);
  });
});

describe('Scenario: draft content generation', () => {
  let drafted;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO opportunities
         (author_id, source, external_id, type, name, host, contact_email, url,
          description, topics, relevance, matched_themes, rationale,
          discovered_month, status)
       VALUES ($1,'directory',$2,'podcast','The Focus Podcast','Dana Reyes',
               'dana@focus.test','https://focus.test',
               'A show about focus and writing practice.',
               $3,0.9,$4,'matched on craft and attention',
               date_trunc('month', now())::date,'identified')
       RETURNING *`,
      [authorId, `focus-${Date.now()}`, ['focus', 'writing'], ['craft', 'attention']],
    );
    assert.ok(rows[0]);
    drafted = await draftOutreachMessages({ authorId, bookId });
  });

  it('creates a draft held for human review', () => {
    assert.ok(drafted.length > 0);
    for (const message of drafted) {
      assert.ok(['pending_approval', 'escalated'].includes(message.status));
    }
  });

  it('stores the theme and voice verdicts rather than blending them away', () => {
    for (const message of drafted) {
      assert.notEqual(message.theme_alignment, null, 'no theme verdict stored');
      assert.notEqual(message.voice_score, null, 'no voice verdict stored');
      assert.ok(Array.isArray(message.voice_violations));
      assert.ok(message.grounded_passages > 0, 'drafted from no retrieved passages');
    }
  });

  it('records which passage grounded each theme', async () => {
    const { rows } = await query(
      `SELECT t.* FROM outreach_message_themes t
         JOIN outreach_messages m ON m.id = t.message_id
        WHERE m.author_id = $1`,
      [authorId],
    );
    assert.ok(rows.length > 0, 'no per-theme evidence stored');
    assert.ok(rows.some((r) => r.passage_ids.length > 0));
  });

  it('writes from the retrieved claims, not a sentence picked at random', () => {
    // The generation half. Before this the pitch quoted whatever sentence the
    // seed happened to land on, which is not retrieval.
    const message = drafted[0];
    assert.match(message.body, /What the book argues:/);
    assert.match(message.body, /slow accumulation of decisions/);
  });

  it('logs the retrieval and the voice it was given, before it wrote', async () => {
    const bookEntries = await listAuditLog({ authorId, entityType: 'book' });
    const retrieved = bookEntries.find((e) => e.action === 'outreach.themes_retrieved');
    assert.ok(retrieved, 'retrieval was not recorded');
    assert.equal(retrieved.actor, 'AIContentGenerationAgent');

    const authorEntries = await listAuditLog({ authorId, entityType: 'author' });
    const derived = authorEntries.find((e) => e.action === 'outreach.voice_derived');
    assert.ok(derived, 'voice derivation was not recorded');
    assert.equal(derived.metadata.priorPosts, HISTORY.length);
    assert.equal(typeof derived.metadata.vocabulary, 'number');
  });

  it('logs the alignment separately from the drafting', async () => {
    const entries = await listAuditLog({ authorId, entityType: 'outreach_message' });
    const aligned = entries.find((e) => e.action === 'outreach.aligned');
    assert.ok(aligned, 'no alignment entry');
    // The agent that checked it, not the agent that commanded the draft.
    assert.equal(aligned.actor, 'AIContentGenerationAgent');
    assert.ok('namedOnly' in aligned.metadata);
  });
});

describe('All three content types are now measured the same way', () => {
  it('scores themes and voice for social, press and outreach alike', async () => {
    // The story names all three. Before it, outreach was the odd one out —
    // and it is the channel that emails a named stranger.
    const columns = async (table) => {
      const { rows } = await query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      return new Set(rows.map((r) => r.column_name));
    };

    for (const table of ['drafts', 'pr_materials', 'outreach_messages']) {
      const cols = await columns(table);
      assert.ok(cols.has('theme_alignment'), `${table} has no theme_alignment`);
      assert.ok(cols.has('voice_score'), `${table} has no voice_score`);
      assert.ok(cols.has('voice_violations'), `${table} has no voice_violations`);
    }
  });

  it('keeps per-theme evidence for all three', async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('draft_themes','pr_material_themes','outreach_message_themes')`,
    );
    assert.equal(rows.length, 3);
  });
});
