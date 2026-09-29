import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { AttentionCard, GovernanceScoreCard, SearchCard } from './TrustLive.jsx';

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

/** How a component or instance reads at a glance (STORY-027). */
const UP_COPY = {
  up: { pill: 'approved', label: 'up' },
  degraded: { pill: 'pending_approval', label: 'degraded' },
  down: { pill: 'escalated', label: 'down' },
  not_deployed: { pill: 'neutral', label: 'not running' },
  unchecked: { pill: 'neutral', label: 'not checked yet' },
};
const upPill = (status) => UP_COPY[status] ?? { pill: 'neutral', label: status ?? 'not checked yet' };

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
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
      {/* STORY-058 */}
      <GovernanceScoreCard authorId={author.id} />

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

      {/* STORY-041: where this author's data lives, and proof that their
          reads are confined to it — the role this request actually ran as. */}
      {tenant && (
        <div className="card">
          <h2>Your data</h2>
          <div className="meta">
            <span className="pill mono">schema {tenant.schema}</span>
            <span className={`pill ${tenant.thisRequestRanAs === tenant.role ? 'approved' : 'neutral'}`}>
              this page's reads ran as {tenant.thisRequestRanAs}
            </span>
            <span className="pill">
              {tenant.views.length} views of {tenant.thisRequestRanAs === tenant.role ? 'your' : `${author.name}'s`} rows
            </span>
            <span className="pill neutral">{tenant.shared.filter((x) => x.readable).length} shared reference tables</span>
          </div>
          <p className="hint">
            {tenant.thisRequestRanAs === tenant.role
              ? 'Every page you open reads through your own database schema, as a role that can see nothing outside it. If a query anywhere in the product forgot to filter by author, the database would still return only your rows.'
              : 'You are signed in with access across tenants, so your reads are not confined to one schema. Authors\' reads are.'}
          </p>
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
              <span className="pill neutral">last {accesses.length} requests</span>
              <span className="pill">{accesses.length - others.length} by {tenant?.thisRequestRanAs === tenant?.role ? 'you' : 'the author'}</span>
              <span className={`pill ${others.length ? 'pending_approval' : 'approved'}`}>{others.length - refused.length} by staff</span>
              <span className={`pill ${refused.length ? 'escalated' : 'approved'}`}>{refused.length} refused attempts</span>
            </div>
            <p className="hint">
              Every request that touches this data is recorded — who made it, what it asked for, and
              whether it was allowed. Staff reads are shown; attempts from other accounts are shown and
              were refused.
            </p>
            {others.length > 0 && (
              <table>
                <thead>
                  <tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Outcome</th></tr>
                </thead>
                <tbody>
                  {others.slice(0, 12).map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{new Date(e.occurred_at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                      <td>{e.user_email ?? 'no session'}{e.user_role ? <span className="hint"> · {e.user_role}</span> : null}</td>
                      <td className="mono">{e.method} {e.route}</td>
                      <td><span className={`pill ${e.outcome === 'allowed' ? 'approved' : 'escalated'}`}>{e.outcome}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}

      <div className="card">
        <h2>System health</h2>

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
                    {component} {copy.label}
                    {component === 'database' && c.latencyMs != null ? ` · ${c.latencyMs}ms` : ''}
                    {component !== 'database' && c.instances > 1 ? ` · ${c.instances} instances` : ''}
                  </span>
                );
              })}
              <span className="pill neutral">
                last checked {ago(health.system.lastCheckAt)} · {health.system.checksRecorded} checks logged
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
              An instance is down when it stops saying it is alive, or when its /ready stops
              answering — not when it forgets to write a stop row. Outages open on the transition and
              page the operators once; they close when a check finds the component up again, never
              because time passed. The database outage is the one this cannot record, because it is
              recorded in the database.
            </p>
          </>
        )}

        <h3>Background work</h3>
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

        {health.integrations?.length > 0 && (
          <>
            <h3>External integrations, last 24 hours</h3>
            <p className="hint">
              Every outbound call goes through one gateway with a policy per integration. When a
              provider fails repeatedly its circuit opens: the gateway stops calling it for a
              cooldown, alerts the operators once, then lets one call test it.
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
            <p className="hint">
              Attempts higher than calls means work is being retried — a provider degrading rather
              than failing, which is the state worth catching before it becomes the other one.
            </p>
          </>
        )}
      </div>

      {/* STORY-057: pending approvals and recent actions, live, with priority. */}
      <AttentionCard authorId={author.id} />

      {/* STORY-055: the logs, searchable over any time range. */}
      <SearchCard authorId={author.id} />

      {/* STORY-021: the dimension the dashboard did not have. A score with
          nothing to compare it to is a number, not a metric. */}
      {history?.length > 0 && (
        <div className="card">
          <h2>Trust over time ({history.length} assessments)</h2>
          <p className="hint">
            Every assessment is stored, so the score is a series rather than a snapshot. Before this
            the dashboard recomputed on each load and compared it to nothing — which made “when did
            this start failing?” and “is this getting worse?” unanswerable.
          </p>
          <div className="meta" style={{ alignItems: 'flex-end', gap: 3, minHeight: 60 }}>
            {[...history].reverse().map((h) => (
              <span
                key={h.id}
                title={`${new Date(h.assessed_at).toISOString().slice(0, 19).replace('T', ' ')} · ${h.status} · ${h.passed}/${h.total}`}
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: Math.max(4, Math.round(Number(h.score ?? 0) * 56)),
                  background:
                    h.status === 'breach' ? '#c0392b' : h.status === 'degraded' ? '#d68910' : '#27ae60',
                }}
              />
            ))}
          </div>
          <p className="hint">
            Oldest left, newest right. Height is the passing fraction; colour is the verdict, because
            a high score with a broken invariant is still a breach.
          </p>

          {episodes?.filter((e) => !e.recovered_at).length > 0 && (
            <>
              <h3>Currently failing</h3>
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Severity</th>
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
                            {e.severity}
                          </span>
                        </td>
                        <td className="mono">
                          {new Date(e.started_at).toISOString().slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="mono">
                          {/* An alert nobody sent and an alert nobody read are
                              different failures, and only the first is ours. */}
                          {e.severity !== 'invariant'
                            ? '—'
                            : e.alerted_at
                              ? 'alerted'
                              : 'NOT YET'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* STORY-024: which readable routes are checked for cross-tenant leaks.
          The number is the point — it sat at 10 of 35 for six stories and
          nothing noticed, because the list was kept by hand. */}
      {surface && (
        <div className="card">
          <h2>
            Leak-checked routes ({surface.walkable} of {surface.total})
          </h2>
          <p className="hint">
            Every route a tenant can read is walked as one author and checked for another author's
            id anywhere in the response, at any depth. The list is derived from the router, so a
            route added tomorrow is walked tomorrow. {surface.declared.length} are deliberately not
            walked and each says why — an exclusion nobody can see is indistinguishable from a check
            that never ran.
          </p>
          <div className="meta">
            <span className="pill approved">{surface.walkable} walked</span>
            <span className="pill">{surface.declared.length} declared</span>
            {surface.needsId > 0 && (
              <span className="pill escalated">{surface.needsId} unwalkable and undeclared</span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Not walked</th>
                <th>Why that is not a gap</th>
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
        </div>
      )}

      {/* STORY-020: every way out of the system, exemptions included. The three
          gate invariants each verify a gate that exists; this is the list that
          shows whether one was ever missed. */}
      {outbound && (
        <div className="card">
          <h2>
            Ways out ({outbound.gated} gated · {outbound.exempt} exempt)
          </h2>
          <p className="hint">
            Every path that can send or publish. A gated path names the approval it sits behind and
            the invariant that checks it from outside; an exempt one says why it has none.
            Exemptions are listed rather than filtered, because an exclusion nobody can see is
            indistinguishable from a check that never ran.
          </p>
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Sends</th>
                <th>Gate, or why not</th>
              </tr>
            </thead>
            <tbody>
              {outbound.paths.map((p) => (
                <tr key={p.id}>
                  <td className="mono">
                    <span className={`pill ${p.kind === 'gated' ? 'approved' : ''}`}>{p.kind}</span>{' '}
                    {p.id}
                  </td>
                  <td>{p.sends}</td>
                  <td className="mono">{p.kind === 'gated' ? p.gate : p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {outbound.unverified.length > 0 && (
            <div className="banner error">
              Gated with no invariant behind it: {outbound.unverified.join(', ')}
            </div>
          )}
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

    </>
  );
}
