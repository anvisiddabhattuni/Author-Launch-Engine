import { createHash, randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

/**
 * Invitations for new tenants (STORY-043).
 *
 * The admin who onboards an author never learns their password — there is
 * none, until the author sets it from a link only they receive. Before this,
 * the admin chose it and had to get it to the author some other way.
 *
 * The token is 32 random bytes, sent once and stored only as its SHA-256: the
 * table is not a list of working links. One use, a deadline, and a resend
 * retires the previous link.
 */
export const ACTOR = 'TenantManagementAgent';

const hash = (token) => createHash('sha256').update(token).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

export const inviteLink = (token) => `${config.appUrl}/accept-invite?token=${encodeURIComponent(token)}`;

/**
 * Creates an invitation and emails it. Pass the transaction's client so the
 * invitation exists exactly when the account does; the email is sent by the
 * caller after commit, because a mail that went out for an account that then
 * rolled back is a link to nothing.
 */
export async function createInvite({ userId, authorId, createdBy = null }, client = pool) {
  await client.query(
    'UPDATE tenant_invites SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
    [userId],
  );
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.inviteTtlHours * 3_600_000);
  const { rows } = await client.query(
    `INSERT INTO tenant_invites (user_id, author_id, token_hash, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [userId, authorId, hash(token), createdBy, expiresAt],
  );
  return { id: Number(rows[0].id), token, expiresAt: rows[0].expires_at };
}

/** The welcome email. Declared as an outbound path; carries a link, not content. */
export async function sendWelcome({ email, name, token, expiresAt, authorId }) {
  const sent = await emailApi.send({
    to: email,
    subject: 'Your Author Launch Engine account is ready',
    body: [
      `Hello ${name},`,
      '',
      'An account has been set up for you. Choose your own password here — nobody else,',
      'including whoever set this up, knows it or can see it:',
      '',
      `  ${inviteLink(token)}`,
      '',
      `The link works once and expires ${new Date(expiresAt).toUTCString()}.`,
      'If you were not expecting this, ignore it and nothing happens.',
    ].join('\n'),
    authorId,
    via: 'tenant.welcome',
  });
  return sent;
}

/** Sends a fresh invitation, retiring the last one. For "I never got it". */
export async function resendInvite({ authorId, user }) {
  const { rows: [account] } = await pool.query(
    'SELECT u.id, u.email, u.name, u.password_hash IS NOT NULL AS activated FROM users u WHERE u.author_id = $1 ORDER BY u.id LIMIT 1',
    [authorId],
  );
  if (!account) throw fail(404, 'No account for that tenant');
  if (account.activated) throw fail(409, 'That account already has a password; an invitation would do nothing');
  const invite = await withTransaction((client) => createInvite({ userId: account.id, authorId, createdBy: user?.id ?? null }, client));
  await sendWelcome({ email: account.email, name: account.name, token: invite.token, expiresAt: invite.expiresAt, authorId });
  await recordAction({
    actor: user?.name ?? ACTOR,
    action: 'tenant.invite_resent',
    entityType: 'author',
    entityId: authorId,
    authorId,
    metadata: { adminId: user?.id ?? null, to: account.email, expiresAt: new Date(invite.expiresAt).toISOString() },
  });
  return { sentTo: account.email, expiresAt: invite.expiresAt, ...devLink(invite.token) };
}

/**
 * The author sets their password. One use; expired, revoked or reused links
 * are refused with the same answer, so a probe learns nothing about which.
 */
export async function acceptInvite({ token, password }) {
  if (!token) throw fail(400, 'This link is incomplete');
  if (!password || password.length < 10) throw fail(400, 'Choose a password of at least 10 characters');
  const { hashPassword } = await import('./auth.js');
  const passwordHash = await hashPassword(password);
  const outcome = await withTransaction(async (client) => {
    const { rows: [invite] } = await client.query(
      'SELECT * FROM tenant_invites WHERE token_hash = $1 FOR UPDATE',
      [hash(token)],
    );
    const usable = invite && !invite.used_at && !invite.revoked_at && new Date(invite.expires_at) > new Date();
    if (!usable) {
      return {
        refused: !invite ? 'no such link' : invite.used_at ? 'already used' : invite.revoked_at ? 'replaced by a newer link' : 'expired',
        authorId: invite?.author_id ?? null,
      };
    }
    await client.query('UPDATE tenant_invites SET used_at = now() WHERE id = $1', [invite.id]);
    const { rows: [user] } = await client.query(
      'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING *',
      [invite.user_id, passwordHash],
    );
    await recordAction(
      {
        actor: user.name,
        action: 'tenant.invite_accepted',
        entityType: 'author',
        entityId: invite.author_id,
        authorId: invite.author_id,
        metadata: { userId: Number(user.id), invitedBy: invite.created_by, invitedAt: new Date(invite.created_at).toISOString() },
      },
      client,
    );
    return { user };
  });
  if (outcome.refused) {
    // Recorded outside the transaction: written inside, the refusal would be
    // rolled back along with everything else, and the log would never show
    // someone trying old links.
    await recordAction({
      actor: ACTOR,
      action: 'tenant.invite_refused',
      entityType: 'author',
      entityId: outcome.authorId,
      authorId: outcome.authorId,
      metadata: { reason: outcome.refused },
    });
    throw fail(400, 'This link has expired or has already been used. Ask for a new one.');
  }
  return outcome.user;
}

/**
 * The link itself, outside production only. The email adapter is a mock
 * (STORY-002) and delivers nowhere, so on a laptop there is no inbox to find
 * it in; the page shows it, labelled. In production this returns nothing and
 * the link exists only in the email.
 */
export function devLink(token) {
  return config.nodeEnv === 'production' ? {} : { devInviteLink: inviteLink(token) };
}
