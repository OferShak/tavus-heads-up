// The Stage: the laptop/TV screen. Shows the Join QR, runs the PAL call, decodes the Word QR from the
// camera and drives the PAL through the PalDirector (Guess mode) or the ClueDirector (Clue mode), routed by the
// friend in the call. In Guess mode it never displays the current Word; in Clue mode it shows it on the PAL forehead.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { CATEGORIES, FRIENDS, ROUND_MS, type Mode } from '../../shared/game';
import type { ClientMsg, RoomEvent, Snapshot } from '../../shared/protocol';
import type { RoundSummary } from '../../shared/room';
import { Qr } from '../lib/Qr';
import { secondsLeft, useRoom, useTick } from '../lib/useRoom';
import { ClueDirector, isRevealStrategyName, REVEAL_STRATEGIES, REVEAL_STRATEGY, type RevealStrategyName } from './clue-director';
import { PalDirector, type TavusEvent } from './director';
import { DirectorRouter, type SwapMeasure } from './director-router';
import { usePalCall, type PalCallHandlers } from './pal-call';
import { preloadScanner, startScanner, type ScanEngine } from './scanner';
import './stage.css';

declare global {
  interface Window {
    /** Every raw Tavus app-message, for capturing undocumented payloads. */
    __omhEvents?: unknown[];
  }
}

const ROOM_KEY = 'omh.stageRoom';
const HELLO: ClientMsg = { t: 'hello', role: 'stage' };
const CLOSED_RESET_MS = 4_000;
const DEBUG_EVENTS = 40;

const params = new URLSearchParams(window.location.search);
const DEBUG = params.has('debug');
const REACTIONS = params.get('react') !== '0';
/** Clue mode Reveal delivery, `?reveal=<name>` for the live spike (see REVEAL_STRATEGIES). */
const REVEAL: RevealStrategyName = isRevealStrategyName(params.get('reveal')) ? (params.get('reveal') as RevealStrategyName) : REVEAL_STRATEGY;

function parseJoinOverride(): string | null {
  const raw = params.get('join');
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
const JOIN_OVERRIDE = parseJoinOverride();
const ON_LOCALHOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const DEV_ORIGIN_POLL_MS = 2_000;
const DEV_ORIGIN_GIVE_UP_MS = 60_000;

/** Served by the dev server only (scripts/vite-tunnel.ts). */
interface DevOrigins {
  tunnel: string | null;
  lan: string | null;
  tunnelEnabled: boolean;
}

/**
 * Origin the phone should open: `?join=<origin>` > the dev HTTPS tunnel > the dev LAN address > this
 * page's origin. The dev ones apply only while the Stage runs on localhost (secure context for the
 * camera), and the tunnel URL can take a few seconds to appear, so poll for it.
 */
function useJoinOrigin(): string {
  const [dev, setDev] = useState<DevOrigins | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV || JOIN_OVERRIDE || !ON_LOCALHOST) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      const r = (await fetch('/__omh/dev-origin')
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)) as DevOrigins | null;
      if (stopped) return;
      if (r) setDev(r);
      const waiting = !r || (r.tunnelEnabled && !r.tunnel);
      if (waiting && Date.now() - started < DEV_ORIGIN_GIVE_UP_MS) timer = setTimeout(poll, DEV_ORIGIN_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  if (JOIN_OVERRIDE) return JOIN_OVERRIDE;
  if (ON_LOCALHOST && dev?.tunnel) return dev.tunnel;
  if (ON_LOCALHOST && dev?.lan) return dev.lan;
  return location.origin;
}

type Io = { interact: (eventType: string, properties?: Record<string, unknown>) => void; report: (m: ClientMsg) => void };
const NO_IO: Io = { interact: () => undefined, report: () => undefined };

interface DebugEvent {
  id: number;
  type: string;
  json: string;
}

interface DebugState {
  events: DebugEvent[];
  engine: ScanEngine | 'loading';
  lastQr: string | null;
  /** The last friend swap, measured on the Stage (a write-up number). */
  swap: SwapMeasure | null;
}

function withEvent(d: DebugState, type: string, data: unknown): DebugState {
  return { ...d, events: [{ id: Date.now() + Math.random(), type, json: JSON.stringify(data, null, 1) }, ...d.events].slice(0, DEBUG_EVENTS) };
}

