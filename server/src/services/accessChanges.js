import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { PERMISSIONS, holds } from './permissions.js';

/**
 * Reviewed changes to who may do what (STORY-042 / REQ-011).
 *
 * Before this, access changed only by editing role_permissions in SQL, one
 * admin could create another through onboarding, and a revoked permission kept
 * working for the life of the session token. Now every grant, revocation and
 * role assignment is a request; a *different* admin decides it; and only an
 * approved request changes anything, through `ale_apply_access_change` (037),
 * which the application login can execute and cannot imitate — it no longer
 * has write access to role_permissions or to users.role at all.
 */
export const ACTOR = 'CoordinationGovernanceAgent';

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// The version sessions are checked against
// ---------------------------------------------------------------------------

let cached = { version: null, at: 0 };

/** The current access version, read at most once a second per process. */
/** Drops this process's cached version, so the next request re-reads it. */
export const forgetAccessVersion = () => {
  cached = { version: null, at: 0 };
};

export async function accessVersion({ fresh = false } = {}) {
  if (!fresh && cached.version !== null && Date.now() - cached.at < 1000) return cached.version;
  const { rows } = await pool.query('SELECT version FROM access_version');
  cached = { version: Number(rows[0]?.version ?? 1), at: Date.now() };
  return cached.version;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Proposes a change. Nothing moves until someone else approves it. */
export async function proposeChange({ kind, role = null, permission = null, userId = null, newRole = null, reason, user }) {
  if (!holds(user, PERMISSIONS.ACCESS_MANAGE)) throw fail(403, 'Proposing an access change needs access.manage');

  // Refuse a change that would change nothing: approving it would put a
  // decision on the record that decided nothing.
  if (kind === 'grant_permission' || kind === 'revoke_permission') {
    const { rows } = await pool.query('SELECT 1 FROM role_permissions WHERE role = $1 AND permission = $2', [role, permission]);
    if (kind === 'grant_permission' && rows.length) throw fail(409, `${role} already holds ${permission}`);
    if (kind === 'revoke_permission' && !rows.length) throw fail(409, `${role} does not hold ${permission}`);
  } else if (kind === 'assign_role') {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw fail(404, 'No such account');
    if (rows[0].role === newRole) throw fail(409, `That account is already ${newRole}`);
  }

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO access_changes (kind, role, permission, user_id, new_role, reason, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [kind, role, permission, userId, newRole, reason, user.id],
      );
      await recordAction(
        {
          actor: user.name,
          action: 'access.change_requested',
          entityType: 'access_change',
          entityId: rows[0].id,
          after: rows[0],
          metadata: { kind, role, permission, userId, newRole, reason, requestedBy: user.id },
        },
        client,
      );
      return rows[0];
    });
  } catch (error) {
    if (error.code === '23505') throw fail(409, 'An identical change is already waiting for a decision');
    if (error.code === '23514' && /has_reason/.test(error.constraint ?? '')) throw fail(400, 'Say why, in at least ten characters');
    throw error;
  }
}

/**
 * Approves or rejects. Approval applies the change in the same transaction —
 * approved-but-not-applied is not a state anyone should have to reason about.
 */
export async function decideChange({ id, user, approve, note = '' }) {
  if (!holds(user, PERMISSIONS.ACCESS_MANAGE)) throw fail(403, 'Deciding an access change needs access.manage');
  return withTransaction(async (client) => {
    const { rows: [change] } = await client.query('SELECT * FROM access_changes WHERE id = $1 FOR UPDATE', [id]);
    if (!change) throw fail(404, 'No such access change');
    if (change.status !== 'pending') throw fail(409, `This change is already ${change.status}`);
    // Said here in words; the database says it too, as a constraint, for any
    // path that does not come through this function.
    if (Number(change.requested_by) === Number(user.id)) {
      throw fail(403, 'You requested this change. Another admin has to decide it.');
    }

    const before = await matrixRow(client, change);
    const { rows: [decided] } = await client.query(
      `UPDATE access_changes SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1 RETURNING *`,
      [id, approve ? 'approved' : 'rejected', user.id, note],
    );
    await recordAction(
      {
        actor: user.name,
        action: approve ? 'access.change_approved' : 'access.change_rejected',
        entityType: 'access_change',
        entityId: id,
        before: change,
        after: decided,
        metadata: { kind: change.kind, requestedBy: Number(change.requested_by), decidedBy: user.id, note },
      },
      client,
    );
    if (!approve) return decided;

    const { rows: [applied] } = await client.query('SELECT * FROM ale_apply_access_change($1)', [id]);
    const after = await matrixRow(client, change);
    await recordAction(
      {
        actor: ACTOR,
        action: 'access.change_applied',
        entityType: 'access_change',
        entityId: id,
        before,
        after,
        metadata: { kind: change.kind, role: change.role, permission: change.permission, userId: change.user_id, newRole: change.new_role },
      },
      client,
    );
    cached = { version: null, at: 0 };
    return applied;
  });
}

/** The requester changes their mind. Only they may. */
export async function withdrawChange({ id, user }) {
  const { rows } = await pool.query(
    `UPDATE access_changes SET status = 'withdrawn' WHERE id = $1 AND status = 'pending' AND requested_by = $2 RETURNING *`,
    [id, user.id],
  );
  if (!rows[0]) throw fail(409, 'Only the person who asked can withdraw a change, and only while it is pending');
  await recordAction({ actor: user.name, action: 'access.change_withdrawn', entityType: 'access_change', entityId: id, after: rows[0] });
  return rows[0];
}

/** What the change touches, as it stands — its before and after on the log. */
async function matrixRow(client, change) {
  if (change.kind === 'assign_role') {
    const { rows } = await client.query('SELECT id, email, role FROM users WHERE id = $1', [change.user_id]);
    return rows[0] ?? null;
  }
  const { rows } = await client.query('SELECT permission FROM role_permissions WHERE role = $1 ORDER BY permission', [change.role]);
  return { role: change.role, permissions: rows.map((r) => r.permission) };
}

/** The read-model for the Access tab. */
export async function accessOverview() {
  const { rows: changes } = await pool.query(
    `SELECT c.*, r.name AS requested_by_name, d.name AS decided_by_name, u.email AS user_email
       FROM access_changes c
       LEFT JOIN users r ON r.id = c.requested_by
       LEFT JOIN users d ON d.id = c.decided_by
       LEFT JOIN users u ON u.id = c.user_id
      ORDER BY (c.status = 'pending') DESC, c.id DESC LIMIT 50`,
  );
  const { rows: elevated } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role,
            (SELECT c.status FROM access_changes c
              WHERE c.user_id = u.id AND c.kind = 'assign_role' AND c.new_role = u.role
                AND (c.status = 'bootstrap' OR c.applied_at IS NOT NULL)
              ORDER BY c.id DESC LIMIT 1) AS how
       FROM users u WHERE u.role <> 'author' AND u.active ORDER BY u.id`,
  );
  const { rows: admins } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users u JOIN role_permissions rp ON rp.role = u.role
      WHERE rp.permission = 'access.manage' AND u.active`,
  );
  return { changes, elevated, approvers: admins[0].n, version: await accessVersion({ fresh: true }) };
}
