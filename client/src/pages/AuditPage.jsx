import { useEffect, useState } from 'react';

import { api } from '../api.js';

/** REQ-005: the append-only record of every action, agent or human. */
export function AuditPage({ author, user }) {
  const [entries, setEntries] = useState([]);
  const [integrity, setIntegrity] = useState(null);
  const [error, setError] = useState('');

  // STORY-019: a compliance session reads every tenant's trail. This page used
  // to pin every request to one author id, so the role existed in the API and
  // was invisible here — the permission was real and the page still showed one
  // tenant's rows.
  const spansTenants = Boolean(user?.permissions?.includes('tenant.read.all'));
  const canVerify = Boolean(user?.permissions?.includes('audit.verify'));

  useEffect(() => {
    api
      .auditLog(spansTenants ? null : author.id, 200)
      .then(setEntries)
      .catch((e) => setError(e.message));
    // Only a session holding audit.verify may ask, so only that session does.
    // This used to ask anyway and swallow the 403 — no panel, but a refused
    // request in the console on every visit, which the STORY-031 browser check
    // reported as an error. Asking for what you know you cannot have is noise
    // in exactly the log someone reads when something is actually wrong.
    if (canVerify) api.auditIntegrity().then(setIntegrity).catch(() => {});
  }, [author.id, spansTenants, canVerify]);

  return (
    <>
      {error && <div className="banner error">{error}</div>}

      {/* STORY-028 */}
      <AuditReport spansTenants={spansTenants} authorId={author.id} />

      {integrity && (
        <div className="card">
          <h2>Integrity</h2>
          {/* Prevention and detection are different claims, and the page used to
              make only the first one. A trigger stops ordinary mutation; it says
              nothing about whether anyone switched it off (STORY-013). */}
          <div
            className={`banner ${integrity.status === 'intact' ? 'ok' : integrity.status === 'altered' ? 'error' : ''}`}
          >
            {integrity.status === 'intact'
              ? `Verified. ${integrity.checked} sealed range${integrity.checked === 1 ? '' : 's'} still hash to what they did when they were written.`
              : integrity.status === 'altered'
                ? `History was rewritten. ${integrity.breaks[0]?.finding} — checkpoint ${integrity.breaks[0]?.checkpoint}, rows ${integrity.breaks[0]?.range?.join('–')}.`
                : 'Nothing sealed yet, so nothing can be verified — which is not the same as intact.'}
          </div>
          <p className="hint">
            The triggers below stop ordinary mutation. They cannot stop somebody who disables them,
            and on their own they leave no evidence either way. Each sealed range is hashed and
            re-checked, so a row altered, removed or slipped in afterwards is detectable even when
            the log still refuses every ordinary write. {integrity.unsealed > 0 && (
              <>
                <strong>{integrity.unsealed}</strong> newer row
                {integrity.unsealed === 1 ? ' is' : 's are'} not sealed yet.
              </>
            )}
          </p>
          {/* STORY-049: encrypted at rest, counted by the storage itself. */}
          {integrity.encryption && (
            <div className="meta" style={{ marginBottom: 10 }}>
              <span className={`pill ${Number(integrity.encryption.other_keys) + Number(integrity.encryption.unopened) === 0 ? 'approved' : 'escalated'}`}>
                {integrity.encryption.entries} entries encrypted at rest
              </span>
              <span className="pill neutral">{integrity.encryption.cipher}</span>
              <span className="pill neutral mono">key {integrity.encryption.keyId}</span>
              {Number(integrity.encryption.other_keys) > 0 && (
                <span className="pill escalated">{integrity.encryption.other_keys} under another key</span>
              )}
              {Number(integrity.encryption.unopened) > 0 && (
                <span className="pill escalated">{integrity.encryption.unopened} do not open — edited after writing</span>
              )}
            </div>
          )}
          {integrity.checkpoints?.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Seal</th>
                  <th>Rows</th>
                  <th>Range</th>
                  <th>Digest</th>
                  <th>Sealed</th>
                </tr>
              </thead>
              <tbody>
                {integrity.checkpoints.slice(0, 6).map((c) => (
                  <tr key={c.id}>
                    <td className="mono">#{c.id}</td>
                    <td className="mono">{c.row_count}</td>
                    <td className="mono">
                      {c.from_id}–{c.to_id}
                    </td>
                    <td className="mono">{c.digest}…</td>
                    <td className="mono">{String(c.sealed_at).slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card">
        <h2>Audit log ({entries.length})</h2>
        <p className="hint">
          Append-only, enforced by database triggers: UPDATE, DELETE and TRUNCATE are all rejected, so
          this history cannot be rewritten from the app or from a direct SQL session.
        </p>

        {entries.length === 0 ? (
          <div className="empty">No actions recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When (UTC)</th>
                {/* Only meaningful once a session can span tenants (STORY-019).
                    A compliance officer reading every tenant's trail cannot
                    tell whose action a row is without it — the column is the
                    difference between a log and a pile of verbs. */}
                {spansTenants && <th>Tenant</th>}
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{new Date(entry.created_at).toISOString().replace('T', ' ').slice(0, 19)}</td>
                  {spansTenants && (
                    <td className="mono">
                      {/* Null is not missing data: a global sweep belongs to no
                          tenant. Saying so beats an empty cell. */}
                      {entry.author_id === null ? 'system' : `author ${entry.author_id}`}
                    </td>
                  )}
                  <td>{entry.actor}</td>
                  <td className="mono">{entry.action}</td>
                  <td className="mono">
                    {entry.entity_type} {entry.entity_id}
                  </td>
                  <td className="mono">
                    {Object.entries(entry.metadata ?? {})
                      // Nested values printed as "[object Object]" (seen on
                      // STORY-043's tenant.onboarded row) — shown as JSON instead.
                      .map(([key, value]) => `${key}=${value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * Audit log reports (STORY-028): every action in a period, with its time and
 * who did it, summarised, with the digest that proves the download is the
 * report, and the seal status when it was made.
 */
export function AuditReport({ spansTenants, authorId }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [form, setForm] = useState({ from: monthAgo, to: today, action: '', actor: '', tenant: '' });
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const params = () => ({
    from: `${form.from}T00:00:00Z`,
    to: `${form.to}T23:59:59Z`,
    action: form.action.trim(),
    actor: form.actor.trim(),
    authorId: spansTenants ? form.tenant : authorId,
  });
  async function generate(event) {
    event.preventDefault();
    setError('');
    try {
      setReport(await api.auditReport(params()));
    } catch (e) {
      setError(e.message);
    }
  }
  async function download() {
    const { text, filename } = await api.auditReportCsv(params());
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="card">
      <h2>Audit log report</h2>
      <p className="hint">
        Every action in a period, with its time and who did it — a person (with their account), an agent, or a name
        no account has. Each report carries a SHA-256 of its records and the seal status when it was made, and is
        itself on the audit log.
      </p>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={generate}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div><label htmlFor="r-from">From</label><input id="r-from" type="date" value={form.from} onChange={set('from')} /></div>
          <div><label htmlFor="r-to">To</label><input id="r-to" type="date" value={form.to} onChange={set('to')} /></div>
          <div><label htmlFor="r-action">Action starts with</label><input id="r-action" placeholder="e.g. draft." value={form.action} onChange={set('action')} /></div>
          <div><label htmlFor="r-actor">Actor</label><input id="r-actor" placeholder="exact name" value={form.actor} onChange={set('actor')} /></div>
          {spansTenants && <div><label htmlFor="r-tenant">Tenant id</label><input id="r-tenant" placeholder="all" value={form.tenant} onChange={set('tenant')} style={{ width: 90 }} /></div>}
          <button type="submit">Generate report</button>
        </div>
      </form>
      {report && (
        <>
          <div className="meta" style={{ marginTop: 12 }}>
            <span className="pill">{report.summary.records} records{report.summary.truncated ? ' (first 5,000)' : ''}</span>
            <span className="pill neutral">{report.period.from.slice(0, 10)} → {report.period.to.slice(0, 10)}</span>
            {Object.entries(report.summary.actorKinds).map(([k, n]) => <span key={k} className="pill neutral">{n} by {k === 'person' ? 'people' : k === 'agent' ? 'agents' : 'unmatched names'}</span>)}
            <span className={`pill ${report.integrity === 'intact' ? 'approved' : report.integrity === 'altered' ? 'escalated' : 'neutral'}`}>seals: {report.integrity}</span>
            <span className="pill neutral mono" title={report.digest}>sha256 {report.digest.slice(0, 16)}…</span>
            <button className="ghost" onClick={download}>Download CSV</button>
          </div>
          <div className="hint">Most frequent: {report.summary.byAction.slice(0, 6).map(([a, n]) => `${a} (${n})`).join(' · ')}</div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>On</th><th>Tenant</th></tr></thead>
            <tbody>
              {report.records.slice(-30).reverse().map((r) => (
                <tr key={r.id}>
                  <td className="mono">{new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                  <td>
                    {r.actor}
                    <div className="hint">{r.actor_kind === 'person' ? `${r.actor_email} · ${r.actor_role}` : r.actor_kind === 'agent' ? 'agent' : 'no matching account'}</div>
                  </td>
                  <td className="mono">{r.action}</td>
                  <td className="mono">{r.entity_type} {r.entity_id}</td>
                  <td>{r.tenant_name ?? (r.author_id ? `author ${r.author_id}` : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.records.length > 30 && <div className="hint">Showing the latest 30; the CSV has all {report.records.length}.</div>}
        </>
      )}
    </div>
  );
}
