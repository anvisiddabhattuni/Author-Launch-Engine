import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Meme versus text (STORY-069).
 *
 * The page leads with what it cannot conclude. Four stories now rest on the
 * premise that memes earn more traction than text, and the useful thing a
 * dashboard can do about an unproven premise is say so — plainly, at the top,
 * before any number that might be mistaken for evidence.
 */
const VERDICT_COPY = {
  insufficient_data: { pill: 'unnamed', label: 'not enough data' },
  no_measurable_difference: { pill: 'neutral', label: 'no measurable difference' },
  meme_leads: { pill: 'approved', label: 'memes lead' },
  text_leads: { pill: 'approved', label: 'text leads' },
};

const pct = (n) => (n === null || n === undefined ? '—' : `${(Number(n) * 100).toFixed(2)}%`);

export function PerformancePage({ author, user }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setData(await api.formatPerformance(author.id));
  }, [author.id]);

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, describe) {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ kind: 'ok', message: describe(await fn()) });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function decide(rec, decision) {
    await run(
      () =>
        decision === 'approve'
          ? api.approveMix(rec.id, { reviewer: user?.name ?? author.name })
          : api.rejectMix(rec.id, { reviewer: user?.name ?? author.name }),
      () =>
        decision === 'approve'
          ? `Approved. The drafter now aims for ${rec.suggested_memes} meme(s) per batch.`
          : 'Rejected. Nothing about what gets published has changed.',
    );
  }

  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  const open = data.recommendations.filter((r) => r.status === 'pending_approval');
  const decided = data.recommendations.filter((r) => r.status !== 'pending_approval');

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Do memes actually do better?</h2>
        {/* The headline is the honest one. A dashboard that always shows a
            winner is a dashboard that will show one made of noise. */}
        <div className={`banner ${data.conclusive ? 'ok' : 'error'}`} style={{ marginTop: 8 }}>
          {data.conclusive
            ? 'On at least one platform the difference is large enough to be measurable. See below.'
            : `Not yet. Nothing here separates the two formats on any platform — ${data.totalMeasured} posts measured, and this view needs ${data.minSample} of each format on a platform before it will say anything at all.`}
        </div>
        <p className="hint">
          Engagement is collected from mocked platform adapters, and the collector does not know
          which format it is measuring — so any gap on default data is sampling noise, which is what
          this refuses to report as a result. Posts younger than {data.maturityHours} hours are
          excluded ({data.excludedTooYoung} right now): a meme measured an hour after publishing
          against a three-week-old text post is measuring age, not format.
        </p>

        <div className="row">
          <button disabled={busy} onClick={() => run(() => api.collectEngagement(author.id), (r) => `Collected metrics for ${r.collected} published posts.`)}>
            Collect engagement
          </button>
          <button className="ghost" disabled={busy} onClick={() => run(() => api.scanMixRecommendations(author.id), (r) => r.proposed.length > 0 ? `${r.proposed.length} recommendation(s) proposed — they change nothing until you approve.` : 'Nothing proposed: no platform has evidence strong enough to act on.')}>
            Look for a mix recommendation
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Per platform</h2>
        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Memes</th>
              <th>Text</th>
              <th>Verdict</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {data.platforms.length === 0 ? (
              <tr><td colSpan={5}><span className="empty">No measured posts yet.</span></td></tr>
            ) : (
              data.platforms.map((p) => {
                const copy = VERDICT_COPY[p.verdict] ?? { pill: 'neutral', label: p.verdict };
                return (
                  <tr key={p.platform}>
                    <td>{p.platform}</td>
                    <td className="mono">
                      n={p.meme.n} · {pct(p.meme.mean)}
                      {p.meme.n >= data.minSample && (
                        <span className="muted"> [{pct(p.meme.low)}–{pct(p.meme.high)}]</span>
                      )}
                    </td>
                    <td className="mono">
                      n={p.text.n} · {pct(p.text.mean)}
                      {p.text.n >= data.minSample && (
                        <span className="muted"> [{pct(p.text.low)}–{pct(p.text.high)}]</span>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${copy.pill}`}>{copy.label}</span>
                      {p.lift !== null && (
                        <span className="mono"> {p.lift > 0 ? '+' : ''}{(p.lift * 100).toFixed(0)}%</span>
                      )}
                    </td>
                    <td className="hint">{p.because}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <p className="hint">
          The bracket is a 95% interval. When two intervals overlap, the gap between the averages is
          inside the noise and this says so rather than picking the larger number.
        </p>
      </div>

      <div className="card">
        <h2>Mix recommendations ({open.length} awaiting you)</h2>
        <p className="hint">
          A recommendation is a proposal and nothing else. The drafter aims for{' '}
          <strong>{data.memesPerBatch} meme(s) per batch</strong> right now, and only an approval
          here moves that — a suggestion sitting unapproved changes nothing about what gets
          published.
        </p>

        {open.length === 0 ? (
          <div className="empty">Nothing proposed. That is the expected state until a platform has evidence.</div>
        ) : (
          open.map((rec) => (
            <div className="draft" key={rec.id}>
              <div className="meta">
                <span className="pill escalated">awaiting approval</span>
                <strong>{rec.platform}</strong>
                <span>favours {rec.favours}</span>
                <span className="mono">{rec.current_memes} → {rec.suggested_memes} memes per batch</span>
              </div>
              <div className="meta mono">
                meme n={rec.evidence.meme?.n} {pct(rec.evidence.meme?.mean)} · text n={rec.evidence.text?.n}{' '}
                {pct(rec.evidence.text?.mean)} · lift {(rec.evidence.lift * 100).toFixed(0)}%
              </div>
              <div className="meta hint">{rec.evidence.because}</div>
              <div className="row">
                <button onClick={() => decide(rec, 'approve')} disabled={busy}>Approve</button>
                <button className="danger" onClick={() => decide(rec, 'reject')} disabled={busy}>Reject</button>
              </div>
            </div>
          ))
        )}

        {decided.length > 0 && (
          <table>
            <thead>
              <tr><th>Platform</th><th>Proposed</th><th>Status</th><th>When</th></tr>
            </thead>
            <tbody>
              {decided.map((r) => (
                <tr key={r.id}>
                  <td>{r.platform}</td>
                  <td className="mono">{r.current_memes} → {r.suggested_memes}</td>
                  <td><span className={`pill ${r.status === 'approved' ? 'approved' : 'rejected'}`}>{r.status}</span></td>
                  <td className="mono">{String(r.updated_at).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
