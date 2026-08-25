/**
 * Deterministic press-material provider.
 *
 * Builds a press release, an author bio and a fact sheet from the book and the
 * milestone, with no network call, so the demo and tests stay reproducible.
 * The angle changes per milestone type: a launch is news because the book is
 * new, an award is news because someone else vouched for it, and an
 * anniversary is news only if you give it a reason to be.
 *
 * STORY-006 changed where the words come from. The copy used to be assembled
 * from theme *labels* and a sentence picked at random out of the whole book;
 * it now writes from the `grounding` retrieved for each theme — what the book
 * claims, and the passages that back the claim. That is the generation half of
 * RAG, and it is why alignment is now something the drafter does rather than
 * something done to the draft afterwards.
 */

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (items, seed) => items[Math.abs(seed) % items.length];

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 200);
}

/** The grounding retrieved for this book, indexed by theme name. */
function groundingIndex(grounding) {
  return new Map((grounding?.themes ?? []).map((entry) => [entry.theme, entry]));
}

/**
 * What the book actually claims about a theme.
 *
 * The key message a human wrote if there is one; otherwise the sentence in the
 * retrieved evidence that actually mentions the theme. Taking the passage's
 * opening sentence instead would attribute the wrong claim to a theme the
 * passage only touches once — two themes retrieving the same paragraph would
 * both be given its first line, which is a confident-sounding falsehood.
 *
 * Null when nothing in the book argues the theme. The copy then says nothing
 * about it rather than inventing a claim, the same rule an unknown anniversary
 * and an unrecorded award outcome already follow.
 */
function claimFor(index, theme) {
  const entry = index.get(theme);
  if (!entry) return null;
  if (entry.keyMessage) return entry.keyMessage;

  const needle = theme.toLowerCase();
  for (const passage of entry.passages) {
    const own = passage.content
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .find((sentence) => sentence.toLowerCase().includes(needle));
    if (own) return own;
  }
  return null;
}

/**
 * The line readers return to, drawn from a retrieved passage rather than from
 * anywhere in the book. A quote that supports the themes being announced is the
 * point; a random sentence was only ever a stand-in for one.
 */
function quotableLine({ index, themes, book, seed }) {
  const retrieved = themes
    .flatMap((theme) => index.get(theme)?.passages ?? [])
    .flatMap((passage) => sentences(passage.content));
  const pool = retrieved.length > 0 ? retrieved : sentences(book.content);
  return pool.length > 0 ? pick(pool, seed) : book.title;
}

/** Claims for the themes that have one, in the book's own order. */
const claimsFor = (index, themes) =>
  [...new Set(themes)]
    .map((theme) => ({ theme, claim: claimFor(index, theme) }))
    .filter((entry) => entry.claim);

/** "a, b, c and d" — a bare comma list reads like a database dump in copy. */
const prose = (items) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const longDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
];

/** "one year" / "two years" / "14 years" — anniversaries past ten read fine as digits. */
const yearsPhrase = (years) =>
  years <= CARDINALS.length ? `${CARDINALS[years - 1]} year${years === 1 ? '' : 's'}` : `${years} years`;

