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
 */
export function PressPage({ author, book }) {
  const [milestones, setMilestones] = useState([]);
  const [approaching, setApproaching] = useState(null);
  const [awaiting, setAwaiting] = useState(null);
  const [kits, setKits] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [open, setOpen] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [m, a, w, k, c] = await Promise.all([
      api.milestones(author.id),
      api.approachingMilestones(author.id),
      api.awardsAwaitingOutcome(author.id),
      api.pressKits(author.id),
      api.pressContacts(),
    ]);
    setMilestones(m);
    setApproaching(a);
    setAwaiting(w);
    setKits(k);
    setContacts(c);
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

  const themes = book?.themes ?? [];
  const onBeat = contacts.filter((c) =>
    (c.beats ?? []).some((beat) => themes.map((t) => t.toLowerCase()).includes(beat.toLowerCase())),
  );

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

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
          criterion, so it has to be readable on its own.
        </p>

        <label htmlFor="pr-reviewer">Reviewer</label>
        <input id="pr-reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />

        {kits.length === 0 ? (
          <div className="empty">No kits yet. Draft one from a milestone above.</div>
        ) : (
          kits.map((kit) => (
            <div className="draft" key={kit.id}>
              <div className="meta">
                <span className={`pill ${kit.status}`}>{kit.status}</span>
                <span className="pill">{kit.milestone_type}</span>
                {kit.outcome && (
                  <span className={`pill ${kit.outcome === 'won' ? 'won' : ''}`}>
                    {kit.outcome.replace('_', ' ')}
                  </span>
                )}
                <strong>{kit.milestone_title}</strong>
                <span>{formatDate(kit.event_date)}</span>
                <span>
                  {kit.approved_count}/{kit.material_count} approved
                </span>
                <span>min alignment {Number(kit.min_theme_alignment).toFixed(2)}</span>
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
                    <span>confidence {Number(material.confidence).toFixed(3)}</span>
                    <span className="mono">themes: {material.themes_used.join(', ') || 'none'}</span>
                  </div>

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
