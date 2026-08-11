import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

const PLATFORM_BRIEF = {
  twitter: 'under 280 characters, punchy, at most one hashtag',
  instagram: 'warm and visual, 2-3 short paragraphs, 3-5 hashtags at the end',
  facebook: 'conversational, 2-3 sentences, no hashtags, invites replies',
  linkedin: 'professional but personal, a concrete takeaway, no hashtags',
};

function buildPrompt({ book, voiceProfile, history, platforms, count }) {
  const samples = history
    .slice(0, 8)
    .map((h) => `- (${h.platform}) ${h.content}`)
    .join('\n');

  return [
    `You draft social media posts promoting the book "${book.title}".`,
    '',
    `Book themes: ${book.themes.join(', ') || 'unspecified'}`,
    `Author voice: ${JSON.stringify(voiceProfile)}`,
    '',
    samples ? `Previous posts by this author, for voice matching:\n${samples}` : '',
    '',
    `Book excerpt:\n${book.content.slice(0, 4000)}`,
    '',
    `Write exactly ${count} posts, distributed across these platforms: ${platforms.join(', ')}.`,
    'Per-platform style:',
    ...platforms.map((p) => `- ${p}: ${PLATFORM_BRIEF[p] ?? 'concise and natural'}`),
    '',
    'Every post must be grounded in the book themes above and must sound like the author.',
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

  async generateCandidates({ book, voiceProfile, history, platforms, count }) {
    if (!config.anthropicApiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 2000,
        messages: [
          { role: 'user', content: buildPrompt({ book, voiceProfile, history, platforms, count }) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
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
