/**
 * Mocked transactional email client (STORY-002 build step 5).
 *
 * Mirrors the shape of a real provider's send call so swapping in SendGrid or
 * Postmark later is a change confined to this file. Ids are sequential and
 * deterministic to keep the demo reproducible.
 */

import { callExternal } from '../agents/apiIntegrationAgent.js';
import { assertDeclaredPath } from './outboundPaths.js';

let counter = 0;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailApi = {
  name: 'mock-email',

  /**
   * @param {string} via Which declared outbound path this send belongs to
   *   (STORY-020). Checked here rather than trusted, because a caller that
   *   forgets is exactly the case this is for — the same reason the approval
   *   check lives inside `scheduleDraft` and not in the route above it.
   */
  async send({ to, subject, body, authorId = null, via }) {
    // Before the network call and before validation: an undeclared path is a
    // build error, not a bad message, and it should fail the same way whether
    // or not the address happens to be well-formed.
    assertDeclaredPath(via);
    return callExternal({
      service: 'email',
      operation: 'send',
      authorId,
      fn: async () => {
        // Validation failures are 400s: the message is wrong, and sending it
        // again unchanged produces the same rejection.
        if (!EMAIL_PATTERN.test(to ?? '')) {
          throw Object.assign(new Error(`Invalid recipient address: "${to}"`), { status: 400 });
        }
        if (!subject?.trim()) {
          throw Object.assign(new Error('Email subject is required'), { status: 400 });
        }
        if (!body?.trim()) {
          throw Object.assign(new Error('Email body is required'), { status: 400 });
        }

        counter += 1;
        return {
          externalId: `msg_${String(counter).padStart(6, '0')}`,
          acceptedAt: new Date().toISOString(),
        };
      },
    });
  },
};

/** Test hook so ids stay stable across runs. */
export const __resetCounter = () => {
  counter = 0;
};
