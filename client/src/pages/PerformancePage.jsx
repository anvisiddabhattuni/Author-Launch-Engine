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

/** What an analysis concluded (STORY-029). Same three answers for every question. */
const FINDING_COPY = {
  insufficient_data: { pill: 'unnamed', label: 'not enough data' },
  no_measurable_relationship: { pill: 'neutral', label: 'no measurable relationship' },
  relationship_found: { pill: 'approved', label: 'found' },
};

const TRAJECTORY_COPY = {
  unmeasured: { pill: 'escalated', label: 'never measured' },
  one_reading: { pill: 'neutral', label: 'one reading' },
  climbing: { pill: 'scheduled', label: 'still climbing' },
  settled: { pill: 'approved', label: 'settled' },
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** A tiny inline series: impressions per reading, newest last. */
function Spark({ history }) {
  if (!history || history.length < 2) return <span className="muted">—</span>;
  const max = Math.max(...history.map((h) => h.impressions));
  return (
    <span className="meta" style={{ gap: 2, alignItems: 'flex-end', height: 18 }} title={history.map((h) => `${h.hoursLive}h: ${h.impressions}`).join('\n')}>
      {history.map((h, i) => (
        <span
          key={i}
          style={{ display: 'inline-block', width: 5, height: Math.max(2, Math.round((h.impressions / max) * 18)), background: 'var(--accent)', opacity: 0.4 + (0.6 * (i + 1)) / history.length }}
        />
      ))}
    </span>
  );
}

export function PerformancePage({ author, user }) {
  const [data, setData] = useState(null);
  const [perf, setPerf] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [formats, performance] = await Promise.all([
      api.formatPerformance(author.id),
      api.contentPerformance(author.id),
    ]);
    setData(formats);
    setPerf(performance);
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

  if (!data || !perf) return <div className="card"><div className="empty">Loading…</div></div>;

  const open = data.recommendations.filter((r) => r.status === 'pending_approval');
  const decided = data.recommendations.filter((r) => r.status !== 'pending_approval');
  const cov = perf.coverage;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {/* STORY-029: what is tracked, how, and what the numbers can say. Leads
          with coverage because a chart is only about the posts it includes. */}
      <div className="card">
        <h2>Content performance</h2>
        <div className="meta">
          <span className="pill">{cov.published} published</span>
          <span className={`pill ${cov.measured === cov.published ? 'approved' : 'pending_approval'}`}>{cov.measured} measured</span>
          <span className="pill">{cov.settled} settled · {cov.tooYoung} under {cov.maturityHours}h</span>
          {cov.unmeasuredMature > 0 && <span className="pill escalated">{cov.unmeasuredMature} matured unmeasured</span>}
          <span className="pill neutral">{cov.readings} readings · last {ago(cov.lastReadingAt)}</span>
          <span className={`pill ${cov.sweep.lastRunAt ? 'approved' : 'unnamed'}`}>
            sweep {cov.sweep.lastRunAt ? `ran ${ago(cov.sweep.lastRunAt)}` : 'has not run yet'} · every {Math.round(cov.sweep.everySeconds / 60)} min
          </span>
          {cov.allMocked && <span className="pill unnamed">all readings mocked</span>}
        </div>
        <p className="hint">
          Every published post is measured on a timer and every reading is kept, so a post has a
          series rather than a number. Nothing here came from a real platform yet; the collector is
          mocked and blind to everything but platform, which is why most of the questions below
          answer “no measurable relationship” — the honest result on data with nothing in it.
        </p>

        <h3>What the numbers can say</h3>
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Because</th>
            </tr>
          </thead>
          <tbody>
            {perf.insights.map((i) => {
              const copy = FINDING_COPY[i.finding] ?? { pill: 'neutral', label: i.finding };
              return (
                <tr key={i.id}>
                  <td>
                    {i.question}
                    <div className="hint">{i.premise}</div>
                  </td>
                  <td>
                    <span className={`pill ${copy.pill}`}>{copy.label}</span>
                    {i.leads && <div className="mono">{i.leads} {i.lift !== undefined && i.lift !== null ? `+${(i.lift * 100).toFixed(0)}%` : ''}</div>}
                    {i.direction && <div className="mono">{i.direction} · r = {i.correlation.r}</div>}
                  </td>
                  <td className="hint">{i.because}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3>By platform</h3>
        <table>
          <thead>
            <tr><th>Platform</th><th>Posts</th><th>Measured</th><th>Impressions</th><th>Engagements</th><th>Rate</th></tr>
          </thead>
          <tbody>
            {perf.totals.map((t) => (
              <tr key={t.platform}>
                <td>{t.platform}</td>
                <td className="mono">{t.posts}</td>
                <td className="mono">{t.measured}</td>
                <td className="mono">{t.impressions.toLocaleString()}</td>
                <td className="mono">{t.engagements.toLocaleString()}</td>
                <td className="mono">{pct(t.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Posts ({perf.posts.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Post</th>
              <th>Published</th>
              <th>Window</th>
              <th>Scores</th>
              <th>Impressions</th>
              <th>Rate</th>
              <th>Series</th>
              <th>Trajectory</th>
            </tr>
          </thead>
          <tbody>
            {perf.posts.slice(0, 40).map((p) => {
              const tr = TRAJECTORY_COPY[p.trajectory] ?? { pill: 'neutral', label: p.trajectory };
              return (
                <tr key={p.id}>
                  <td>
                    <span className="pill">{p.platform}</span> <span className="pill neutral">{p.format}</span>
                    <div className="hint">{p.excerpt}</div>
                  </td>
                  <td className="mono">{String(p.publishedAt).slice(0, 10)} {String(p.publishedHour).padStart(2, '0')}:00</td>
                  <td>{p.inWindow === null ? '—' : <span className={`pill ${p.inWindow ? 'approved' : 'neutral'}`}>{p.inWindow ? 'in' : 'out'}</span>}</td>
                  <td className="mono">
                    theme {p.scores.themeAlignment ?? '—'} · voice {p.scores.voice ?? '—'}
                  </td>
                  <td className="mono">{p.latest ? p.latest.impressions.toLocaleString() : '—'}</td>
                  <td className="mono">{p.latest ? pct(p.latest.engagementRate) : '—'}</td>
                  <td><Spark history={p.history} /></td>
                  <td><span className={`pill ${tr.pill}`}>{tr.label}</span> <span className="hint">{p.readings} reading{p.readings === 1 ? '' : 's'}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {perf.posts.length > 40 && <p className="hint">Showing the 40 most recent of {perf.posts.length}.</p>}
      </div>

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
