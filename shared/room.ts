// Pure Room logic: the Room Durable Object is a thin shell around these transitions (ADR 0002).
// Every function returns a new state; nothing here touches sockets, storage or the clock.

import { judgeSaid } from './foul';
import { COUNTDOWN_MS, FREEZE_NUDGES, ROUND_MS, type CategoryId, type Mode, type Outcome, type Who, type Word } from './game';

export type Phase = 'waiting' | 'lobby' | 'countdown' | 'playing' | 'recap' | 'closed';

/**
 * idle: no conversation yet · starting: Worker is creating it · joining: Stage is joining the call
 * ready: PAL is in the call · busy: concurrency cap hit · ended · error
 * offline: Rounds run without a PAL: Tavus test mode, or no key / Guess PAL id (the Stage gates that case; tests use it)
 */
export type PalStatus = 'idle' | 'starting' | 'joining' | 'ready' | 'busy' | 'offline' | 'ended' | 'error';

export interface PalState {
  status: PalStatus;
  conversationId?: string;
  conversationUrl?: string;
  startedAt?: number;
  error?: string;
  /** Which Mode's friend this conversation is (ADR 0004: one PAL per Mode). Absent: the Guess mode PAL. */
  mode?: Mode;
}

export type DecodeSource = 'qr' | 'fallback';

export interface CurrentWord {
  wordId: string;
  word: string;
  level: Word['level'];
  /** Position within the Round (0-based). */
  position: number;
  shownAt: number;
  /** Heard it: the PAL's word_guessed tool call. Feeds Reaction lag only. */
  heardAt?: number;
  decodedAt?: number;
  decodeSource?: DecodeSource;
  /** Stage → PAL injection to first PAL speech, measured by the Stage. */
  clueLatencyMs?: number;
  leaked?: boolean;
  nudges?: number;
  /** Silence nudges: fresh Clues the PAL gave because the Player went quiet (Guess mode). */
  silenceNudges?: number;
  /** Clue mode: when the PAL's own speech first said the Word (its guess). */
  palSaidAt?: number;
  /** Clue mode Foul: the Player's speech said the Word before the PAL had. */
  foul?: true;
}

export interface WordResult extends CurrentWord {
  outcome: Outcome;
  tiltAt: number;
  /** Who tilted: the Player (Controller) in Guess mode, the PAL (PAL tilt) in Clue mode. */
  by: Who;
  /** Whether the PAL was in the call at tilt time. A Got it can only be "unheard" if the PAL was listening. */
  palReady?: boolean;
}

/** A tilt that disagrees with Heard it. The tilt still scores; the PAL calls the slip out. */
export type TiltSlip = 'passed_after_heard' | 'got_unheard';

export interface RoundState {
  index: number;
  category: CategoryId;
  mode: Mode;
  startsAt: number;
  endsAt: number;
  current: CurrentWord | null;
  results: WordResult[];
}

/**
 * Clue Rounds count Fouls; Tilt slips, Heard it, Reaction lag, QR, clue latency, leaks and nudges are Guess mode
 * numbers and stay zero (or null) there.
 */
export interface RoundSummary {
  index: number;
  category: CategoryId;
  /** Always set by summarize; absent on summaries stored before Clue mode existed (Guess mode). */
  mode?: Mode;
  gotIt: number;
  passed: number;
  /** freeze: the Word took FREEZE_NUDGES or more Silence nudges. foul: Clue mode Foul. */
  words: { wordId: string; word: string; outcome: Outcome | 'unfinished'; slip?: TiltSlip; freeze?: true; foul?: true }[];
  /** Clue mode only: Words fouled, including an unfinished one. */
  fouls?: number;
  /** Mean Heard it → Got it tilt, over Words the PAL heard. */
  reactionLagMs: number | null;
  heardCount: number;
  qrDecoded: number;
  qrFallback: number;
  qrDecodeMs: number | null;
  clueLatencyMs: number | null;
  leaks: number;
  nudges: number;
  silenceNudges: number;
  /** Tilt slips: Pass on a Word the PAL had heard. */
  passedAfterHeard: number;
  /** Tilt slips: Got it on a Word the PAL never heard (only while the PAL was in the call). */
  gotUnheard: number;
}

