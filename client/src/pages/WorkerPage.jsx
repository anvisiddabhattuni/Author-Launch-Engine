import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * STORY-065: run health for the background worker.
 *
 * The number that matters is the dead-letter count — work the system has
 * stopped trying to do. Everything else on this page is context for it.
 */
const KIND_LABELS = {
  'posts.publish_due': 'Publish scheduled posts',
  'press.draft_approaching': 'Draft kits for approaching milestones',
  'reviews.notify_pending': 'Notify reviewers of pending drafts',
  'outreach.send': 'Send an approved outreach message',
};

const when = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false })
    : '—';

/** Who said what to whom, in the words of the contract rather than the topic name. */
const MESSAGE_STATUS = {
  queued: 'queued',
  delivered: 'queued',
  acked: 'approved',
  dead_letter: 'escalated',
};

const ms = (n) => (n === null || n === undefined ? '—' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

export function WorkerPage({ user }) {
  const [data, setData] = useState(null);
  const [messages, setMessages] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [jobs, bus] = await Promise.all([api.jobs(), api.messages()]);
    setData(jobs);
    setMessages(bus);
  }, []);
  const canOperate = Boolean(user?.permissions?.includes('system.operate'));

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function run(fn, message) {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ kind: 'ok', message });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="card">Loading run health…</div>;

  const deadLetters = data.jobs.filter((j) => j.status === 'dead_letter');
  const health = data.health ?? {};

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Worker</h2>
        <p className="hint">
          A separate process (<span className="mono">npm run worker</span>) polls every{' '}
          {data.pollSeconds}s and runs each recurring sweep once per {data.sweepSeconds}s window. It
          acts on work a human already approved — it has no session and cannot approve anything
          itself. A job is tried {data.maxAttempts} times with backoff, then handed to a person.
        </p>

        <div className="meta">
          {['queued', 'running', 'done', 'dead_letter', 'cancelled'].map((s) => (
            <span key={s} className={`pill ${s === 'dead_letter' ? 'escalated' : s}`}>
              {s.replace('_', ' ')} {health[s] ?? 0}
            </span>
          ))}
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await api.runWorkerCycle();
                setStatus({
                  kind: 'ok',
                  message: `Cycle ran: ${result.scheduled} scheduled, ${result.ran.length} executed.`,
                });
              }, 'Cycle complete.')
            }
          >
            Run a cycle now
          </button>
          <span className="hint">
            Does exactly what the worker&apos;s loop does, once — so you can watch it without waiting
            on the poll interval.
          </span>
        </div>
      </div>

      {deadLetters.length > 0 && (
        <div className="card">
          <h2>Needs a human ({deadLetters.length})</h2>
          <p className="hint">
            These exhausted their retries. Nothing was dropped — the error is recorded and the work
            is still owed. Fix the cause, then put it back in the queue.
          </p>
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deadLetters.map((job) => (
                <tr key={job.id}>
                  <td>
                    {KIND_LABELS[job.kind] ?? job.kind}
                    <span className="mono"> · #{job.id}</span>
                  </td>
                  <td className="mono">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td className="mono">{job.last_error}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(() => api.retryJob(job.id), `Job ${job.id} is back in the queue.`)
                      }
                    >
                      Put back in the queue
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Recent runs ({data.jobs.length})</h2>
        <p className="hint">
          Order is decided by the Coordination and Governance Agent, not by arrival. Outbound work a
          human authorised outranks the sweeps that produce work, which outrank the agents that react
          to what was produced. <strong>Holds</strong> is the resource a job takes exclusively while
          it runs — two jobs naming the same one never run at once, so one author&apos;s press
          pipeline stays in order while another author&apos;s runs in parallel.
        </p>
        {data.jobs.length === 0 ? (
          <div className="empty">
            Nothing has run yet. Start the worker, or press “Run a cycle now”.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Assigned to</th>
                <th>Priority</th>
                <th>Holds</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Due</th>
                <th>Finished</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.slice(0, 40).map((job) => (
                <tr key={job.id}>
                  <td>
                    {KIND_LABELS[job.kind] ?? job.kind}
                    {job.author_id === null && <span className="mono"> · system-wide</span>}
                    {/* STORY-040: a waiting task says what it is waiting for. */}
                    {job.status === 'queued' && job.deferred_reason && (
                      <div className="hint">⏸ {job.deferred_reason}</div>
                    )}
                  </td>
                  {/* Who the task manager gave it to, and on what grounds
                      (STORY-040) — shown, so an assignment can be reviewed
                      without reading the audit log. */}
                  <td>
                    {job.agent || '—'}
                    {job.coordination?.reason && <div className="hint">{job.coordination.reason}</div>}
                    {job.requires?.length > 0 && <div className="hint">needs {job.requires.join(', ')}</div>}
                  </td>
                  <td className="mono">{job.priority ?? '—'}</td>
                  <td className="mono">{job.resource ?? '—'}</td>
                  <td>
                    <span className={`pill ${job.status === 'dead_letter' ? 'escalated' : job.status}`}>
                      {job.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="mono">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td className="mono">{when(job.run_at)}</td>
                  <td className="mono">{when(job.finished_at)}</td>
                  <td className="mono">
                    {job.last_error ?? (job.result ? JSON.stringify(job.result) : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* STORY-039: the hand-offs between agents. Before this, agents learned
          of each other's work by polling a table every five minutes. */}
      {messages && (
        <div className="card">
          <h2>Messages between agents</h2>
          <p className="hint">
            When one agent needs another to act, it sends a message in the same transaction as the
            change it describes, and the worker delivers it within one poll ({messages.pollSeconds}s)
            — where this used to wait for a sweep, up to five minutes. Every message is acknowledged
            by its recipient or kept as a dead letter; none is dropped. The sweeps still run, so a
            message lost to a bug is a late notice, not a missing one.
          </p>

          <h3>Who may tell whom what</h3>
          <table>
            <thead>
              <tr><th>Recipient</th><th>Topic</th><th>Why</th></tr>
            </thead>
            <tbody>
              {Object.entries(messages.contracts).flatMap(([to, topics]) =>
                Object.entries(topics).map(([topic, why]) => (
                  <tr key={`${to}:${topic}`}>
                    <td>{to}</td>
                    <td className="mono">{topic}</td>
                    <td className="hint">{why}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>

          {messages.latency.length > 0 && (
            <>
              <h3>How fast</h3>
              <div className="meta">
                {messages.latency.map((l) => (
                  <span className="pill" key={l.topic}>
                    {l.topic}: {l.delivered} delivered · avg {ms(l.avg_ms)} · slowest {ms(l.max_ms)}
                  </span>
                ))}
              </div>
            </>
          )}

          {messages.dead.length > 0 && (
            <>
              <h3>Dead letters ({messages.dead.length})</h3>
              <table>
                <thead>
                  <tr><th>Message</th><th>Attempts</th><th>Last error</th><th /></tr>
                </thead>
                <tbody>
                  {messages.dead.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="mono">{m.topic}</span>
                        <div className="hint">{m.sender} → {m.recipient}</div>
                      </td>
                      <td className="mono">{m.attempts}</td>
                      <td className="hint">{m.last_error}</td>
                      <td>
                        {canOperate && (
                          <button
                            className="ghost"
                            disabled={busy}
                            onClick={() => run(() => api.redeliverMessage(m.id), 'Queued for redelivery.')}
                          >
                            Redeliver
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Recent ({messages.recent.length})</h3>
          {messages.recent.length === 0 ? (
            <div className="empty">No messages yet.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Topic</th><th>From → to</th><th>Status</th><th>Sent</th><th>Handled</th></tr>
              </thead>
              <tbody>
                {messages.recent.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.topic}</td>
                    <td className="hint">{m.sender} → {m.recipient}</td>
                    <td>
                      <span className={`pill ${MESSAGE_STATUS[m.status] ?? ''}`}>
                        {m.status === 'delivered' ? `delivered, awaiting ack` : m.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="mono">{when(m.created_at)}</td>
                    <td className="mono">
                      {m.acked_at ? ms(new Date(m.acked_at) - new Date(m.created_at)) + ' later' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
