import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RoundSummary } from '../shared/room';
import type { StoredStats } from './player-stats';

const statsStub = (playerId: string) => env.PLAYER_STATS.get(env.PLAYER_STATS.idFromName(playerId));

function round(over: Partial<RoundSummary> = {}): RoundSummary {
  return {
    index: 1,
    category: 'animals',
    gotIt: 0,
    passed: 0,
    words: [],
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
    ...over,
  };
}

describe('PlayerStats Tilt slips', () => {
  it('counts each kind of Tilt slip separately, plus the total', async () => {
    const stub = statsStub('slips-split');
    await stub.recordRound(round({ passedAfterHeard: 2, gotUnheard: 1 }), 1);
    const { summary } = await stub.recordRound(round({ index: 2, passedAfterHeard: 1, gotUnheard: 0 }), 2);
    expect(summary).toMatchObject({ tiltSlips: 4, passedAfterHeard: 3, gotUnheard: 1 });
    expect(await stub.getSummary()).toMatchObject({ tiltSlips: 4, passedAfterHeard: 3, gotUnheard: 1 });
  });

  it('starts a new Player at zero of each kind', async () => {
    expect(await statsStub('slips-new').getSummary()).toMatchObject({ tiltSlips: 0, passedAfterHeard: 0, gotUnheard: 0 });
  });

  it('backfills the split from recent Rounds for data stored before it existed', async () => {
    const stub = statsStub('slips-backfill');
    // Only the merged total was kept; the oldest recent Round predates Tilt slips entirely.
    const { passedAfterHeard: _p, gotUnheard: _g, ...legacy } = round();
    const old: StoredStats = {
      nickname: 'Ofer',
      roundsPlayed: 3,
      bests: {},
      totalGot: 0,
      totalMinutes: 3,
      lagSumMs: 0,
      lagCount: 0,
      passCounts: {},
      wordNames: {},
      tiltSlips: 7,
      recent: [
        { ...(legacy as RoundSummary), at: 1 },
        { ...round({ passedAfterHeard: 2, gotUnheard: 1 }), at: 2 },
        { ...round({ passedAfterHeard: 1, gotUnheard: 0 }), at: 3 },
      ],
    };
    await runInDurableObject(stub, (_obj, state) => state.storage.kv.put('stats', old));

    // 3 + 1 attributed from recent; the other 3 slips are too old to tell apart.
    expect(await stub.getSummary()).toMatchObject({ tiltSlips: 7, passedAfterHeard: 3, gotUnheard: 1 });

    // Recording a Round persists the backfilled split and adds to it.
    await stub.recordRound(round({ index: 4, gotUnheard: 2 }), 4);
    expect(await stub.getSummary()).toMatchObject({ tiltSlips: 9, passedAfterHeard: 3, gotUnheard: 3 });
    const stored = await runInDurableObject(stub, (_obj, state) => state.storage.kv.get<StoredStats>('stats'));
    expect(stored).toMatchObject({ tiltSlips: 9, passedAfterHeard: 3, gotUnheard: 3 });
  });
});

const word = (wordId: string, outcome: 'got' | 'pass', foul = false) => ({ wordId, word: wordId, outcome, ...(foul ? { foul: true as const } : {}) });

