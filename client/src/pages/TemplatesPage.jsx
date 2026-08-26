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
export function TemplatesPage({ user, author, book }) {
  const [templates, setTemplates] = useState([]);
  const [identity, setIdentity] = useState(null);
  const [edit, setEdit] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState({});

  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    setTemplates(await api.memeTemplates());
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
      setStatus({ kind: 'ok', message: `"${key}" retired. Drafts that used it keep their provenance.` });
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
        message: `Saved as version ${saved.version}. Memes drafted from now on are judged against it; earlier ones keep the version they were made under.`,
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
          <h2>Visual identity — version {active.version}</h2>
          <p className="hint">
            What every meme is generated against and scored against, so the output looks like one
            book rather than one feed. {active.derivedFrom?.confidence}. Editing writes a new
            version: later memes are judged against it, and memes already drafted keep pointing at
            the version they were made to satisfy.
          </p>

          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {['ground', 'ink', 'accent'].map((key) => (
              <div key={key}>
                <label htmlFor={`c-${key}`}>{key}</label>
                <div className="row" style={{ alignItems: 'center' }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      border: '1px solid #333',
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
              <label htmlFor="c-mode">mode</label>
              <select
                id="c-mode"
                value={edit.mode}
                onChange={(e) => setEdit({ ...edit, mode: e.target.value })}
              >
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </div>
          </div>

          <label htmlFor="dnu" style={{ marginTop: 12 }}>
            Do not use — one rule per line. These are the half with teeth: a meme breaking one is
            withheld and sent to you.
          </label>
          <textarea
            id="dnu"
            rows={4}
            value={edit.doNotUse}
            onChange={(e) => setEdit({ ...edit, doNotUse: e.target.value })}
          />

          <input
            placeholder="Why are you changing it? (goes on the audit log)"
            value={edit.note}
            onChange={(e) => setEdit({ ...edit, note: e.target.value })}
            style={{ marginTop: 8 }}
          />

          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={revise} disabled={busy}>
              Save as version {active.version + 1}
            </button>
          </div>

          <h3>History</h3>
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Accent</th>
                <th>Mode</th>
                <th>Set by</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {identity.versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">
                    v{v.version}
                    {v.active && <span className="pill approved" style={{ marginLeft: 6 }}>active</span>}
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
                  <td className="mono">{v.palette.mode}</td>
                  <td>{v.createdBy}</td>
                  <td>{v.note || <span className="mono">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Withheld from the generator ({withheld.length})</h2>
        <p className="hint">
          Templates the system will not compose a meme from, and why. Every time the generator
          reaches for one it is refused and the refusal is written to the audit log — an unlicensed
          image cannot reach a draft, and now you can check that rather than take it on trust.
        </p>
        {withheld.length === 0 ? (
          <div className="empty">Every template in the library is licensed and active.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Source</th>
                <th>Licence</th>
                <th>Why it is withheld</th>
              </tr>
            </thead>
            <tbody>
              {withheld.map((t) => (
                <tr key={t.key}>
                  <td>
                    {t.name}
                    <span className="mono"> · {t.key}</span>
                  </td>
                  <td className="mono">{t.source || '—'}</td>
                  <td className="mono">{t.licence?.terms ?? 'none recorded'}</td>
                  <td>
                    <span className="pill unnamed">{t.reason?.replace(/_/g, ' ')}</span>
                    {t.retiredReason && <span className="mono"> · {t.retiredReason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Available to the generator ({usable.length})</h2>
        <p className="hint">
          Each template is a piece of artwork with named caption slots the drafter fills. A slot says
          what it is <em>for</em>, so a new template can be added without a code change to go with it.
          {!isAdmin && ' Retiring a template is an operator action — sign in as ops to do it.'}
        </p>

        {usable.map((t) => (
          <div className="draft" key={t.key}>
            <div className="meta">
              <strong>{t.name}</strong>
              <span className="mono">{t.key}</span>
              <span className="pill">{t.layout}</span>
              <span className="pill approved">{t.licence?.terms}</span>
              {t.licence?.attribution && <span className="mono">© {t.licence.attribution}</span>}
            </div>

            <div className="meme">
              <img src={t.imageRef} alt={`${t.name} artwork, before any caption`} />
              <div>
                <div className="meta mono">source: {t.source}</div>
                <table>
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>What it is for</th>
                      <th>Limit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.captionSlots.map((slot) => (
                      <tr key={slot.name}>
                        <td className="mono">{slot.name}</td>
                        <td>{slot.role}</td>
                        <td className="mono">{slot.maxChars}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {isAdmin && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <input
                      placeholder="Why retire it? (goes on the audit log)"
                      value={reasons[t.key] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [t.key]: e.target.value })}
                    />
                    <button className="danger" disabled={busy} onClick={() => retire(t.key)}>
                      Retire
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
