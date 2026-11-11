import type { Level, Word } from './game';

export interface DrawInput {
  words: Word[];
  /** Word ids already shown in this Room (no repeats within a Room). */
  used: ReadonlySet<string>;
  /** Lifetime pass counts for this Player (spaced repetition: most-passed come back more often). */
  passCounts?: Readonly<Record<string, number>>;
  /** 0-based index of the Word within the Round. Rounds start easy. */
  position: number;
  /** Returns a float in [0, 1). */
  rng?: () => number;
}

/** Levels allowed at a given position in a Round: easy openers, then widen. */
export function levelsFor(position: number): Level[] {
  if (position < 3) return ['easy'];
  if (position < 7) return ['easy', 'medium'];
  return ['easy', 'medium', 'hard'];
}

const MAX_PASS_BOOST = 4;

export function weightOf(wordId: string, passCounts?: Readonly<Record<string, number>>): number {
  return 1 + Math.min(passCounts?.[wordId] ?? 0, MAX_PASS_BOOST);
}

/**
 * Pick the next Word. Prefers unused Words at the allowed levels, widens the levels if those run out,
 * and only repeats once the whole Category is exhausted. Weighted by past passes.
 */
export function drawWord({ words, used, passCounts, position, rng = Math.random }: DrawInput): Word {
  if (words.length === 0) throw new Error('empty category');
  const unused = words.filter((w) => !used.has(w.id));
  const levels = levelsFor(position);
  const pools = [unused.filter((w) => levels.includes(w.level)), unused, words];
  const pool = pools.find((p) => p.length > 0)!;

  const total = pool.reduce((sum, w) => sum + weightOf(w.id, passCounts), 0);
  let r = rng() * total;
  for (const w of pool) {
    r -= weightOf(w.id, passCounts);
    if (r < 0) return w;
  }
  return pool[pool.length - 1];
}
