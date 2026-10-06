import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * What the AI learned from a book (STORY-046).
 *
 * The model fitted to it: for each theme, the words this book uses to argue
 * it, the lines that carry it, the passages it found that never name the
 * theme, and how well it does on passages held out with the theme's word
 * masked. Supplementary material added here is learned from; only the book
 * is ever quoted.
 */
const KINDS = [
  ['synopsis', 'Synopsis'],
  ['author_note', 'Author note'],
  ['excerpt', 'Excerpt'],
  ['press_quote', 'Press quote'],
  ['review', 'Review'],
];

export function BookModelPanel({ author, books }) {
  const [bookId, setBookId] = useState(books[0]?.id ?? null);
  const [data, setData] = useState(null);
  const [material, setMaterial] = useState({ kind: 'author_note', content: '' });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bookId && books[0]) setBookId(books[0].id);
  }, [books, bookId]);

  const refresh = useCallback(async () => {
    if (bookId) setData(await api.bookModel(author.id, bookId));
  }, [author.id, bookId]);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  async function addMaterial(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.addBookMaterial(author.id, bookId, material);
      setStatus({ kind: 'ok', message: `Added. The model was refitted — now version ${r.model.version}.` });
      setMaterial({ ...material, content: '' });
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (books.length === 0) return null;
  const m = data?.current;

  return (
    <div className="card">
      <h2>What the app learned from your book</h2>
      <p className="hint">Before writing, the app studies your book to learn the words it uses for each theme. Your reviews teach it more over time.</p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div>
          <label htmlFor="model-book">Book</label>
          <select id="model-book" value={bookId ?? ''} onChange={(e) => setBookId(Number(e.target.value))}>
            {books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
        </div>
      </div>
      {status && <div className={`banner ${status.kind}`} style={{ marginTop: 10 }}>{status.message}</div>}

      {!m ? (
        <div className="empty">Nothing learned yet — it happens when a book is added, or before its first posts are written.</div>
      ) : (
        <>
          <div className="meta" style={{ marginTop: 10 }}>
            <span className="pill">Learning version {m.version}</span>
            <span className="pill neutral">
              updated {new Date(m.trainedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              {m.trigger === 'feedback' ? ' from your reviews' : ''}
            </span>
            <span className="pill neutral">
              studied {m.parameters.sources.passages} passages
              {Object.keys(m.parameters.sources.materials).length ? ` and ${Object.values(m.parameters.sources.materials).reduce((a, b) => a + b, 0)} of your notes` : ''}
            </span>
          </div>
          <details className="draft-details" style={{ marginTop: 8 }}>
            <summary>Technical details</summary>
            <p className="hint">
              Evidence found: {m.metrics.literalEvidence} → {m.metrics.modelEvidence} of {m.metrics.evidenceSlots}.
              Recognition test (hide a passage and its theme word, then see if the theme is still recognised):{' '}
              {m.metrics.maskedRecall == null ? 'not measurable yet' : `${Math.round(m.metrics.maskedRecall * 100)}%`}
              {m.metrics.heldOut ? ` (${m.metrics.recalled} of ${m.metrics.heldOut})` : ''}.
            </p>
          </details>
          <table>
            <thead>
              <tr><th>Theme</th><th>Learned from</th><th>Words your book uses for it</th><th>Strongest line</th></tr>
            </thead>
            <tbody>
              {m.parameters.themes.map((t) => (
                <tr key={t.theme}>
                  <td><strong>{t.theme}</strong></td>
                  <td className="mono">
                    {t.examples.passages} passage{t.examples.passages === 1 ? '' : 's'}
                    {t.examples.materialSentences ? ` + ${t.examples.materialSentences} note${t.examples.materialSentences === 1 ? '' : 's'}` : ''}
                  </td>
                  <td className="mono">
                    {t.lexicon.length ? t.lexicon.slice(0, 6).map((l) => l.word ?? l.term).join(', ') : <span className="pill pending_approval">not enough examples yet</span>}
                  </td>
                  <td className="hint">{t.anchorLines[0] ? `“${t.anchorLines[0].sentence}”` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.metrics.themesWithoutExamples.length > 0 && (
            <p className="hint">
              <strong>{m.metrics.themesWithoutExamples.join(', ')}</strong>: your book mentions {m.metrics.themesWithoutExamples.length === 1 ? 'this theme' : 'these themes'} too
              rarely to learn from. Add a short note about {m.metrics.themesWithoutExamples.length === 1 ? 'it' : 'them'} below to help.
            </p>
          )}
        </>
      )}

      {m && <ReviewerLessons model={m} previews={data.passagePreviews ?? {}} busy={busy} onApply={async () => {
        setBusy(true);
        setStatus(null);
        try {
          const r = await api.applyFeedback(author.id, bookId);
          setStatus(r.refitted
            ? { kind: 'ok', message: `Your reviews have been applied — now learning version ${r.model.version}.` }
            : { kind: 'ok', message: 'No new reviews since the last update, so nothing changed.' });
          await refresh();
        } catch (e) {
          setStatus({ kind: 'error', message: e.message });
        } finally {
          setBusy(false);
        }
      }} />}

      <form onSubmit={addMaterial} style={{ marginTop: 14 }}>
        <label htmlFor="material-kind">Add a note about your book <span className="label-hint">— the app learns from it but never quotes it</span></label>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <select id="material-kind" style={{ width: 'auto' }} value={material.kind} onChange={(e) => setMaterial({ ...material, kind: e.target.value })}>
            {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <textarea
            id="material-content"
            rows={3}
            style={{ flex: 1, minWidth: 220 }}
            value={material.content}
            placeholder="e.g. Loss in this book lives in small objects: the empty chair, his coat on the hook…"
            onChange={(e) => setMaterial({ ...material, content: e.target.value })}
          />
          <button type="submit" className="ghost" disabled={busy || material.content.trim().length < 20}>Add note</button>
        </div>
      </form>

      {data?.versions?.length > 1 && (
        <p className="hint" style={{ marginTop: 10 }}>
          Earlier learning versions: {data.versions.filter((v) => v.status === 'superseded').map((v) => `${v.version}`).join(', ')}
        </p>
      )}
    </div>
  );
}

/**
 * What reviewers have taught the model (STORY-048): passages they kept turning
 * down or kept liking, themes tilted, and what they said. Two judgments before
 * anything moves; a theme is tilted, never silenced.
 */
function ReviewerLessons({ model, previews, busy, onApply }) {
  const prefs = model.parameters.preferences ?? { judgments: 0, passages: [], themes: [], notes: [] };
  const moved = prefs.passages.filter((p) => p.weight !== 1);
  const tilted = prefs.themes.filter((t) => t.weight !== 1);
  return (
    <div style={{ marginTop: 16 }}>
      <h3>What your reviews have taught it</h3>
      <div className="meta">
        <span className="pill neutral">{prefs.judgments} decisions and ratings</span>
        <span className={`pill ${moved.length ? 'approved' : 'neutral'}`}>{moved.length} passage{moved.length === 1 ? '' : 's'} used more or less</span>
        {tilted.length > 0 && <span className="pill neutral">{tilted.length} theme{tilted.length === 1 ? '' : 's'} adjusted</span>}
        <button className="ghost small" disabled={busy} onClick={onApply}>Apply my reviews now</button>
      </div>
      <p className="hint">
        Every approval, rejection and rating counts. A passage you’ve turned down twice and never liked stops being
        quoted. Your reviews are applied automatically before the next posts are written.
      </p>
      {moved.length > 0 && (
        <table>
          <thead><tr><th>Passage</th><th>Liked</th><th>Turned down</th><th>Effect</th></tr></thead>
          <tbody>
            {moved.map((p) => (
              <tr key={p.id}>
                <td className="hint">“{previews[p.id] ?? `passage ${p.id}`}…”</td>
                <td className="mono">{p.good}</td>
                <td className="mono">{p.bad}</td>
                <td title={`weight ${p.weight.toFixed(2)}`}>{p.weight < 0.6 ? <span className="pill escalated">no longer quoted</span> : p.weight > 1 ? <span className="pill approved">used more</span> : <span className="pill neutral">unchanged</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {prefs.notes.length > 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          What reviewers said: {[...new Set(prefs.notes.map((n) => n.note))].map((n) => `“${n}”`).join(' · ')}
        </div>
      )}
    </div>
  );
}
