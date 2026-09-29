import { notifyRaisedEscalations } from '../services/reviewNotifier.js';
import { notifyFailedPublishes } from '../services/publishFailureNotifier.js';

/**
 * What each recipient does with what it is sent (STORY-039).
 *
 * Every handler is an existing notifier that a sweep already calls, and every
 * one is idempotent on its own account — it announces each item once however
 * often it runs. That is what makes at-least-once delivery safe: a message
 * delivered twice produces one email, and the sweep that still runs every five
 * minutes finds nothing left to do. The message makes it fast; the sweep
 * makes it certain.
 */
export const MESSAGE_HANDLERS = {
  ApprovalNotificationAgent: {
    'escalation.raised': async ({ payload }) => {
      const result = await notifyRaisedEscalations({ authorId: Number(payload.authorId) });
      return { notified: result.notified.length };
    },
  },
  APIIntegrationAgent: {
    'post.publish_failed': async ({ payload }) => {
      const result = await notifyFailedPublishes({ authorId: Number(payload.authorId) });
      return { notified: result.notified.length };
    },
  },
};
