import { config } from '../config.js';
import { recordAction } from '../services/auditLog.js';
import { retrieveThemeGrounding } from '../services/themeRetrieval.js';

/**
 * AI Content Generation Agent (STORY-006).
 *
 * The agent Basecamp names as the owner of theme alignment. It exists as its
 * own module because STORY-006 asks for something STORY-003 did not do: not
 * *scoring* a finished draft against the book's themes, but *aligning* the
 * draft with them — retrieving what the book actually argues before a word is
 * written, and then checking the finished copy against that same evidence.
 *
 * It owns two steps on either side of generation and nothing else. Approval,
 * distribution and the audit log stay where they are; forking a second copy of
 * the trust spine to give this agent a home would be the wrong trade.
 */
export const ACTOR = 'AIContentGenerationAgent';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'along', 'also', 'always', 'among', 'another',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'came', 'come',
  'could', 'does', 'doing', 'done', 'down', 'each', 'even', 'ever', 'every', 'from',
  'gave', 'give', 'going', 'gone', 'have', 'having', 'here', 'into', 'itself', 'just',
  'keep', 'kept', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must',
  'never', 'next', 'once', 'only', 'onto', 'other', 'over', 'own', 'same', 'she',
  'should', 'since', 'some', 'still', 'such', 'take', 'taken', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'those',
  'through', 'time', 'under', 'until', 'upon', 'very', 'was', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'will', 'with', 'would', 'your',
]);

