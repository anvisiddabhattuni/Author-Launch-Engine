import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime, statusLabel } from '../labels.js';

const pct = (x) => `${Math.round(Number(x ?? 0) * 100)}%`;
const MILESTONE_LABELS = { launch: 'Launch', award: 'Award', anniversary: 'Anniversary' };
const REASON_LABELS = { confidence: 'not confident', theme_alignment: 'doesn’t match the book', voice: 'doesn’t sound like you', brand_safety: 'brand safety', visual_identity: 'doesn’t fit the look' };

const DECIDABLE = ['pending_approval', 'escalated'];

const MATERIAL_LABELS = {
  press_release: 'Press release',
  author_bio: 'Author bio',
  fact_sheet: 'Fact sheet',
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

function ordinal(n) {
  const suffix =
    n % 10 === 1 && n % 100 !== 11 ? 'st'
    : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd'
    : 'th';
  return `${n}${suffix}`;
}

const countdown = (days) =>
  days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;

/**
 * STORY-003: PR materials drafted for a milestone, each aligned with the book's
 * themes and held for human review before the kit can be distributed.
 * STORY-004: an approaching milestone gets its kit drafted without being asked.
 * STORY-005: recording that an award was won is what drafts the win release.
 * STORY-006: a draft is written from what the book argues about each theme, and
 * checked against the same evidence — named and argued are shown separately.
 * STORY-007: the review itself already existed; what was missing was telling a
 * human that something is sitting on them.
 * STORY-008: an independent check re-derives every escalation decision, so the
 * agent that wrote the material is no longer the only judge of it.
 */
export function PressPage({ author, book }) {
  const [milestones, setMilestones] = useState([]);
  const [approaching, setApproaching] = useState(null);
  const [awaiting, setAwaiting] = useState(null);
  const [kits, setKits] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [grounding, setGrounding] = useState(null);
  const [pending, setPending] = useState(null);
  const [reviewers, setReviewers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [newReviewer, setNewReviewer] = useState({ name: '', email: '', role: 'publisher', phone: '' });
  const [texts, setTexts] = useState(null);
  const [escalations, setEscalations] = useState(null);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [open, setOpen] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [m, a, w, k, c, g, p, r, n, esc] = await Promise.all([
      api.milestones(author.id),
      api.approachingMilestones(author.id),
      api.awardsAwaitingOutcome(author.id),
      api.pressKits(author.id),
      api.pressContacts(),
      book ? api.bookThemes(book.id) : Promise.resolve(null),
      api.pendingReview(author.id),
      api.reviewers(author.id),
      api.notifications(author.id),
      api.escalations(author.id),
    ]);
    setMilestones(m);
    setApproaching(a);
    setAwaiting(w);
    setKits(k);
    setContacts(c);
    setGrounding(g);
    setPending(p);
    setReviewers(r);
    setNotifications(n);
    // STORY-037: separate, so a texting problem never blanks the rest of the page.
    api.smsLog(author.id).then(setTexts).catch(() => setTexts(null));
    setEscalations(esc);
  }, [author.id, book]);

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

  const themes = book?.themes ?? [];
  const onBeat = contacts.filter((c) =>
    (c.beats ?? []).some((beat) => themes.map((t) => t.toLowerCase()).includes(beat.toLowerCase())),
  );

  const activeKits = kits.filter((k) => k.status === 'drafting');
  const pastKits = kits.filter((k) => k.status !== 'drafting');
  const activeReviewers = reviewers.filter((r) => r.active).length;

  const kitCard = (kit) => (
    <div className="draft" key={kit.id}>
      <div className="draft-head">
        <span className={`pill ${kit.status}`}>{statusLabel(kit.status)}</span>
        <strong>{kit.milestone_title}</strong>
        {/* An on-demand kit has no milestone type to show (STORY-018). */}
        <span className="pill neutral">{MILESTONE_LABELS[kit.milestone_type] ?? 'Anytime'}</span>
        {kit.outcome && (
          <span className={`pill ${kit.outcome === 'won' ? 'won' : ''}`}>{kit.outcome === 'won' ? 'Won' : 'Did not win'}</span>
        )}
        {kit.event_date && <span className="hint">{formatDate(kit.event_date)}</span>}
        <span className="draft-id">{kit.approved_count} of {kit.material_count} approved</span>
      </div>
      {kit.status === 'superseded' && kit.superseded_reason && <p className="hint">{kit.superseded_reason}</p>}

      {kit.materials.map((material) => {
        const themeOk = Number(material.theme_alignment) >= 0.5;
        const voiceOk = material.voice_score === null || Number(material.voice_score) >= 0.5;
        return (
          <div className={`draft${material.status === 'escalated' ? ' draft-flagged' : ''}`} key={material.id} style={{ marginTop: 12 }}>
            <div className="draft-head">
              <span className={`pill ${material.status}`}>
                {material.status === 'escalated' ? 'Flagged — check carefully' : statusLabel(material.status)}
              </span>
              <strong>{MATERIAL_LABELS[material.type] ?? material.type}</strong>
            </div>
            <div className="email-subject">{material.headline}</div>

            <div className="checks">
              <span className={`check ${themeOk ? 'ok' : 'bad'}`}>{themeOk ? '✓' : '!'} Matches your book <strong>{pct(material.theme_alignment)}</strong></span>
              {/* Null on materials drafted before STORY-018: never measured, so not shown as a zero. */}
              {material.voice_score !== null && (
                <span className={`check ${voiceOk ? 'ok' : 'bad'}`}>{voiceOk ? '✓' : '!'} Sounds like you <strong>{pct(material.voice_score)}</strong></span>
              )}
            </div>

            <div style={{ marginTop: 8 }}>
              <button className="link" onClick={() => setOpen({ ...open, [material.id]: !open[material.id] })}>
                {open[material.id] ? 'Hide the full text' : 'Read the full text'}
              </button>
            </div>
            {open[material.id] && <pre>{material.body}</pre>}

            <details className="draft-details">
              <summary>Details — how this was checked</summary>
              {material.themes?.length > 0 && (
                <div className="meta" style={{ marginTop: 8 }}>
                  {material.themes.map((t) => (
                    <span
                      key={t.theme}
                      className={`pill ${!t.named ? 'unnamed' : t.score >= 0.7 ? 'argued' : 'named-only'}`}
                      title={t.key_message || 'No key message recorded for this theme.'}
                    >
                      {t.theme} · {!t.named ? 'missing' : t.score >= 0.7 ? 'explained well' : 'mentioned only'}
                    </span>
                  ))}
                </div>
              )}
              {material.voice_violations?.length > 0 && (
                <p className="hint">Doesn’t sound like you because of: {material.voice_violations.join(', ')}</p>
              )}
              <p className="hint mono">Overall confidence {pct(material.confidence)} · {material.rationale}</p>
            </details>

            {kit.status !== 'superseded' && DECIDABLE.includes(material.status) && (
              <>
                <label htmlFor={`pr-note-${material.id}`}>Note <span className="label-hint">— optional</span></label>
                <input
                  id={`pr-note-${material.id}`}
                  placeholder="Notes — anything worth recording about this decision"
                  value={notes[material.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [material.id]: e.target.value })}
                />
                <div className="row">
                  <button
                    disabled={busy || !reviewer.trim()}
                    onClick={() => run(() => api.approvePrMaterial(material.id, { reviewer, notes: notes[material.id] ?? '' }), `${MATERIAL_LABELS[material.type]} approved.`)}
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={busy || !reviewer.trim()}
                    onClick={() => run(() => api.rejectPrMaterial(material.id, { reviewer, notes: notes[material.id] ?? '' }), `${MATERIAL_LABELS[material.type]} rejected. This kit won’t be sent.`)}
                  >
                    Reject
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {kit.status === 'drafting' && (
        <div className="row" style={{ marginTop: 14 }}>
          <button
            disabled={busy || !kit.readyToDistribute}
            onClick={() => run(() => api.distributeKit(kit.id), `Sent to the journalists who cover your book’s topics.`)}
          >
            Send to journalists
          </button>
          {!kit.readyToDistribute && <span className="hint">Approve every piece above first — a kit is sent as one package.</span>}
        </div>
      )}

      {kit.distributions.length > 0 && (
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr><th>Outlet</th><th>Sent to</th><th>Status</th></tr>
          </thead>
          <tbody>
            {kit.distributions.map((d) => (
              <tr key={d.id}>
                <td>{d.outlet}</td>
                <td>{d.recipient}</td>
                <td><span className={`pill ${d.status}`}>{statusLabel(d.status)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {pending?.unreachable && (
        <div className="banner error">
          Press materials are waiting and there’s nobody to tell. Add a reviewer at the bottom of this page.
        </div>
      )}

      <div className="card">
        <h2>Press materials waiting for you ({activeKits.reduce((n, k) => n + k.materials.filter((m) => DECIDABLE.includes(m.status)).length, 0)})</h2>
        <p className="hint">
          A press kit is a press release, an author bio and a fact sheet. Approve every piece, then send the kit to
          journalists. In this demo, sending is simulated — no real email leaves.
        </p>

        <div className="row form-row">
          <div>
            <label htmlFor="pr-reviewer">Your name</label>
            <input id="pr-reviewer" className="narrow" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          </div>
          {/* STORY-018: press does not have to wait for something to happen to the book. */}
          <button
            className="ghost"
            disabled={busy || !book}
            onClick={() => run(() => api.generatePrMaterials(author.id, book.id), 'A new press kit was written from your book. Review each piece below.')}
          >
            Write a press kit for “{book?.title ?? 'this book'}”
          </button>
        </div>

        {activeKits.length === 0 ? (
          <div className="empty">Nothing waiting. Write a press kit above, or from a date in “Coming up”.</div>
        ) : (
          activeKits.map(kitCard)
        )}
      </div>

      {approaching && (
        <div className="card">
          <h2>Coming up in the next {approaching.leadTimeDays} days ({approaching.approaching.length})</h2>
          <p className="hint">Journalists need notice, so the app writes a press kit ahead of each launch, award or anniversary. You still approve every piece.</p>
          {approaching.approaching.length === 0 ? (
            <div className="empty">Nothing in the next {approaching.leadTimeDays} days.</div>
          ) : (
            <>
              <table>
                <thead>
                  <tr><th>What</th><th>When</th><th>Press kit</th></tr>
                </thead>
                <tbody>
                  {approaching.approaching.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.title}
                        <div className="hint">{MILESTONE_LABELS[m.type] ?? m.type}{m.anniversaryYears ? ` · ${ordinal(m.anniversaryYears)} anniversary` : ''}</div>
                      </td>
                      <td>{countdown(m.days_until)}</td>
                      <td>
                        {m.kit_id ? (
                          <span className={`pill ${m.kit_status}`}>{statusLabel(m.kit_status)}</span>
                        ) : (
                          <span className="pill escalated">Not written yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {approaching.needingKit > 0 && (
                <div className="row" style={{ marginTop: 14 }}>
                  <button disabled={busy} onClick={() => run(() => api.draftApproaching(author.id), 'Press kits written for everything coming up. Review them above.')}>
                    Write the missing press kits
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {awaiting && awaiting.count > 0 && (
        <div className="card">
          <h2>Did you win? ({awaiting.count})</h2>
          <p className="hint">
            These award ceremonies have happened. Tell the app the result — if you won, it writes a press release
            for you to review. The app never guesses.
          </p>
          <table>
            <thead>
              <tr><th>Award</th><th>Ceremony</th><th /></tr>
            </thead>
            <tbody>
              {awaiting.awaiting.map((m) => (
                <tr key={m.id}>
                  <td>{m.award_name ?? m.title}<div className="hint">shortlisted</div></td>
                  <td>{Number(m.days_since) === 0 ? 'today' : `${m.days_since} day${Number(m.days_since) === 1 ? '' : 's'} ago`}</td>
                  <td className="cell-action">
                    <div className="row">
                      <button
                        disabled={busy}
                        onClick={() => run(() => api.recordAwardOutcome(m.id, { outcome: 'won', actor: reviewer }), `Congratulations! A press release about ${m.award_name ?? m.title} is waiting for your review above.`)}
                      >
                        I won
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => run(() => api.recordAwardOutcome(m.id, { outcome: 'not_won', actor: reviewer }), 'Noted. Nothing will be written about this award.')}
                      >
                        I didn’t win
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Who reviews press materials ({activeReviewers})</h2>
        <p className="hint">
          These people get an email (and a text, if they have a mobile number) when press materials are waiting.
          This only decides who is <em>told</em> — not who is allowed to approve.
        </p>

        {reviewers.length === 0 ? (
          <div className="empty">No reviewers yet. Add someone below so press materials don’t sit unnoticed.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Mobile</th><th>Emails sent</th><th /></tr>
            </thead>
            <tbody>
              {reviewers.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}<div className="hint">{r.role}</div></td>
                  <td>{r.email}</td>
                  <td className="num">{r.phone ?? '—'}</td>
                  <td className="num">{notifications.filter((n) => n.reviewer_id === r.id && n.status === 'sent').length}</td>
                  <td className="cell-action">
                    <button
                      className={r.active ? 'ghost' : ''}
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.setReviewerActive(r.id, { active: !r.active, actor: reviewer }),
                          r.active ? `${r.name} won’t be told any more.` : `${r.name} will be told again.`,
                        )
                      }
                    >
                      {r.active ? 'Stop telling them' : 'Start telling them again'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {pending && pending.kits.length > 0 && (
          <div className="row" style={{ marginTop: 14 }}>
            <button
              disabled={busy || activeReviewers === 0}
              onClick={() => run(() => api.notifyPending(author.id), 'Reviewers have been told about everything waiting.')}
            >
              Remind reviewers now
            </button>
            <span className="hint">
              {pending.materialsAwaitingReview} piece{pending.materialsAwaitingReview === 1 ? '' : 's'} waiting. Nobody is emailed twice about the same kit.
            </span>
          </div>
        )}

        <h3>Add a reviewer</h3>
        <div className="row form-row">
          <div><label htmlFor="rv-name">Name</label><input id="rv-name" value={newReviewer.name} onChange={(e) => setNewReviewer({ ...newReviewer, name: e.target.value })} /></div>
          <div><label htmlFor="rv-email">Email</label><input id="rv-email" type="email" placeholder="name@example.com" value={newReviewer.email} onChange={(e) => setNewReviewer({ ...newReviewer, email: e.target.value })} /></div>
          <div><label htmlFor="rv-role">Their role</label><input id="rv-role" placeholder="e.g. publisher" value={newReviewer.role} onChange={(e) => setNewReviewer({ ...newReviewer, role: e.target.value })} /></div>
          {/* STORY-037: optional; texts go to it when approvals are waiting. */}
          <div><label htmlFor="rv-phone">Mobile <span className="label-hint">— optional</span></label><input id="rv-phone" placeholder="+15551234567" value={newReviewer.phone ?? ''} onChange={(e) => setNewReviewer({ ...newReviewer, phone: e.target.value })} /></div>
          <button
            disabled={busy || !newReviewer.name.trim() || !newReviewer.email.trim()}
            onClick={() =>
              run(async () => {
                await api.addReviewer(author.id, { ...newReviewer, actor: reviewer });
                setNewReviewer({ name: '', email: '', role: 'publisher', phone: '' });
              }, `${newReviewer.name} will be told when press materials are waiting.`)
            }
          >
            Add reviewer
          </button>
        </div>
      </div>

      <h2 className="section-label">More</h2>

      <details className="card disclosure">
        <summary><h2>All dates ({milestones.length})</h2></summary>
        <p className="hint">Launches, awards and anniversaries. Each kind of date gets a different angle in its press kit.</p>
        {milestones.length === 0 ? (
          <div className="empty">No dates yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>What</th><th>Date</th><th>Press kit</th><th /></tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.title}
                    <div className="hint">
                      {MILESTONE_LABELS[m.type] ?? m.type}
                      {m.anniversaryYears ? ` · ${ordinal(m.anniversaryYears)} anniversary` : ''}
                      {m.award_name ? ` · ${m.award_name}` : ''}
                      {m.awardOutcome ? ` · ${m.awardOutcome === 'won' ? 'won' : m.awardOutcome === 'not_won' ? 'did not win' : m.awardOutcome.replace('_', ' ')}` : ''}
                    </div>
                  </td>
                  <td className="num">{formatDate(m.event_date)}</td>
                  <td>{m.kit_id ? <span className={`pill ${m.kit_status}`}>{statusLabel(m.kit_status)}</span> : '—'}</td>
                  <td className="cell-action">
                    {!m.kit_id && m.awardOutcome !== 'not_won' && (
                      <button
                        className="ghost small"
                        disabled={busy}
                        onClick={() => run(() => api.draftPressKit(m.id), `A press kit for “${m.title}” is waiting for your review above.`)}
                      >
                        Write press kit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      {pastKits.length > 0 && (
        <details className="card disclosure">
          <summary><h2>Sent and older press kits ({pastKits.length})</h2></summary>
          {pastKits.map(kitCard)}
        </details>
      )}

      {escalations && escalations.escalations.length > 0 && (
        <details className="card disclosure">
          <summary><h2>Flagged for a second look ({escalations.open} still open)</h2></summary>
          <p className="hint">
            A separate safety check re-scores every piece, so the part of the app that wrote it isn’t the only judge.
            It can flag a piece but never clear one. A piece is flagged if it matches the book less than{' '}
            {pct(escalations.thresholds.themeAlignment)} or the app is less than {pct(escalations.thresholds.confidence)} confident.
          </p>
          <table>
            <thead>
              <tr><th>Piece</th><th>Why flagged</th><th>Flagged by</th><th>Status</th></tr>
            </thead>
            <tbody>
              {escalations.escalations.map((e) => (
                <tr key={e.id}>
                  <td>{MATERIAL_LABELS[e.type] ?? e.type}<div className="hint">{e.milestone_title}</div></td>
                  <td>
                    {e.reasons.length > 0
                      ? e.reasons.map((r) => <span key={r} className="pill escalated" style={{ marginRight: 4 }}>{REASON_LABELS[r] ?? r.replace(/_/g, ' ')}</span>)
                      : <span className="hint">no longer below the bar</span>}
                    <div className="hint">matches the book {pct(e.theme_alignment)} · confidence {pct(e.confidence)}</div>
                  </td>
                  <td>
                    {e.detected_by === 'monitor' ? 'Safety check' : 'The writer'}
                    {!e.agreed && <div className="hint">the two disagreed</div>}
                  </td>
                  <td><span className={`pill ${e.open ? 'pending_approval' : 'approved'}`}>{e.open ? 'Needs review' : statusLabel(e.material_status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await api.scanEscalations(author.id);
                  setStatus({ kind: 'ok', message: `Checked ${result.examined} pieces; ${result.raised.length} newly flagged.` });
                }, 'Done.')
              }
            >
              Check again now
            </button>
            <span className="hint">This also runs by itself on a schedule.</span>
          </div>
        </details>
      )}

      {grounding && (
        <details className="card disclosure">
          <summary><h2>What press materials are based on ({grounding.themes.length} themes)</h2></summary>
          <p className="hint">
            Before writing, the app looks up what your book says about each theme. A theme the book never explains is
            one a press kit can’t talk about convincingly — worth fixing on the My books page.
          </p>
          <table>
            <thead>
              <tr><th>Theme</th><th>Key message</th><th>Passages from the book</th></tr>
            </thead>
            <tbody>
              {grounding.themes.map((t) => (
                <tr key={t.theme}>
                  <td><span className="pill">{t.theme}</span></td>
                  <td>{t.key_message || <span className="hint">none yet — a passage from the book is used instead</span>}</td>
                  <td>{t.passage_count > 0 ? `${t.passage_count} passage${t.passage_count === 1 ? '' : 's'}` : <span className="pill unnamed">the book never explains this</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <details className="card disclosure">
        <summary><h2>Journalists ({onBeat.length} of {contacts.length} cover your topics)</h2></summary>
        <p className="hint">A press kit only goes to journalists who write about one of your book’s themes.</p>
        <table>
          <thead>
            <tr><th>Outlet</th><th>Journalist</th><th>Writes about</th><th>Matches your book</th></tr>
          </thead>
          <tbody>
            {contacts.map((c) => {
              const matched = (c.beats ?? []).filter((beat) => themes.map((t) => t.toLowerCase()).includes(beat.toLowerCase()));
              return (
                <tr key={c.id}>
                  <td>{c.outlet}</td>
                  <td>{c.name}</td>
                  <td>{(c.beats ?? []).join(', ')}</td>
                  <td>{matched.length > 0 ? <span className="pill approved">{matched.join(', ')}</span> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

      {(notifications.length > 0 || texts) && (
        <details className="card disclosure">
          <summary><h2>Messages sent to reviewers ({notifications.length + (texts?.messages.length ?? 0)})</h2></summary>
          {notifications.length > 0 && (
            <>
              <h3>Emails</h3>
              <table>
                <thead>
                  <tr><th>To</th><th>About</th><th>Pieces waiting</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {notifications.map((n) => (
                    <tr key={n.id}>
                      <td>{n.reviewer_name}<div className="hint">{n.reviewer_role}</div></td>
                      <td>{n.milestone_title ?? '—'}</td>
                      <td className="num">{n.pending_count}</td>
                      <td><span className={`pill ${n.status}`}>{statusLabel(n.status)}</span>{n.error && <div className="hint">{n.error}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {texts && (
            <>
              <h3>Texts</h3>
              {!texts.configured && <div className="banner">Text messages aren’t switched on yet. An administrator needs to connect the texting service (Twilio).</div>}
              {texts.messages.length > 0 && (
                <table>
                  <thead><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
                  <tbody>
                    {texts.messages.map((m) => (
                      <tr key={m.id}>
                        <td className="num">{localTime(m.created_at)}</td>
                        <td className="num">{m.to_number}</td>
                        <td>{m.body}</td>
                        <td>
                          <span className={`pill ${m.status === 'sent' ? 'approved' : m.status === 'failed' ? 'escalated' : 'pending_approval'}`}>{m.status === 'failed' ? 'Failed' : statusLabel(m.status)}</span>
                          {m.next_attempt_at && <div className="hint">trying again at {localTime(m.next_attempt_at)}</div>}
                          {m.last_error && <div className="hint">{m.last_error}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </details>
      )}
    </>
  );
}
