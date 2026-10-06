import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { BookModelPanel } from './BookModelPanel.jsx';

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
      setStatus({ kind: 'ok', message: `“${book.title}” is added. You can now write posts from it below.` });
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
      setStatus({ kind: 'ok', message: `Added ${posts.length} past post${posts.length === 1 ? '' : 's'}. New posts will be written to sound like these.` });
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
          `Wrote ${drafts.length} draft posts` +
          (escalated > 0 ? ` (${escalated} flagged for a closer look)` : '') +
          '. Open Review posts to read and approve them.',
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

      <div className="card">
        <h2>Your books</h2>
        <p className="hint">Press “Write this week’s posts” to get a week of drafts — it can take a minute or two. They wait for your approval on Review posts.</p>
        {books.length === 0 ? (
          <div className="empty">No books yet — add your first one below.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Title</th><th>Themes</th><th /></tr>
            </thead>
            <tbody>
              {books.map((book) => (
                <tr key={book.id}>
                  <td><strong>{book.title}</strong></td>
                  <td>{book.themes.join(', ') || '—'}</td>
                  <td className="cell-action">
                    <button onClick={() => generate(book.id)} disabled={busy}>
                      {busy ? 'Writing…' : 'Write this week’s posts'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form className="card" onSubmit={submitBook}>
        <h2>Add a book</h2>
        <p className="hint">
          Paste a chapter or a few pages. Posts quote and build on this text, so pick passages that show what the book is about.
        </p>

        <label htmlFor="title">Book title</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />

        <label htmlFor="themes">Main themes <span className="label-hint">— a few words each, separated by commas</span></label>
        <input
          id="themes"
          value={themes}
          onChange={(e) => setThemes(e.target.value)}
          placeholder="e.g. deep work, craft, attention"
        />

        <label htmlFor="content">Text from the book</label>
        <textarea id="content" value={content} onChange={(e) => setContent(e.target.value)} required placeholder="Paste a chapter or a few pages here…" />

        <button type="submit" disabled={busy}>
          Add book
        </button>
      </form>

      <form className="card" onSubmit={submitHistory}>
        <h2>Your past posts</h2>
        <p className="hint">
          Paste a few posts you’ve written before, so new posts sound like you. One per line: the platform, a
          vertical bar <span className="mono">|</span>, then the post.
        </p>
        <label htmlFor="history">Past posts</label>
        <textarea
          id="history"
          value={history}
          onChange={(e) => setHistory(e.target.value)}
          placeholder={'twitter | Craft is the slow accumulation of decisions nobody claps for.\nlinkedin | One lesson from writing this book…'}
        />
        <button type="submit" className="ghost" disabled={busy}>
          Add posts
        </button>
      </form>

      {/* STORY-046 */}
      <BookModelPanel author={author} books={books} />
    </>
  );
}
