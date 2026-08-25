import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const DECIDABLE = ['pending_approval', 'escalated'];

/** The approval gate (REQ-006): nothing is scheduled without a decision here. */
export function ReviewPage({ author, book }) {
  const [drafts, setDrafts] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [grounding, setGrounding] = useState(null);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [d, c] = await Promise.all([
      api.drafts({ authorId: author.id }),
      api.weeklyCoverage(author.id),
    ]);
    setDrafts(d);
    setCoverage(c);
    if (book?.id) {
      setGrounding(await api.voiceGrounding(author.id, book.id));
    }
  }, [author.id, book?.id]);

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function decide(draft, decision) {
    setBusy(true);
    setStatus(null);
    try {
      const body = { reviewer, notes: notes[draft.id] ?? '' };
      if (decision === 'approve') {
        await api.approve(draft.id, body);
        setStatus({ kind: 'ok', message: `Draft ${draft.id} approved. Schedule it on the next tab.` });
      } else {
        await api.reject(draft.id, body);
        setStatus({ kind: 'ok', message: `Draft ${draft.id} rejected.` });
      }
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const queue = drafts.filter((d) => DECIDABLE.includes(d.status));
  const decided = drafts.filter((d) => !DECIDABLE.includes(d.status));

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Weekly cadence</h2>
        <p className="hint">
          Acceptance criterion: at least three posts drafted per week, tailored across platforms.
        </p>
        {coverage.length === 0 ? (
          <div className="empty">No drafts yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th>Drafts</th>
                <th>Platforms</th>
                <th>Meets minimum</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((week) => (
                <tr key={week.week_of}>
                  <td className="mono">{String(week.week_of).slice(0, 10)}</td>
                  <td>{week.total}</td>
                  <td className="mono">{week.platform_list.join(', ')}</td>
                  <td>
                    <span className={`pill ${week.meetsMinimum ? 'approved' : 'escalated'}`}>
                      {week.meetsMinimum ? `yes (>= ${week.minimum})` : `no (< ${week.minimum})`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Awaiting your decision ({queue.length})</h2>
        <p className="hint">
          Every decision is written to the audit log against your name. A draft is escalated when it
          falls below any of three floors, scored separately on purpose: confidence, how far it
          argues the book&apos;s themes rather than naming them, and how close it sits to how the
          author actually writes. A post can be word-perfect and still be in the wrong voice.
        </p>

        <label htmlFor="reviewer">Reviewer</label>
        <input id="reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {queue.length === 0 ? (
          <div className="empty">Nothing pending. Generate drafts on the Upload tab.</div>
        ) : (
          queue.map((draft) => (
            <div className="draft" key={draft.id}>
              <div className="meta">
                <span className={`pill ${draft.status}`}>{draft.status.replace('_', ' ')}</span>
                <strong>{draft.platform}</strong>
                <span>confidence {Number(draft.confidence).toFixed(3)}</span>
                <span
                  className={
                    Number(draft.theme_alignment) < (draft.floors?.themeAlignment ?? 0.5)
                      ? 'pill escalated'
                      : undefined
                  }
                >
                  themes {Number(draft.theme_alignment).toFixed(2)}
                </span>
                <span
                  className={
                    Number(draft.voice_score) < (draft.floors?.voice ?? 0.5)
                      ? 'pill escalated'
                      : undefined
                  }
                >
                  voice {Number(draft.voice_score).toFixed(2)}
                </span>
                <span>draft {draft.id}</span>
              </div>

              {draft.format === 'meme' ? (
                // Image and caption previewed as one unit (STORY-066): they are
                // one post, and a reviewer judging the caption alone is judging
                // half of what would go out.
                <div className="meme">
                  <img src={draft.media?.imageRef} alt={draft.media?.altText ?? ''} />
                  <div>
                    <pre>{draft.content}</pre>
                    <div className="meta mono">
                      <span>{draft.media?.template}</span>
                      <span>{draft.media?.provenance?.licence?.terms ?? 'no licence'}</span>
                      {draft.media?.provenance?.licence?.attribution && (
                        <span>© {draft.media.provenance.licence.attribution}</span>
                      )}
                    </div>
                    <div className="meta mono">
                      alt: {draft.media?.altText || <em>none — unreadable to a screen reader</em>}
                    </div>
                  </div>
                </div>
              ) : (
                <pre>{draft.content}</pre>
              )}

              <div className="meta mono">{draft.rationale}</div>

              {draft.format === 'meme' && (
                <div className="meta">
                  {/* Rights outrank approval, so they are stated plainly rather
                      than buried in the rationale. */}
                  <span
                    className={`pill ${draft.image_rights === 'cleared' ? 'approved' : 'escalated'}`}
                    title="An uncleared image cannot publish even once you approve it"
                  >
                    image rights: {draft.image_rights}
                  </span>
                  {draft.safety_findings?.map((f) => (
                    <span className="pill unnamed" key={f}>
                      {f.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}

              {draft.voice_violations?.length > 0 && (
                <div className="meta">
                  {/* A trait can drift without the post failing the voice floor.
                      Saying so in the same red as an escalation would make every
                      long sentence look like a rejected draft. */}
                  <span
                    className={`pill ${
                      Number(draft.voice_score) < (draft.floors?.voice ?? 0.5) ? 'unnamed' : 'neutral'
                    }`}
                  >
                    {Number(draft.voice_score) < (draft.floors?.voice ?? 0.5)
                      ? 'unlike the author'
                      : 'drifts from the author'}
                  </span>
                  {draft.voice_violations.map((v) => (
                    <span className="mono" key={v}>
                      {v.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              )}

              {draft.themes?.length > 0 && (
                <div className="meta">
                  {draft.themes.map((t) => (
                    <span
                      key={t.theme}
                      className={`pill ${t.score >= 0.5 ? 'approved' : 'unnamed'}`}
                      title={
                        t.known
                          ? `carried: ${t.carried_terms.join(', ') || 'none of the book’s words'}`
                          : 'the book does not claim this theme'
                      }
                    >
                      {t.theme} {Number(t.score).toFixed(2)}
                      {t.known ? '' : ' · not the book’s'}
                    </span>
                  ))}
                </div>
              )}

              <input
                placeholder="Notes for the record (optional)"
                value={notes[draft.id] ?? ''}
                onChange={(e) => setNotes({ ...notes, [draft.id]: e.target.value })}
                style={{ marginTop: 12 }}
              />

              <div className="row">
                <button onClick={() => decide(draft, 'approve')} disabled={busy || !reviewer.trim()}>
                  Approve
                </button>
                <button
                  className="danger"
                  onClick={() => decide(draft, 'reject')}
                  disabled={busy || !reviewer.trim()}
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {grounding && (
        <div className="card">
          <h2>What a draft is written from</h2>
          <p className="hint">
            Before a word is written the agent retrieves what the book argues about each theme, and
            derives the author&apos;s voice from their own previous posts. The finished post is then
            checked against the same two things — which is why the score can fail.
          </p>

          <table>
            <thead>
              <tr>
                <th>Theme</th>
                <th>Key message</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {grounding.themes.map((t) => (
                <tr key={t.theme}>
                  <td>
                    <span className="pill">{t.theme}</span>
                  </td>
                  <td>
                    {t.keyMessage || (
                      <span className="mono">no key message — falls back to the passage</span>
                    )}
                  </td>
                  <td>
                    {t.passages.length > 0 ? (
                      <span className="mono">
                        {t.passages.length} passage{t.passages.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="pill unnamed">the book never argues this</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>The author&apos;s voice, counted from {grounding.voice.priorPosts} previous posts</h3>
          {grounding.voice.enforceable ? (
            <div className="meta mono">
              <span>sentences average {grounding.voice.meanSentenceWords} words</span>
              <span>exclamations {grounding.voice.exclamationsPer100} / 100 words</span>
              <span>hype {grounding.voice.hypePer100} / 100 words</span>
              <span>shouting {grounding.voice.shoutedPer100} / 100 words</span>
              <span>{grounding.voice.vocabulary} distinct words</span>
            </div>
          ) : (
            <div className="empty">
              Only {grounding.voice.priorPosts} prior post
              {grounding.voice.priorPosts === 1 ? '' : 's'} — {grounding.voice.minPostsForTrait} are
              needed before a draft is held to a voice. Add earlier posts on the Upload tab.
            </div>
          )}

          {grounding.voice.statedClaims?.length > 0 && (
            <>
              <p className="hint">
                The voice profile written by hand, checked against what the posts actually show. A
                claim the writing does not support is a wish, not a rule.
              </p>
              <div className="meta">
                {grounding.voice.statedClaims.map((c) => (
                  <span
                    key={c.claim}
                    className={`pill ${
                      c.supported === true ? 'approved' : c.supported === false ? 'escalated' : 'neutral'
                    }`}
                  >
                    {c.claim}
                    {c.supported === true
                      ? ' · supported'
                      : c.supported === false
                        ? ' · not in the writing'
                        : ' · not measurable'}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>Already decided ({decided.length})</h2>
        {decided.length === 0 ? (
          <div className="empty">Nothing decided yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Draft</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((draft) => (
                <tr key={draft.id}>
                  <td className="mono">{draft.id}</td>
                  <td>{draft.platform}</td>
                  <td>
                    <span className={`pill ${draft.status}`}>{draft.status}</span>
                  </td>
                  <td>{draft.content.slice(0, 90)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
