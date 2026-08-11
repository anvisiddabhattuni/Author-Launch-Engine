/**
 * Mocked social platform clients (per STORY-001 build step 5).
 *
 * Each adapter mimics the shape of a real publish call — accept content,
 * return a platform-side id — so swapping in a live SDK later is a change
 * inside this file only. Deterministic ids keep the demo reproducible.
 */

let counter = 0;

const publisher = (platform, maxChars) => ({
  platform,
  maxChars,
  async publish({ content, scheduledFor }) {
    if (content.length > maxChars) {
      throw new Error(`${platform} rejected the post: ${content.length} chars exceeds ${maxChars}`);
    }
    counter += 1;
    return {
      externalId: `${platform}_${String(counter).padStart(6, '0')}`,
      permalink: `https://mock.${platform}.test/p/${counter}`,
      publishedAt: scheduledFor ?? new Date().toISOString(),
    };
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
