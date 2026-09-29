import { createHash } from 'node:crypto';

import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { PASSAGES_PER_THEME } from './themeRetrieval.js';

/**
 * A model fitted to each book (STORY-046 / REQ-012) — AI Content Generation Agent.
 *
 * What is fitted: for each of the book's themes, a lexicon — the words this
 * book uses when it argues that theme — learned by contrasting the passages
 * that name the theme with the rest of the book. Supplementary materials (a
 * synopsis, the author's notes) join the examples; only the book's own
 * passages are ever used as evidence. Plus the book's own style and, per
 * theme, the lines that carry it best.
 *
 * What it changes: retrieval found a theme only where the book used its word.
 * With a model, passages that argue a theme in other words reach the drafter
 * too, marked as found by the model — and the drafter's prompt carries the
 * lexicon and the lines.
 *
 * How it is judged: leave-one-out on the passages that name a theme, with the
 * theme's own word masked out. Literal retrieval scores zero on that by
 * construction; the model scores what it actually learned.
 *
 * Words are Postgres `english` lexemes — the same stemming retrieval uses —
 * and every statistic is computed within the book. Other tenants' books are
 * never read to fit this one.
 */
export const ACTOR = 'AIContentGenerationAgent';
export const LEXICON_SIZE = 12;
/** A term must appear in at least this many example documents to be learned. */
export const MIN_SUPPORT = 2;
/** Below this many passages naming a theme there is nothing to learn from, and the model says so. */
export const MIN_EXAMPLES = 2;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

const flat = (text) => String(text).replace(/\s+/g, ' ').trim();

/**
 * Which of these passages a draft quotes. `draft_themes.passage_ids` lists every
 * passage grounding a theme, not the one a draft was written from; the text
 * says which (STORY-047).
 */
export function quotedPassages(content, passages) {
  const text = flat(content);
  return passages.filter((p) => p.content.split(/(?<=[.!?])\s+/)
    .some((sentence) => sentence.length >= 20 && text.includes(flat(sentence))));
}

/** Feedback needs this many judgments on a passage or theme before it moves anything. */
export const MIN_JUDGMENTS = 2;
/** A passage whose preference falls below this — turned down twice and never liked scores 0.5 — is not quoted when the book has another. */
export const AVOID_BELOW = 0.6;

/**
 * Every judgment on this book's drafts (STORY-048): a reviewer's rating where
 * there is one (4–5 good, 1–2 bad, 3 neither), otherwise their decision
 * (approved or scheduled good; rejected or changes requested bad). Each is
 * attributed to the passages the draft quoted and the themes it claimed.
 */
async function loadFeedback(bookId, passages, client) {
  const { rows } = await client.query(
    `SELECT d.id, d.content, d.themes_used, d.status, d.change_request,
            (SELECT f.rating FROM content_feedback f WHERE f.draft_id = d.id AND f.rating IS NOT NULL ORDER BY f.id DESC LIMIT 1) AS rating,
            (SELECT array_agg(f.comment ORDER BY f.id) FROM content_feedback f WHERE f.draft_id = d.id AND f.comment IS NOT NULL) AS comments,
            (SELECT a.notes FROM approvals a WHERE a.draft_id = d.id ORDER BY a.id DESC LIMIT 1) AS decision_notes
       FROM drafts d
      WHERE d.book_id = $1
        AND (d.status IN ('approved', 'scheduled', 'rejected', 'changes_requested')
             OR EXISTS (SELECT 1 FROM content_feedback f WHERE f.draft_id = d.id))
      ORDER BY d.id`,
    [bookId],
  );
  return rows.map((r) => {
    const byRating = r.rating == null ? null : r.rating >= 4 ? 1 : r.rating <= 2 ? -1 : 0;
    const byDecision = ['approved', 'scheduled'].includes(r.status) ? 1 : ['rejected', 'changes_requested'].includes(r.status) ? -1 : 0;
    const label = byRating ?? byDecision;
    return {
      draftId: Number(r.id),
      label,
      source: byRating != null ? `rating ${r.rating}` : r.status,
      themes: r.themes_used ?? [],
      passages: quotedPassages(r.content, passages).map((p) => Number(p.id)),
      notes: [r.change_request, r.decision_notes, ...(r.comments ?? [])].filter((n) => n && n.trim()),
    };
  });
}

