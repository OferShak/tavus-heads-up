// The Stage: the laptop/TV screen. Shows the Join QR, runs the PAL call, decodes the Word QR from the
// camera and drives the PAL through the PalDirector. It never displays the current Word.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { CATEGORIES, ROUND_MS } from '../../shared/game';
import type { ClientMsg, RoomEvent, Snapshot } from '../../shared/protocol';
import { Qr } from '../lib/Qr';
import { secondsLeft, useRoom, useTick } from '../lib/useRoom';
import { PalDirector, type TavusEvent } from './director';
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
  const [director] = useState(
    () =>
      new PalDirector({
        interact: (t, p) => io.current.interact(t, p),
        report: (m) => io.current.report(m),
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (id) => window.clearTimeout(id as number),
        reactions: REACTIONS,
      }),
  );
  useEffect(() => () => director.dispose(), [director]);

  const [debug, setDebug] = useState<DebugState>({ events: [], engine: 'loading', lastQr: null });
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
  director: PalDirector;
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
        setDebug((d) => ({
          ...d,
          events: [{ id: Date.now() + Math.random(), type, json: JSON.stringify(data, null, 1) }, ...d.events].slice(0, DEBUG_EVENTS),
        }));
      }
      if (data && typeof data === 'object') director.onTavusEvent(data as TavusEvent);
    },
    onPalJoined: () => {
      roomSend({ t: 'pal', status: 'joined' });
      director.onPalJoined();
    },
    onPalLeft: () => {
      director.setLive(false);
      roomSend({ t: 'pal', status: 'left' });
    },
    onError: (error) => {
      director.setLive(false);
      roomSend({ t: 'pal', status: 'error', error });
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
    if (pal?.status === 'joining' && call.view.present) roomSend({ t: 'pal', status: 'joined' });
  }, [pal?.status, call.view.present, roomSend]);

  // ----- Word QR scanner -----
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const playing = phase === 'playing';
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
    screen = <Game snap={snap} clockOffset={room.clockOffset} palVideo={call.view.video} selfView={selfView} cameraError={camera.error} />;
  }

  return (
    <>
      {screen}
      <PalAudio track={call.view.audio} />
      {DEBUG && <DebugPanel debug={debug} palStatus={pal?.status ?? 'none'} connected={room.connected} />}
    </>
  );
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
}

function Game({ snap, clockOffset, palVideo, selfView, cameraError }: GameProps) {
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
          <section className="stage-hero" aria-label="Your PAL">
            <TrackVideo track={pal.status === 'ready' ? palVideo : null} className="stage-pal-video" />
            <PalPanel snap={snap} hasVideo={palVideo !== null} />
            {countdown !== null && (
              <div className="stage-countdown" aria-live="assertive">
                <span key={countdown} className="stage-num">
                  {countdown}
                </span>
              </div>
            )}
            {heard && (
              <p className="stage-heard" role="status">
                Heard it
              </p>
            )}
            <div className="stage-pip">
              {cameraError ? <p className="stage-pip-error">Camera off</p> : selfView}
            </div>
          </section>
        </div>
        {recap && <Recap snap={snap} />}
      </main>
    </div>
  );
}

/** What sits on the hero when the PAL video isn't the whole story. */
function PalPanel({ snap, hasVideo }: { snap: Snapshot; hasVideo: boolean }) {
  const { pal, phase } = snap;
  let title: string | null = null;
  let detail: string | null = null;
  let note: string | null = null;
  let tone = '';
  switch (pal.status) {
    case 'idle':
    case 'starting':
    case 'joining':
      title = 'Your PAL is joining…';
      break;
    case 'ready':
      if (!hasVideo) title = 'Your PAL is joining…';
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

function Recap({ snap }: { snap: Snapshot }) {
  const s = snap.lastSummary;
  if (!s) return null;
  const stats = snap.stats;
  const pb = snap.personalBest;
  const best = stats?.bests[s.category];
  const qrTotal = s.qrDecoded + s.qrFallback;

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
                {stats?.tiltSlips != null && <span className="stage-dd-note"> of {stats.tiltSlips} all time</span>}
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

// ---------- Debug ----------

function DebugPanel({ debug, palStatus, connected }: { debug: DebugState; palStatus: string; connected: boolean }) {
  return (
    <aside className="stage-debug" aria-label="Debug panel">
      <dl>
        <div>
          <dt>Room socket</dt>
          <dd>{connected ? 'open' : 'closed'}</dd>
        </div>
        <div>
          <dt>PAL</dt>
          <dd>{palStatus}</dd>
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
