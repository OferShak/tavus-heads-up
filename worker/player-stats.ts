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
  /** Lifetime Tilt slips. Missing in data stored before this field existed (filled from EMPTY on load). */
  tiltSlips: number;
  recent: (RoundSummary & { at: number })[];
}

const EMPTY: StatsData = {
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

export interface RecordResult {
  summary: PlayerSummary;
  personalBest: { category: CategoryId; score: number; previous: number | null } | null;
}

export class PlayerStats extends DurableObject<Env> {
  private load(): StatsData {
    return { ...EMPTY, ...(this.ctx.storage.kv.get<StatsData>('stats') ?? {}) };
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
  };
}
