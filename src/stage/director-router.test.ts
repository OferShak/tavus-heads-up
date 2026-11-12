import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mode } from '../../shared/game';
import type { RoomEvent, Snapshot } from '../../shared/protocol';
import type { PalStatus } from '../../shared/room';
import type { TavusEvent } from './director';
import { DirectorRouter, type GuessStageDirector, type StageDirector, type SwapMeasure } from './director-router';

type Call = [string, ...unknown[]];

function fake(): StageDirector & GuessStageDirector & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    onSnapshot: (s: Snapshot, e?: RoomEvent) => calls.push(['onSnapshot', s.phase, e?.kind]),
    onTavusEvent: (ev: TavusEvent) => calls.push(['onTavusEvent', ev.event_type]),
    onPalJoined: () => calls.push(['onPalJoined']),
    setLive: (live: boolean) => calls.push(['setLive', live]),
    dispose: () => calls.push(['dispose']),
    onQr: (p: string) => calls.push(['onQr', p]),
  };
}

function snap(status: PalStatus, friend: Mode, phase: Snapshot['phase'] = 'lobby', roundMode?: Mode): Snapshot {
  return {
    code: 'ABCDE',
    phase,
    mode: friend,
    serverNow: 0,
    player: { nickname: 'Sam' },
    stageConnected: true,
    controllerConnected: true,
    pal: { status, mode: friend },
    round: roundMode
      ? { index: 1, category: 'animals', mode: roundMode, startsAt: 0, endsAt: 60_000, current: null, gotIt: 0, passed: 0 }
      : null,
    lastSummary: null,
    stats: null,
    personalBest: null,
  };
}

const palSpeaks: TavusEvent = { event_type: 'conversation.started_speaking', properties: { role: 'pal' } };

describe('DirectorRouter', () => {
  let guess: ReturnType<typeof fake>;
  let clue: ReturnType<typeof fake>;
  let swaps: SwapMeasure[];
  let r: DirectorRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    guess = fake();
    clue = fake();
    swaps = [];
    r = new DirectorRouter(guess, clue, { now: () => Date.now(), onSwap: (m) => swaps.push(m) });
  });
  afterEach(() => vi.useRealTimers());

  it('sends snapshots, Tavus events and QR only to the friend in the call', () => {
    r.onSnapshot(snap('ready', 'guess'));
    r.onTavusEvent(palSpeaks);
    r.onQr('omh:w1:giraffe');
    expect(clue.calls).toEqual([]);

    r.onSnapshot(snap('starting', 'clue'));
    // Switching away: the Guess director drops its Word and goes off the call.
    expect(guess.calls.slice(-2)).toEqual([['dispose'], ['setLive', false]]);
    guess.calls.length = 0;
    r.onSnapshot(snap('ready', 'clue', 'playing', 'clue'));
    r.onTavusEvent(palSpeaks);
    r.onQr('omh:w1:giraffe');
    r.onPalJoined();
    expect(guess.calls).toEqual([['setLive', false]]);
    expect(clue.calls).toEqual([
      ['onSnapshot', 'lobby', undefined],
      ['onSnapshot', 'playing', undefined],
      ['onTavusEvent', 'conversation.started_speaking'],
      ['onPalJoined'],
    ]);
  });

  it('keeps a Clue Round on the Clue director by its Round Mode', () => {
    r.onSnapshot({ ...snap('ready', 'guess', 'playing', 'clue') });
    expect(r.active).toBe('clue');
  });

  it('measures the friend swap: starting for the other Mode → joined → first PAL speech', () => {
    r.onSnapshot(snap('ready', 'guess'));
    r.onSnapshot(snap('starting', 'clue'));
    vi.advanceTimersByTime(1_000);
    // Old call's speech before the new friend joined doesn't count.
    r.onTavusEvent(palSpeaks);
    r.onSnapshot(snap('joining', 'clue'));
    vi.advanceTimersByTime(3_000);
    r.onPalJoined();
    r.onTavusEvent({ event_type: 'conversation.started_speaking', properties: { role: 'user' } });
    vi.advanceTimersByTime(1_500);
    r.onTavusEvent(palSpeaks);
    r.onTavusEvent(palSpeaks);
    expect(swaps).toEqual([{ from: 'guess', to: 'clue', joinMs: 4_000, ms: 5_500 }]);
  });

  it('does not measure the first start, and drops a swap that failed', () => {
    r.onSnapshot(snap('idle', 'guess'));
    r.onSnapshot(snap('starting', 'guess'));
    r.onPalJoined();
    r.onTavusEvent(palSpeaks);
    r.onSnapshot(snap('ready', 'guess'));
    r.onSnapshot(snap('starting', 'clue'));
    r.onSnapshot(snap('error', 'clue'));
    r.onPalJoined();
    r.onTavusEvent(palSpeaks);
    expect(swaps).toEqual([]);
  });
});
