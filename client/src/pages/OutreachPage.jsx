import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { statusLabel } from '../labels.js';

const pct = (x) => `${Math.round(Number(x) * 100)}%`;

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
        <h2>Pitches waiting for you ({queue.length})</h2>
        <p className="hint">
          Each pitch is an email to a real person, so nothing is sent until you approve it. Pitches marked{' '}
          <span className="pill escalated">flagged</span> didn’t pass an automatic check — read those carefully.
        </p>

        <label htmlFor="reviewer">Your name</label>
        <input id="reviewer" className="narrow" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {queue.length === 0 ? (
          <div className="empty">No pitches waiting. Write some from the Opportunities page.</div>
        ) : (
          queue.map((message) => {
            const themeOk = message.theme_alignment == null || Number(message.theme_alignment) >= 0.5;
            const voiceOk = message.voice_score == null || Number(message.voice_score) >= 0.5;
            return (
              <article className={`draft${message.status === 'escalated' ? ' draft-flagged' : ''}`} key={message.id}>
                <div className="draft-head">
                  <span className={`pill ${message.status}`}>{message.status === 'escalated' ? 'Flagged — check carefully' : 'Needs review'}</span>
                  <strong>{message.opportunity_name}</strong>
                  <span className="pill neutral">{message.opportunity_type}</span>
                  <span className="draft-id">Pitch #{message.id}</span>
                </div>
                <div className="email-preview">
                  <div className="hint">To: {message.contact_email}</div>
                  <div className="email-subject">{message.subject}</div>
                  <pre>{message.body}</pre>
                </div>
                <div className="checks">
                  {message.theme_alignment != null && (
                    <span className={`check ${themeOk ? 'ok' : 'bad'}`}>{themeOk ? '✓' : '!'} Matches your book <strong>{pct(message.theme_alignment)}</strong></span>
                  )}
                  {message.voice_score != null && (
                    <span className={`check ${voiceOk ? 'ok' : 'bad'}`}>{voiceOk ? '✓' : '!'} Sounds like you <strong>{pct(message.voice_score)}</strong></span>
                  )}
                </div>
                <details className="draft-details">
                  <summary>Details — how this pitch was checked</summary>
                  {message.themes_used?.length > 0 && <p className="hint">Themes used: {message.themes_used.join(', ')}</p>}
                  {message.voice_violations?.length > 0 && <p className="hint">Doesn’t sound like you because of: {message.voice_violations.join(', ')}</p>}
                  <p className="hint mono">Overall confidence {pct(message.confidence)} · {message.rationale}</p>
                </details>
                <label htmlFor={`note-${message.id}`}>Note <span className="label-hint">— optional</span></label>
                <input
                  id={`note-${message.id}`}
                  placeholder="Notes — anything worth recording about this decision"
                  value={notes[message.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [message.id]: e.target.value })}
                />
                <div className="row">
                  <button
                    disabled={busy || !reviewer.trim()}
                    onClick={() => run(() => api.approveOutreach(message.id, { reviewer, notes: notes[message.id] ?? '' }), `Pitch ${message.id} approved. Send it from the list below when you’re ready.`)}
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={busy || !reviewer.trim()}
                    onClick={() => run(() => api.rejectOutreach(message.id, { reviewer, notes: notes[message.id] ?? '' }), `Pitch ${message.id} rejected. It won’t be sent.`)}
                  >
                    Reject
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="card">
        <h2>Approved — ready to send ({approved.length})</h2>
        <p className="hint">In this demo, sending is simulated — no real email leaves the app.</p>
        {approved.length === 0 ? (
          <div className="empty">Nothing approved yet.</div>
        ) : (
          approved.map((message) => (
            <div className="draft" key={message.id}>
              <div className="draft-head">
                <span className="pill approved">Approved</span>
                <strong>{message.opportunity_name}</strong>
                <span className="hint">to {message.contact_email}</span>
              </div>
              <div className="email-subject">{message.subject}</div>
              <div className="row">
                <button disabled={busy} onClick={() => run(() => api.sendOutreach(message.id), `Pitch ${message.id} sent to ${message.contact_email}.`)}>
                  Send now
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <details className="card disclosure">
        <summary><h2>Sent and rejected ({done.length})</h2></summary>
        {done.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <table>
            <thead><tr><th>Opportunity</th><th>Type</th><th>Status</th><th>Sent to</th></tr></thead>
            <tbody>
              {done.map((message) => (
                <tr key={message.id}>
                  <td>{message.opportunity_name}</td>
                  <td>{message.opportunity_type}</td>
                  <td><span className={`pill ${message.status}`}>{statusLabel(message.status)}</span></td>
                  <td>{message.contact_email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </>
  );
}
