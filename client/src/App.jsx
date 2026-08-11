import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { api } from './api.js';
import { AuditPage } from './pages/AuditPage.jsx';
import { ReviewPage } from './pages/ReviewPage.jsx';
import { SchedulePage } from './pages/SchedulePage.jsx';
import { UploadPage } from './pages/UploadPage.jsx';

export function App() {
  const [author, setAuthor] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .authors()
      .then((authors) => {
        if (authors.length === 0) {
          setError('No author found. Run `npm run db:reset` to seed the demo data.');
          return;
        }
        setAuthor(authors[0]);
      })
      .catch((e) => setError(`${e.message} — is the API running on port 4000?`));
  }, []);

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Author Launch Engine</h1>
          <div className="story">STORY-001 · Draft and Schedule Social Media Content</div>
        </div>
        {author && (
          <div className="story">
            Signed in as <strong>{author.name}</strong>
          </div>
        )}
      </header>

      <nav className="tabs">
        {[
          ['/upload', '1 · Upload'],
          ['/review', '2 · Review & approve'],
          ['/schedule', '3 · Schedule'],
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
          <Route path="/review" element={<ReviewPage author={author} />} />
          <Route path="/schedule" element={<SchedulePage author={author} />} />
          <Route path="/audit" element={<AuditPage author={author} />} />
        </Routes>
      )}
    </div>
  );
}
