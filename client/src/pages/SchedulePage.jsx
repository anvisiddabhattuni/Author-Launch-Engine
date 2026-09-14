import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const when = (value) => new Date(value).toUTCString().replace(' GMT', ' UTC');

/** Build steps 4 and 5: queue approved posts, then publish through mocks. */
export function SchedulePage({ author }) {
  const [approved, setApproved] = useState([]);
  const [posts, setPosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [a, p] = await Promise.all([
      api.drafts({ authorId: author.id, status: 'approved' }),
      api.scheduledPosts(author.id),
    ]);
    setApproved(a);
    setPosts(p);
  }, [author.id]);

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

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {/* STORY-025: a failed post used to be one pill in a table nobody had a
          reason to open, while the author believed it had gone out. The failure
          is announced by email now; this is the same fact on the page they are
          already looking at. */}
      {posts.some((p) => p.status === 'failed') && (
        <div className="banner error">
          <strong>
            {posts.filter((p) => p.status === 'failed').length} post
            {posts.filter((p) => p.status === 'failed').length === 1 ? '' : 's'} failed to publish.
          </strong>{' '}
          These were approved and scheduled — the failure happened at the platform, after the gate.
          Nothing was published that should not have been, and a failed post does not retry on its
          own. Your reviewers have been emailed once about each.
        </div>
      )}

      <div className="card">
        <h2>Approved, ready to queue ({approved.length})</h2>
        <p className="hint">
          Scheduling picks the next high-engagement window for the platform and avoids stacking two
          posts within an hour of each other.
        </p>
        {approved.length === 0 ? (
          <div className="empty">Nothing approved yet. Approve a draft on the Review tab.</div>
        ) : (
          approved.map((draft) => (
            <div className="draft" key={draft.id}>
              <div className="meta">
                <span className="pill approved">approved</span>
                <strong>{draft.platform}</strong>
                <span>draft {draft.id}</span>
              </div>
              <pre>{draft.content}</pre>
              <button
                disabled={busy}
                onClick={() =>
                  run(() => api.schedule(draft.id), `Draft ${draft.id} queued at its next optimal slot.`)
                }
              >
                Schedule at optimal time
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Publishing queue ({posts.length})</h2>
        <p className="hint">
          Publishing goes through mocked platform adapters, so the demo runs without live social
          accounts. "Publish due now" fast-forwards the clock 60 days to flush the queue.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(
                () => api.publishDue(new Date(Date.now() + 60 * 864e5).toISOString()),
                'Ran the publisher over everything due.',
              )
            }
          >
            Publish due now
          </button>
        </div>

        {posts.length === 0 ? (
          <div className="empty">Nothing queued.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Scheduled for (UTC)</th>
                <th>Status</th>
                <th>Platform id</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>{post.platform}</td>
                  <td className="mono">{when(post.scheduled_for)}</td>
                  <td>
                    <span className={`pill ${post.status}`}>{post.status}</span>
                  </td>
                  <td className="mono">{post.external_id ?? post.error ?? '—'}</td>
                  <td>{post.content.slice(0, 70)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
