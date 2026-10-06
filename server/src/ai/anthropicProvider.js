import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';
import { stubProvider } from './stubProvider.js';

const apiUrl = () => `${config.anthropicBaseUrl}/v1/messages`;

const PLATFORM_BRIEF = {
  twitter: 'under 280 characters, punchy, at most one hashtag',
  instagram: 'warm and visual, 2-3 short paragraphs, 3-5 hashtags at the end',
  facebook: 'conversational, 2-3 sentences, no hashtags, invites replies',
  linkedin: 'professional but personal, a concrete takeaway, no hashtags',
};

/**
 * The retrieved evidence, laid out per theme (STORY-009).
 *
 * The prompt used to carry four theme labels and the first 4,000 characters of
 * the book and hope the model found the connection. It now carries what each
 * theme claims and the book's own passages that argue it — the same grounding
 * the post is scored against afterwards, so the model is asked for the thing it
 * will be measured on rather than something adjacent to it.
 */
function groundingBrief(grounding) {
  const themes = grounding?.themes ?? [];
  if (themes.length === 0) return '';

  return [
    "What the book argues, theme by theme. Write from this, not from the theme names:",
    ...themes.map((t) => {
      // A passage the book model found argues the theme without naming it
      // (STORY-046); the model is told so, so it does not go looking for the word.
      const evidence = t.passages
        .map((p) => `    > ${p.content}${p.source === 'book model' ? '  [found by the book model: argues this without naming it]' : ''}`)
        .join('\n');
      return [
        `- ${t.theme}`,
        t.keyMessage ? `    claim: ${t.keyMessage}` : '    claim: (none recorded — do not invent one)',
        evidence || '    (no passage in the book argues this theme)',
      ].join('\n');
    }),
  ].join('\n');
}

/**
 * The author's voice as counted off their own posts, not as described.
 *
 * Stated tone words go in too, but second: the drafts are scored against these
 * measurements, so telling the model the numbers is telling it the target.
 */
function voiceBrief(voice, voiceProfile) {
  const stated = `Stated voice: ${JSON.stringify(voiceProfile)}`;
  if (!voice?.enforceable) return stated;

  return [
    stated,
    'Measured from this author\'s own previous posts — match these:',
    `- sentences average ${voice.meanSentenceWords.toFixed(1)} words`,
    `- exclamation marks per 100 words: ${voice.exclamationsPer100.toFixed(2)}`,
    `- marketing/hype words per 100 words: ${voice.hypePer100.toFixed(2)}`,
    `- words in all caps per 100 words: ${voice.shoutedPer100.toFixed(2)}`,
    'Copy that exceeds these rates is rejected before a human sees it.',
  ].join('\n');
}

/**
 * What was fitted to this book (STORY-046): the words it uses for each theme,
 * and the lines that carry each best. The prompt is where a model that cannot
 * be fine-tuned is adapted.
 */
function bookModelBrief(bookModel) {
  const themes = bookModel?.themes?.filter((t) => t.lexicon.length || t.anchorLines?.length) ?? [];
  if (themes.length === 0 && !(bookModel?.preferences?.notes ?? []).length) return '';
  return [
    'Fitted to this book — its own words for each theme, and its strongest lines. Prefer these:',
    ...themes.map((t) => [
      `- ${t.theme}: ${t.lexicon.map((l) => l.word ?? l.term).join(', ') || '(no words learned)'}`,
      ...(t.anchorLines ?? []).map((a) => `    "${a.sentence}"`),
    ].join('\n')),
    `Book style: sentences average ${bookModel.style.meanSentenceWords} words.`,
    // What reviewers have said about earlier drafts (STORY-048).
    ...((bookModel.preferences?.notes ?? []).length
      ? ['Reviewers on earlier drafts of this book:', ...bookModel.preferences.notes.map((n) => `  - (${n.label > 0 ? 'liked' : 'turned down'}) ${n.note}`)]
      : []),
  ].join('\n');
}

