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

/**
 * STORY-003: PR materials drafted for a milestone, each aligned with the book's
 * themes and held for human review before the kit can be distributed.
 */
export function PressPage({ author, book }) {
  const [milestones, setMilestones] = useState([]);
  const [kits, setKits] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [reviewer, setReviewer] = useState(author.name);
  const [notes, setNotes] = useState({});
  const [open, setOpen] = useState({});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [m, k, c] = await Promise.all([
      api.milestones(author.id),
      api.pressKits(author.id),
      api.pressContacts(),
    ]);
    setMilestones(m);
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
                  <td>{m.title}</td>
                  <td>
                    <span className="pill">{m.type}</span>
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
                    {!m.kit_id && (
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
                <strong>{kit.milestone_title}</strong>
                <span>{formatDate(kit.event_date)}</span>
                <span>
                  {kit.approved_count}/{kit.material_count} approved
                </span>
                <span>min alignment {Number(kit.min_theme_alignment).toFixed(2)}</span>
              </div>

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

                  {DECIDABLE.includes(material.status) && (
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

              {kit.status !== 'distributed' && (
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
