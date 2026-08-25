/**
 * STORY-009 acceptance tests.
 *
 * The story's Gherkin — "Given the Content Drafting Agent has access to the
 * book's themes and previous posts; When a new social media post draft is
 * requested; Then the agent drafts a post that aligns with the book's themes
 * and the author's voice" — is the first `describe` block.
 *
 * The rest cover what STORY-001 could not. It had access to both inputs, passed
 * them to a provider that ignored them, and then scored itself on how well it
 * had used them with two measures that could not fail: "grounding" asked
 * whether a theme *label* was reused, and "voice" measured vocabulary overlap
 * with the author's prior posts, which any text about the same book shares.
 *
 * The hype test is the one that matters — copy breaking every rule the author's
 * own voice profile states scored 0.994 under the old measure and queued as the
 * best draft in the system.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ACTOR as CONTENT_AGENT } from '../src/agents/contentAlignmentAgent.js';
import {
  ACTOR as DRAFTING_AGENT,
  draftWeeklyPosts,
  scoreDraft,
  termTargetFor,
  themesInPlay,
  withoutTitle,
} from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, pool, query } from '../src/db/pool.js';
import { assess } from '../src/services/escalationPolicy.js';
import { retrieveThemeGrounding } from '../src/services/themeRetrieval.js';
import { MIN_POSTS_FOR_TRAIT, checkVoice, deriveVoice, measure } from '../src/services/voiceProfile.js';

const BOOK_THEMES = ['deep work', 'craft', 'attention', 'resilience'];

/** Paragraph-separated, because a passage is what retrieval returns. */
const BOOK_CONTENT = [
  'Every craft has a moment where technique stops being the point. What remains is attention, ' +
    'and attention is the only real currency any of us spend.',
  'Deep work is not a productivity trick. It is a way of refusing the terms the world offers ' +
    'you by default, and it is almost entirely invisible to everyone but you.',
  'Craft is the slow accumulation of decisions nobody claps for. A carpenter planes a joint ' +
    'that will be hidden inside a cabinet for a hundred years.',
  'Attention is a muscle, and like any muscle it adapts to the load you give it. Give it ' +
    'fragments and it becomes good at fragments.',
  'Resilience is what remains when motivation has gone home for the evening. The people who ' +
    'finish things are rarely the most inspired people in the room.',
].join('\n\n');

const KEY_MESSAGES = {
  'deep work': 'Deep work is a refusal of interruption as a default condition, not a productivity trick.',
  craft: 'Craft is the slow accumulation of decisions nobody claps for.',
  attention: 'Attention is a muscle that adapts to the load you give it.',
  resilience: 'Resilience is what remains when motivation has gone home for the evening.',
};

/** The author's real posts. Short, declarative, no exclamation marks, no hype. */
const PRIOR_POSTS = [
  'Spent the morning reworking one paragraph. Attention is a muscle and mine was weak today.',
  'Craft is the slow accumulation of decisions nobody claps for. Still the most useful thing I know.',
  'The desk at 6am. No inspiration in sight, just practice and a bad first sentence.',
  'Deep work is not a productivity trick. It is a refusal of interruption as a default condition.',
  'A reader asked how I survive the middle of a long project. Honest answer: habits, not motivation.',
];

/** Everything the author's voice profile says to avoid, in one post. */
const HYPE_POST =
  'craft attention Attention is a muscle!!! UNLOCK your craft attention RIGHT NOW!!! ' +
  '10X your writing attention with this ONE WEIRD TRICK!!! Smash that follow button, ' +
  'growth-hack your craft today!!!';

let authorId;
let bookId;
let grounding;
let voice;
let history;

const score = (content, themesUsed, extra = {}) =>
  scoreDraft({
    content,
    themesUsed,
    bookThemes: BOOK_THEMES,
    history,
    maxChars: 280,
    grounding,
    voice,
    bookTitle: 'The Quiet Craft',
    ...extra,
  });

