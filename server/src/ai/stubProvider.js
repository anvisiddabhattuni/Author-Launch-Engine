/**
 * Deterministic content provider.
 *
 * Produces plausible, platform-shaped copy from the book's own themes and
 * sentences with no network call, so tests and demos are reproducible and run
 * without an API key. Same inputs always yield the same drafts.
 */

/** FNV-1a: small, stable string hash used to seed per-draft variation. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Math.abs guards against a caller passing a signed-shifted seed.
const pick = (items, seed) => items[Math.abs(seed) % items.length];

/** Splits prose into usable sentences, longest-first so we quote substance. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 220);
}

const TEMPLATES = {
  twitter: [
    (t, s) => `${t} is the thread I keep pulling in "${s.title}".\n\n${s.line}\n\n#${s.tag}`,
    (t, s) => `Writing "${s.title}" taught me this about ${t}:\n\n${s.line}`,
    (t, s) => `On ${t} — a line from the book I still stand behind:\n\n"${s.line}"\n\n#${s.tag}`,
  ],
  instagram: [
    (t, s) => `${s.line}\n\nThat idea sits at the heart of ${t} in "${s.title}".\n\n#${s.tag} #amwriting #books`,
    (t, s) => `A page from "${s.title}" on ${t}.\n\n${s.line}\n\nWhat would you add?\n\n#${s.tag} #bookstagram`,
  ],
  facebook: [
    (t, s) => `A few readers have asked about ${t} in "${s.title}". Here is the short version.\n\n${s.line}\n\nHappy to go deeper in the comments if it is useful.`,
    (t, s) => `Something I have been thinking about since finishing "${s.title}": ${t}.\n\n${s.line}`,
  ],
  linkedin: [
    (t, s) => `${t} came up again this week.\n\nIn "${s.title}" I put it this way:\n\n${s.line}\n\nCurious how others are approaching this.`,
    (t, s) => `One lesson from writing "${s.title}" that keeps applying at work: ${t}.\n\n${s.line}`,
  ],
};

const slug = (theme) => theme.replace(/[^a-zA-Z0-9]+/g, '');

export const stubProvider = {
  name: 'stub',

  /**
   * @returns {Array<{platform: string, content: string, themesUsed: string[]}>}
   */
  async generateCandidates({ book, platforms, count, weekOf }) {
    const lines = sentences(book.content);
    const themes = book.themes.length > 0 ? book.themes : ['the book'];
    const candidates = [];

    for (let i = 0; i < count; i += 1) {
      const platform = platforms[i % platforms.length];
      const seed = hash(`${book.id}:${weekOf}:${platform}:${i}`);
      const theme = pick(themes, seed);
      const line = lines.length > 0 ? pick(lines, seed >>> 3) : book.title;
      const templates = TEMPLATES[platform] ?? TEMPLATES.facebook;
      const render = pick(templates, seed >>> 7);

      candidates.push({
        platform,
        content: render(theme, { title: book.title, line, tag: slug(theme) }),
        themesUsed: [theme],
      });
    }

    return candidates;
  },
};
