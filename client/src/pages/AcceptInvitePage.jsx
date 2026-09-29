import { useState } from 'react';

import { api } from '../api.js';

/**
 * Where the welcome email's link lands (STORY-043). The author chooses their
 * own password and is signed in. No session is needed to get here — the link
 * is the credential, once.
 */
export function AcceptInvitePage({ onSignedIn }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 10;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api.acceptInvite(token, password);
      window.history.replaceState(null, '', '/upload');
      onSignedIn(user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Author Launch Engine</h1>
          <div className="story">STORY-043 · Welcome</div>
        </div>
      </header>

      <div className="card" style={{ maxWidth: 460 }}>
        <h2>Choose your password</h2>
        <p className="hint">
          Your account and your own private workspace are ready. Nobody else — including whoever set
          this up — knows this password or can see it. This link works once.
        </p>

        {!token && <div className="banner error">This link is incomplete. Use the full link from your welcome email.</div>}
        {error && <div className="banner error">{error}</div>}

        <form onSubmit={submit}>
          <label htmlFor="invite-password">Password (at least 10 characters)</label>
          <input
            id="invite-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {tooShort && <div className="hint">{10 - password.length} more characters.</div>}

          <label htmlFor="invite-confirm">The same again</label>
          <input
            id="invite-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <div className="hint">These do not match yet.</div>}

          <div className="row" style={{ marginTop: 14 }}>
            <button type="submit" disabled={busy || !token || password.length < 10 || confirm !== password}>
              {busy ? 'Setting up…' : 'Set password and sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