// ---------- Room code ----------

let pendingRoom: Promise<string> | null = null;

async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error(`POST /api/rooms ${res.status}`);
  const { code } = (await res.json()) as { code: string };
  sessionStorage.setItem(ROOM_KEY, code);
  return code;
}

/** Reuse this tab's Room after a reload unless it is gone or closed. Shared promise: StrictMode mounts twice. */
function obtainRoom(): Promise<string> {
  pendingRoom ??= (async () => {
    const saved = sessionStorage.getItem(ROOM_KEY);
    if (saved) {
      const res = await fetch(`/api/rooms/${saved}`).catch(() => null);
      if (res?.ok) {
        const info = (await res.json().catch(() => null)) as { phase?: string } | null;
        if (info && info.phase !== 'closed') return saved;
      }
      sessionStorage.removeItem(ROOM_KEY);
    }
    return createRoom();
  })().catch((e: unknown) => {
    pendingRoom = null;
    throw e;
  });
  return pendingRoom;
}

function useRoomCode() {
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let off = false;
    setFailed(false);
    obtainRoom().then(
      (c) => !off && setCode(c),
      () => !off && setFailed(true),
    );
    return () => {
      off = true;
    };
  }, [generation]);

  const renew = useCallback(() => {
    sessionStorage.removeItem(ROOM_KEY);
    pendingRoom = null;
    setCode(null);
    setGeneration((g) => g + 1);
  }, []);
  const retry = useCallback(() => setGeneration((g) => g + 1), []);

  return { code, failed, renew, retry };
}

// ---------- Camera ----------

function cameraMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera and microphone are blocked. Allow them for this site (the icon in the address bar), then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera or microphone found. Plug one in and try again.';
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close it there and try again.';
  return 'Could not start the camera. Try again.';
}

/** One MediaStream for the whole session: Self-view, Word QR scanner and the PAL call. */
function useCamera() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let off = false;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser has no camera access. Use a recent Chrome, Edge or Safari over https.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then(
        (s) => {
          if (off) return s.getTracks().forEach((t) => t.stop());
          setStream(s);
        },
        (e: unknown) => !off && setError(cameraMessage(e)),
      );
    return () => {
      off = true;
    };
  }, [attempt]);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { stream, error, retry };
}

// ---------- Stage ----------

export default function Stage() {
  const { code, failed, renew, retry } = useRoomCode();
  const camera = useCamera();
  const io = useRef<Io>(NO_IO);
  const [debug, setDebug] = useState<DebugState>({ events: [], engine: 'loading', lastQr: null, swap: null });
  const [director] = useState(() => {
    const interact = (t: string, p?: Record<string, unknown>) => io.current.interact(t, p);
    const report = (m: ClientMsg) => io.current.report(m);
    const now = () => Date.now();
    const guess = new PalDirector({
      interact,
      report,
      now,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      reactions: REACTIONS,
    });
    const clue = new ClueDirector({
      interact,
      report,
      now,
      reactions: REACTIONS,
      reveal: REVEAL_STRATEGIES[REVEAL],
      log: DEBUG ? (label, data) => setDebug((d) => withEvent(d, label, data)) : undefined,
    });
    return new DirectorRouter(guess, clue, { now, onSwap: (swap) => setDebug((d) => ({ ...d, swap })) });
  });
  useEffect(() => () => director.dispose(), [director]);

  const setEngine = useCallback((engine: ScanEngine) => setDebug((d) => (d.engine === engine ? d : { ...d, engine })), []);
  useEffect(() => preloadScanner(setEngine), [setEngine]);

  const newRoom = useCallback(() => {
    director.dispose();
    director.setLive(false);
    renew();
  }, [director, renew]);

  if (!code) {
    return (
      <div className="stage stage-plain">
        <span className="wordmark stage-logo">Over My Head</span>
        {failed ? (
          <>
            <p className="stage-plain-line">Couldn't set up a Room. Check your connection.</p>
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </>
        ) : (
          <p className="stage-plain-line">Setting up a Room…</p>
        )}
      </div>
    );
  }

  return (
    <StageRoom key={code} code={code} camera={camera} director={director} io={io} debug={debug} setDebug={setDebug} setEngine={setEngine} onRenew={newRoom} />
  );
}

