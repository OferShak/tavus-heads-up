import { useEffect } from 'react';
import { marked } from 'marked';
import md from '../../docs/writeup.md?raw';
import './how.css';

// Rendered once at module load. The source is our own repo file, so raw HTML output is fine.
// Tables get a scroll wrapper so they never force horizontal page scroll on phones.
const html = (marked(md, { async: false, gfm: true }) as string)
  .replace(/<table>/g, '<div class="how-table"><table>')
  .replace(/<\/table>/g, '</table></div>');

/** `/how`: the write-up, rendered from docs/writeup.md at build time. */
export default function How() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'How it works: Over My Head';
    document.body.classList.add('how-body');
    return () => {
      document.title = prevTitle;
      document.body.classList.remove('how-body');
    };
  }, []);

  return (
    <div className="how">
      <header className="how-header">
        <a className="how-home wordmark" href="/">
          Over My Head
        </a>
        <span className="sticky how-note" aria-hidden="true">
          the write-up
        </span>
        <a className="how-play" href="/">
          Play
        </a>
      </header>
      <main className="how-article" dangerouslySetInnerHTML={{ __html: html }} />
      <footer className="how-footer">
        <a href="/">Play Over My Head</a>
      </footer>
    </div>
  );
}
