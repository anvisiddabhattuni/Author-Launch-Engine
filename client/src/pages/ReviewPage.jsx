import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const DECIDABLE = ['pending_approval', 'escalated'];

/** The approval gate (REQ-006): nothing is scheduled without a decision here. */
export function ReviewPage({ author }) {
  const [drafts, setDrafts] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [d, c] = await Promise.all([
      api.drafts({ authorId: author.id }),
      api.weeklyCoverage(author.id),
    ]);
    setDrafts(d);
    setCoverage(c);
  }, [author.id]);

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function decide(draft, decision) {
    setBusy(true);
    setStatus(null);
    try {
      const body = { reviewer, notes: notes[draft.id] ?? '' };
      if (decision === 'approve') {
        await api.approve(draft.id, body);
        setStatus({ kind: 'ok', message: `Draft ${draft.id} approved. Schedule it on the next tab.` });
      } else {
        await api.reject(draft.id, body);
        setStatus({ kind: 'ok', message: `Draft ${draft.id} rejected.` });
      }
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const queue = drafts.filter((d) => DECIDABLE.includes(d.status));
  const decided = drafts.filter((d) => !DECIDABLE.includes(d.status));

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Weekly cadence</h2>
        <p className="hint">
          Acceptance criterion: at least three posts drafted per week, tailored across platforms.
        </p>
        {coverage.length === 0 ? (
          <div className="empty">No drafts yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th>Drafts</th>
                <th>Platforms</th>
                <th>Meets minimum</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((week) => (
                <tr key={week.week_of}>
                  <td className="mono">{String(week.week_of).slice(0, 10)}</td>
                  <td>{week.total}</td>
                  <td className="mono">{week.platform_list.join(', ')}</td>
                  <td>
                    <span className={`pill ${week.meetsMinimum ? 'approved' : 'escalated'}`}>
                      {week.meetsMinimum ? `yes (>= ${week.minimum})` : `no (< ${week.minimum})`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Awaiting your decision ({queue.length})</h2>
        <p className="hint">
          Every decision is written to the audit log against your name. Escalated drafts scored below
          the confidence threshold and need a closer look.
        </p>

        <label htmlFor="reviewer">Reviewer</label>
        <input id="reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {queue.length === 0 ? (
          <div className="empty">Nothing pending. Generate drafts on the Upload tab.</div>
        ) : (
          queue.map((draft) => (
            <div className="draft" key={draft.id}>
              <div className="meta">
                <span className={`pill ${draft.status}`}>{draft.status.replace('_', ' ')}</span>
                <strong>{draft.platform}</strong>
                <span>confidence {Number(draft.confidence).toFixed(3)}</span>
                <span>themes: {draft.themes_used.join(', ') || '—'}</span>
                <span>draft {draft.id}</span>
              </div>

              <pre>{draft.content}</pre>

              <div className="meta mono">{draft.rationale}</div>

              <input
                placeholder="Notes for the record (optional)"
                value={notes[draft.id] ?? ''}
                onChange={(e) => setNotes({ ...notes, [draft.id]: e.target.value })}
                style={{ marginTop: 12 }}
              />

              <div className="row">
                <button onClick={() => decide(draft, 'approve')} disabled={busy || !reviewer.trim()}>
                  Approve
                </button>
                <button
                  className="danger"
                  onClick={() => decide(draft, 'reject')}
                  disabled={busy || !reviewer.trim()}
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Already decided ({decided.length})</h2>
        {decided.length === 0 ? (
          <div className="empty">Nothing decided yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Draft</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((draft) => (
                <tr key={draft.id}>
                  <td className="mono">{draft.id}</td>
                  <td>{draft.platform}</td>
                  <td>
                    <span className={`pill ${draft.status}`}>{draft.status}</span>
                  </td>
                  <td>{draft.content.slice(0, 90)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
