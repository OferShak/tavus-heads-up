// What the Controller shows, as pure functions of the Snapshot, so Clue mode idleness is covered by unit tests.

import { FRIENDS, type CategoryId, type Mode } from '../../shared/game';
import type { Snapshot } from '../../shared/protocol';
import type { RoomError } from '../lib/useRoom';

/** Absent Mode fields mean Guess mode (Snapshots and summaries from before Clue mode existed). */
export const modeOf = (m: Mode | undefined): Mode => m ?? 'guess';

export type ControllerScreen =
  | 'not_found'
  | 'room_taken'
  | 'closed'
  | 'join'
  | 'reveal'
  | 'joining'
  | 'countdown'
  | 'play'
  | 'clue_countdown'
  | 'clue_play'
  | 'recap'
  | 'lobby';

export interface ViewInput {
  state: Snapshot | null;
  error: RoomError;
  joined: boolean;
  /** A Reveal is on screen (Guess mode, just after a tilt). */
  revealing: boolean;
  /** The wordId already answered: input stays off until the Room sends the next Word. */
  sentFor: string | null;
}

export interface ControllerView {
  screen: ControllerScreen;
  /** Countdown or playing, either Mode: the timer runs. */
  inRound: boolean;
  /** The current Word of a Guess mode Round in play. Always null in Clue mode: the Controller never has the Word. */
  current: { wordId: string; word: string } | null;
  /** The Word the Word QR shows: `current` until it has been answered. */
  qrWordId: string | null;
  /** A tilt (or the tap fallback) may answer the current Word. Only ever true on the Guess mode play screen. */
  canAnswer: boolean;
  /** Keep the screen on: Guess mode Rounds only, where the phone is on the forehead. */
  wakeLock: boolean;
}

export function controllerView({ state, error, joined, revealing, sentFor }: ViewInput): ControllerView {
  const phase = state?.phase;
  const round = state?.round ?? null;
  const inRound = (phase === 'countdown' || phase === 'playing') && !!round;
  const clue = inRound && modeOf(round?.mode) === 'clue';
  const guessRound = inRound && !clue;

  const live = round?.current ?? null;
  const current = guessRound && phase === 'playing' && live ? { wordId: live.wordId, word: live.word } : null;
  const qrWordId = current && current.wordId !== sentFor ? current.wordId : null;

  let screen: ControllerScreen;
  if (error === 'not_found') screen = 'not_found';
  else if (error === 'room_taken') screen = 'room_taken';
  else if (error === 'room_closed' || phase === 'closed') screen = 'closed';
  else if (!joined) screen = 'join';
  else if (revealing && !clue) screen = 'reveal';
  else if (!state) screen = 'joining';
  else if (phase === 'countdown' && round) screen = clue ? 'clue_countdown' : 'countdown';
  else if (phase === 'playing' && round) screen = clue ? 'clue_play' : 'play';
  else if (phase === 'recap' && state.lastSummary) screen = 'recap';
  else screen = 'lobby';

  return {
    screen,
    inRound,
    current,
    qrWordId,
    canAnswer: screen === 'play' && !!qrWordId && !revealing,
    wakeLock: guessRound,
  };
}

export type PalNotice = 'no_stage' | 'joining' | 'busy' | 'ended' | 'error' | 'offline' | null;

export interface PalGate {
  /** Mirrors canStartRound in shared/room.ts: the selected Mode's friend is ready in the call, or playing without the PAL. */
  canStart: boolean;
  notice: PalNotice;
  /** The friend the notice is about. */
  friend: string;
}

/** Whether a Round can start from the lobby / recap, and what to tell the Player about their friend and the Stage. */
export function palGate(state: Snapshot): PalGate {
  const { status } = state.pal;
  const selected = modeOf(state.mode);
  const inCall = modeOf(state.pal.mode);
  const swapping = status === 'ready' && inCall !== selected;
  const canStart = status === 'offline' || (status === 'ready' && !swapping);

  let notice: PalNotice = null;
  if (!state.stageConnected) notice = 'no_stage';
  else if (status === 'idle' || status === 'starting' || status === 'joining' || swapping) notice = 'joining';
  else if (status === 'busy' || status === 'ended' || status === 'error' || status === 'offline') notice = status;

  // 'ended': the friend who was in the call left; otherwise it's about the friend the selected Mode needs.
  const friend = FRIENDS[notice === 'ended' ? inCall : selected].name;
  return { canStart, notice, friend };
}

/** Category bests for the selected Mode: the Room sends that Mode's Training stats. */
export function bestsFor(state: Snapshot): Partial<Record<CategoryId, number>> {
  const stats = state.stats;
  return stats && stats.mode === modeOf(state.mode) ? stats.bests : {};
}

/** The Mode choices, worded by who does what. */
export const MODE_CHOICES: { mode: Mode; you: string; friend: string }[] = [
  { mode: 'guess', you: 'You guess', friend: `${FRIENDS.guess.name} gives Clues` },
  { mode: 'clue', you: 'You give Clues', friend: `${FRIENDS.clue.name} guesses` },
];
