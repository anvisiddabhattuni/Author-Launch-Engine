import { useEffect, useRef, useState } from 'react';

import { api } from '../api.js';
import './book.css';

/**
 * The front door: a closed book titled "Author Launch Engine". Opening it swings
 * the cover to the left, where its inside carries a short welcome, and the sign-in
 * form is printed on the first page. `/` starts closed; `/login` starts open, so a
 * link, a refresh or an automated check goes straight to the form.
 *
 * STORY-064: the sign-in itself. Every approval is recorded against the account
 * that made it; without a session the API returns 401.
 */
export function LoginPage({ onSignedIn }) {
  const startsOpen = typeof window !== 'undefined' && window.location.pathname !== '/';
  const [open, setOpen] = useState(startsOpen);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Once open, the address says so: a refresh stays on the page, not the cover.
    if (window.location.pathname === '/') window.history.replaceState(null, '', '/login');
    const t = setTimeout(() => emailRef.current?.focus({ preventScroll: true }), startsOpen ? 0 : 900);
    return () => clearTimeout(t);
  }, [open, startsOpen]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await api.login(email, password));
    } catch (e) {
      setError(e instanceof TypeError ? `${e.message} — is the API running on port 4000?` : e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`book-stage${open ? ' is-open' : ''}`}>
      <div className="book" aria-live="polite">
        {/* The first page: the sign-in form. */}
        <section className="page page-right" aria-hidden={!open}>
          <div className="page-inner">
            <p className="folio">Chapter one</p>
            <h2>Sign in</h2>
            <p className="page-lede">Pick up where your launch left off.</p>

            {error && <div className="paper-banner" role="alert">{error}</div>}

            <form onSubmit={submit}>
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                ref={emailRef}
                type="email"
                autoComplete="username"
                value={email}
                tabIndex={open ? 0 : -1}
                onChange={(e) => setEmail(e.target.value)}
              />

              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                tabIndex={open ? 0 : -1}
                onChange={(e) => setPassword(e.target.value)}
              />

              <button type="submit" className="paper-button" tabIndex={open ? 0 : -1} disabled={busy || !email.trim() || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <p className="page-note">
              New here? Your publisher sends an invitation — follow the link in that email to choose your password.
            </p>

            {/* STORY-030: the published demo passwords, only where they are the
                passwords. The production build sets VITE_SHOW_DEMO_LOGINS=false. */}
            {import.meta.env.VITE_SHOW_DEMO_LOGINS !== 'false' && (
              <details className="demo-logins">
                <summary>Demo accounts</summary>
                <table>
                  <tbody>
                    <tr><td className="mono">mira@example.test</td><td className="mono">quiet-craft</td><td>an author</td></tr>
                    <tr><td className="mono">tomas@example.test</td><td className="mono">second-shelf</td><td>another author</td></tr>
                    <tr><td className="mono">ops@example.test</td><td className="mono">ops-password</td><td>admin</td></tr>
                    <tr><td className="mono">auditor@example.test</td><td className="mono">compliance-only</td><td>read-only</td></tr>
                  </tbody>
                </table>
              </details>
            )}
            <p className="page-number">1</p>
          </div>
        </section>

        {/* The cover: front shows the title; its inside becomes the left page. */}
        <div className="cover">
          <button
            type="button"
            className="cover-front"
            onClick={() => setOpen(true)}
            disabled={open}
            aria-label="Open the book to sign in"
          >
            <span className="cover-frame">
              <span className="cover-kicker">A launch companion for authors</span>
              <span className="cover-title">
                <span>Author</span>
                <span>Launch</span>
                <span>Engine</span>
              </span>
              <span className="cover-rule" aria-hidden="true" />
              <span className="cover-tagline">Social · Outreach · Press · Trust</span>
            </span>
          </button>
          <div className="cover-back" aria-hidden={!open}>
            <div className="page-inner">
              <p className="folio">Frontispiece</p>
              <blockquote>
                Every post drafted from your book, in your voice — and nothing goes out until a person says yes.
              </blockquote>
              <ul className="endpaper-list">
                <li><span>Write</span> drafts grounded in your book’s themes</li>
                <li><span>Review</span> everything before it leaves</li>
                <li><span>Reach</span> podcasts, events and press</li>
                <li><span>Trust</span> an audit trail for every decision</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {!open && (
        <button type="button" className="open-hint" onClick={() => setOpen(true)}>
          Open the book
        </button>
      )}
    </main>
  );
}
