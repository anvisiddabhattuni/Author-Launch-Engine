import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localDate, platformName, statusLabel } from '../labels.js';

/**
 * Meme versus text (STORY-069).
 *
 * The page leads with what it cannot conclude. Four stories now rest on the
 * premise that memes earn more traction than text, and the useful thing a
 * dashboard can do about an unproven premise is say so — plainly, at the top,
 * before any number that might be mistaken for evidence.
 */
const VERDICT_COPY = {
  insufficient_data: { pill: 'unnamed', label: 'Too early to tell' },
  no_measurable_difference: { pill: 'neutral', label: 'About the same' },
  meme_leads: { pill: 'approved', label: 'Images do better' },
  text_leads: { pill: 'approved', label: 'Text does better' },
};

const pct = (n) => (n === null || n === undefined ? '—' : `${(Number(n) * 100).toFixed(1)}%`);

/** What an analysis concluded (STORY-029). Same three answers for every question. */
const FINDING_COPY = {
  insufficient_data: { pill: 'unnamed', label: 'Too early to tell' },
  no_measurable_relationship: { pill: 'neutral', label: 'No clear link' },
  relationship_found: { pill: 'approved', label: 'Yes' },
};

const TRAJECTORY_COPY = {
  unmeasured: { pill: 'escalated', label: 'Not measured yet' },
  one_reading: { pill: 'neutral', label: 'Just started' },
  climbing: { pill: 'scheduled', label: 'Still growing' },
  settled: { pill: 'approved', label: 'Settled' },
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
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
  const [shown, setShown] = useState(20);

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
          ? `Approved. Each weekly batch will now include ${rec.suggested_memes} image post${rec.suggested_memes === 1 ? '' : 's'}.`
          : 'Rejected. Nothing has changed.',
    );
  }

  if (!data || !perf) return <div className="card"><div className="empty">Loading…</div></div>;

  const open = data.recommendations.filter((r) => r.status === 'pending_approval');
  const decided = data.recommendations.filter((r) => r.status !== 'pending_approval');
  const cov = perf.coverage;

  const sum = (k) => perf.totals.reduce((n, t) => n + Number(t[k] ?? 0), 0);
  const views = sum('impressions');
  const engagements = sum('engagements');

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {/* STORY-029: what is tracked and what the numbers can say. */}
      <div className="card">
        <h2>At a glance</h2>
        <div className="stat-tiles">
          <div><span className="fact-num">{cov.published}</span><span className="fact-label">posts published</span></div>
          <div><span className="fact-num">{views.toLocaleString()}</span><span className="fact-label">times seen</span></div>
          <div><span className="fact-num">{engagements.toLocaleString()}</span><span className="fact-label">likes, shares &amp; comments</span></div>
          <div><span className="fact-num">{views ? pct(engagements / views) : '—'}</span><span className="fact-label">of viewers reacted</span></div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button disabled={busy} onClick={() => run(() => api.collectEngagement(author.id), (r) => `Updated the numbers for ${r.collected} posts.`)}>
            Update the numbers now
          </button>
          <span className="hint">
            Last updated {ago(cov.lastReadingAt)}. They also update by themselves every {Math.round(cov.sweep.everySeconds / 60)} minutes.
          </span>
        </div>
        {cov.allMocked && (
          <p className="hint">
            <span className="pill unnamed">demo numbers</span> This demo isn’t connected to real social media accounts, so these
            numbers are simulated.
          </p>
        )}
      </div>

      <div className="card">
        <h2>By platform</h2>
        <table>
          <thead>
            <tr><th>Platform</th><th>Posts</th><th>Times seen</th><th>Reactions</th><th>Reacted</th></tr>
          </thead>
          <tbody>
            {perf.totals.map((t) => (
              <tr key={t.platform}>
                <td>{platformName(t.platform)}</td>
                <td className="num">{t.posts}</td>
                <td className="num">{t.impressions.toLocaleString()}</td>
                <td className="num">{t.engagements.toLocaleString()}</td>
                <td className="num">{pct(t.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Your posts ({perf.posts.length})</h2>
        <p className="hint">“Still growing” means people are still finding the post; “Settled” means its numbers have stopped changing.</p>
        <table>
          <thead>
            <tr>
              <th>Post</th>
              <th>Posted</th>
              <th>Times seen</th>
              <th>Reacted</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {perf.posts.slice(0, shown).map((p) => {
              const tr = TRAJECTORY_COPY[p.trajectory] ?? { pill: 'neutral', label: p.trajectory };
              return (
                <tr key={p.id}>
                  <td>
                    <span className="pill">{platformName(p.platform)}</span> <span className="pill neutral">{p.format === 'meme' ? 'image' : p.format}</span>
                    <div className="hint">{p.excerpt}</div>
                  </td>
                  <td className="num">{localDate(p.publishedAt)}</td>
                  <td className="num">{p.latest ? p.latest.impressions.toLocaleString() : '—'}</td>
                  <td className="num">{p.latest ? pct(p.latest.engagementRate) : '—'}</td>
                  <td>
                    <Spark history={p.history} />
                    <div><span className={`pill ${tr.pill}`}>{tr.label}</span></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {perf.posts.length > shown && (
          <button className="show-more" onClick={() => setShown(shown + 20)}>Show {Math.min(20, perf.posts.length - shown)} more</button>
        )}
      </div>

      <div className="card">
        <h2>Do image posts do better than text posts?</h2>
        {/* The headline is the honest one. A dashboard that always shows a
            winner is a dashboard that will show one made of noise. */}
        <div className={`banner ${data.conclusive ? 'ok' : ''}`} style={{ marginTop: 8 }}>
          {data.conclusive
            ? 'Yes, on at least one platform there is a real difference. See the table below.'
            : `Not enough to tell yet. The app needs at least ${data.minSample} image posts and ${data.minSample} text posts on a platform before it will answer — so far ${data.totalMeasured} posts have been measured.`}
        </div>

        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Image posts</th>
              <th>Text posts</th>
              <th>Answer</th>
            </tr>
          </thead>
          <tbody>
            {data.platforms.length === 0 ? (
              <tr><td colSpan={4}><span className="empty">No measured posts yet.</span></td></tr>
            ) : (
              data.platforms.map((p) => {
                const copy = VERDICT_COPY[p.verdict] ?? { pill: 'neutral', label: p.verdict };
                return (
                  <tr key={p.platform}>
                    <td>{platformName(p.platform)}</td>
                    <td className="num">{p.meme.n} posts · {pct(p.meme.mean)} reacted</td>
                    <td className="num">{p.text.n} posts · {pct(p.text.mean)} reacted</td>
                    <td>
                      <span className={`pill ${copy.pill}`}>{copy.label}</span>
                      {p.lift !== null && (
                        <span className="num"> {p.lift > 0 ? '+' : ''}{(p.lift * 100).toFixed(0)}%</span>
                      )}
                      <div className="hint">{p.because}</div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" disabled={busy} onClick={() => run(() => api.scanMixRecommendations(author.id), (r) => r.proposed.length > 0 ? `${r.proposed.length} suggestion${r.proposed.length === 1 ? '' : 's'} below — nothing changes unless you approve.` : 'No suggestions yet — there isn’t enough evidence to change anything.')}>
            Suggest a better mix
          </button>
          <span className="hint">Right now the app writes <strong>{data.memesPerBatch} image post{data.memesPerBatch === 1 ? '' : 's'}</strong> in each weekly batch.</span>
        </div>
      </div>

      <div className="card">
        <h2>Suggestions waiting for you ({open.length})</h2>
        <p className="hint">A suggestion changes nothing until you approve it.</p>

        {open.length === 0 ? (
          <div className="empty">No suggestions right now.</div>
        ) : (
          open.map((rec) => (
            <div className="draft" key={rec.id}>
              <div className="draft-head">
                <span className="pill pending_approval">Needs your decision</span>
                <strong>{platformName(rec.platform)}</strong>
              </div>
              <p>
                Write <strong>{rec.suggested_memes}</strong> image post{rec.suggested_memes === 1 ? '' : 's'} per batch instead of{' '}
                {rec.current_memes}, because {rec.favours === 'meme' ? 'image posts' : rec.favours === 'text' ? 'text posts' : rec.favours} are doing
                {' '}{Math.abs(Math.round(rec.evidence.lift * 100))}% better there.
              </p>
              <div className="hint">{rec.evidence.because}</div>
              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={() => decide(rec, 'approve')} disabled={busy}>Approve</button>
                <button className="danger" onClick={() => decide(rec, 'reject')} disabled={busy}>Reject</button>
              </div>
            </div>
          ))
        )}

        {decided.length > 0 && (
          <details className="draft-details">
            <summary>Earlier suggestions ({decided.length})</summary>
            <table>
              <thead>
                <tr><th>Platform</th><th>Image posts per batch</th><th>Decision</th><th>When</th></tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id}>
                    <td>{platformName(r.platform)}</td>
                    <td className="num">{r.current_memes} → {r.suggested_memes}</td>
                    <td><span className={`pill ${r.status === 'approved' ? 'approved' : 'rejected'}`}>{statusLabel(r.status)}</span></td>
                    <td className="num">{localDate(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <details className="card disclosure">
        <summary><h2>How the numbers are measured</h2></summary>
        <div className="meta">
          <span className="pill">{cov.published} published</span>
          <span className={`pill ${cov.measured === cov.published ? 'approved' : 'pending_approval'}`}>{cov.measured} measured</span>
          <span className="pill">{cov.settled} settled · {cov.tooYoung} newer than {cov.maturityHours} hours</span>
          {cov.unmeasuredMature > 0 && <span className="pill escalated">{cov.unmeasuredMature} never measured</span>}
          <span className="pill neutral">{cov.readings} readings</span>
        </div>
        <p className="hint">
          Each post is checked again and again, so you can see how it grows over time. Posts newer than{' '}
          {data.maturityHours} hours ({data.excludedTooYoung} right now) are left out of comparisons — a brand-new post
          hasn’t had time to be seen yet. Differences are only reported when they are bigger than chance (a 95% interval).
        </p>
        <h3>What the numbers can tell you</h3>
        <table>
          <thead>
            <tr><th>Question</th><th>Answer</th><th>Because</th></tr>
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
                    {i.leads && <div className="num">{i.leads} {i.lift !== undefined && i.lift !== null ? `+${(i.lift * 100).toFixed(0)}%` : ''}</div>}
                    {i.direction && <div className="num">{i.direction} · r = {i.correlation.r}</div>}
                  </td>
                  <td className="hint">{i.because}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </>
  );
}
