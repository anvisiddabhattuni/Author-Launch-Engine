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
      <h2>What the AI learned from this book</h2>
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
        <div className="empty">No model yet — one is fitted when a book is uploaded, or before its first drafts.</div>
      ) : (
        <>
          <div className="meta" style={{ marginTop: 10 }}>
            <span className="pill">version {m.version}</span>
            <span className="pill neutral">fitted {new Date(m.trainedAt).toISOString().slice(0, 16).replace('T', ' ')} · {m.trigger.replace('_', ' ')}</span>
            <span className="pill neutral">
              {m.parameters.sources.passages} passages
              {Object.keys(m.parameters.sources.materials).length ? ` + ${Object.values(m.parameters.sources.materials).reduce((a, b) => a + b, 0)} materials` : ''}
            </span>
            <span className={`pill ${m.metrics.modelEvidence > m.metrics.literalEvidence ? 'approved' : 'neutral'}`}>
              evidence {m.metrics.literalEvidence} → {m.metrics.modelEvidence} of {m.metrics.evidenceSlots}
            </span>
            <span className={`pill ${m.metrics.maskedRecall == null ? 'neutral' : 'approved'}`}>
              held-out recall {m.metrics.maskedRecall == null ? 'not measurable' : `${Math.round(m.metrics.maskedRecall * 100)}%`}
              {m.metrics.heldOut ? ` (${m.metrics.recalled}/${m.metrics.heldOut})` : ''}
            </span>
          </div>
          <p className="hint">
            For each theme, the words this book uses to argue it — learned from the passages that name it.
            Held-out recall: hide one of those passages, remove the theme&apos;s own word, and see whether the model
            still recognises it. Searching for the word alone scores 0% on that by definition.
          </p>
          <table>
            <thead>
              <tr><th>Theme</th><th>Learned from</th><th>This book&apos;s words for it</th><th>Found without the word</th><th>Strongest line</th></tr>
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
                    {t.lexicon.length ? t.lexicon.slice(0, 6).map((l) => l.word ?? l.term).join(', ') : <span className="pill escalated">too few examples</span>}
                  </td>
                  <td className="mono">{t.foundPassages.length || '—'}</td>
                  <td className="hint">{t.anchorLines[0] ? `“${t.anchorLines[0].sentence}”` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.metrics.themesWithoutExamples.length > 0 && (
            <p className="hint">
              <strong>{m.metrics.themesWithoutExamples.join(', ')}</strong>: the book names {m.metrics.themesWithoutExamples.length === 1 ? 'this theme' : 'these themes'} too
              rarely to learn from. A synopsis or note describing {m.metrics.themesWithoutExamples.length === 1 ? 'it' : 'them'} gives the model examples.
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
            ? { kind: 'ok', message: `Feedback applied — now version ${r.model.version}.` }
            : { kind: 'ok', message: 'No new feedback since the last version; nothing changed.' });
          await refresh();
        } catch (e) {
          setStatus({ kind: 'error', message: e.message });
        } finally {
          setBusy(false);
        }
      }} />}

      <form onSubmit={addMaterial} style={{ marginTop: 14 }}>
        <label htmlFor="material-kind">Add supplementary material — learned from, never quoted</label>
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
          <button type="submit" className="ghost" disabled={busy || material.content.trim().length < 20}>Add and refit</button>
        </div>
      </form>

      {data?.versions?.length > 1 && (
        <p className="hint" style={{ marginTop: 10 }}>
          Earlier versions: {data.versions.filter((v) => v.status === 'superseded').map((v) => `v${v.version} (${v.trigger.replace('_', ' ')}, recall ${v.metrics.maskedRecall == null ? 'n/a' : `${Math.round(v.metrics.maskedRecall * 100)}%`})`).join(' · ')}
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
      <h3>What reviewers have taught it</h3>
      <div className="meta">
        <span className="pill neutral">{prefs.judgments} judgments</span>
        <span className={`pill ${moved.length ? 'approved' : 'neutral'}`}>{moved.length} passage{moved.length === 1 ? '' : 's'} reweighted</span>
        <span className="pill neutral">{tilted.length} theme{tilted.length === 1 ? '' : 's'} tilted</span>
        {model.trigger === 'feedback' && <span className="pill approved">this version: from feedback</span>}
        <button className="ghost" disabled={busy} onClick={onApply}>Apply feedback now</button>
      </div>
      <p className="hint">
        Every approval, rejection, request for changes and rating on this book&apos;s drafts counts. A passage turned
        down twice and never liked is not quoted while the book has another for its theme. Otherwise feedback is
        applied before the next drafts.
      </p>
      {moved.length > 0 && (
        <table>
          <thead><tr><th>Passage</th><th>Liked</th><th>Turned down</th><th>Weight</th><th /></tr></thead>
          <tbody>
            {moved.map((p) => (
              <tr key={p.id}>
                <td className="hint">“{previews[p.id] ?? `passage ${p.id}`}…”</td>
                <td className="mono">{p.good}</td>
                <td className="mono">{p.bad}</td>
                <td className="mono">{p.weight.toFixed(2)}</td>
                <td>{p.weight < 0.6 ? <span className="pill escalated">not quoted</span> : p.weight > 1 ? <span className="pill approved">preferred</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {prefs.notes.length > 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          What they said: {prefs.notes.map((n) => `“${n.note}”`).join(' · ')}
        </div>
      )}
    </div>
  );
}