/** Content words only. Short words and connectives carry no evidence of a claim. */
const tokenize = (text) =>
  (String(text).toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter(
    (word) => word.length > 3 && !STOP_WORDS.has(word),
  );

/**
 * The vocabulary that counts as *arguing* a theme: the words of its key message
 * and of the passages retrieved for it, minus the theme's own tokens.
 *
 * Removing the theme's own words is the whole point. Naming "craft" must not
 * also earn credit for arguing craft — a draft that repeats the label four
 * times is exactly the failure STORY-003's verbatim check could not see.
 *
 * `excluded` removes the *other* themes' labels too (STORY-009). A book's
 * passages discuss its themes together, so "craft" is a distinctive term of
 * attention's evidence and vice versa — which let copy that name-checked four
 * themes earn argument credit on each one for naming the other three. Naming a
 * theme is not arguing it, and that has to hold sideways as well as directly.
 */
export function distinctiveTerms({ theme, keyMessage = '', passages = [] }, excluded = null) {
  const own = new Set(tokenize(theme));
  const source = [keyMessage, ...passages.map((p) => p.content)].join(' ');
  return new Set(
    tokenize(source).filter((word) => !own.has(word) && !excluded?.has(word)),
  );
}

/**
 * Full marks is not "quote the passage back". A press release that carries this
 * many of the book's own words about a theme is making the book's argument
 * rather than name-checking it; a fact sheet that carries none is name-checking.
 *
 * `target` is overridable because the bar cannot be the same for every form.
 * A tweet has 280 characters and physically cannot carry eight of the book's
 * words about a theme; holding it to a press release's target would escalate
 * every well-written short post and teach a reviewer to ignore the queue
 * (STORY-009). What counts as arguing a theme depends on how much room the
 * format gives you to argue it.
 */
const messageTarget = (available, target = config.themeMessageTermTarget) =>
  Math.min(target, available);

/**
 * Naming the theme is worth this much; arguing it is worth the rest.
 *
 * Deliberately below MIN_THEME_ALIGNMENT (0.5). A draft that name-checks every
 * theme in the book and argues none of them scores 0.40 and escalates — under
 * STORY-003's verbatim check the same copy scored 1.00 and went to a reviewer
 * looking approved. Naming your themes is no longer enough to clear the floor,
 * which is the whole of what this story changes.
 */
const NAMED_WEIGHT = 0.4;

/** A named theme counts as argued once it carries half its evidence weight. */
const ARGUED_AT = 0.5;

/**
 * Checks one finished material against the grounding it was written from.
 *
 * Our code scores; the model does not grade itself. The provider is *given* the
 * retrieved evidence, and then measured against that same evidence — asking it
 * to report its own alignment would make the acceptance criterion unverifiable.
 *
 * @returns {{score: number, matched: string[], argued: string[],
 *   perTheme: Array<object>, summary: string}}
 */
export function alignToThemes({
  text,
  grounding,
  termTarget = config.themeMessageTermTarget,
  // Every label that must not count as an argument. Defaults to the themes
  // being scored, which is all of them for a press kit. A social post is
  // scored on the one or two themes it raises, so its caller passes the book's
  // whole list — otherwise naming an unscored theme would still earn credit.
  themeVocabulary = null,
}) {
  const themes = grounding?.themes ?? [];
  if (themes.length === 0) {
    return { score: 0, matched: [], argued: [], perTheme: [], summary: 'no themes to align to' };
  }

  const haystack = String(text).toLowerCase();
  const draftTokens = new Set(tokenize(text));
  const labels = themeVocabulary ?? themes.map((t) => t.theme);
  const labelTokens = new Set(labels.flatMap((label) => tokenize(label)));

  const perTheme = themes.map((entry) => {
    const named = haystack.includes(entry.theme.toLowerCase());
    const terms = distinctiveTerms(entry, labelTokens);
    const carried = [...terms].filter((term) => draftTokens.has(term));
    const target = messageTarget(terms.size, termTarget);
    const messageScore = target === 0 ? 0 : Math.min(1, carried.length / target);

    // Message credit requires the name. A draft that never mentions the theme
    // cannot be reflecting its key message, and allowing it to score would let
    // generic book vocabulary earn alignment for copy about another book —
    // which is precisely what keeps off-message material at exactly zero.
    const score = named ? NAMED_WEIGHT + (1 - NAMED_WEIGHT) * messageScore : 0;

    return {
      theme: entry.theme,
      keyMessage: entry.keyMessage ?? '',
      named,
      argued: named && messageScore >= ARGUED_AT,
      messageScore: Number(messageScore.toFixed(3)),
      score: Number(score.toFixed(3)),
      passageIds: entry.passages.map((p) => p.id),
      // Capped for readability: the rationale is meant to be read by a
      // reviewer, not to reproduce the passage.
      carriedTerms: carried.slice(0, 8),
    };
  });

  const score = perTheme.reduce((total, t) => total + t.score, 0) / perTheme.length;
  const matched = perTheme.filter((t) => t.named).map((t) => t.theme);
  const argued = perTheme.filter((t) => t.argued).map((t) => t.theme);

  return {
    score: Number(score.toFixed(3)),
    matched,
    argued,
    perTheme,
    summary:
      `named ${matched.length}/${perTheme.length}` +
      ` (${matched.join(', ') || 'none'}) · ` +
      `argued ${argued.length}/${perTheme.length}` +
      ` (${argued.join(', ') || 'none'})`,
  };
}

/**
 * The retrieval half of the pipeline: pull what the book argues, and record
 * having done so.
 *
 * The audit row is not decoration — STORY-006's trust clause asks for theme
 * alignment *actions* on the log, and grounding a draft in retrieved passages
 * is an action taken before anyone reviews anything. A kit whose copy looks
 * fine but was grounded in zero passages is a kit to be suspicious of.
 */
export async function groundInBookThemes(
  {
    bookId,
    authorId,
    kitId = null,
    // STORY-009 brings social drafting through this same step, and a week of
    // posts has no row of its own to hang the retrieval on — the retrieval is
    // about the book. Defaulting to the kit keeps every STORY-006 caller as it
    // was rather than making the agent's own history harder to read.
    entityType = 'pr_kit',
    entityId = kitId,
    action = 'pr_kit.themes_retrieved',
  },
  client,
) {
  const grounding = await retrieveThemeGrounding({ bookId }, client);

  const ungrounded = grounding.themes
    .filter((t) => t.passages.length === 0)
    .map((t) => t.theme);

  await recordAction(
    {
      actor: ACTOR,
      action,
      entityType,
      entityId,
      authorId,
      metadata: {
        bookId,
        themes: grounding.themes.map((t) => t.theme),
        passageCount: grounding.passageCount,
        passagesPerTheme: Object.fromEntries(
          grounding.themes.map((t) => [t.theme, t.passages.length]),
        ),
        // A theme the book never argues in its own text. The draft is about to
        // be written without evidence for it, and that is worth saying out loud.
        ungroundedThemes: ungrounded,
        withKeyMessage: grounding.themes.filter((t) => t.keyMessage).length,
      },
    },
    client,
  );

  return grounding;
}
