/**
 * Opportunities found on the web by Claude's web search.
 *
 * Measured before: every opportunity came from a fixed, made-up catalogue
 * (directories.js) — "The Long Game" podcast, booking@thelonggame.test.
 *
 *   Given a book with themes and Claude configured,
 *   when the author searches for opportunities,
 *   then Claude searches the web and each listing it returns is kept only if
 *   it points at a page the search actually found, then scored and stored
 *   like any other opportunity — and what was thrown away is on the record.
 *
 * Claude is played by a local HTTP server speaking the Messages API, including
 * the web search tool's result blocks; only the far end is ours.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { scoutOpportunities } from '../src/agents/opportunityScoutingAgent.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { buildSearchPrompt, parseListings, searchedHosts } from '../src/services/webOpportunities.js';

const stamp = Date.now();
const FROM = new Date('2026-10-06T12:00:00Z');

const searchBlocks = [
  { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'deep work podcast guest authors' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srv_1',
    content: [
      { type: 'web_search_result', url: 'https://www.quietcraftcast.example/guests', title: 'Be a guest' },
      { type: 'web_search_result', url: 'https://festival.example.org/call-for-speakers', title: 'Call for speakers' },
    ],
  },
];
const reply = (opportunities) => [
  ...searchBlocks,
  { type: 'text', text: `Here is what I found:\n\`\`\`json\n${JSON.stringify({ opportunities })}\n\`\`\`` },
];
const REAL = {
  type: 'podcast',
  name: `Quiet Craft Cast ${stamp}`,
  host: 'Sam Rivera',
  url: 'https://quietcraftcast.example/guests',
  contactEmail: 'guests@quietcraftcast.example',
  description: 'A weekly podcast interviewing writers about deep work, craft and attention.',
  topics: ['Deep Work', 'craft', 'attention'],
  audienceSize: 12000,
  deadline: null,
};
const SPEAKING = {
  type: 'speaking',
  name: `Slow Ideas Festival ${stamp}`,
  host: null,
  url: 'https://festival.example.org/call-for-speakers',
  contactEmail: 'see the form on the page',
  description: 'A festival on craft, attention and deep work, now taking speaker proposals.',
  topics: ['craft', 'attention'],
  audienceSize: null,
  deadline: '2026-11-30',
};
const INVENTED = {
  type: 'podcast',
  name: 'A Podcast Claude Half-Remembers',
  url: 'https://made-up-podcast.example/apply',
  contactEmail: 'hi@made-up-podcast.example',
  description: 'Deep work and craft.',
  topics: ['craft'],
};

describe('what is kept from a web search', () => {
  it('knows which sites the search returned', () => {
    assert.deepEqual([...searchedHosts(searchBlocks)].sort(), ['festival.example.org', 'quietcraftcast.example']);
  });

  it('keeps listings from searched pages, and drops one the search never returned', () => {
    const { listings, dropped } = parseListings({ content: reply([REAL, SPEAKING, INVENTED]), types: ['podcast', 'speaking'], from: FROM });
    assert.deepEqual(listings.map((l) => l.name), [REAL.name, SPEAKING.name]);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /not from a searched page \(made-up-podcast\.example\)/);
  });

  it('shapes each like any directory listing: web source, stable id, clean fields', () => {
    const [podcast, talk] = parseListings({ content: reply([REAL, SPEAKING]), types: ['podcast', 'speaking'], from: FROM }).listings;
    assert.equal(podcast.source, 'web');
    assert.match(podcast.externalId, /^web:[0-9a-f]{16}$/);
    assert.deepEqual(podcast.topics, ['deep work', 'craft', 'attention']);
    assert.equal(podcast.contactEmail, 'guests@quietcraftcast.example');
    assert.equal(talk.contactEmail, '', 'text that is not an email address is not kept as one');
    assert.equal(talk.host, '');
    assert.equal(talk.deadline, '2026-11-30');
    // Same page, same id — so searching again next week does not duplicate it.
    const again = parseListings({ content: reply([REAL]), types: ['podcast'], from: FROM }).listings[0];
    assert.equal(again.externalId, podcast.externalId);
  });

  it('drops a kind that was not asked for, and a deadline already past', () => {
    const { listings, dropped } = parseListings({
      content: reply([REAL, { ...SPEAKING, deadline: '2026-01-01' }]),
      types: ['speaking'],
      from: FROM,
    });
    assert.equal(listings.length, 1);
    assert.equal(listings[0].deadline, null);
    assert.match(dropped[0].reason, /type "podcast" was not asked for/);
  });

  it('asks for the book’s themes, the kinds wanted, and no invented listings', () => {
    const prompt = buildSearchPrompt({ book: { title: 'The Quiet Craft', themes: ['craft', 'attention'] }, types: ['podcast'], from: FROM });
    assert.match(prompt, /The Quiet Craft/);
    assert.match(prompt, /craft, attention/);
    assert.match(prompt, /podcasts that interview authors/);
    assert.ok(!/conferences/.test(prompt), 'only the kinds asked for');
    assert.match(prompt, /Do not invent any/);
  });
});

describe('searching for opportunities with Claude', () => {
  let fake;
  let authorId;
  let bookId;
  const received = [];
  const saved = { key: config.anthropicApiKey, url: config.anthropicBaseUrl, sources: config.opportunitySources };

  before(async () => {
    fake = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      received.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${stamp}`, type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: reply([REAL, SPEAKING, INVENTED]),
        usage: { input_tokens: 900, output_tokens: 400, server_tool_use: { web_search_requests: 3 } },
      }));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    config.anthropicBaseUrl = `http://127.0.0.1:${fake.address().port}`;
    config.anthropicApiKey = 'sk-ant-test-not-a-real-key';
    config.opportunitySources = 'web';
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'anthropic'");

    const { rows: [a] } = await query(
      'INSERT INTO authors (name, email) VALUES ($1,$2) RETURNING id',
      [`Web Search Author ${stamp}`, `web-${stamp}@example.test`],
    );
    authorId = a.id;
    const { rows: [b] } = await query(
      `INSERT INTO books (author_id, title, content, themes) VALUES ($1, 'The Quiet Craft',
        'Craft is slow and quiet. Deep work is a refusal of interruption. Attention is a muscle.', '{deep work,craft,attention}') RETURNING id`,
      [authorId],
    );
    bookId = b.id;
  });

  after(async () => {
    Object.assign(config, { anthropicApiKey: saved.key, anthropicBaseUrl: saved.url, opportunitySources: saved.sources });
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'anthropic'");
    for (let attempt = 1; ; attempt += 1) {
      try { await query('DELETE FROM authors WHERE id = $1', [authorId]); break; } catch (e) {
        if (e.code !== '40P01' || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
    await new Promise((r) => fake.close(r));
    await closePool();
  });

  it('asks Claude with the web search tool, bounded, with the key only in the header', async () => {
    await scoutOpportunities({ authorId, bookId, from: FROM });
    const [call] = received;
    assert.equal(call.tools[0].type, 'web_search_20250305');
    assert.equal(call.tools[0].max_uses, config.webSearchMaxUses);
    assert.match(call.messages[0].content, /The Quiet Craft/);
    assert.ok(!JSON.stringify(call).includes('sk-ant-test'));
  });

  it('stores what the web search found, scored like any other source — and not the invented one', async () => {
    const { rows } = await query('SELECT * FROM opportunities WHERE author_id = $1 ORDER BY name', [authorId]);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes(REAL.name), names.join(', '));
    assert.ok(!names.includes(INVENTED.name), 'a listing from a page the search never returned is never stored');
    const podcast = rows.find((r) => r.name === REAL.name);
    assert.equal(podcast.source, 'web');
    assert.equal(podcast.url, REAL.url);
    assert.ok(Number(podcast.relevance) > 0, 'scored against the book');
  });

  it('puts the search and what it threw away on the record', async () => {
    const { rows: [log] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'opportunity.web_searched' AND author_id = $1 ORDER BY id DESC LIMIT 1",
      [authorId],
    );
    assert.equal(log.metadata.searches, 3);
    assert.equal(log.metadata.found, 2);
    assert.equal(log.metadata.dropped[0].name, INVENTED.name);
  });

  it('does not duplicate what it already found when searching again', async () => {
    await scoutOpportunities({ authorId, bookId, from: FROM });
    const { rows } = await query('SELECT count(*)::int AS n FROM opportunities WHERE author_id = $1 AND name = $2', [authorId, REAL.name]);
    assert.equal(rows[0].n, 1);
  });
});
