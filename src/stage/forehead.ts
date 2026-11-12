// The PAL forehead (Clue mode): the phone drawn on the PAL's head, its screen showing the Word to the Player.
// Pure state machine with time passed in, so it is tested without timers or a DOM; usePalForehead owns the timers.
//
// It answers a PAL tilt at once (tip + flash), before the Room accepts it, like the Controller in Guess mode, and
// guards tilts the same way: one per Word, none during the flash, unlocked again if the Room never moves on.

import { REVEAL_MS, TILT_UNLOCK_MS, type Outcome } from '../../shared/game';

export interface ForeheadWord {
  wordId: string;
  word: string;
}

export type ForeheadEvent =
  /** Countdown second (3, 2, 1): the phone comes up. */
  | { type: 'countdown'; n: number }
  /** The Room's current Word. */
  | ({ type: 'word' } & ForeheadWord)
  /** The PAL's tilt tool call. */
  | { type: 'tilt'; outcome: Outcome }
  /** The Round ended (the Room moved to the recap). */
  | { type: 'timesUp' }
  /** No Round: lobby, waiting, closed. */
  | { type: 'hide' }
  /** Clock tick: lets timed transitions happen (see nextForeheadDeadline). */
  | { type: 'tick' };

type Mode = 'hidden' | 'countdown' | 'playing' | 'timesUp';

/** A PAL tilt the Room hasn't answered with a new Word yet. Its flash shows while it is pending. */
interface PendingTilt extends ForeheadWord {
  outcome: Outcome;
  at: number;
}

export interface ForeheadState {
  mode: Mode;
  count: number;
  current: ForeheadWord | null;
  tilt: PendingTilt | null;
  /** When "Time's up" comes on screen: right away, or once a running flash has finished. */
  timesUpAt: number;
}

export const INITIAL_FOREHEAD: ForeheadState = { mode: 'hidden', count: 0, current: null, tilt: null, timesUpAt: 0 };

export type ForeheadScreen =
  | { kind: 'hidden' }
  | { kind: 'countdown'; n: number }
  | { kind: 'word'; word: string }
  | { kind: 'flash'; outcome: Outcome; word: string }
  | { kind: 'timesUp' };

/** upright on the head; forward = screen toward the floor (Got it); back = screen toward the ceiling (Pass). */
export type ForeheadTip = 'upright' | 'forward' | 'back';

export interface ForeheadView {
  screen: ForeheadScreen;
  tip: ForeheadTip;
}

export interface ForeheadStep {
  state: ForeheadState;
  /** Set when a PAL tilt was accepted: the caller sends it to the Room. */
  forward: { wordId: string; outcome: Outcome } | null;
}

const same = (state: ForeheadState): ForeheadStep => ({ state, forward: null });

/** One event at time `now` (ms, any clock as long as it is the same one throughout). */
export function foreheadStep(s: ForeheadState, e: ForeheadEvent, now: number): ForeheadStep {
  switch (e.type) {
    case 'countdown':
      return same({ ...INITIAL_FOREHEAD, mode: 'countdown', count: e.n });
    case 'word':
      // Hidden → playing too: a Stage that (re)joins mid-Round puts the phone straight up.
      if (s.mode === 'timesUp') return same(s);
      return same(settle({ ...s, mode: 'playing', current: { wordId: e.wordId, word: e.word } }, now));
    case 'tilt': {
      s = settle(s, now);
      const cur = s.current;
      // One tilt per Word: a pending tilt (its flash, or the Room not having moved on yet) blocks the next.
      if (s.mode !== 'playing' || !cur || s.tilt) return same(s);
      return {
        state: { ...s, tilt: { ...cur, outcome: e.outcome, at: now } },
        forward: { wordId: cur.wordId, outcome: e.outcome },
      };
    }
    case 'timesUp': {
      if (s.mode === 'hidden' || s.mode === 'timesUp') return same(s);
      s = settle(s, now);
      const timesUpAt = s.tilt ? Math.max(now, s.tilt.at + REVEAL_MS) : now;
      return same(settle({ ...s, mode: 'timesUp', timesUpAt }, now));
    }
    case 'hide':
      return same(INITIAL_FOREHEAD);
    case 'tick':
      return same(settle(s, now));
  }
}

/**
 * Applies the timed transitions due by `now`.
 * A pending tilt ends once its flash has shown for REVEAL_MS and the Room has moved on to a new Word; if the Room
 * hasn't moved on by TILT_UNLOCK_MS the tilt was lost, so the same Word comes back and can be tilted again.
 * After time's up no next Word comes, so the flash just finishes; "Time's up" then shows for REVEAL_MS.
 */
function settle(s: ForeheadState, now: number): ForeheadState {
  const t = s.tilt;
  if (t) {
    const flashDone = now >= t.at + REVEAL_MS;
    const answered = s.mode === 'timesUp' || s.current?.wordId !== t.wordId;
    const lost = now >= t.at + TILT_UNLOCK_MS;
    if (!((flashDone && answered) || lost)) return s;
    s = { ...s, tilt: null };
  }
  if (s.mode === 'timesUp' && now >= s.timesUpAt + REVEAL_MS) return INITIAL_FOREHEAD;
  return s;
}

/** The next time after `now` a tick could change the state, or null if nothing is timed. */
export function nextForeheadDeadline(s: ForeheadState, now: number): number | null {
  const times: number[] = [];
  if (s.tilt) times.push(s.tilt.at + REVEAL_MS, s.tilt.at + TILT_UNLOCK_MS);
  if (s.mode === 'timesUp') times.push(s.timesUpAt, s.timesUpAt + REVEAL_MS);
  const future = times.filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}

/** What the phone shows and how it is tipped. */
export function foreheadView(s: ForeheadState): ForeheadView {
  if (s.mode === 'countdown') return { screen: { kind: 'countdown', n: s.count }, tip: 'upright' };
  if (s.tilt) {
    const { outcome, word } = s.tilt;
    return { screen: { kind: 'flash', outcome, word }, tip: outcome === 'got' ? 'forward' : 'back' };
  }
  if (s.mode === 'timesUp') return { screen: { kind: 'timesUp' }, tip: 'upright' };
  if (s.mode === 'playing' && s.current) return { screen: { kind: 'word', word: s.current.word }, tip: 'upright' };
  return { screen: { kind: 'hidden' }, tip: 'upright' };
}
