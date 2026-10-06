import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { localDate, localTime } from '../labels.js';

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

      {integrity && (
        <div className={`banner ${integrity.status === 'intact' ? 'ok' : integrity.status === 'altered' ? 'error' : ''}`}>
          {integrity.status === 'intact'
            ? 'History check passed — nothing in this record has been changed or removed since it was written.'
            : integrity.status === 'altered'
              ? `Warning: part of this history was changed after it was written (${integrity.breaks[0]?.finding}). Tell an admin.`
              : 'History check: nothing has been sealed yet, so there is nothing to check.'}
        </div>
      )}

      <div className="card">
        <h2>Everything that happened ({entries.length})</h2>
        <p className="hint">Newest first. Entries can’t be edited or deleted — not even by an admin.</p>

        {entries.length === 0 ? (
          <div className="empty">Nothing has been recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                {/* A session that reads every tenant's trail (STORY-019) needs to
                    see whose action each row is. */}
                {spansTenants && <th>Author</th>}
                <th>Who</th>
                <th>What happened</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="num">{localTime(entry.created_at)}</td>
                  {spansTenants && <td>{entry.author_id === null ? 'Whole system' : `Author ${entry.author_id}`}</td>}
                  <td>{entry.actor}</td>
                  <td>
                    {actionWords(entry.action)}
                    <div className="hint">{entry.entity_type?.replace(/_/g, ' ')} #{entry.entity_id}</div>
                  </td>
                  <td className="audit-detail mono">
                    {Object.entries(entry.metadata ?? {})
                      // Nested values printed as "[object Object]" — shown as JSON instead.
                      .map(([key, value]) => `${key}=${value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* STORY-028 */}
      <AuditReport spansTenants={spansTenants} authorId={author.id} />

      {integrity && (
        <details className="card disclosure">
          <summary><h2>Technical details — how the history is protected</h2></summary>
          {/* Prevention and detection are different claims (STORY-013): a
              trigger stops ordinary mutation; the seals detect anyone who
              switched it off. */}
          <p className="hint">
            The database refuses to edit or delete entries. Groups of entries are also “sealed” with a
            fingerprint (a hash) and re-checked, so a change made by going around the database would still be
            spotted. {integrity.unsealed > 0 && (
              <>
                <strong>{integrity.unsealed}</strong> newer entr{integrity.unsealed === 1 ? 'y is' : 'ies are'} not sealed yet.
              </>
            )}
          </p>
          {/* STORY-049: encrypted at rest, counted by the storage itself. */}
          {integrity.encryption && (
            <div className="meta" style={{ marginBottom: 10 }}>
              <span className={`pill ${Number(integrity.encryption.other_keys) + Number(integrity.encryption.unopened) === 0 ? 'approved' : 'escalated'}`}>
                {integrity.encryption.entries} entries stored encrypted
              </span>
              <span className="pill neutral">{integrity.encryption.cipher}</span>
              <span className="pill neutral mono">key {integrity.encryption.keyId}</span>
              {Number(integrity.encryption.other_keys) > 0 && (
                <span className="pill escalated">{integrity.encryption.other_keys} under another key</span>
              )}
              {Number(integrity.encryption.unopened) > 0 && (
                <span className="pill escalated">{integrity.encryption.unopened} won’t open — edited after writing</span>
              )}
            </div>
          )}
          {integrity.checkpoints?.length > 0 && (
            <table>
              <thead>
                <tr><th>Seal</th><th>Entries</th><th>Range</th><th>Fingerprint</th><th>Sealed</th></tr>
              </thead>
              <tbody>
                {integrity.checkpoints.slice(0, 6).map((c) => (
                  <tr key={c.id}>
                    <td className="mono">#{c.id}</td>
                    <td className="num">{c.row_count}</td>
                    <td className="mono">{c.from_id}–{c.to_id}</td>
                    <td className="mono">{c.digest}…</td>
                    <td className="num">{localTime(c.sealed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      )}
    </>
  );
}

/** "draft.revision_requested" → "Draft revision requested". */
export const actionWords = (action) => {
  const words = String(action ?? '').replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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
      <h2>Make a report</h2>
      <p className="hint">
        Pick dates to list everything that happened between them, and download it as a spreadsheet (CSV).
        Making a report is itself recorded.
      </p>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={generate}>
        <div className="row form-row">
          <div><label htmlFor="r-from">From</label><input id="r-from" type="date" value={form.from} onChange={set('from')} /></div>
          <div><label htmlFor="r-to">To</label><input id="r-to" type="date" value={form.to} onChange={set('to')} /></div>
          <div><label htmlFor="r-action">Kind of action <span className="label-hint">— optional</span></label><input id="r-action" placeholder="e.g. draft" value={form.action} onChange={set('action')} /></div>
          <div><label htmlFor="r-actor">Who <span className="label-hint">— optional</span></label><input id="r-actor" placeholder="exact name" value={form.actor} onChange={set('actor')} /></div>
          {spansTenants && <div><label htmlFor="r-tenant">Author number</label><input id="r-tenant" placeholder="all" value={form.tenant} onChange={set('tenant')} style={{ width: 90 }} /></div>}
          <button type="submit">Make report</button>
        </div>
      </form>
      {report && (
        <>
          <div className="meta" style={{ marginTop: 12 }}>
            <span className="pill">{report.summary.records} entries{report.summary.truncated ? ' (first 5,000)' : ''}</span>
            <span className="pill neutral">{localDate(report.period.from)} → {localDate(report.period.to)}</span>
            {Object.entries(report.summary.actorKinds).map(([k, n]) => <span key={k} className="pill neutral">{n} by {k === 'person' ? 'people' : k === 'agent' ? 'the app' : 'unknown names'}</span>)}
            <span className={`pill ${report.integrity === 'intact' ? 'approved' : report.integrity === 'altered' ? 'escalated' : 'neutral'}`}>history check: {report.integrity === 'intact' ? 'passed' : report.integrity}</span>
            <span className="pill neutral mono" title={`SHA-256 fingerprint of this report: ${report.digest}`}>fingerprint {report.digest.slice(0, 12)}…</span>
            <button className="ghost small" onClick={download}>Download spreadsheet (CSV)</button>
          </div>
          <div className="hint">Most common: {report.summary.byAction.slice(0, 6).map(([a, n]) => `${actionWords(a)} (${n})`).join(' · ')}</div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Author</th></tr></thead>
            <tbody>
              {report.records.slice(-30).reverse().map((r) => (
                <tr key={r.id}>
                  <td className="num">{localTime(r.created_at)}</td>
                  <td>
                    {r.actor}
                    <div className="hint">{r.actor_kind === 'person' ? `${r.actor_email} · ${r.actor_role}` : r.actor_kind === 'agent' ? 'done by the app' : 'no matching account'}</div>
                  </td>
                  <td>{actionWords(r.action)}<div className="hint">{r.entity_type?.replace(/_/g, ' ')} #{r.entity_id}</div></td>
                  <td>{r.tenant_name ?? (r.author_id ? `author ${r.author_id}` : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.records.length > 30 && <div className="hint">Showing the latest 30. The spreadsheet has all {report.records.length}.</div>}
        </>
      )}
    </div>
  );
}