describe('PlayerStats per Mode', () => {
  it('keeps Guess and Clue stats apart, each with its own personal best', async () => {
    const stub = statsStub('modes-apart');
    await stub.setNickname('Sam');
    const g = await stub.recordRound(round({ mode: 'guess', gotIt: 3, reactionLagMs: 1200, passedAfterHeard: 1, words: [word('a1', 'got'), word('a2', 'pass')] }), 1);
    expect(g.personalBest).toEqual({ category: 'animals', score: 3, previous: null });
    // Clue mode's first Animals Round is its own personal best, even though it scores less than the Guess one.
    const c = await stub.recordRound(round({ mode: 'clue', gotIt: 2, fouls: 1, words: [word('a3', 'got', true), word('a4', 'pass')] }), 2);
    expect(c.personalBest).toEqual({ category: 'animals', score: 2, previous: null });
    expect(c.summary).toMatchObject({ mode: 'clue', nickname: 'Sam', roundsPlayed: 1, bests: { animals: 2 }, fouls: 1, mostPassed: [{ word: 'a4', passes: 1 }] });

    const guess = await stub.getSummary('guess');
    expect(guess).toMatchObject({ mode: 'guess', nickname: 'Sam', roundsPlayed: 1, bests: { animals: 3 }, reactionLagMs: 1200, tiltSlips: 1, fouls: 0 });
    expect(guess.mostPassed).toEqual([{ word: 'a2', passes: 1 }]);
    expect(await stub.getSummary()).toEqual(guess);
    expect(await stub.getSummaries()).toEqual({ guess, clue: c.summary });

    // Personal best detection compares within the Mode only.
    const c2 = await stub.recordRound(round({ mode: 'clue', index: 3, gotIt: 3 }), 3);
    expect(c2.personalBest).toEqual({ category: 'animals', score: 3, previous: 2 });
    expect(c2.summary.wordsPerMinute).toBe(2.5);
  });

  it('counts Reaction lag and Tilt slips only from Guess Rounds, Fouls only from Clue Rounds', async () => {
    const stub = statsStub('modes-only');
    // Defensive: a Clue summary carrying Guess-only numbers (and the other way round) doesn't leak across.
    await stub.recordRound(round({ mode: 'clue', reactionLagMs: 900, passedAfterHeard: 2, gotUnheard: 1, fouls: 2 }), 1);
    await stub.recordRound(round({ mode: 'guess', fouls: 5 }), 2);
    expect(await stub.getSummary('clue')).toMatchObject({ reactionLagMs: null, tiltSlips: 0, passedAfterHeard: 0, gotUnheard: 0, fouls: 2 });
    expect(await stub.getSummary('guess')).toMatchObject({ reactionLagMs: null, tiltSlips: 0, fouls: 0 });
  });

  it('draws pass counts from the requested Mode', async () => {
    const stub = statsStub('modes-pass');
    await stub.recordRound(round({ mode: 'guess', words: [word('g1', 'pass')] }), 1);
    await stub.recordRound(round({ mode: 'clue', words: [word('c1', 'pass'), word('c1b', 'pass')] }), 2);
    expect(await stub.getPassCounts('guess')).toEqual({ g1: 1 });
    expect(await stub.getPassCounts()).toEqual({ g1: 1 });
    expect(await stub.getPassCounts('clue')).toEqual({ c1: 1, c1b: 1 });
  });

  it('reads stats stored before Modes existed as Guess mode, and keeps their nickname', async () => {
    const stub = statsStub('modes-legacy');
    const old: StoredStats = {
      nickname: 'Ofer',
      roundsPlayed: 2,
      bests: { food: 4 },
      totalGot: 6,
      totalMinutes: 2,
      lagSumMs: 3000,
      lagCount: 2,
      passCounts: { f1: 2 },
      wordNames: { f1: 'pizza' },
      tiltSlips: 1,
      passedAfterHeard: 1,
      gotUnheard: 0,
      recent: [],
    };
    await runInDurableObject(stub, (_obj, state) => state.storage.kv.put('stats', old));
    expect(await stub.getSummary('guess')).toMatchObject({ mode: 'guess', nickname: 'Ofer', roundsPlayed: 2, bests: { food: 4 }, reactionLagMs: 1500, fouls: 0, mostPassed: [{ word: 'pizza', passes: 2 }] });
    expect(await stub.getSummary('clue')).toMatchObject({ mode: 'clue', nickname: 'Ofer', roundsPlayed: 0, bests: {}, fouls: 0 });
    // A summary without `mode` (stored before Clue mode) records as Guess mode.
    const { mode: _m, ...legacyRound } = round({ category: 'food', gotIt: 5 });
    const r = await stub.recordRound(legacyRound as RoundSummary, 3);
    expect(r.personalBest).toEqual({ category: 'food', score: 5, previous: 4 });
    expect(r.summary).toMatchObject({ mode: 'guess', roundsPlayed: 3 });
    await stub.setNickname('Ofer S');
    expect(await stub.getSummary('clue')).toMatchObject({ nickname: 'Ofer S' });
    expect(await stub.getSummary('guess')).toMatchObject({ nickname: 'Ofer S' });
  });
});
