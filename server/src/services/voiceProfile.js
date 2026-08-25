/**
 * The author's voice, derived from the author's own previous posts (STORY-009).
 *
 * `social_history` has said since 001_init that it exists "to derive the voice
 * profile"; nothing ever derived one. `authors.voice_profile` was written by
 * hand and passed to the provider, which ignored it, and the agent then scored
 * "voice" as vocabulary overlap with the history — a measure any text about the
 * same book passes. Copy breaking every rule the profile states scored 0.98.
 *
 * So voice becomes measurement rather than description. Every trait here is
 * counted off the author's real posts, which means the profile cannot flatter
 * the drafter and cannot be satisfied by naming the right nouns. It is the same
 * trade STORY-006 made for themes: retrieval over assertion, and offline and
 * reproducible so the stub provider and the tests keep working with no network.
 *
 * The hand-written `voice_profile` is not discarded — it is cross-checked
 * against what the posts actually show, so an author claiming a habit their
 * writing does not support is visible rather than authoritative.
 */

/** Below this many prior posts a trait is noise, and is not enforced. */
export const MIN_POSTS_FOR_TRAIT = 3;

/**
 * Marketing register the author's posts do not use. Deliberately a short,
 * inspectable list rather than a classifier: the drafter must not be able to
 * argue with the rule, and a reviewer has to be able to read it.
 */
const HYPE_TERMS = new Set([
  'amazing', 'awesome', 'blowing', 'boost', 'crush', 'crushing', 'epic', 'exclusive',
  'explode', 'exploding', 'game-changer', 'gamechanger', 'grab', 'growth-hack',
  'growthhack', 'guaranteed', 'hack', 'huge', 'hurry', 'incredible', 'insane',
  'instantly', 'jaw-dropping', 'legendary', 'limited', 'massive', 'mindblowing',
  'must-read', 'revolutionary', 'sensational', 'skyrocket', 'smash', 'stunning',
  'supercharge', 'transform', 'ultimate', 'unbelievable', 'unlock', 'unleash',
  'viral', 'wow',
]);

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'been', 'before', 'being', 'both',
  'came', 'come', 'could', 'does', 'doing', 'done', 'down', 'each', 'even', 'ever',
  'every', 'from', 'gave', 'give', 'going', 'gone', 'have', 'having', 'here', 'into',
  'just', 'keep', 'kept', 'like', 'made', 'make', 'many', 'more', 'most', 'much',
  'must', 'never', 'next', 'once', 'only', 'onto', 'other', 'over', 'same', 'should',
  'since', 'some', 'still', 'such', 'take', 'taken', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'those', 'through',
  'time', 'under', 'until', 'upon', 'very', 'was', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'will', 'with', 'would', 'your',
]);

const words = (text) => String(text).toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];

const contentWords = (text) =>
  words(text).filter((word) => word.length > 3 && !STOP_WORDS.has(word));

/** Sentences, for measuring how long the author lets one run. */
const sentencesOf = (text) =>
  String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Per 100 words, so a long post and a short one are compared on equal terms. */
const per100 = (count, total) => (total === 0 ? 0 : (count * 100) / total);

/** Counts the traits of one piece of text. The same function measures the */
/** author's history and the finished draft, which is what makes them comparable. */
export function measure(text) {
  const all = words(text);
  const sentences = sentencesOf(text);
  const sentenceWords = sentences.map((s) => words(s).length).filter((n) => n > 0);

  const exclamations = (String(text).match(/!/g) ?? []).length;
  const hype = all.filter((word) => HYPE_TERMS.has(word)).length;
  // Two or more capitals in a row, excluding common acronyms picked up by the
  // length floor. Shouting is a register, and this author does not use it.
  const shouted = (String(text).match(/\b[A-Z]{3,}\b/g) ?? []).length;
  const firstPerson = all.filter((word) => word === 'i' || word === 'my' || word === 'me').length;

  return {
    words: all.length,
    sentences: sentences.length,
    meanSentenceWords:
      sentenceWords.length === 0
        ? 0
        : sentenceWords.reduce((a, b) => a + b, 0) / sentenceWords.length,
    exclamationsPer100: per100(exclamations, all.length),
    hypePer100: per100(hype, all.length),
    shoutedPer100: per100(shouted, all.length),
    firstPersonPer100: per100(firstPerson, all.length),
  };
}

/**
 * Derives the voice from the author's previous posts.
 *
 * `posts` below MIN_POSTS_FOR_TRAIT leaves `enforceable` false: with two posts
 * to go on, "this author never uses an exclamation mark" is a coincidence, and
 * escalating a draft over a coincidence spends the reviewer's attention on
 * nothing. A new author is not held to a voice nobody has evidence for.
 *
 * @param {Array<{content: string}>} history
 * @param {object} [stated] The hand-written `authors.voice_profile`, cross-checked.
 */
export function deriveVoice(history = [], stated = {}) {
  const posts = history.filter((h) => h && typeof h.content === 'string');
  const corpus = posts.map((h) => h.content).join('\n\n');
  const measured = measure(corpus);

  const vocabulary = new Set(contentWords(corpus));

  // Per-post means, so one long post does not set the sentence length for all.
  const perPost = posts.map((h) => measure(h.content));
  const mean = (key) =>
    perPost.length === 0 ? 0 : perPost.reduce((total, m) => total + m[key], 0) / perPost.length;

  const derived = {
    posts: posts.length,
    enforceable: posts.length >= MIN_POSTS_FOR_TRAIT,
    vocabulary,
    meanSentenceWords: mean('meanSentenceWords'),
    exclamationsPer100: mean('exclamationsPer100'),
    hypePer100: mean('hypePer100'),
    shoutedPer100: mean('shoutedPer100'),
    firstPersonPer100: mean('firstPersonPer100'),
    words: measured.words,
  };

  return { ...derived, stated: crossCheck(derived, stated) };
}

