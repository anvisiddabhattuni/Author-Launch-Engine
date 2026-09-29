/**
 * Deterministic content provider.
 *
 * Produces plausible, platform-shaped copy with no network call, so tests and
 * demos are reproducible and run without an API key. Same inputs always yield
 * the same drafts.
 *
 * STORY-009 changed where the words come from. The copy used to be assembled
 * from a theme *label* and a sentence picked at random out of the whole book,
 * with the author's voice and previous posts accepted as arguments and then
 * dropped on the floor. It now writes from the `grounding` retrieved for the
 * chosen theme — what the book claims about it, and the passages that back the
 * claim — and picks a shape that matches how long the author's own sentences
 * actually run. That is the generation half of RAG, and it is why alignment and
 * voice are now things the drafter does rather than things done to the draft.
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
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220);
}

/**
 * What the book actually claims about a theme: the key message a human wrote if
 * there is one, otherwise the sentence in the retrieved evidence that mentions
 * the theme. Null when nothing in the book argues it — the copy then says
 * nothing about it rather than inventing a claim, the same rule the press
 * drafter follows for an unknown anniversary or an unrecorded award.
 */
function claimFor(entry) {
  if (!entry) return null;
  if (entry.keyMessage) return entry.keyMessage;

  const needle = entry.theme.toLowerCase();
  for (const passage of entry.passages) {
    const own = passage.content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .find((s) => s.toLowerCase().includes(needle));
    if (own) return own;
  }
  return null;
}

/**
 * A line drawn from the passages retrieved *for this theme*, rather than from
 * anywhere in the book. A quote that evidences the point being made is the
 * point; a random sentence was only ever a stand-in for one.
 */
function lineFor(entry, book, seed) {
  const retrieved = (entry?.passages ?? []).flatMap((p) => sentences(p.content));
  const pool = retrieved.length > 0 ? retrieved : sentences(book.content);
  return pool.length > 0 ? pick(pool, seed) : book.title;
}

/**
 * Templates carry the claim and the evidence as separate slots, so a post is
 * the book's argument plus the book's words for it — not a label and a quote
 * that happen to share a page.
 */
const TEMPLATES = {
  twitter: [
    (t, s) => `${t}, in one line from "${s.title}":\n\n${s.claim}\n\n#${s.tag}`,
    (t, s) => `Writing "${s.title}" taught me this about ${t}:\n\n${s.claim}`,
    (t, s) => `On ${t} — a line from the book I still stand behind:\n\n"${s.line}"\n\n#${s.tag}`,
  ],
  instagram: [
    (t, s) => `${s.claim}\n\nThat is what ${t} means in "${s.title}".\n\n${s.line}\n\n#${s.tag} #amwriting #books`,
    (t, s) => `A page from "${s.title}" on ${t}.\n\n${s.line}\n\n${s.claim}\n\nWhat would you add?\n\n#${s.tag} #bookstagram`,
  ],
  facebook: [
    (t, s) => `A few readers have asked about ${t} in "${s.title}". Here is the short version.\n\n${s.claim}\n\n${s.line}\n\nHappy to go deeper in the comments if it is useful.`,
    (t, s) => `Something I have been thinking about since finishing "${s.title}": ${t}.\n\n${s.claim}\n\n${s.line}`,
  ],
  linkedin: [
    (t, s) => `${t} came up again this week.\n\nIn "${s.title}" I put it this way:\n\n${s.claim}\n\n${s.line}\n\nCurious how others are approaching this.`,
    (t, s) => `One lesson from writing "${s.title}" that keeps applying at work: ${t}.\n\n${s.claim}`,
  ],
};

const slug = (theme) => theme.replace(/[^a-zA-Z0-9]+/g, '');

/**
 * Caption shapes, one per template layout (STORY-066).
 *
 * A meme caption is not a short text post: the image carries half the sentence,
 * so the words have to leave room for it. Each shape is written against the
 * layout's own `shape` description rather than being one caption style pasted
 * into three different pictures.
 *
 * All three are built from the theme's *claim* — the key message a human wrote,
 * or a sentence from a retrieved passage — for the same reason text posts have
 * been since STORY-009: a caption assembled from a theme label is name-checking
 * the book, not making its argument.
 */
/**
 * How each named caption slot gets filled (STORY-067).
 *
 * STORY-066 had one hardcoded caption function per layout, which meant adding a
 * template meant editing this file. Slots are named and carry their own role,
 * so a new template composed of slots this map already knows needs no code at
 * all — and one introducing a new slot name degrades to the book's claim rather
 * than rendering empty.
 */
const SLOT_FILLERS = {
  // The expectation the meme is about to overturn.
  setup: ({ theme }) => `What everyone thinks ${theme} is`,
  first: ({ theme }) => `What everyone thinks ${theme} is`,
  left: ({ theme }) => `${theme}, as advertised`,
  label: ({ theme }) => theme,
  second: () => 'What it actually takes',
  // The book's own argument.
  turn: ({ claim }) => claim,
  third: ({ claim }) => claim,
  right: ({ claim }) => claim,
  body: ({ claim }) => claim,
  statement: ({ claim }) => claim,
  quote: ({ claim }) => claim,
  note: ({ claim }) => claim,
  attribution: ({ title }) => `— ${title}`,
};

/** Fills every slot a template declares, in the template's own order. */
function fillSlots(template, context) {
  const captions = {};
  for (const slot of template.captionSlots) {
    const filler = SLOT_FILLERS[slot.name] ?? SLOT_FILLERS.statement;
    const text = filler(context);
    // Respect the slot's own limit rather than overflowing the artwork it was
    // drawn to sit inside.
    captions[slot.name] =
      slot.maxChars && text.length > slot.maxChars
        ? `${text.slice(0, Math.max(0, slot.maxChars - 1)).trimEnd()}…`
        : text;
  }
  return captions;
}

