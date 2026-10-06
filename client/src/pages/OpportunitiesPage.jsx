import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localDate, statusLabel } from '../labels.js';

const TYPE_LABEL = { podcast: 'podcast', speaking: 'speaking event', event: 'event', 'book-club': 'book club', festival: 'festival' };
const pct = (x) => `${Math.round(Number(x) * 100)}%`;

const TYPES = ['speaking', 'podcast', 'event'];

/** STORY-002 scenario 1: identify at least five opportunities a month, by type. */
export function OpportunitiesPage({ author }) {
  const [opportunities, setOpportunities] = useState([]);
  const [monthly, setMonthly] = useState([]);
  const [books, setBooks] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [rejections, setRejections] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [o, m, b, r] = await Promise.all([
      api.opportunities({ authorId: author.id }),
      api.monthlyOpportunities(author.id),
      api.books(author.id),
      api.opportunityRejections(author.id),
    ]);
    setOpportunities(o);
    setMonthly(m);
    setBooks(b);
    setRejections(r);
  }, [author.id]);

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, describe) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await fn();
      setStatus({ kind: 'ok', message: describe(result) });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const shown = typeFilter ? opportunities.filter((o) => o.type === typeFilter) : opportunities;
  const bookId = books[0]?.id;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Find opportunities</h2>
        <p className="hint">
          Search podcast, event and speaker directories for places that suit your book. Then let the app write a
          pitch for the best ones — you approve each pitch on the Outreach page before anything is sent.
        </p>
        <div className="row">
          <button disabled={busy || !bookId} onClick={() =>
            run(() => api.scout(author.id, bookId), (r) =>
              `Looked at ${r.scanned} listings: ${r.identified.length} new opportunit${r.identified.length === 1 ? 'y' : 'ies'} found, ${r.rejected.length} not a good fit.`)
          }>
            Search for opportunities
          </button>
          <button className="ghost" disabled={busy || !bookId} onClick={() =>
            run(() => api.scout(author.id, bookId, ['speaking']), (r) =>
              `Searched speaking events only: ${r.identified.length} new found out of ${r.scanned} listings.`)
          }>
            Speaking events only
          </button>
          <button className="ghost" disabled={busy || !bookId} onClick={() =>
            run(() => api.draftOutreach(author.id, bookId, { limit: 10 }), (r) =>
              `Wrote ${r.length} pitch${r.length === 1 ? '' : 'es'}. Read and approve them on the Outreach page.`)
          }>
            Write pitches for the best ones
          </button>
        </div>
      </div>

      <div className="card">
        <h2>What was found ({shown.length})</h2>
        <p className="hint">
          Each one fits either your book’s themes or you as an author. Hover over the fit to see why it was chosen.
        </p>

        <label htmlFor="type">Show</label>
        <select id="type" className="narrow" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>{TYPE_LABEL[type] ?? type}</option>
          ))}
        </select>

        {shown.length === 0 ? (
          <div className="empty">Nothing found yet. Press “Search for opportunities” above.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Type</th><th>Name</th><th>Host</th><th>Why it fits</th><th>Topics</th><th>Deadline</th><th>Pitch</th></tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td><span className="pill">{TYPE_LABEL[o.type] ?? o.type}</span></td>
                  <td><strong>{o.name}</strong></td>
                  <td>{o.host}</td>
                  <td title={o.rationale}>
                    <span className={`pill ${o.qualified_by === 'expertise' ? 'scheduled' : 'approved'}`}>
                      {o.qualified_by === 'expertise' ? 'Fits you as an author' : 'Fits your book'}
                    </span>
                    <div className="hint">book {pct(o.relevance)} · you {pct(o.expertise ?? 0)}</div>
                  </td>
                  <td>{[...(o.matched_themes ?? []), ...(o.expertise_matched ?? [])].join(', ') || '—'}</td>
                  <td>{o.deadline ? localDate(o.deadline) : '—'}</td>
                  <td>{o.message_status ? <span className={`pill ${o.message_status}`}>{statusLabel(o.message_status)}</span> : <span className="muted">not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <details className="card disclosure">
        <summary><h2>Monthly goal</h2></summary>
        <p className="hint">The aim is at least five good opportunities a month, of different kinds.</p>
        {monthly.length === 0 ? (
          <div className="empty">No searches yet.</div>
        ) : (
          <table>
            <thead><tr><th>Month</th><th>Found</th><th>Kinds</th><th>Goal</th></tr></thead>
            <tbody>
              {monthly.map((month) => (
                <tr key={month.discovered_month}>
                  <td>{new Date(month.discovered_month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</td>
                  <td>{month.total}</td>
                  <td>{Object.entries(month.breakdown).map(([type, n]) => `${n} ${TYPE_LABEL[type] ?? type}`).join(', ')}</td>
                  <td><span className={`pill ${month.meetsMinimum ? 'approved' : 'escalated'}`}>{month.meetsMinimum ? 'Met' : `Below goal (${month.minimum} needed)`}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      <details className="card disclosure">
        <summary><h2>Not a good fit ({rejections.length})</h2></summary>
        <p className="hint">
          Listings the search left out, and how close each came. Shown so you can check nothing good was missed.
        </p>
        {rejections.length === 0 ? (
          <div className="empty">Nothing left out yet.</div>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Name</th><th>Fit with your book</th><th>Fit with you</th><th>Topics</th></tr></thead>
            <tbody>
              {rejections.map((r) => (
                <tr key={r.id}>
                  <td><span className="pill">{TYPE_LABEL[r.type] ?? r.type}</span></td>
                  <td title={r.rationale}>{r.name}</td>
                  <td>{pct(r.relevance)} <span className="muted">(needs {pct(r.relevance_floor)})</span></td>
                  <td>{pct(r.expertise)} <span className="muted">(needs {pct(r.expertise_floor)})</span></td>
                  <td>{(r.topics ?? []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </>
  );
}