/**
 * Whether the hand-written profile matches what the posts actually show.
 *
 * Not used for scoring — the posts decide that. It exists so a claim like
 * "avoid: exclamation marks" can be reported as *supported by the writing* or
 * *asserted and unevidenced*, which is the difference between a voice profile
 * and a wish. The mapping is deliberately narrow: only claims we can measure
 * are checked, and the rest are returned untouched rather than guessed at.
 */
export function crossCheck(derived, stated = {}) {
  const claims = [
    ...(stated.avoid ?? []).map((claim) => ({ claim, kind: 'avoid' })),
    ...(stated.habits ?? []).map((claim) => ({ claim, kind: 'habit' })),
  ];

  return claims.map(({ claim, kind }) => {
    const text = String(claim).toLowerCase();
    let supported = null;
    if (text.includes('exclamation')) supported = derived.exclamationsPer100 < 0.5;
    else if (text.includes('hype') || text.includes('growth-hacking')) {
      supported = derived.hypePer100 < 0.5;
    } else if (text.includes('short') && text.includes('sentence')) {
      supported = derived.meanSentenceWords > 0 && derived.meanSentenceWords <= 18;
    }
    return { claim, kind, supported };
  });
}

/**
 * A trait's score: 1.0 while the draft sits inside the author's range, falling
 * off as it leaves. `tolerance` is how far past the author's own rate the draft
 * may go before it starts costing, which keeps a single stray mark from failing
 * an otherwise faithful post.
 */
function ceilingTrait({ observed, authorRate, tolerance }) {
  const allowed = authorRate + tolerance;
  if (observed <= allowed) return 1;
  return Math.max(0, 1 - (observed - allowed) / (tolerance * 2));
}

/**
 * Checks a finished draft against the voice derived from the author's posts.
 *
 * Our code measures; the model does not report on itself. A provider is given
 * the voice and then held to it by the same counts — the acceptance criterion
 * is that the post "sounds like the author", and a criterion the writer grades
 * is not a criterion.
 *
 * @returns {{score: number, violations: string[], traits: Array<object>, summary: string}}
 */
export function checkVoice({ text, voice }) {
  // No evidence, no verdict. 0.6 is the neutral value STORY-001 used when an
  // author had no history, kept so a first-time author is not escalated for
  // having written nothing yet.
  if (!voice || !voice.enforceable) {
    return {
      score: 0.6,
      violations: [],
      traits: [],
      summary: `no voice baseline (${voice?.posts ?? 0} prior posts, need ${MIN_POSTS_FOR_TRAIT})`,
    };
  }

  const m = measure(text);
  const draftVocabulary = contentWords(text);
  const shared =
    draftVocabulary.length === 0
      ? 0
      : draftVocabulary.filter((word) => voice.vocabulary.has(word)).length /
        draftVocabulary.length;

  const traits = [
    {
      trait: 'exclamations',
      observed: Number(m.exclamationsPer100.toFixed(2)),
      author: Number(voice.exclamationsPer100.toFixed(2)),
      weight: 0.2,
      score: ceilingTrait({
        observed: m.exclamationsPer100,
        authorRate: voice.exclamationsPer100,
        tolerance: 1,
      }),
    },
    {
      trait: 'hype',
      observed: Number(m.hypePer100.toFixed(2)),
      author: Number(voice.hypePer100.toFixed(2)),
      weight: 0.25,
      score: ceilingTrait({ observed: m.hypePer100, authorRate: voice.hypePer100, tolerance: 1 }),
    },
    {
      trait: 'shouting',
      observed: Number(m.shoutedPer100.toFixed(2)),
      author: Number(voice.shoutedPer100.toFixed(2)),
      weight: 0.15,
      score: ceilingTrait({
        observed: m.shoutedPer100,
        authorRate: voice.shoutedPer100,
        tolerance: 1,
      }),
    },
    {
      // Two-sided: this author writes short declarative sentences, and copy that
      // runs long is as unlike them as copy that clips into fragments.
      trait: 'sentence_length',
      observed: Number(m.meanSentenceWords.toFixed(1)),
      author: Number(voice.meanSentenceWords.toFixed(1)),
      weight: 0.15,
      score: (() => {
        if (voice.meanSentenceWords === 0 || m.meanSentenceWords === 0) return 0.6;
        const ratio = m.meanSentenceWords / voice.meanSentenceWords;
        const drift = Math.abs(Math.log2(ratio));
        return Math.max(0, 1 - drift);
      })(),
    },
    {
      // The measure STORY-001 used, kept but demoted. Sharing the author's
      // vocabulary is evidence of voice; it is just not the whole of it, and on
      // its own it is satisfied by any text about the same book.
      trait: 'vocabulary',
      observed: Number(shared.toFixed(2)),
      author: 1,
      weight: 0.25,
      score: Math.min(1, shared / 0.35),
    },
  ];

  const score = Number(
    traits.reduce((total, t) => total + t.score * t.weight, 0).toFixed(3),
  );
  const violations = traits.filter((t) => t.score < 0.5).map((t) => t.trait);

  return {
    score,
    violations,
    traits: traits.map((t) => ({ ...t, score: Number(t.score.toFixed(3)) })),
    summary:
      violations.length === 0
        ? `matches the author's ${voice.posts} prior posts`
        : `unlike the author's ${voice.posts} prior posts: ${violations.join(', ')}`,
  };
}
