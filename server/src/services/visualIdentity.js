/**
 * The book's visual identity (STORY-068).
 *
 * STORY-067 gave every template a licence and a slot structure. Reading the
 * finished library back is what showed the gap: eight licensed templates
 * carrying five different accent colours, one of them light while the rest are
 * dark. Every template legal, on-message and reusable; together, a feed rather
 * than a book.
 *
 * Two halves, and the split is the same one STORY-066 made for safety and
 * rights. **Tone words describe** — they are handed to the drafter and shape
 * what it writes. **Do-not-use rules refuse** — they are checked afterwards and
 * can withhold a candidate. A guide that only described would be the failure
 * STORY-009 found in the hand-written voice profile: a claim nothing verifies.
 */
import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';

export const ACTOR = 'AIContentGenerationAgent';

/** Named findings, so a withheld meme says which rule it broke. */
export const IDENTITY_FINDINGS = {
  OFF_PALETTE: 'off_palette',
  WRONG_MODE: 'wrong_mode',
  TOO_MANY_ACCENTS: 'too_many_accents',
  FORBIDDEN_TERM: 'forbidden_term',
};

const hexToRgb = (hex) => {
  const clean = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
};

/**
 * Straight RGB distance. Not perceptually uniform, and deliberately not:
 * this number is shown to an author as the reason their meme was withheld, and
 * a metric they can check by eye beats a more accurate one they cannot.
 */
export function colourDistance(a, b) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.round(Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2));
}

/** Perceived lightness, 0–255. Decides whether a colour reads as ground or ink. */
export const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
};