function buildPrompt({ book, voiceProfile, voice, grounding, history, platforms, count, bookModel = null, revision = null }) {
  const samples = history
    .slice(0, 8)
    .map((h) => `- (${h.platform}) ${h.content}`)
    .join('\n');

  const brief = groundingBrief(grounding);

  return [
    `You draft social media posts promoting the book "${book.title}".`,
    '',
    `Book themes: ${book.themes.join(', ') || 'unspecified'}`,
    voiceBrief(voice, voiceProfile),
    '',
    samples ? `Previous posts by this author, for voice matching:\n${samples}` : '',
    '',
    brief || `Book excerpt:\n${book.content.slice(0, 4000)}`,
    '',
    bookModelBrief(bookModel),
    '',
    // A reviewer asked for changes (STORY-047): their note, and what they saw.
    revision
      ? `A reviewer asked for changes to an earlier draft.\nTheir note: ${revision.note}\nThe draft they saw:\n  ${revision.previous}\nWrite a new draft that answers the note.`
      : '',
    `Write exactly ${count} posts, distributed across these platforms: ${platforms.join(', ')}.`,
    'Per-platform style:',
    ...platforms.map((p) => `- ${p}: ${PLATFORM_BRIEF[p] ?? 'concise and natural'}`),
    '',
    'Each post makes one theme\'s argument using the book\'s own language for it.',
    'Name only themes you actually write about: a theme you list and do not argue',
    'scores zero, and a theme not in the list above scores zero however well written.',
    'Respond with JSON only, no prose, in exactly this shape:',
    '{"posts":[{"platform":"twitter","content":"...","themesUsed":["..."]}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Models sometimes wrap JSON in prose or fences; recover the object. */
function parsePosts(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Anthropic response contained no JSON object: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed.posts)) {
    throw new Error('Anthropic response JSON has no "posts" array');
  }
  return parsed.posts;
}

/**
 * The meme brief: the formats on offer, what the book argues, and the voice.
 *
 * Claude picks the format that fits each joke and writes the words in the
 * picture — the first version of this filled every format from one fixed
 * phrase per slot, which read like a quote card with a template's name on it.
 */
function buildMemePrompt({ book, voiceProfile, voice, grounding, bookModel = null, memeCount, memeLibrary }) {
  const formats = memeLibrary.map((t) => [
    `- "${t.key}" — ${t.name}. ${t.joke ?? ''}`,
    ...t.captionSlots.map((sl) => `    ${sl.name}: ${sl.role} (at most ${sl.maxChars} characters)`),
  ].join('\n'));

  return [
    `You make memes that promote the book "${book.title}" on social media.`,
    'A good one is funny or painfully relatable to the book\'s readers AND carries one of the book\'s real ideas.',
    'It must be about this book specifically — a reader should be able to tell which book it came from.',
    '',
    `Book themes: ${book.themes.join(', ') || 'unspecified'}`,
    voiceBrief(voice, voiceProfile),
    '',
    groundingBrief(grounding) || `Book excerpt:\n${book.content.slice(0, 4000)}`,
    '',
    bookModelBrief(bookModel),
    '',
    'Meme formats you may use (fill every slot the format lists, short and punchy):',
    ...formats,
    '',
    `Write exactly ${memeCount} meme${memeCount === 1 ? '' : 's'}. Use a different format for each where you can.`,
    'For each: the format key, the one theme it argues (from the themes above), the words for each slot,',
    'a short post to go with the image (1–2 sentences, in the author\'s voice), and alt text describing the',
    'finished image for someone who cannot see it.',
    'No exclamation marks or hype words unless the author\'s own posts use them.',
    'Respond with JSON only, in exactly this shape:',
    '{"memes":[{"format":"meme-expectation-reality","theme":"...","captions":{"expectation":"...","reality":"..."},"post":"...","altText":"..."}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The memes in a reply, checked against the formats that were offered. */
function parseMemes(text, memeLibrary) {
  const raw = (text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Anthropic meme response contained no JSON object: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed.memes)) throw new Error('Anthropic meme response JSON has no "memes" array');

  const byKey = new Map(memeLibrary.map((t) => [t.key, t]));
  return parsed.memes.flatMap((m) => {
    const template = byKey.get(m?.format);
    // A format nobody offered, or a reply with no words for the picture, is dropped.
    if (!template || !m.captions || typeof m.captions !== 'object') return [];
    const captions = {};
    for (const sl of template.captionSlots) {
      const words = String(m.captions[sl.name] ?? '').replace(/\s+/g, ' ').trim();
      if (!words) continue;
      captions[sl.name] = sl.maxChars && words.length > sl.maxChars ? `${words.slice(0, sl.maxChars - 1).trimEnd()}…` : words;
    }
    if (Object.keys(captions).length < template.captionSlots.length) return [];
    return [{ template, theme: String(m.theme ?? ''), captions, post: String(m.post ?? '').trim(), altText: String(m.altText ?? '').trim() }];
  });
}

async function callClaude(operation, prompt, maxTokens) {
  // Through the API Integration Agent (STORY-016): timed out rather than
  // hanging forever, retried on a 429 or a 5xx and not on a 400, and every
  // attempt on the record.
  const body = await callExternal({
    service: 'anthropic',
    operation,
    fn: (signal) =>
      httpJson(apiUrl(), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: config.anthropicModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      }),
  });
  const text = (body.content ?? []).map((part) => (part.type === 'text' || part.type === undefined ? part.text ?? '' : '')).join('');
  if (!text.trim() && body.stop_reason === 'max_tokens') {
    throw new Error(`Claude used its whole reply budget (${maxTokens} tokens) before writing anything — raise ANTHROPIC_MAX_TOKENS`);
  }
  return text;
}

