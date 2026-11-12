// WebSocket messages between the Room DO and its two clients.

import type { CategoryId, Mode, Outcome, Who } from './game';
import type { DecodeSource, PalStatus, Phase, RoundSummary, WordResult } from './room';

export type Role = 'stage' | 'controller';

export type ClientMsg =
  | { t: 'hello'; role: 'stage' }
  | { t: 'hello'; role: 'controller'; playerId: string; nickname?: string }
  | { t: 'start'; category: CategoryId }
  // Controller: pick the Mode for the next Round (lobby / recap only).
  | { t: 'mode'; mode: Mode }
  | { t: 'tilt'; wordId: string; outcome: Outcome; via: 'tilt' | 'tap' }
  | { t: 'done' }
  | { t: 'reconnect_pal' }
  // Stage-only reports
  // conversationId: the call this report is about; a report about a call swapped out since is ignored.
  | { t: 'pal'; status: 'joined' | 'left' | 'error'; error?: string; conversationId?: string }
  | { t: 'heard'; wordId: string }
  | { t: 'decoded'; wordId: string; source: DecodeSource }
  | { t: 'clue_latency'; wordId: string; ms: number }
  | { t: 'leak'; wordId: string }
  | { t: 'nudge'; wordId: string }
  | { t: 'silence_nudge'; wordId: string }
  // Stage-only, Clue mode: the PAL's tilt tool call, and transcribed speech for the Foul rule.
  | { t: 'pal_tilt'; wordId: string; outcome: Outcome }
  | { t: 'said'; wordId: string; who: Who; text: string };

/**
 * Training stats for one Mode (CONTEXT.md "Training stats"). Clue mode: reactionLagMs is null and the Tilt slip counts
 * are 0. Guess mode: fouls is 0.
 */
export interface PlayerSummary {
  /** Which Mode these stats are for. */
  mode: Mode;
  nickname: string;
  roundsPlayed: number;
  bests: Partial<Record<CategoryId, number>>;
  wordsPerMinute: number | null;
  reactionLagMs: number | null;
  mostPassed: { word: string; passes: number }[];
  /** Lifetime Tilt slips (Pass after Heard it + Got it never heard). */
  tiltSlips: number;
  /** Lifetime Tilt slips that were a Pass after Heard it. */
  passedAfterHeard: number;
  /** Lifetime Tilt slips that were a Got it the PAL never heard. With passedAfterHeard, at most tiltSlips: slips from before the split was tracked (beyond the last 50 Rounds) can't be attributed. */
  gotUnheard: number;
  /** Lifetime Fouls (Clue mode only). */
  fouls: number;
}

/**
 * Role-filtered snapshot of the Room. In Guess mode the current Word goes to both: the Controller renders it as the
 * Word QR, the Stage needs it for the fallback injection and the leak guard (it never displays it). In Clue mode
 * only the Stage gets it (shown on the PAL forehead); the Worker's role filter hides it from the idle Controller.
 */
export interface Snapshot {
  code: string;
  phase: Phase;
  /** The Mode the next Round will use. Absent: Guess mode. */
  mode?: Mode;
  serverNow: number;
  player: { nickname: string } | null;
  stageConnected: boolean;
  controllerConnected: boolean;
  /** mode: which Mode's friend is in the call (absent: the Guess mode PAL). */
  pal: { status: PalStatus; error?: string; conversationId?: string; conversationUrl?: string; mode?: Mode };
  round: {
    index: number;
    category: CategoryId;
    /** Absent: Guess mode. */
    mode?: Mode;
    startsAt: number;
    endsAt: number;
    current: { wordId: string; word: string; position: number; shownAt: number; heardAt?: number } | null;
    gotIt: number;
    passed: number;
  } | null;
  lastSummary: RoundSummary | null;
  /** Training stats for the Room's selected Mode. */
  stats: PlayerSummary | null;
  /** Set when this Round ended with a new personal best for its Category. */
  personalBest: { category: CategoryId; score: number; previous: number | null } | null;
}

/**
 * tilt: the Reveal. In Clue mode the Stage passes `foul` along with the Reveal to the PAL. `by` absent: the Player.
 * A Foul spoken just after the tilt is not in this event (it still reaches the recap).
 */
export type RoomEvent =
  | { kind: 'tilt'; result: Pick<WordResult, 'wordId' | 'word' | 'outcome' | 'heardAt' | 'tiltAt' | 'foul'> & Partial<Pick<WordResult, 'by'>> }
  | { kind: 'round_start' }
  | { kind: 'round_end' }
  | { kind: 'player_joined' };

export type ServerMsg =
  | { t: 'state'; state: Snapshot; event?: RoomEvent }
  | { t: 'error'; code: 'room_taken' | 'room_closed' | 'bad_message' | 'not_found'; message: string };

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && typeof m.t === 'string' ? (m as ClientMsg) : null;
  } catch {
    return null;
  }
}
