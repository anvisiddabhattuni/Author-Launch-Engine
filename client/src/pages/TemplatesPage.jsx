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
export function TemplatesPage({ user }) {
  const [templates, setTemplates] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState({});

  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    setTemplates(await api.memeTemplates());
  }, []);

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

  const usable = templates.filter((t) => t.usable);
  const withheld = templates.filter((t) => !t.usable);

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

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
