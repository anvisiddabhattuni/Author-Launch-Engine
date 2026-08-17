/**
 * Deterministic press-material provider.
 *
 * Builds a press release, an author bio and a fact sheet from the book and the
 * milestone, with no network call, so the demo and tests stay reproducible.
 * The angle changes per milestone type: a launch is news because the book is
 * new, an award is news because someone else vouched for it, and an
 * anniversary is news only if you give it a reason to be.
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
  award: ({ book, author, milestone, themes }) => ({
    headline: `"${book.title}" by ${author.name} named to the ${milestone.title.replace(/^.*shortlisted for (the )?/i, '')} shortlist`,
    lede:
      `"${book.title}" by ${author.name} has been shortlisted for a major nonfiction prize, ` +
      `announced on ${longDate(milestone.event_date)}. Judges cited the book's treatment of ${themes[0]} ` +
      `and ${themes[1]} as the reason for its inclusion.`,
    quote:
      `A shortlist is a room full of books that took ${themes[1]} seriously. ` +
      `Being in that room is the part that matters.`,
  }),
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

const KICKER = {
  launch: 'NEW RELEASE',
  award: 'AWARD NEWS',
  anniversary: 'ANNIVERSARY',
};

function pressRelease({ book, author, milestone, themes, line, years }) {
  const angle = (ANGLES[milestone.type] ?? ANGLES.launch)({ book, author, milestone, themes, years });
  const dateline = [milestone.location, longDate(milestone.event_date)].filter(Boolean).join(', ');

  const body = [
    'FOR IMMEDIATE RELEASE',
    KICKER[milestone.type] ?? 'BOOK NEWS',
    '',
    angle.headline,
    '',
    `${dateline} — ${angle.lede}`,
    '',
    milestone.details,
    '',
    `The book takes ${prose(themes)} as its subject, and makes its case in short chapters drawn ` +
      `from ordinary working life rather than from research summaries. One line readers return to:`,
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
  ].join('\n');

  return { headline: angle.headline, body, themesUsed: themes };
}

function authorBio({ book, author, themes, line }) {
  const headline = `${author.name} — author biography`;
  const body = [
    `${author.name} writes about ${themes[0]}, ${themes[1]} and the ordinary discipline that ` +
      `holds a long project together.`,
    '',
    `Her book "${book.title}" argues that ${themes[2]} is the only real currency any of us spend, ` +
      `and that ${themes[3]} is what remains after motivation has gone home for the evening. ` +
      `She writes in short declarative sentences and concrete images, without hype.`,
    '',
    `"${line}"`,
    '',
    `${author.name} can be reached at ${author.email}.`,
  ].join('\n');

  return { headline, body, themesUsed: themes };
}

function factSheet({ book, author, milestone, themes, years }) {
  const headline = `"${book.title}" — fact sheet`;
  const body = [
    `TITLE — ${book.title}`,
    `AUTHOR — ${author.name}`,
    `CATEGORY — Nonfiction`,
    `THEMES — ${themes.join(' · ')}`,
    book.published_on ? `PUBLISHED — ${longDate(book.published_on)}` : null,
    `MILESTONE — ${milestone.title}`,
    years ? `ANNIVERSARY — ${ordinalWord(years)}, ${yearsPhrase(years)} in print` : null,
    `DATE — ${longDate(milestone.event_date)}`,
    milestone.location ? `LOCATION — ${milestone.location}` : null,
    `DETAILS — ${milestone.details}`,
    '',
    `SUMMARY — A book about ${prose([themes[0], themes[1]])}: why ${themes[2]} is the scarce ` +
      `resource in creative work, and how ${themes[3]} carries a project through its middle.`,
    '',
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
  async draftKit({ milestone, book, author, anniversaryYears = null }) {
    const seed = hash(`${milestone.id}:${book.id}`);
    const lines = sentences(book.content);
    const line = lines.length > 0 ? pick(lines, seed) : book.title;

    // Padded so an angle can reference themes[3] on a book with fewer themes.
    const themes = [...book.themes];
    while (themes.length < 4) themes.push(themes[themes.length - 1] ?? 'the work');

    const years = anniversaryYears;

    return [
      { type: 'press_release', ...pressRelease({ book, author, milestone, themes, line, years }) },
      { type: 'author_bio', ...authorBio({ book, author, themes, line }) },
      { type: 'fact_sheet', ...factSheet({ book, author, milestone, themes, years }) },
    ];
  },
};