before(async () => {
  const { rows: authorRows } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING *',
    [
      'Social Test Author',
      `social-${Date.now()}@example.test`,
      JSON.stringify({
        tone: ['plain', 'unsentimental', 'warm'],
        habits: ['short declarative sentences', 'concrete images', 'no hype'],
        avoid: ['exclamation marks', 'growth-hacking language'],
      }),
    ],
  );
  authorId = authorRows[0].id;

  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [authorId, 'The Quiet Craft', BOOK_CONTENT, BOOK_THEMES, '2023-04-01'],
  );
  bookId = bookRows[0].id;

  for (const [theme, message] of Object.entries(KEY_MESSAGES)) {
    await query('UPDATE book_themes SET key_message = $3 WHERE book_id = $1 AND theme = $2', [
      bookId,
      theme,
      message,
    ]);
  }

  for (const content of PRIOR_POSTS) {
    await query(
      `INSERT INTO social_history (author_id, platform, content, posted_at)
       VALUES ($1,'twitter',$2, now())`,
      [authorId, content],
    );
  }

  grounding = await retrieveThemeGrounding({ bookId }, pool);
  const { rows } = await query('SELECT content FROM social_history WHERE author_id = $1', [authorId]);
  history = rows;
  const { rows: a } = await query('SELECT voice_profile FROM authors WHERE id = $1', [authorId]);
  voice = deriveVoice(history, a[0].voice_profile);
});

after(async () => {
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await closePool();
});

describe('STORY-009: social posts drafted from the themes and the voice', () => {
  let drafts;

  before(async () => {
    drafts = await draftWeeklyPosts({ authorId, bookId, count: 4 });
  });

  it('drafts a post that aligns with the book themes', () => {
    assert.ok(drafts.length > 0);
    for (const draft of drafts) {
      assert.ok(
        Number(draft.theme_alignment) >= config.minThemeAlignment,
        `${draft.platform} aligned ${draft.theme_alignment}`,
      );
    }
  });

  it('drafts a post that sounds like the author', () => {
    for (const draft of drafts) {
      assert.ok(
        Number(draft.voice_score) >= config.minVoiceMatch,
        `${draft.platform} voice ${draft.voice_score} (${draft.voice_violations})`,
      );
    }
  });

  it('writes from the retrieved passages, not from a theme label', () => {
    for (const draft of drafts) {
      assert.ok(draft.grounded_passages > 0, 'the drafter was given evidence');
    }
    // The book's own words about the theme have to appear, which a post built
    // out of the label and a randomly chosen sentence could only manage by luck.
    const carried = drafts.some((d) =>
      Object.values(KEY_MESSAGES).some((message) =>
        message
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 5)
          .some((word) => d.content.toLowerCase().includes(word)),
      ),
    );
    assert.ok(carried, 'copy carries the book’s own language about its themes');
  });

  it('records a per-theme verdict for every draft', async () => {
    const { rows } = await query(
      `SELECT dt.* FROM draft_themes dt
         JOIN drafts d ON d.id = dt.draft_id
        WHERE d.author_id = $1`,
      [authorId],
    );
    assert.ok(rows.length >= drafts.length, 'each draft is broken down by theme');
    assert.ok(rows.every((r) => r.named), 'a theme in play is one the post names');
    assert.ok(rows.every((r) => r.passage_ids.length > 0), 'each verdict cites its evidence');
  });
});

