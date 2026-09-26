import { useEffect, useState } from 'react';

import { api } from '../api.js';

/** Build step 1: the author supplies book content and prior social posts. */
export function UploadPage({ author }) {
  const [books, setBooks] = useState([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [themes, setThemes] = useState('');
  const [history, setHistory] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.books(author.id).then(setBooks).catch(() => {});

  useEffect(() => {
    refresh();
  }, [author.id]);

  async function submitBook(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const book = await api.uploadBook(author.id, {
        title,
        content,
        themes: themes
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setStatus({ kind: 'ok', message: `Uploaded "${book.title}" (id ${book.id}).` });
      setTitle('');
      setContent('');
      setThemes('');
      refresh();
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function submitHistory(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    let posts = [];
    try {
      // One post per line: "platform | text"
      posts = history
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [platform, ...rest] = line.split('|');
          return { platform: platform.trim(), content: rest.join('|').trim() };
        })
        .filter((p) => p.platform && p.content);

      if (posts.length === 0) throw new Error('Add at least one line as "platform | post text".');

      await api.uploadHistory(author.id, posts);
      setStatus({ kind: 'ok', message: `Added ${posts.length} prior posts for voice matching.` });
      setHistory('');
    } catch (error) {
      // Before STORY-032 a typo'd platform was stored and this said "Added".
      // Now it is refused per line; say which line, in the author's terms.
      const lines = (error.details ?? [])
        .map((d) => d.path.match(/^posts\.(\d+)\.(\w+)/))
        .filter(Boolean)
        .map(([, i, field]) => {
          const n = Number(i) + 1;
          const shown = posts[Number(i)]?.[field];
          return field === 'platform'
            ? `Line ${n}: "${shown}" is not a platform posts are drafted for — use twitter, instagram, facebook or linkedin.`
            : `Line ${n}: the ${field} is not valid.`;
        });
      setStatus({
        kind: 'error',
        message: lines.length ? `Nothing was added. ${lines.join(' ')}` : error.message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function generate(bookId) {
    setBusy(true);
    setStatus(null);
    try {
      const drafts = await api.generateDrafts(author.id, bookId, { count: 4 });
      const escalated = drafts.filter((d) => d.status === 'escalated').length;
      setStatus({
        kind: 'ok',
        message:
          `Generated ${drafts.length} drafts` +
          (escalated > 0 ? `, ${escalated} escalated for low confidence` : '') +
          '. Open "Review & approve" to decide on them.',
      });
    } catch (error) {
      setStatus({ kind: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <form className="card" onSubmit={submitBook}>
        <h2>Book content</h2>
        <p className="hint">
          The drafting agent quotes from this text and anchors every post in the themes you list.
        </p>

        <label htmlFor="title">Title</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />

        <label htmlFor="themes">Themes (comma separated)</label>
        <input
          id="themes"
          value={themes}
          onChange={(e) => setThemes(e.target.value)}
          placeholder="deep work, craft, attention"
        />

        <label htmlFor="content">Manuscript excerpt</label>
        <textarea id="content" value={content} onChange={(e) => setContent(e.target.value)} required />

        <button type="submit" disabled={busy}>
          Upload book
        </button>
      </form>

      <form className="card" onSubmit={submitHistory}>
        <h2>Previous social posts</h2>
        <p className="hint">
          One per line as <span className="mono">platform | post text</span>. Used to score how closely
          a draft matches your voice.
        </p>
        <textarea
          value={history}
          onChange={(e) => setHistory(e.target.value)}
          placeholder={'twitter | Craft is the slow accumulation of decisions nobody claps for.'}
        />
        <button type="submit" className="ghost" disabled={busy}>
          Add posts
        </button>
      </form>

      <div className="card">
        <h2>Your books</h2>
        <p className="hint">Generating drafts creates a week of platform-tailored posts for review.</p>
        {books.length === 0 ? (
          <div className="empty">No books uploaded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Themes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {books.map((book) => (
                <tr key={book.id}>
                  <td>{book.title}</td>
                  <td className="mono">{book.themes.join(', ') || '—'}</td>
                  <td>
                    <button onClick={() => generate(book.id)} disabled={busy}>
                      Generate weekly drafts
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
