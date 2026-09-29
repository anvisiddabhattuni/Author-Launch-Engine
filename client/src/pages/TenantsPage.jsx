import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Onboarding a tenant (STORY-043).
 *
 * The admin gives a name and an address and nothing else. There is no
 * password field on purpose: the author chooses their own from the link in
 * the welcome email, so nobody who set the account up ever knows it. Before
 * this story the admin chose it and had to pass it on somehow.
 */
const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—');

function accessState(t) {
  if (t.tenant_status === 'suspended') return ['rejected', 'suspended'];
  if (t.activated) return ['approved', 'signed in'];
  if (t.invite_expired) return ['escalated', 'invitation expired'];
  if (t.invite_expires_at) return ['pending_approval', 'invited'];
  return ['neutral', 'no account'];
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
    const result = await run(() => api.resendInvite(t.id), (r) => `A new link went to ${r.sentTo}. The previous one no longer works.`);
    if (result) setSent({ name: t.name, email: result.sentTo, expiresAt: result.expiresAt, link: result.devInviteLink });
  }

  if (!tenants) return <div className="card"><div className="empty">Loading…</div></div>;

  const waiting = tenants.filter((t) => !t.activated && t.tenant_status !== 'suspended').length;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {canManage && (
        <div className="card">
          <h2>Onboard a new author</h2>
          <p className="hint">
            Creates their account and their own private section of the database, then emails them a
            link to choose a password. <strong>You never set or see their password.</strong> The link
            works once and expires after 72 hours.
          </p>
          <form onSubmit={onboard}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="tenant-name">Name</label>
                <input id="tenant-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="tenant-email">Email</label>
                <input id="tenant-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button type="submit" disabled={busy || !form.name.trim() || !form.email.trim()}>
                {busy ? 'Onboarding…' : 'Onboard and send welcome email'}
              </button>
            </div>
          </form>

          {sent && (
            <div className="banner ok" style={{ marginTop: 14 }}>
              <div>
                <strong>{sent.name}</strong> is set up.
                {sent.schema && <> Private schema <span className="mono">{sent.schema.name}</span> created.</>}{' '}
                Welcome email sent to <span className="mono">{sent.email}</span>; the link expires {when(sent.expiresAt)} UTC.
              </div>
              {sent.link && (
                <div style={{ marginTop: 8 }}>
                  <span className="pill">development only</span>{' '}
                  Email here goes nowhere, so the link is shown instead. In production it exists only in the email.
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
        <h2>Tenants ({tenants.length})</h2>
        <p className="hint">
          {waiting === 0
            ? 'Everyone onboarded has signed in.'
            : `${waiting} ${waiting === 1 ? 'author has' : 'authors have'} not accepted their invitation yet.`}{' '}
          Every onboarding is on the Audit log with the admin who did it and when.
        </p>
        <div>
          <table>
            <thead>
              <tr>
                <th>Author</th>
                <th>Access</th>
                <th>Private schema</th>
                <th>Onboarded</th>
                <th>By</th>
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
                      <div className="mono hint">{t.email}</div>
                    </td>
                    <td>
                      <span className={`pill ${pill}`}>{label}</span>
                      {!t.activated && t.invite_expires_at && !t.invite_expired && (
                        <div className="hint">link expires {when(t.invite_expires_at)}</div>
                      )}
                    </td>
                    <td className="mono">{t.has_schema ? `tenant_${t.id}` : '—'}</td>
                    <td className="mono">{when(t.onboarded_at)}</td>
                    <td>{t.onboarded_by ?? <span className="hint">before STORY-043</span>}</td>
                    {canManage && (
                      <td className="row">
                        {!t.activated && t.user_id && t.tenant_status !== 'suspended' && (
                          <button className="ghost" disabled={busy} onClick={() => resend(t)}>
                            Resend invitation
                          </button>
                        )}
                        {t.tenant_status === 'suspended' ? (
                          <button className="ghost" disabled={busy} onClick={() => run(() => api.restoreTenant(t.id), `${t.name} restored.`)}>
                            Restore
                          </button>
                        ) : (
                          <button
                            className="ghost"
                            disabled={busy}
                            onClick={() => {
                              const reason = window.prompt(`Why suspend ${t.name}?`);
                              if (reason) run(() => api.suspendTenant(t.id, reason), `${t.name} suspended. Nothing was deleted.`);
                            }}
                          >
                            Suspend
                          </button>
                        )}
                      </td>
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
