import { useEffect, useState } from 'react';

import { api } from '../api.js';

/** REQ-005: the append-only record of every action, agent or human. */
export function AuditPage({ author }) {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .auditLog(author.id, 200)
      .then(setEntries)
      .catch((e) => setError(e.message));
  }, [author.id]);

  return (
    <>
      {error && <div className="banner error">{error}</div>}

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
