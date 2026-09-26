import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { api, session, setSessionLostHandler } from './api.js';
import { AuditPage } from './pages/AuditPage.jsx';
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

  if (checking) return <div className="shell" />;
  if (!user) return <LoginPage onSignedIn={setUser} />;

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Author Launch Engine</h1>
          <div className="story">
            STORY-001 · Social content &nbsp;·&nbsp; STORY-002 · Outreach &nbsp;·&nbsp; STORY-003 ·
            Press materials
          </div>
        </div>
        <div className="story">
          Signed in as <strong>{user.name}</strong>
          <span className="pill" style={{ marginLeft: 8 }}>{user.role}</span>
          {/* Reads the capability rather than the role name: `compliance` also
              spans every tenant, and "all tenants" said about an admin only
              would be wrong for them (STORY-019). */}
          {user.permissions?.includes('tenant.read.all') && (
            <span className="mono"> · all tenants</span>
          )}
          {user.permissions?.length > 0 && (
            <span className="mono" title={user.permissions.join('\n')}>
              {' '}· {user.permissions.length} permissions
            </span>
          )}
          <button className="link" onClick={signOut} style={{ marginLeft: 12 }}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {[
          ['/upload', 'Upload'],
          ['/review', 'Social · review'],
          ['/schedule', 'Social · schedule'],
          ['/opportunities', 'Opportunities'],
          ['/outreach', 'Outreach'],
          ['/press', 'Press'],
          ['/worker', 'Worker'],
          ['/templates', 'Meme templates'],
          ['/performance', 'Performance'],
          ['/trust', 'Trust'],
          ['/audit', 'Audit log'],
        ].map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : undefined)}>
            {label}
          </NavLink>
        ))}
      </nav>

      {error && <div className="banner error">{error}</div>}

      {author && (
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<UploadPage author={author} />} />
          <Route path="/review" element={<ReviewPage author={author} book={book} />} />
          <Route path="/schedule" element={<SchedulePage author={author} />} />
          <Route path="/opportunities" element={<OpportunitiesPage author={author} />} />
          <Route path="/outreach" element={<OutreachPage author={author} />} />
          <Route path="/press" element={<PressPage author={author} book={book} />} />
          <Route path="/worker" element={<WorkerPage />} />
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
        </Routes>
      )}
    </div>
  );
}
