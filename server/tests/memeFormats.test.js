/**
 * Memes written by Claude, about the book, in real meme formats.
 *
 * Measured before: with AI_PROVIDER=anthropic no meme was written at all — the
 * Claude adapter wrote text posts only. Offline, every meme came from one fixed
 * phrase per slot ("What everyone thinks craft is") on a coloured card.
 *
 *   Given a book with themes and an author's voice,
 *   when a weekly batch is drafted with Claude,
 *   then Claude picks a meme format for each meme and writes its words from the
 *   book's argument, and the picture is drawn in the book's own colours.
 *
 * Claude is played by a local HTTP server speaking the Messages API, so the
 * real adapter, gateway and drafting agent all run; only the far end is ours.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { buildMemePrompt, parseMemes } from '../src/ai/anthropicProvider.js';
import { draftWeeklyPosts } from '../src/agents/contentDraftingAgent.js';
import { config } from '../src/config.js';
import { MEME_FORMATS, SWATCH } from '../src/db/memeFormats.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { assessTemplate, composeFromTemplate, getTemplate, jokeFor, selectTemplate, themedArtwork } from '../src/services/memeLibrary.js';
import { scoreIdentity } from '../src/services/visualIdentity.js';

const stamp = Date.now();
const svgText = (ref) => Buffer.from(String(ref).split(',')[1], 'base64').toString('utf8');
const DARK = { palette: { ground: '#120f05', ink: '#f3f3f3', accent: '#dd9645', mode: 'dark', tolerance: 60 }, doNotUse: [] };
const LIGHT = { palette: { ground: '#f3efe6', ink: '#1b1a17', accent: '#2f6f9f', mode: 'light', tolerance: 60 }, doNotUse: [] };

describe('meme formats: drawn in-house, coloured per book', () => {
  it('are all licensed for use, and each says how its joke works', () => {
    for (const f of MEME_FORMATS) {
      assert.equal(assessTemplate({ ...f, active: true }).usable, true, f.key);
      assert.ok(f.joke.length > 20, `${f.key} has no description of its joke`);
      assert.ok(f.caption_slots.length >= 1);
    }
  });

  it('are drawn in the book’s colours, light or dark, so the identity check passes', () => {
    for (const identity of [DARK, LIGHT]) {
      for (const f of MEME_FORMATS) {
        const themed = themedArtwork(f.image_ref, identity);
        const text = svgText(themed).toLowerCase();
        for (const placeholder of Object.values(SWATCH)) {
          assert.ok(!text.includes(placeholder), `${f.key} still has placeholder ${placeholder}`);
        }
        assert.equal(scoreIdentity({ imageRef: themed, identity }).score, 1, `${f.key} off-identity in ${identity.palette.mode}`);
      }
    }
  });

  it('draws the words bold, like a meme, in the book’s ink', async () => {
    const template = await getTemplate('meme-expectation-reality');
    const image = svgText(composeFromTemplate({
      template,
      captions: { expectation: 'One quiet weekend of writing', reality: 'Attention is a muscle' },
      identity: LIGHT,
    }));
    assert.match(image, /font-weight="700"/);
    assert.match(image, /Attention is a muscle/);
    assert.match(image, new RegExp(`fill="${LIGHT.palette.ink}"`));
  });

  it('are chosen before the older quote cards', async () => {
    for (let seed = 0; seed < 6; seed += 1) {
      const { template } = await selectTemplate({ seed, identity: DARK });
      assert.match(template.key, /^meme-/, `seed ${seed} picked ${template.key}`);
    }
  });
});

describe('the brief Claude gets, and what is kept from its reply', () => {
  const library = MEME_FORMATS.map((f) => ({ key: f.key, name: f.name, captionSlots: f.caption_slots, joke: f.joke }));
  const book = { title: 'The Quiet Craft', themes: ['craft', 'attention'], content: '' };
  const grounding = { themes: [{ theme: 'craft', keyMessage: 'Craft is slow on purpose.', passages: [{ id: 1, content: 'The quiet hours are where the work gets good.' }] }] };

  it('names every format, its slots and limits, and what the book argues', () => {
    const prompt = buildMemePrompt({ book, voiceProfile: {}, voice: null, grounding, memeCount: 2, memeLibrary: library });
    assert.match(prompt, /The Quiet Craft/);
    assert.match(prompt, /meme-two-buttons/);
    assert.match(prompt, /option_a: the first tempting choice \(at most 50 characters\)/);
    assert.match(prompt, /Craft is slow on purpose\./);
    assert.match(prompt, /Write exactly 2 memes/);
  });

  it('keeps offered formats with every slot filled, and trims words to fit', () => {
    const reply = JSON.stringify({
      memes: [
        { format: 'meme-nah-yeah', theme: 'craft', captions: { nah: 'Rushing the draft', yeah: 'x'.repeat(200) }, post: 'Slow is the point.' },
        { format: 'a-format-nobody-offered', theme: 'craft', captions: { top: 'hi' } },
        { format: 'meme-two-buttons', theme: 'craft', captions: { option_a: 'Ship it' } },
      ],
    });
    const memes = parseMemes(`Here you go:\n\`\`\`json\n${reply}\n\`\`\``, library);
    assert.equal(memes.length, 1, 'an unknown format and a half-filled one are dropped');
    assert.equal(memes[0].template.key, 'meme-nah-yeah');
    assert.equal(memes[0].captions.yeah.length, 80);
    assert.ok(memes[0].captions.yeah.endsWith('…'));
  });

  it('knows each format’s joke', () => {
    assert.match(jokeFor({ key: 'meme-starter-pack' }), /starter|four/i);
    assert.equal(jokeFor({ key: 'quote-card' }), null);
  });
});

describe('a weekly batch drafted with Claude', () => {
  let fake;
  let authorId;
  let bookId;
  let memeReply = null;
  const received = [];
  const saved = { key: config.anthropicApiKey, url: config.anthropicBaseUrl };

  const answer = (text) => ({ id: `msg_${stamp}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
  const goodMemes = () => JSON.stringify({
    memes: [
      {
        format: 'meme-expectation-reality',
        theme: 'craft',
        captions: { expectation: 'Finishing the novel in one inspired weekend', reality: 'Three quiet years of showing up to the desk' },
        post: 'The quiet hours are where the work gets good.',
        altText: 'Expectation: one inspired weekend. Reality: three quiet years at the desk.',
      },
      {
        format: 'meme-starter-pack',
        theme: 'attention',
        captions: { title: 'The deep work starter pack', item1: 'Phone in another room', item2: 'One open tab', item3: 'Cold tea', item4: 'The same chapter, again' },
        post: 'Attention is a muscle, and this is the gym.',
        altText: 'A starter pack: phone in another room, one tab, cold tea, the same chapter again.',
      },
    ],
  });

  before(async () => {
    fake = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages?.[0]?.content ?? '';
      received.push({ path: req.url, key: req.headers['x-api-key'], prompt });
      const isMemes = prompt.startsWith('You make memes');
      const count = Number(prompt.match(/Write exactly (\d+) posts/)?.[1] ?? 2);
      const text = isMemes
        ? (memeReply ?? goodMemes())
        : JSON.stringify({ posts: Array.from({ length: count }, (_, i) => ({ platform: 'linkedin', content: `Craft is slow on purpose (${i}). The quiet hours are where the work gets good.`, themesUsed: ['craft'] })) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(text)));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    config.anthropicBaseUrl = `http://127.0.0.1:${fake.address().port}`;
    config.anthropicApiKey = 'sk-ant-test-not-a-real-key';
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'anthropic'");

    const { rows: [a] } = await query(
      'INSERT INTO authors (name, email, voice_profile) VALUES ($1,$2,$3) RETURNING id',
      [`Meme Author ${stamp}`, `memes-${stamp}@example.test`, JSON.stringify({ tone: ['plain'] })],
    );
    authorId = a.id;
    const { rows: [b] } = await query(
      `INSERT INTO books (author_id, title, content, themes) VALUES ($1, 'The Quiet Craft',
        'Craft is slow and quiet. The quiet hours are where the work gets good. Attention is a muscle.', '{craft,attention}') RETURNING id`,
      [authorId],
    );
    bookId = b.id;
  });

  beforeEach(() => { received.length = 0; memeReply = null; });

  after(async () => {
    config.anthropicApiKey = saved.key;
    config.anthropicBaseUrl = saved.url;
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'anthropic'");
    await query('DELETE FROM authors WHERE id = $1', [authorId]);
    await new Promise((r) => fake.close(r));
    await closePool();
  });

  it('asks Claude for the memes separately, offering only the meme formats', async () => {
    await draftWeeklyPosts({ authorId, bookId, count: 2, platforms: ['twitter', 'linkedin'], providerName: 'anthropic', memeCount: 2 });
    assert.equal(received.length, 2, 'one call for the posts, one for the memes');
    const memeCall = received.find((r) => r.prompt.startsWith('You make memes'));
    assert.ok(memeCall, 'no meme request was made');
    assert.equal(memeCall.path, '/v1/messages');
    assert.match(memeCall.prompt, /meme-expectation-reality/);
    assert.ok(!memeCall.prompt.includes('quote-card'), 'the older quote cards are not offered as memes');
    assert.ok(!memeCall.prompt.includes('sk-ant-test'), 'the key is never in the prompt');
  });

  it('stores Claude’s memes as drafts, drawn in the book’s colours, held for a person', async () => {
    const drafts = await draftWeeklyPosts({ authorId, bookId, count: 2, platforms: ['twitter', 'linkedin'], providerName: 'anthropic', memeCount: 2 });
    const memes = drafts.filter((d) => d.format === 'meme');
    assert.equal(memes.length, 2);
    const byTemplate = Object.fromEntries(memes.map((m) => [m.media.template, m]));
    const er = byTemplate['meme-expectation-reality'];
    assert.ok(er, 'the format Claude chose is the one drawn');
    assert.equal(er.content, 'The quiet hours are where the work gets good.');
    assert.equal(er.media.provenance.writer, 'anthropic');
    assert.equal(er.media.altText, 'Expectation vs reality meme. expectation: Finishing the novel in one inspired weekend. reality: Three quiet years of showing up to the desk', 'describes what is drawn, nothing imagined');
    assert.match(svgText(er.media.imageRef), /Three quiet years of showing/);
    assert.match(svgText(er.media.imageRef), /up to the desk/);
    for (const placeholder of Object.values(SWATCH)) {
      assert.ok(!svgText(er.media.imageRef).toLowerCase().includes(placeholder), 'drawn in the book’s colours');
    }
    for (const m of memes) assert.ok(['pending_approval', 'escalated'].includes(m.status), m.status);

    const { rows } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'meme_template.selected' AND author_id = $1 AND metadata->>'chosenBy' = 'anthropic'",
      [authorId],
    );
    assert.ok(rows.length >= 2, 'Claude’s choice of format is on the record');
  });

  it('still carries its memes when Claude’s reply is unusable — written offline, and marked so', async () => {
    memeReply = 'I would rather not make memes today.';
    const drafts = await draftWeeklyPosts({ authorId, bookId, count: 2, platforms: ['twitter', 'linkedin'], providerName: 'anthropic', memeCount: 1 });
    const memes = drafts.filter((d) => d.format === 'meme');
    assert.equal(memes.length, 1);
    assert.equal(memes[0].media.provenance.writer, 'stub (fallback)');
  });
});
