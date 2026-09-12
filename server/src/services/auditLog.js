import { pool } from '../db/pool.js';

/**
 * Field names whose values must never reach the log (STORY-019).
 *
 * Matched on the key, not the value. A value-based scan — "does this look like
 * a hash?" — is a guess that fails open on the one case that matters, and the
 * key is the thing the writer actually controls.
 *
 * `password_hash` is the live hazard: 28 call sites log a whole database row
 * with `after: row`, and the day one of those rows comes from `users`, the
 * hash is in the log. Ordinary application code could delete such a row. This
 * table cannot — 019_audit_integrity.sql installs triggers that refuse UPDATE,
 * DELETE and TRUNCATE, so a secret written here is unremovable by design. That
 * is the argument for redacting at the boundary rather than encrypting the
 * column: encryption still lets the key holder read it, and neither lets anyone
 * take it back out.
 */
const SECRET_KEYS =
  /^(password|password_hash|passwd|pwd|token|access_token|refresh_token|secret|api_?key|authorization|bearer|credential|private_key|session|salt|jwt)$/i;

export const REDACTED = '[redacted]';

/**
 * Removes secret-shaped fields, at any depth, without altering the shape.
 *
 * The key is kept and its value replaced rather than the key being dropped: a
 * reviewer reading the trail should see *that* a credential was part of the
 * change, because "this write touched a password" is itself the audit fact.
 * Silently dropping it would make the log quietly incomplete, which is the
 * failure REQ-005 is about.
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  // A cycle would otherwise recurse forever; a row object with a self-reference
  // is unusual but a crash inside the audit writer would take the business
  // transaction down with it.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SECRET_KEYS.test(key) ? REDACTED : redact(inner, seen),
    ]),
  );
}

/**
 * Appends one entry to the append-only audit log (REQ-005).
 *
 * Pass the transaction `client` when the audited change happens inside a
 * transaction, so the action and its audit entry commit or roll back together
 * and the log can never disagree with the data.
 *
 * Redaction happens here, in the one function every writer goes through, rather
 * than being a rule each of the 28 call sites has to remember. A convention
 * that has to be remembered is a convention that gets forgotten once, and once
 * is enough when the table cannot be edited afterwards.
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
      before ? JSON.stringify(redact(before)) : null,
      after ? JSON.stringify(redact(after)) : null,
      JSON.stringify(redact(metadata)),
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
