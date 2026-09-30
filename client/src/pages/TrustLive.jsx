import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';

import { api } from '../api.js';

/**
 * The live parts of the trust dashboard (STORY-057, STORY-058).
 *
 * Polled rather than pushed: the browser's EventSource cannot send the
 * Authorization header this API requires, and a token in a URL is a token in
 * every proxy log. Every 15 seconds is "the most recent data" for a dashboard
 * people glance at, and the card says when it last refreshed.
 */
export const REFRESH_MS = 15_000;

function usePolling(fetcher, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const tick = () => fetcher().then((d) => alive && (setData(d), setError(''))).catch((e) => alive && setError(e.message));
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, error];
}

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
const stamp = (iso) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
const age = (hours) => (hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${Math.round(hours)} h` : `${Math.round(hours * 60)} min`);
const PRIORITY = { high: 'escalated', medium: 'pending_approval', normal: 'neutral' };

/** STORY-058: the score, what it is made of, and why it is capped when it is. */
export function GovernanceScoreCard({ authorId }) {
  const [s, error] = usePolling(() => api.governanceScore(authorId), [authorId]);
  if (error) return <div className="card"><h2>Governance score</h2><div className="banner error">{error}</div></div>;
  if (!s) return null;
  const tone = s.score == null ? 'neutral' : s.capped || s.score < 60 ? 'escalated' : s.score < 85 ? 'pending_approval' : 'approved';
  return (
    <div className="card">
      <h2>Governance score</h2>
      <div className="meta" style={{ alignItems: 'baseline' }}>
        <span className={`pill ${tone}`} style={{ fontSize: '1.6rem', padding: '6px 16px' }}>{s.score ?? '—'}<span style={{ fontSize: '0.9rem' }}> / 100</span></span>
        {s.capped && <span className="pill escalated">capped from {s.uncapped}</span>}
        <span className="pill neutral">last {s.window.days} days</span>
        <span className="hint">updated {ago(s.computedAt)} · refreshes every 15 s</span>
      </div>
      {s.capReason && <div className="banner error" style={{ marginTop: 8 }}>{s.capReason}</div>}
      <p className="hint">
        What the system did, not only whether its rules held: each factor is measured from the records, weighted, and
        added up. A factor with nothing to measure yet is left out and its weight shared by the rest.
      </p>
      <table>
        <thead><tr><th>Factor</th><th>Measured</th><th>Score</th><th>Weight</th><th>Adds</th></tr></thead>
        <tbody>
          {s.factors.map((f) => (
            <tr key={f.id}>
              <td>{f.label}<div className="hint">{f.detail}</div></td>
              <td className="mono">{f.noData ? 'nothing yet' : `${f.measured.n} / ${f.measured.d}`}</td>
              <td className="mono">{f.noData ? '—' : `${Math.round(f.value * 100)}%`}</td>
              <td className="mono">{f.noData ? '—' : `${Math.round(f.effectiveWeight * 100)}%`}</td>
              <td className="mono">{f.noData ? '—' : f.contribution.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** STORY-057: every waiting item and recent action, with timestamp and priority. */
export function AttentionCard({ authorId }) {
  const [a, error] = usePolling(() => api.attention(authorId), [authorId]);
  if (error) return <div className="card"><h2>Pending approvals</h2><div className="banner error">{error}</div></div>;
  if (!a) return null;
  const w = a.awaiting;
  return (
    <>
      <div className="card">
        <h2>Pending approvals ({w.total})</h2>
        <div className="meta">
          <span className={`pill ${w.byPriority.high ? 'escalated' : 'neutral'}`}>{w.byPriority.high} high</span>
          <span className="pill pending_approval">{w.byPriority.medium} medium</span>
          <span className="pill neutral">{w.byPriority.normal} normal</span>
          <span className="hint">updated {ago(a.generatedAt)} · refreshes every 15 s</span>
        </div>
        {w.total === 0 ? (
          <div className="empty">Nothing is waiting for a person.</div>
        ) : (
          <table>
            <thead><tr><th>Priority</th><th>Waiting</th><th>What</th><th>Since (UTC)</th></tr></thead>
            <tbody>
              {w.items.slice(0, 12).map((i) => (
                <tr key={`${i.kind}-${i.id}`}>
                  <td><span className={`pill ${PRIORITY[i.priority]}`}>{i.priority}</span><div className="hint">{i.priorityReason}</div></td>
                  <td className="mono">{age(i.ageHours)}</td>
                  <td>{i.label}<div className="hint">{i.detail}</div></td>
                  <td className="mono">{stamp(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {w.total > 12 && <div className="hint">…and {w.total - 12} more on the Social · review tab.</div>}
      </div>

      <div className="card">
        <h2>Recent actions</h2>
        <table>
          <thead><tr><th>When (UTC)</th><th>Priority</th><th>Actor</th><th>Action</th><th>On</th></tr></thead>
          <tbody>
            {a.recentActions.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.created_at.slice(0, 19).replace('T', ' ')}</td>
                <td><span className={`pill ${PRIORITY[r.priority]}`} title={r.priorityReason}>{r.priority}</span></td>
                <td className="mono">{r.actor}</td>
                <td>{r.action}</td>
                <td className="mono">{r.entity_type}{r.entity_id ? ` ${r.entity_id}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** STORY-057: shown on every tab to whoever decides, while something waits for them. */
export function AttentionNotice({ authorId }) {
  const [a] = usePolling(() => api.attention(authorId), [authorId]);
  if (!a?.forYou) return null;
  return (
    <div className={`banner ${a.forYou.high ? 'error' : 'ok'} attention-notice`} role="status">
      <strong>{a.forYou.message}.</strong>{' '}
      <NavLink to="/review">Review them →</NavLink>
    </div>
  );
}

const RANGES = [
  { id: '1h', label: 'Last hour', hours: 1 },
  { id: '24h', label: 'Last 24 hours', hours: 24 },
  { id: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { id: 'all', label: 'All time', hours: null },
  { id: 'custom', label: 'Custom…', hours: null },
];

/**
 * STORY-055: the tenant's audit and data access logs, searched in the index.
 * Shows how long the index took to answer, and whether the index matched the
 * logs at its last check — a search over a copy should say how good the copy is.
 */
export function SearchCard({ authorId }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [range, setRange] = useState('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status] = usePolling(() => api.searchStatus(authorId), [authorId]);

  const run = async (event) => {
    event?.preventDefault();
    const preset = RANGES.find((r) => r.id === range);
    const from = range === 'custom' ? custom.from && new Date(`${custom.from}Z`).toISOString()
      : preset.hours ? new Date(Date.now() - preset.hours * 3_600_000).toISOString() : '';
    const to = range === 'custom' && custom.to ? new Date(`${custom.to}Z`).toISOString() : '';
    setBusy(true);
    try {
      setResult(await api.search(authorId, { q, source, from, to, size: 50 }));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // Search only once the status says there is an index: asking first would
  // put a 503 in the console on every visit where none is set up.
  const configured = status?.configured === true;
  useEffect(() => { if (configured) run(); }, [authorId, configured]); // eslint-disable-line react-hooks/exhaustive-deps

  const unavailable = status && !status.configured;
  const audit = status?.sources?.find((s) => s.source === 'audit');
  return (
    <div className="card search-card">
      <h2>Search the logs</h2>
      <p className="hint">
        The audit log and the data access log, indexed for search (who did what, to which record, when). What each
        entry changed stays encrypted in the database and is not in the index.
      </p>
      {unavailable ? (
        <div className="banner">Search isn't set up here: the server has no search index (ELASTICSEARCH_URL). The logs are all still on the Audit tab.</div>
      ) : (
        <>
          <form className="search-form" onSubmit={run}>
            <input aria-label="Search for" placeholder="e.g. approved, outreach sent, draft 42" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Log" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Both logs</option>
              <option value="audit">Audit log</option>
              <option value="access">Data access log</option>
            </select>
            <select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            {range === 'custom' && (
              <>
                <input type="datetime-local" aria-label="From (UTC)" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
                <input type="datetime-local" aria-label="To (UTC)" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
              </>
            )}
            <button type="submit" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
          </form>
          <div className="meta">
            {result && (
              <>
                <span className="pill neutral">{result.total.toLocaleString()} found</span>
                {Object.entries(result.bySource).map(([s, n]) => <span key={s} className="pill neutral">{s === 'audit' ? 'audit' : 'data access'}: {n.toLocaleString()}</span>)}
                <span className={`pill ${result.elapsedMs < 1000 ? 'approved' : 'escalated'}`}>answered in {result.elapsedMs} ms</span>
                <span className="hint">index: {result.took} ms</span>
              </>
            )}
            {audit && (
              <span className="hint">
                {audit.inSync === false ? 'index behind the log at the last check · ' : audit.inSync ? 'index matched the log at the last check · ' : ''}
                last indexed {audit.lastRunAt ? stamp(audit.lastRunAt) : 'never'} UTC
              </span>
            )}
          </div>
          {error && <div className="banner error">{error.message}</div>}
          {result && result.hits.length > 0 && (
            <table>
              <thead><tr><th>When (UTC)</th><th>Log</th><th>What</th><th>Who</th><th>Priority / outcome</th></tr></thead>
              <tbody>
                {result.hits.map((h) => (
                  <tr key={`${h.source}-${h.id}`}>
                    <td className="mono">{h['@timestamp'].slice(0, 19).replace('T', ' ')}</td>
                    <td>{h.source === 'audit' ? 'audit' : 'data access'}</td>
                    <td>{h.source === 'audit' ? <>{h.action}<div className="hint">{h.entity_type}{h.entity_id ? ` ${h.entity_id}` : ''}</div></> : <span className="mono">{h.method} {h.route}</span>}</td>
                    <td className="mono">{h.actor ?? (h.user_id ? `user ${h.user_id}` : '—')}</td>
                    <td>{h.priority ? <span className={`pill ${PRIORITY[h.priority]}`}>{h.priority}</span> : <span className={`pill ${h.outcome === 'allowed' ? 'approved' : 'escalated'}`}>{h.outcome} {h.status}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result && result.hits.length === 0 && <div className="empty">Nothing matches in this time range.</div>}
          {result && result.total > result.hits.length && <div className="hint">Showing the newest {result.hits.length} of {result.total.toLocaleString()}.</div>}
        </>
      )}
    </div>
  );
}

const ANOMALY_TONE = { open: 'escalated', acknowledged: 'pending_approval', resolved: 'approved', dismissed: 'neutral' };

/**
 * STORY-059: anomalies escalated to a person, first on the Trust tab. Each
 * shows what was found, when, who was told and when, and its status — and
 * whoever may act can acknowledge, resolve or dismiss it, saying why.
 */
export function AnomaliesCard({ authorId, user }) {
  const [tick, setTick] = useState(0);
  const [a, error] = usePolling(() => api.anomalies(authorId), [authorId, tick]);
  const [notes, setNotes] = useState({});
  const [problem, setProblem] = useState('');
  if (error) return <div className="card"><h2>Anomalies</h2><div className="banner error">{error}</div></div>;
  if (!a) return null;
  const act = async (id, action) => {
    try {
      await api.anomalyAction(id, action, notes[id] ?? '');
      setProblem('');
      setTick((t) => t + 1);
    } catch (e) {
      setProblem(e.message);
    }
  };
  const live = a.open + a.acknowledged;
  const canAct = (e) => user?.permissions?.includes('audit.verify') || user?.permissions?.includes('tenant.act.all')
    || (e.author_id != null && Number(user?.authorId) === Number(e.author_id) && user?.permissions?.includes('content.approve'));
  return (
    <div className="card anomalies-card">
      <h2>Anomalies{live ? ` — ${live} need a person` : ''}</h2>
      {a.open > 0 && (
        <div className="banner error" role="status">
          <strong>{a.open} open anomal{a.open === 1 ? 'y' : 'ies'}</strong> — escalated to the people below; acknowledge when you are looking at it.
        </div>
      )}
      <p className="hint">
        Checked every {a.scanEverySeconds} s; anything found is escalated in the same check, and must reach a person within
        {' '}{a.escalateWithinMinutes} minutes (a governance check counts any that did not). Every rule says what it counted.
      </p>
      {problem && <div className="banner error">{problem}</div>}
      {a.events.length === 0 ? (
        <div className="empty">Nothing unusual found.</div>
      ) : (
        <table>
          <thead><tr><th>Status</th><th>What was found</th><th>Detected (UTC)</th><th>Escalated to</th><th /></tr></thead>
          <tbody>
            {a.events.slice(0, 10).map((e) => (
              <tr key={e.id}>
                <td>
                  <span className={`pill ${ANOMALY_TONE[e.status]}`}>{e.status}</span>
                  <div className="hint"><span className={`pill ${e.severity === 'high' ? 'escalated' : 'pending_approval'}`}>{e.severity}</span></div>
                </td>
                <td>
                  {e.summary}
                  <div className="hint mono">{e.detector}{e.author_name ? ` · ${e.author_name}` : ' · system-wide'}{e.occurrences > 1 ? ` · seen ${e.occurrences}×` : ''}</div>
                  {e.resolution_note && <div className="hint">{e.status} by {e.resolved_by}: {e.resolution_note}</div>}
                </td>
                <td className="mono">{stamp(e.detected_at)}</td>
                <td>
                  {e.escalated_at ? (
                    <>
                      <span className="mono">{stamp(e.escalated_at)}</span>
                      <span className="hint"> · {Math.round((new Date(e.escalated_at) - new Date(e.detected_at)) / 1000)} s after</span>
                      <div className="hint">{e.escalated_to.join(', ')}</div>
                    </>
                  ) : <span className="pill escalated">not yet escalated</span>}
                </td>
                <td>
                  {['open', 'acknowledged'].includes(e.status) && canAct(e) && (
                    <div className="anomaly-actions">
                      {e.status === 'open' && <button type="button" onClick={() => act(e.id, 'acknowledge')}>Acknowledge</button>}
                      <input aria-label="What was found or done" placeholder="What was found or done" value={notes[e.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [e.id]: ev.target.value })} />
                      <button type="button" onClick={() => act(e.id, 'resolve')}>Resolve</button>
                      <button type="button" className="danger" onClick={() => act(e.id, 'dismiss')}>Dismiss</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
