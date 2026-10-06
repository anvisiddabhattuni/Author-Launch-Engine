import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { api, session, setSessionLostHandler } from './api.js';
import { AuditPage } from './pages/AuditPage.jsx';
import { AccessPage } from './pages/AccessPage.jsx';
import { AcceptInvitePage } from './pages/AcceptInvitePage.jsx';
import { TenantsPage } from './pages/TenantsPage.jsx';
import { SecurityPage } from './pages/SecurityPage.jsx';
import { ApiKeysPage } from './pages/ApiKeysPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { OpportunitiesPage } from './pages/OpportunitiesPage.jsx';
import { OutreachPage } from './pages/OutreachPage.jsx';
import { PressPage } from './pages/PressPage.jsx';
import { ReviewPage } from './pages/ReviewPage.jsx';
import { SchedulePage } from './pages/SchedulePage.jsx';
import { UploadPage } from './pages/UploadPage.jsx';
import { WorkerPage } from './pages/WorkerPage.jsx';
import { TemplatesPage } from './pages/TemplatesPage.jsx';
import { PerformancePage } from './pages/PerformancePage.jsx';
import { TrustPage } from './pages/TrustPage.jsx';
import { BillingPage } from './pages/BillingPage.jsx';
import { AttentionNotice } from './pages/TrustLive.jsx';
import { PageIntro, ROLE_LABEL, navGroups } from './navigation.jsx';

export function App() {
  const [user, setUser] = useState(null);
  const [author, setAuthor] = useState(null);
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  // A token in localStorage is a claim, not a session. Ask the API whether it
  // still accepts it rather than trusting what the browser kept.
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
      setAuthor(null);
      setBook(null);
    });

    if (!session.get()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => session.clear())
      .finally(() => setChecking(false));
  }, []);

  // The tenant comes from the session now. `authors()` returns exactly one row
  // for an author account — the days of taking authors[0] and calling it
  // "signed in" are what STORY-064 ended.
  useEffect(() => {
    if (!user) return;
    setError('');
    api
      .authors()
      .then(async (authors) => {
        const mine = authors.find((a) => a.id === user.authorId) ?? authors[0];
        if (!mine) {
          setError('This account is not attached to an author yet.');
          return;
        }
        setAuthor(mine);
        const books = await api.books(mine.id);
        setBook(books[0] ?? null);
      })
      .catch((e) => setError(`${e.message} — is the API running on port 4000?`));
  }, [user]);

  function signOut() {
    api.logout();
    setUser(null);
    setAuthor(null);
    setBook(null);
  }

  // The welcome email's link (STORY-043): no session yet, and it is not a
  // sign-in either — the author is choosing the password they will sign in with.
  if (window.location.pathname === '/accept-invite' && !user) {
    return <AcceptInvitePage onSignedIn={setUser} />;
  }
  if (checking) return <div className="shell" />;
  if (!user) return <LoginPage onSignedIn={setUser} />;

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Author Launch Engine</h1>
          <div className="story tagline">A launch companion for authors — social, outreach, press and trust</div>
        </div>
        <div className="account">
          <span className="account-name">{user.name}</span>
          <span className="pill" title={user.permissions?.join('\n')}>{ROLE_LABEL[user.role] ?? user.role}</span>
          {/* Reads the capability rather than the role name: `compliance` also
              spans every tenant (STORY-019). */}
          {user.permissions?.includes('tenant.read.all') && <span className="account-scope">sees all authors</span>}
          <button className="ghost small" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {navGroups(user).map((group) => (
          <div className="tab-group" key={group.label}>
            <span className="tab-group-label">{group.label}</span>
            {group.items.map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <PageIntro />

      {/* Someone who can look but not decide should know before they press a button. */}
      {user.permissions && !user.permissions.includes('content.approve') && (
        <p className="readonly-note" role="note">
          👁 You have <strong>view-only</strong> access: you can see everything, but you can’t approve or change things.
        </p>
      )}

      {error && <div className="banner error">{error}</div>}

      {/* STORY-057: what waits for this person, on every tab. */}
      {author && user.permissions?.includes('content.approve') && user.permissions?.includes('audit.read') && (
        <AttentionNotice authorId={author.id} />
      )}

      {author && (
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<UploadPage author={author} />} />
          <Route path="/review" element={<ReviewPage author={author} book={book} />} />
          <Route path="/schedule" element={<SchedulePage author={author} />} />
          <Route path="/opportunities" element={<OpportunitiesPage author={author} />} />
          <Route path="/outreach" element={<OutreachPage author={author} />} />
          <Route path="/press" element={<PressPage author={author} book={book} />} />
          <Route path="/worker" element={<WorkerPage user={user} />} />
          <Route path="/trust" element={<TrustPage author={author} user={user} />} />
          <Route
            path="/performance"
            element={<PerformancePage author={author} user={user} />}
          />
          <Route
            path="/templates"
            element={<TemplatesPage user={user} author={author} book={book} />}
          />
          <Route path="/audit" element={<AuditPage author={author} user={user} />} />
          <Route path="/access" element={<AccessPage user={user} />} />
          <Route path="/tenants" element={<TenantsPage user={user} />} />
          <Route path="/security" element={<SecurityPage user={user} />} />
          <Route path="/api-keys" element={<ApiKeysPage author={author} user={user} />} />
          <Route path="/billing" element={<BillingPage author={author} user={user} />} />
          <Route path="/accept-invite" element={<Navigate to="/upload" replace />} />
          <Route path="/login" element={<Navigate to="/upload" replace />} />
        </Routes>
      )}
    </div>
  );
}
