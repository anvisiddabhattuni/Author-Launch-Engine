import { withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/** Statuses a human is still allowed to act on. */
const DECIDABLE = new Set(['pending_approval', 'escalated']);

/**
 * The two kinds of thing a human approves. Both funnel through one decision
 * path so the gate behaves identically for a social post and an outreach
 * email, and both write to the same `approvals` table.
 */
const TARGETS = {
  draft: {
    table: 'drafts',
    column: 'draft_id',
    entityType: 'draft',
    actionPrefix: 'draft',
  },
  outreach: {
    table: 'outreach_messages',
    column: 'outreach_message_id',
    entityType: 'outreach_message',
    actionPrefix: 'outreach',
  },
};

async function decide({ target, id, decision, reviewer, notes = '' }) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unknown approval target "${target}"`);

  if (!reviewer || !String(reviewer).trim()) {
    throw Object.assign(new Error('A reviewer name is required to record a decision'), { status: 400 });
  }

  return withTransaction(async (client) => {
    // Lock the row so two reviewers cannot decide the same item concurrently.
    const { rows } = await client.query(`SELECT * FROM ${spec.table} WHERE id = $1 FOR UPDATE`, [id]);
    const record = rows[0];
    if (!record) throw Object.assign(new Error(`${spec.entityType} not found`), { status: 404 });

    if (!DECIDABLE.has(record.status)) {
      throw Object.assign(
        new Error(`${spec.entityType} ${id} is "${record.status}" and can no longer be decided`),
        { status: 409 },
      );
    }

    await client.query(
      `INSERT INTO approvals (${spec.column}, decision, reviewer, notes) VALUES ($1,$2,$3,$4)`,
      [id, decision, reviewer, notes],
    );

    const { rows: updated } = await client.query(
      `UPDATE ${spec.table} SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [decision, id],
    );

    await recordAction(
      {
        actor: reviewer,
        action: `${spec.actionPrefix}.${decision}`,
        entityType: spec.entityType,
        entityId: id,
        authorId: record.author_id,
        before: record,
        after: updated[0],
        metadata: { notes, escalated: record.status === 'escalated' },
      },
      client,
    );

    return updated[0];
  });
}

export const approveDraft = ({ draftId, reviewer, notes }) =>
  decide({ target: 'draft', id: draftId, decision: 'approved', reviewer, notes });

export const rejectDraft = ({ draftId, reviewer, notes }) =>
  decide({ target: 'draft', id: draftId, decision: 'rejected', reviewer, notes });

export const approveOutreach = ({ messageId, reviewer, notes }) =>
  decide({ target: 'outreach', id: messageId, decision: 'approved', reviewer, notes });

export const rejectOutreach = ({ messageId, reviewer, notes }) =>
  decide({ target: 'outreach', id: messageId, decision: 'rejected', reviewer, notes });
