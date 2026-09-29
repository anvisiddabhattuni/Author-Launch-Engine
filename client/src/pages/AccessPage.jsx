import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Who may do what, and every change to it (STORY-042).
 *
 * A change is a request; someone other than the requester decides it; only an
 * approved request changes anything, and it takes effect on the next request
 * every signed-in person makes. The page shows the request you made as
 * waiting for someone else — the database refuses your own approval anyway,
 * and a button that could only fail is not offered.
 */
const STATUS = {
  pending: 'pending_approval',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'neutral',
  bootstrap: 'neutral',
};

const describe = (c) =>
  c.kind === 'assign_role'
    ? `make ${c.user_email ?? `account ${c.user_id}`} ${c.new_role}`
    : `${c.kind === 'grant_permission' ? 'grant' : 'revoke'} ${c.permission} ${c.kind === 'grant_permission' ? 'to' : 'from'} ${c.role}`;

const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—');

export function AccessPage({ user }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ kind: 'grant_permission', role: 'compliance', permission: '', userId: '', newRole: 'compliance', reason: '' });
  const canManage = Boolean(user?.permissions?.includes('access.manage'));

  const refresh = useCallback(async () => setData(await api.access()), []);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, message) {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ kind: 'ok', message });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  const pending = data.changes.filter((c) => c.status === 'pending');
  const decided = data.changes.filter((c) => c.status !== 'pending');
  const allPermissions = [...new Set(data.matrix.flatMap((r) => r.permissions))].sort();

  function submit(event) {
    event.preventDefault();
    const body = form.kind === 'assign_role'
      ? { kind: form.kind, userId: Number(form.userId), newRole: form.newRole, reason: form.reason }
      : { kind: form.kind, role: form.role, permission: form.permission, reason: form.reason };
    run(() => api.proposeAccessChange(body), 'Requested. Another admin has to approve it before anything changes.');
  }

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Waiting for a decision ({pending.length})</h2>
        <p className="hint">
          Nothing below has changed anyone&apos;s access yet. Each needs an admin other than the one
          who asked — the database refuses a requester&apos;s own approval — and an approved change
          applies to every signed-in session on its next request, not when their token expires.
          {data.approvers < 2 && (
            <strong> Only {data.approvers} person can approve changes, so nothing can be approved.</strong>
          )}
        </p>
        {pending.length === 0 ? (
          <div className="empty">Nothing waiting.</div>
        ) : (
          pending.map((c) => {
            const mine = Number(c.requested_by) === Number(user.id);
            return (
              <div className="draft" key={c.id}>
                <div className="meta">
                  <span className="pill pending_approval">waiting</span>
                  <strong>{describe(c)}</strong>
                </div>
                <div className="hint">
                  “{c.reason}” — asked by {c.requested_by_name} at {when(c.requested_at)}
                </div>
                {canManage && (
                  <div className="row">
                    {mine ? (
                      <>
                        <span className="pill neutral">you asked — another admin decides</span>
                        <button className="ghost" disabled={busy} onClick={() => run(() => api.withdrawAccessChange(c.id), 'Withdrawn.')}>Withdraw</button>
                      </>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => run(() => api.approveAccessChange(c.id), 'Approved and applied.')}>Approve</button>
                        <button className="danger" disabled={busy} onClick={() => run(() => api.rejectAccessChange(c.id), 'Rejected. Nothing changed.')}>Reject</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {canManage && (
        <form className="card" onSubmit={submit}>
          <h2>Request a change</h2>
          <div className="row">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="grant_permission">Grant a permission to a role</option>
              <option value="revoke_permission">Revoke a permission from a role</option>
              <option value="assign_role">Give an account a role</option>
            </select>
          </div>
          {form.kind === 'assign_role' ? (
            <div className="row">
              <input placeholder="account id" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} />
              <select value={form.newRole} onChange={(e) => setForm({ ...form, newRole: e.target.value })}>
                {data.matrix.map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
              </select>
            </div>
          ) : (
            <div className="row">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {data.matrix.map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
              </select>
              <select value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
                <option value="">permission…</option>
                {allPermissions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
          <input placeholder="Why — at least ten characters, and it goes on the audit log" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <button type="submit" disabled={busy}>Request</button>
        </form>
      )}

      <AuditAccessPolicy />

      <div className="card">
        <h2>Who holds what</h2>
        <table>
          <thead><tr><th>Role</th><th>Permissions</th></tr></thead>
          <tbody>
            {data.matrix.map((r) => (
              <tr key={r.role}>
                <td>{r.role}<div className="hint">{r.description}</div></td>
                <td>{r.permissions.map((p) => <span className="pill mono" key={p} style={{ marginRight: 4 }}>{p}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Accounts with more than author access</h3>
        <table>
          <thead><tr><th>Account</th><th>Role</th><th>How they got it</th></tr></thead>
          <tbody>
            {data.elevated.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="hint mono">{u.email} · id {u.id}</div></td>
                <td>{u.role}</td>
                <td>
                  {u.how === 'approved' ? <span className="pill approved">approved change</span>
                    : u.how === 'bootstrap' ? <span className="pill neutral">seeded before review existed</span>
                      : <span className="pill escalated">nobody approved this</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Decided ({decided.length})</h2>
        <table>
          <thead><tr><th>Change</th><th>Asked by</th><th>Decided by</th><th>Status</th></tr></thead>
          <tbody>
            {decided.map((c) => (
              <tr key={c.id}>
                <td>{describe(c)}<div className="hint">“{c.reason}”</div></td>
                <td>{c.requested_by_name ?? '—'}<div className="hint mono">{when(c.requested_at)}</div></td>
                <td>{c.decided_by_name ?? '—'}<div className="hint mono">{when(c.decided_at)}</div></td>
                <td><span className={`pill ${STATUS[c.status] ?? ''}`}>{c.status}{c.applied_at ? ', applied' : ''}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Who may read and manage the audit logs (STORY-050), derived from the live
 * grant table — every audit route, every role, and an API key, which holds
 * nothing. The same declaration the tests hold the router to.
 */
function AuditAccessPolicy() {
  const [policy, setPolicy] = useState(null);
  useEffect(() => {
    api.auditAccessPolicy().then(setPolicy).catch(() => setPolicy(null));
  }, []);
  if (!policy) return null;
  const roles = Object.keys(policy[0]?.roles ?? {});
  const PILL = { no: 'neutral', yes: 'approved', 'own tenant': 'pending_approval', 'all tenants': 'approved' };
  return (
    <div className="card">
      <h2>Who can read the audit logs</h2>
      <p className="hint">
        Every route that serves audit data, the permission that guards it, and what each role gets. Worked out
        from the grants below, not written down twice — change a grant and this table changes. A route that
        serves audit data without being on this list fails the build.
      </p>
      <table>
        <thead>
          <tr><th>Audit route</th><th>Needs</th>{roles.map((r) => <th key={r}>{r}</th>)}</tr>
        </thead>
        <tbody>
          {policy.map((p) => (
            <tr key={p.route}>
              <td className="mono" title={p.why}>{p.route}{p.can === 'manage' ? ' · manage' : ''}</td>
              <td className="mono hint">{p.permission}</td>
              {roles.map((r) => (
                <td key={r}><span className={`pill ${PILL[p.roles[r]] ?? 'neutral'}`}>{p.roles[r]}</span></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
