import { pool } from '../db/pool.js';

/**
 * Appends one entry to the append-only audit log (REQ-005).
 *
 * Pass the transaction `client` when the audited change happens inside a
 * transaction, so the action and its audit entry commit or roll back together
 * and the log can never disagree with the data.
 */
export async function recordAction(
  { actor, action, entityType, entityId, authorId = null, before = null, after = null, metadata = {} },
  client = pool,
) {
  const { rows } = await client.query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, author_id, before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      actor,
      action,
      entityType,
      entityId === null || entityId === undefined ? null : String(entityId),
      authorId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      JSON.stringify(metadata),
    ],
  );
  return rows[0];
}

export async function listAuditLog({ authorId, entityType, limit = 100 } = {}) {
  const conditions = [];
  const params = [];

  if (authorId) {
    params.push(authorId);
    conditions.push(`author_id = $${params.length}`);
  }
  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }

  params.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