const ordinalWord = (years) => {
  if (years <= ORDINALS.length) return ORDINALS[years - 1];
  const suffix = years % 10 === 1 && years % 100 !== 11 ? 'st'
    : years % 10 === 2 && years % 100 !== 12 ? 'nd'
    : years % 10 === 3 && years % 100 !== 13 ? 'rd'
    : 'th';
  return `${years}${suffix}`;
};

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Headline and opening paragraph carry the news; both turn on milestone type. */
const ANGLES = {
  launch: ({ book, author, milestone, themes }) => ({
    headline: `${author.name} publishes "${book.title}", a book on ${themes[0]} and ${themes[1]}`,
    lede:
      `${author.name} will publish "${book.title}" on ${longDate(milestone.event_date)}. ` +
      `The book argues that ${themes[0]} is a practice rather than a talent, and that ${themes[1]} ` +
      `is what remains once the initial enthusiasm for a project has worn off.`,
    quote:
      `I wanted to write the book I needed during the middle of a long project, ` +
      `when nothing was working and ${themes[2]} was the only thing left to spend.`,
  }),
  // A win and a shortlisting are different news. The prize name arrives as data
  // (`awardName`); it used to be scraped out of the milestone title with a
  // regex, which mangled the headline for any title not phrased as "shortlisted
  // for X" — a won award being exactly such a title.
  award: ({ book, author, milestone, themes, awardOutcome, awardName }) => {
    const prize = awardName ? `the ${awardName}` : 'a major nonfiction prize';

    if (awardOutcome === 'won') {
      return {
        headline: `"${book.title}" by ${author.name} wins ${prize}`,
        lede:
          `"${book.title}" by ${author.name} has won ${prize}, announced on ` +
          `${longDate(milestone.event_date)}. Judges cited the book's treatment of ${themes[0]} ` +
          `and ${themes[1]} as the reason for the award.`,
        quote:
          `Prizes go to books, but the work is done by people nobody is watching yet. ` +
          `This one is for anyone still spending ${themes[2]} on something that has not paid them back.`,
      };
    }

    return {
      headline: `"${book.title}" by ${author.name} named to the ${awardName ?? 'nonfiction prize'} shortlist`,
      lede:
        `"${book.title}" by ${author.name} has been shortlisted for ${prize}, ` +
        `announced on ${longDate(milestone.event_date)}. Judges cited the book's treatment of ${themes[0]} ` +
        `and ${themes[1]} as the reason for its inclusion.`,
      quote:
        `A shortlist is a room full of books that took ${themes[1]} seriously. ` +
        `Being in that room is the part that matters.`,
    };
  },
  // `years` is null when the publication date is unknown. Rather than assert an
  // anniversary it cannot count, the copy says "another year" — vaguer, but not
  // wrong, and wrong is what reaches a journalist.
  anniversary: ({ book, author, milestone, themes, years }) => ({
    headline: years
      ? `"${book.title}" marks ${yearsPhrase(years)} in print as its argument about ${themes[0]} finds new readers`
      : `"${book.title}" marks another year in print as its argument about ${themes[0]} finds new readers`,
    lede:
      (years
        ? `"${book.title}" by ${author.name} reaches its ${ordinalWord(years)} anniversary on ${longDate(milestone.event_date)}. ` +
          `${capitalize(yearsPhrase(years))} on, `
        : `"${book.title}" by ${author.name} marks an anniversary on ${longDate(milestone.event_date)}. ` +
          `Years on, `) +
      `the book's case for ${themes[0]} and ${themes[2]} continues to reach readers ` +
      `who found it by recommendation rather than by advertising.`,
    quote:
      `Books about ${themes[1]} are supposed to disappear quietly. ` +
      `This one kept being handed from one person to the next, which is the only distribution I ever wanted.`,
  }),
};

const kicker = (type, awardOutcome) => {
  if (type === 'launch') return 'NEW RELEASE';
  if (type === 'anniversary') return 'ANNIVERSARY';
  if (type === 'award') return awardOutcome === 'won' ? 'AWARD WINNER' : 'SHORTLIST';
  return 'BOOK NEWS';
};

function pressRelease({
  book, author, milestone, themes, claims, line, years, awardOutcome, awardName,
}) {
  const angle = (ANGLES[milestone.type] ?? ANGLES.launch)({
    book,
    author,
    milestone,
    themes,
    years,
    awardOutcome,
    awardName,
  });
  const dateline = [milestone.location, longDate(milestone.event_date)].filter(Boolean).join(', ');

  const body = [
    'FOR IMMEDIATE RELEASE',
    kicker(milestone.type, awardOutcome),
    '',
    angle.headline,
    '',
    `${dateline} — ${angle.lede}`,
    '',
    milestone.details,
    '',
    `The book takes ${prose(themes)} as its subject, and makes its case in short chapters drawn ` +
      `from ordinary working life rather than from research summaries.`,
    '',
    // The retrieved claims, stated as claims. A journalist writing from this
    // kit should be able to quote what the book argues, not only what it is
    // filed under — which is the difference STORY-006 exists to make.
    claims.length > 0 ? 'WHAT THE BOOK ARGUES' : null,
    ...claims.map(({ theme, claim }) => `${capitalize(theme)} — ${claim}`),
    claims.length > 0 ? '' : null,
    'One line readers return to:',
    '',
    `"${line}"`,
    '',
    `"${angle.quote.replace(/\.$/, '')}," said ${author.name}.`,
    '',
    `ABOUT THE BOOK — "${book.title}" is a nonfiction work on ${themes[0]} and ${themes[1]}, ` +
      `written for people who do careful work without an audience for it.`,
    '',
    `MEDIA CONTACT — ${author.name}, ${author.email}`,
    '',
    '###',
  ]
    .filter((part) => part !== null)
    .join('\n');

  return { headline: angle.headline, body, themesUsed: themes };
}