/**
 * Preferences from feedback: a smoothed share of good judgments, scaled so 1
 * is neutral — (good + 1) / (good + bad + 2) × 2 — and applied only after
 * MIN_JUDGMENTS. Passages range 0–2; themes are held to 0.5–1.5 so feedback
 * can tilt which themes are written about but never silence one.
 */
export function learnPreferences(feedback) {
  const tally = (key) => {
    const m = new Map();
    for (const f of feedback) {
      if (f.label === 0) continue;
      for (const k of f[key]) {
        const t = m.get(k) ?? { good: 0, bad: 0 };
        if (f.label > 0) t.good += 1; else t.bad += 1;
        m.set(k, t);
      }
    }
    return m;
  };
  const weigh = ({ good, bad }, lo, hi) => {
    if (good + bad < MIN_JUDGMENTS) return 1;
    return Number(Math.min(hi, Math.max(lo, ((good + 1) / (good + bad + 2)) * 2)).toFixed(3));
  };
  return {
    judgments: feedback.filter((f) => f.label !== 0).length,
    passages: [...tally('passages')].map(([id, t]) => ({ id, ...t, weight: weigh(t, 0, 2) }))
      .sort((a, b) => a.weight - b.weight || a.id - b.id),
    themes: [...tally('themes')].map(([theme, t]) => ({ theme, ...t, weight: weigh(t, 0.5, 1.5) }))
      .sort((a, b) => a.theme.localeCompare(b.theme)),
    // What reviewers said, most recent last — for a provider that can read it.
    notes: feedback.flatMap((f) => f.notes.map((note) => ({ draftId: f.draftId, label: f.label, note }))).slice(-8),
  };
}

/** Everything the model is fitted on, and the digest that identifies it. */
async function loadInputs(bookId, client) {
  const { rows: [book] } = await client.query('SELECT id, author_id, title, content FROM books WHERE id = $1', [bookId]);
  if (!book) throw fail(404, 'No such book');
  const { rows: themes } = await client.query(
    `SELECT theme, key_message, array_to_json(tsvector_to_array(to_tsvector('english', theme))) AS lexemes
       FROM book_themes WHERE book_id = $1 ORDER BY position, theme`,
    [bookId],
  );
  const { rows: passages } = await client.query(
    `SELECT id, ordinal, content, array_to_json(tsvector_to_array(tsv)) AS lexemes
       FROM book_passages WHERE book_id = $1 ORDER BY ordinal`,
    [bookId],
  );
  const { rows: materials } = await client.query(
    'SELECT id, kind, content FROM book_materials WHERE book_id = $1 ORDER BY id',
    [bookId],
  );
  // Materials are learned from a sentence at a time: a synopsis naming all
  // three themes in one paragraph would otherwise teach each theme the others'
  // words (the first version did exactly that).
  const sentences = materials.flatMap((m) =>
    m.content.split(/(?<=[.!?])\s+/).filter((x) => /\w/.test(x)).map((text) => ({ materialId: m.id, text })));
  const { rows: lexed } = sentences.length
    ? await client.query(
      `SELECT ord, array_to_json(tsvector_to_array(to_tsvector('english', s))) AS lexemes
         FROM unnest($1::text[]) WITH ORDINALITY AS u(s, ord)`,
      [sentences.map((x) => x.text)],
    )
    : { rows: [] };
  const materialSentences = lexed.map((r) => ({ ...sentences[Number(r.ord) - 1], lexemes: r.lexemes }));
  const contentDigest = sha256(JSON.stringify({
    content: book.content,
    themes: themes.map((t) => [t.theme, t.key_message]),
    materials: materials.map((m) => [m.kind, m.content]),
  }));
  const feedback = await loadFeedback(bookId, passages, client);
  const feedbackDigest = sha256(JSON.stringify(feedback.map((f) => [f.draftId, f.label, f.source])));
  const digest = sha256(`${contentDigest}:${feedbackDigest}`);
  return { book, themes, passages, materials, materialSentences, feedback, contentDigest, feedbackDigest, digest };
}