export interface Player {
  playerId: string;
  nickname: string;
}

export interface RoomState {
  code: string;
  phase: Phase;
  createdAt: number;
  player: Player | null;
  /** The Mode the next Round will use; picked in the lobby or recap. */
  mode: Mode;
  pal: PalState;
  /** Word ids drawn in this Room: no repeats within a Room. */
  used: string[];
  roundsPlayed: number;
  round: RoundState | null;
  lastSummary: RoundSummary | null;
}

export type Draw = (position: number, used: ReadonlySet<string>) => Word;

export function createRoom(code: string, now: number): RoomState {
  return {
    code,
    phase: 'waiting',
    createdAt: now,
    player: null,
    mode: 'guess',
    pal: { status: 'idle' },
    used: [],
    roundsPlayed: 0,
    round: null,
    lastSummary: null,
  };
}

export type JoinResult = { ok: true; state: RoomState } | { ok: false; reason: 'room_taken' | 'room_closed' };

/** One Player per Room. The same phone can reconnect; a different one is turned away. */
export function joinController(s: RoomState, player: Player): JoinResult {
  if (s.phase === 'closed') return { ok: false, reason: 'room_closed' };
  if (s.player && s.player.playerId !== player.playerId) return { ok: false, reason: 'room_taken' };
  return {
    ok: true,
    state: { ...s, player, phase: s.phase === 'waiting' ? 'lobby' : s.phase },
  };
}

export function setPal(s: RoomState, pal: PalState): RoomState {
  return { ...s, pal };
}

const betweenRounds = (s: RoomState) => s.phase === 'lobby' || s.phase === 'recap';

/** Pick the Mode for the next Round. Only between Rounds; the Worker swaps the PAL when it changes (ADR 0004). */
export function selectMode(s: RoomState, mode: Mode): RoomState {
  if (!betweenRounds(s) || s.mode === mode) return s;
  return { ...s, mode };
}

/** A Round starts only with the selected Mode's friend in the call (or with no PAL at all in UI-only dev). */
export function canStartRound(s: RoomState): boolean {
  if (!betweenRounds(s)) return false;
  if (s.pal.status === 'offline') return true;
  return s.pal.status === 'ready' && (s.pal.mode ?? 'guess') === s.mode;
}

export function startRound(s: RoomState, category: CategoryId, now: number): RoomState {
  if (!canStartRound(s)) return s;
  const startsAt = now + COUNTDOWN_MS;
  return {
    ...s,
    phase: 'countdown',
    round: {
      index: s.roundsPlayed + 1,
      category,
      mode: s.mode,
      startsAt,
      endsAt: startsAt + ROUND_MS,
      current: null,
      results: [],
    },
  };
}

function nextWord(s: RoomState, position: number, now: number, draw: Draw): { current: CurrentWord; used: string[] } {
  const w = draw(position, new Set(s.used));
  return {
    current: { wordId: w.id, word: w.word, level: w.level, position, shownAt: now },
    used: [...s.used, w.id],
  };
}

export function beginPlay(s: RoomState, now: number, draw: Draw): RoomState {
  if (s.phase !== 'countdown' || !s.round) return s;
  const { current, used } = nextWord(s, 0, now, draw);
  return { ...s, phase: 'playing', used, round: { ...s.round, current } };
}

export type TiltResult = { accepted: true; state: RoomState; result: WordResult } | { accepted: false; state: RoomState };

/** Whoever guesses tilts: the Player in Guess mode, the PAL in Clue mode. */
const tilterOf = (mode: Mode): Who => (mode === 'clue' ? 'pal' : 'player');

/**
 * Only a tilt scores, and only from whoever is guessing (`by`; defaults to the Player, Guess mode). The first tilt
 * for the current wordId wins; stale or duplicate ones are ignored, which removes any race between the phone and
 * the PAL.
 */
export function applyTilt(s: RoomState, wordId: string, outcome: Outcome, now: number, draw: Draw, by: Who = 'player'): TiltResult {
  const round = s.round;
  if (s.phase !== 'playing' || !round?.current || round.current.wordId !== wordId || now >= round.endsAt || by !== tilterOf(round.mode)) {
    return { accepted: false, state: s };
  }
  const result: WordResult = { ...round.current, outcome, tiltAt: now, by, palReady: s.pal.status === 'ready' };
  const { current, used } = nextWord(s, round.current.position + 1, now, draw);
  return {
    accepted: true,
    result,
    state: { ...s, used, round: { ...round, current, results: [...round.results, result] } },
  };
}

