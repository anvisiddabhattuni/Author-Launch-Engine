/**
 * The starting meme template library (STORY-067).
 *
 * STORY-066 built five templates as a hardcoded array and drew the whole
 * picture at draft time from a colour palette. These are different in kind:
 * each carries a piece of **artwork** that exists independently of the caption
 * laid over it, which is what makes a template something an author can preview,
 * licence, retire and eventually replace with a photograph.
 *
 * The artwork is SVG composed here rather than fetched, for the reason every
 * other stand-in in this project is offline: the demo and the tests have to
 * produce the same bytes twice with no network and no key. It is drawn, not
 * generated — there is no image model behind this, and the Known gaps say so.
 *
 * Two templates are deliberately unusable. One has a licence that forbids
 * commercial use and one has no licence recorded at all, because the story's
 * second acceptance clause is about what happens when the generator reaches for
 * a template it may not have.
 */

/** Shared background pieces, so each artwork is composition rather than repetition. */
const defs = (id, from, to) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>` +
  `</linearGradient></defs>`;

const svg = (w, h, body) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`,
    'utf8',
  ).toString('base64')}`;

const HOUSE = { holder: 'Author Launch Engine', terms: 'cc0', commercial: true, attribution: null };
const PRESS = {
  holder: 'Vermilion Press',
  terms: 'cc-by',
  commercial: true,
  attribution: 'Vermilion Press',
};

export const TEMPLATE_SEED = [
  {
    key: 'two-panel-contrast',
    name: 'Two panel contrast',
    layout: 'two-panel',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      800,
      `${defs('g1', '#0d1117', '#161b22')}` +
        `<rect width="800" height="400" fill="url(#g1)"/>` +
        `<rect y="400" width="800" height="400" fill="#0b1b2b"/>` +
        `<circle cx="690" cy="110" r="64" fill="#4a9eff" opacity="0.18"/>` +
        `<circle cx="690" cy="510" r="64" fill="#4a9eff" opacity="0.42"/>` +
        `<rect y="396" width="800" height="8" fill="#4a9eff"/>`,
    ),
    caption_slots: [
      { name: 'setup', role: 'the expectation', maxChars: 60, x: 40, y: 170, size: 40, anchor: 'start', wrap: 30 },
      { name: 'turn', role: 'what the book actually says', maxChars: 200, x: 40, y: 560, size: 34, anchor: 'start', wrap: 34 },
    ],
  },
  {
    key: 'quote-card',
    name: 'Quote card',
    layout: 'quote',
    source: 'Drawn in-house, press colourway',
    licence: PRESS,
    image_ref: svg(
      800,
      600,
      `${defs('g2', '#0f1613', '#131f1a')}` +
        `<rect width="800" height="600" fill="url(#g2)"/>` +
        `<rect x="48" y="48" width="704" height="504" fill="none" stroke="#5fbf95" stroke-width="2" opacity="0.5"/>` +
        `<text x="86" y="176" font-family="Georgia,serif" font-size="140" fill="#5fbf95" opacity="0.25">&#8220;</text>`,
    ),
    caption_slots: [
      { name: 'quote', role: 'a sentence from the book', maxChars: 180, x: 400, y: 300, size: 36, anchor: 'middle', wrap: 30 },
      { name: 'attribution', role: 'the book it came from', maxChars: 60, x: 400, y: 500, size: 22, anchor: 'middle', wrap: 40 },
    ],
  },
  {
    key: 'single-statement',
    name: 'Single statement',
    layout: 'single',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      600,
      `${defs('g3', '#14110e', '#1c1713')}` +
        `<rect width="800" height="600" fill="url(#g3)"/>` +
        `<rect x="0" y="0" width="800" height="10" fill="#e0a458"/>` +
        `<rect x="0" y="590" width="800" height="10" fill="#e0a458" opacity="0.4"/>`,
    ),
    caption_slots: [
      { name: 'statement', role: 'one line, stated flatly', maxChars: 160, x: 400, y: 300, size: 42, anchor: 'middle', wrap: 26 },
    ],
  },
  {
    key: 'three-beat',
    name: 'Three beat',
    layout: 'three-panel',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      780,
      `<rect width="800" height="780" fill="#101014"/>` +
        `<rect y="0" width="800" height="256" fill="#17171f"/>` +
        `<rect y="262" width="800" height="256" fill="#1c1c26"/>` +
        `<rect y="524" width="800" height="256" fill="#23232f"/>` +
        `<rect x="0" y="256" width="800" height="6" fill="#a78bfa" opacity="0.6"/>` +
        `<rect x="0" y="518" width="800" height="6" fill="#a78bfa" opacity="0.6"/>`,
    ),
    caption_slots: [
      { name: 'first', role: 'the easy version', maxChars: 70, x: 40, y: 130, size: 34, anchor: 'start', wrap: 34 },
      { name: 'second', role: 'the complication', maxChars: 70, x: 40, y: 392, size: 34, anchor: 'start', wrap: 34 },
      { name: 'third', role: 'what the book argues', maxChars: 140, x: 40, y: 654, size: 34, anchor: 'start', wrap: 34 },
    ],
  },
  {
    key: 'side-by-side',
    name: 'Side by side',
    layout: 'comparison',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="#0e1116"/>` +
        `<rect x="0" y="0" width="396" height="600" fill="#141922"/>` +
        `<rect x="404" y="0" width="396" height="600" fill="#101a17"/>` +
        `<rect x="396" y="0" width="8" height="600" fill="#5fbf95" opacity="0.7"/>`,
    ),
    caption_slots: [
      { name: 'left', role: 'the common belief', maxChars: 90, x: 198, y: 300, size: 32, anchor: 'middle', wrap: 18 },
      { name: 'right', role: 'the book’s position', maxChars: 90, x: 602, y: 300, size: 32, anchor: 'middle', wrap: 18 },
    ],
  },
  {
    key: 'labelled-note',
    name: 'Labelled note',
    layout: 'labelled',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="#0f1014"/>` +
        `<rect x="0" y="0" width="800" height="120" fill="#4a9eff" opacity="0.16"/>` +
        `<rect x="0" y="118" width="800" height="4" fill="#4a9eff"/>`,
    ),
    caption_slots: [
      { name: 'label', role: 'the theme, named', maxChars: 40, x: 40, y: 78, size: 38, anchor: 'start', wrap: 30 },
      { name: 'body', role: 'what the book claims about it', maxChars: 200, x: 40, y: 260, size: 34, anchor: 'start', wrap: 34 },
    ],
  },
  {
    key: 'margin-note',
    name: 'Margin note',
    layout: 'single',
    source: 'Drawn in-house, page colourway',
    licence: HOUSE,
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="#f4f1e8"/>` +
        `<rect x="118" y="0" width="3" height="600" fill="#c86b6b" opacity="0.6"/>` +
        `${[...Array(9)].map((_, i) => `<rect x="150" y="${120 + i * 48}" width="600" height="1" fill="#c9c2b2"/>`).join('')}`,
    ),
    caption_slots: [
      {
        name: 'note',
        role: 'a line as if written in a margin',
        maxChars: 160,
        x: 160,
        y: 260,
        size: 34,
        anchor: 'start',
        wrap: 30,
        fill: '#22201c',
      },
    ],
  },
  {
    key: 'quiet-field',
    name: 'Quiet field',
    layout: 'single',
    source: 'Drawn in-house for this project',
    licence: HOUSE,
    image_ref: svg(
      800,
      600,
      `${defs('g4', '#0b0e11', '#131a20')}` +
        `<rect width="800" height="600" fill="url(#g4)"/>` +
        `<circle cx="400" cy="300" r="230" fill="#4a9eff" opacity="0.05"/>` +
        `<circle cx="400" cy="300" r="150" fill="#4a9eff" opacity="0.05"/>`,
    ),
    caption_slots: [
      { name: 'statement', role: 'one quiet line', maxChars: 140, x: 400, y: 300, size: 38, anchor: 'middle', wrap: 24 },
    ],
  },

  // ── The two the generator must never reach for ──────────────────────────────

  {
    key: 'stock-photo-overlay',
    name: 'Stock photo overlay',
    layout: 'single',
    source: 'Northlight Stock, editorial catalogue',
    // Known, and it forbids this use. Refused rather than escalated: no reviewer
    // here can grant a permission the licence withholds.
    licence: {
      holder: 'Northlight Stock',
      terms: 'editorial-only',
      commercial: false,
      attribution: 'Northlight Stock',
    },
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="#181818"/><rect x="60" y="60" width="680" height="480" fill="#2a2a2a"/>`,
    ),
    caption_slots: [
      { name: 'statement', role: 'one line over a photograph', maxChars: 120, x: 400, y: 300, size: 40, anchor: 'middle', wrap: 24 },
    ],
  },
  {
    key: 'community-remix',
    name: 'Community remix',
    layout: 'single',
    source: 'Submitted by a reader; origin not established',
    // No licence recorded at all. Unresolved, not refused — a gap in our
    // paperwork rather than a decision by a rights-holder, and the generator
    // refuses it either way while the audit log says which of the two it was.
    licence: null,
    image_ref: svg(
      800,
      600,
      `<rect width="800" height="600" fill="#111018"/><rect x="40" y="40" width="720" height="520" fill="#1a1826"/>`,
    ),
    caption_slots: [
      { name: 'statement', role: 'one line, informal', maxChars: 120, x: 400, y: 300, size: 40, anchor: 'middle', wrap: 24 },
    ],
  },
];
