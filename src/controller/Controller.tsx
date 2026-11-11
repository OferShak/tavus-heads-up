import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { CATEGORIES, CATEGORY_IDS, REVEAL_MS, type CategoryId, type Outcome } from '../../shared/game';
import type { ClientMsg, Snapshot } from '../../shared/protocol';
import { encodeWordQr } from '../../shared/qr';
import { Qr } from '../lib/Qr';
import { secondsLeft, useRoom, useTick } from '../lib/useRoom';
import { initialTiltPermission, requestTiltPermission, useTilt, type TiltPermission } from './useTilt';
import { useWakeLock } from './useWakeLock';
import './controller.css';

const PLAYER_KEY = 'omh.playerId';
const NICK_KEY = 'omh.nickname';
const NICK_MAX = 24;
/** No next Word this long after a tilt: assume it was lost and accept input for the same Word again. */
const UNLOCK_MS = 2_500;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage blocked: the Player just stays anonymous for this visit.
  }
}

function newId(): string {
  // randomUUID needs a secure context; a phone on the LAN dev server over http doesn't have one.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function getPlayerId(): string {
  const existing = readStorage(PLAYER_KEY);
  if (existing) return existing;
  const id = newId();
  writeStorage(PLAYER_KEY, id);
  return id;
}

const NOTE_TILTS = ['-3deg', '2deg', '-1.5deg'];
const tiltStyle = (i: number) => ({ '--tilt': NOTE_TILTS[i % NOTE_TILTS.length] }) as CSSProperties;

type Reveal = { word: string; outcome: Outcome };

export default function Controller({ code }: { code: string }) {
  const [playerId] = useState(getPlayerId);
  const [nickname, setNickname] = useState(() => (readStorage(NICK_KEY) ?? '').slice(0, NICK_MAX));
  const [joined, setJoined] = useState(false);
  const [tiltPerm, setTiltPerm] = useState<TiltPermission>(initialTiltPermission);

  const hello = useMemo<ClientMsg | null>(
    () => (joined ? { t: 'hello', role: 'controller', playerId, nickname: nickname.trim() || undefined } : null),
    [joined, playerId, nickname],
  );
  const { state, connected, error, send, clockOffset } = useRoom(joined ? code : null, 'controller', hello);

  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (connected) setEverConnected(true);
  }, [connected]);

  /** Must run synchronously inside a tap: iOS only shows the motion prompt for a user gesture. */
  const askTilt = () => {
    if (tiltPerm === 'granted' || tiltPerm === 'not-needed') return;
    void requestTiltPermission().then(setTiltPerm);
  };

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    askTilt();
    const nick = nickname.trim().slice(0, NICK_MAX);
    setNickname(nick);
    writeStorage(NICK_KEY, nick);
    setJoined(true);
  };

  const onStart = (category: CategoryId) => {
    askTilt();
    send({ t: 'start', category });
  };

  // ---------- Round ----------

  const phase = state?.phase;
  const round = state?.round ?? null;
  const current = phase === 'playing' ? (round?.current ?? null) : null;
  const inRound = phase === 'countdown' || phase === 'playing';
  const now = useTick(inRound, 200);
  useWakeLock(inRound);

  // The wordId we already answered: input stays off until the Room sends the next Word.
  const sentForRef = useRef<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  useEffect(() => {
    if (!reveal) return;
    const id = setTimeout(() => setReveal(null), REVEAL_MS);
    return () => clearTimeout(id);
  }, [reveal]);

  const answer = useCallback(
    (outcome: Outcome, via: 'tilt' | 'tap') => {
      if (!current || sentForRef.current === current.wordId) return;
      sentForRef.current = current.wordId;
      setSentFor(current.wordId);
      send({ t: 'tilt', wordId: current.wordId, outcome, via });
      navigator.vibrate?.(50);
      setReveal({ word: current.word, outcome });
    },
    [current, send],
  );

  // If the tilt was lost (socket down mid-send) the Room never advances: unlock so the Player can tilt again.
  const currentId = current?.wordId ?? null;
  useEffect(() => {
    if (!sentFor || currentId !== sentFor) return;
    const id = setTimeout(() => {
      sentForRef.current = null;
      setSentFor(null);
    }, UNLOCK_MS);
    return () => clearTimeout(id);
  }, [sentFor, currentId]);

  const canAnswer = !!current && current.wordId !== sentFor && !reveal;
  const tilt = useTilt(canAnswer, (o) => answer(o, 'tilt'), current?.wordId ?? null);

  // ---------- screens ----------

  let screen: ReactNode;
  if (error === 'not_found') {
    screen = <Message title="This code isn't active.">Scan the code on the big screen again.</Message>;
  } else if (error === 'room_taken') {
    screen = <Message title="Someone else is already playing in this Room." />;
  } else if (error === 'room_closed' || phase === 'closed') {
    screen = <Message title="Thanks for training.">Scan the new code on the big screen to play again.</Message>;
  } else if (!joined) {
    screen = <Join code={code} nickname={nickname} onNickname={setNickname} onJoin={onJoin} />;
  } else if (reveal) {
    screen = <RevealScreen reveal={reveal} />;
  } else if (!state) {
    screen = <Message title="Joining the game…" />;
  } else if (phase === 'countdown' && round) {
    screen = <Countdown seconds={secondsLeft(round.startsAt, now, clockOffset)} />;
  } else if (phase === 'playing' && round) {
    screen = (
      <Play
        wordId={current && current.wordId !== sentFor ? current.wordId : null}
        word={current?.word ?? ''}
        seconds={secondsLeft(round.endsAt, now, clockOffset)}
        score={round.gotIt}
        tapFallback={!tilt.available}
        onTap={(o) => canAnswer && answer(o, 'tap')}
      />
    );
  } else if (phase === 'recap' && state.lastSummary) {
    screen = <Recap state={state} onStart={onStart} onDone={() => send({ t: 'done' })} onReconnect={() => send({ t: 'reconnect_pal' })} />;
  } else {
    screen = <Lobby state={state} onStart={onStart} onReconnect={() => send({ t: 'reconnect_pal' })} />;
  }

  return (
    <div className="ctl">
      {screen}
      {joined && everConnected && !connected && !error && phase !== 'closed' && (
        <div className="ctl-reconnecting" role="status">
          Reconnecting…
        </div>
      )}
    </div>
  );
}

