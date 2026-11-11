import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_IDS } from './game';
import { drawWord, levelsFor, weightOf } from './words';
import type { Word } from './game';

const deck: Word[] = [
  { id: 'e1', word: 'cat', level: 'easy' },
  { id: 'e2', word: 'dog', level: 'easy' },
  { id: 'm1', word: 'owl', level: 'medium' },
  { id: 'h1', word: 'sloth', level: 'hard' },
];

describe('decks', () => {
  it.each(CATEGORY_IDS)('%s has ~50 unique words across all levels', (id) => {
    const words = CATEGORIES[id].words;
    expect(words.length).toBeGreaterThanOrEqual(45);
    expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
    expect(new Set(words.map((w) => w.word)).size).toBe(words.length);
    for (const level of ['easy', 'medium', 'hard'] as const) {
      expect(words.filter((w) => w.level === level).length).toBeGreaterThanOrEqual(10);
    }
  });

  it('word ids are unique across categories (QR payload carries only the id + word)', () => {
    const ids = CATEGORY_IDS.flatMap((id) => CATEGORIES[id].words.map((w) => w.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('drawWord', () => {
  it('starts a Round with easy words', () => {
    expect(levelsFor(0)).toEqual(['easy']);
    for (let i = 0; i < 50; i++) {
      expect(drawWord({ words: deck, used: new Set(), position: 0 }).level).toBe('easy');
    }
  });

  it('widens to harder levels later in the Round', () => {
    expect(levelsFor(8)).toEqual(['easy', 'medium', 'hard']);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(drawWord({ words: deck, used: new Set(), position: 8 }).id);
    expect(seen).toEqual(new Set(['e1', 'e2', 'm1', 'h1']));
  });

  it('never repeats a Word used in the Room while unused ones remain', () => {
    const used = new Set(['e1', 'e2']);
    for (let i = 0; i < 50; i++) {
      const w = drawWord({ words: deck, used, position: 0 });
      expect(used.has(w.id)).toBe(false);
    }
  });

  it('falls back to repeats only when the Category is exhausted', () => {
    const used = new Set(deck.map((w) => w.id));
    expect(deck.map((w) => w.id)).toContain(drawWord({ words: deck, used, position: 0 }).id);
  });

  it('weights most-passed words up, capped', () => {
    expect(weightOf('x', undefined)).toBe(1);
    expect(weightOf('x', { x: 2 })).toBe(3);
    expect(weightOf('x', { x: 99 })).toBe(5);
  });

  it('draws a heavily passed word more often', () => {
    let rngI = 0;
    const seq = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);
    const rng = () => seq[rngI++ % seq.length];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const w = drawWord({ words: deck, used: new Set(), position: 0, passCounts: { e2: 4 }, rng });
      counts[w.id] = (counts[w.id] ?? 0) + 1;
    }
    // e1 weight 1, e2 weight 5 → ~1/6 vs ~5/6
    expect(counts.e2).toBeGreaterThan(counts.e1 * 4);
  });
});
