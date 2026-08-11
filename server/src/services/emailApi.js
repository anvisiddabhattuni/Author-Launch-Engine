/**
 * Mocked transactional email client (STORY-002 build step 5).
 *
 * Mirrors the shape of a real provider's send call so swapping in SendGrid or
 * Postmark later is a change confined to this file. Ids are sequential and
 * deterministic to keep the demo reproducible.
 */

let counter = 0;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailApi = {
  name: 'mock-email',

  async send({ to, subject, body }) {
    if (!EMAIL_PATTERN.test(to ?? '')) {
      throw new Error(`Invalid recipient address: "${to}"`);
    }
    if (!subject?.trim()) throw new Error('Email subject is required');
    if (!body?.trim()) throw new Error('Email body is required');

    counter += 1;
    return {
      externalId: `msg_${String(counter).padStart(6, '0')}`,
      acceptedAt: new Date().toISOString(),
    };
  },
};

/** Test hook so ids stay stable across runs. */
export const __resetCounter = () => {
  counter = 0;
};