// ---------- pieces ----------

function Logo() {
  return <div className="wordmark ctl-logo">Over My Head</div>;
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="ctl-page ctl-message">
      <Logo />
      <div className="sticky ctl-message-note" style={tiltStyle(0)}>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </main>
  );
}

function Join({ code, nickname, onNickname, onJoin }: { code: string; nickname: string; onNickname: (v: string) => void; onJoin: (e: FormEvent) => void }) {
  return (
    <main className="ctl-page ctl-join">
      <Logo />
      <div className="sticky ctl-join-note" style={tiltStyle(0)}>
        <h1>Join the game</h1>
        <p>Room {code}</p>
      </div>
      <form className="ctl-join-form" onSubmit={onJoin}>
        <label className="ctl-field">
          <span>Nickname (optional)</span>
          <input
            type="text"
            value={nickname}
            maxLength={NICK_MAX}
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="go"
            onChange={(e) => onNickname(e.target.value.slice(0, NICK_MAX))}
          />
        </label>
        <button type="submit" className="btn ctl-wide">
          Join
        </button>
        <p className="ctl-fine">Your phone becomes the card on your forehead. Allow motion access so tilting works.</p>
      </form>
    </main>
  );
}

/** PAL and Stage status in plain words. Returns whether a Round can start. */
function palNotice(state: Snapshot, onReconnect: () => void): { canStart: boolean; notice: ReactNode } {
  const { status, error } = state.pal;
  const canStart = status === 'ready' || status === 'offline';
  let notice: ReactNode = null;
  if (!state.stageConnected) {
    notice = <p className="ctl-status">Open the big screen to continue.</p>;
  } else if (status === 'idle' || status === 'starting' || status === 'joining') {
    notice = <p className="ctl-status ctl-pulse">Your PAL is joining the call…</p>;
  } else if (status === 'busy') {
    notice = (
      <div className="ctl-status">
        <p>{error ?? 'The PAL is busy right now. Try again in a few minutes.'}</p>
        <button type="button" className="btn secondary ctl-wide" onClick={onReconnect}>
          Try again
        </button>
      </div>
    );
  } else if (status === 'ended' || status === 'error') {
    notice = (
      <div className="ctl-status">
        <p>{status === 'ended' ? 'Your PAL left the call.' : "Your PAL couldn't join the call."}</p>
        {status === 'error' && error && <p className="ctl-fine">{error}</p>}
        <button type="button" className="btn secondary ctl-wide" onClick={onReconnect}>
          Reconnect PAL
        </button>
      </div>
    );
  } else if (status === 'offline') {
    notice = <p className="ctl-fine">Playing without the PAL</p>;
  }
  return { canStart, notice };
}