const hasAll = (set, lexemes) => lexemes.length > 0 && lexemes.every((l) => set.has(l));

/**
 * Learns a theme's lexicon: terms over-represented in the examples (passages
 * and materials naming the theme) relative to the rest of the book. A smoothed
 * log ratio of document frequencies — interpretable, and stable on a book's
 * worth of text, which is small data.
 */
/**
 * Words too general to say anything about a theme, which a book's worth of
 * text lets through: the first fit learned "could" for grief and "year" for
 * patience. Postgres' stopword list already drops the commonest.
 */
export const GENERIC = new Set([
  'could', 'would', 'cannot', 'much', 'year', 'made', 'make', 'like', 'still', 'first', 'time', 'way',
  'thing', 'came', 'come', 'went', 'know', 'said', 'say', 'never', 'everi', 'even', 'back', 'one', 'two',
  'day', 'morn', 'night', 'long', 'mani', 'also', 'someth', 'anyth', 'noth', 'get', 'got', 'put', 'left',
  'book', 'stori', 'run',
]);

export function learnLexicon({ themeLexemes, examples, background, exclude = [] }) {
  const own = new Set([...themeLexemes, ...exclude, ...GENERIC]);
  const count = (docs) => {
    const n = new Map();
    for (const d of docs) for (const l of d) if (!own.has(l) && l.length > 2) n.set(l, (n.get(l) ?? 0) + 1);
    return n;
  };
  const inExamples = count(examples);
  const inBackground = count(background);
  const lexicon = [];
  for (const [term, a] of inExamples) {
    if (a < MIN_SUPPORT) continue;
    const b = inBackground.get(term) ?? 0;
    const weight = Math.log(((a + 0.5) / (examples.length + 1)) / ((b + 0.5) / (background.length + 1)));
    if (weight > 0) lexicon.push({ term, weight: Number(weight.toFixed(3)), support: a });
  }
  lexicon.sort((x, y) => y.weight - x.weight || y.support - x.support || x.term.localeCompare(y.term));
  return lexicon.slice(0, LEXICON_SIZE);
}

/** How strongly a passage argues a theme, by the lexicon — ignoring the theme's own word. */
export function scoreWith(lexicon, lexemes) {
  const set = lexemes instanceof Set ? lexemes : new Set(lexemes);
  let score = 0;
  let hits = 0;
  for (const { term, weight } of lexicon) {
    if (set.has(term)) {
      score += weight;
      hits += 1;
    }
  }
  return { score, hits };
}

