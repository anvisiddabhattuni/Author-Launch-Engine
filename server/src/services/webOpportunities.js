/**
 * Opportunities found on the open web, by Claude with its web search tool.
 *
 * The directories in directories.js are a fixed, made-up catalogue: useful for
 * the demo and the tests, useless to a real author. This asks Claude to search
 * the web for podcasts, speaking slots and events that fit the book, and to
 * return each with the page it came from.
 *
 * What comes back is checked, not trusted:
 *   - every listing must point at a site the search actually returned, so a
 *     podcast Claude half-remembers and a URL it guessed are both dropped;
 *   - a contact email is kept only when Claude says it read it on the page,
 *     and nothing is ever emailed without a person approving the pitch;
 *   - relevance is scored afterwards by the same scorer as every other source
 *     (opportunityScoutingAgent.js), not taken from Claude's opinion.
 *
 * Billed per search (Anthropic web search) plus tokens; `maxSearches` bounds it.
 */
import { createHash } from 'node:crypto';

import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';

export const SOURCE = 'web';

const TYPE_WORDS = {
  podcast: 'podcasts that interview authors and accept guest pitches',
  speaking: 'conferences, festivals and organisations booking speakers or calling for talks',
  event: 'events, festivals, workshops and author nights that feature authors',
};

/** The brief: what the book is about and what to look for. */
export function buildSearchPrompt({ book, types, expertise = null, from = new Date(), maxResults = 10 }) {
  const today = from.toISOString().slice(0, 10);
  return [
    `Search the web for real opportunities for the author of the book "${book.title}" to reach new readers.`,
    `The book's themes: ${(book.themes ?? []).join(', ') || 'unspecified'}.`,
    expertise?.themes?.length ? `The author can speak credibly about: ${expertise.themes.slice(0, 8).join(', ')}.` : '',
    '',
    'Look for:',
    ...types.map((t) => `- ${TYPE_WORDS[t] ?? t}`),
    '',
    `Today is ${today}. Prefer ones that are active now: a podcast still releasing episodes, an event or call for speakers that has not closed.`,
    'Only include opportunities you found on a page in your search results. Do not invent any.',
    'Only give a contact email if you saw it written on the page; otherwise use null.',
    `Return at most ${maxResults}, best fits first, as JSON only, in exactly this shape:`,
    '{"opportunities":[{"type":"podcast|speaking|event","name":"...","host":"who runs it, or null",' +
      '"url":"the page you found it on","contactEmail":null,"description":"one or two sentences: what it is and who it reaches",' +
      '"topics":["subjects it covers"],"audienceSize":null,"deadline":"YYYY-MM-DD or null"}]}',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const hostOf = (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Every site the search really returned — the only places a listing may come from. */
export function searchedHosts(content = []) {
  const hosts = new Set();
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      const h = hostOf(r.url);
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The listings in Claude's reply, in the shape every directory returns, keeping
 * only those that point at a site the search found.
 */
export function parseListings({ content = [], types, from = new Date(), maxResults = 10 }) {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Web search reply contained no JSON object: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed.opportunities)) throw new Error('Web search reply JSON has no "opportunities" array');

  const allowed = searchedHosts(content);
  const wanted = new Set(types);
  const today = from.toISOString().slice(0, 10);
  const seen = new Set();
  const listings = [];
  const dropped = [];

  for (const o of parsed.opportunities) {
    const url = String(o?.url ?? '').trim();
    const host = hostOf(url);
    const name = String(o?.name ?? '').trim();
    if (!name || !host) { dropped.push({ name, reason: 'no usable link' }); continue; }
    // A site the search never returned is a guess, however plausible.
    if (![...allowed].some((a) => host === a || host.endsWith(`.${a}`) || a.endsWith(`.${host}`))) {
      dropped.push({ name, reason: `not from a searched page (${host})` });
      continue;
    }
    const type = wanted.has(o.type) ? o.type : null;
    if (!type) { dropped.push({ name, reason: `type "${o.type}" was not asked for` }); continue; }
    const key = url.toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(o.deadline ?? '') && o.deadline >= today ? o.deadline : null;
    const email = String(o.contactEmail ?? '').trim();
    listings.push({
      source: SOURCE,
      externalId: `web:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      type,
      name: name.slice(0, 200),
      host: String(o.host ?? '').trim().slice(0, 200),
      // Blank when none was seen: the sender refuses to email a blank address,
      // and the page says to get in touch through the website instead.
      contactEmail: EMAIL.test(email) ? email : '',
      url,
      description: String(o.description ?? '').trim().slice(0, 1000),
      topics: (Array.isArray(o.topics) ? o.topics : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10),
      audienceSize: Number.isInteger(o.audienceSize) && o.audienceSize > 0 ? o.audienceSize : null,
      deadline,
    });
    if (listings.length >= maxResults) break;
  }
  return { listings, dropped };
}

/** One search, through the gateway. Returns listings in the directories' shape. */
export async function searchWeb({ book, types, expertise = null, from = new Date(), authorId = null, maxSearches = config.webSearchMaxUses }) {
  if (!config.anthropicApiKey) throw new Error('Web search needs ANTHROPIC_API_KEY');
  const body = await callExternal({
    service: 'anthropic',
    operation: 'opportunities.search',
    authorId,
    fn: (signal) =>
      httpJson(`${config.anthropicBaseUrl}/v1/messages`, {
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
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
          messages: [{ role: 'user', content: buildSearchPrompt({ book, types, expertise, from }) }],
        }),
      }),
  });
  const { listings, dropped } = parseListings({ content: body.content ?? [], types, from });
  return { listings, dropped, searches: body.usage?.server_tool_use?.web_search_requests ?? null };
}
