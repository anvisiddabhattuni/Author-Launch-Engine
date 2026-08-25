/**
 * What the author is qualified to be invited to (STORY-010).
 *
 * STORY-002 scored a listing against one thing: whether its topics repeated one
 * of the four theme labels on the book being promoted. Nothing modelled the
 * author. The cost was a real lead — "Library Author Nights: evening talks
 * where authors discuss their books with local reading groups" scores exactly
 * 0.000 against 'deep work, craft, attention, resilience' and was discarded
 * without a record. It is an ideal speaking slot; it simply never repeats a
 * theme. It does not want a lecture on attention, it wants an author.
 *
 * So expertise is split in two, because the domain is:
 *
 *   subjects — what this author can credibly speak *about*, derived from every
 *     book they have written and what they actually post about. Wider than one
 *     book's four labels, which is the point: an author is not only their
 *     latest title.
 *
 *   standing — what this author *is*, and therefore the shapes of engagement
 *     they qualify for. A published author qualifies for author talks, panels,
 *     readings and lecture series regardless of subject. A track record of
 *     accepted invitations adds the formats they have actually done.
 *
 * Derived from evidence rather than typed into a field, for the same reason
 * voice is (STORY-009): a self-description cannot fail, and this score decides
 * what a human is never shown.
 */

/** Below this many words of evidence, subject matching is not trustworthy. */
export const MIN_SUBJECT_EVIDENCE = 40;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'been', 'before', 'being', 'both',
  'came', 'come', 'could', 'does', 'doing', 'done', 'down', 'each', 'even', 'ever',
  'every', 'from', 'gave', 'give', 'going', 'gone', 'have', 'having', 'here', 'into',
  'just', 'keep', 'kept', 'like', 'made', 'make', 'many', 'more', 'most', 'much',
  'must', 'never', 'next', 'once', 'only', 'onto', 'other', 'over', 'same', 'should',
  'since', 'some', 'still', 'such', 'take', 'taken', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'those', 'through',
  'time', 'under', 'until', 'upon', 'very', 'was', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'will', 'with', 'would', 'your', 'been', 'they',
]);

