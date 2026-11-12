// Dev-only preview of the PAL forehead (`/dev/forehead`), so it can be checked without Tavus or a Room.
// The buttons stand in for the Room (countdown, next Word, time's up) and the PAL (its tilt tool call).

import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, type Outcome } from '../../shared/game';
import { PalForehead } from '../stage/PalForehead';
import { usePalForehead, type ForeheadRoom } from '../stage/usePalForehead';
import '../stage/stage.css';
import './forehead-preview.css';

const WORDS = CATEGORIES.animals.words.slice(8, 20);
const LOBBY: ForeheadRoom = { phase: 'lobby', countdown: null, current: null };

function wordAt(i: number) {
  const w = WORDS[i % WORDS.length];
  return { wordId: `${w.id}-${i}`, word: w.word };
}

const positionOf = (wordId: string) => Number(wordId.split('-')[1]);

export default function ForeheadPreview() {
  const [room, setRoom] = useState<ForeheadRoom>(LOBBY);
  const [dropNext, setDropNext] = useState(false);
  const [delayMs, setDelayMs] = useState(150);
  const [log, setLog] = useState<string[]>([]);
  const forehead = usePalForehead(room);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const note = (line: string) => setLog((l) => [`${(performance.now() / 1000).toFixed(2)}s  ${line}`, ...l].slice(0, 12));
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const startCountdown = () => {
    clearTimers();
    setRoom({ phase: 'countdown', countdown: 3, current: null });
    later(() => setRoom({ phase: 'countdown', countdown: 2, current: null }), 1000);
    later(() => setRoom({ phase: 'countdown', countdown: 1, current: null }), 2000);
    later(() => setRoom({ phase: 'playing', countdown: null, current: wordAt(0) }), 3000);
    note('Room: countdown');
  };

  const palTilt = (outcome: Outcome) => {
    const { forward } = forehead.tilt(outcome);
    if (!forward) return note(`PAL tilt ${outcome}: ignored by the forehead`);
    if (dropNext) {
      setDropNext(false);
      return note(`PAL tilt ${outcome} on ${forward.wordId}: Room dropped it`);
    }
    note(`PAL tilt ${outcome} on ${forward.wordId}: sent`);
    // Like the Room: only a tilt for the current Word advances it.
    later(() => {
      // Pure updater (StrictMode runs it twice): the position comes from the wordId.
      setRoom((r) => {
        if (r.phase !== 'playing' || r.current?.wordId !== forward.wordId) return r;
        return { ...r, current: wordAt(positionOf(r.current.wordId) + 1) };
      });
    }, delayMs);
  };

  const doubleTilt = () => {
    palTilt('got');
    palTilt('got');
  };

  const timesUp = () => {
    clearTimers();
    setRoom({ phase: 'recap', countdown: null, current: null });
    note("Room: time's up");
  };

  const lobby = () => {
    clearTimers();
    setRoom(LOBBY);
    note('Room: lobby');
  };

  return (
    <div className="stage fhp">
      <header className="fhp-head">
        <span className="stage-logo wordmark">PAL forehead preview</span>
        <span className="fhp-status">
          Room: {room.phase}
          {room.current ? ` · ${room.current.word}` : ''} · forehead: {forehead.view.screen.kind}, {forehead.view.tip}
        </span>
      </header>

      <div className="stage-hero-wrap fhp-hero-wrap">
        <section className="stage-hero" aria-label="Your PAL">
          <PlaceholderPal />
          <PalForehead view={forehead.view} />
        </section>
      </div>

      <div className="fhp-controls">
        <button type="button" className="btn" onClick={startCountdown}>
          Start countdown
        </button>
        <button type="button" className="btn secondary" onClick={() => palTilt('got')}>
          PAL tilt down
        </button>
        <button type="button" className="btn secondary" onClick={() => palTilt('pass')}>
          PAL tilt up
        </button>
        <button type="button" className="btn secondary" onClick={doubleTilt}>
          Double tilt
        </button>
        <button type="button" className="btn secondary" onClick={timesUp}>
          Time's up
        </button>
        <button type="button" className="btn secondary" onClick={lobby}>
          Lobby
        </button>
        <label className="fhp-field">
          <input type="checkbox" checked={dropNext} onChange={(e) => setDropNext(e.target.checked)} />
          Room drops the next tilt
        </label>
        <label className="fhp-field">
          Room delay
          <input type="number" min={0} step={50} value={delayMs} onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))} />
          ms
        </label>
      </div>

      <ol className="fhp-log" aria-label="Event log">
        {log.map((l, i) => (
          <li key={log.length - i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}

/** Head-and-shoulders stand-in for the PAL video, with guides for where the phone may sit. */
function PlaceholderPal() {
  return (
    <svg className="fhp-pal" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <ellipse className="fhp-body" cx="80" cy="96" rx="52" ry="28" />
      <rect className="fhp-body" x="72" y="52" width="16" height="18" />
      <ellipse className="fhp-body" cx="80" cy="31" rx="19" ry="25" />
      <path className="fhp-hair" d="M61 31 Q60 6 80 6 Q100 6 99 31 Q96 19 80 19 Q64 19 61 31 Z" />
      <circle className="fhp-eye" cx="73" cy="32" r="1.6" />
      <circle className="fhp-eye" cx="87" cy="32" r="1.6" />
      <line className="fhp-guide" x1="0" x2="160" y1="19" y2="19" />
      <text className="fhp-guide-label" x="2" y="18">
        hairline
      </text>
      <line className="fhp-guide" x1="0" x2="160" y1="32" y2="32" />
      <text className="fhp-guide-label" x="2" y="31">
        eyes
      </text>
    </svg>
  );
}
