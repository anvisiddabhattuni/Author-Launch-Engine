import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localDate, localTime } from '../labels.js';

/**
 * Onboarding a tenant (STORY-043).
 *
 * The admin gives a name and an address and nothing else. There is no
 * password field on purpose: the author chooses their own from the link in
 * the welcome email, so nobody who set the account up ever knows it. Before
 * this story the admin chose it and had to pass it on somehow.
 */

function accessState(t) {
  if (t.tenant_status === 'suspended') return ['rejected', 'Paused'];
  if (t.activated) return ['approved', 'Active'];
  if (t.invite_expired) return ['escalated', 'Invitation expired'];
  if (t.invite_expires_at) return ['pending_approval', 'Invited — not joined yet'];
  return ['neutral', 'No account'];
}

export function TenantsPage({ user }) {
  const [tenants, setTenants] = useState(null);
  const [form, setForm] = useState({ name: '', email: '' });
  const [status, setStatus] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const canManage = Boolean(user?.permissions?.includes('tenant.manage'));

  const refresh = useCallback(async () => setTenants(await api.tenants()), []);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, message) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await fn();
      if (message) setStatus({ kind: 'ok', message: typeof message === 'function' ? message(result) : message });
      await refresh();
      return result;
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onboard(event) {
    event.preventDefault();
    const result = await run(() => api.onboardTenant({ name: form.name.trim(), email: form.email.trim() }));
    if (result) {
      setSent({
        name: result.author.name,
        email: result.invite?.sentTo,
        expiresAt: result.invite?.expiresAt,
        schema: result.schema,
        link: result.invite?.devInviteLink,
      });
      setForm({ name: '', email: '' });
    }
  }

  async function resend(t) {
    const result = await run(() => api.resendInvite(t.id), (r) => `A new link went to ${r.sentTo}. The old one no longer works.`);
    if (result) setSent({ name: t.name, email: result.sentTo, expiresAt: result.expiresAt, link: result.devInviteLink });
  }

  if (!tenants) return <div className="card"><div className="empty">Loading…</div></div>;

  const waiting = tenants.filter((t) => !t.activated && t.tenant_status !== 'suspended').length;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {canManage && (
        <div className="card">
          <h2>Invite a new author</h2>
          <p className="hint">
            They get an email with a link to choose their own password — <strong>you never see it.</strong>{' '}
            The link works once and stops working after 3 days. Their books and posts are kept separate from every other author’s.
          </p>
          <form onSubmit={onboard}>
            <div className="row form-row">
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="tenant-name">Author’s name</label>
                <input id="tenant-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="tenant-email">Their email</label>
                <input id="tenant-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button type="submit" disabled={busy || !form.name.trim() || !form.email.trim()}>
                {busy ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>

          {sent && (
            <div className="banner ok" style={{ marginTop: 14 }}>
              <div>
                <strong>{sent.name}</strong> is set up. An invitation went to <strong>{sent.email}</strong>; the link
                works until {localTime(sent.expiresAt)}.
              </div>
              {sent.link && (
                <div style={{ marginTop: 8 }}>
                  <span className="pill">demo only</span>{' '}
                  This demo doesn’t send real email, so here is the link the author would have received:
                  <div className="mono" style={{ wordBreak: 'break-all', marginTop: 4 }}>
                    <a href={sent.link}>{sent.link}</a>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>All authors ({tenants.length})</h2>
        <p className="hint">
          {waiting === 0
            ? 'Everyone invited has joined.'
            : `${waiting} ${waiting === 1 ? 'author hasn’t' : 'authors haven’t'} joined yet.`}
        </p>
        <div>
          <table>
            <thead>
              <tr>
                <th>Author</th>
                <th>Status</th>
                <th>Added</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const [pill, label] = accessState(t);
                return (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="hint">{t.email}</div>
                    </td>
                    <td>
                      <span className={`pill ${pill}`}>{label}</span>
                      {!t.activated && t.invite_expires_at && !t.invite_expired && (
                        <div className="hint">link works until {localDate(t.invite_expires_at)}</div>
                      )}
                    </td>
                    <td>
                      {localDate(t.onboarded_at)}
                      {t.onboarded_by && <div className="hint">by {t.onboarded_by}</div>}
                    </td>
                    {canManage && (
                      <td className="cell-action"><div className="row">
                        {!t.activated && t.user_id && t.tenant_status !== 'suspended' && (
                          <button className="ghost" disabled={busy} onClick={() => resend(t)}>
                            Send a new link
                          </button>
                        )}
                        {t.tenant_status === 'suspended' ? (
                          <button className="ghost" disabled={busy} onClick={() => run(() => api.restoreTenant(t.id), `${t.name} can use the app again.`)}>
                            Un-pause
                          </button>
                        ) : (
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => {
                              const reason = window.prompt(`Pausing stops ${t.name} from signing in. Nothing is deleted. Why are you pausing this account?`);
                              if (reason) run(() => api.suspendTenant(t.id, reason), `${t.name} is paused. Nothing was deleted.`);
                            }}
                          >
                            Pause
                          </button>
                        )}
                      </div></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
