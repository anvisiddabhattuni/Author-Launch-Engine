import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

const ASK = {
  podcast: 'ask to appear as a guest on the show',
  speaking: 'propose a talk for the programme',
  event: 'ask to take part in the event',
};

function buildPrompt({ opportunity, book, author }) {
  return [
    `Write one outreach email from the author ${author.name} promoting the book "${book.title}".`,
    '',
    `Opportunity type: ${opportunity.type}`,
    `Name: ${opportunity.name}`,
    `Host / contact: ${opportunity.host || 'unknown'}`,
    `Their description: ${opportunity.description}`,
    `Their topics: ${opportunity.topics.join(', ')}`,
    `Overlapping book themes: ${opportunity.matched_themes.join(', ') || 'none recorded'}`,
    '',
    `Book themes: ${book.themes.join(', ')}`,
    `Author voice: ${JSON.stringify(author.voice_profile)}`,
    `Book excerpt:\n${book.content.slice(0, 2500)}`,
    '',
    `The email should ${ASK[opportunity.type] ?? ASK.event}.`,
    'It must name the opportunity and the host explicitly, reference at least one overlapping',
    'theme, stay under 1200 characters, and sound like the author rather than a marketer.',
    'No exclamation marks, no hype.',
    '',
    'Respond with JSON only, no prose, in exactly this shape:',
    '{"subject":"...","body":"...","personalization":["..."]}',
  ].join('\n');
}

function parseMessage(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Anthropic response contained no JSON object: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!parsed.subject || !parsed.body) {
    throw new Error('Anthropic response JSON is missing "subject" or "body"');
  }
  return parsed;
}

export const outreachAnthropicProvider = {
  name: 'anthropic',

  async draftMessage({ opportunity, book, author }) {
    if (!config.anthropicApiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }

    // Through the API Integration Agent (STORY-016): timed out rather than
    // hanging forever, retried on a 429 or a 5xx and not on a 400, and every
    // attempt on the record. This is the one adapter that makes a real
    // network call, so it is the one where a bare fetch was a live hazard.
    const body = await callExternal({
      service: 'anthropic',
      operation: 'outreach.generate',
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
                  max_tokens: config.anthropicMaxTokens,
                  messages: [{ role: 'user', content: buildPrompt({ opportunity, book, author }) }],
                }),
        }),
    });
    const text = (body.content ?? []).map((part) => part.text ?? '').join('');
    const message = parseMessage(text);

    return {
      subject: message.subject,
      body: message.body,
      personalization: Array.isArray(message.personalization) ? message.personalization : [],
    };
  },
};
