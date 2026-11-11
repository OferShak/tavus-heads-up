import { describe, expect, it } from 'vitest';
import { leaksWord } from './leak';

describe('leaksWord', () => {
  it('catches the Word itself, case and punctuation aside', () => {
    expect(leaksWord('It is a GIRAFFE!', 'giraffe')).toBe(true);
  });

  it('catches plurals and short suffixes', () => {
    expect(leaksWord('lots of giraffes here', 'giraffe')).toBe(true);
    expect(leaksWord('the baker is baking', 'baker')).toBe(true);
  });

  it('catches any part of a multi-word Word', () => {
    expect(leaksWord('cold and creamy, like a cream pie', 'ice cream')).toBe(true);
    expect(leaksWord('your mail arrives', 'mail carrier')).toBe(true);
    expect(leaksWord('an icecream truck', 'ice cream')).toBe(true);
  });

  it('allows clean clues, rhymes and "sounds like"', () => {
    expect(leaksWord('long neck, spots, eats leaves', 'giraffe')).toBe(false);
    expect(leaksWord('rhymes with hat', 'cat')).toBe(false);
    expect(leaksWord('frozen dessert in a cone', 'ice cream')).toBe(false);
  });

  it('ignores tiny parts that collide with normal speech', () => {
    // "hot dog": "hot" counts, but not "do"
    expect(leaksWord('do it fast', 'hot dog')).toBe(false);
  });

  it('does not flag a longer unrelated word that merely starts with the part', () => {
    expect(leaksWord('a catalogue of things', 'cat')).toBe(false);
  });
});
