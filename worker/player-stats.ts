import { DurableObject } from 'cloudflare:workers';
import { ROUND_MS, type CategoryId } from '../shared/game';
import type { PlayerSummary } from '../shared/protocol';
import type { RoundSummary } from '../shared/room';

/** Training stats for one Player (keyed by the phone's anonymous playerId), persisted across visits. */
interface StatsData {
  nickname: string;
  roundsPlayed: number;
  bests: Partial<Record<CategoryId, number>>;
  totalGot: number;
  totalMinutes: number;
  lagSumMs: number;
  lagCount: number;
  passCounts: Record<string, number>;
  /** wordId → word, for showing most-passed Words. */
  wordNames: Record<string, string>;
  /** Lifetime Tilt slips, both kinds. Missing in data stored before this field existed (filled from EMPTY on load). */
  tiltSlips: number;
  /** Lifetime Tilt slips that were a Pass on a Word the PAL heard. */
  passedAfterHeard: number;
  /** Lifetime Tilt slips that were a Got it on a Word the PAL never heard. */
  gotUnheard: number;
  /** Last 50 Rounds. Entries stored before Tilt slips existed lack passedAfterHeard / gotUnheard. */
  recent: (RoundSummary & { at: number })[];
}

type SlipSplit = 'passedAfterHeard' | 'gotUnheard';
/** StatsData as stored: the split slip counters are missing in data stored before they existed. */
export type StoredStats = Omit<StatsData, SlipSplit> & Partial<Pick<StatsData, SlipSplit>>;

/** Defaults for fields missing in stored data. The split slip counters are left out on purpose so backfillSlips can spot old data. */
const EMPTY: Omit<StatsData, SlipSplit> = {
  nickname: '',
  roundsPlayed: 0,
  bests: {},
  totalGot: 0,
  totalMinutes: 0,
  lagSumMs: 0,
  lagCount: 0,
  passCounts: {},
  wordNames: {},
  tiltSlips: 0,
  recent: [],
};

/**
 * Data stored before the lifetime split existed only has the merged tiltSlips: derive each kind from `recent`
 * (the last 50 Rounds). Older slips can't be attributed, so passedAfterHeard + gotUnheard <= tiltSlips.
 */
export function backfillSlips(d: StoredStats): StatsData {
  if (d.passedAfterHeard !== undefined && d.gotUnheard !== undefined) return d as StatsData;
  const sum = (k: SlipSplit) => d.recent.reduce((n, r) => n + ((r[k] as number | undefined) ?? 0), 0);
  const passedAfterHeard = sum('passedAfterHeard');
  const gotUnheard = sum('gotUnheard');
  return { ...d, passedAfterHeard, gotUnheard, tiltSlips: Math.max(d.tiltSlips, passedAfterHeard + gotUnheard) };
}

export interface RecordResult {
  summary: PlayerSummary;
  personalBest: { category: CategoryId; score: number; previous: number | null } | null;
}

export class PlayerStats extends DurableObject<Env> {
  private load(): StatsData {
    return backfillSlips({ ...EMPTY, ...(this.ctx.storage.kv.get<StoredStats>('stats') ?? {}) });
  }

  private save(d: StatsData) {
    this.ctx.storage.kv.put('stats', d);
  }

  async setNickname(nickname: string): Promise<void> {
    const d = this.load();
    if (nickname && nickname !== d.nickname) this.save({ ...d, nickname });
  }

  async getSummary(): Promise<PlayerSummary> {
    return summarize(this.load());
  }

  async getPassCounts(): Promise<Record<string, number>> {
    return this.load().passCounts;
  }

  async recordRound(r: RoundSummary, at: number): Promise<RecordResult> {
    const d = this.load();
    const previous = d.bests[r.category] ?? null;
    const isBest = r.gotIt > 0 && (previous === null || r.gotIt > previous);
    const passCounts = { ...d.passCounts };
    const wordNames = { ...d.wordNames };
    for (const w of r.words) {
      if (w.outcome === 'pass') {
        passCounts[w.wordId] = (passCounts[w.wordId] ?? 0) + 1;
        wordNames[w.wordId] = w.word;
      } else if (w.outcome === 'got' && passCounts[w.wordId]) {
        // Got it after struggling: decay so it comes back less often.
        passCounts[w.wordId] = passCounts[w.wordId] - 1;
      }
    }
    // Reaction lag is averaged per Round (each Round's mean counts once).
    const lagN = r.reactionLagMs === null ? 0 : 1;
    const next: StatsData = {
      ...d,
      roundsPlayed: d.roundsPlayed + 1,
      bests: isBest ? { ...d.bests, [r.category]: r.gotIt } : d.bests,
      totalGot: d.totalGot + r.gotIt,
      totalMinutes: d.totalMinutes + ROUND_MS / 60_000,
      lagSumMs: d.lagSumMs + (r.reactionLagMs ?? 0) * lagN,
      lagCount: d.lagCount + lagN,
      passCounts,
      wordNames,
      tiltSlips: d.tiltSlips + r.passedAfterHeard + r.gotUnheard,
      passedAfterHeard: d.passedAfterHeard + r.passedAfterHeard,
      gotUnheard: d.gotUnheard + r.gotUnheard,
      recent: [...d.recent, { ...r, at }].slice(-50),
    };
    this.save(next);
    return {
      summary: summarize(next),
      personalBest: isBest ? { category: r.category, score: r.gotIt, previous } : null,
    };
  }
}

export function summarize(d: StatsData): PlayerSummary {
  return {
    nickname: d.nickname,
    roundsPlayed: d.roundsPlayed,
    bests: d.bests,
    wordsPerMinute: d.totalMinutes ? Math.round((d.totalGot / d.totalMinutes) * 10) / 10 : null,
    reactionLagMs: d.lagCount ? Math.round(d.lagSumMs / d.lagCount) : null,
    mostPassed: Object.entries(d.passCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, passes]) => ({ word: d.wordNames[id] ?? id, passes })),
    tiltSlips: d.tiltSlips,
    passedAfterHeard: d.passedAfterHeard,
    gotUnheard: d.gotUnheard,
  };
}
