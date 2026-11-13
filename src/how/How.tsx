import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import md from '../../docs/writeup.md?raw';
import './how.css';

interface Heading {
  depth: number;
  id: string;
  label: string;
}

interface TocEntry {
  id: string;
  label: string;
  children: { id: string; label: string }[];
}

/** The H2 whose H3s are listed in the table of contents; H3s in other sections stay out of it. */
const TOC_NESTED = 'key-decisions';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Strip inline markdown so a heading's TOC label and slug come from its plain text. */
const plain = (s: string) => s.replace(/[`*_]/g, '').trim();

// Rendered once at module load. The source is our own repo file, so raw HTML output is fine.
// H2s and H3s get stable slug ids (marked doesn't add them) and are collected for the table of contents.
const headings: Heading[] = [];
const used = new Map<string, number>();
const markdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    heading({ tokens, depth, text }) {
      if (depth !== 2 && depth !== 3) return false;
      const label = plain(text);
      const base = slugify(label) || 'section';
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n + 1}`;
      headings.push({ depth, id, label });
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

// Tables get a scroll wrapper so they never force horizontal page scroll on phones.
const html = (markdown.parse(md) as string)
  .replace(/<table>/g, '<div class="how-table"><table>')
  .replace(/<\/table>/g, '</table></div>');

/** H2s, with the H3s of "Key decisions" nested under it. */
const toc: TocEntry[] = [];
for (const h of headings) {
  if (h.depth === 2) toc.push({ id: h.id, label: h.label, children: [] });
  else if (toc.at(-1)?.id === TOC_NESTED) toc.at(-1)!.children.push({ id: h.id, label: h.label });
}

/** Every id the scrollspy tracks, in document order, with the H2 each belongs to. */
const tracked = toc.flatMap((e) => [{ id: e.id, h2: e.id }, ...e.children.map((c) => ({ id: c.id, h2: e.id }))]);

/** How far down the viewport a heading must pass to become the section being read. */
const ACTIVE_LINE = 0.3;

/** Scrollspy: the deepest TOC entry being read, via IntersectionObserver. */
function useActiveSection(): { id: string; h2: string } {
  const [active, setActive] = useState(tracked[0] ?? { id: '', h2: '' });

  useEffect(() => {
    const els = tracked.map((t) => document.getElementById(t.id));
    const footer = document.querySelector('.how-footer');
    let atEnd = false;

    const update = () => {
      let i = 0;
      if (atEnd) {
        i = tracked.length - 1;
      } else {
        const line = window.innerHeight * ACTIVE_LINE;
        els.forEach((el, k) => {
          if (el && el.getBoundingClientRect().top <= line) i = k;
        });
      }
      const next = tracked[i];
      if (next) setActive((cur) => (cur.id === next.id ? cur : next));
    };

    // Headings crossing the active line trigger a recompute; the zone is the top ACTIVE_LINE of the viewport.
    const spy = new IntersectionObserver(update, { rootMargin: `0px 0px -${(1 - ACTIVE_LINE) * 100}% 0px` });
    els.forEach((el) => el && spy.observe(el));
    // A short last section never reaches the line: once the footer is fully in view, it is the one being read.
    const end = new IntersectionObserver(
      ([e]) => {
        atEnd = e.isIntersecting;
        update();
      },
      { threshold: 1 },
    );
    if (footer) end.observe(footer);
    update();
    return () => {
      spy.disconnect();
      end.disconnect();
    };
  }, []);

  return active;
}

/** `/how`: the write-up, rendered from docs/writeup.md at build time, with an on-this-page nav. */
export default function How() {
  const active = useActiveSection();
  const navList = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'How it works: Over My Head';
    document.body.classList.add('how-body');
    return () => {
      document.title = prevTitle;
      document.body.classList.remove('how-body');
    };
  }, []);

  // Deep links (`/how#clue-mode`): the page renders after the browser's own hash scroll, so do it once mounted.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, []);

  // Narrow screens: keep the active chip in view by scrolling the chip row only (never the page).
  useEffect(() => {
    const row = navList.current;
    const chip = row?.querySelector<HTMLElement>(`[data-h2="${active.h2}"]`);
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
  }, [active.h2]);

  return (
    <div className="how">
      <div className="how-frame">
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
        <div className="how-layout">
          <nav className="how-toc" aria-label="On this page">
            <p className="how-toc-title" aria-hidden="true">
              On this page
            </p>
            <ul ref={navList}>
              {toc.map((e) => {
                const current = active.id === e.id;
                const within = active.h2 === e.id;
                return (
                  <li key={e.id} data-h2={e.id} className={within ? 'is-within' : undefined}>
                    <a href={`#${e.id}`} aria-current={current ? 'true' : undefined}>
                      {e.label}
                    </a>
                    {e.children.length > 0 && (
                      <ul>
                        {e.children.map((c) => (
                          <li key={c.id}>
                            <a href={`#${c.id}`} aria-current={active.id === c.id ? 'true' : undefined}>
                              {c.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
          <main className="how-article" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        <footer className="how-footer">
          <a href="/">Play Over My Head</a>
        </footer>
      </div>
    </div>
  );
}