function updateCurrent(s: RoomState, wordId: string, f: (c: CurrentWord) => CurrentWord): RoomState {
  const c = s.round?.current;
  if (s.phase !== 'playing' || !c || c.wordId !== wordId) return s;
  const next = f(c);
  return next === c ? s : { ...s, round: { ...s.round!, current: next } };
}

/**
 * Heard it: the PAL's tool call. Never scores; starts the Reaction lag clock. First call wins.
 * The tool call can land just after the tilt (before the next Word reached the PAL), so a late Heard it for
 * the Word just tilted is recorded on its result. It can only turn a Pass into a Tilt slip; Reaction lag
 * ignores it (heardAt > tiltAt).
 */
export function markHeard(s: RoomState, wordId: string, now: number): RoomState {
  return updateCurrentOrJustTilted(s, wordId, (w) => (w.heardAt !== undefined ? w : { ...w, heardAt: now }));
}

/**
 * Apply f to the current Word, or to the Word just tilted (the last result) when a report for it lands after the
 * tilt, before the next Word reached the PAL. Older Words are closed.
 */
function updateCurrentOrJustTilted(s: RoomState, wordId: string, f: <W extends CurrentWord>(w: W) => W): RoomState {
  const next = updateCurrent(s, wordId, f);
  if (next !== s || s.phase !== 'playing' || !s.round || s.round.current?.wordId === wordId) return next;
  const results = s.round.results;
  const last = results[results.length - 1];
  if (!last || last.wordId !== wordId) return s;
  const updated = f(last);
  return updated === last ? s : { ...s, round: { ...s.round, results: [...results.slice(0, -1), updated] } };
}

/**
 * Clue mode: a transcribed utterance from the Player or the PAL (Foul rule in shared/foul.ts). PAL speech that says
 * the Word records palSaidAt (first wins); Player speech that says it before then fouls the Word. Like markHeard,
 * an utterance landing just after the tilt is recorded on the Word just tilted (recap and stats; its Reveal may
 * already be gone). Ignored in Guess Rounds.
 */
export function markSaid(s: RoomState, wordId: string, who: Who, text: string, now: number): RoomState {
  if (s.round?.mode !== 'clue') return s;
  return updateCurrentOrJustTilted(s, wordId, (w) => {
    const verdict = judgeSaid(w.word, who, text, w.palSaidAt !== undefined);
    if (verdict === 'pal_said' && w.palSaidAt === undefined) return { ...w, palSaidAt: now };
    if (verdict === 'foul' && !w.foul) return { ...w, foul: true };
    return w;
  });
}

export function markDecoded(s: RoomState, wordId: string, source: DecodeSource, now: number): RoomState {
  return updateCurrent(s, wordId, (c) => (c.decodeSource ? c : { ...c, decodedAt: now, decodeSource: source }));
}

export function markClueLatency(s: RoomState, wordId: string, ms: number): RoomState {
  return updateCurrent(s, wordId, (c) => (c.clueLatencyMs !== undefined ? c : { ...c, clueLatencyMs: Math.max(0, ms) }));
}

export function markLeak(s: RoomState, wordId: string): RoomState {
  return updateCurrent(s, wordId, (c) => (c.leaked ? c : { ...c, leaked: true }));
}

export function markNudge(s: RoomState, wordId: string): RoomState {
  return updateCurrent(s, wordId, (c) => ({ ...c, nudges: (c.nudges ?? 0) + 1 }));
}

export function markSilenceNudge(s: RoomState, wordId: string): RoomState {
  return updateCurrent(s, wordId, (c) => ({ ...c, silenceNudges: (c.silenceNudges ?? 0) + 1 }));
}

const freezeOf = (w: CurrentWord) => ((w.silenceNudges ?? 0) >= FREEZE_NUDGES ? { freeze: true as const } : {});
const foulOf = (w: CurrentWord) => (w.foul ? { foul: true as const } : {});