const quantile = (values, q) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** Style, counted off the book's own sentences. */
function styleOf(text) {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /\w/.test(s));
  const words = text.match(/[A-Za-z']+/g) ?? [];
  const perSentence = sentences.map((s) => (s.match(/[A-Za-z']+/g) ?? []).length);
  const mean = perSentence.reduce((a, b) => a + b, 0) / Math.max(1, perSentence.length);
  const secondPerson = words.filter((w) => /^(you|your|yours|yourself)$/i.test(w)).length;
  return {
    sentences: sentences.length,
    words: words.length,
    meanSentenceWords: Number(mean.toFixed(1)),
    questionsPer100Sentences: Number(((sentences.filter((s) => s.endsWith('?')).length / Math.max(1, sentences.length)) * 100).toFixed(1)),
    secondPersonPer1000Words: Number(((secondPerson / Math.max(1, words.length)) * 1000).toFixed(1)),
  };
}

/**
 * Fits the model. Pure over its inputs, so it can be tested and re-run: the
 * same book and materials give the same parameters.
 */
export async function fitParameters(inputs, client = pool) {
  const { book, themes, passages, materials, materialSentences } = inputs;
  const passageSets = passages.map((p) => ({ ...p, set: new Set(p.lexemes) }));
  const materialSets = materialSentences.map((m) => new Set(m.lexemes));
  // A theme's lexicon never includes another theme's own word: "grief" is not
  // evidence of "inheritance" because one sentence mentions both.
  const allThemeLexemes = themes.flatMap((t) => t.lexemes);

  const fitted = [];
  const evaluation = [];
  for (const t of themes) {
    const seeds = passageSets.filter((p) => hasAll(p.set, t.lexemes));
    const rest = passageSets.filter((p) => !hasAll(p.set, t.lexemes));
    const materialExamples = materialSets.filter((m) => hasAll(m, t.lexemes)).map((m) => [...m]);
    const examples = [...seeds.map((p) => p.lexemes), ...materialExamples];

    const lexicon = examples.length >= MIN_EXAMPLES
      ? learnLexicon({ themeLexemes: t.lexemes, examples, background: rest.map((p) => p.lexemes), exclude: allThemeLexemes })
      : [];

    // Passages the literal search misses and the lexicon finds: at least two
    // of its terms, and scoring above what the rest of the book usually does.
    const restScores = rest.map((p) => ({ p, ...scoreWith(lexicon, p.set) }));
    const bar = Math.max(quantile(restScores.map((r) => r.score), 0.75), 1e-9);
    const found = restScores
      .filter((r) => r.hits >= 2 && r.score > bar)
      .sort((a, b) => b.score - a.score || a.p.ordinal - b.p.ordinal)
      .slice(0, PASSAGES_PER_THEME)
      .map((r) => ({ id: Number(r.p.id), score: Number(r.score.toFixed(3)), terms: lexicon.filter((l) => r.p.set.has(l.term)).map((l) => l.term) }));

    // Held-out check: learn without one naming passage, then find it again
    // with the theme's word masked. Literal retrieval can never do this.
    let recalled = 0;
    let tried = 0;
    if (seeds.length >= MIN_EXAMPLES + 1) {
      for (const held of seeds) {
        const others = seeds.filter((s) => s !== held).map((s) => s.lexemes);
        const lex = learnLexicon({ themeLexemes: t.lexemes, examples: [...others, ...materialExamples], background: rest.map((p) => p.lexemes), exclude: allThemeLexemes });
        const masked = new Set([...held.set].filter((l) => !t.lexemes.includes(l)));
        const heldScore = scoreWith(lex, masked).score;
        const restBar = quantile(rest.map((p) => scoreWith(lex, p.set).score), 0.75);
        tried += 1;
        if (heldScore > restBar && heldScore > 0) recalled += 1;
      }
    }

    fitted.push({
      theme: t.theme,
      lexicon,
      examples: { passages: seeds.length, materialSentences: materialExamples.length },
      literalPassages: seeds.map((s) => Number(s.id)),
      foundPassages: found,
      learned: lexicon.length > 0,
    });
    evaluation.push({ theme: t.theme, heldOut: tried, recalled });
  }

  // The lines that carry each theme best, from the passages the model reads
  // as arguing it: sentences of a readable length, densest in its terms.
  const byId = new Map(passageSets.map((p) => [Number(p.id), p]));
  const candidateSentences = [];
  for (const f of fitted) {
    const ids = [...f.literalPassages, ...f.foundPassages.map((x) => x.id)];
    for (const id of ids) {
      for (const sentence of byId.get(id).content.split(/(?<=[.!?])\s+/)) {
        const words = (sentence.match(/[A-Za-z']+/g) ?? []).length;
        if (words >= 6 && words <= 28) candidateSentences.push({ theme: f.theme, passageId: id, sentence: sentence.trim() });
      }
    }
  }
  const { rows: lexed } = candidateSentences.length
    ? await client.query(
      `SELECT ord, array_to_json(tsvector_to_array(to_tsvector('english', s))) AS lexemes
         FROM unnest($1::text[]) WITH ORDINALITY AS u(s, ord)`,
      [candidateSentences.map((c) => c.sentence)],
    )
    : { rows: [] };
  for (const f of fitted) {
    const own = themes.find((t) => t.theme === f.theme).lexemes;
    const terms = [...own.map((term) => ({ term, weight: 1 })), ...f.lexicon];
    f.anchorLines = lexed
      .map((r) => ({ ...candidateSentences[Number(r.ord) - 1], score: scoreWith(terms, r.lexemes).score }))
      .filter((c) => c.theme === f.theme && c.score > 0)
      .sort((a, b) => b.score - a.score || a.sentence.length - b.sentence.length)
      .filter((c, i, all) => all.findIndex((x) => x.sentence === c.sentence) === i)
      .slice(0, 2)
      .map(({ passageId, sentence }) => ({ passageId, sentence }));
  }

  // Stems are what matching uses ("empti", "chang"); people read words. Each
  // learned term is shown as the word this book most often uses for it.
  const learnedTerms = [...new Set(fitted.flatMap((f) => f.lexicon.map((l) => l.term)))];
  if (learnedTerms.length) {
    const counts = new Map();
    for (const w of (book.content.toLowerCase().match(/[a-z']+/g) ?? [])) counts.set(w, (counts.get(w) ?? 0) + 1);
    const { rows: forms } = await client.query(
      `SELECT w, (tsvector_to_array(to_tsvector('english', w)))[1] AS lexeme
         FROM unnest($1::text[]) AS u(w)`,
      [[...counts.keys()]],
    );
    const word = new Map();
    for (const { w, lexeme } of forms) {
      if (!lexeme || !learnedTerms.includes(lexeme)) continue;
      const best = word.get(lexeme);
      if (!best || counts.get(w) > counts.get(best)) word.set(lexeme, w);
    }
    for (const f of fitted) for (const l of f.lexicon) l.word = word.get(l.term) ?? l.term;
  }

  const heldOut = evaluation.reduce((a, e) => a + e.heldOut, 0);
  const recalled = evaluation.reduce((a, e) => a + e.recalled, 0);
  const literalEvidence = fitted.reduce((a, f) => a + Math.min(f.literalPassages.length, PASSAGES_PER_THEME), 0);
  const modelEvidence = fitted.reduce(
    (a, f) => a + Math.min(f.literalPassages.length + f.foundPassages.length, PASSAGES_PER_THEME), 0,
  );

  return {
    parameters: {
      themes: fitted,
      style: styleOf(book.content),
      preferences: learnPreferences(inputs.feedback ?? []),
      sources: {
        contentDigest: inputs.contentDigest,
        feedbackDigest: inputs.feedbackDigest,
        bookCharacters: book.content.length,
        passages: passages.length,
        materials: materials.reduce((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {}),
      },
    },
    metrics: {
      // Held-out, theme word masked. Literal retrieval scores 0 here by construction.
      maskedRecall: heldOut ? Number((recalled / heldOut).toFixed(3)) : null,
      heldOut,
      recalled,
      perTheme: evaluation,
      // Grounding slots filled (themes × PASSAGES_PER_THEME) before and after.
      evidenceSlots: themes.length * PASSAGES_PER_THEME,
      literalEvidence,
      modelEvidence,
      themesLearned: fitted.filter((f) => f.learned).length,
      themesWithoutExamples: fitted.filter((f) => !f.learned).map((f) => f.theme),
    },
  };
}

/**
 * Fits and stores a new version, unless the current one was fitted on exactly
 * these inputs. Logged with what it learned and how well it did.
 */
export async function fitBookModel({ bookId, trigger = 'manual', actor = ACTOR }, client = pool) {
  const inputs = await loadInputs(bookId, client);
  const { rows: [current] } = await client.query("SELECT * FROM book_models WHERE book_id = $1 AND status = 'current'", [bookId]);
  if (current && current.input_digest === inputs.digest) return { model: current, refitted: false };
  // Only the feedback moved (STORY-048): say so, rather than "inputs changed".
  const onlyFeedback = current && current.parameters.sources?.contentDigest === inputs.contentDigest;
  const why = onlyFeedback && ['inputs_changed', 'first_draft', 'manual'].includes(trigger) ? 'feedback' : trigger;

  const { parameters, metrics } = await fitParameters(inputs, client);
  // What the feedback moved, against the version this supersedes.
  const before = new Map((current?.parameters.preferences?.passages ?? []).map((p) => [p.id, p.weight]));
  const beforeThemes = new Map((current?.parameters.preferences?.themes ?? []).map((t) => [t.theme, t.weight]));
  const moved = {
    passages: parameters.preferences.passages
      .filter((p) => (before.get(p.id) ?? 1) !== p.weight)
      .map((p) => ({ id: p.id, from: before.get(p.id) ?? 1, to: p.weight, good: p.good, bad: p.bad })),
    themes: parameters.preferences.themes
      .filter((t) => (beforeThemes.get(t.theme) ?? 1) !== t.weight)
      .map((t) => ({ theme: t.theme, from: beforeThemes.get(t.theme) ?? 1, to: t.weight, good: t.good, bad: t.bad })),
  };
  if (current) await client.query("UPDATE book_models SET status = 'superseded' WHERE id = $1", [current.id]);
  const { rows: [model] } = await client.query(
    `INSERT INTO book_models (book_id, author_id, version, status, input_digest, parameters, metrics, trigger, trained_by)
     VALUES ($1, $2, COALESCE((SELECT MAX(version) FROM book_models WHERE book_id = $1), 0) + 1, 'current', $3, $4, $5, $6, $7)
     RETURNING *`,
    [bookId, inputs.book.author_id, inputs.digest, JSON.stringify(parameters), JSON.stringify(metrics), why, actor],
  );
  await recordAction(
    {
      actor: ACTOR,
      action: 'book_model.fitted',
      entityType: 'book',
      entityId: bookId,
      authorId: Number(inputs.book.author_id),
      metadata: {
        version: model.version,
        trigger: why,
        requestedBy: actor,
        feedbackJudgments: parameters.preferences.judgments,
        preferencesMoved: moved,
        inputDigest: inputs.digest,
        supersedes: current ? current.version : null,
        sources: parameters.sources,
        lexicons: Object.fromEntries(parameters.themes.map((t) => [t.theme, t.lexicon.slice(0, 5).map((l) => l.word ?? l.term)])),
        maskedRecall: metrics.maskedRecall,
        evidence: `${metrics.literalEvidence} → ${metrics.modelEvidence} of ${metrics.evidenceSlots} slots`,
        themesWithoutExamples: metrics.themesWithoutExamples,
      },
    },
    client,
  );
  return { model, refitted: true };
}

/** The current model, fitted first if there is none or its inputs have changed. */
export async function ensureBookModel({ bookId, actor = ACTOR }, client = pool) {
  const { rows: [current] } = await client.query("SELECT id FROM book_models WHERE book_id = $1 AND status = 'current'", [bookId]);
  const { model } = await fitBookModel({ bookId, trigger: current ? 'inputs_changed' : 'first_draft', actor }, client);
  return model;
}

/**
 * Grounding with the model: a theme short of evidence gets the passages the
 * model found for it, marked as such. Literal evidence is never displaced.
 */
export async function groundWithModel(grounding, model, client = pool) {
  if (!model) return grounding;
  const weightOf = new Map((model.parameters.preferences?.passages ?? []).map((p) => [Number(p.id), p.weight]));
  const w = (id) => weightOf.get(Number(id)) ?? 1;

  // Candidates per theme: what retrieval found, the book's other passages that
  // name the theme, then what the model found (STORY-046).
  const plan = new Map();
  const needed = new Set();
  for (const g of grounding.themes) {
    const t = model.parameters.themes.find((x) => x.theme === g.theme);
    const seen = new Set(g.passages.map((p) => Number(p.id)));
    const more = [
      ...(t?.literalPassages ?? []).filter((id) => !seen.has(Number(id))).map((id) => ({ id: Number(id), source: 'book' })),
      ...(t?.foundPassages ?? []).filter((f) => !seen.has(Number(f.id))).map((f) => ({ id: Number(f.id), source: 'book model', rank: f.score, terms: f.terms })),
    ];
    plan.set(g.theme, more);
    for (const m of more) needed.add(m.id);
  }
  const { rows } = needed.size
    ? await client.query('SELECT id, content FROM book_passages WHERE id = ANY($1::bigint[])', [[...needed]])
    : { rows: [] };
  const content = new Map(rows.map((r) => [Number(r.id), r.content]));

  let added = 0;
  const avoided = [];
  const themes = grounding.themes.map((g) => {
    const extra = (plan.get(g.theme) ?? []).filter((m) => content.has(m.id)).map((m) => ({ ...m, content: content.get(m.id) }));
    const all = [...g.passages, ...extra];
    // Reviewers' preferences (STORY-048): a passage they keep turning down is
    // not quoted while the book has another for the theme. Never all of them:
    // a theme with only disfavoured passages keeps them, and the reviewer sees why.
    const liked = all.filter((p) => w(p.id) >= AVOID_BELOW);
    const usable = liked.length ? liked : all;
    for (const p of all) if (!usable.includes(p) || (liked.length && w(p.id) < AVOID_BELOW)) avoided.push(Number(p.id));
    // Literal evidence first, as before; within that, what reviewers liked first.
    const chosen = usable
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.source ? 1 : 0) - (b.p.source ? 1 : 0) || w(b.p.id) - w(a.p.id) || a.i - b.i)
      .map(({ p }) => p)
      .slice(0, Math.max(PASSAGES_PER_THEME, 0));
    const kept = chosen.length ? chosen : g.passages;
    added += kept.filter((p) => p.source === 'book model').length;
    return { ...g, passages: kept.map((p) => (weightOf.has(Number(p.id)) ? { ...p, preference: w(p.id) } : p)) };
  });
  const passageCount = new Set(themes.flatMap((t) => t.passages.map((p) => p.id))).size;
  return { ...grounding, themes, passageCount, model: { version: model.version, added, avoided: [...new Set(avoided)] } };
}

export async function addMaterial({ bookId, authorId, kind, content, user }) {
  const { rows: [book] } = await pool.query('SELECT id FROM books WHERE id = $1 AND author_id = $2', [bookId, authorId]);
  if (!book) throw fail(404, 'Book not found for this author');
  const { rows: [material] } = await pool.query(
    'INSERT INTO book_materials (book_id, author_id, kind, content, added_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, created_at',
    [bookId, authorId, kind, content.trim(), user?.name ?? 'unknown'],
  );
  await recordAction({
    actor: user?.name ?? ACTOR,
    action: 'book.material_added',
    entityType: 'book',
    entityId: bookId,
    authorId: Number(authorId),
    metadata: { kind, characters: content.trim().length },
  });
  const { model, refitted } = await fitBookModel({ bookId, trigger: 'material_added', actor: user?.name ?? ACTOR });
  return { material, model: summarise(model), refitted };
}

/** What a reviewer or the author reads: the model, its history and its inputs. */
export async function describeBookModel({ bookId, authorId }) {
  const { rows: [book] } = await pool.query('SELECT id, title FROM books WHERE id = $1 AND author_id = $2', [bookId, authorId]);
  if (!book) throw fail(404, 'Book not found for this author');
  const { rows: versions } = await pool.query(
    'SELECT id, version, status, trigger, trained_by, trained_at, metrics FROM book_models WHERE book_id = $1 ORDER BY version DESC',
    [bookId],
  );
  const { rows: [current] } = await pool.query("SELECT * FROM book_models WHERE book_id = $1 AND status = 'current'", [bookId]);
  const { rows: materials } = await pool.query(
    'SELECT id, kind, left(content, 160) AS preview, added_by, created_at FROM book_materials WHERE book_id = $1 ORDER BY id DESC',
    [bookId],
  );
  // The passages reviewers' feedback has moved (STORY-048), with enough text to recognise them.
  const moved = (current?.parameters.preferences?.passages ?? []).filter((p) => p.weight !== 1).map((p) => p.id);
  const { rows: previews } = moved.length
    ? await pool.query('SELECT id, left(content, 140) AS preview FROM book_passages WHERE id = ANY($1::bigint[])', [moved])
    : { rows: [] };
  return {
    book,
    current: current ? summarise(current) : null,
    versions,
    materials,
    passagePreviews: Object.fromEntries(previews.map((r) => [Number(r.id), r.preview])),
  };
}

export const summarise = (model) => ({
  id: Number(model.id),
  version: model.version,
  status: model.status,
  trigger: model.trigger,
  trainedBy: model.trained_by,
  trainedAt: model.trained_at,
  inputDigest: model.input_digest,
  parameters: model.parameters,
  metrics: model.metrics,
});
