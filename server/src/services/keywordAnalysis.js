/**
 * Keyword analysis for opportunity relevance (STORY-002 build step 2).
 *
 * Deliberately not a model call: relevance decides what reaches a human, so it
 * has to be reproducible and explainable rather than a number we cannot
 * defend. Scores combine direct theme matching with looser token overlap
 * against the listing's topics and description.
 */

const STOP_WORDS = new Set([
  'a', 'about', 'and', 'are', 'the', 'with', 'for', 'from', 'that', 'this', 'they', 'them',
  'what', 'when', 'where', 'who', 'why', 'how', 'into', 'over', 'than', 'then', 'their',
  'there', 'have', 'has', 'had', 'been', 'being', 'does', 'did', 'doing', 'its', 'it',
  'on', 'in', 'of', 'to', 'is', 'as', 'at', 'by', 'an', 'or', 'be', 'do',
]);

const tokenize = (text) =>
  (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter(
    (word) => word.length > 2 && !STOP_WORDS.has(word),
  );

/**
 * Scores one listing against the book's themes.
 *
 * @returns {{relevance: number, matchedThemes: string[], rationale: string}}
 */
export function scoreOpportunity({ listing, bookThemes }) {
  if (bookThemes.length === 0) {
    return { relevance: 0, matchedThemes: [], rationale: 'no book themes to match against' };
  }

  const topicText = listing.topics.join(' ');
  const listingTokens = new Set([...tokenize(topicText), ...tokenize(listing.description)]);

  // A theme counts as matched when every one of its own tokens appears in the
  // listing, so "deep work" needs both words rather than just "work".
  const matchedThemes = bookThemes.filter((theme) => {
    const themeTokens = tokenize(theme);
    return themeTokens.length > 0 && themeTokens.every((token) => listingTokens.has(token));
  });

  // Strength before breadth: a podcast squarely about one of the book's themes
  // is a strong lead even though it ignores the other three. Scoring breadth
  // first would reject exactly the best-targeted opportunities.
  const hasMatch = matchedThemes.length > 0 ? 1 : 0;
  const breadth = matchedThemes.length / bookThemes.length;

  // Looser signal: how much of the book's whole vocabulary the listing echoes.
  const allThemeTokens = new Set(bookThemes.flatMap(tokenize));
  const tokenHits = [...allThemeTokens].filter((token) => listingTokens.has(token)).length;
  const tokenOverlap = allThemeTokens.size === 0 ? 0 : tokenHits / allThemeTokens.size;

  const relevance = Number(
    Math.min(1, hasMatch * 0.55 + breadth * 0.3 + tokenOverlap * 0.15).toFixed(3),
  );

  return {
    relevance,
    matchedThemes,
    rationale:
      `themes matched ${matchedThemes.length}/${bookThemes.length}` +
      (matchedThemes.length > 0 ? ` (${matchedThemes.join(', ')})` : '') +
      ` · vocabulary overlap ${(tokenOverlap * 100).toFixed(0)}%`,
  };
}
