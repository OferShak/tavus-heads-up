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
