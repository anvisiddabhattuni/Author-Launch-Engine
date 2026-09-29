import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const DECIDABLE = ['pending_approval', 'escalated'];

/** The approval gate (REQ-006): nothing is scheduled without a decision here. */
export function ReviewPage({ author, book }) {
  const [drafts, setDrafts] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [grounding, setGrounding] = useState(null);
  const [waiting, setWaiting] = useState(null);
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
    setWaiting(await api.awaitingApproval(author.id));
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
      } else if (decision === 'changes') {
        // STORY-047: the note is the request; a revision comes back into this queue.
        const r = await api.requestChanges(draft.id, notes[draft.id] ?? '');
        setStatus(r.revision
          ? { kind: 'ok', message: `Changes requested on draft ${draft.id}. Revision #${r.revision.id} is in the queue for review.` }
          : { kind: 'error', message: `Changes requested on draft ${draft.id}, but no revision came back: ${r.revisionError}` });
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

      {waiting && (
        <div className="card">
          <h2>Waiting on you ({waiting.total})</h2>
          <p className="hint">
            Everything held for a decision, across all four kinds of work — not just the social
            drafts on this page. Nothing here has been published and nothing will be until you
            decide. {waiting.escalated > 0 && (
              <>
                <strong>{waiting.escalated}</strong> of these were escalated: something checked them
                and asked for a person rather than letting them through.
              </>
            )}
          </p>

          {waiting.total === 0 ? (
            <div className="empty">Nothing is waiting on you.</div>
          ) : (
            <>
              <div className="meta">
                {Object.entries(waiting.byKind).map(([kind, n]) => (
                  <span className="pill" key={kind}>
                    {n} {kind === 'mixRecommendation' ? 'mix change' : kind}
                    {n === 1 ? '' : 's'}
                  </span>
                ))}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>What</th>
                    <th>Detail</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {waiting.items.slice(0, 12).map((item) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td>{item.label}</td>
                      <td className="mono">{item.detail}</td>
                      <td>
                        <span className={`pill ${item.escalated ? 'escalated' : 'pending_approval'}`}>
                          {item.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setStatus(null);
                try {
                  const r = await api.notifyAwaiting(author.id);
                  setStatus({
                    kind: r.unreachable ? 'error' : 'ok',
                    message: r.unreachable
                      ? `${r.waiting} items are waiting and no active reviewer is configured to tell. Recorded rather than passed over.`
                      : r.notified.length === 0
                        ? `Nothing new to announce — all ${r.waiting} were already sent to their reviewers.`
                        : `Told ${r.notified.length} reviewer(s). One digest each, covering only what they had not already been sent.`,
                  });
                  await refresh();
                } catch (error) {
                  setStatus({ kind: 'error', message: error.message });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Tell the reviewers
            </button>
          </div>
        </div>
      )}

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

              {draft.revision_of && (() => {
                const original = drafts.find((x) => Number(x.id) === Number(draft.revision_of));
                return (
                  <div className="hint" style={{ marginTop: 6 }}>
                    Revision of draft #{draft.revision_of}
                    {original?.change_request ? <> — {original.changes_requested_by} asked: “{original.change_request}”</> : null}
                  </div>
                );
              })()}

              <BookComparison review={draft.bookReview} />

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
                  className="ghost"
                  onClick={() => decide(draft, 'changes')}
                  disabled={busy || (notes[draft.id] ?? '').trim().length < 10}
                  title="Write what should change in the notes box first"
                >
                  Request changes
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
                    <span className={`pill ${draft.status === 'changes_requested' ? 'pending_approval' : draft.status}`}>{draft.status.replace('_', ' ')}</span>
                  </td>
                  <td>
                    {draft.content.slice(0, 90)}…
                    <RateDraft draft={draft} onDone={refresh} />
                    {draft.status === 'changes_requested' && (
                      <div className="hint">
                        {draft.changes_requested_by}: “{draft.change_request}”
                        {(() => {
                          const rev = drafts.find((x) => Number(x.revision_of) === Number(draft.id));
                          return rev ? ` → revised as #${rev.id}` : '';
                        })()}
                      </div>
                    )}
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

/**
 * The draft compared with the book (STORY-047): each claimed theme, whether it
 * is argued and in the book's own words, and each style element against the
 * book's. Shown beside the buttons; it informs the decision, it does not make it.
 */
function BookComparison({ review }) {
  if (!review) return <div className="hint" style={{ marginTop: 6 }}>Not compared with the book (drafted before STORY-047).</div>;
  const c = review.comparison;
  const VERDICT = { aligned: ['approved', 'matches the book'], check: ['pending_approval', 'check against the book'], misaligned: ['escalated', 'does not match the book'] };
  const [pill, label] = VERDICT[review.verdict];
  return (
    <div className="book-comparison" style={{ marginTop: 8 }}>
      <div className="meta">
        <span className={`pill ${pill}`}>{label}</span>
        {c.themes.map((t) => (
          <span key={t.theme} className={`pill ${t.aligned && t.inBookLanguage ? 'approved' : t.aligned ? 'pending_approval' : 'escalated'}`}>
            {t.theme}{t.bookWords.length ? ` · book's words: ${t.bookWords.join(', ')}` : t.learned ? ' · none of the book’s words' : ''}
          </span>
        ))}
        {c.style.map((st) => (
          <span key={st.element} className={`pill ${st.fits ? 'neutral' : 'escalated'}`} title={`draft ${st.draft} · book ${st.book}`}>
            {st.label.toLowerCase()} {st.fits ? '✓' : `${st.draft} vs book ${st.book}`}
          </span>
        ))}
        {review.model_version && <span className="pill neutral">book model v{review.model_version}</span>}
      </div>
      {c.notes.length > 0 && <div className="hint">{c.notes.join(' · ')}</div>}
    </div>
  );
}

/**
 * A rating and a comment on a decided draft (STORY-048). Fed back into the
 * book's model: what reviewers keep turning down stops being quoted.
 */
function RateDraft({ draft, onDone }) {
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(null);
  async function rate(rating) {
    try {
      await api.rateDraft(draft.id, { rating, comment: comment.trim() || null });
      setSent(`Rated ${rating}/5 — it counts from the next drafts.`);
      setComment('');
      onDone?.();
    } catch (e) {
      setSent(e.message);
    }
  }
  if (sent) return <div className="hint">{sent}</div>;
  const given = draft.feedback;
  if (given) {
    return (
      <div className="hint" style={{ marginTop: 6 }}>
        <span className={`pill ${given.rating >= 4 ? 'approved' : given.rating <= 2 ? 'escalated' : 'neutral'}`}>
          {given.rating ? `rated ${given.rating}/5` : 'comment'}
        </span>{' '}
        {given.given_by}{given.comment ? `: “${given.comment}”` : ''}
      </div>
    );
  }
  return (
    <div className="row" style={{ marginTop: 6, gap: 4, alignItems: 'center' }}>
      <input
        placeholder="What worked, or didn't (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        style={{ flex: 1, minWidth: 160, padding: '4px 8px' }}
      />
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className="ghost" style={{ padding: '2px 8px' }} onClick={() => rate(n)} title={`Rate ${n} of 5`}>
          {n}
        </button>
      ))}
    </div>
  );
}
