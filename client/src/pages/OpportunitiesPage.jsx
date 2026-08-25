import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

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
        <h2>Monthly discovery</h2>
        <p className="hint">
          Acceptance criterion: at least five relevant opportunities identified per month,
          categorized by type.
        </p>

        {monthly.length === 0 ? (
          <div className="empty">No scan has run yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Found</th>
                <th>Types</th>
                <th>Breakdown</th>
                <th>Meets minimum</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((month) => (
                <tr key={month.discovered_month}>
                  <td className="mono">{String(month.discovered_month).slice(0, 7)}</td>
                  <td>{month.total}</td>
                  <td>{month.types}</td>
                  <td className="mono">
                    {Object.entries(month.breakdown)
                      .map(([type, n]) => `${type} ${n}`)
                      .join(' · ')}
                  </td>
                  <td>
                    <span className={`pill ${month.meetsMinimum ? 'approved' : 'escalated'}`}>
                      {month.meetsMinimum ? `yes (>= ${month.minimum})` : `no (< ${month.minimum})`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={busy || !bookId} onClick={() =>
            run(
              () => api.scout(author.id, bookId),
              (r) =>
                `Scanned ${r.scanned} listings: ${r.identified.length} new opportunities recorded, ` +
                `${r.rejected.length} rejected.`,
            )
          }>
            Scan directories
          </button>
          <button className="ghost" disabled={busy || !bookId} onClick={() =>
            run(
              () => api.scout(author.id, bookId, ['speaking']),
              (r) =>
                `Searched the speaker bureaus only: ${r.scanned} listings, ` +
                `${r.identified.length} new speaking opportunities recorded.`,
            )
          }>
            Search speaking only
          </button>
          <button className="ghost" disabled={busy || !bookId} onClick={() =>
            run(
              () => api.draftOutreach(author.id, bookId, { limit: 10 }),
              (r) => `Drafted ${r.length} outreach messages. Review them on the Outreach tab.`,
            )
          }>
            Draft outreach for these
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Opportunities ({shown.length})</h2>
        <p className="hint">
          Scored twice, because there are two reasons to say yes. <strong>Themes</strong> is how well
          the listing matches what this book argues; <strong>author</strong> is how well it matches
          you — your subjects across every book, and the fact that a published author is what an
          author panel is looking for. A lead qualifies on either, and the column says which.
        </p>

        <label htmlFor="type">Filter by type</label>
        <select id="type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        {shown.length === 0 ? (
          <div className="empty">Nothing found yet. Run a scan.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Host</th>
                <th>Themes</th>
                <th>Author</th>
                <th>Qualified by</th>
                <th>Matched</th>
                <th>Deadline</th>
                <th>Outreach</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td>
                    <span className="pill">{o.type}</span>
                  </td>
                  <td>{o.name}</td>
                  <td>{o.host}</td>
                  <td className="mono">{Number(o.relevance).toFixed(3)}</td>
                  <td className="mono">{Number(o.expertise ?? 0).toFixed(3)}</td>
                  <td>
                    <span
                      className={`pill ${o.qualified_by === 'expertise' ? 'scheduled' : 'approved'}`}
                      title={o.rationale}
                    >
                      {o.qualified_by === 'expertise' ? 'you, not the book' : o.qualified_by}
                    </span>
                  </td>
                  <td className="mono">
                    {[...(o.matched_themes ?? []), ...(o.expertise_matched ?? [])].join(', ') || '—'}
                  </td>
                  <td className="mono">{o.deadline ? String(o.deadline).slice(0, 10) : '—'}</td>
                  <td>
                    {o.message_status ? (
                      <span className={`pill ${o.message_status}`}>{o.message_status}</span>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Rejected by the filter ({rejections.length})</h2>
        <p className="hint">
          What the scan decided you should never see, and how close each came to a floor. This is the
          part of the scan nobody could previously check: an identified lead is visible and can be
          judged wrong, but one dropped for a bad reason used to leave no trace at all. Both floors
          are stored with the verdict, so a call made under an older policy can be re-derived.
        </p>
        {rejections.length === 0 ? (
          <div className="empty">Nothing rejected yet. Run a scan.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Themes</th>
                <th>Author</th>
                <th>Topics</th>
              </tr>
            </thead>
            <tbody>
              {rejections.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="pill">{r.type}</span>
                  </td>
                  <td title={r.rationale}>{r.name}</td>
                  <td className="mono">
                    {Number(r.relevance).toFixed(3)}{' '}
                    <span className="muted">/ {Number(r.relevance_floor).toFixed(2)}</span>
                  </td>
                  <td className="mono">
                    {Number(r.expertise).toFixed(3)}{' '}
                    <span className="muted">/ {Number(r.expertise_floor).toFixed(2)}</span>
                  </td>
                  <td className="mono">{(r.topics ?? []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
