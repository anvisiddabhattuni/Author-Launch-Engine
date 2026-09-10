import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

const DECIDABLE = ['pending_approval', 'escalated'];

const MATERIAL_LABELS = {
  press_release: 'Press release',
  author_bio: 'Author bio',
  fact_sheet: 'Fact sheet',
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', {
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
  const [newReviewer, setNewReviewer] = useState({ name: '', email: '', role: 'publisher' });
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

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {escalations && escalations.escalations.length > 0 && (
        <div className="card">
          <h2>
            Escalated ({escalations.open} open
            {escalations.raisedByMonitor > 0 && `, ${escalations.raisedByMonitor} raised by monitoring`})
          </h2>
          <p className="hint">
            The Trust and Monitoring Agent re-derives every escalation decision from the stored
            scores, so the agent that wrote a material is no longer the only judge of it. It can
            raise a concern and never clear one. Current floors: confidence{' '}
            {Number(escalations.thresholds.confidence).toFixed(2)}, theme alignment{' '}
            {Number(escalations.thresholds.themeAlignment).toFixed(2)}.
          </p>

          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Raised for</th>
                <th>Scores when judged</th>
                <th>Caught by</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {escalations.escalations.map((e) => (
                <tr key={e.id}>
                  <td>
                    {MATERIAL_LABELS[e.type] ?? e.type}
                    <span className="mono"> · {e.milestone_title}</span>
                  </td>
                  <td>
                    {e.reasons.length > 0 ? (
                      e.reasons.map((r) => (
                        <span key={r} className="pill escalated" style={{ marginRight: 4 }}>
                          {r.replace('_', ' ')}
                        </span>
                      ))
                    ) : (
                      <span className="mono">policy has since relaxed</span>
                    )}
                  </td>
                  <td className="mono">
                    conf {Number(e.confidence).toFixed(2)} · align{' '}
                    {Number(e.theme_alignment).toFixed(2)}
                  </td>
                  <td>
                    {e.detected_by === 'monitor' ? (
                      <span className="pill escalated">monitoring</span>
                    ) : (
                      <span className="pill">the drafter</span>
                    )}
                    {!e.agreed && <span className="mono"> · disagreed</span>}
                  </td>
                  <td>
                    <span className={`pill ${e.open ? 'pending_approval' : 'approved'}`}>
                      {e.open ? 'awaiting a human' : e.material_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await api.scanEscalations(author.id);
                  setStatus({
                    kind: 'ok',
                    message: `Examined ${result.examined}; raised ${result.raised.length}.`,
                  });
                }, 'Scan complete.')
              }
            >
              Re-check now
            </button>
            <span className="hint">
              The worker runs this on a schedule anyway — a floor raised today catches drafts written
              yesterday that are still unapproved. Decide each material below as usual.
            </span>
          </div>
        </div>
      )}

      {pending && pending.kits.length > 0 && (
        <div className="card">
          <h2>
            Awaiting your review ({pending.materialsAwaitingReview} material
            {pending.materialsAwaitingReview === 1 ? '' : 's'} across {pending.kits.length} kit
            {pending.kits.length === 1 ? '' : 's'})
          </h2>
          <p className="hint">
            Nothing in a kit can be distributed until every material in it is approved. Reviewing is
            what releases it — taking no action leaves it unsent, which is safe but not free.
          </p>

          {pending.unreachable && (
            <div className="banner error">
              Work is waiting and there is nobody to tell. Add a reviewer below — until then the
              approval gate is holding drafts that no one has been asked to look at.
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Type</th>
                <th>Awaiting</th>
                <th>Escalated</th>
                <th>Reviewers told</th>
              </tr>
            </thead>
            <tbody>
              {pending.kits.map((kit) => (
                <tr key={kit.id}>
                  <td>{kit.milestone_title}</td>
                  <td>
                    {/* Null for a kit that was requested rather than triggered. */}
                    <span className="pill">{kit.milestone_type ?? 'on request'}</span>
                  </td>
                  <td>{kit.pending_count}</td>
                  <td>
                    {kit.escalated_count > 0 ? (
                      <span className="pill escalated">{kit.escalated_count}</span>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </td>
                  <td>
                    {kit.notified > 0 ? (
                      <span className="pill approved">{kit.notified} notified</span>
                    ) : (
                      <span className="pill pending_approval">nobody told yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              disabled={busy || reviewers.filter((r) => r.active).length === 0}
              onClick={() =>
                run(
                  () => api.notifyPending(author.id),
                  'Reviewers notified about everything still awaiting a decision.',
                )
              }
            >
              Notify reviewers of pending drafts
            </button>
            <span className="hint">
              Safe to press twice — a reviewer already told about a kit is not mailed again. This is
              what a scheduled worker would call; nothing runs on a timer yet.
            </span>
          </div>
        </div>
      )}

      {awaiting && awaiting.count > 0 && (
        <div className="card">
          <h2>Awards awaiting a result ({awaiting.count})</h2>
          <p className="hint">
            The ceremony has happened and nobody has written down who won. The system will not guess
            — announcing a shortlisting as a win is a false claim, and announcing a win as a
            shortlisting understates it. Recording a win drafts the release and holds it for review.
            Recording a loss drafts nothing.
          </p>
          <table>
            <thead>
              <tr>
                <th>Award</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {awaiting.awaiting.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.award_name ?? m.title}
                    <span className="mono"> · currently shortlisted</span>
                  </td>
                  <td>
                    {Number(m.days_since) === 0
                      ? 'today'
                      : `${m.days_since} day${Number(m.days_since) === 1 ? '' : 's'} ago`}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              api.recordAwardOutcome(m.id, {
                                outcome: 'won',
                                actor: reviewer,
                              }),
                            `Win recorded for ${m.award_name ?? m.title}. A new kit is held for review.`,
                          )
                        }
                      >
                        Record win
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              api.recordAwardOutcome(m.id, {
                                outcome: 'not_won',
                                actor: reviewer,
                              }),
                            `Loss recorded. No press material will be drafted.`,
                          )
                        }
                      >
                        Did not win
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {approaching && (
        <div className="card">
          <h2>
            Approaching ({approaching.approaching.length} within {approaching.leadTimeDays} days)
          </h2>
          <p className="hint">
            A milestone inside the lead-time window should already have a press kit waiting for
            review — a journalist needs notice, and so do you. Drafting on detection does not skip
            the approval gate: every material still lands held for review.
          </p>

          {approaching.approaching.length === 0 ? (
            <div className="empty">
              Nothing within {approaching.leadTimeDays} days. The next milestone is further out.
            </div>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Milestone</th>
                    <th>Type</th>
                    <th>When</th>
                    <th>Press kit</th>
                  </tr>
                </thead>
                <tbody>
                  {approaching.approaching.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.title}
                        {m.anniversaryYears && (
                          <span className="mono"> · {ordinal(m.anniversaryYears)} anniversary</span>
                        )}
                      </td>
                      <td>
                        <span className="pill">{m.type}</span>
                      </td>
                      <td>{countdown(m.days_until)}</td>
                      <td>
                        {m.kit_id ? (
                          <span className={`pill ${m.kit_status}`}>{m.kit_status}</span>
                        ) : (
                          <span className="pill escalated">needs drafting</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="row" style={{ marginTop: 14 }}>
                <button
                  disabled={busy || approaching.needingKit === 0}
                  onClick={() =>
                    run(
                      () => api.draftApproaching(author.id),
                      'Kits drafted for every approaching milestone. All held for review.',
                    )
                  }
                >
                  Draft kits for approaching milestones
                </button>
                {approaching.needingKit === 0 && (
                  <span className="hint">Every approaching milestone already has a kit.</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {grounding && (
        <div className="card">
          <h2>
            What a draft is grounded in ({grounding.themes.length} themes ·{' '}
            {grounding.passages} passages)
          </h2>
          <p className="hint">
            Before a word is written, the agent retrieves what the book actually argues about each
            theme and hands that to the drafter. A theme with no key message and no retrievable
            passage is one the next press kit cannot argue — worth fixing while it is still cheap.
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
                    {t.key_message || (
                      <span className="mono">no key message — falls back to the passage</span>
                    )}
                  </td>
                  <td>
                    {t.passage_count > 0 ? (
                      <span className="mono">
                        {t.passage_count} passage{t.passage_count === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="pill unnamed">the book never argues this</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Milestones ({milestones.length})</h2>
        <p className="hint">
          A press kit is drafted for a milestone: a launch, an award or an anniversary. The angle
          changes with the type, because each is news for a different reason.
        </p>

        {milestones.length === 0 ? (
          <div className="empty">No milestones scheduled.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Type</th>
                <th>Date</th>
                <th>Press kit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.title}
                    {m.anniversaryYears && (
                      <span className="mono"> · {ordinal(m.anniversaryYears)} anniversary</span>
                    )}
                    {m.award_name && <span className="mono"> · {m.award_name}</span>}
                  </td>
                  <td>
                    <span className="pill">{m.type}</span>
                    {m.awardOutcome && (
                      <span className={`pill ${m.awardOutcome === 'won' ? 'won' : ''}`}>
                        {m.awardOutcome.replace('_', ' ')}
                      </span>
                    )}
                  </td>
                  <td>{formatDate(m.event_date)}</td>
                  <td>
                    {m.kit_id ? (
                      <span className={`pill ${m.kit_status}`}>{m.kit_status}</span>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </td>
                  <td>
                    {!m.kit_id && m.awardOutcome !== 'not_won' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => api.draftPressKit(m.id),
                            `Press kit drafted for "${m.title}". Every piece is held for review.`,
                          )
                        }
                      >
                        Draft press kit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Press kits ({kits.length})</h2>
        <p className="hint">
          A kit goes out as one package, so distribution is refused until <em>every</em> material in
          it is approved. Theme alignment is scored separately from confidence: it is the acceptance
          criterion, so it has to be readable on its own. Each theme is judged twice — whether the
          draft <em>named</em> it, and whether it carried the argument behind it. Naming alone is
          worth less than the escalation floor, so copy that name-checks every theme and argues none
          reaches a human rather than a newsroom. Voice is scored the same way and on the same
          footing: copy that argues every theme in a register the author has never used is
          escalated too.
        </p>

        {/* STORY-018: press does not have to wait for something to happen to
            the book. The materials are written from what the book argues, in
            the voice measured from the author's own posts. */}
        <button
          disabled={busy || !book}
          onClick={() =>
            run(
              () => api.generatePrMaterials(author.id, book.id),
              'PR materials generated from the book\'s themes. Every piece is held for review.',
            )
          }
        >
          Generate PR materials for "{book?.title ?? 'this book'}"
        </button>

        <label htmlFor="pr-reviewer">Reviewer</label>
        <input id="pr-reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {kits.length === 0 ? (
          <div className="empty">
            No kits yet. Draft one from a milestone above, or generate one from the book itself.
          </div>
        ) : (
          kits.map((kit) => (
            <div className="draft" key={kit.id}>
              <div className="meta">
                <span className={`pill ${kit.status}`}>{kit.status}</span>
                {/* An on-demand kit has no milestone type to show (STORY-018). */}
                <span className="pill">{kit.milestone_type ?? 'on request'}</span>
                {kit.outcome && (
                  <span className={`pill ${kit.outcome === 'won' ? 'won' : ''}`}>
                    {kit.outcome.replace('_', ' ')}
                  </span>
                )}
                <strong>{kit.milestone_title}</strong>
                {kit.event_date && <span>{formatDate(kit.event_date)}</span>}
                <span>
                  {kit.approved_count}/{kit.material_count} approved
                </span>
                <span>min alignment {Number(kit.min_theme_alignment).toFixed(2)}</span>
                <span>min voice {Number(kit.min_voice_score ?? 0).toFixed(2)}</span>
                <span className="mono">
                  grounded in {kit.grounded_themes} themes / {kit.grounded_passages} passages
                </span>
              </div>
              {kit.status === 'superseded' && kit.superseded_reason && (
                <p className="hint">{kit.superseded_reason}</p>
              )}

              {kit.materials.map((material) => (
                <div className="draft" key={material.id} style={{ marginTop: 12 }}>
                  <div className="meta">
                    <span className={`pill ${material.status}`}>
                      {material.status.replace('_', ' ')}
                    </span>
                    <strong>{MATERIAL_LABELS[material.type] ?? material.type}</strong>
                    <span>alignment {Number(material.theme_alignment).toFixed(2)}</span>
                    {/* The other half of the criterion, since STORY-018. Null on
                        materials drafted before the story: never measured, so
                        not shown as a zero it did not earn. */}
                    {material.voice_score !== null && (
                      <span>voice {Number(material.voice_score).toFixed(2)}</span>
                    )}
                    <span>confidence {Number(material.confidence).toFixed(3)}</span>
                    <span className="mono">themes: {material.themes_used.join(', ') || 'none'}</span>
                  </div>

                  {material.voice_violations?.length > 0 && (
                    <p className="hint">
                      Reads unlike the author on:{' '}
                      <span className="mono">{material.voice_violations.join(', ')}</span>
                    </p>
                  )}

                  {material.themes?.length > 0 && (
                    <div className="meta" style={{ marginTop: 8 }}>
                      {material.themes.map((t) => (
                        <span
                          key={t.theme}
                          className={`pill ${
                            !t.named ? 'unnamed' : t.score >= 0.7 ? 'argued' : 'named-only'
                          }`}
                          title={t.key_message || 'No key message recorded for this theme.'}
                        >
                          {t.theme} ·{' '}
                          {!t.named
                            ? 'missing'
                            : t.score >= 0.7
                              ? 'argued'
                              : 'named, not argued'}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <strong>{material.headline}</strong>
                  </div>

                  <button
                    className="link"
                    onClick={() => setOpen({ ...open, [material.id]: !open[material.id] })}
                    style={{ marginTop: 8 }}
                  >
                    {open[material.id] ? 'Hide copy' : 'Show copy'}
                  </button>
                  {open[material.id] && <pre>{material.body}</pre>}

                  <div className="meta mono">{material.rationale}</div>

                  {kit.status !== 'superseded' && DECIDABLE.includes(material.status) && (
                    <>
                      <input
                        placeholder="Notes for the record (optional)"
                        value={notes[material.id] ?? ''}
                        onChange={(e) => setNotes({ ...notes, [material.id]: e.target.value })}
                        style={{ marginTop: 12 }}
                      />
                      <div className="row">
                        <button
                          disabled={busy || !reviewer.trim()}
                          onClick={() =>
                            run(
                              () =>
                                api.approvePrMaterial(material.id, {
                                  reviewer,
                                  notes: notes[material.id] ?? '',
                                }),
                              `${MATERIAL_LABELS[material.type]} approved.`,
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
                                api.rejectPrMaterial(material.id, {
                                  reviewer,
                                  notes: notes[material.id] ?? '',
                                }),
                              `${MATERIAL_LABELS[material.type]} rejected. The kit cannot be distributed.`,
                            )
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {kit.status === 'drafting' && (
                <div className="row" style={{ marginTop: 14 }}>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api.distributeKit(kit.id),
                        `Kit ${kit.id} distributed to the matching press contacts.`,
                      )
                    }
                  >
                    Distribute to press
                  </button>
                  {!kit.readyToDistribute && (
                    <span className="hint">
                      Not every material is approved — try it anyway to see the gate refuse.
                    </span>
                  )}
                </div>
              )}

              {kit.distributions.length > 0 && (
                <table style={{ marginTop: 14 }}>
                  <thead>
                    <tr>
                      <th>Outlet</th>
                      <th>Recipient</th>
                      <th>Status</th>
                      <th>Provider id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kit.distributions.map((d) => (
                      <tr key={d.id}>
                        <td>{d.outlet}</td>
                        <td className="mono">{d.recipient}</td>
                        <td>
                          <span className={`pill ${d.status}`}>{d.status}</span>
                        </td>
                        <td className="mono">{d.external_id ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Reviewers ({reviewers.filter((r) => r.active).length} active)</h2>
        <p className="hint">
          Who gets told when press materials are waiting. This is an address book, not a permission
          list — it decides who hears about pending work, not who is allowed to approve it. Sending
          is mocked; no real mail leaves.
        </p>

        {reviewers.length === 0 ? (
          <div className="empty">
            No reviewers yet. Drafts will still be held at the gate — they will just sit there
            unread.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Notified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reviewers.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    <span className="pill">{r.role}</span>
                  </td>
                  <td className="mono">{r.email}</td>
                  <td className="mono">
                    {notifications.filter((n) => n.reviewer_id === r.id && n.status === 'sent').length}
                  </td>
                  <td>
                    <button
                      className={r.active ? 'danger' : ''}
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.setReviewerActive(r.id, { active: !r.active, actor: reviewer }),
                          r.active
                            ? `${r.name} will no longer be notified.`
                            : `${r.name} will be notified again.`,
                        )
                      }
                    >
                      {r.active ? 'Stop notifying' : 'Notify again'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <input
            placeholder="Name"
            value={newReviewer.name}
            onChange={(e) => setNewReviewer({ ...newReviewer, name: e.target.value })}
          />
          <input
            placeholder="email@example.test"
            value={newReviewer.email}
            onChange={(e) => setNewReviewer({ ...newReviewer, email: e.target.value })}
          />
          <input
            placeholder="Role"
            value={newReviewer.role}
            onChange={(e) => setNewReviewer({ ...newReviewer, role: e.target.value })}
          />
          <button
            disabled={busy || !newReviewer.name.trim() || !newReviewer.email.trim()}
            onClick={() =>
              run(async () => {
                await api.addReviewer(author.id, { ...newReviewer, actor: reviewer });
                setNewReviewer({ name: '', email: '', role: 'publisher' });
              }, `${newReviewer.name} will be notified when press materials are waiting.`)
            }
          >
            Add reviewer
          </button>
        </div>

        {notifications.length > 0 && (
          <>
            <h2 style={{ marginTop: 22 }}>Notifications sent ({notifications.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>To</th>
                  <th>About</th>
                  <th>Waiting</th>
                  <th>Status</th>
                  <th>Provider id</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => (
                  <tr key={n.id}>
                    <td>
                      {n.reviewer_name}
                      <span className="mono"> · {n.reviewer_role}</span>
                    </td>
                    <td>{n.milestone_title ?? <span className="mono">—</span>}</td>
                    <td className="mono">{n.pending_count}</td>
                    <td>
                      <span className={`pill ${n.status}`}>{n.status}</span>
                    </td>
                    <td className="mono">{n.external_id ?? n.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2>
          Press list ({onBeat.length} of {contacts.length} on beat)
        </h2>
        <p className="hint">
          A kit only goes to contacts whose beat matches one of the book&apos;s themes. Sending is
          mocked; no real mail leaves.
        </p>
        <table>
          <thead>
            <tr>
              <th>Outlet</th>
              <th>Contact</th>
              <th>Beats</th>
              <th>On beat</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => {
              const matched = (c.beats ?? []).filter((beat) =>
                themes.map((t) => t.toLowerCase()).includes(beat.toLowerCase()),
              );
              return (
                <tr key={c.id}>
                  <td>{c.outlet}</td>
                  <td>{c.name}</td>
                  <td className="mono">{(c.beats ?? []).join(', ')}</td>
                  <td>
                    {matched.length > 0 ? (
                      <span className="pill approved">{matched.join(', ')}</span>
                    ) : (
                      <span className="mono">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
