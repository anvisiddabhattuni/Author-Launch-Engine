/**
 * STORY-035 acceptance tests — OpenAI for content generation.
 *
 *   Given an author has provided book themes and prior approved posts,
 *   when the AI Content Generation Agent requests content generation,
 *   then the system retrieves creative, contextually relevant content from OpenAI.
 *
 *   Given the OpenAI API is temporarily unavailable,
 *   when the agent requests content generation,
 *   then the system logs the error and retries the request after a delay.
 *
 * Measured before: no OpenAI adapter existed; AI_PROVIDER took `stub` or
 * `anthropic` only.
 *
 * "Test mode": OpenAI is played by a local HTTP server speaking its chat
 * completions API, so the real adapter, the real gateway and the real retries
 * run — only the far end is ours. With a real OPENAI_API_KEY and no
 * OPENAI_BASE_URL, the same code talks to OpenAI.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';

const stamp = Date.now();
let fake;
let authorId;
let bookId;
const saved = { key: config.openaiApiKey, url: config.openaiBaseUrl };

// The stand-in: records every request; answers with whatever `script` says next.
const received = [];
let script = [];
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const posts = (n) => ({
  id: `chatcmpl-test-${stamp}`,
  model: 'gpt-test',
  usage: { prompt_tokens: 900, completion_tokens: 120 },
  choices: [{
    message: {
      content: JSON.stringify({
        posts: Array.from({ length: n }, (_, i) => ({
          platform: 'twitter',
          content: `Craft is slow on purpose (${i}): the quiet hours are where the work gets good.`,
          themesUsed: ['craft'],
        })),
      }),
    },
  }],
});

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    const next = script.shift() ?? { status: 200, body: posts(3) };
    reply(res, next.status, next.body);
  });
  await new Promise((r) => fake.listen(0, r));
  config.openaiBaseUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  config.openaiApiKey = 'sk-test-not-a-real-key';

  const { rows: [a] } = await query(
    'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING id',
    [`OpenAI Author ${stamp}`, `openai-${stamp}@example.test`, JSON.stringify({ tone: ['plain'] })],
  );
  authorId = a.id;
  const { rows: [b] } = await query(
    `INSERT INTO books (author_id, title, content, themes) VALUES ($1, 'The Quiet Craft',
      'Craft is slow and quiet. The quiet hours are where the work gets good. Attention is a muscle.', '{craft,attention}') RETURNING id`,
    [authorId],
  );
  bookId = b.id;
  // A post a person approved before: the story's "prior approved posts".
  await query(
    `INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
     VALUES ($1,$2,'linkedin','An approved post about slow craft, from last month.','approved',0.9,CURRENT_DATE)`,
    [authorId, bookId],
  );
  await ownerQuery("DELETE FROM integration_circuits WHERE service = 'openai'");
});

beforeEach(() => { received.length = 0; script = []; });

after(async () => {
  config.openaiApiKey = saved.key;
  config.openaiBaseUrl = saved.url;
  await ownerQuery("DELETE FROM integration_circuits WHERE service = 'openai'");
  await query('DELETE FROM authors WHERE id = $1', [authorId]);
  await new Promise((r) => fake.close(r));
  await closePool();
});

describe('STORY-035: content generation via OpenAI', () => {
  it('sends the book\'s themes, prior posts and the approved posts, with the key only in the header', async () => {
    await draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 });
    assert.equal(received.length, 1);
    const [call] = received;
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.auth, 'Bearer sk-test-not-a-real-key');
    const prompt = call.body.messages.map((m) => m.content).join('\n');
    assert.match(prompt, /craft/);
    assert.match(prompt, /An approved post about slow craft/, 'the approved posts are part of the request');
    assert.ok(!prompt.includes('sk-test'), 'the key is never in the prompt');
  });

  it('stores what comes back as drafts held for a person — nothing is published', async () => {
    const drafts = await draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 });
    assert.equal(drafts.length, 3);
    for (const d of drafts) {
      assert.equal(d.provider, 'openai');
      assert.ok(['pending_approval', 'escalated'].includes(d.status), d.status);
    }
  });

  it('records each request and response on the audit log — digests and sizes, not the key', async () => {
    await draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 });
    const { rows: [log] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'ai.generation' AND author_id = $1 ORDER BY id DESC LIMIT 1", [authorId],
    );
    assert.equal(log.metadata.provider, 'openai');
    assert.match(log.metadata.requestSha256, /^[0-9a-f]{64}$/);
    assert.match(log.metadata.responseSha256, /^[0-9a-f]{64}$/);
    assert.equal(log.metadata.candidates, 3);
    assert.equal(log.metadata.approvedExamples >= 1, true);
    assert.ok(!JSON.stringify(log.metadata).includes('sk-test'));
  });
});

describe('STORY-035: OpenAI temporarily unavailable', () => {
  it('logs the error and retries after a delay, then succeeds', async () => {
    script = [{ status: 503, body: { error: { message: 'overloaded' } } }];
    const started = Date.now();
    const drafts = await draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 });
    const took = Date.now() - started;
    assert.equal(drafts.length, 3);
    assert.equal(received.length, 2, 'one failure, one retry');
    assert.ok(took >= 1500, `retried after a delay, not at once (${took} ms)`);
    const { rows } = await ownerQuery(
      "SELECT attempt, outcome, error FROM api_interactions WHERE service = 'openai' ORDER BY id DESC LIMIT 2",
    );
    const [ok, failed] = rows;
    assert.equal(failed.outcome, 'retrying');
    assert.match(failed.error, /503/);
    assert.equal(ok.outcome, 'ok');
    assert.equal(ok.attempt, 2);
  });

  it('a request OpenAI rejects as malformed is not retried — it would fail the same way', async () => {
    script = [{ status: 400, body: { error: { message: 'bad request' } } }];
    await assert.rejects(draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai', memeCount: 0 }), /400/);
    assert.equal(received.length, 1);
  });

  it('without a key it refuses plainly, before any call', async () => {
    config.openaiApiKey = '';
    try {
      await assert.rejects(draftWeeklyPosts({ authorId, bookId, count: 3, platforms: ['twitter'], providerName: 'openai' }), /OPENAI_API_KEY/);
      assert.equal(received.length, 0);
    } finally {
      config.openaiApiKey = 'sk-test-not-a-real-key';
    }
  });
});
