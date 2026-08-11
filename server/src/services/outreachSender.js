import { withTransaction, query } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

export const ACTOR = 'PROutreachAgent';

/**
 * Sends an approved outreach message.
 *
 * Refuses anything not already approved. As with the scheduler, the check
 * lives in the service rather than only in the HTTP route, so another agent
 * calling this directly still hits the gate.
 */
export async function sendOutreachMessage({ messageId }) {
  let prepared;

  try {
    prepared = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM outreach_messages WHERE id = $1 FOR UPDATE',
        [messageId],
      );
      const message = rows[0];
      if (!message) throw Object.assign(new Error('Outreach message not found'), { status: 404 });

      if (message.status !== 'approved') {
        throw Object.assign(
          new Error(
            `Outreach message ${messageId} cannot be sent: status is "${message.status}", not "approved"`,
          ),
          { status: 409, blockedMessage: message },
        );
      }

      const { rows: opportunityRows } = await client.query(
        'SELECT * FROM opportunities WHERE id = $1',
        [message.opportunity_id],
      );
      const opportunity = opportunityRows[0];

      if (!opportunity?.contact_email) {
        throw Object.assign(
          new Error(`Opportunity ${message.opportunity_id} has no contact address`),
          { status: 400 },
        );
      }

      // Claim the send inside the transaction so two concurrent callers cannot
      // both reach the email provider for the same message.
      const { rows: send } = await client.query(
        `INSERT INTO outreach_sends (message_id, author_id, recipient)
         VALUES ($1,$2,$3) RETURNING *`,
        [messageId, message.author_id, opportunity.contact_email],
      );

      return { message, opportunity, send: send[0] };
    });
  } catch (error) {
    if (error.blockedMessage) {
      // The transaction rolled back, so this refusal is recorded separately —
      // a blocked action must still leave a trace.
      await recordAction({
        actor: ACTOR,
        action: 'outreach.send_blocked',
        entityType: 'outreach_message',
        entityId: messageId,
        authorId: error.blockedMessage.author_id,
        before: error.blockedMessage,
        metadata: {
          reason: 'approval gate: message is not approved',
          status: error.blockedMessage.status,
        },
      });
    }
    throw error;
  }

  const { message, opportunity, send } = prepared;

  try {
    const result = await emailApi.send({
      to: opportunity.contact_email,
      subject: message.subject,
      body: message.body,
    });

    const { rows } = await query(
      `UPDATE outreach_sends SET status = 'sent', external_id = $1, sent_at = now()
        WHERE id = $2 RETURNING *`,
      [result.externalId, send.id],
    );
    await query("UPDATE outreach_messages SET status = 'sent', updated_at = now() WHERE id = $1", [
      messageId,
    ]);

    await recordAction({
      actor: ACTOR,
      action: 'outreach.sent',
      entityType: 'outreach_message',
      entityId: messageId,
      authorId: message.author_id,
      before: message,
      after: rows[0],
      metadata: {
        recipient: opportunity.contact_email,
        opportunity: opportunity.name,
        externalId: result.externalId,
        mocked: true,
      },
    });

    return rows[0];
  } catch (error) {
    const { rows } = await query(
      "UPDATE outreach_sends SET status = 'failed', error = $1 WHERE id = $2 RETURNING *",
      [error.message, send.id],
    );

    await recordAction({
      actor: ACTOR,
      action: 'outreach.send_failed',
      entityType: 'outreach_message',
      entityId: messageId,
      authorId: message.author_id,
      metadata: { error: error.message, recipient: opportunity.contact_email },
    });

    return rows[0];
  }
}
