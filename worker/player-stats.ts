import { DurableObject } from 'cloudflare:workers';
import { ROUND_MS, type CategoryId, type Mode } from '../shared/game';
import type { PlayerSummary } from '../shared/protocol';
import type { RoundSummary } from '../shared/room';

/**
 * Training stats for one Player (keyed by the phone's anonymous playerId) in one Mode, persisted across visits.
 * Kept separately per Mode (CONTEXT.md "Training stats"): Reaction lag and Tilt slips only grow from Guess Rounds,
 * Fouls only from Clue Rounds.
 */
interface StatsData {
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
  /** Lifetime Fouls (Clue mode). Missing in data stored before Clue mode existed. */
  fouls: number;
  /** Last 50 Rounds. Entries stored before Tilt slips existed lack passedAfterHeard / gotUnheard. */
  recent: (RoundSummary & { at: number })[];
}

type SlipSplit = 'passedAfterHeard' | 'gotUnheard';
/**
 * StatsData as stored. The split slip counters and fouls are missing in data stored before they existed. Guess mode
 * data stored before Modes existed (under the 'stats' key) also carries the Player's nickname.
 */
export type StoredStats = Omit<StatsData, SlipSplit | 'fouls'> & Partial<Pick<StatsData, SlipSplit | 'fouls'>> & { nickname?: string };

/** Defaults for fields missing in stored data. The split slip counters are left out on purpose so backfillSlips can spot old data. */
const EMPTY: Omit<StatsData, SlipSplit> = {
  roundsPlayed: 0,
  bests: {},
  totalGot: 0,
  totalMinutes: 0,
  lagSumMs: 0,
  lagCount: 0,
  passCounts: {},
  wordNames: {},
  tiltSlips: 0,
  fouls: 0,
  recent: [],
};

/** Guess mode keeps the key it had before Modes existed, so stored stats read as Guess mode with no migration. */
const STATS_KEY: Record<Mode, string> = { guess: 'stats', clue: 'stats:clue' };

/**
 * Data stored before the lifetime split existed only has the merged tiltSlips: derive each kind from `recent`
 * (the last 50 Rounds). Older slips can't be attributed, so passedAfterHeard + gotUnheard <= tiltSlips.
 */
export function backfillSlips(d: Omit<StoredStats, 'fouls' | 'nickname'> & { fouls: number }): StatsData {
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
  private stored(mode: Mode): StoredStats | undefined {
    return this.ctx.storage.kv.get<StoredStats>(STATS_KEY[mode]);
  }

  private load(mode: Mode): StatsData {
    const { nickname: _legacy, ...d } = { ...EMPTY, ...(this.stored(mode) ?? {}) };
    return backfillSlips(d);
  }

  private save(mode: Mode, d: StatsData) {
    // Keep the legacy nickname on the Guess record so older code reading it still finds it.
    const nickname = mode === 'guess' ? this.stored('guess')?.nickname : undefined;
    this.ctx.storage.kv.put(STATS_KEY[mode], nickname === undefined ? d : { ...d, nickname });
  }

  /** The nickname lives on its own key; data stored before Modes existed kept it inside the Guess stats. */
  private nickname(): string {
    return this.ctx.storage.kv.get<string>('nickname') ?? this.stored('guess')?.nickname ?? '';
  }

  async setNickname(nickname: string): Promise<void> {
    if (nickname && nickname !== this.nickname()) this.ctx.storage.kv.put('nickname', nickname);
  }

  async getSummary(mode: Mode = 'guess'): Promise<PlayerSummary> {
    return summarize(this.load(mode), mode, this.nickname());
  }

  async getSummaries(): Promise<Record<Mode, PlayerSummary>> {
    return { guess: await this.getSummary('guess'), clue: await this.getSummary('clue') };
  }

  /** Pass counts for drawing Words in a Round of this Mode (most-passed Words come back more often, per Mode). */
  async getPassCounts(mode: Mode = 'guess'): Promise<Record<string, number>> {
    return this.load(mode).passCounts;
  }

  /** Records the Round into its own Mode's stats (a summary without `mode` predates Clue mode: Guess mode). */
  async recordRound(r: RoundSummary, at: number): Promise<RecordResult> {
    const mode: Mode = r.mode ?? 'guess';
    const guess = mode === 'guess';
    const d = this.load(mode);
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
    // Reaction lag is averaged per Round (each Round's mean counts once). Guess mode only, like Tilt slips.
    const lag = guess ? r.reactionLagMs : null;
    const lagN = lag === null ? 0 : 1;
    const passedAfterHeard = guess ? r.passedAfterHeard : 0;
    const gotUnheard = guess ? r.gotUnheard : 0;
    const next: StatsData = {
      ...d,
      roundsPlayed: d.roundsPlayed + 1,
      bests: isBest ? { ...d.bests, [r.category]: r.gotIt } : d.bests,
      totalGot: d.totalGot + r.gotIt,
      totalMinutes: d.totalMinutes + ROUND_MS / 60_000,
      lagSumMs: d.lagSumMs + (lag ?? 0) * lagN,
      lagCount: d.lagCount + lagN,
      passCounts,
      wordNames,
      tiltSlips: d.tiltSlips + passedAfterHeard + gotUnheard,
      passedAfterHeard: d.passedAfterHeard + passedAfterHeard,
      gotUnheard: d.gotUnheard + gotUnheard,
      fouls: d.fouls + (guess ? 0 : (r.fouls ?? 0)),
      recent: [...d.recent, { ...r, at }].slice(-50),
    };
    this.save(mode, next);
    return {
      summary: summarize(next, mode, this.nickname()),
      personalBest: isBest ? { category: r.category, score: r.gotIt, previous } : null,
    };
  }
}

export function summarize(d: StatsData, mode: Mode, nickname: string): PlayerSummary {
  const guess = mode === 'guess';
  return {
    mode,
    nickname,
    roundsPlayed: d.roundsPlayed,
    bests: d.bests,
    wordsPerMinute: d.totalMinutes ? Math.round((d.totalGot / d.totalMinutes) * 10) / 10 : null,
    reactionLagMs: guess && d.lagCount ? Math.round(d.lagSumMs / d.lagCount) : null,
    mostPassed: Object.entries(d.passCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, passes]) => ({ word: d.wordNames[id] ?? id, passes })),
    tiltSlips: guess ? d.tiltSlips : 0,
    passedAfterHeard: guess ? d.passedAfterHeard : 0,
    gotUnheard: guess ? d.gotUnheard : 0,
    fouls: guess ? 0 : d.fouls,
  };
}
