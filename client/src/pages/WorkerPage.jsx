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

export function WorkerPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setData(await api.jobs()), []);

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
                  </td>
                  {/* What the Coordination and Governance Agent decided, and why
                      (STORY-011). The title carries the reason so a queue that
                      looks stalled can be explained without reading code. */}
                  <td className="mono" title={job.coordination?.reason ?? ''}>
                    {job.priority ?? '—'}
                  </td>
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
    </>
  );
}