describe('Voice is measured, not asserted', () => {
  it('derives the author traits from their own previous posts', () => {
    assert.equal(voice.posts, PRIOR_POSTS.length);
    assert.ok(voice.enforceable, 'five posts is enough to hold a draft to');
    assert.equal(voice.exclamationsPer100, 0, 'this author never uses one');
    assert.equal(voice.hypePer100, 0, 'and never reaches for marketing language');
    assert.ok(voice.meanSentenceWords > 0 && voice.meanSentenceWords < 20, 'short sentences');
  });

  it('checks the hand-written profile against what the writing shows', () => {
    const claims = Object.fromEntries(voice.stated.map((c) => [c.claim, c.supported]));
    assert.equal(claims['exclamation marks'], true);
    assert.equal(claims['growth-hacking language'], true);
    assert.equal(claims['short declarative sentences'], true);
    // Not everything a profile claims is measurable, and guessing would be
    // worse than saying so.
    assert.equal(claims['concrete images'], null);
  });

  it('holds nobody to a voice there is no evidence for', () => {
    const thin = deriveVoice([{ content: 'One post.' }], {});
    assert.equal(thin.enforceable, false);
    const checked = checkVoice({ text: HYPE_POST, voice: thin });
    assert.equal(checked.violations.length, 0, 'a new author is not escalated for having no history');
    assert.match(checked.summary, /no voice baseline/);
  });

  it('measures a draft with the same counts it measured the history with', () => {
    const m = measure('Wow!! HUGE news!!');
    assert.ok(m.exclamationsPer100 > 0);
    assert.ok(m.hypePer100 > 0);
    assert.ok(m.shoutedPer100 > 0);
  });

  it('needs at least MIN_POSTS_FOR_TRAIT posts before it enforces anything', () => {
    const justUnder = deriveVoice(PRIOR_POSTS.slice(0, MIN_POSTS_FOR_TRAIT - 1).map((content) => ({ content })), {});
    assert.equal(justUnder.enforceable, false);
    const justEnough = deriveVoice(PRIOR_POSTS.slice(0, MIN_POSTS_FOR_TRAIT).map((content) => ({ content })), {});
    assert.equal(justEnough.enforceable, true);
  });
});

describe('The measure STORY-001 could not fail', () => {
  it('scores copy breaking every stated rule below the voice floor', () => {
    const result = score(HYPE_POST, ['craft', 'attention']);

    assert.ok(
      result.voiceScore < config.minVoiceMatch,
      `hype copy scored ${result.voiceScore} on voice`,
    );
    assert.deepEqual(
      [...result.voiceViolations].sort(),
      ['exclamations', 'hype', 'shouting'],
      'and says which traits it broke',
    );
  });

  it('escalates it on voice even when confidence alone would clear', () => {
    // The reason voice is its own floor rather than a term inside confidence.
    // Blended, a post can buy its way past the threshold with themes and fit.
    const { status, reasons } = assess({
      confidence: 0.85,
      themeAlignment: 0.9,
      voice: 0.385,
    });
    assert.equal(status, 'escalated');
    assert.deepEqual(reasons, ['voice']);
  });

  it('still passes a post that argues the themes in the author own register', () => {
    const result = score(
      'On resilience: what remains when motivation has gone home for the evening. ' +
        'The people who finish are rarely the most inspired.',
      ['resilience'],
    );
    const { status } = assess({
      confidence: result.confidence,
      themeAlignment: result.themeAlignment,
      voice: result.voiceScore,
    });
    assert.equal(status, 'pending_approval', result.rationale);
  });
});

