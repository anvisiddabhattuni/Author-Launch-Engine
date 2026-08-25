import { useState } from 'react';

import { api } from '../api.js';

/**
 * STORY-064: the sign-in the rest of the app has been assuming since STORY-001.
 *
 * The masthead used to read "Signed in as …" over whichever author happened to
 * be first in the database. Nobody had signed in; there was nothing to sign in
 * to. Every approval recorded a name somebody typed into a box.
 */
export function LoginPage({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await api.login(email, password));
    } catch (e) {
      // A request that never reached the server rejects in fetch itself, with a
      // message ("Failed to fetch") that says nothing about why. App.jsx already
      // points at the likely cause; the sign-in screen is where someone hits it
      // first, so it says the same thing here.
      setError(
        e instanceof TypeError ? `${e.message} — is the API running on port 4000?` : e.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Author Launch Engine</h1>
          <div className="story">STORY-064 · Login and basic permissions</div>
        </div>
      </header>

      <div className="card" style={{ maxWidth: 460 }}>
        <h2>Sign in</h2>
        <p className="hint">
          Every approval is recorded against the account that made it. Without a session the API
          returns 401 and nothing can be drafted, published or approved.
        </p>

        {error && <div className="banner error">{error}</div>}

        <form onSubmit={submit}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <div className="row" style={{ marginTop: 14 }}>
            <button type="submit" disabled={busy || !email.trim() || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>

        <p className="hint" style={{ marginTop: 18 }}>
          Seeded demo logins — these are printed by <span className="mono">npm run db:reset</span>{' '}
          and are not secret:
        </p>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Password</th>
              <th>Sees</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">mira@example.test</td>
              <td className="mono">quiet-craft</td>
              <td>Her own work only</td>
            </tr>
            <tr>
              <td className="mono">tomas@example.test</td>
              <td className="mono">second-shelf</td>
              <td>A different tenant</td>
            </tr>
            <tr>
              <td className="mono">ops@example.test</td>
              <td className="mono">ops-password</td>
              <td>All tenants (admin)</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
