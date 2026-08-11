import { withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/** Statuses a human is still allowed to act on. */
const DECIDABLE = new Set(['pending_approval', 'escalated']);

/**
 * Records a human decision on a draft (REQ-006).
 *
 * Approval is the only route out of `pending_approval`/`escalated`, and it is
 * the precondition the scheduler checks — so no content can reach a platform
 * without a named reviewer having said yes, on the record.
 */
async function decide({ draftId, decision, reviewer, notes = '' }) {
  if (!reviewer || !String(reviewer).trim()) {
    throw Object.assign(new Error('A reviewer name is required to record a decision'), { status: 400 });
  }

  return withTransaction(async (client) => {
    // Lock the row so two reviewers cannot decide the same draft concurrently.
    const { rows } = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [draftId]);
    const draft = rows[0];
    if (!draft) throw Object.assign(new Error('Draft not found'), { status: 404 });

    if (!DECIDABLE.has(draft.status)) {
      throw Object.assign(
        new Error(`Draft ${draftId} is "${draft.status}" and can no longer be decided`),
        { status: 409 },
      );
    }

    await client.query('INSERT INTO approvals (draft_id, decision, reviewer, notes) VALUES ($1,$2,$3,$4)', [
      draftId,
      decision,
      reviewer,
      notes,
    ]);

    const { rows: updated } = await client.query(
      'UPDATE drafts SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [decision, draftId],
    );

    await recordAction(
      {
        actor: reviewer,
        action: `draft.${decision}`,
        entityType: 'draft',
        entityId: draftId,
        authorId: draft.author_id,
        before: draft,
        after: updated[0],
        metadata: { notes, escalated: draft.status === 'escalated' },
      },
      client,
    );

    return updated[0];
  });
}

export const approveDraft = ({ draftId, reviewer, notes }) =>
  decide({ draftId, decision: 'approved', reviewer, notes });

export const rejectDraft = ({ draftId, reviewer, notes }) =>
  decide({ draftId, decision: 'rejected', reviewer, notes });
