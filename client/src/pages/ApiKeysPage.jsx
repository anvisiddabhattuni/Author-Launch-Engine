import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Per-tenant API keys (STORY-045).
 *
 * For an integration that needs this tenant's data without a person's
 * password. A key is shown once, stored only as a hash, works inside this
 * tenant only, expires, and can never approve content.
 */
const when = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : '—');
const STATUS_PILL = { live: 'approved', expired: 'neutral', revoked: 'rejected' };

export function ApiKeysPage({ author, user }) {
  const [keys, setKeys] = useState(null);
  const [form, setForm] = useState({ name: '', access: 'read', expiresInDays: '90' });
  const [created, setCreated] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const own = Number(user.authorId) === Number(author.id);

  const refresh = useCallback(async () => setKeys(await api.apiKeys(author.id)), [author.id]);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, onDone) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await fn();
      onDone?.(result);
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  function create(event) {
    event.preventDefault();
    run(
      () => api.createApiKey(author.id, { name: form.name.trim(), access: form.access, expiresInDays: Number(form.expiresInDays) }),
      (result) => {
        setCreated(result);
        setForm({ ...form, name: '' });
      },
    );
  }

  if (!keys) return <div className="card"><div className="empty">Loading…</div></div>;
  const live = keys.filter((k) => k.status === 'live');

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Create an API key{own ? '' : ` for ${author.name}`}</h2>
        <p className="hint">
          For software that needs {own ? 'your' : `${author.name}'s`} data — a newsletter sync, an upload
          script — without anyone&apos;s password. A key works only inside this account, acts on behalf of
          whoever creates it, expires, and <strong>can never approve content</strong>: approval stays with people.
        </p>
        <form onSubmit={create}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 2, minWidth: 200 }}>
              <label htmlFor="key-name">What it is for</label>
              <input id="key-name" value={form.name} placeholder="e.g. Newsletter sync" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="key-access">Access</label>
              <select id="key-access" value={form.access} onChange={(e) => setForm({ ...form, access: e.target.value })}>
                <option value="read">Read only</option>
                <option value="read_write">Read and submit</option>
              </select>
            </div>
            <div>
              <label htmlFor="key-days">Expires after</label>
              <select id="key-days" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </div>
            <button type="submit" disabled={busy || !form.name.trim()}>Create key</button>
          </div>
        </form>

        {created && (
          <div className="banner ok" style={{ marginTop: 14 }}>
            <div>
              <strong>Copy this key now — it will not be shown again.</strong> Only a fingerprint of it is stored,
              so nobody, including us, can show it to you later.
            </div>
            <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{created.key}</div>
            <div className="hint" style={{ marginTop: 6 }}>
              Send it as <span className="mono">X-API-Key: {created.key.slice(0, 17)}…</span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Keys ({live.length} live)</h2>
        <p className="hint">
          Every request a key makes is on the Security and Trust tabs, marked with the key. Revoking stops it on
          its next request; so does blocking the person it acts for, or suspending the account.
        </p>
        {keys.length === 0 ? (
          <div className="empty">No keys yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Key</th><th>For</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="mono">ale_{k.prefix}_…</td>
                  <td>{k.name}<div className="hint">by {k.createdBy ?? 'staff'}</div></td>
                  <td>{k.access === 'read' ? 'read only' : 'read and submit'}</td>
                  <td className="mono">{when(k.createdAt)}</td>
                  <td className="mono">{when(k.lastUsedAt)}</td>
                  <td className="mono">{when(k.expiresAt)}</td>
                  <td><span className={`pill ${STATUS_PILL[k.status]}`}>{k.status}</span></td>
                  <td>
                    {k.status === 'live' && (
                      <button className="danger" disabled={busy} onClick={() => run(() => api.revokeApiKey(author.id, k.id))}>
                        Revoke
                      </button>
                    )}
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
