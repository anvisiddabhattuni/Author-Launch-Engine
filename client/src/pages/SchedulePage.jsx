import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime, platformName, statusLabel } from '../labels.js';


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

  const failed = posts.filter((p) => p.status === 'failed').length;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {/* STORY-025: a failed post is announced by email and shown here. */}
      {failed > 0 && (
        <div className="banner error">
          <strong>{failed} post{failed === 1 ? '' : 's'} couldn’t be posted.</strong>{' '}
          {failed === 1 ? 'It was' : 'They were'} approved and scheduled, but the platform refused {failed === 1 ? 'it' : 'them'}.
          Failed posts don’t retry on their own, and your reviewers have been emailed. Nothing went out that you
          hadn’t approved.
        </div>
      )}

      <div className="card">
        <h2>Approved — ready to schedule ({approved.length})</h2>
        <p className="hint">
          The app picks the next good time to post on each platform, and keeps your posts at least an hour apart.
        </p>
        {approved.length === 0 ? (
          <div className="empty">Nothing approved yet. Approve posts on the Review posts page.</div>
        ) : (
          approved.map((draft) => (
            <div className="draft" key={draft.id}>
              <div className="draft-head">
                <span className="pill approved">Approved</span>
                <strong>{platformName(draft.platform)}</strong>
                <span className="draft-id">Post #{draft.id}</span>
              </div>
              <pre>{draft.content}</pre>
              <div className="row">
                <button
                  disabled={busy}
                  onClick={() => run(() => api.schedule(draft.id), `Post ${draft.id} is scheduled for the next good time to post.`)}
                >
                  Schedule for the best time
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Scheduled and posted ({posts.length})</h2>
        <p className="hint">
          In this demo, posting is simulated — nothing reaches real social media accounts. “Post everything due now”
          skips ahead in time so you can see scheduled posts go out.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => run(() => api.publishDue(new Date(Date.now() + 60 * 864e5).toISOString()), 'Everything that was due has been posted.')}
          >
            Post everything due now
          </button>
        </div>

        {posts.length === 0 ? (
          <div className="empty">Nothing scheduled yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Platform</th><th>When</th><th>Status</th><th>Post</th></tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>{platformName(post.platform)}</td>
                  <td>{localTime(post.scheduled_for)}</td>
                  <td>
                    <span className={`pill ${post.status}`}>{statusLabel(post.status)}</span>
                    {post.status === 'failed' && post.error && <div className="hint">{post.error}</div>}
                  </td>
                  <td>{post.content.slice(0, 90)}{post.content.length > 90 ? '…' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