const tokenize = (text) =>
  (String(text).toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter(
    (word) => word.length > 3 && !STOP_WORDS.has(word),
  );

/**
 * The formats a published author qualifies for by virtue of being one.
 *
 * A deliberately small, inspectable list of the cues a listing uses to say "we
 * are looking for an author". Not a classifier: this decides what reaches a
 * human, so it has to be readable by the person reviewing the queue and it must
 * not be something the scan can argue with.
 *
 * Each entry is a phrase matched against the listing's topics and description.
 */
export const AUTHOR_FORMATS = [
  'author panel',
  'author talk',
  'author night',
  'authors discuss',
  'book festival',
  'book club',
  'reading group',
  'lecture series',
  'writers in residence',
  'residency',
  'keynote',
  'panel discussion',
  'fireside chat',
  'literary festival',
  'writing workshop',
  'guest lecture',
];

/**
 * Singular/plural and light morphological variants, so "author panels" matches
 * "author panel" without a stemmer. Kept mechanical rather than clever: a
 * surprising match here becomes a lead the author is asked to consider.
 */
function phraseVariants(phrase) {
  const variants = new Set([phrase]);
  const words = phrase.split(' ');
  const last = words[words.length - 1];
  variants.add([...words.slice(0, -1), `${last}s`].join(' '));
  if (last.endsWith('y')) {
    variants.add([...words.slice(0, -1), `${last.slice(0, -1)}ies`].join(' '));
  }
  // "authors discuss" ↔ "author discusses"
  const first = words[0];
  if (first.endsWith('s')) {
    variants.add([first.slice(0, -1), ...words.slice(1)].join(' '));
  } else {
    variants.add([`${first}s`, ...words.slice(1)].join(' '));
  }
  return [...variants];
}

/**
 * Derives the author's expertise from the evidence the system already holds.
 *
 * @param {object} input
 * @param {Array<{title: string, themes: string[], content: string}>} input.books
 *   Every book by this author, not only the one being promoted.
 * @param {Array<{content: string}>} [input.posts] The author's own prior posts.
 * @param {Array<{type: string, topics: string[]}>} [input.trackRecord]
 *   Engagements already approved and pursued — what they have actually done.
 */
export function deriveExpertise({ books = [], posts = [], trackRecord = [] }) {
  const bookText = books.map((b) => `${b.title} ${b.content}`).join('\n');
  const postText = posts.map((p) => p.content).join('\n');

  const subjectTokens = tokenize(`${bookText}\n${postText}`);
  const subjects = new Set(subjectTokens);

  // Theme labels across every book, kept whole. These are the author's declared
  // subject areas and are matched as phrases, not bags of words.
  const themes = [...new Set(books.flatMap((b) => b.themes ?? []))];

  // Formats they qualify for: author-shaped ones by standing, plus the types of
  // engagement they have actually been accepted for.
  const doneTypes = [...new Set(trackRecord.map((t) => t.type).filter(Boolean))];
  const doneTopics = [...new Set(trackRecord.flatMap((t) => t.topics ?? []))];

  return {
    isPublishedAuthor: books.length > 0,
    books: books.length,
    posts: posts.length,
    themes,
    subjects,
    subjectEvidence: subjectTokens.length,
    // Subject matching needs enough text behind it to mean anything; a book
    // with a one-line description should not be scored as broad expertise.
    enforceable: subjectTokens.length >= MIN_SUBJECT_EVIDENCE,
    formats: books.length > 0 ? AUTHOR_FORMATS : [],
    doneTypes,
    doneTopics,
  };
}

/**
 * Scores one listing against the author rather than against the book.
 *
 * @returns {{score: number, matched: string[], subjectFit: number,
 *   standingFit: number, rationale: string}}
 */
export function scoreExpertise({ listing, expertise }) {
  if (!expertise || !expertise.isPublishedAuthor) {
    return {
      score: 0,
      matched: [],
      subjectFit: 0,
      standingFit: 0,
      rationale: 'no published work to derive expertise from',
    };
  }

  const haystack = `${(listing.topics ?? []).join(' ')} ${listing.description ?? ''}`.toLowerCase();
  const listingTokens = new Set(tokenize(haystack));
  const matched = [];

  // Standing: does this listing want the kind of person this author is?
  const formatHits = expertise.formats.filter((format) =>
    phraseVariants(format).some((variant) => haystack.includes(variant)),
  );
  matched.push(...formatHits);

  // A listing seeking an author is a strong signal on its own — it is the whole
  // reason this dimension exists — but one cue is not four, so it saturates
  // rather than jumping straight to full marks.
  const standingFit = formatHits.length === 0 ? 0 : Math.min(1, 0.7 + 0.15 * (formatHits.length - 1));

  // Subject: how much of what this author actually writes about the listing
  // echoes. Measured over every book and post, not the four labels on one book.
  let subjectFit = 0;
  if (expertise.enforceable && listingTokens.size > 0) {
    const hits = [...listingTokens].filter((token) => expertise.subjects.has(token));
    subjectFit = Math.min(1, hits.length / Math.max(4, Math.min(listingTokens.size, 10)));
  }

  // Track record: they have already done this kind of engagement.
  const doneTypeHit = expertise.doneTypes.includes(listing.type);
  const doneTopicHits = expertise.doneTopics.filter((topic) =>
    haystack.includes(String(topic).toLowerCase()),
  );
  if (doneTopicHits.length > 0) matched.push(...doneTopicHits.map((t) => `done: ${t}`));
  const recordFit = Math.min(1, (doneTypeHit ? 0.5 : 0) + 0.25 * doneTopicHits.length);

  // Standing dominates deliberately. This dimension exists to catch the lead
  // that wants an author and never names a subject, and weighting subject fit
  // higher would reproduce the blind spot it was added to close.
  const score = Number(
    Math.min(1, standingFit * 0.55 + subjectFit * 0.3 + recordFit * 0.15).toFixed(3),
  );

  return {
    score,
    matched: [...new Set(matched)],
    subjectFit: Number(subjectFit.toFixed(3)),
    standingFit: Number(standingFit.toFixed(3)),
    rationale:
      `standing ${standingFit.toFixed(2)}` +
      (formatHits.length > 0 ? ` (${formatHits.join(', ')})` : ' (no author-shaped cue)') +
      ` · subject ${subjectFit.toFixed(2)} over ${expertise.books} book(s)` +
      ` · record ${recordFit.toFixed(2)}`,
  };
}
