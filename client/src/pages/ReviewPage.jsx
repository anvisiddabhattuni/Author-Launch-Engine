import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { platformName } from '../labels.js';

const DECIDABLE = ['pending_approval', 'escalated'];
const PAGE_SIZE = 8;

/** What each kind of waiting work is called, in words anyone would use. */
const KIND_LABEL = {
  draft: ['social post', 'social posts'],
  drafts: ['social post', 'social posts'],
  outreach: ['outreach email', 'outreach emails'],
  outreachs: ['outreach email', 'outreach emails'],
  prMaterial: ['press item', 'press items'],
  prMaterials: ['press item', 'press items'],
  mixRecommendation: ['posting-mix suggestion', 'posting-mix suggestions'],
};
const kindLabel = (kind, n) => (KIND_LABEL[kind] ? KIND_LABEL[kind][n === 1 ? 0 : 1] : kind);
const pct = (x) => `${Math.round(Number(x) * 100)}%`;

/**
 * Review posts — the approval gate (REQ-006): nothing is scheduled without a
 * decision here. The decision comes first on the page; how a score was reached
 * is one click away under "Details" for whoever wants it.
 */
export function ReviewPage({ author, book }) {
  const [drafts, setDrafts] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [grounding, setGrounding] = useState(null);
  const [waiting, setWaiting] = useState(null);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(PAGE_SIZE);

  const refresh = useCallback(async () => {
    const [d, c] = await Promise.all([api.drafts({ authorId: author.id }), api.weeklyCoverage(author.id)]);
    setDrafts(d);
    setCoverage(c);
    if (book?.id) setGrounding(await api.voiceGrounding(author.id, book.id));
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
        setStatus({ kind: 'ok', message: `Post ${draft.id} approved. You can choose when it goes out on the Schedule page.` });
      } else if (decision === 'changes') {
        // STORY-047: the note is the request; a rewrite comes back into this list.
        const r = await api.requestChanges(draft.id, notes[draft.id] ?? '');
        setStatus(r.revision
          ? { kind: 'ok', message: `Changes requested on post ${draft.id}. The rewrite is post ${r.revision.id}, waiting below for your review.` }
          : { kind: 'error', message: `Changes were requested on post ${draft.id}, but the rewrite could not be made: ${r.revisionError}` });
      } else {
        await api.reject(draft.id, body);
        setStatus({ kind: 'ok', message: `Post ${draft.id} rejected. It will not be posted.` });
      }
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function tellReviewers() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.notifyAwaiting(author.id);
      setStatus({
        kind: r.unreachable ? 'error' : 'ok',
        message: r.unreachable
          ? `${r.waiting} items are waiting, but no reviewer is set up to receive emails. Add one on the Press page.`
          : r.notified.length === 0
            ? 'Everyone has already been told about everything waiting — no new email was needed.'
            : `Emailed ${r.notified.length} reviewer${r.notified.length === 1 ? '' : 's'} a summary of what is waiting.`,
      });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  // Rewrites first (they answer something you asked for), then flagged posts,
  // then the newest — so what most needs a person is at the top.
  const queue = drafts
    .filter((d) => DECIDABLE.includes(d.status))
    .sort((a, b) =>
      Number(Boolean(b.revision_of)) - Number(Boolean(a.revision_of))
      || Number(b.status === 'escalated') - Number(a.status === 'escalated')
      || Number(b.id) - Number(a.id));
  const decided = drafts.filter((d) => !DECIDABLE.includes(d.status));
  const others = waiting ? Object.entries(waiting.byKind).filter(([k]) => !['draft', 'drafts'].includes(k)) : [];

  return (
    <>
      {status && <div className={`banner ${status.kind}`} role="status">{status.message}</div>}

      <div className="card">
        <h2>Posts waiting for you ({queue.length})</h2>
        <p className="hint">
          Posts marked <span className="pill escalated">flagged</span> didn’t pass one of the automatic checks — read
          those carefully. Every decision is saved with your name.
        </p>

        <label htmlFor="reviewer">Your name</label>
        <input id="reviewer" className="narrow" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {queue.length === 0 ? (
          <div className="empty">Nothing to review right now. New posts are created from the My books page.</div>
        ) : (
          <>
            {queue.slice(0, shown).map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                original={drafts.find((x) => Number(x.id) === Number(draft.revision_of))}
                note={notes[draft.id] ?? ''}
                onNote={(v) => setNotes({ ...notes, [draft.id]: v })}
                busy={busy}
                canDecide={Boolean(reviewer.trim())}
                onDecide={(d) => decide(draft, d)}
              />
            ))}
            {queue.length > shown && (
              <button className="ghost show-more" onClick={() => setShown(shown + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, queue.length - shown)} more ({queue.length - shown} left)
              </button>
            )}
          </>
        )}
      </div>

      {waiting && (
        <div className="card">
          <h2>Everything waiting for approval ({waiting.total})</h2>
          <p className="hint">
            Social posts above, plus anything else across the app. Nothing here goes out until someone approves it.
          </p>
          <div className="meta">
            {Object.entries(waiting.byKind).map(([kind, n]) => (
              <span className="pill" key={kind}>{n} {kindLabel(kind, n)}</span>
            ))}
          </div>
          {others.length > 0 && (
            <p className="hint" style={{ marginTop: 10 }}>
              Outreach emails are reviewed on the Outreach page; press items on the Press page.
            </p>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="ghost" disabled={busy} onClick={tellReviewers}>Email my reviewers a summary</button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Posts per week</h2>
        <p className="hint">The goal is at least three posts a week, spread across your platforms.</p>
        {coverage.length === 0 ? (
          <div className="empty">No posts drafted yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Week starting</th><th>Posts</th><th>Platforms</th><th>Goal</th></tr>
            </thead>
            <tbody>
              {coverage.map((week) => (
                <tr key={week.week_of}>
                  <td>{new Date(week.week_of).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td>{week.total}</td>
                  <td>{week.platform_list.map(platformName).join(', ')}</td>
                  <td>
                    <span className={`pill ${week.meetsMinimum ? 'approved' : 'escalated'}`}>
                      {week.meetsMinimum ? 'Met' : `Below goal (${week.minimum} needed)`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {grounding && (
        <details className="card disclosure">
          <summary><h2>How posts are written</h2></summary>
          <p className="hint">
            Before writing, the app looks up what your book says about each theme, and learns your voice from your
            past posts. Each finished post is checked against both — that’s what the “matches your book” and “sounds
            like you” checks mean.
          </p>
          <table>
            <thead><tr><th>Theme</th><th>What the book says</th><th>Passages found</th></tr></thead>
            <tbody>
              {grounding.themes.map((t) => (
                <tr key={t.theme}>
                  <td><span className="pill">{t.theme}</span></td>
                  <td>{t.keyMessage || <span className="muted">No summary yet — the passage itself is used.</span>}</td>
                  <td>
                    {t.passages.length > 0
                      ? `${t.passages.length} passage${t.passages.length === 1 ? '' : 's'}`
                      : <span className="pill unnamed">not found in the book</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Your voice, learned from {grounding.voice.priorPosts} past posts</h3>
          {grounding.voice.enforceable ? (
            <ul className="facts">
              <li>Sentences average <strong>{grounding.voice.meanSentenceWords}</strong> words</li>
              <li>Exclamation marks: <strong>{grounding.voice.exclamationsPer100}</strong> per 100 words</li>
              <li>Salesy words (“amazing”, “must-read”): <strong>{grounding.voice.hypePer100}</strong> per 100 words</li>
              <li>Words in capitals: <strong>{grounding.voice.shoutedPer100}</strong> per 100 words</li>
              <li><strong>{grounding.voice.vocabulary}</strong> different words used</li>
            </ul>
          ) : (
            <div className="empty">
              Only {grounding.voice.priorPosts} past post{grounding.voice.priorPosts === 1 ? '' : 's'} so far —{' '}
              {grounding.voice.minPostsForTrait} are needed before posts are checked against your voice. Add more on the
              My books page.
            </div>
          )}

          {grounding.voice.statedClaims?.length > 0 && (
            <>
              <p className="hint">How you described your voice, compared with how your posts actually read:</p>
              <div className="meta">
                {grounding.voice.statedClaims.map((c) => (
                  <span key={c.claim} className={`pill ${c.supported === true ? 'approved' : c.supported === false ? 'escalated' : 'neutral'}`}>
                    {c.claim}
                    {c.supported === true ? ' · yes, it shows' : c.supported === false ? ' · not in your posts' : ' · can’t tell yet'}
                  </span>
                ))}
              </div>
            </>
          )}
        </details>
      )}

      <details className="card disclosure">
        <summary><h2>Already decided ({decided.length})</h2></summary>
        <p className="hint">Rate past posts to teach the app what you like — it uses your ratings in the next drafts.</p>
        {decided.length === 0 ? (
          <div className="empty">Nothing decided yet.</div>
        ) : (
          <table>
            <thead><tr><th>Post</th><th>Platform</th><th>Decision</th><th>Text, and your rating</th></tr></thead>
            <tbody>
              {decided.map((draft) => (
                <tr key={draft.id}>
                  <td className="mono">#{draft.id}</td>
                  <td>{platformName(draft.platform)}</td>
                  <td><span className={`pill ${draft.status === 'changes_requested' ? 'pending_approval' : draft.status}`}>{STATUS_LABEL[draft.status] ?? draft.status}</span></td>
                  <td>
                    {draft.content.slice(0, 110)}{draft.content.length > 110 ? '…' : ''}
                    <RateDraft draft={draft} onDone={refresh} />
                    {draft.status === 'changes_requested' && (
                      <div className="hint">
                        {draft.changes_requested_by} asked: “{draft.change_request}”
                        {(() => {
                          const rev = drafts.find((x) => Number(x.revision_of) === Number(draft.id));
                          return rev ? ` — rewritten as post #${rev.id}` : '';
                        })()}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </>
  );
}

const STATUS_LABEL = {
  pending_approval: 'Needs review',
  escalated: 'Flagged',
  approved: 'Approved',
  rejected: 'Rejected',
  scheduled: 'Scheduled',
  published: 'Posted',
  changes_requested: 'Changes asked for',
};

/** One post to decide on: the text first, plain-language checks, details on request. */
function DraftCard({ draft, original, note, onNote, busy, canDecide, onDecide }) {
  const themeOk = Number(draft.theme_alignment) >= (draft.floors?.themeAlignment ?? 0.5);
  const voiceOk = Number(draft.voice_score) >= (draft.floors?.voice ?? 0.5);
  const flagged = draft.status === 'escalated';
  return (
    <article className={`draft${flagged ? ' draft-flagged' : ''}`}>
      <div className="draft-head">
        <span className={`pill ${draft.status}`}>{flagged ? 'Flagged — check carefully' : 'Needs review'}</span>
        <strong>{platformName(draft.platform)}</strong>
        {draft.format === 'meme' && <span className="pill neutral">image post</span>}
        <span className="draft-id">Post #{draft.id}</span>
      </div>

      {draft.revision_of && (
        <div className="hint revision-note">
          Rewrite of post #{draft.revision_of}
          {original?.change_request ? <> — {original.changes_requested_by} asked: “{original.change_request}”</> : null}
        </div>
      )}

      {draft.format === 'meme' ? (
        // Image and caption previewed as one post (STORY-066).
        <div className="meme">
          <img src={draft.media?.imageRef} alt={draft.media?.altText ?? ''} />
          <div>
            <pre>{draft.content}</pre>
            <p className="hint">
              {draft.media?.altText
                ? <>Image description: “{draft.media.altText}”</>
                : <span className="pill unnamed">No image description — people using screen readers won’t know what it shows</span>}
            </p>
          </div>
        </div>
      ) : (
        <pre>{draft.content}</pre>
      )}

      <div className="checks">
        <span className={`check ${themeOk ? 'ok' : 'bad'}`}>
          {themeOk ? '✓' : '!'} Matches your book <strong>{pct(draft.theme_alignment)}</strong>
        </span>
        <span className={`check ${voiceOk ? 'ok' : 'bad'}`}>
          {voiceOk ? '✓' : '!'} Sounds like you <strong>{pct(draft.voice_score)}</strong>
        </span>
        {draft.format === 'meme' && (
          <span className={`check ${draft.image_rights === 'cleared' ? 'ok' : 'bad'}`} title="An image without cleared rights can’t be posted, even if you approve it">
            {draft.image_rights === 'cleared' ? '✓ Image cleared to use' : `! Image rights: ${draft.image_rights}`}
          </span>
        )}
        {draft.safety_findings?.map((f) => (
          <span className="check bad" key={f}>! {f.replace(/_/g, ' ')}</span>
        ))}
      </div>

      <details className="draft-details">
        <summary>Details — how this post was checked</summary>
        <BookComparison review={draft.bookReview} />
        {draft.themes?.length > 0 && (
          <div className="meta">
            {draft.themes.map((t) => (
              <span
                key={t.theme}
                className={`pill ${t.score >= 0.5 ? 'approved' : 'unnamed'}`}
                title={t.known ? `uses: ${t.carried_terms.join(', ') || 'none of the book’s words'}` : 'not one of the book’s themes'}
              >
                {t.theme} {pct(t.score)}{t.known ? '' : ' · not a book theme'}
              </span>
            ))}
          </div>
        )}
        {draft.voice_violations?.length > 0 && (
          <p className="hint">Doesn’t sound like you because of: {draft.voice_violations.map((v) => v.replace(/_/g, ' ')).join(', ')}</p>
        )}
        <p className="hint mono">Overall confidence {pct(draft.confidence)} · {draft.rationale}</p>
      </details>

      <label htmlFor={`note-${draft.id}`}>Note <span className="label-hint">— optional, but needed to ask for changes</span></label>
      <input
        id={`note-${draft.id}`}
        placeholder="Notes — e.g. “Shorter, and mention the launch date”"
        value={note}
        onChange={(e) => onNote(e.target.value)}
      />

      <div className="row">
        <button onClick={() => onDecide('approve')} disabled={busy || !canDecide}>Approve</button>
        <button
          className="ghost"
          onClick={() => onDecide('changes')}
          disabled={busy || note.trim().length < 10}
          title="Write what should change in the note first (at least a few words)"
        >
          Request changes
        </button>
        <button className="danger" onClick={() => onDecide('reject')} disabled={busy || !canDecide}>Reject</button>
      </div>
    </article>
  );
}

/**
 * The post compared with the book (STORY-047): each claimed theme, whether it
 * is argued in the book's own words, and the book's style.
 */
function BookComparison({ review }) {
  if (!review) return <p className="hint">This post was written before the book comparison existed.</p>;
  const c = review.comparison;
  const VERDICT = { aligned: ['approved', 'matches the book'], check: ['pending_approval', 'check against the book'], misaligned: ['escalated', 'does not match the book'] };
  const [pill, label] = VERDICT[review.verdict];
  return (
    <div className="book-comparison">
      <div className="meta">
        <span className={`pill ${pill}`}>{label}</span>
        {c.themes.map((t) => (
          <span key={t.theme} className={`pill ${t.aligned && t.inBookLanguage ? 'approved' : t.aligned ? 'pending_approval' : 'escalated'}`}>
            {t.theme}{t.bookWords.length ? ` · uses the book’s words: ${t.bookWords.join(', ')}` : t.learned ? ' · not in the book’s words' : ''}
          </span>
        ))}
        {c.style.map((st) => (
          <span key={st.element} className={`pill ${st.fits ? 'neutral' : 'escalated'}`} title={`this post ${st.draft} · the book ${st.book}`}>
            {st.label.toLowerCase()} {st.fits ? '✓' : `${st.draft} (book: ${st.book})`}
          </span>
        ))}
      </div>
      {c.notes.length > 0 && <p className="hint">{c.notes.join(' · ')}</p>}
    </div>
  );
}

/** A rating and a comment on a decided post (STORY-048): it shapes the next drafts. */
function RateDraft({ draft, onDone }) {
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(null);
  async function rate(rating) {
    try {
      await api.rateDraft(draft.id, { rating, comment: comment.trim() || null });
      setSent(`Thanks — rated ${rating} out of 5. The next drafts take it into account.`);
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
          {given.rating ? `${'★'.repeat(given.rating)}${'☆'.repeat(5 - given.rating)}` : 'comment'}
        </span>{' '}
        {given.given_by}{given.comment ? `: “${given.comment}”` : ''}
      </div>
    );
  }
  return (
    <div className="rate-row">
      <input placeholder="What worked, or didn’t? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <span className="rate-label">Rate:</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className="ghost star" onClick={() => rate(n)} title={`${n} out of 5`} aria-label={`Rate ${n} out of 5`}>
          {n}★
        </button>
      ))}
    </div>
  );
}
