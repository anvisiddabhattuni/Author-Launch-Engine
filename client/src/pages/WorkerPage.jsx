import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime } from '../labels.js';

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

const when = localTime;
const JOB_STATUS = { queued: 'Waiting', running: 'Running', done: 'Done', dead_letter: 'Stuck', cancelled: 'Cancelled' };

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

  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  const deadLetters = data.jobs.filter((j) => j.status === 'dead_letter');
  const health = data.health ?? {};

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>How background work is going</h2>
        <p className="hint">
          The app does some jobs by itself — posting at the scheduled time, sending approved emails, reminding
          reviewers. It only carries out things a person has already approved. If a job fails{' '}
          {data.maxAttempts} times, it stops and waits for a person below.
        </p>

        <div className="meta">
          {[['queued', 'Waiting'], ['running', 'Running now'], ['done', 'Done'], ['dead_letter', 'Stuck'], ['cancelled', 'Cancelled']].map(([s, word]) => (
            <span key={s} className={`pill ${s === 'dead_letter' ? (health[s] ? 'escalated' : 'approved') : s}`}>
              {word}: {health[s] ?? 0}
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
                  message: `Done: ${result.ran.length} job${result.ran.length === 1 ? '' : 's'} ran, ${result.scheduled} new one${result.scheduled === 1 ? '' : 's'} lined up.`,
                });
              }, 'Done.')
            }
          >
            Run background jobs now
          </button>
          <span className="hint">They run every {data.pollSeconds} seconds anyway — this just doesn’t wait.</span>
        </div>
      </div>

      {deadLetters.length > 0 && (
        <div className="card">
          <h2>Stuck — needs a person ({deadLetters.length})</h2>
          <p className="hint">
            These failed every time they were tried. Nothing was lost. Once the cause is fixed, press “Try again”.
          </p>
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Tries</th>
                <th>What went wrong</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deadLetters.map((job) => (
                <tr key={job.id}>
                  <td>
                    {KIND_LABELS[job.kind] ?? job.kind}
                    <span className="hint"> · #{job.id}</span>
                  </td>
                  <td className="num">
                    {job.attempts} of {job.max_attempts}
                  </td>
                  <td className="audit-detail mono">{job.last_error}</td>
                  <td className="cell-action">
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(() => api.retryJob(job.id), `Job ${job.id} will be tried again.`)
                      }
                    >
                      Try again
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Recent jobs ({data.jobs.length})</h2>
        <p className="hint">
          Jobs a person approved — like sending a post — go first. Hover over “Handled by” to see why a job was ordered the way it was.
        </p>
        {data.jobs.length === 0 ? (
          <div className="empty">
            Nothing has run yet. Press “Run background jobs now” to start.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Due</th>
                <th>Finished</th>
                <th>Handled by</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.slice(0, 40).map((job) => (
                <tr key={job.id}>
                  <td>
                    {KIND_LABELS[job.kind] ?? job.kind}
                    {job.author_id === null && <span className="hint"> · all authors</span>}
                    {/* STORY-040: a waiting task says what it is waiting for. */}
                    {job.status === 'queued' && job.deferred_reason && (
                      <div className="hint">⏸ {job.deferred_reason}</div>
                    )}
                  </td>
                  {/* Who the task manager gave it to, and on what grounds
                      (STORY-040) — shown, so an assignment can be reviewed
                      without reading the audit log. */}
                  <td>
                    <span className={`pill ${job.status === 'dead_letter' ? 'escalated' : job.status}`}>
                      {JOB_STATUS[job.status] ?? job.status}
                    </span>
                    {job.attempts > 1 && <div className="hint">try {job.attempts} of {job.max_attempts}</div>}
                  </td>
                  <td className="num">{when(job.run_at)}</td>
                  <td className="num">{when(job.finished_at)}</td>
                  <td
                    title={[
                      job.coordination?.reason,
                      job.requires?.length ? `needs ${job.requires.join(', ')}` : null,
                      job.priority != null ? `priority ${job.priority}` : null,
                      job.resource ? `holds ${job.resource}` : null,
                    ].filter(Boolean).join(' · ')}
                  >
                    {job.agent || '—'}
                  </td>
                  <td className="audit-detail mono">
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
        <details className="card disclosure">
          <summary><h2>Technical: messages between the app’s helpers</h2></summary>
          <p className="hint">
            The parts of the app (“agents”) pass notes to each other when one needs another to act. Notes are
            delivered within {messages.pollSeconds} seconds and none is ever dropped — a note that can’t be delivered
            is kept below.
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
              <h3>Couldn’t be delivered ({messages.dead.length})</h3>
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
                            onClick={() => run(() => api.redeliverMessage(m.id), 'It will be delivered again.')}
                          >
                            Deliver again
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
        </details>
      )}
    </>
  );
}