function Categories({ state, enabled, onStart }: { state: Snapshot; enabled: boolean; onStart: (c: CategoryId) => void }) {
  return (
    <div className="ctl-cats">
      {CATEGORY_IDS.map((id, i) => {
        const c = CATEGORIES[id];
        const best = state.stats?.bests?.[id];
        return (
          <button key={id} type="button" className="sticky ctl-cat" style={tiltStyle(i)} disabled={!enabled} onClick={() => onStart(id)}>
            <span className="ctl-cat-name">{c.name}</span>
            <span className="ctl-cat-meta">
              <span>{c.blurb}</span>
              <span>{best !== undefined ? `Your best ${best}` : 'No score yet'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Lobby({ state, onStart, onReconnect }: { state: Snapshot; onStart: (c: CategoryId) => void; onReconnect: () => void }) {
  const { canStart, notice } = palNotice(state, onReconnect);
  const name = state.player?.nickname;
  return (
    <main className="ctl-page ctl-lobby">
      <Logo />
      <h1 className="ctl-title">{name ? `Hi ${name}, pick a category` : 'Pick a category'}</h1>
      {notice}
      <Categories state={state} enabled={canStart} onStart={onStart} />
    </main>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  return (
    <main className="ctl-countdown">
      <p className="ctl-countdown-hint">Hold it sideways on your forehead, screen facing out</p>
      <div key={seconds} className="ctl-countdown-num" aria-live="assertive">
        {seconds > 0 ? seconds : 'Go'}
      </div>
    </main>
  );
}

function Play({
  wordId,
  word,
  seconds,
  score,
  tapFallback,
  onTap,
}: {
  wordId: string | null;
  word: string;
  seconds: number;
  score: number;
  tapFallback: boolean;
  onTap: (o: Outcome) => void;
}) {
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!tapFallback) return;
    const r = e.currentTarget.getBoundingClientRect();
    onTap(e.clientX - r.left < r.width / 2 ? 'pass' : 'got');
  };
  return (
    <main className="ctl-play" onPointerDown={onPointerDown}>
      <div className="ctl-hud" aria-label={`${seconds} seconds left, ${score} got`}>
        <span>{seconds}s</span>
        <span>{score} got</span>
      </div>
      {/* Never the Word as text: only the Stage camera reads it. */}
      {wordId && <Qr className="ctl-qr" value={encodeWordQr(wordId, word)} level="L" label="Word QR" />}
      {tapFallback && (
        <>
          <span className="ctl-tap-hint ctl-tap-pass">Pass</span>
          <span className="ctl-tap-hint ctl-tap-got">Got it</span>
        </>
      )}
    </main>
  );
}

function RevealScreen({ reveal }: { reveal: Reveal }) {
  return (
    <main className={`ctl-reveal ${reveal.outcome === 'got' ? 'is-got' : 'is-pass'}`} aria-live="assertive">
      <p className="ctl-reveal-label">{reveal.outcome === 'got' ? 'Got it' : 'Pass'}</p>
      <p className="ctl-reveal-word">{reveal.word}</p>
    </main>
  );
}

function Recap({
  state,
  onStart,
  onDone,
  onReconnect,
}: {
  state: Snapshot;
  onStart: (c: CategoryId) => void;
  onDone: () => void;
  onReconnect: () => void;
}) {
  const s = state.lastSummary!;
  const { canStart, notice } = palNotice(state, onReconnect);
  const pb = state.personalBest && state.personalBest.category === s.category ? state.personalBest : null;
  return (
    <main className="ctl-page ctl-recap">
      <Logo />
      <div className="ctl-recap-result">
        <section className="ctl-score">
          <p className="ctl-score-cat">{CATEGORIES[s.category].name}</p>
          <p className="ctl-score-num">{s.gotIt}</p>
          <p className="ctl-score-sub">
            got it, {s.passed} passed
          </p>
          {pb && (
            <p className="ctl-pb">
              New personal best{pb.previous !== null ? `, up from ${pb.previous}` : ''}!
            </p>
          )}
        </section>
        {s.words.length > 0 && (
          <ul className="ctl-words">
            {s.words.map((w) => (
              <li key={w.wordId} className={`is-${w.outcome}`}>
                <span className="ctl-mark" aria-hidden="true">
                  {w.outcome === 'got' ? '✓' : w.outcome === 'pass' ? '✕' : '…'}
                </span>
                <span className="ctl-word">{w.word}</span>
                <span className="sr-only">{w.outcome === 'got' ? 'Got it' : w.outcome === 'pass' ? 'Pass' : 'Time ran out'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ctl-recap-again">
        <h2 className="ctl-title">Play again</h2>
        {notice}
        <Categories state={state} enabled={canStart} onStart={onStart} />
        <button type="button" className="btn secondary ctl-wide ctl-done" onClick={onDone}>
          Done
        </button>
      </div>
    </main>
  );
}