describe('Naming a theme is not arguing it, sideways either', () => {
  it('scores a post that repeats theme labels and argues none below the floor', () => {
    const result = score('craft craft craft. attention attention. resilience and craft again. attention.', [
      'craft',
      'attention',
      'resilience',
    ]);
    assert.ok(
      result.themeAlignment < config.minThemeAlignment,
      `name-checking scored ${result.themeAlignment}`,
    );
  });

  it('gives no credit on one theme for naming the others', () => {
    // The book's passages discuss its themes together, so "attention" is a
    // distinctive word of craft's evidence. Without excluding every label, a
    // post naming four themes argued each one by naming the other three.
    const result = score('craft and attention and resilience and deep work', BOOK_THEMES);
    const craft = result.perTheme.find((t) => t.theme === 'craft');
    assert.equal(craft.messageScore, 0, 'naming its neighbours is not arguing craft');
  });

  it('does not credit a theme the post only names through the book title', () => {
    assert.equal(withoutTitle('A page from "The Quiet Craft" today', 'The Quiet Craft').includes('Craft'), false);
    const inPlay = themesInPlay({
      content: 'A page from "The Quiet Craft" on resilience.',
      claimed: ['resilience'],
      grounding,
      bookTitle: 'The Quiet Craft',
    });
    assert.deepEqual(inPlay.map((t) => t.theme), ['resilience'], 'the title is not an argument');
  });

  it('scores a theme the post claimed but never named at zero', () => {
    const result = score('Attention is a muscle that adapts to the load you give it.', [
      'attention',
      'resilience',
    ]);
    const overclaimed = result.perTheme.find((t) => t.theme === 'resilience');
    assert.equal(overclaimed.named, false);
    assert.equal(overclaimed.score, 0, 'claiming a theme you did not write about costs you');
  });

  it('flags a claimed theme the book does not have', () => {
    const result = score('Maps and memory are what I care about most.', ['maps']);
    const invented = result.perTheme.find((t) => t.theme === 'maps');
    assert.equal(invented.known, false, 'the book claims no such theme');
    assert.ok(result.themeAlignment < config.minThemeAlignment);
  });

  it('asks a longer post to carry more of the book than a tweet does', () => {
    assert.equal(termTargetFor('a'.repeat(240)), 3, 'a tweet cannot carry eight of the book’s words');
    assert.equal(
      termTargetFor('a'.repeat(3000)),
      config.themeMessageTermTarget,
      'a long post faces the press-release target and no more',
    );
  });
});

describe('TBI: retrieval and voice derivation are on the audit log', () => {
  it('records what the drafter was given, before recording what it produced', async () => {
    const { rows } = await query(
      `SELECT action, actor, metadata FROM audit_log
        WHERE author_id = $1 AND action IN ('social.themes_retrieved','social.voice_derived')
        ORDER BY id`,
      [authorId],
    );
    assert.equal(rows.length >= 2, true, 'both halves of the grounding are logged');
    assert.equal(rows[0].action, 'social.themes_retrieved', 'retrieval comes first');
    assert.equal(rows[0].actor, CONTENT_AGENT);
    assert.ok(rows[0].metadata.passageCount > 0);

    const derived = rows.find((r) => r.action === 'social.voice_derived');
    assert.equal(derived.metadata.priorPosts, PRIOR_POSTS.length);
    assert.equal(derived.metadata.enforceable, true);
    assert.ok(Array.isArray(derived.metadata.statedClaims));
  });

  it('records the floors a draft was judged against, so a decision is re-derivable', async () => {
    const { rows } = await query(
      `SELECT metadata FROM audit_log
        WHERE author_id = $1 AND actor = $2 AND action LIKE 'draft.%'
        ORDER BY id DESC LIMIT 1`,
      [authorId, DRAFTING_AGENT],
    );
    const meta = rows[0].metadata;
    assert.equal(meta.minVoiceMatch, config.minVoiceMatch);
    assert.equal(meta.minThemeAlignment, config.minThemeAlignment);
    assert.ok(typeof meta.voiceScore === 'number');
    assert.ok(Array.isArray(meta.voiceTraits) && meta.voiceTraits.length > 0);
  });
});

describe('Degrading rather than escalating wholesale', () => {
  it('falls back to the STORY-001 measures when a book has no grounding', () => {
    const result = scoreDraft({
      content: 'A post about craft and attention.',
      themesUsed: ['craft'],
      bookThemes: BOOK_THEMES,
      history,
      maxChars: 280,
    });
    assert.match(result.rationale, /grounding=/, 'the old label marks the degraded path');
    assert.ok(result.confidence > 0, 'an unindexed book is scored, not zeroed');
  });
});
