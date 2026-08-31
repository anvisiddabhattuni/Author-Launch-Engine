/**
 * Mocked social platform clients (per STORY-001 build step 5).
 *
 * Each adapter mimics the shape of a real publish call — accept content,
 * return a platform-side id — so swapping in a live SDK later is a change
 * inside this file only. Deterministic ids keep the demo reproducible.
 */

import { callExternal } from '../agents/apiIntegrationAgent.js';

let counter = 0;

const publisher = (platform, maxChars) => ({
  platform,
  maxChars,
  // Routed through the API Integration Agent (STORY-016), so the call is timed,
  // logged and retried on the provider's terms rather than ours. The adapter
  // itself stays a mock; the policy around it is the part that has to be real
  // before a live SDK is dropped in here.
  async publish({ content, scheduledFor, authorId = null }) {
    return callExternal({
      service: platform,
      operation: 'publish',
      authorId,
      fn: async () => {
        if (content.length > maxChars) {
          // The provider rejecting the content is an answer, not a fault. It
          // carries a 400 so the retry policy does not ask again and get the
          // same refusal more slowly.
          throw Object.assign(
            new Error(`${platform} rejected the post: ${content.length} chars exceeds ${maxChars}`),
            { status: 400 },
          );
        }
        counter += 1;
        return {
          externalId: `${platform}_${String(counter).padStart(6, '0')}`,
          permalink: `https://mock.${platform}.test/p/${counter}`,
          publishedAt: scheduledFor ?? new Date().toISOString(),
        };
      },
    });
  },
});

export const socialApis = {
  twitter: publisher('twitter', 280),
  instagram: publisher('instagram', 2200),
  facebook: publisher('facebook', 63206),
  linkedin: publisher('linkedin', 3000),
};

export function getSocialApi(platform) {
  const api = socialApis[platform];
  if (!api) throw Object.assign(new Error(`No social adapter for platform "${platform}"`), { status: 400 });
  return api;
}

/** Test hook so ids stay stable across runs. */
export const __resetCounter = () => {
  counter = 0;
};
