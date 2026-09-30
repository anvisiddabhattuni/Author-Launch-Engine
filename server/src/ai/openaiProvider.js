import { createHash } from 'node:crypto';

import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';

import { buildPrompt, parsePosts } from './anthropicProvider.js';

/**
 * Social drafts from OpenAI (STORY-035 / REQ-009, REQ-010, REQ-011) — AI
 * Content Generation Agent.
 *
 * The same prompt as the Anthropic adapter — the book's themes with the
 * passages that argue them, the author's measured voice and prior posts — plus
 * the posts a human has already approved, which the story names: "book themes
 * and prior approved posts". What comes back is scored and held for approval
 * exactly like any other provider's drafts; nothing here publishes.
 *
 * Through the integration gateway: timed out, retried after a delay on a 429
 * or a 5xx (not on a 400, which would fail the same way again), every attempt
 * logged, and the circuit opened if OpenAI keeps failing.
 */
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function approvedBrief(approved = []) {
  if (!approved.length) return '';
  return [
    'Posts this author has approved before — the clearest signal of what they will publish:',
    ...approved.slice(0, 5).map((a) => `- [${a.platform}] ${a.content}`),
  ].join('\n');
}

export const openaiProvider = {
  name: 'openai',

  async generateCandidates({ book, voiceProfile, voice, grounding, history, platforms, count, bookModel = null, revision = null, approvedExamples = [] }) {
    if (!config.openaiApiKey) {
      throw new Error('AI_PROVIDER=openai requires OPENAI_API_KEY to be set');
    }
    const prompt = [
      buildPrompt({ book, voiceProfile, voice, grounding, history, platforms, count, bookModel, revision }),
      approvedBrief(approvedExamples),
    ].filter(Boolean).join('\n\n');

    const body = await callExternal({
      service: 'openai',
      operation: 'social.generate',
      fn: (signal) =>
        httpJson(`${config.openaiBaseUrl}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
          body: JSON.stringify({
            model: config.openaiModel,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You draft social posts for an author. You answer with JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        }),
    });
    const text = body.choices?.[0]?.message?.content ?? '';

    const candidates = parsePosts(text)
      .filter((post) => post && typeof post.content === 'string')
      .map((post) => ({
        platform: platforms.includes(post.platform) ? post.platform : platforms[0],
        content: post.content,
        themesUsed: Array.isArray(post.themesUsed) ? post.themesUsed : [],
      }));
    // What was asked and what came back, for the audit log (the story's Trust
    // line): digests and sizes, not the text — the drafts themselves are stored.
    Object.defineProperty(candidates, 'exchange', {
      enumerable: false,
      value: {
        provider: 'openai',
        model: body.model ?? config.openaiModel,
        requestSha256: sha(prompt),
        requestChars: prompt.length,
        responseSha256: sha(text),
        responseChars: text.length,
        responseId: body.id ?? null,
        usage: body.usage ?? null,
        approvedExamples: approvedExamples.length,
      },
    });
    return candidates;
  },
};