export const stubProvider = {
  name: 'stub',

  /**
   * @param {object} input
   * @param {object} [input.grounding] Retrieved themes and passages (STORY-009).
   * @param {object} [input.voice] Traits derived from the author's own posts.
   * @returns {Array<{platform: string, content: string, themesUsed: string[]}>}
   */
  async generateCandidates({
    book,
    grounding = null,
    voice = null,
    platforms,
    count,
    weekOf,
    memeCount = 0,
    revision = null,
    bookModel = null,
    visualFirstPlatforms = [],
    // Templates already chosen from the library by the agent, one per meme
    // (STORY-067). The provider does not pick: selection is a decision with a
    // reason and the reason gets written to the audit log, which is the
    // agent's job rather than the content generator's.
    memeTemplates = [],
  }) {
    // Prefer the grounded themes: they are the ones with evidence behind them.
    // `books.themes` remains the fallback for a book with no theme index.
    const grounded = grounding?.themes ?? [];
    let themes = grounded.length > 0
      ? grounded.map((t) => t.theme)
      : (book.themes.length > 0 ? book.themes : ['the book']);
    const index = new Map(grounded.map((t) => [t.theme, t]));
    // A revision (STORY-047) keeps the theme the reviewer saw and, where the
    // book offers another, writes from a passage they did not. This provider
    // cannot read the note; these two rules are what it can do honestly.
    const seen = new Set((revision?.avoidPassages ?? []).map(Number));
    if (revision?.themes?.length) {
      const kept = revision.themes.filter((t) => themes.includes(t));
      if (kept.length) themes = kept;
    }
    // Reviewers' preferences (STORY-048): a theme they like comes up more, one
    // they keep turning down less — tilted, never silenced (weights 0.5–1.5).
    const themeWeight = new Map((bookModel?.preferences?.themes ?? []).map((t) => [t.theme, t.weight]));
    if (themeWeight.size && !revision?.themes?.length) {
      themes = themes.flatMap((t) => Array(Math.max(1, Math.round((themeWeight.get(t) ?? 1) * 2))).fill(t));
    }
    const fresh = (entry) => {
      if (!entry || seen.size === 0) return entry;
      const unseen = entry.passages.filter((p) => !seen.has(Number(p.id)));
      return unseen.length ? { ...entry, passages: unseen } : entry;
    };

    const candidates = [];

    for (let i = 0; i < count; i += 1) {
      const platform = platforms[i % platforms.length];
      // A revision (STORY-047) is seeded apart from the draft it replaces, so it
      // is a different draft rather than the same one again. The offline
      // provider cannot read the reviewer's note; the Anthropic one can.
      const seed = hash(`${book.id}:${weekOf}:${platform}:${i}${revision ? `:rev${revision.of}` : ''}`);
      const theme = pick(themes, seed);
      const entry = fresh(index.get(theme) ?? null);

      const claim = claimFor(entry);
      const line = lineFor(entry, book, seed >>> 3);

      // A theme with no evidence behind it gets the quote alone. Nothing is
      // asserted on the book's behalf that the book does not say.
      const templates = TEMPLATES[platform] ?? TEMPLATES.facebook;
      const usable = claim ? templates : templates.filter((_, idx) => idx === templates.length - 1);
      const render = pick(usable.length > 0 ? usable : templates, seed >>> 7);

      candidates.push({
        format: 'text',
        platform,
        content: render(theme, {
          title: book.title,
          claim: claim ?? line,
          line,
          tag: slug(theme),
        }),
        themesUsed: [theme],
        // Recorded so the trace can say which passages this post was written
        // from, not only which it turned out to echo.
        groundedIn: (entry?.passages ?? []).map((p) => p.id),
      });
    }

    // Memes (STORY-066). Produced from the same grounding as the text posts —
    // the image is a second way to carry the book's argument, not a second
    // source of it — and routed to the platforms the database marks visual-first.
    for (let i = 0; i < memeCount; i += 1) {
      const platform =
        visualFirstPlatforms.length > 0
          ? visualFirstPlatforms[i % visualFirstPlatforms.length]
          : platforms[i % platforms.length];
      const seed = hash(`meme:${book.id}:${weekOf}:${platform}:${i}`);
      const theme = pick(themes, seed);
      const entry = index.get(theme) ?? null;

      const claim = claimFor(entry);
      const line = lineFor(entry, book, seed >>> 3);

      // No licensed template, no meme. The library refuses at selection and
      // logs why; there is nothing sensible to draft from here.
      const template = memeTemplates[i];
      if (!template) break;

      const captions = fillSlots(template, {
        theme,
        claim: claim ?? line,
        title: book.title,
      });
      // What the picture says, in the template's own slot order.
      const panels = template.captionSlots.map((slot) => captions[slot.name]).filter(Boolean);

      candidates.push({
        format: 'meme',
        platform,
        content: `On ${theme}, and what it actually costs.`,
        themesUsed: [theme],
        groundedIn: (entry?.passages ?? []).map((p) => p.id),
        template,
        captions,
        panels,
        // Alt text is written here, at generation, because the drafter is the
        // only thing that knows what the image was built to show — and what it
        // shows is the panels, not the caption sitting beside it.
        altText: `${template.name}: ${panels.join(' — ')}`,
      });
    }

    return candidates;
  },
};
