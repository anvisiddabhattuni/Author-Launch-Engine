import { withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';

/** Statuses a human is still allowed to act on. */
const DECIDABLE = new Set(['pending_approval', 'escalated']);

/**
 * The kinds of thing a human approves. All funnel through one decision path so
 * the gate behaves identically for a social post, an outreach email and a press
 * material, and all three write to the same `approvals` table.
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
  prMaterial: {
    table: 'pr_materials',
    column: 'pr_material_id',
    entityType: 'pr_material',
    actionPrefix: 'pr_material',
  },
};

/**
 * @param {object} args
 * @param {{id: number, name: string, role: string}} [args.user] The authenticated
 *   decider (STORY-064). Supplied by the API on every request. Absent only when
 *   trusted internal code — the demo, a test — calls the service directly; the
 *   decision is still recorded, but marked on the audit log as unattributable so
 *   it cannot be mistaken for one a real session stands behind.
 */
async function decide({ target, id, decision, reviewer, notes = '', user = null }) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unknown approval target "${target}"`);

  // A signed-in decider names themselves. The free-text argument survives for
  // internal callers, and because rewriting history is not this story's job.
  const decidedBy = user?.name ?? reviewer;

  if (!decidedBy || !String(decidedBy).trim()) {
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

    // Reviewing withdrawn copy wastes the reviewer's attention, which is the
    // scarce resource this whole gate is spending (STORY-005).
    if (target === 'prMaterial') {
      const { rows: kitRows } = await client.query('SELECT * FROM pr_kits WHERE id = $1', [
        record.kit_id,
      ]);
      if (kitRows[0]?.status === 'superseded') {
        throw Object.assign(
          new Error(
            `pr_material ${id} belongs to superseded kit ${record.kit_id} and no longer needs a decision`,
          ),
          { status: 409 },
        );
      }
    }

    await client.query(
      `INSERT INTO approvals (${spec.column}, decision, reviewer, notes, user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, decision, decidedBy, notes, user?.id ?? null],
    );

    const { rows: updated } = await client.query(
      `UPDATE ${spec.table} SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [decision, id],
    );

    await recordAction(
      {
        actor: decidedBy,
        action: `${spec.actionPrefix}.${decision}`,
        entityType: spec.entityType,
        entityId: id,
        authorId: record.author_id,
        before: record,
        after: updated[0],
        metadata: {
          notes,
          escalated: record.status === 'escalated',
          // The point of STORY-064: the log now says *who*, not just that
          // somebody said they were who. A decision with no session behind it
          // is marked as such rather than looking identical to one that has.
          userId: user?.id ?? null,
          role: user?.role ?? null,
          attributable: Boolean(user),
        },
      },
      client,
    );

    return updated[0];
  });
}

export const approveDraft = ({ draftId, reviewer, notes, user }) =>
  decide({ target: 'draft', id: draftId, decision: 'approved', reviewer, notes, user });

export const rejectDraft = ({ draftId, reviewer, notes, user }) =>
  decide({ target: 'draft', id: draftId, decision: 'rejected', reviewer, notes, user });

export const approveOutreach = ({ messageId, reviewer, notes, user }) =>
  decide({ target: 'outreach', id: messageId, decision: 'approved', reviewer, notes, user });

export const rejectOutreach = ({ messageId, reviewer, notes, user }) =>
  decide({ target: 'outreach', id: messageId, decision: 'rejected', reviewer, notes, user });

export const approvePrMaterial = ({ materialId, reviewer, notes, user }) =>
  decide({ target: 'prMaterial', id: materialId, decision: 'approved', reviewer, notes, user });

export const rejectPrMaterial = ({ materialId, reviewer, notes, user }) =>
  decide({ target: 'prMaterial', id: materialId, decision: 'rejected', reviewer, notes, user });
