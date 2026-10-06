import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime } from '../labels.js';
import { AnomaliesCard, AttentionCard, GovernanceScoreCard, SearchCard } from './TrustLive.jsx';

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
  breach: { kind: 'error', label: 'Something went wrong' },
  degraded: { kind: 'error', label: 'Needs attention' },
  healthy: { kind: 'ok', label: 'All good' },
};

const CONFIDENCE_COPY = {
  reported: { pill: 'escalated', label: 'Found something' },
  insufficient_evidence: { pill: 'neutral', label: 'Not enough to tell' },
  clear: { pill: 'approved', label: 'Nothing found' },
};

/** How a component or instance reads at a glance (STORY-027). */
const UP_COPY = {
  up: { pill: 'approved', label: 'up' },
  degraded: { pill: 'pending_approval', label: 'degraded' },
  down: { pill: 'escalated', label: 'down' },
  not_deployed: { pill: 'neutral', label: 'not running' },
  unchecked: { pill: 'neutral', label: 'not checked yet' },
};
const COMPONENT_WORD = { database: 'Database', api: 'Website server', worker: 'Background jobs' };
const upPill = (status) => UP_COPY[status] ?? { pill: 'neutral', label: status ?? 'not checked yet' };

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} hours ago`;
};

export function TrustPage({ author, user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');

  const [tenant, setTenant] = useState(null);
  const [accesses, setAccesses] = useState(null);
  const load = () => api.trustDashboard(author.id).then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.tenantSchema(author.id).then(setTenant).catch(() => setTenant(null));
    api.accessEvents(author.id).then(setAccesses).catch(() => setAccesses(null));
  }, [author.id]);

  const canOperate = Boolean(user?.permissions?.includes('system.operate'));

  const checkNow = async () => {
    setChecking(true);
    setCheckNote('');
    try {
      const result = await api.runHealthCheck();
      const parts = [
        `database ${result.database.status}`,
        `api ${result.components.api?.status ?? '—'}`,
        `worker ${result.components.worker?.status ?? '—'}`,
      ];
      if (result.started.length) parts.push(`outage opened: ${result.started.map((o) => o.component).join(', ')}`);
      if (result.resolved.length) parts.push(`recovered: ${result.resolved.map((o) => o.component).join(', ')}`);
      if (result.alert?.alerted?.length) parts.push(`${result.alert.alerted.length} operator(s) paged`);
      else if (result.alert?.reason && result.started.length) parts.push(`not paged: ${result.alert.reason}`);
      setCheckNote(parts.join(' · '));
      await load();
    } catch (e) {
      setCheckNote(e.message);
    } finally {
      setChecking(false);
    }
  };

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  const { governance, checks, anomalies, health, queue, recent, outbound, history, episodes, surface } = data;
  const status = STATUS_COPY[governance.status] ?? { kind: '', label: governance.status };
  const invariants = checks.filter((c) => c.severity === 'invariant');
  const quality = checks.filter((c) => c.severity === 'quality');

  const checkRow = (c) => (
    <tr key={c.id}>
      <td>
        <span className={`pill ${c.passed ? 'approved' : 'escalated'}`}>
          {c.passed ? 'OK' : 'Problem'}
        </span>
      </td>
      <td>
        {c.label}
        <div className="hint">{c.why}</div>
      </td>
      <td className="num">{c.passed ? '—' : c.violations}</td>
    </tr>
  );

  return (
    <>
      {/* The verdict first, in a sentence — then what is waiting on a person. */}
      <div className={`banner ${status.kind}`}>
        <strong>{status.label}.</strong> {governance.headline} ({governance.passed} of {governance.total} safety checks OK.)
      </div>

      {/* STORY-059: something here may be waiting on a person. */}
      <AnomaliesCard authorId={author.id} user={user} />

      {/* STORY-057: pending approvals and recent actions, live, with priority. */}
      <AttentionCard authorId={author.id} />

      {/* STORY-058 */}
      <GovernanceScoreCard authorId={author.id} />

      <div className="card">
        <h2>Safety checks</h2>
        <p className="hint">
          The app checks its own promises all the time. The first list must <strong>never</strong> fail — one problem
          there matters more than any score.
        </p>

        <h3>Must never happen ({invariants.filter((c) => c.passed).length} of {invariants.length} OK)</h3>
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Check</th>
              <th>Problems</th>
            </tr>
          </thead>
          <tbody>{invariants.map(checkRow)}</tbody>
        </table>

        <details className="draft-details">
          <summary>Good practice ({quality.filter((c) => c.passed).length} of {quality.length} OK)</summary>
          <table>
            <thead>
              <tr>
                <th>Result</th>
                <th>Check</th>
                <th>Problems</th>
              </tr>
            </thead>
            <tbody>{quality.map(checkRow)}</tbody>
          </table>
        </details>
      </div>

      {/* STORY-041: where this author's data lives, and proof that their
          reads are confined to it — the role this request actually ran as. */}
      {tenant && (
        <div className="card">
          <h2>Your data is kept separate</h2>
          <p className="hint">
            {tenant.thisRequestRanAs === tenant.role
              ? 'Your books, posts and notes are stored in your own private area. Other authors can’t see them — even if the app had a bug, the database itself would refuse.'
              : 'You’re signed in with access to every author, so this page isn’t limited to one author’s private area. Authors themselves only ever see their own.'}
          </p>
          <details className="draft-details">
            <summary>Technical details</summary>
            <div className="meta">
              <span className="pill mono">schema {tenant.schema}</span>
              <span className={`pill ${tenant.thisRequestRanAs === tenant.role ? 'approved' : 'neutral'}`}>
                this page read as {tenant.thisRequestRanAs}
              </span>
              <span className="pill">{tenant.views.length} private views</span>
              <span className="pill neutral">{tenant.shared.filter((x) => x.readable).length} shared reference tables</span>
            </div>
          </details>
        </div>
      )}

      {/* STORY-044: who has opened this tenant's data, read through the
          tenant's own view of the access log. */}
      {accesses && (() => {
        const others = accesses.filter((e) => Number(e.actor_author_id) !== Number(author.id));
        const refused = others.filter((e) => e.outcome === 'denied' || e.outcome === 'unauthenticated');
        return (
          <div className="card">
            <h2>Who opened {tenant?.thisRequestRanAs === tenant?.role ? 'your' : `${author.name}'s`} data</h2>
            <div className="meta">
              <span className="pill neutral">last {accesses.length} times</span>
              <span className="pill">{accesses.length - others.length} by {tenant?.thisRequestRanAs === tenant?.role ? 'you' : 'the author'}</span>
              <span className={`pill ${others.length ? 'pending_approval' : 'approved'}`}>{others.length - refused.length} by staff (allowed)</span>
              <span className={`pill ${refused.length ? 'escalated' : 'approved'}`}>{refused.length} blocked attempts</span>
            </div>
            <p className="hint">
              Every time anyone opens this data it is recorded. Here are the times it wasn’t you.
            </p>
            {others.length > 0 && (
              <table>
                <thead>
                  <tr><th>When</th><th>Who</th><th>Result</th><th>Technical</th></tr>
                </thead>
                <tbody>
                  {others.slice(0, 12).map((e, i) => (
                    <tr key={i}>
                      <td className="num">{localTime(e.occurred_at)}</td>
                      <td>{e.user_email ?? 'not signed in'}{e.user_role ? <span className="hint"> · {e.user_role}</span> : null}</td>
                      <td><span className={`pill ${e.outcome === 'allowed' ? 'approved' : 'escalated'}`}>{e.outcome === 'allowed' ? 'Allowed' : 'Blocked'}</span></td>
                      <td className="audit-detail mono">{e.method} {e.route}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}

      {/* STORY-055: the logs, searchable over any time range. */}
      <SearchCard authorId={author.id} />

      <h2 className="section-label">Technical details</h2>

      <details className="card disclosure">
        <summary><h2>Is the app running properly?</h2></summary>

        {/* STORY-027: whether the processes are up, from rows the checks
            wrote. Before this the panel could say when the worker last ran
            and nothing about the API it was being read through. */}
        {health.system && (
          <>
            <div className="meta">
              {['database', 'api', 'worker'].map((component) => {
                const c = health.system.components[component];
                const copy = upPill(c.status);
                return (
                  <span className={`pill ${copy.pill}`} key={component}>
                    {COMPONENT_WORD[component]}: {copy.label}
                    {component === 'database' && c.latencyMs != null ? ` · ${c.latencyMs}ms` : ''}
                    {component !== 'database' && c.instances > 1 ? ` · ${c.instances} instances` : ''}
                  </span>
                );
              })}
              <span className="pill neutral">
                last checked {ago(health.system.lastCheckAt)}
              </span>
              {canOperate && (
                <button className="ghost" onClick={checkNow} disabled={checking}>
                  {checking ? 'Checking…' : 'Check now'}
                </button>
              )}
            </div>
            {checkNote && <p className="hint">{checkNote}</p>}

            {health.system.instances.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>Heartbeat</th>
                    <th>Requests</th>
                    <th>Errors</th>
                    <th>p95</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {health.system.instances.map((i) => {
                    const copy = upPill(i.status);
                    return (
                      <tr key={i.deploymentId}>
                        <td>
                          {i.component} <span className="mono">{i.instance}</span>
                          <div className="hint">v{i.version} · started {ago(i.startedAt)}</div>
                        </td>
                        <td><span className={`pill ${copy.pill}`}>{copy.label}</span></td>
                        <td className="mono">{ago(i.lastSeenAt)}</td>
                        <td className="mono">{i.stats?.requests ?? '—'}</td>
                        <td className="mono">
                          {i.stats?.errorRate == null
                            ? '—'
                            : <span className={`pill ${i.stats.errorRate > 0.05 ? 'escalated' : i.stats.errorRate > 0 ? 'unnamed' : 'approved'}`}>
                                {(i.stats.errorRate * 100).toFixed(1)}%
                              </span>}
                        </td>
                        <td className="mono">{i.stats?.p95Ms != null ? `${i.stats.p95Ms}ms` : '—'}</td>
                        <td className="hint">{i.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {health.system.outages.length > 0 && (
              <>
                <h3>Outages ({health.system.openOutages} open)</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th>Down since</th>
                      <th>Noticed</th>
                      <th>Paged</th>
                      <th>Recovered</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.system.outages.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <span className={`pill ${o.resolved_at ? 'neutral' : 'escalated'}`}>{o.component}</span>
                        </td>
                        <td className="mono">{ago(o.down_since)}</td>
                        <td className="mono">
                          {ago(o.detected_at)}
                          <div className="hint">
                            {Math.round((new Date(o.detected_at) - new Date(o.down_since)) / 1000)}s after · by {o.detected_by}
                          </div>
                        </td>
                        <td className="mono">{o.alerted_at ? ago(o.alerted_at) : <span className="pill unnamed">nobody</span>}</td>
                        <td className="mono">{o.resolved_at ? ago(o.resolved_at) : <span className="pill escalated">still down</span>}</td>
                        <td className="hint">{o.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p className="hint">
              A part counts as down when it stops checking in. Operators are alerted once when that happens, and the
              outage closes only when a check finds it working again.
            </p>
          </>
        )}

        <h3>Background jobs</h3>
        <div className="meta">
          <span className={`pill ${health.workerSeen ? 'approved' : 'escalated'}`}>
            {health.workerSeen
              ? `background jobs last ran ${health.minutesSinceRun} min ago`
              : 'background jobs have never run'}
          </span>
          <span
            className={`pill ${health.auditIntegrity === 'intact' ? 'approved' : health.auditIntegrity === 'altered' ? 'escalated' : 'neutral'}`}
          >
            activity history {health.auditIntegrity === 'intact' ? 'unchanged' : health.auditIntegrity.replace(/_/g, ' ')}
          </span>
          {Object.entries(health.jobs).map(([k, n]) => (
            <span className={`pill ${k === 'dead_letter' ? 'escalated' : ''}`} key={k}>
              {n} {k.replace('_', ' ')}
            </span>
          ))}
        </div>


        {health.integrations?.length > 0 && (
          <>
            <h3>Outside services, last 24 hours</h3>
            <p className="hint">
              Outside services the app talks to. If one keeps failing, the app pauses calls to it for a while
              (“circuit open”) and alerts the operators.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Circuit</th>
                  <th>Calls</th>
                  <th>Attempts</th>
                  <th>Retried</th>
                  <th>Timed out</th>
                  <th>Failed</th>
                  <th>Avg</th>
                </tr>
              </thead>
              <tbody>
                {health.integrations.map((i) => (
                  <tr key={i.service}>
                    <td>
                      {i.service}
                      {/* STORY-038: the policy the gateway applies to this one. */}
                      <div className="hint">
                        {i.policy ? `${i.kind} · ${i.policy.timeoutMs / 1000}s × ${i.policy.maxAttempts}` : i.kind}
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${i.circuit?.state === 'closed' ? 'approved' : 'escalated'}`}>
                        {i.circuit?.state === 'closed' ? 'closed' : i.circuit?.state?.replace('_', '-')}
                      </span>
                      {i.circuit?.state !== 'closed' && (
                        <div className="hint">
                          {i.circuit.consecutiveFailures} failed in a row · {i.circuit.alertedAt ? 'operators alerted' : 'not alerted'}
                          <br />
                          {i.circuit.lastError}
                        </div>
                      )}
                      {i.short_circuited > 0 && <div className="hint">{i.short_circuited} call(s) not sent</div>}
                    </td>
                    <td className="mono">{i.calls}</td>
                    <td className="mono">{i.attempts}</td>
                    <td className="mono">
                      {/* Attempts above calls is the early signal: the provider
                          is still working, and working harder than it should. */}
                      {i.retried > 0 ? <span className="pill unnamed">{i.retried}</span> : '—'}
                    </td>
                    <td className="mono">
                      {i.timed_out > 0 ? <span className="pill escalated">{i.timed_out}</span> : '—'}
                    </td>
                    <td className="mono">
                      {i.failed > 0 ? <span className="pill escalated">{i.failed}</span> : '—'}
                    </td>
                    <td className="mono">{i.avg_ms === null ? '—' : `${i.avg_ms}ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </details>

      {/* STORY-021: the dimension the dashboard did not have. A score with
          nothing to compare it to is a number, not a metric. */}
      {history?.length > 0 && (
        <details className="card disclosure">
          <summary><h2>Safety checks over time ({history.length})</h2></summary>
          <p className="hint">Each bar is one check-up. Green is all good, amber needs attention, red means something went wrong.</p>
          <div className="meta" style={{ alignItems: 'flex-end', gap: 3, minHeight: 60 }}>
            {[...history].reverse().map((h) => (
              <span
                key={h.id}
                title={`${localTime(h.assessed_at)} · ${(STATUS_COPY[h.status] ?? { label: h.status }).label} · ${h.passed}/${h.total} OK`}
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: Math.max(4, Math.round(Number(h.score ?? 0) * 56)),
                  background:
                    h.status === 'breach' ? 'var(--danger)' : h.status === 'degraded' ? 'var(--caramel)' : 'var(--ok)',
                }}
              />
            ))}
          </div>
          <p className="hint">
            Oldest on the left, newest on the right. Taller means more checks passed.
          </p>

          {episodes?.filter((e) => !e.recovered_at).length > 0 && (
            <>
              <h3>Failing right now</h3>
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>How serious</th>
                    <th>Failing since</th>
                    <th>Anyone told?</th>
                  </tr>
                </thead>
                <tbody>
                  {episodes
                    .filter((e) => !e.recovered_at)
                    .map((e) => (
                      <tr key={e.id}>
                        <td className="mono">{e.check_id}</td>
                        <td>
                          <span className={`pill ${e.severity === 'invariant' ? 'escalated' : ''}`}>
                            {e.severity === 'invariant' ? 'Must never happen' : 'Good practice'}
                          </span>
                        </td>
                        <td className="num">{localTime(e.started_at)}</td>
                        <td className="mono">
                          {/* An alert nobody sent and an alert nobody read are
                              different failures, and only the first is ours. */}
                          {e.severity !== 'invariant'
                            ? '—'
                            : e.alerted_at
                              ? 'Yes'
                              : 'Not yet'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </details>
      )}

      {/* STORY-024: which readable routes are checked for cross-tenant leaks.
          The number is the point — it sat at 10 of 35 for six stories and
          nothing noticed, because the list was kept by hand. */}
      {surface && (
        <details className="card disclosure">
          <summary><h2>Pages tested for leaks between authors ({surface.walkable} of {surface.total})</h2></summary>
          <p className="hint">
            The app’s tests open each page as one author and check that nothing belonging to another author shows up.
            The ones not tested are listed with the reason.
          </p>
          <div className="meta">
            <span className="pill approved">{surface.walkable} tested</span>
            <span className="pill">{surface.declared.length} skipped, with a reason</span>
            {surface.needsId > 0 && (
              <span className="pill escalated">{surface.needsId} skipped with no reason</span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Not tested</th>
                <th>Why that’s OK</th>
              </tr>
            </thead>
            <tbody>
              {surface.declared.map((d) => (
                <tr key={d.path}>
                  <td className="mono">{d.path}</td>
                  <td>{d.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {/* STORY-020: every way out of the system, exemptions included. The three
          gate invariants each verify a gate that exists; this is the list that
          shows whether one was ever missed. */}
      {outbound && (
        <details className="card disclosure">
          <summary><h2>Everything the app can send out ({outbound.gated} need approval · {outbound.exempt} don’t)</h2></summary>
          <p className="hint">
            Every way the app can post or send something. Most need a person’s approval first; the few that don’t
            (like a password reset email) say why.
          </p>
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Sends</th>
                <th>Approval needed, or why not</th>
              </tr>
            </thead>
            <tbody>
              {outbound.paths.map((p) => (
                <tr key={p.id}>
                  <td className="mono">
                    <span className={`pill ${p.kind === 'gated' ? 'approved' : ''}`}>{p.kind === 'gated' ? 'needs approval' : 'no approval'}</span>{' '}
                    {p.id}
                  </td>
                  <td>{p.sends}</td>
                  <td className="audit-detail">{p.kind === 'gated' ? p.gate : p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {outbound.unverified.length > 0 && (
            <div className="banner error">
              These need approval but nothing double-checks it: {outbound.unverified.join(', ')}
            </div>
          )}
        </details>
      )}

      <details className="card disclosure">
        <summary><h2>What the unusual-activity checks look for ({anomalies.findings} found)</h2></summary>
        <p className="hint">
          Patterns worth a second look. A check that didn’t have enough to go on says so, rather than looking like it found nothing.
        </p>
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Check</th>
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
      </details>
    </>
  );
}
