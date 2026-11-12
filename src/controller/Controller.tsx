import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { CATEGORIES, CATEGORY_IDS, FRIENDS, REVEAL_MS, type CategoryId, type Mode, type Outcome } from '../../shared/game';
import type { ClientMsg, Snapshot } from '../../shared/protocol';
import { encodeWordQr } from '../../shared/qr';
import { Qr } from '../lib/Qr';
import { secondsLeft, useRoom, useTick } from '../lib/useRoom';
import { initialTiltPermission, requestTiltPermission, useTilt, type TiltPermission } from './useTilt';
import { bestsFor, controllerView, MODE_CHOICES, modeOf, palGate } from './view';
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
    // Clue mode never reads tilts, so no motion prompt for it.
    if (modeOf(state?.mode) === 'guess') askTilt();
    send({ t: 'start', category });
  };

  const onMode = (mode: Mode) => send({ t: 'mode', mode });

  // ---------- Round ----------

  // The wordId we already answered: input stays off until the Room sends the next Word.
  const sentForRef = useRef<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const view = controllerView({ state, error, joined, revealing: !!reveal, sentFor });
  const { current, canAnswer } = view;
  const phase = state?.phase;
  const round = state?.round ?? null;
  const now = useTick(view.inRound, 200);
  useWakeLock(view.wakeLock);

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

  const tilt = useTilt(canAnswer, (o) => answer(o, 'tilt'), current?.wordId ?? null);

  // ---------- screens ----------

  let screen: ReactNode;
  switch (view.screen) {
    case 'not_found':
      screen = <Message title="This code isn't active.">Scan the code on the big screen again.</Message>;
      break;
    case 'room_taken':
      screen = <Message title="Someone else is already playing in this Room." />;
      break;
    case 'closed':
      screen = <Message title="Thanks for training.">Scan the new code on the big screen to play again.</Message>;
      break;
    case 'join':
      screen = <Join code={code} nickname={nickname} onNickname={setNickname} onJoin={onJoin} />;
      break;
    case 'reveal':
      screen = <RevealScreen reveal={reveal!} />;
      break;
    case 'joining':
      screen = <Message title="Joining the game…" />;
      break;
    case 'countdown':
      screen = <Countdown seconds={secondsLeft(round!.startsAt, now, clockOffset)} />;
      break;
    case 'play':
      screen = (
        <Play
          wordId={view.qrWordId}
          word={current?.word ?? ''}
          seconds={secondsLeft(round!.endsAt, now, clockOffset)}
          score={round!.gotIt}
          tapFallback={!tilt.available}
          onTap={(o) => canAnswer && answer(o, 'tap')}
        />
      );
      break;
    case 'clue_countdown':
      screen = <ClueIdle countdown={secondsLeft(round!.startsAt, now, clockOffset)} seconds={null} score={0} />;
      break;
    case 'clue_play':
      screen = <ClueIdle countdown={null} seconds={secondsLeft(round!.endsAt, now, clockOffset)} score={round!.gotIt} />;
      break;
    case 'recap':
      screen = (
        <Recap state={state!} onStart={onStart} onMode={onMode} onDone={() => send({ t: 'done' })} onReconnect={() => send({ t: 'reconnect_pal' })} />
      );
      break;
    case 'lobby':
      screen = <Lobby state={state!} onStart={onStart} onMode={onMode} onReconnect={() => send({ t: 'reconnect_pal' })} />;
      break;
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
  const { canStart, notice: kind, friend } = palGate(state);
  const { error } = state.pal;
  let notice: ReactNode = null;
  if (kind === 'no_stage') {
    notice = <p className="ctl-status">Open the big screen to continue.</p>;
  } else if (kind === 'joining') {
    notice = (
      <p className="ctl-status ctl-pulse" role="status">
        {friend} is joining…
      </p>
    );
  } else if (kind === 'busy') {
    notice = (
      <div className="ctl-status">
        <p>{error ?? `${friend} is busy right now. Try again in a few minutes.`}</p>
        <button type="button" className="btn secondary ctl-wide" onClick={onReconnect}>
          Try again
        </button>
      </div>
    );
  } else if (kind === 'ended' || kind === 'error') {
    notice = (
      <div className="ctl-status">
        <p>{kind === 'ended' ? `${friend} left the call.` : `${friend} couldn't join the call.`}</p>
        {kind === 'error' && error && <p className="ctl-fine">{error}</p>}
        <button type="button" className="btn secondary ctl-wide" onClick={onReconnect}>
          Reconnect {friend}
        </button>
      </div>
    );
  } else if (kind === 'offline') {
    notice = <p className="ctl-fine">Playing without the PAL</p>;
  }
  return { canStart, notice };
}