/** Claude's memes, shaped as drafting candidates. */
async function writeMemes({ book, voiceProfile, voice, grounding, bookModel, memeCount, memeLibrary, platforms, visualFirstPlatforms }) {
  const text = await callClaude('social.memes', buildMemePrompt({ book, voiceProfile, voice, grounding, bookModel, memeCount, memeLibrary }), config.anthropicMaxTokens);
  const routes = visualFirstPlatforms.length > 0 ? visualFirstPlatforms : platforms;
  const passagesFor = (theme) => (grounding?.themes ?? []).find((t) => t.theme.toLowerCase() === theme.toLowerCase())?.passages ?? [];

  return parseMemes(text, memeLibrary).slice(0, memeCount).map((m, i) => {
    const theme = book.themes.find((t) => t.toLowerCase() === m.theme.toLowerCase()) ?? m.theme;
    const panels = m.template.captionSlots.map((sl) => m.captions[sl.name]).filter(Boolean);
    return {
      format: 'meme',
      platform: routes[i % routes.length],
      content: m.post || panels.join(' '),
      themesUsed: theme ? [theme] : [],
      groundedIn: passagesFor(theme).map((p) => p.id),
      template: m.template,
      captions: m.captions,
      panels,
      altText: m.altText || `${m.template.name} meme: ${panels.join(' — ')}`,
      chosenBy: 'writer',
      writtenBy: 'anthropic',
    };
  });
}

export { buildMemePrompt, buildPrompt, parseMemes, parsePosts };

export const anthropicProvider = {
  name: 'anthropic',

  async generateCandidates({
    book, voiceProfile, voice, grounding, history, platforms, count, bookModel = null, revision = null,
    memeCount = 0, memeTemplates = [], memeLibrary = [], visualFirstPlatforms = [], weekOf,
  }) {
    if (!config.anthropicApiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }

    const text = await callClaude(
      'social.generate',
      buildPrompt({ book, voiceProfile, voice, grounding, history, platforms, count, bookModel, revision }),
      config.anthropicMaxTokens,
    );
    const posts = parsePosts(text)
      .filter((post) => post && typeof post.content === 'string')
      .map((post) => ({
        platform: platforms.includes(post.platform) ? post.platform : platforms[0],
        content: post.content,
        themesUsed: Array.isArray(post.themesUsed) ? post.themesUsed : [],
      }));

    // A revision rewrites one text post; memes are a batch's business.
    if (revision || memeCount <= 0) return posts;

    // Memes are written by Claude from the formats on offer. If that call fails
    // or returns fewer than asked, the gap is filled by the offline writer so
    // the batch still carries its memes — marked as such on each draft.
    let memes = [];
    if (memeLibrary.length > 0) {
      try {
        memes = await writeMemes({ book, voiceProfile, voice, grounding, bookModel, memeCount, memeLibrary, platforms, visualFirstPlatforms });
      } catch (error) {
        console.warn(`[anthropic] memes fell back to the offline writer: ${error.message}`);
      }
    }
    if (memes.length < memeCount && memeTemplates.length > 0) {
      const filler = await stubProvider.generateCandidates({
        book, voiceProfile, voice, grounding, history, platforms, count: 0, weekOf,
        memeCount: memeCount - memes.length,
        memeTemplates: memeTemplates.slice(memes.length),
        visualFirstPlatforms,
      });
      memes = memes.concat(filler.filter((c) => c.format === 'meme').map((c) => ({ ...c, writtenBy: 'stub (fallback)' })));
    }
    return posts.concat(memes);
  },
};