/** Every distinct colour an artwork actually uses. */
export const paletteOf = (svgDataUri) => {
  const svg = Buffer.from(String(svgDataUri).split(',')[1] ?? '', 'base64').toString('utf8');
  return [...new Set(svg.match(/#[0-9a-fA-F]{6}/g) ?? [])].map((h) => h.toLowerCase());
};

/**
 * Colours filling enough of the picture to set its mode.
 *
 * Deliberately *only* used for "is this light or dark". An earlier version used
 * this for accents too and caught almost nothing: a template's accent is
 * usually a hairline rule, a stroke or a line, all far below any sensible area
 * threshold. Checking the library back against the guide is what exposed it —
 * green, amber and purple templates all scored a clean 1.00.
 */
const STRUCTURAL_MIN_AREA = 20000;

/**
 * How far a colour is from grey.
 *
 * An accent is a *deliberate* colour, and size is not what makes it deliberate —
 * a 2px purple rule is the brand mark of that template. What separates an accent
 * from the near-black fields around it is saturation, not area.
 */
export const colourfulness = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/** Below this a colour reads as a neutral ground, however dark or light. */
const ACCENT_SATURATION = 40;

/**
 * Every deliberate colour in the artwork, at any size.
 *
 * Includes strokes and text fills, which is where most templates keep their
 * accent — and which is exactly what the area-based version missed.
 */
export function accentColours(svgDataUri, ground) {
  return paletteOf(svgDataUri).filter(
    (hex) => colourfulness(hex) >= ACCENT_SATURATION && colourDistance(hex, ground) > 40,
  );
}

export function structuralColours(svgDataUri) {
  const svg = Buffer.from(String(svgDataUri).split(',')[1] ?? '', 'base64').toString('utf8');
  const found = new Map();
  for (const m of svg.matchAll(/<rect[^>]*\/>/g)) {
    const tag = m[0];
    const w = Number(tag.match(/width="(\d+)"/)?.[1] ?? 0);
    const h = Number(tag.match(/height="(\d+)"/)?.[1] ?? 0);
    const fill = tag.match(/fill="(#[0-9a-fA-F]{6})"/)?.[1];
    if (!fill || w * h < STRUCTURAL_MIN_AREA) continue;
    const key = fill.toLowerCase();
    found.set(key, (found.get(key) ?? 0) + w * h);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([hex, area]) => ({ hex, area }));
}

/**
 * Derives a first guide from whatever evidence exists.
 *
 * With cover art the palette is *observed*. Without it, it is inferred from the
 * book's own words and is a guess — recorded as one, so the UI can ask for a
 * human rather than presenting an inference with the confidence of a fact. Same
 * rule as a voice profile nobody has posts for (STORY-009).
 */
export function deriveIdentity({ book, voiceProfile = {} }) {
  const cover = book.cover_art ?? null;
  const observed = cover ? structuralColours(cover) : [];

  // Ground is the largest field; ink is whatever contrasts it most; accent is
  // the most saturated remainder.
  const ground = observed[0]?.hex ?? '#0d1117';
  const mode = luminance(ground) > 140 ? 'light' : 'dark';
  const ink = mode === 'dark' ? '#f4f6f8' : '#14110e';
  const accent = (cover ? accentColours(cover, ground) : [])[0] ?? '#4a9eff';

  const tone = [
    ...new Set([
      ...(voiceProfile.tone ?? []),
      ...(book.themes ?? []).slice(0, 2),
      'quiet',
      'unhurried',
    ]),
  ];

  return {
    palette: { ground, ink, accent, mode, tolerance: 60 },
    typography: {
      family: 'Georgia, serif',
      case: 'sentence',
      why: 'A book about craft should not be set in the typeface of a dashboard.',
    },
    tone_words: tone,
    // Visual rules first, then whatever the author's own voice profile already
    // says to avoid — the verbal identity and the visual one should not
    // contradict each other, and it already exists.
    do_not_use: [
      'more than one accent colour',
      `${mode === 'dark' ? 'light' : 'dark'} backgrounds`,
      ...(voiceProfile.avoid ?? []),
    ],
    derived_from: {
      coverArt: Boolean(cover),
      structuralColours: observed.slice(0, 4).map((c) => c.hex),
      themes: book.themes ?? [],
      voiceProfileTone: voiceProfile.tone ?? [],
      // The honest label. An inferred palette is a starting point for an
      // argument with the author, not an answer.
      confidence: cover ? 'observed from cover art' : 'inferred from the book’s words — no cover art supplied',
    },
  };
}

const rowToIdentity = (row) =>
  row && {
    id: Number(row.id),
    authorId: Number(row.author_id),
    bookId: Number(row.book_id),
    version: row.version,
    palette: row.palette,
    typography: row.typography,
    toneWords: row.tone_words,
    doNotUse: row.do_not_use,
    derivedFrom: row.derived_from,
    active: row.active,
    createdBy: row.created_by,
    note: row.note,
    createdAt: row.created_at,
  };

export async function getActiveIdentity({ bookId }, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM visual_identity WHERE book_id = $1 AND active',
    [bookId],
  );
  return rowToIdentity(rows[0]);
}

export async function listVersions({ bookId }, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM visual_identity WHERE book_id = $1 ORDER BY version DESC',
    [bookId],
  );
  return rows.map(rowToIdentity);
}

/**
 * Writes a new version and retires the previous one.
 *
 * Always a new row, never an update. The story asks that a revision apply to
 * later memes; the half it does not say is that it must not reinterpret earlier
 * ones, and an in-place edit would do exactly that to every draft already
 * judged against the old rules.
 */
export async function saveIdentity(
  { authorId, bookId, guide, createdBy = 'system', note = '' },
  client = pool,
) {
  const { rows: prior } = await client.query(
    'SELECT COALESCE(MAX(version), 0) AS v FROM visual_identity WHERE book_id = $1',
    [bookId],
  );
  const version = Number(prior[0].v) + 1;

  await client.query('UPDATE visual_identity SET active = FALSE WHERE book_id = $1 AND active', [
    bookId,
  ]);

  const { rows } = await client.query(
    `INSERT INTO visual_identity
       (author_id, book_id, version, palette, typography, tone_words, do_not_use,
        derived_from, created_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      authorId,
      bookId,
      version,
      JSON.stringify(guide.palette),
      JSON.stringify(guide.typography ?? {}),
      guide.tone_words ?? guide.toneWords ?? [],
      guide.do_not_use ?? guide.doNotUse ?? [],
      JSON.stringify(guide.derived_from ?? guide.derivedFrom ?? {}),
      createdBy,
      note,
    ],
  );

  await recordAction(
    {
      actor: ACTOR,
      action: version === 1 ? 'visual_identity.derived' : 'visual_identity.revised',
      entityType: 'visual_identity',
      entityId: rows[0].id,
      authorId,
      metadata: {
        bookId,
        version,
        palette: rows[0].palette,
        doNotUse: rows[0].do_not_use,
        createdBy,
        note,
        supersedes: version > 1 ? version - 1 : null,
      },
    },
    client,
  );

  return rowToIdentity(rows[0]);
}

/**
 * Scores one candidate against the guide it will be judged by.
 *
 * Our code scores, as everywhere else in this project: the drafter is *given*
 * the guide and then measured against the same guide, so "looks like the book"
 * is a claim something other than the drafter can check.
 *
 * @returns {{score: number, findings: string[], detail: object[], summary: string}}
 */
export function scoreIdentity({ imageRef, caption = '', identity }) {
  if (!identity) {
    return { score: 1, findings: [], detail: [], summary: 'no identity recorded to check against' };
  }

  const { palette } = identity;
  const structural = structuralColours(imageRef);
  const detail = [];

  // Mode: is this a dark picture where the book is dark?
  const ground = structural[0]?.hex ?? palette.ground;
  const actualMode = luminance(ground) > 140 ? 'light' : 'dark';
  const modeOk = actualMode === palette.mode;
  if (!modeOk) {
    detail.push({
      finding: IDENTITY_FINDINGS.WRONG_MODE,
      why: `a ${actualMode} background where the identity is ${palette.mode}`,
    });
  }

  // Accents: every deliberate colour, at any size. A hairline rule counts.
  const accents = accentColours(imageRef, ground);
  const offPalette = accents.filter(
    (hex) => colourDistance(hex, palette.accent) > (palette.tolerance ?? 60),
  );

  if (offPalette.length > 0) {
    detail.push({
      finding: IDENTITY_FINDINGS.OFF_PALETTE,
      why:
        `${offPalette.join(', ')} against the identity accent ${palette.accent} ` +
        `(tolerance ${palette.tolerance ?? 60})`,
    });
  }
  if (accents.length > 1 && identity.doNotUse?.some((r) => /more than one accent/i.test(r))) {
    detail.push({
      finding: IDENTITY_FINDINGS.TOO_MANY_ACCENTS,
      why: `${accents.length} accent colours: ${accents.join(', ')}`,
    });
  }

  // Tone: the do-not-use rules that are about words rather than colour. A rule
  // naming a colour behaviour is handled above; anything else is matched
  // literally against the caption, which is what makes the list editable by a
  // human without a code change.
  const text = String(caption).toLowerCase();
  const verbalRules = (identity.doNotUse ?? []).filter(
    (rule) => !/accent|background|colour|color/i.test(rule),
  );
  const broken = verbalRules.filter((rule) => {
    const needle = rule.toLowerCase().replace(/^(no|avoid)\s+/, '').replace(/s$/, '');
    if (needle.includes('exclamation')) return caption.includes('!');
    return needle.length > 3 && text.includes(needle);
  });
  if (broken.length > 0) {
    detail.push({
      finding: IDENTITY_FINDINGS.FORBIDDEN_TERM,
      why: `the caption breaks: ${broken.join('; ')}`,
    });
  }

  // Weighted towards what a reader sees first. Mode is the loudest signal —
  // a light card in a dark identity does not look like the same book from
  // across a feed, however correct its accent is.
  const score = Number(
    Math.max(
      0,
      1 -
        (modeOk ? 0 : 0.5) -
        (offPalette.length > 0 ? 0.3 : 0) -
        (detail.some((d) => d.finding === IDENTITY_FINDINGS.TOO_MANY_ACCENTS) ? 0.15 : 0) -
        (broken.length > 0 ? 0.25 : 0),
    ).toFixed(3),
  );

  const findings = detail.map((d) => d.finding);
  return {
    score,
    findings,
    detail,
    summary:
      findings.length === 0
        ? `matches identity v${identity.version}`
        : `off identity v${identity.version}: ${detail.map((d) => d.why).join('; ')}`,
  };
}
