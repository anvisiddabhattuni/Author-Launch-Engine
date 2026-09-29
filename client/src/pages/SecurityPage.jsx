import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Tenant data access audit (STORY-044).
 *
 * Every request that touched tenant data, who made it, whose data it was and
 * how it ended. Accounts refused too often in a short window are flagged
 * here (and the admins emailed); an admin can block one, and it stops on its
 * next request.
 */
const OUTCOME_PILL = {
  allowed: 'approved',
  denied: 'escalated',
  unauthenticated: 'escalated',
  not_found: 'neutral',
  invalid: 'neutral',
  error: 'rejected',
};

const when = (v) => new Date(v).toISOString().slice(0, 19).replace('T', ' ');

export function SecurityPage({ user }) {
  // Filters can arrive in the URL — /security?outcome=refused — so a link in
  // an alert email opens on what it is about.
  const [filters, setFilters] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return { tenant: q.get('tenant') ?? '', user: q.get('user') ?? '', outcome: q.get('outcome') ?? '', hours: q.get('hours') ?? '24' };
  });
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const canBlock = Boolean(user?.permissions?.includes('access.manage'));

  const refresh = useCallback(async () => setData(await api.accessReport(filters)), [filters]);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function toggleBlock(f) {
    const blocking = f.active;
    const reason = blocking ? window.prompt(`Why block ${f.email}? (at least ten characters)`) : '';
    if (blocking && !reason) return;
    setBusy(true);
    setStatus(null);
    try {
      await (blocking ? api.blockAccount(f.user_id, reason) : api.unblockAccount(f.user_id));
      setStatus({ kind: 'ok', message: blocking ? `${f.email} is blocked — refused from their next request.` : `${f.email} can sign in again.` });
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;
  const t = data.totals;
  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {user?.permissions?.includes('audit.verify') && <AuditAlerts user={user} />}

      <div className="card">
        <h2>Flagged accounts ({data.flagged.length})</h2>
        <p className="hint">
          An account — or, with no session, an address — refused {data.threshold.refusals} times within{' '}
          {data.threshold.minutes} minutes is flagged, and every admin is emailed once.
        </p>
        {data.flagged.length === 0 ? (
          <div className="empty">Nobody has been flagged in the last {data.hours} hours.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Flagged (UTC)</th><th>Who</th><th>Refusals</th><th>Tried</th>{canBlock && <th />}</tr>
            </thead>
            <tbody>
              {data.flagged.map((f) => (
                <tr key={`${f.subject_key}-${f.created_at}`}>
                  <td className="mono">{when(f.created_at)}</td>
                  <td>
                    {f.email ?? f.metadata.subject}
                    {f.role && <span className="hint"> · {f.role}</span>}
                    {f.user_id && !f.active && <span className="pill rejected" style={{ marginLeft: 6 }}>blocked</span>}
                  </td>
                  <td className="mono">{f.metadata.refusals} in {f.metadata.windowMinutes} min</td>
                  <td className="mono hint">{(f.metadata.paths ?? []).slice(0, 3).join(', ')}</td>
                  {canBlock && (
                    <td>
                      {f.user_id && f.user_id !== String(user.id) && (
                        <button className={f.active ? 'danger' : 'ghost'} disabled={busy} onClick={() => toggleBlock(f)}>
                          {f.active ? 'Block account' : 'Unblock'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AuditLogAccess />

      <div className="card">
        <h2>Data access, last {data.hours} hours</h2>
        <div className="meta">
          <span className="pill neutral">{t.events} requests</span>
          <span className="pill approved">{t.allowed} allowed</span>
          <span className={`pill ${t.denied ? 'escalated' : 'approved'}`}>{t.denied} denied</span>
          <span className={`pill ${t.unauthenticated ? 'escalated' : 'approved'}`}>{t.unauthenticated} with no session</span>
          <span className="pill">{t.users} accounts · {t.tenants} tenants</span>
          <span className={`pill ${t.unattributed ? 'rejected' : 'approved'}`}>{t.unattributed} not traceable to a person</span>
          {data.recordingFailures > 0 && <span className="pill rejected">{data.recordingFailures} could not be recorded</span>}
        </div>

        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="f-tenant">Tenant</label>
            <select id="f-tenant" value={filters.tenant} onChange={set('tenant')}>
              <option value="">All</option>
              {data.byTenant.map((b) => <option key={b.author_id} value={b.author_id}>{b.name ?? `author ${b.author_id}`}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-outcome">Outcome</label>
            <select id="f-outcome" value={filters.outcome} onChange={set('outcome')}>
              <option value="">Any</option>
              <option value="refused">Refused (denied or no session)</option>
              <option value="allowed">Allowed</option>
              <option value="denied">Denied</option>
              <option value="unauthenticated">No session</option>
              <option value="not_found">Not found</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-hours">Window</label>
            <select id="f-hours" value={filters.hours} onChange={set('hours')}>
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
            </select>
          </div>
        </div>

        <table style={{ marginTop: 12 }}>
          <thead>
            <tr><th>When (UTC)</th><th>Who</th><th>Whose data</th><th>Request</th><th>Outcome</th><th>Read as</th></tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id}>
                <td className="mono">{when(e.occurred_at)}</td>
                <td>
                  {e.user_email ?? <span className="hint">no session · {e.ip}</span>}
                  {e.user_role && <span className="hint"> · {e.user_role}</span>}
                </td>
                <td>
                  {e.scope === 'tenant' ? (e.tenant_name ?? `author ${e.author_id}`) : <span className="hint">{e.scope === 'own_account' ? 'own account' : 'all tenants'}</span>}
                </td>
                <td className="mono">{e.method} {e.route}</td>
                <td>
                  <span className={`pill ${OUTCOME_PILL[e.outcome] ?? 'neutral'}`}>{e.outcome}</span>
                  {e.reason && <div className="hint">{e.reason}</div>}
                </td>
                <td className="mono hint">{e.db_role ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The security log (STORY-051): every attempt on an audit log, allowed or
 * refused — separate from the data access log, encrypted, reviewers only.
 * Opening this card is itself an attempt on an audit log, and is recorded.
 */
function AuditLogAccess() {
  const [log, setLog] = useState(null);
  const [refusedOnly, setRefusedOnly] = useState(false);
  useEffect(() => {
    api.securityLog({ outcome: refusedOnly ? 'refused' : '' }).then(setLog).catch(() => setLog(null));
  }, [refusedOnly]);
  if (!log) return null;
  const t = log.totals;
  return (
    <div className="card">
      <h2>Who tried to read the audit logs</h2>
      <div className="meta">
        <span className="pill neutral">{t.attempts} attempts, last {log.hours} hours</span>
        <span className="pill approved">{t.allowed} allowed</span>
        <span className={`pill ${t.refused ? 'escalated' : 'approved'}`}>{t.refused} refused</span>
        <span className="pill neutral">{t.people} people</span>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={refusedOnly} onChange={(e) => setRefusedOnly(e.target.checked)} />
          refused only
        </label>
      </div>
      <p className="hint">
        A separate security log, encrypted with the audit log&apos;s key and readable only here. Opening this card is
        itself recorded in it.
      </p>
      <table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>Tried</th><th>Outcome</th><th>From</th></tr></thead>
        <tbody>
          {log.entries.slice(0, 25).map((e) => (
            <tr key={e.id}>
              <td className="mono">{new Date(e.occurred_at).toISOString().slice(0, 19).replace('T', ' ')}</td>
              <td>
                {e.user_email ?? (e.api_key_id ? `API key #${e.api_key_id}` : 'no session')}
                {e.user_role && <span className="hint"> · {e.user_role}</span>}
              </td>
              <td className="mono">{e.route}</td>
              <td>
                <span className={`pill ${e.outcome === 'allowed' ? 'approved' : 'escalated'}`}>{e.outcome}</span>
                {e.reason && <div className="hint">{e.reason}</div>}
              </td>
              <td className="mono hint">{e.ip}{e.user_agent ? ` · ${e.user_agent.slice(0, 32)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Alerts to security officers (STORY-052): each refused attempt on the audit
 * logs, sent at once, later attempts from the same person folded in. Here an
 * officer acknowledges one, and an admin can block the account behind it.
 */
function AuditAlerts({ user }) {
  const [alerts, setAlerts] = useState(null);
  const [status, setStatus] = useState(null);
  const canBlock = Boolean(user?.permissions?.includes('access.manage'));
  const load = useCallback(async () => setAlerts(await api.securityNotifications()), []);
  useEffect(() => {
    load().catch(() => setAlerts([]));
  }, [load]);

  async function act(fn, message) {
    setStatus(null);
    try {
      await fn();
      setStatus({ kind: 'ok', message });
      await load();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    }
  }

  if (!alerts) return null;
  const open = alerts.filter((a) => !a.acknowledged_at);
  return (
    <div className="card">
      <h2>Alerts: refused attempts on the audit logs ({open.length} open)</h2>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}
      <p className="hint">
        The first refused attempt from a person or address emails every security officer at once, with the details.
        Attempts in the next 10 minutes join that alert rather than sending another.
      </p>
      {alerts.length === 0 ? (
        <div className="empty">No refused attempts on the audit logs.</div>
      ) : (
        <table>
          <thead><tr><th>First (UTC)</th><th>Who</th><th>Tried</th><th>Attempts</th><th>Told</th><th /></tr></thead>
          <tbody>
            {alerts.slice(0, 15).map((a) => (
              <tr key={a.id}>
                <td className="mono">{new Date(a.first_at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                <td>{a.subject_label}<div className="hint">{a.reason}</div></td>
                <td className="mono">{a.routes_tried.join(', ')}</td>
                <td className="mono">{a.attempts}</td>
                <td className="hint">
                  {a.delivered.length} of {a.recipients.length}
                  {a.failed.length > 0 && <span className="pill escalated"> {a.failed.length} failed</span>}
                </td>
                <td className="row">
                  {a.acknowledged_at ? (
                    <span className="pill neutral" title={a.note ?? ''}>acknowledged by {a.acknowledged_by}</span>
                  ) : (
                    <button className="ghost" onClick={() => act(() => api.acknowledgeNotification(a.id, window.prompt('Note (optional)') ?? ''), 'Acknowledged.')}>
                      Acknowledge
                    </button>
                  )}
                  {canBlock && a.user_id && Number(a.user_id) !== Number(user.id) && (
                    <button
                      className="danger"
                      onClick={() => {
                        const reason = window.prompt(`Why block ${a.subject_label}? (at least ten characters)`);
                        if (reason) act(() => api.blockAccount(a.user_id, reason), 'Blocked — refused from their next request.');
                      }}
                    >
                      Block
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
