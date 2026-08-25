/**
 * Meme templates and the image they render to (STORY-066).
 *
 * Mocked the way the directories and the social adapters are: a fixed
 * catalogue with the shape a real template provider would return, so swapping
 * in a live one is a change confined to this file.
 *
 * Images are rendered as SVG data URIs rather than fetched. That keeps the demo
 * and the tests offline and byte-for-byte reproducible — the same constraint
 * that made theme retrieval lexical in STORY-006 — and it means the approval UI
 * previews a real image rather than a grey box standing in for one.
 *
 * The catalogue deliberately includes one template nobody can use and one whose
 * paperwork is incomplete, so the rights check has something real to refuse.
 */

/**
 * `licence` is the whole point of this file existing.
 *
 * A template without a licence is not a template we own, and the system will
 * not guess on the author's behalf — the same rule that stops it inventing an
 * award result or a claim about the book.
 */
export const TEMPLATES = [
  {
    id: 'tmpl-two-panel',
    name: 'Two panel contrast',
    layout: 'two-panel',
    // What the caption is expected to do in this layout, handed to the drafter
    // so the copy fits the shape rather than being pasted onto it.
    shape: 'a before line and an after line, the turn between them doing the work',
    licence: { holder: 'Author Launch Engine', terms: 'cc0', commercial: true, attribution: null },
    palette: { bg: '#101418', fg: '#f4f6f8', accent: '#4a9eff' },
  },
  {
    id: 'tmpl-single-caption',
    name: 'Single caption over field',
    layout: 'single',
    shape: 'one line, stated flatly, no setup',
    licence: { holder: 'Author Launch Engine', terms: 'cc0', commercial: true, attribution: null },
    palette: { bg: '#14110e', fg: '#f7f3ec', accent: '#e0a458' },
  },
  {
    id: 'tmpl-quote-card',
    name: 'Quote card',
    layout: 'quote',
    shape: 'a sentence from the book, attributed to the book',
    licence: {
      holder: 'Vermilion Press',
      terms: 'cc-by',
      commercial: true,
      attribution: 'Vermilion Press',
    },
    palette: { bg: '#0f1613', fg: '#eef5f1', accent: '#5fbf95' },
  },
  {
    // Editorial-use-only: the licence is known and it forbids this use. The
    // check must refuse it outright rather than escalate, because no reviewer
    // here can grant a permission the licence withholds.
    id: 'tmpl-stock-photo',
    name: 'Stock photo overlay',
    layout: 'single',
    shape: 'one line over a photograph',
    licence: {
      holder: 'Northlight Stock',
      terms: 'editorial-only',
      commercial: false,
      attribution: 'Northlight Stock',
    },
    palette: { bg: '#181818', fg: '#fafafa', accent: '#c46b6b' },
  },
  {
    // Paperwork incomplete. Not refused — unresolved, which is a different
    // answer and gets a different treatment: a human is asked.
    id: 'tmpl-community-remix',
    name: 'Community remix',
    layout: 'single',
    shape: 'one line, informal',
    licence: null,
    palette: { bg: '#111018', fg: '#f2f0f8', accent: '#a78bfa' },
  },
];

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) ?? null;

/** Templates a meme may actually be built from, given what we can licence. */
export const usableTemplates = () =>
  TEMPLATES.filter((t) => t.licence?.commercial === true);

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Greedy wrap. Crude on purpose — the point is a legible preview, not typesetting. */
function wrap(text, perLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > perLine && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Renders the meme to an SVG data URI.
 *
 * Deterministic: the same template and caption always produce the same bytes,
 * which is what lets a test assert on an image and a demo re-run unchanged.
 */
export function renderMeme({ template, caption, bookTitle }) {
  const { palette, layout } = template;
  const W = 800;
  const H = layout === 'two-panel' ? 800 : 600;

  const panels = layout === 'two-panel' ? String(caption).split(/\s*\|\s*|\n+/) : [String(caption)];
  const blocks = [];

  if (layout === 'two-panel') {
    const [top = '', bottom = ''] = panels;
    blocks.push(`<rect x="0" y="0" width="${W}" height="${H / 2}" fill="${palette.bg}"/>`);
    blocks.push(
      `<rect x="0" y="${H / 2}" width="${W}" height="${H / 2}" fill="${palette.accent}" opacity="0.12"/>`,
    );
    wrap(top, 30).slice(0, 3).forEach((line, i) => {
      blocks.push(
        `<text x="40" y="${110 + i * 54}" font-family="Georgia,serif" font-size="40" fill="${palette.fg}">${escape(line)}</text>`,
      );
    });
    wrap(bottom, 30).slice(0, 3).forEach((line, i) => {
      blocks.push(
        `<text x="40" y="${H / 2 + 110 + i * 54}" font-family="Georgia,serif" font-size="40" fill="${palette.fg}">${escape(line)}</text>`,
      );
    });
    blocks.push(
      `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="${palette.accent}" stroke-width="4"/>`,
    );
  } else {
    blocks.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${palette.bg}"/>`);
    const lines = wrap(caption, layout === 'quote' ? 28 : 26).slice(0, 6);
    const startY = H / 2 - (lines.length - 1) * 28;
    lines.forEach((line, i) => {
      blocks.push(
        `<text x="${W / 2}" y="${startY + i * 56}" text-anchor="middle" font-family="Georgia,serif" font-size="${layout === 'quote' ? 38 : 42}" fill="${palette.fg}">${escape(line)}</text>`,
      );
    });
    if (layout === 'quote') {
      blocks.push(
        `<text x="${W / 2}" y="${H - 60}" text-anchor="middle" font-family="Georgia,serif" font-size="24" fill="${palette.accent}">— ${escape(bookTitle)}</text>`,
      );
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    blocks.join('') +
    '</svg>';

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * The provenance record that travels with the image.
 *
 * Written at generation time, not derived later: the point of provenance is
 * that it says where an image came from, and something reconstructing it
 * afterwards would only be guessing.
 */
export const provenanceFor = (template) => ({
  source: 'template',
  templateId: template.id,
  templateName: template.name,
  generator: 'renderMeme/svg',
  licence: template.licence,
});
