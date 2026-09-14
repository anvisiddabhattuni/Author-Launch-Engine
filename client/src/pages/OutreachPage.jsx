import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const DECIDABLE = ['pending_approval', 'escalated'];

/** STORY-002 scenario 2: personalized messages, human-reviewed before sending. */
export function OutreachPage({ author }) {
  const [messages, setMessages] = useState([]);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    () => api.outreachMessages({ authorId: author.id }).then(setMessages),
    [author.id],
  );

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

  const queue = messages.filter((m) => DECIDABLE.includes(m.status));
  const approved = messages.filter((m) => m.status === 'approved');
  const done = messages.filter((m) => ['sent', 'rejected'].includes(m.status));

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Awaiting your decision ({queue.length})</h2>
        <p className="hint">
          Nothing is emailed without an approval recorded against your name. A message is escalated
          when confidence is low, when it does not carry what the book argues, or when it does not
          sound like the author — three separate floors, so a pitch cannot pass on one by being
          strong on another. This is the channel that reaches a named stranger, so it is measured
          the same way social posts and press materials are (STORY-023).
        </p>

        <label htmlFor="reviewer">Reviewer</label>
        <input id="reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {queue.length === 0 ? (
          <div className="empty">Nothing pending. Draft outreach on the Opportunities tab.</div>
        ) : (
          queue.map((message) => (
            <div className="draft" key={message.id}>
              <div className="meta">
                <span className={`pill ${message.status}`}>{message.status.replace('_', ' ')}</span>
                <span className="pill">{message.opportunity_type}</span>
                <strong>{message.opportunity_name}</strong>
                <span>to {message.contact_email}</span>
                <span>confidence {Number(message.confidence).toFixed(3)}</span>
                {/* STORY-023: both were computed and blended away before. A
                    reviewer deciding on a pitch needs to see the two numbers
                    that can escalate it, not only the one that averages them. */}
                {message.theme_alignment !== null && message.theme_alignment !== undefined && (
                  <span>alignment {Number(message.theme_alignment).toFixed(2)}</span>
                )}
                {message.voice_score !== null && message.voice_score !== undefined && (
                  <span>voice {Number(message.voice_score).toFixed(2)}</span>
                )}
                {message.themes_used?.length > 0 && (
                  <span className="mono">themes: {message.themes_used.join(', ')}</span>
                )}
              </div>

              {message.voice_violations?.length > 0 && (
                <p className="hint">
                  Reads unlike the author on:{' '}
                  <span className="mono">{message.voice_violations.join(', ')}</span>
                </p>
              )}

              <div style={{ marginTop: 10 }}>
                <strong>{message.subject}</strong>
              </div>
              <pre>{message.body}</pre>

              <div className="meta mono">{message.rationale}</div>

              <input
                placeholder="Notes for the record (optional)"
                value={notes[message.id] ?? ''}
                onChange={(e) => setNotes({ ...notes, [message.id]: e.target.value })}
                style={{ marginTop: 12 }}
              />

              <div className="row">
                <button
                  disabled={busy || !reviewer.trim()}
                  onClick={() =>
                    run(
                      () =>
                        api.approveOutreach(message.id, { reviewer, notes: notes[message.id] ?? '' }),
                      `Message ${message.id} approved. It can now be sent.`,
                    )
                  }
                >
                  Approve
                </button>
                <button
                  className="danger"
                  disabled={busy || !reviewer.trim()}
                  onClick={() =>
                    run(
                      () =>
                        api.rejectOutreach(message.id, { reviewer, notes: notes[message.id] ?? '' }),
                      `Message ${message.id} rejected.`,
                    )
                  }
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Approved, ready to send ({approved.length})</h2>
        <p className="hint">Sending goes through a mocked email provider; no real mail leaves.</p>
        {approved.length === 0 ? (
          <div className="empty">Nothing approved yet.</div>
        ) : (
          approved.map((message) => (
            <div className="draft" key={message.id}>
              <div className="meta">
                <span className="pill approved">approved</span>
                <strong>{message.opportunity_name}</strong>
                <span>to {message.contact_email}</span>
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>{message.subject}</strong>
              </div>
              <button
                style={{ marginTop: 12 }}
                disabled={busy}
                onClick={() =>
                  run(() => api.sendOutreach(message.id), `Message ${message.id} sent.`)
                }
              >
                Send
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Sent and rejected ({done.length})</h2>
        {done.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Type</th>
                <th>Status</th>
                <th>Recipient</th>
                <th>Provider id</th>
              </tr>
            </thead>
            <tbody>
              {done.map((message) => (
                <tr key={message.id}>
                  <td>{message.opportunity_name}</td>
                  <td>{message.opportunity_type}</td>
                  <td>
                    <span className={`pill ${message.status}`}>{message.status}</span>
                  </td>
                  <td className="mono">{message.contact_email}</td>
                  <td className="mono">{message.send_external_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
