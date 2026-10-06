import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime } from '../labels.js';

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

const when = localTime;
const STATUS_WORD = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn', bootstrap: 'Set up at start' };

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
          These requests haven’t changed anything yet. A <strong>different</strong> admin from the one who asked must
          approve each one; once approved, it takes effect straight away.
          {data.approvers < 2 && (
            <strong> Only {data.approvers} person can approve changes right now, so nothing can be approved until a second admin is added.</strong>
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
                  <span className="pill pending_approval">Waiting</span>
                  <strong>{describe(c)}</strong>
                </div>
                <div className="hint">
                  “{c.reason}” — asked by {c.requested_by_name} at {when(c.requested_at)}
                </div>
                {canManage && (
                  <div className="row">
                    {mine ? (
                      <>
                        <span className="pill neutral">You asked — another admin decides</span>
                        <button className="ghost" disabled={busy} onClick={() => run(() => api.withdrawAccessChange(c.id), 'Request withdrawn. Nothing changed.')}>Withdraw</button>
                      </>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => run(() => api.approveAccessChange(c.id), 'Approved. The change is now in effect.')}>Approve</button>
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
          <h2>Ask for a change</h2>
          <p className="hint">Another admin will need to approve it.</p>
          <label htmlFor="ac-kind">What kind of change</label>
          <div className="row">
            <select id="ac-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="grant_permission">Grant a permission to a role</option>
              <option value="revoke_permission">Revoke a permission from a role</option>
              <option value="assign_role">Give an account a role</option>
            </select>
          </div>
          {form.kind === 'assign_role' ? (
            <div className="row form-row">
              <div><label htmlFor="ac-user">Account number</label><input id="ac-user" placeholder="e.g. 4" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} />
</div>
              <div><label htmlFor="ac-newrole">New role</label><select id="ac-newrole" value={form.newRole} onChange={(e) => setForm({ ...form, newRole: e.target.value })}>
                {data.matrix.map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
              </select></div>
            </div>
          ) : (
            <div className="row form-row">
              <div><label htmlFor="ac-role">Role</label><select id="ac-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {data.matrix.map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
              </select></div>
              <div><label htmlFor="ac-perm">Permission</label><select id="ac-perm" value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
                <option value="">Choose…</option>
                {allPermissions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></div>
            </div>
          )}
          <label htmlFor="ac-reason">Why is this needed? <span className="label-hint">— at least 10 characters; it’s kept in the activity history</span></label>
          <input id="ac-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <div className="row" style={{ marginTop: 12 }}><button type="submit" disabled={busy || form.reason.trim().length < 10}>Send request</button></div>
        </form>
      )}

      <AuditAccessPolicy />

      <div className="card">
        <h2>Roles and what each can do</h2>
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

        <h3>People with extra access</h3>
        <table>
          <thead><tr><th>Account</th><th>Role</th><th>How they got it</th></tr></thead>
          <tbody>
            {data.elevated.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="hint">{u.email} · account {u.id}</div></td>
                <td>{u.role}</td>
                <td>
                  {u.how === 'approved' ? <span className="pill approved">Approved request</span>
                    : u.how === 'bootstrap' ? <span className="pill neutral">Set up at the start</span>
                      : <span className="pill escalated">Nobody approved this — check it</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Past requests ({decided.length})</h2>
        <table>
          <thead><tr><th>Change</th><th>Asked by</th><th>Decided by</th><th>Status</th></tr></thead>
          <tbody>
            {decided.map((c) => (
              <tr key={c.id}>
                <td>{describe(c)}<div className="hint">“{c.reason}”</div></td>
                <td>{c.requested_by_name ?? '—'}<div className="hint">{when(c.requested_at)}</div></td>
                <td>{c.decided_by_name ?? '—'}<div className="hint">{when(c.decided_at)}</div></td>
                <td><span className={`pill ${STATUS[c.status] ?? ''}`}>{STATUS_WORD[c.status] ?? c.status}</span></td>
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
    <details className="card disclosure">
      <summary><h2>Who can see the activity history</h2></summary>
      <p className="hint">
        Worked out from the roles below, so it is always up to date. Technical: each row is one place the
        activity history can be read from, and the permission it needs.
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
    </details>
  );
}