interface StageRoomProps {
  code: string;
  camera: ReturnType<typeof useCamera>;
  director: DirectorRouter;
  io: RefObject<Io>;
  debug: DebugState;
  setDebug: Dispatch<SetStateAction<DebugState>>;
  setEngine: (e: ScanEngine) => void;
  onRenew: () => void;
}

/** Everything tied to one Room. Keyed by code, so a fresh Room starts from clean connection state. */
function StageRoom({ code, camera, director, io, debug, setDebug, setEngine, onRenew }: StageRoomProps) {
  const onMessage = useCallback((s: Snapshot, ev?: RoomEvent) => director.onSnapshot(s, ev), [director]);
  const room = useRoom(code, 'stage', HELLO, onMessage);
  const snap = room.state;
  const pal = snap?.pal;
  const phase = snap?.phase ?? 'waiting';

  // ----- PAL call -----
  const palUrl = pal?.conversationUrl && (pal.status === 'joining' || pal.status === 'ready') ? pal.conversationUrl : null;
  const roomSend = room.send;
  const handlers: PalCallHandlers = {
    onAppMessage: (data) => {
      (window.__omhEvents ??= []).push(data);
      if (DEBUG) {
        const type = (data as TavusEvent | undefined)?.event_type ?? '(no event_type)';
        setDebug((d) => withEvent(d, type, data));
      }
      if (data && typeof data === 'object') director.onTavusEvent(data as TavusEvent);
    },
    onPalJoined: (conversationId) => {
      roomSend({ t: 'pal', status: 'joined', ...(conversationId ? { conversationId } : {}) });
      director.onPalJoined();
    },
    onPalLeft: (conversationId) => {
      director.setLive(false);
      roomSend({ t: 'pal', status: 'left', ...(conversationId ? { conversationId } : {}) });
    },
    onError: (error, conversationId) => {
      director.setLive(false);
      roomSend({ t: 'pal', status: 'error', error, ...(conversationId ? { conversationId } : {}) });
    },
  };
  const call = usePalCall(palUrl, pal?.conversationId ?? null, camera.stream, camera.stream !== null || camera.error !== null, handlers);

  useEffect(() => {
    io.current = { interact: call.send, report: roomSend };
    return () => {
      io.current = NO_IO;
    };
  }, [io, call.send, roomSend]);

  // The call is gone (conversation ended): the next join must brief the PAL again.
  useEffect(() => {
    if (!palUrl) director.setLive(false);
  }, [palUrl, director]);

  // After a socket reconnect the Room demotes the PAL to joining; it is still in our call, so say so.
  useEffect(() => {
    if (pal?.status === 'joining' && call.view.present) {
      roomSend({ t: 'pal', status: 'joined', ...(pal.conversationId ? { conversationId: pal.conversationId } : {}) });
    }
  }, [pal?.status, pal?.conversationId, call.view.present, roomSend]);

  const lastFriend = useLastFriend(pal);

  // ----- Word QR scanner (Guess mode only: in Clue mode the Word is on the PAL forehead) -----
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const playing = phase === 'playing' && snap?.round?.mode !== 'clue';
  useEffect(() => {
    if (!playing || !videoEl) return;
    const scanner = startScanner(
      videoEl,
      (payload) => {
        director.onQr(payload);
        if (DEBUG) setDebug((d) => (d.lastQr === payload ? d : { ...d, lastQr: payload }));
      },
      setEngine,
    );
    return () => scanner.stop();
  }, [playing, videoEl, director, setDebug, setEngine]);

  // ----- Room lifecycle -----
  useEffect(() => {
    if (room.error) onRenew();
  }, [room.error, onRenew]);
  useEffect(() => {
    if (phase !== 'closed') return;
    const t = window.setTimeout(onRenew, CLOSED_RESET_MS);
    return () => window.clearTimeout(t);
  }, [phase, onRenew]);

  const selfView = <SelfView stream={camera.stream} onVideo={setVideoEl} />;

  let screen;
  if (phase === 'closed') {
    screen = (
      <div className="stage stage-plain">
        <span className="wordmark stage-logo">Over My Head</span>
        <p className="stage-plain-title">Thanks for training.</p>
        <p className="stage-plain-line">Go beat your friends. A fresh Room is on its way.</p>
      </div>
    );
  } else if (!snap || phase === 'waiting') {
    screen = <Waiting code={code} camera={camera} selfView={selfView} />;
  } else {
    screen = (
      <Game snap={snap} clockOffset={room.clockOffset} palVideo={call.view.video} selfView={selfView} cameraError={camera.error} lastFriend={lastFriend} />
    );
  }

  return (
    <>
      {screen}
      <PalAudio track={call.view.audio} />
      {DEBUG && (
        <DebugPanel
          debug={debug}
          palStatus={pal?.status ?? 'none'}
          friend={pal ? FRIENDS[pal.mode ?? 'guess'].name : 'none'}
          route={director.active}
          connected={room.connected}
        />
      )}
    </>
  );
}

