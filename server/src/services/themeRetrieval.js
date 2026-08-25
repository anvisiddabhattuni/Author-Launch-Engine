/**
 * Retrieval over the book's own text (STORY-006 build step 2).
 *
 * The "R" in RAG. For each theme the book claims, pull the passages that
 * actually evidence it, so the drafter writes from the book rather than from
 * four one-word labels. Postgres full-text search rather than embeddings: the
 * retrieved passage decides what the drafter is told, so it has to be
 * reproducible and inspectable — and the stub provider has to keep working with
 * no network at all.
 */

/** How many passages a single theme is grounded in. */
export const PASSAGES_PER_THEME = 2;

/**
 * Retrieves the grounding for one book: its themes, what each one claims, and
 * the book's own passages that support it.
 *
 * A theme with no matching passage comes back with an empty `passages` array
 * rather than being dropped. A book that never argues one of its own themes is
 * a real finding, and hiding it would let the draft inherit the same silence.
 *
 * @returns {Promise<{bookId: number, themes: Array<{theme: string, keyMessage: string,
 *   passages: Array<{id: number, content: string, rank: number}>}>, passageCount: number}>}
 */
export async function retrieveThemeGrounding(
  { bookId, perTheme = PASSAGES_PER_THEME },
  client,
) {
  const { rows } = await client.query(
    `SELECT t.theme,
            t.key_message,
            t.position,
            p.id      AS passage_id,
            p.content AS passage,
            p.rank
       FROM book_themes t
       LEFT JOIN LATERAL (
            SELECT bp.id,
                   bp.content,
                   ts_rank(bp.tsv, plainto_tsquery('english', t.theme)) AS rank
              FROM book_passages bp
             WHERE bp.book_id = t.book_id
               AND bp.tsv @@ plainto_tsquery('english', t.theme)
             ORDER BY rank DESC, bp.ordinal
             LIMIT $2
       ) p ON TRUE
      WHERE t.book_id = $1
      ORDER BY t.position, t.theme, p.rank DESC NULLS LAST, p.id`,
    [bookId, perTheme],
  );

  const byTheme = new Map();
  for (const row of rows) {
    if (!byTheme.has(row.theme)) {
      byTheme.set(row.theme, { theme: row.theme, keyMessage: row.key_message, passages: [] });
    }
    if (row.passage_id !== null) {
      byTheme.get(row.theme).passages.push({
        id: Number(row.passage_id),
        content: row.passage,
        rank: Number(row.rank),
      });
    }
  }

  const themes = [...byTheme.values()];
  const passageCount = new Set(
    themes.flatMap((t) => t.passages.map((p) => p.id)),
  ).size;

  return { bookId, themes, passageCount };
}