function slipOf(r: WordResult): TiltSlip | undefined {
  if (r.outcome === 'pass' && r.heardAt !== undefined) return 'passed_after_heard';
  if (r.outcome === 'got' && r.heardAt === undefined && r.palReady) return 'got_unheard';
  return undefined;
}

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function summarize(round: RoundState): RoundSummary {
  return round.mode === 'clue' ? summarizeClue(round) : summarizeGuess(round);
}

function summarizeClue(round: RoundState): RoundSummary {
  const all: CurrentWord[] = [...round.results, ...(round.current ? [round.current] : [])];
  const gotIt = round.results.filter((r) => r.outcome === 'got').length;
  return {
    index: round.index,
    category: round.category,
    mode: 'clue',
    gotIt,
    passed: round.results.length - gotIt,
    words: [
      ...round.results.map((r) => ({ wordId: r.wordId, word: r.word, outcome: r.outcome, ...foulOf(r) })),
      ...(round.current ? [{ wordId: round.current.wordId, word: round.current.word, outcome: 'unfinished' as const, ...foulOf(round.current) }] : []),
    ],
    fouls: all.filter((w) => w.foul).length,
    reactionLagMs: null,
    heardCount: 0,
    qrDecoded: 0,
    qrFallback: 0,
    qrDecodeMs: null,
    clueLatencyMs: null,
    leaks: 0,
    nudges: 0,
    silenceNudges: 0,
    passedAfterHeard: 0,
    gotUnheard: 0,
  };
}

function summarizeGuess(round: RoundState): RoundSummary {
  const all: CurrentWord[] = [...round.results, ...(round.current ? [round.current] : [])];
  const got = round.results.filter((r) => r.outcome === 'got');
  const lags = got.filter((r) => r.heardAt !== undefined && r.tiltAt >= r.heardAt).map((r) => r.tiltAt - r.heardAt!);
  const qr = all.filter((w) => w.decodeSource === 'qr');
  const slips = round.results.map(slipOf);
  return {
    index: round.index,
    category: round.category,
    mode: 'guess',
    gotIt: got.length,
    passed: round.results.length - got.length,
    words: [
      ...round.results.map((r, i) => ({
        wordId: r.wordId,
        word: r.word,
        outcome: r.outcome,
        ...(slips[i] ? { slip: slips[i] } : {}),
        ...freezeOf(r),
      })),
      ...(round.current
        ? [{ wordId: round.current.wordId, word: round.current.word, outcome: 'unfinished' as const, ...freezeOf(round.current) }]
        : []),
    ],
    reactionLagMs: mean(lags),
    heardCount: all.filter((w) => w.heardAt !== undefined).length,
    qrDecoded: qr.length,
    qrFallback: all.filter((w) => w.decodeSource === 'fallback').length,
    qrDecodeMs: mean(qr.map((w) => w.decodedAt! - w.shownAt)),
    clueLatencyMs: mean(all.flatMap((w) => (w.clueLatencyMs !== undefined ? [w.clueLatencyMs] : []))),
    leaks: all.filter((w) => w.leaked).length,
    nudges: all.reduce((n, w) => n + (w.nudges ?? 0), 0),
    silenceNudges: all.reduce((n, w) => n + (w.silenceNudges ?? 0), 0),
    passedAfterHeard: slips.filter((x) => x === 'passed_after_heard').length,
    gotUnheard: slips.filter((x) => x === 'got_unheard').length,
  };
}

export function endRound(s: RoomState): RoomState {
  if ((s.phase !== 'playing' && s.phase !== 'countdown') || !s.round) return s;
  return {
    ...s,
    phase: 'recap',
    roundsPlayed: s.roundsPlayed + 1,
    lastSummary: summarize(s.round),
    round: { ...s.round, current: null },
  };
}

export function closeRoom(s: RoomState): RoomState {
  return { ...s, phase: 'closed', round: s.round ? { ...s.round, current: null } : null };
}

/** When the Room's single alarm should next fire. */
export function nextAlarmAt(s: RoomState): number | null {
  if (s.phase === 'countdown' && s.round) return s.round.startsAt;
  if (s.phase === 'playing' && s.round) return s.round.endsAt;
  return null;
}
