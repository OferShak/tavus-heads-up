import type { ForeheadView } from './forehead';
import './forehead.css';

/**
 * The PAL forehead: a phone held sideways on the PAL's head (Clue mode). Place it inside the 16:9 hero box
 * (`.stage-hero`); it positions itself over the top-centre. Tune the spot with `--forehead-top` / `--forehead-width`
 * on any ancestor. Drive it with usePalForehead: `<PalForehead view={forehead.view} />`.
 */
export function PalForehead({ view }: { view: ForeheadView }) {
  const { screen, tip } = view;
  if (screen.kind === 'hidden') return null;

  let content;
  let screenClass = `is-${screen.kind}`;
  if (screen.kind === 'countdown') {
    // Keyed so each number pops in, like the Controller's countdown.
    content = (
      <span key={screen.n} className="forehead-count">
        {screen.n}
      </span>
    );
  } else if (screen.kind === 'word') {
    content = <span className="forehead-word">{screen.word}</span>;
  } else if (screen.kind === 'flash') {
    screenClass += screen.outcome === 'got' ? ' is-got' : ' is-pass';
    content = (
      <>
        <span className="forehead-label">{screen.outcome === 'got' ? 'Got it' : 'Pass'}</span>
        <span className="forehead-word">{screen.word}</span>
      </>
    );
  } else {
    content = <span className="forehead-timesup">Time's up</span>;
  }

  return (
    <div className="forehead" aria-label="The Word on your PAL's forehead">
      <div className={`forehead-phone tip-${tip}`}>
        <div className={`forehead-screen ${screenClass}`} aria-live="assertive">
          {content}
        </div>
      </div>
    </div>
  );
}
