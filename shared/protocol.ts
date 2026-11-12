// WebSocket messages between the Room DO and its two clients.

import type { CategoryId, Outcome } from './game';
import type { DecodeSource, PalStatus, Phase, RoundSummary, WordResult } from './room';

export type Role = 'stage' | 'controller';

export type ClientMsg =
  | { t: 'hello'; role: 'stage' }
  | { t: 'hello'; role: 'controller'; playerId: string; nickname?: string }
  | { t: 'start'; category: CategoryId }
  | { t: 'tilt'; wordId: string; outcome: Outcome; via: 'tilt' | 'tap' }
  | { t: 'done' }
  | { t: 'reconnect_pal' }
  // Stage-only reports
  | { t: 'pal'; status: 'joined' | 'left' | 'error'; error?: string }
  | { t: 'heard'; wordId: string }
  | { t: 'decoded'; wordId: string; source: DecodeSource }
  | { t: 'clue_latency'; wordId: string; ms: number }
  | { t: 'leak'; wordId: string }
  | { t: 'nudge'; wordId: string };

export interface PlayerSummary {
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
}

/** Role-filtered snapshot of the Room. The current Word goes to both: the Controller renders it as the Word QR, the Stage needs it for the fallback injection and the leak guard (it never displays it). */
export interface Snapshot {
  code: string;
  phase: Phase;
  serverNow: number;
  player: { nickname: string } | null;
  stageConnected: boolean;
  controllerConnected: boolean;
  pal: { status: PalStatus; error?: string; conversationId?: string; conversationUrl?: string };
  round: {
    index: number;
    category: CategoryId;
    startsAt: number;
    endsAt: number;
    current: { wordId: string; word: string; position: number; shownAt: number; heardAt?: number } | null;
    gotIt: number;
    passed: number;
  } | null;
  lastSummary: RoundSummary | null;
  stats: PlayerSummary | null;
  /** Set when this Round ended with a new personal best for its Category. */
  personalBest: { category: CategoryId; score: number; previous: number | null } | null;
}

export type RoomEvent =
  | { kind: 'tilt'; result: Pick<WordResult, 'wordId' | 'word' | 'outcome' | 'heardAt' | 'tiltAt'> }
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
