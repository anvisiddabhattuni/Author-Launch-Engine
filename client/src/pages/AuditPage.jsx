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
                      .map(([key, value]) => `${key}=${value}`)
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
