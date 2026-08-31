import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

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
      const evidence = t.passages.map((p) => `    > ${p.content}`).join('\n');
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

function buildPrompt({ book, voiceProfile, voice, grounding, history, platforms, count }) {
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

export const anthropicProvider = {
  name: 'anthropic',

  async generateCandidates({ book, voiceProfile, voice, grounding, history, platforms, count }) {
    if (!config.anthropicApiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }

    // Through the API Integration Agent (STORY-016): timed out rather than
    // hanging forever, retried on a 429 or a 5xx and not on a 400, and every
    // attempt on the record. This is the one adapter that makes a real
    // network call, so it is the one where a bare fetch was a live hazard.
    const body = await callExternal({
      service: 'anthropic',
      operation: 'social.generate',
      fn: (signal) =>
        httpJson(API_URL, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.anthropicApiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
                  model: config.anthropicModel,
                  max_tokens: 2000,
                  messages: [
                    {
                      role: 'user',
                      content: buildPrompt({ book, voiceProfile, voice, grounding, history, platforms, count }),
                    },
                  ],
                }),
        }),
    });
    const text = (body.content ?? []).map((part) => part.text ?? '').join('');

    return parsePosts(text)
      .filter((post) => post && typeof post.content === 'string')
      .map((post) => ({
        platform: platforms.includes(post.platform) ? post.platform : platforms[0],
        content: post.content,
        themesUsed: Array.isArray(post.themesUsed) ? post.themesUsed : [],
      }));
  },
};
