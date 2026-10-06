import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * The meme template library (STORY-067).
 *
 * Browsing is open to anyone signed in; adding and retiring are admin-only,
 * because the library is global — one tenant retiring a template changes what
 * every other tenant's generator can reach for.
 *
 * The page leads with the templates the generator is *not* allowed to use,
 * because that is the half a filter normally hides. STORY-010 spent a whole
 * story on the same point about opportunities: an offered template is visible
 * and can be judged wrong, and a withheld one used to leave no trace at all.
 */
const COLOUR_LABEL = { ground: 'Background colour', ink: 'Text colour', accent: 'Highlight colour' };

export function TemplatesPage({ user, author, book }) {
  const [templates, setTemplates] = useState([]);
  const [identity, setIdentity] = useState(null);
  const [edit, setEdit] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState({});

  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    setTemplates(await api.memeTemplates(book?.id));
    if (author?.id && book?.id) {
      const guide = await api.visualIdentity(author.id, book.id);
      setIdentity(guide);
      setEdit(
        guide.active
          ? { ...guide.active.palette, doNotUse: guide.active.doNotUse.join('\n'), note: '' }
          : null,
      );
    }
  }, [author?.id, book?.id]);

  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function retire(key) {
    setBusy(true);
    setStatus(null);
    try {
      await api.retireMemeTemplate(key, reasons[key] ?? '');
      setStatus({ kind: 'ok', message: `“${key}” won’t be used any more. Posts already made with it are unchanged.` });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function revise() {
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api.reviseVisualIdentity(author.id, book.id, {
        palette: { ground: edit.ground, ink: edit.ink, accent: edit.accent, mode: edit.mode },
        doNotUse: edit.doNotUse.split('\n').map((r) => r.trim()).filter(Boolean),
        note: edit.note,
      });
      setStatus({
        kind: 'ok',
        message: `Saved. New image posts will follow this look; earlier ones are unchanged.`,
      });
      await refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const usable = templates.filter((t) => t.usable);
  const withheld = templates.filter((t) => !t.usable);
  const active = identity?.active;

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      {active && edit && (
        <div className="card">
          <h2>Your book’s look</h2>
          <p className="hint">
            The colours and rules every image post follows, so they all look like they belong to your book.
            Changes apply to new image posts only. (Version {active.version}.)
          </p>
          {/* Where the palette came from, said as its own claim rather than
              buried mid-sentence — an inferred palette and one the author set
              are different things and should not read the same. */}
          <div className="meta">
            <span
              className={`pill ${active.derivedFrom?.coverArt || active.createdBy !== 'system' ? 'approved' : 'neutral'}`}
            >
              colours: {active.derivedFrom?.coverArt ? 'taken from your cover' : active.createdBy !== 'system' ? 'chosen by you' : 'a starting guess'}
            </span>
          </div>

          <div className="row form-row">
            {['ground', 'ink', 'accent'].map((key) => (
              <div key={key}>
                <label htmlFor={`c-${key}`}>{COLOUR_LABEL[key]}</label>
                <div className="row" style={{ alignItems: 'center' }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      border: '1px solid var(--border-strong)',
                      flex: 'none',
                      background: edit[key],
                      display: 'inline-block',
                    }}
                  />
                  <input
                    id={`c-${key}`}
                    value={edit[key]}
                    onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                    style={{ width: 120 }}
                  />
                </div>
              </div>
            ))}
            <div>
              <label htmlFor="c-mode">Style</label>
              <select
                id="c-mode"
                value={edit.mode}
                onChange={(e) => setEdit({ ...edit, mode: e.target.value })}
              >
                <option value="dark">Dark background</option>
                <option value="light">Light background</option>
              </select>
            </div>
          </div>

          <label htmlFor="dnu" style={{ marginTop: 12 }}>
            Never use — one rule per line <span className="label-hint">— an image breaking one of these is held back and shown to you</span>
          </label>
          <textarea
            id="dnu"
            rows={4}
            value={edit.doNotUse}
            onChange={(e) => setEdit({ ...edit, doNotUse: e.target.value })}
          />

          <label htmlFor="identity-note">Why are you changing it? <span className="label-hint">— optional, kept in the activity history</span></label>
          <input
            id="identity-note"
            value={edit.note}
            onChange={(e) => setEdit({ ...edit, note: e.target.value })}
          />

          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={revise} disabled={busy}>
              Save changes
            </button>
          </div>

          <details className="draft-details">
          <summary>Earlier versions ({identity.versions.length})</summary>
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Main colour</th>
                <th>Style</th>
                <th>Changed by</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {identity.versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">
                    v{v.version}
                    {v.active && <span className="pill approved" style={{ marginLeft: 6 }}>in use</span>}
                  </td>
                  <td className="mono">
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: v.palette.accent,
                        display: 'inline-block',
                        marginRight: 6,
                      }}
                    />
                    {v.palette.accent}
                  </td>
                  <td>{v.palette.mode === 'dark' ? 'Dark' : 'Light'}</td>
                  <td>{v.createdBy}</td>
                  <td>{v.note || <span className="mono">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </details>
        </div>
      )}

      <details className="card disclosure">
        <summary><h2>Not allowed to be used ({withheld.length})</h2></summary>
        <p className="hint">
          Pictures the app will never use — usually because we don’t have permission (a licence) to use them.
        </p>
        {withheld.length === 0 ? (
          <div className="empty">None — every picture can be used.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Where it’s from</th>
                <th>Licence</th>
                <th>Why not</th>
              </tr>
            </thead>
            <tbody>
              {withheld.map((t) => (
                <tr key={t.key}>
                  <td>
                    {t.name}
                  </td>
                  <td className="audit-detail mono">{t.source || '—'}</td>
                  <td>{t.licence?.terms ?? 'None recorded'}</td>
                  <td>
                    <span className="pill unnamed">{t.reason?.replace(/_/g, ' ')}</span>
                    {t.retiredReason && <div className="hint">{t.retiredReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      <div className="card">
        <h2>Pictures the app can use ({usable.length})</h2>
        <p className="hint">
          Each picture has spaces for captions, which the app fills in. “Fits your book’s look” shows how well
          its colours match — the app prefers the ones that fit best.
          {!isAdmin && ' Only an admin can stop a picture from being used.'}
        </p>

        {usable.map((t) => (
          <div className="draft" key={t.key}>
            <div className="meta">
              <strong>{t.name}</strong>
              <span className="pill">{t.layout}</span>
              <span className="pill approved">{t.licence?.terms}</span>
              {t.licence?.attribution && <span className="hint">© {t.licence.attribution}</span>}
              {/* Licensed and on-brand are different questions (STORY-068). A
                  template can be perfectly licensed and still not look like
                  this book, and the author is the one who decides what to do
                  about that — retire it, or move the guide. */}
              {t.identityScore !== null && (
                <span
                  className={`pill ${t.identityScore >= (t.identityFloor ?? 0.75) ? 'approved' : 'unnamed'}`}
                  title={
                    t.identityFindings?.length
                      ? t.identityFindings.join(', ')
                      : 'matches your book’s look'
                  }
                >
                  {t.identityScore >= (t.identityFloor ?? 0.75) ? 'Fits your book’s look' : 'Doesn’t quite fit your look'} {Math.round(t.identityScore * 100)}%
                  {t.identityFindings?.length > 0 && ` · ${t.identityFindings.join(', ').replace(/_/g, ' ')}`}
                </span>
              )}
            </div>

            <div className="meme">
              <img src={t.imageRef} alt={`${t.name} artwork, before any caption`} />
              <div>
                <div className="hint audit-detail">From: {t.source}</div>
                <table>
                  <thead>
                    <tr>
                      <th>Caption space</th>
                      <th>What goes there</th>
                      <th>Max letters</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.captionSlots.map((slot) => (
                      <tr key={slot.name}>
                        <td>{slot.name.replace(/_/g, ' ')}</td>
                        <td>{slot.role}</td>
                        <td className="num">{slot.maxChars}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {isAdmin && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <input
                      aria-label={`Why stop using ${t.name}?`}
                      placeholder="Why stop using it? (kept in the activity history)"
                      value={reasons[t.key] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [t.key]: e.target.value })}
                    />
                    <button className="danger" disabled={busy} onClick={() => retire(t.key)}>
                      Stop using
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
