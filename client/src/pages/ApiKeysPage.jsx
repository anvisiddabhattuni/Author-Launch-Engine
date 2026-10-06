import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localDate } from '../labels.js';

/**
 * Per-tenant API keys (STORY-045).
 *
 * For an integration that needs this tenant's data without a person's
 * password. A key is shown once, stored only as a hash, works inside this
 * tenant only, expires, and can never approve content.
 */
const STATUS_PILL = { live: 'approved', expired: 'neutral', revoked: 'rejected' };
const KEY_LABEL = { live: 'Working', expired: 'Expired', revoked: 'Turned off' };

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
          A key lets another program — say, a newsletter tool — use {own ? 'your' : `${author.name}’s`} account
          without a password. It stops working on the date you choose, and it <strong>can never approve posts</strong> —
          only people can do that.
        </p>
        <form onSubmit={create}>
          <div className="row form-row">
            <div style={{ flex: 2, minWidth: 200 }}>
              <label htmlFor="key-name">What it is for</label>
              <input id="key-name" value={form.name} placeholder="e.g. Newsletter sync" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="key-access">What it may do</label>
              <select id="key-access" value={form.access} onChange={(e) => setForm({ ...form, access: e.target.value })}>
                <option value="read">Look only</option>
                <option value="read_write">Look and add things</option>
              </select>
            </div>
            <div>
              <label htmlFor="key-days">Stops working after</label>
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
              <strong>Copy this key now — it won’t be shown again.</strong> The app doesn’t keep a readable copy,
              so nobody can show it to you later.
            </div>
            <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{created.key}</div>
            <div className="hint" style={{ marginTop: 6 }}>
              For the person setting it up: send it in the <span className="mono">X-API-Key</span> header.
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Your keys ({live.length} working)</h2>
        <p className="hint">
          Turning a key off takes effect straight away. Everything a key does is recorded in the activity history.
        </p>
        {keys.length === 0 ? (
          <div className="empty">No keys yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>May</th><th>Last used</th><th>Stops working</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}<div className="hint">made by {k.createdBy ?? 'staff'} on {localDate(k.createdAt)} · <span className="mono">ale_{k.prefix}_…</span></div></td>
                  <td>{k.access === 'read' ? 'Look only' : 'Look and add'}</td>
                  <td>{k.lastUsedAt ? localDate(k.lastUsedAt) : 'Never'}</td>
                  <td>{localDate(k.expiresAt)}</td>
                  <td><span className={`pill ${STATUS_PILL[k.status]}`}>{KEY_LABEL[k.status] ?? k.status}</span></td>
                  <td className="cell-action">
                    {k.status === 'live' && (
                      <button className="danger" disabled={busy} onClick={() => run(() => api.revokeApiKey(author.id, k.id))}>
                        Turn off
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