/** Who does what in the next Round. The Room swaps friends when it changes. */
function ModePicker({ state, onMode }: { state: Snapshot; onMode: (m: Mode) => void }) {
  const selected = modeOf(state.mode);
  return (
    <div className="ctl-modes" role="group" aria-label="Mode">
      {MODE_CHOICES.map((c) => (
        <button
          key={c.mode}
          type="button"
          className={`ctl-mode${c.mode === selected ? ' is-on' : ''}`}
          aria-pressed={c.mode === selected}
          onClick={() => c.mode !== selected && onMode(c.mode)}
        >
          <span className="ctl-mode-you">{c.you}</span>
          <span className="ctl-mode-friend">{c.friend}</span>
        </button>
      ))}
    </div>
  );
}

function Categories({ state, enabled, onStart }: { state: Snapshot; enabled: boolean; onStart: (c: CategoryId) => void }) {
  const bests = bestsFor(state);
  return (
    <div className="ctl-cats">
      {CATEGORY_IDS.map((id, i) => {
        const c = CATEGORIES[id];
        const best = bests[id];
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

function Lobby({
  state,
  onStart,
  onMode,
  onReconnect,
}: {
  state: Snapshot;
  onStart: (c: CategoryId) => void;
  onMode: (m: Mode) => void;
  onReconnect: () => void;
}) {
  const { canStart, notice } = palNotice(state, onReconnect);
  const name = state.player?.nickname;
  return (
    <main className="ctl-page ctl-lobby">
      <Logo />
      <h1 className="ctl-title">{name ? `Hi ${name}, pick a category` : 'Pick a category'}</h1>
      <ModePicker state={state} onMode={onMode} />
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

/**
 * Clue mode Round: the phone has no part in it (Maya tilts, a missed tilt is fixed by talking), so nothing here can
 * score or show the Word. Just the timer and score, and a reminder of how to play.
 */
function ClueIdle({ countdown, seconds, score }: { countdown: number | null; seconds: number | null; score: number }) {
  const friend = FRIENDS.clue.name;
  return (
    <main className="ctl-page ctl-clue">
      <Logo />
      <div className="sticky ctl-message-note" style={tiltStyle(0)}>
        <h1>Put the phone down</h1>
        <p>
          {friend}'s guessing. Read the Word above her head and give her Clues!
        </p>
      </div>
      <div className="ctl-clue-hud" aria-live="polite">
        {countdown !== null ? (
          <p className="ctl-clue-big">{countdown > 0 ? `Starting in ${countdown}` : 'Go'}</p>
        ) : (
          <>
            <p className="ctl-clue-big">{seconds}s</p>
            <p className="ctl-clue-score">{score} got</p>
          </>
        )}
      </div>
      <ul className="ctl-clue-rules">
        <li>Never say the Word, not even part of it.</li>
        <li>Faces and miming count.</li>
        <li>Tell {friend} “got it!” or “skip it” and she tilts.</li>
      </ul>
    </main>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Recap({
  state,
  onStart,
  onMode,
  onDone,
  onReconnect,
}: {
  state: Snapshot;
  onStart: (c: CategoryId) => void;
  onMode: (m: Mode) => void;
  onDone: () => void;
  onReconnect: () => void;
}) {
  const s = state.lastSummary!;
  const mode = modeOf(s.mode);
  const clue = mode === 'clue';
  const fouls = s.fouls ?? 0;
  const lifetimeFouls = clue && state.stats?.mode === 'clue' ? state.stats.fouls : null;
  const { canStart, notice } = palNotice(state, onReconnect);
  const pb = state.personalBest && state.personalBest.category === s.category ? state.personalBest : null;
  return (
    <main className="ctl-page ctl-recap">
      <Logo />
      <div className="ctl-recap-result">
        <section className="ctl-score">
          <p className="ctl-score-cat">
            {CATEGORIES[s.category].name} · {clue ? 'You gave Clues' : 'You guessed'}
          </p>
          <p className="ctl-score-num">{s.gotIt}</p>
          <p className="ctl-score-sub">
            got it, {s.passed} passed
            {clue && <>, {fouls > 0 ? plural(fouls, 'Foul') : 'no Fouls'}</>}
          </p>
          {lifetimeFouls !== null && lifetimeFouls > 0 && <p className="ctl-fine">{plural(lifetimeFouls, 'Foul')} all time</p>}
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
                {clue && w.foul && (
                  <span className="ctl-foul">
                    <span className="sr-only">, </span>Foul
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ctl-recap-again">
        <h2 className="ctl-title">Play again</h2>
        <ModePicker state={state} onMode={onMode} />
        {notice}
        <Categories state={state} enabled={canStart} onStart={onStart} />
        <button type="button" className="btn secondary ctl-wide ctl-done" onClick={onDone}>
          Done
        </button>
      </div>
    </main>
  );
}
