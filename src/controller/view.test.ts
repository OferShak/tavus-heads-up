import { describe, expect, it } from 'vitest';
import type { Mode } from '../../shared/game';
import type { PlayerSummary, Snapshot } from '../../shared/protocol';
import type { RoundSummary } from '../../shared/room';
import { bestsFor, controllerView, palGate, type ViewInput } from './view';

const WORD = { wordId: 'w1', word: 'giraffe', position: 0, shownAt: 1_000 };

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    code: 'ABCD',
    phase: 'lobby',
    serverNow: 0,
    player: { nickname: 'Ofer' },
    stageConnected: true,
    controllerConnected: true,
    pal: { status: 'ready' },
    round: null,
    lastSummary: null,
    stats: null,
    personalBest: null,
    ...over,
  };
}

function inRound(phase: 'countdown' | 'playing', mode?: Mode): Snapshot {
  return snap({
    phase,
    mode,
    round: { index: 1, category: 'animals', mode, startsAt: 0, endsAt: 60_000, current: phase === 'playing' ? WORD : null, gotIt: 2, passed: 1 },
  });
}

const view = (state: Snapshot | null, over: Partial<ViewInput> = {}) =>
  controllerView({ state, error: null, joined: true, revealing: false, sentFor: null, ...over });

describe('controllerView', () => {
  describe('Guess mode (unchanged)', () => {
    it('shows the Word QR and arms tilts while playing', () => {
      for (const mode of [undefined, 'guess'] as const) {
        const v = view(inRound('playing', mode));
        expect(v).toMatchObject({ screen: 'play', qrWordId: 'w1', canAnswer: true, wakeLock: true, inRound: true });
        expect(v.current).toEqual({ wordId: 'w1', word: 'giraffe' });
      }
    });

    it('hides the QR and disarms once the Word is answered, until the next Word', () => {
      expect(view(inRound('playing', 'guess'), { sentFor: 'w1' })).toMatchObject({ screen: 'play', qrWordId: null, canAnswer: false });
    });

    it('shows the Reveal after a tilt, with input off', () => {
      expect(view(inRound('playing', 'guess'), { revealing: true })).toMatchObject({ screen: 'reveal', canAnswer: false });
    });

    it('counts down with the wake lock on and nothing to answer', () => {
      expect(view(inRound('countdown', 'guess'))).toMatchObject({ screen: 'countdown', canAnswer: false, wakeLock: true, current: null });
    });
  });

  describe('Clue mode Rounds: the phone is idle', () => {
    it('never has the Word, never arms tilts, no wake lock, even if a Snapshot carried the Word', () => {
      const v = view(inRound('playing', 'clue'));
      expect(v).toEqual({ screen: 'clue_play', inRound: true, current: null, qrWordId: null, canAnswer: false, wakeLock: false });
    });

    it('idles through the countdown too', () => {
      expect(view(inRound('countdown', 'clue'))).toMatchObject({ screen: 'clue_countdown', canAnswer: false, wakeLock: false, inRound: true });
    });

    it('never shows a Reveal', () => {
      expect(view(inRound('playing', 'clue'), { revealing: true })).toMatchObject({ screen: 'clue_play', canAnswer: false });
    });

    it('follows the Round mode, not the selected Mode', () => {
      const s = inRound('playing', 'clue');
      expect(view({ ...s, mode: 'guess' }).screen).toBe('clue_play');
      const g = inRound('playing', 'guess');
      expect(view({ ...g, mode: 'clue' })).toMatchObject({ screen: 'play', canAnswer: true });
    });
  });

  it('routes errors, join, lobby and recap as before', () => {
    expect(view(null, { error: 'not_found' }).screen).toBe('not_found');
    expect(view(null, { error: 'room_taken' }).screen).toBe('room_taken');
    expect(view(snap(), { error: 'room_closed' }).screen).toBe('closed');
    expect(view(snap({ phase: 'closed' })).screen).toBe('closed');
    expect(view(null, { joined: false }).screen).toBe('join');
    expect(view(null).screen).toBe('joining');
    expect(view(snap()).screen).toBe('lobby');
    expect(view(snap({ phase: 'recap' })).screen).toBe('lobby');
    const summary = { index: 1, category: 'animals', gotIt: 1, passed: 0, words: [] } as unknown as RoundSummary;
    expect(view(snap({ phase: 'recap', lastSummary: summary }))).toMatchObject({ screen: 'recap', inRound: false, wakeLock: false, canAnswer: false });
  });
});

describe('palGate', () => {
  it('starts when the selected Mode friend is ready, or without the PAL', () => {
    expect(palGate(snap())).toEqual({ canStart: true, notice: null, friend: 'Anna' });
    expect(palGate(snap({ mode: 'clue', pal: { status: 'ready', mode: 'clue' } }))).toEqual({ canStart: true, notice: null, friend: 'Maya' });
    expect(palGate(snap({ mode: 'clue', pal: { status: 'offline' } }))).toMatchObject({ canStart: true, notice: 'offline' });
  });

  it('waits while the friends swap after a Mode change', () => {
    expect(palGate(snap({ mode: 'clue', pal: { status: 'ready' } }))).toEqual({ canStart: false, notice: 'joining', friend: 'Maya' });
    expect(palGate(snap({ mode: 'guess', pal: { status: 'ready', mode: 'clue' } }))).toEqual({ canStart: false, notice: 'joining', friend: 'Anna' });
    for (const status of ['idle', 'starting', 'joining'] as const) {
      expect(palGate(snap({ mode: 'clue', pal: { status } }))).toEqual({ canStart: false, notice: 'joining', friend: 'Maya' });
    }
  });

  it('asks for the big screen first', () => {
    expect(palGate(snap({ stageConnected: false, pal: { status: 'idle' } }))).toMatchObject({ canStart: false, notice: 'no_stage' });
  });

  it('names who left and who could not join', () => {
    expect(palGate(snap({ mode: 'clue', pal: { status: 'ended', mode: 'guess' } }))).toEqual({ canStart: false, notice: 'ended', friend: 'Anna' });
    expect(palGate(snap({ mode: 'clue', pal: { status: 'error', mode: 'guess' } }))).toEqual({ canStart: false, notice: 'error', friend: 'Maya' });
    expect(palGate(snap({ pal: { status: 'busy' } }))).toMatchObject({ canStart: false, notice: 'busy' });
  });
});

describe('bestsFor', () => {
  const stats = (mode: Mode): PlayerSummary => ({
    mode,
    nickname: 'Ofer',
    roundsPlayed: 3,
    bests: { animals: 7 },
    wordsPerMinute: null,
    reactionLagMs: null,
    mostPassed: [],
    tiltSlips: 0,
    passedAfterHeard: 0,
    gotUnheard: 0,
    fouls: 0,
  });

  it("shows the selected Mode's bests only", () => {
    expect(bestsFor(snap({ mode: 'clue', stats: stats('clue') }))).toEqual({ animals: 7 });
    expect(bestsFor(snap({ stats: stats('guess') }))).toEqual({ animals: 7 });
    expect(bestsFor(snap({ mode: 'clue', stats: stats('guess') }))).toEqual({});
    expect(bestsFor(snap())).toEqual({});
  });
});
