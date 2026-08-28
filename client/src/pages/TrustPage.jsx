import { useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * The trust dashboard (STORY-014).
 *
 * Leads with a verdict rather than a number. A governance score is easy to build
 * and easy to believe, and "94%" printed above content that went out unapproved
 * would be worse than showing nothing — so the status is decided by severity and
 * the score sits beside it as a summary of a list you can read.
 *
 * The anomalies section shows detectors that found nothing and detectors that
 * could not look, both explicitly. A panel listing only its findings looks the
 * same whether it checked and found nothing or never checked at all.
 */
const STATUS_COPY = {
  breach: { kind: 'error', label: 'Breach' },
  degraded: { kind: 'error', label: 'Degraded' },
  healthy: { kind: 'ok', label: 'Healthy' },
};

const CONFIDENCE_COPY = {
  reported: { pill: 'escalated', label: 'found' },
  insufficient_evidence: { pill: 'neutral', label: 'not enough evidence to say' },
  clear: { pill: 'approved', label: 'looked, found nothing' },
};

export function TrustPage({ author }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.trustDashboard(author.id).then(setData).catch((e) => setError(e.message));
  }, [author.id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  const { governance, checks, anomalies, health, queue, recent } = data;
  const status = STATUS_COPY[governance.status] ?? { kind: '', label: governance.status };
  const invariants = checks.filter((c) => c.severity === 'invariant');
  const quality = checks.filter((c) => c.severity === 'quality');

  const checkRow = (c) => (
    <tr key={c.id}>
      <td>
        <span className={`pill ${c.passed ? 'approved' : 'escalated'}`}>
          {c.passed ? 'pass' : 'fail'}
        </span>
      </td>
      <td>
        {c.label}
        <div className="hint">{c.why}</div>
      </td>
      <td className="mono">{c.passed ? '—' : c.violations}</td>
    </tr>
  );

  return (
    <>
      <div className="card">
        <h2>Governance</h2>
        <div className={`banner ${status.kind}`}>
          <strong>{status.label}.</strong> {governance.headline}
        </div>
        <p className="hint">
          {governance.passed} of {governance.total} checks passing. The score is a summary of the
          list below, not the verdict — a single broken invariant means the system did the one thing
          it promises not to, and no number of passing checks offsets that.
        </p>

        <h3>Invariants — must never be true</h3>
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Check</th>
              <th>Violations</th>
            </tr>
          </thead>
          <tbody>{invariants.map(checkRow)}</tbody>
        </table>

        <h3>Governance quality — should be true</h3>
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Check</th>
              <th>Violations</th>
            </tr>
          </thead>
          <tbody>{quality.map(checkRow)}</tbody>
        </table>
      </div>

      <div className="card">
        <h2>System health</h2>
        <div className="meta">
          <span className={`pill ${health.workerSeen ? 'approved' : 'escalated'}`}>
            {health.workerSeen
              ? `worker last ran ${health.minutesSinceRun} min ago`
              : 'the worker has never run'}
          </span>
          <span
            className={`pill ${health.auditIntegrity === 'intact' ? 'approved' : health.auditIntegrity === 'altered' ? 'escalated' : 'neutral'}`}
          >
            audit log {health.auditIntegrity.replace(/_/g, ' ')}
          </span>
          {Object.entries(health.jobs).map(([k, n]) => (
            <span className={`pill ${k === 'dead_letter' ? 'escalated' : ''}`} key={k}>
              {n} {k.replace('_', ' ')}
            </span>
          ))}
        </div>
        <p className="hint">
          A worker that has never run and a worker that stopped an hour ago look identical in a
          status count, and are very different problems — so the two are distinguished here.
        </p>
      </div>

      {queue && (
        <div className="card">
          <h2>Pending approvals ({queue.total})</h2>
          <p className="hint">
            Held for a human across all four kinds of work. {queue.escalated} escalated — something
            checked them and asked for a person rather than letting them through.
          </p>
          <div className="meta">
            {Object.entries(queue.byKind).map(([kind, n]) => (
              <span className="pill" key={kind}>
                {n} {kind === 'mixRecommendation' ? 'mix change' : kind}
                {n === 1 ? '' : 's'}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Anomalies ({anomalies.findings} found)</h2>
        <p className="hint">
          Patterns worth a second look, which is a much weaker claim than a failed check. Detectors
          that could not look say so — a panel listing only its findings looks the same whether it
          checked and found nothing or never checked at all.
        </p>
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Detector</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {anomalies.detectors.map((d) => {
              const copy = CONFIDENCE_COPY[d.confidence] ?? { pill: '', label: d.confidence };
              return (
                <tr key={d.id}>
                  <td>
                    <span className={`pill ${copy.pill}`}>{copy.label}</span>
                  </td>
                  <td>
                    {d.label}
                    {d.findings.map((f) => (
                      <div className="mono" key={f.reviewer ?? f.detail}>
                        {f.reviewer ? `${f.reviewer}: ` : ''}
                        {f.detail}
                      </div>
                    ))}
                  </td>
                  <td className="hint">{d.because}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Recent actions</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>On</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r, i) => (
              <tr key={`${r.created_at}-${i}`}>
                <td className="mono">{String(r.created_at).slice(11, 19)}</td>
                <td className="mono">{r.actor}</td>
                <td>{r.action}</td>
                <td className="mono">
                  {r.entity_type}
                  {r.entity_id ? ` ${r.entity_id}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
