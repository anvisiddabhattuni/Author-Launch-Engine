/**
 * Meme formats, drawn in-house.
 *
 * The first template library (STORY-067) was coloured cards with room for a
 * sentence — quote cards, not memes. These are the formats people recognise
 * as memes: expectation versus reality, "nobody: / me:", the two-button
 * dilemma, nah/yeah, the starter pack, the expanding brain, how it started.
 * Each is our own drawing of the *format*, not a copy of anyone's picture, so
 * it carries the house licence like the rest of the library.
 *
 * The artwork is drawn in four placeholder colours, swapped for the book's own
 * palette when a meme is made (`themedArtwork` in memeLibrary.js). A format
 * therefore never fails the visual identity check for a colour it was drawn in
 * — it is always in the book's colours.
 *
 * `joke` is how the format works, in a sentence. It goes to the writer (Claude)
 * so a caption is written for the format rather than pasted into it.
 */

/** The placeholder colours. Distinctive values, so a swap never hits a real one. */
export const SWATCH = {
  ground: '#161513',
  panel: '#201e1b',
  ink: '#f3f1ec',
  accent: '#d9963f',
};

const svg = (w, h, body) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`,
    'utf8',
  ).toString('base64')}`;

const SANS = 'Helvetica,Arial,sans-serif';
const label = (x, y, text, { size = 26, fill = SWATCH.accent, anchor = 'start', opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${SANS}" font-weight="700" font-size="${size}" letter-spacing="3" ` +
  `text-anchor="${anchor}" fill="${fill}" opacity="${opacity}">${text}</text>`;

const HOUSE = { holder: 'Author Launch Engine', terms: 'cc0', commercial: true, attribution: null };
const SOURCE = 'Drawn in-house: our own drawing of a common meme format';

/** Caption text: bold sans, like a meme, unless a slot says otherwise. */
const slot = (name, role, maxChars, x, y, extra = {}) => ({
  name, role, maxChars, x, y, size: 36, anchor: 'start', wrap: 30, family: SANS, weight: 700, fill: SWATCH.ink, ...extra,
});

const twoPanel = (top, bottom) =>
  svg(
    800,
    800,
    `<rect width="800" height="800" fill="${SWATCH.ground}"/>` +
      `<rect x="20" y="20" width="760" height="370" rx="14" fill="${SWATCH.panel}"/>` +
      `<rect x="20" y="410" width="760" height="370" rx="14" fill="${SWATCH.panel}"/>` +
      label(48, 72, top) +
      label(48, 462, bottom) +
      `<rect x="48" y="86" width="64" height="4" fill="${SWATCH.accent}"/>` +
      `<rect x="48" y="476" width="64" height="4" fill="${SWATCH.accent}"/>`,
  );

export const MEME_FORMATS = [
  {
    key: 'meme-expectation-reality',
    name: 'Expectation vs reality',
    layout: 'two-panel',
    joke: 'Top: the rosy version people imagine. Bottom: what actually happens, as the book describes it. The laugh is the gap.',
    image_ref: twoPanel('EXPECTATION', 'REALITY'),
    caption_slots: [
      slot('expectation', 'the rosy version people imagine', 90, 48, 230, { size: 40 }),
      slot('reality', 'what really happens, as the book shows it', 110, 48, 620, { size: 40 }),
    ],
  },
  {
    key: 'meme-how-it-started',
    name: 'How it started / how it’s going',
    layout: 'two-panel',
    joke: 'Top: an innocent beginning. Bottom: where it ended up. Funny when the ending is bigger, stranger or more honest than the start.',
    image_ref: twoPanel('HOW IT STARTED', 'HOW IT’S GOING'),
    caption_slots: [
      slot('started', 'the innocent beginning', 90, 48, 230, { size: 40 }),
      slot('going', 'where it ended up', 110, 48, 620, { size: 40 }),
    ],
  },
  {
    key: 'meme-nobody-me',
    name: 'Nobody: / Me:',
    layout: 'single',
    joke: 'Nobody asked, and yet "me" does something oddly specific and relatable. The caption is that unprompted, specific thing.',
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="${SWATCH.ground}"/>` +
        `<rect x="20" y="20" width="760" height="560" rx="14" fill="${SWATCH.panel}"/>` +
        label(56, 110, 'Nobody:', { size: 38, fill: SWATCH.ink }) +
        label(56, 180, 'Absolutely no one:', { size: 38, fill: SWATCH.ink, opacity: 0.6 }) +
        label(56, 272, 'Me:', { size: 38 }),
    ),
    caption_slots: [slot('me', 'the oddly specific thing I do anyway', 120, 56, 390, { size: 38, wrap: 32 })],
  },
  {
    key: 'meme-two-buttons',
    name: 'Two buttons',
    layout: 'choice',
    joke: 'Two buttons, both tempting, and someone sweating over which to press. The two options are a real dilemma the book is about.',
    image_ref: svg(
      800,
      800,
      `<rect width="800" height="800" fill="${SWATCH.ground}"/>` +
        `<rect x="20" y="20" width="760" height="760" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="60" y="90" width="320" height="200" rx="28" fill="${SWATCH.accent}"/>` +
        `<rect x="420" y="90" width="320" height="200" rx="28" fill="${SWATCH.accent}"/>` +
        `<rect x="60" y="282" width="320" height="16" rx="8" fill="${SWATCH.ground}" opacity="0.5"/>` +
        `<rect x="420" y="282" width="320" height="16" rx="8" fill="${SWATCH.ground}" opacity="0.5"/>` +
        // The person deciding: a face, worried, sweating.
        `<circle cx="400" cy="480" r="92" fill="none" stroke="${SWATCH.ink}" stroke-width="6"/>` +
        `<circle cx="368" cy="462" r="9" fill="${SWATCH.ink}"/><circle cx="432" cy="462" r="9" fill="${SWATCH.ink}"/>` +
        `<path d="M360 520 q20 -16 40 0 q20 16 40 0" fill="none" stroke="${SWATCH.ink}" stroke-width="6" stroke-linecap="round"/>` +
        `<path d="M492 430 q12 22 0 34 q-12 -12 0 -34z" fill="${SWATCH.accent}"/>` +
        `<path d="M300 410 q10 18 0 28 q-10 -10 0 -28z" fill="${SWATCH.accent}"/>`,
    ),
    caption_slots: [
      slot('option_a', 'the first tempting choice', 50, 220, 190, { anchor: 'middle', size: 30, wrap: 16, fill: SWATCH.ground }),
      slot('option_b', 'the second tempting choice', 50, 580, 190, { anchor: 'middle', size: 30, wrap: 16, fill: SWATCH.ground }),
      slot('who', 'who is sweating over it', 70, 400, 680, { anchor: 'middle', size: 34, wrap: 34 }),
    ],
  },
  {
    key: 'meme-nah-yeah',
    name: 'Nah / yeah',
    layout: 'comparison',
    joke: 'Top: the thing waved away (nah). Bottom: the thing preferred (yeah). The preferred one is the book’s position, the rejected one the common habit.',
    image_ref: svg(
      800,
      800,
      `<rect width="800" height="800" fill="${SWATCH.ground}"/>` +
        `<rect x="20" y="20" width="250" height="370" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="20" y="410" width="250" height="370" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="290" y="20" width="490" height="370" rx="14" fill="${SWATCH.panel}" opacity="0.55"/>` +
        `<rect x="290" y="410" width="490" height="370" rx="14" fill="${SWATCH.panel}"/>` +
        // Nah: a cross, greyed. Yeah: a tick, in the accent.
        `<path d="M95 150 L195 250 M195 150 L95 250" stroke="${SWATCH.ink}" stroke-width="18" stroke-linecap="round" opacity="0.45"/>` +
        `<path d="M85 600 L130 650 L205 545" fill="none" stroke="${SWATCH.accent}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
    caption_slots: [
      slot('nah', 'the common habit, waved away', 80, 320, 205, { size: 36, wrap: 22, fill: SWATCH.ink }),
      slot('yeah', 'what the book says to do instead', 80, 320, 595, { size: 36, wrap: 22 }),
    ],
  },
  {
    key: 'meme-starter-pack',
    name: 'Starter pack',
    layout: 'grid',
    joke: 'A title naming a type of person, then four small, instantly recognisable things that person has. Specific beats general.',
    image_ref: svg(
      800,
      800,
      `<rect width="800" height="800" fill="${SWATCH.ground}"/>` +
        `<rect x="20" y="20" width="760" height="130" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="20" y="170" width="370" height="295" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="410" y="170" width="370" height="295" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="20" y="485" width="370" height="295" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="410" y="485" width="370" height="295" rx="14" fill="${SWATCH.panel}"/>` +
        `<rect x="370" y="128" width="60" height="4" fill="${SWATCH.accent}"/>`,
    ),
    caption_slots: [
      slot('title', 'the “… starter pack” title', 50, 400, 92, { anchor: 'middle', size: 38, wrap: 34 }),
      slot('item1', 'a telling thing they have', 60, 205, 318, { anchor: 'middle', size: 28, wrap: 18 }),
      slot('item2', 'a telling thing they have', 60, 595, 318, { anchor: 'middle', size: 28, wrap: 18 }),
      slot('item3', 'a telling thing they have', 60, 205, 633, { anchor: 'middle', size: 28, wrap: 18 }),
      slot('item4', 'a telling thing they have', 60, 595, 633, { anchor: 'middle', size: 28, wrap: 18 }),
    ],
  },
  {
    key: 'meme-galaxy-brain',
    name: 'Expanding brain',
    layout: 'levels',
    joke: 'Four ideas, each "smarter" than the last, the glow growing. The last is the book’s insight; the joke is how the levels escalate.',
    image_ref: svg(
      800,
      880,
      `<rect width="800" height="880" fill="${SWATCH.ground}"/>` +
        [0, 1, 2, 3]
          .map(
            (i) =>
              `<rect x="20" y="${20 + i * 215}" width="500" height="200" rx="14" fill="${SWATCH.panel}"/>` +
              `<rect x="535" y="${20 + i * 215}" width="245" height="200" rx="14" fill="${SWATCH.panel}"/>` +
              `<circle cx="657" cy="${120 + i * 215}" r="${26 + i * 18}" fill="${SWATCH.accent}" opacity="${0.2 + i * 0.26}"/>` +
              `<circle cx="657" cy="${120 + i * 215}" r="${14 + i * 4}" fill="${SWATCH.ink}" opacity="${0.25 + i * 0.25}"/>`,
          )
          .join(''),
    ),
    caption_slots: [0, 1, 2, 3].map((i) =>
      slot(`level${i + 1}`, ['the obvious idea', 'a slightly better one', 'a clever one', 'the book’s insight'][i], 70, 44, 120 + i * 215, { size: 30, wrap: 26 })),
  },
].map((f) => ({ ...f, source: SOURCE, licence: HOUSE }));

export const MEME_FORMAT_KEYS = new Set(MEME_FORMATS.map((f) => f.key));
export const isMemeFormat = (template) => MEME_FORMAT_KEYS.has(template?.key);