function authorBio({ book, author, themes, claims, index, line }) {
  const headline = `${author.name} — author biography`;
  // The opening line names the first two themes, so the argument paragraph
  // takes the ones it has not covered yet — between them the bio names every
  // theme the book claims. Two claims is a bio; four is a fact sheet with a
  // name on it.
  const remaining = claimsFor(index, themes.slice(2));
  const carried = (remaining.length > 0 ? remaining : claims).slice(0, 2);
  const body = [
    `${author.name} writes about ${themes[0]}, ${themes[1]} and the ordinary discipline that ` +
      `holds a long project together.`,
    '',
    // The argument used to be hardcoded here — the stub asserted what the book
    // said about themes[2] and themes[3] whatever book it was handed. It now
    // states only what retrieval found the book actually arguing.
    carried.length > 0
      ? `The book "${book.title}" makes its case theme by theme. ` +
        carried.map(({ theme, claim }) => `On ${theme}: ${claim}`).join(' ') +
        ` ${author.name} writes in short declarative sentences and concrete images, without hype.`
      : `The book "${book.title}" is a nonfiction work on ${prose(themes)}. ${author.name} writes ` +
        `in short declarative sentences and concrete images, without hype.`,
    '',
    `"${line}"`,
    '',
    `${author.name} can be reached at ${author.email}.`,
  ].join('\n');

  return { headline, body, themesUsed: themes };
}

const AWARD_STATUS_LINE = {
  won: 'Winner',
  shortlisted: 'Shortlisted',
  not_won: 'Shortlisted (did not win)',
};

function factSheet({ book, author, milestone, themes, claims, years, awardOutcome, awardName }) {
  const headline = `"${book.title}" — fact sheet`;
  const body = [
    `TITLE — ${book.title}`,
    `AUTHOR — ${author.name}`,
    `CATEGORY — Nonfiction`,
    `THEMES — ${themes.join(' · ')}`,
    book.published_on ? `PUBLISHED — ${longDate(book.published_on)}` : null,
    `MILESTONE — ${milestone.title}`,
    awardName ? `AWARD — ${awardName}` : null,
    awardOutcome ? `AWARD STATUS — ${AWARD_STATUS_LINE[awardOutcome] ?? awardOutcome}` : null,
    years ? `ANNIVERSARY — ${ordinalWord(years)}, ${yearsPhrase(years)} in print` : null,
    `DATE — ${longDate(milestone.event_date)}`,
    milestone.location ? `LOCATION — ${milestone.location}` : null,
    `DETAILS — ${milestone.details}`,
    '',
    `SUMMARY — A book about ${prose(themes)}, argued in short chapters drawn from ordinary ` +
      `working life rather than from research summaries.`,
    '',
    // A fact sheet exists to be lifted verbatim, so the key messages belong on
    // it as their own lines rather than dissolved into a summary sentence.
    claims.length > 0 ? 'KEY MESSAGES' : null,
    ...claims.map(({ theme, claim }) => `${capitalize(theme)} — ${claim}`),
    claims.length > 0 ? '' : null,
    `MEDIA CONTACT — ${author.name}, ${author.email}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { headline, body, themesUsed: themes };
}

export const prStubProvider = {
  name: 'stub',

  /**
   * @returns {Array<{type: string, headline: string, body: string, themesUsed: string[]}>}
   */
  async draftKit({
    milestone,
    book,
    author,
    anniversaryYears = null,
    awardOutcome = null,
    awardName = null,
    // What retrieval found the book arguing about each of its themes. Absent
    // only when a caller drafts without the grounding step, which the pipeline
    // never does; the copy then degrades to theme labels the way it used to.
    grounding = null,
  }) {
    const seed = hash(`${milestone.id}:${book.id}`);

    // Padded so an angle can reference themes[3] on a book with fewer themes.
    const themes = [...book.themes];
    while (themes.length < 4) themes.push(themes[themes.length - 1] ?? 'the work');

    const index = groundingIndex(grounding);
    const claims = claimsFor(index, themes);
    const line = quotableLine({ index, themes, book, seed });

    const years = anniversaryYears;

    return [
      {
        type: 'press_release',
        ...pressRelease({
          book, author, milestone, themes, claims, line, years, awardOutcome, awardName,
        }),
      },
      { type: 'author_bio', ...authorBio({ book, author, themes, claims, index, line }) },
      {
        type: 'fact_sheet',
        ...factSheet({
          book, author, milestone, themes, claims, years, awardOutcome, awardName,
        }),
      },
    ];
  },
};