/** The friend last seen ready in the call: a different friend starting or joining is a swap (ADR 0004). */
function useLastFriend(pal: Snapshot['pal'] | undefined): Mode | null {
  const [last, setLast] = useState<Mode | null>(null);
  const ready = pal?.status === 'ready';
  const friend = pal?.mode ?? 'guess';
  useEffect(() => {
    if (ready) setLast(friend);
  }, [ready, friend]);
  return last;
}

// ---------- Media elements ----------

function SelfView({ stream, onVideo }: { stream: MediaStream | null; onVideo: (el: HTMLVideoElement | null) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const setRef = useCallback(
    (el: HTMLVideoElement | null) => {
      ref.current = el;
      onVideo(el);
    },
    [onVideo],
  );
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={setRef} className="stage-selfview" autoPlay playsInline muted aria-label="Your camera" />;
}

function TrackVideo({ track, className }: { track: MediaStreamTrack | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted aria-label="Your PAL" />;
}

/** The PAL's voice. Browsers may block autoplay with sound until someone clicks the Stage. */
function PalAudio({ track }: { track: MediaStreamTrack | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (!track) return setBlocked(false);
    el.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
  }, [track]);
  const unblock = () => {
    ref.current?.play().then(
      () => setBlocked(false),
      () => undefined,
    );
  };
  return (
    <>
      <audio ref={ref} autoPlay />
      {blocked && (
        <button type="button" className="btn stage-unmute" onClick={unblock}>
          Click to hear your PAL
        </button>
      )}
    </>
  );
}

// ---------- Waiting ----------

function Waiting({ code, camera, selfView }: { code: string; camera: ReturnType<typeof useCamera>; selfView: ReactNode }) {
  const joinOrigin = useJoinOrigin();
  const joinUrl = `${joinOrigin}/j/${code}`;
  return (
    <div className="stage stage-waiting">
      <header className="stage-top">
        <span className="wordmark stage-logo">Over My Head</span>
        <a className="stage-howlink" href="/how">
          How it's built
        </a>
      </header>
      <main className="stage-waiting-main">
        <div className="sticky stage-join" style={{ '--tilt': '-3deg' } as CSSProperties}>
          <Qr value={joinUrl} level="M" className="stage-join-qr" label="Join QR: scan with your phone to join this Room" />
          <p className="stage-join-code" aria-label={`Room code ${code.split('').join(' ')}`}>
            {code}
          </p>
        </div>
        <div className="stage-waiting-side">
          <h1 className="stage-waiting-title">Scan the note with your phone, then hold the phone on your forehead.</h1>
          <p className="stage-waiting-alt">
            No scanner? Open <strong>{`${joinOrigin.replace(/^https?:\/\//, '')}/j/${code}`}</strong> on your phone.
          </p>
          <figure className="stage-camcheck">
            <div className="stage-camcheck-frame">
              {camera.error ? (
                <div className="stage-camcheck-error" role="alert">
                  <p>{camera.error}</p>
                  <button type="button" className="btn secondary" onClick={camera.retry}>
                    Try the camera again
                  </button>
                </div>
              ) : (
                selfView
              )}
            </div>
            <figcaption>{camera.error ? 'The PAL needs your camera to see the Word on your forehead.' : 'Get your forehead in frame.'}</figcaption>
          </figure>
        </div>
      </main>
    </div>
  );
}

// ---------- Game ----------

interface GameProps {
  snap: Snapshot;
  clockOffset: number;
  palVideo: MediaStreamTrack | null;
  selfView: ReactNode;
  cameraError: string | null;
  /** The friend last seen in the call, to tell a swap from a first join. */
  lastFriend: Mode | null;
}

function Game({ snap, clockOffset, palVideo, selfView, cameraError, lastFriend }: GameProps) {
  const { phase, round, pal } = snap;
  const ticking = phase === 'countdown' || phase === 'playing';
  const now = useTick(ticking, 100);
  const serverNow = now + clockOffset;

  let secs = ROUND_MS / 1000;
  let fraction = 1;
  if (round && phase === 'playing') {
    secs = secondsLeft(round.endsAt, now, clockOffset);
    fraction = Math.min(1, Math.max(0, (round.endsAt - serverNow) / ROUND_MS));
  } else if (round && phase === 'recap') {
    secs = 0;
    fraction = 0;
  }
  const countdown = round && phase === 'countdown' ? Math.max(1, secondsLeft(round.startsAt, now, clockOffset)) : null;
  const heard = phase === 'playing' && round?.current?.heardAt !== undefined;
  const recap = phase === 'recap';
  const friend = pal.mode ?? 'guess';
  // Clue mode only: the Word on the PAL forehead. Guess mode's Word never shows on the Stage.
  const forehead = phase === 'playing' && round?.mode === 'clue' ? round.current : null;
  const showName = pal.status === 'ready' && palVideo !== null;

  return (
    <div className={`stage stage-game${recap ? ' is-recap' : ''}`}>
      <header className="stage-hud">
        <span className="wordmark stage-logo">Over My Head</span>
        {round ? (
          <div className="stage-hud-round">
            <span className="stage-hud-category">{CATEGORIES[round.category].name}</span>
            <span className="stage-hud-index">Round {round.index}</span>
          </div>
        ) : (
          <div className="stage-hud-round" />
        )}
        <div className="stage-hud-stat" aria-label={`${round?.gotIt ?? 0} got it`}>
          <span className="stage-num">{round?.gotIt ?? 0}</span>
          <span className="stage-hud-unit">got it</span>
        </div>
        <div className={`stage-hud-stat${phase === 'playing' && secs <= 10 ? ' is-low' : ''}`} aria-label={`${secs} seconds left`}>
          <span className="stage-num">{secs}</span>
          <span className="stage-hud-unit">seconds</span>
        </div>
      </header>
      <div className="stage-timebar" aria-hidden="true">
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>

      <main className="stage-arena">
        <div className="stage-hero-wrap">
          {forehead && <PalForehead key={forehead.wordId} word={forehead.word} friend={FRIENDS[friend].name} />}
          <div className="stage-hero-box">
            <section className="stage-hero" aria-label={`Your PAL, ${FRIENDS[friend].name}`}>
              <TrackVideo track={pal.status === 'ready' ? palVideo : null} className="stage-pal-video" />
              <PalPanel snap={snap} hasVideo={palVideo !== null} lastFriend={lastFriend} />
              {countdown !== null && (
                <div className="stage-countdown" aria-live="assertive">
                  <span key={countdown} className="stage-num">
                    {countdown}
                  </span>
                </div>
              )}
              {(showName || heard) && (
                <div className="stage-hero-tags">
                  {showName && (
                    <span className="stage-friend">
                      {FRIENDS[friend].name}
                      <span className="stage-friend-role">{friend === 'clue' ? 'guessing' : 'giving clues'}</span>
                    </span>
                  )}
                  {heard && (
                    <p className="stage-heard" role="status">
                      Heard it
                    </p>
                  )}
                </div>
              )}
              <div className="stage-pip">
                {cameraError ? <p className="stage-pip-error">Camera off</p> : selfView}
              </div>
            </section>
          </div>
        </div>
        {recap && <Recap snap={snap} />}
      </main>
    </div>
  );
}

/**
 * The Word on the PAL forehead (Clue mode): the Player reads it like a friend's card. The PAL can't see it. No
 * aria-live: a screen reader saying it out loud could reach the PAL through the mic.
 */
function PalForehead({ word, friend }: { word: string; friend: string }) {
  return (
    <div className="stage-forehead">
      <div className="sticky stage-forehead-card" style={{ '--tilt': '-1.5deg' } as CSSProperties}>
        <span className="stage-forehead-label">On {friend}'s forehead</span>
        <span className="stage-forehead-word">{word}</span>
      </div>
    </div>
  );
}

/** Shown while a friend joins: a swap reads as the guesser changing, like in a real group (ADR 0004). */
function joiningTitle(friend: Mode, lastFriend: Mode | null): { title: string; detail: string | null } {
  const name = FRIENDS[friend].name;
  if (lastFriend === null || lastFriend === friend) return { title: `${name} is joining…`, detail: null };
  return { title: friend === 'clue' ? `${name}'s turn to guess` : `${name}'s turn to give the clues`, detail: 'Joining…' };
}

/** What sits on the hero when the PAL video isn't the whole story. */
function PalPanel({ snap, hasVideo, lastFriend }: { snap: Snapshot; hasVideo: boolean; lastFriend: Mode | null }) {
  const { pal, phase } = snap;
  let title: string | null = null;
  let detail: string | null = null;
  let note: string | null = null;
  let tone = '';
  switch (pal.status) {
    case 'idle':
    case 'starting':
    case 'joining':
      ({ title, detail } = joiningTitle(pal.mode ?? 'guess', lastFriend));
      break;
    case 'ready':
      if (!hasVideo) ({ title, detail } = joiningTitle(pal.mode ?? 'guess', lastFriend));
      break;
    case 'busy':
      title = 'PAL is busy with another player. Try again in a few minutes.';
      detail = pal.error && !pal.error.includes('busy') ? pal.error : null;
      tone = ' is-warn';
      break;
    case 'offline':
      title = 'Your PAL is off for this run.';
      detail = phase === 'countdown' || phase === 'playing' ? 'Rounds still run without the PAL.' : 'Pick a Category on your phone.';
      note = pal.error ?? null;
      break;
    case 'ended':
      title = 'Your PAL left the call.';
      detail = 'You can reconnect the PAL from your phone.';
      tone = ' is-warn';
      break;
    case 'error':
      title = "Your PAL couldn't connect.";
      detail = `${pal.error ? `${pal.error} ` : ''}You can reconnect the PAL from your phone.`;
      tone = ' is-warn';
      break;
  }

  if (title) {
    return (
      <div className={`stage-pal-panel${tone}`} role="status">
        <p className="stage-pal-title">{title}</p>
        {detail && <p className="stage-pal-detail">{detail}</p>}
        {note && <p className="stage-pal-note">{note}</p>}
      </div>
    );
  }
  if (phase === 'lobby') {
    return (
      <p className="stage-caption" role="status">
        Pick a Category on your phone
      </p>
    );
  }
  return null;
}

// ---------- Recap ----------

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Tilt slips by kind, worded like the per-Word slip notes; zero kinds are left out ('' when there are none). */
const slipSplit = (passedAfterHeard: number, gotUnheard: number) =>
  [passedAfterHeard > 0 && `${passedAfterHeard} you said it`, gotUnheard > 0 && `${gotUnheard} not heard`].filter(Boolean).join(', ');

function Recap({ snap }: { snap: Snapshot }) {
  const s = snap.lastSummary;
  if (!s) return null;
  if (s.mode === 'clue') return <ClueRecap snap={snap} s={s} />;
  // snap.stats follows the selected Mode; after switching to Clue mode they aren't this Round's.
  const stats = snap.stats?.mode === 'guess' ? snap.stats : null;
  const pb = snap.personalBest;
  const best = stats?.bests[s.category];
  const qrTotal = s.qrDecoded + s.qrFallback;
  // Lifetime split can sum to less than tiltSlips: slips from before it was tracked can't be attributed.
  const allTimeSlips = stats ? slipSplit(stats.passedAfterHeard, stats.gotUnheard) : '';

  return (
    <section className="stage-recap" aria-label="Round recap">
      <div className="stage-recap-head">
        <p className="stage-recap-score">
          <span className="stage-num">{s.gotIt}</span>
          <span className="stage-recap-score-unit">got it</span>
        </p>
        <div>
          <h2 className="stage-recap-category">{CATEGORIES[s.category].name}</h2>
          <p className="stage-recap-sub">
            Round {s.index}, {s.passed} passed
          </p>
        </div>
        {pb && (
          <div className="sticky stage-pb" style={{ '--tilt': '4deg' } as CSSProperties}>
            <span className="stage-pb-title">New personal best</span>
            <span className="stage-pb-detail">{pb.previous !== null ? `Up from ${pb.previous}` : 'Your first one'}</span>
          </div>
        )}
      </div>

      {s.words.length > 0 && (
        <ol className="stage-recap-words">
          {s.words.map((w) => (
            <li key={w.wordId} className={`is-${w.outcome}`}>
              <span className="stage-mark" aria-hidden="true">
                {w.outcome === 'got' ? '✓' : w.outcome === 'pass' ? '↑' : '…'}
              </span>
              {w.word}
              <span className="sr-only">{w.outcome === 'got' ? ', got it' : w.outcome === 'pass' ? ', passed' : ', unfinished'}</span>
              {w.slip && (
                <span className="stage-slip-note">
                  <span className="sr-only">, Tilt slip: </span>
                  {w.slip === 'passed_after_heard' ? 'you said it' : 'not heard'}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="stage-recap-cols">
        <section>
          <h3>Training stats</h3>
          <dl className="stage-dl">
            <div>
              <dt>Reaction lag</dt>
              <dd>{stats?.reactionLagMs != null ? seconds(stats.reactionLagMs) : 'Not measured yet'}</dd>
            </div>
            <div>
              <dt>Words per minute</dt>
              <dd>{stats?.wordsPerMinute != null ? stats.wordsPerMinute.toFixed(1) : 'Not measured yet'}</dd>
            </div>
            <div>
              <dt>Best at {CATEGORIES[s.category].name}</dt>
              <dd>{best ?? s.gotIt}</dd>
            </div>
            <div>
              <dt>Tilt slips</dt>
              <dd>
                {s.passedAfterHeard + s.gotUnheard}
                {s.passedAfterHeard + s.gotUnheard > 0 && (
                  <span className="stage-dd-note"> ({slipSplit(s.passedAfterHeard, s.gotUnheard)})</span>
                )}
                {stats?.tiltSlips != null && (
                  <span className="stage-dd-note">
                    {' '}
                    of {stats.tiltSlips} all time
                    {allTimeSlips && ` (${allTimeSlips})`}
                  </span>
                )}
              </dd>
            </div>
            {stats && stats.mostPassed.length > 0 && (
              <div>
                <dt>Most passed</dt>
                <dd>{stats.mostPassed.map((w) => w.word).join(', ')}</dd>
              </div>
            )}
          </dl>
        </section>
        <section>
          <h3>Under the hood</h3>
          <dl className="stage-dl">
            <div>
              <dt>Word QR read by the camera</dt>
              <dd>
                {s.qrDecoded} of {qrTotal}
                {s.qrDecodeMs !== null && <span className="stage-dd-note"> in {s.qrDecodeMs} ms on average</span>}
              </dd>
            </div>
            <div>
              <dt>New Word to first clue</dt>
              <dd>{s.clueLatencyMs !== null ? `${s.clueLatencyMs} ms on average` : 'Not measured'}</dd>
            </div>
            <div>
              <dt>Tilt nudges</dt>
              <dd>{s.nudges}</dd>
            </div>
            <div>
              <dt>Silence nudges</dt>
              <dd>{s.silenceNudges ?? 0}</dd>
            </div>
            <div>
              <dt>PAL leaks</dt>
              <dd>{s.leaks}</dd>
            </div>
          </dl>
        </section>
      </div>

      <p className="stage-recap-next">Play again or tap Done on your phone.</p>
    </section>
  );
}

/**
 * Clue mode recap: score, Fouls (count and per Word) and the Clue mode Training stats. None of Guess mode's numbers
 * (Reaction lag, Tilt slips, Word QR, leaks, nudges): they don't exist in Clue mode.
 */
function ClueRecap({ snap, s }: { snap: Snapshot; s: RoundSummary }) {
  // snap.stats follows the selected Mode; after switching back to Guess mode they aren't this Round's.
  const stats = snap.stats?.mode === 'clue' ? snap.stats : null;
  const pb = snap.personalBest;
  const best = stats?.bests[s.category];
  const fouls = s.fouls ?? s.words.filter((w) => w.foul).length;

  return (
    <section className="stage-recap" aria-label="Round recap">
      <div className="stage-recap-head">
        <p className="stage-recap-score">
          <span className="stage-num">{s.gotIt}</span>
          <span className="stage-recap-score-unit">got it</span>
        </p>
        <div>
          <h2 className="stage-recap-category">{CATEGORIES[s.category].name}</h2>
          <p className="stage-recap-sub">
            Round {s.index}, {s.passed} passed, {FRIENDS.clue.name} guessing
          </p>
        </div>
        {pb && (
          <div className="sticky stage-pb" style={{ '--tilt': '4deg' } as CSSProperties}>
            <span className="stage-pb-title">New personal best</span>
            <span className="stage-pb-detail">{pb.previous !== null ? `Up from ${pb.previous}` : 'Your first one'}</span>
          </div>
        )}
      </div>

      {s.words.length > 0 && (
        <ol className="stage-recap-words">
          {s.words.map((w) => (
            <li key={w.wordId} className={`is-${w.outcome}`}>
              <span className="stage-mark" aria-hidden="true">
                {w.outcome === 'got' ? '✓' : w.outcome === 'pass' ? '↑' : '…'}
              </span>
              {w.word}
              <span className="sr-only">{w.outcome === 'got' ? ', got it' : w.outcome === 'pass' ? ', passed' : ', unfinished'}</span>
              {w.foul && (
                <span className="stage-foul-note">
                  <span className="sr-only">, </span>Foul
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="stage-recap-cols is-single">
        <section>
          <h3>Training stats, Clue mode</h3>
          <dl className="stage-dl">
            <div>
              <dt>Fouls</dt>
              <dd>
                {fouls}
                {stats && <span className="stage-dd-note"> of {stats.fouls} all time</span>}
              </dd>
            </div>
            <div>
              <dt>Words per minute</dt>
              <dd>{stats?.wordsPerMinute != null ? stats.wordsPerMinute.toFixed(1) : 'Not measured yet'}</dd>
            </div>
            <div>
              <dt>Best at {CATEGORIES[s.category].name}</dt>
              <dd>{best ?? s.gotIt}</dd>
            </div>
            {stats && (
              <div>
                <dt>Clue Rounds played</dt>
                <dd>{stats.roundsPlayed}</dd>
              </div>
            )}
            {stats && stats.mostPassed.length > 0 && (
              <div>
                <dt>Most passed</dt>
                <dd>{stats.mostPassed.map((w) => w.word).join(', ')}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      <p className="stage-recap-next">Play again or tap Done on your phone.</p>
    </section>
  );
}

// ---------- Debug ----------

interface DebugPanelProps {
  debug: DebugState;
  palStatus: string;
  friend: string;
  route: Mode;
  connected: boolean;
}

function DebugPanel({ debug, palStatus, friend, route, connected }: DebugPanelProps) {
  const sw = debug.swap;
  return (
    <aside className="stage-debug" aria-label="Debug panel">
      <dl>
        <div>
          <dt>Room socket</dt>
          <dd>{connected ? 'open' : 'closed'}</dd>
        </div>
        <div>
          <dt>PAL</dt>
          <dd>
            {palStatus} ({friend})
          </dd>
        </div>
        <div>
          <dt>Director</dt>
          <dd>{route === 'clue' ? `clue (reveal: ${REVEAL})` : 'guess'}</dd>
        </div>
        <div>
          <dt>Friend swap</dt>
          <dd>
            {sw
              ? `${FRIENDS[sw.from].name} → ${FRIENDS[sw.to].name}: ${seconds(sw.ms)} to first speech${sw.joinMs !== null ? ` (joined ${seconds(sw.joinMs)})` : ''}`
              : 'not measured'}
          </dd>
        </div>
        <div>
          <dt>Scanner</dt>
          <dd>{debug.engine}</dd>
        </div>
        <div>
          <dt>Last QR</dt>
          <dd>{debug.lastQr ?? 'none'}</dd>
        </div>
      </dl>
      <ol>
        {debug.events.map((e) => (
          <li key={e.id}>
            <strong>{e.type}</strong>
            <pre>{e.json}</pre>
          </li>
        ))}
      </ol>
    </aside>
  );
}
