import { describe, expect, it } from 'vitest';
import { saysWord } from './guess';

describe('saysWord', () => {
  it('matches the Word, case and punctuation aside', () => {
    expect(saysWord("It's a PAINTER!", 'painter')).toBe(true);
    expect(saysWord('Uh, chef—', 'chef')).toBe(true);
    expect(saysWord('chef', 'chef')).toBe(true);
  });

  it('allows plurals and short suffixes', () => {
    expect(saysWord('painters?', 'painter')).toBe(true);
    expect(saysWord("the painter's brush", 'painter')).toBe(true);
    expect(saysWord('foxes!', 'fox')).toBe(true);
    expect(saysWord('butterflies', 'butterfly')).toBe(true);
  });

  it('matches multi-word Words and split or merged forms', () => {
    expect(saysWord('ice cream!', 'ice cream')).toBe(true);
    expect(saysWord('icecream', 'ice cream')).toBe(true);
    expect(saysWord('is it a fire fighter?', 'firefighter')).toBe(true);
    expect(saysWord('firefighters', 'firefighter')).toBe(true);
    expect(saysWord('a hot-dog', 'hot dog')).toBe(true);
  });

  it('does not match a different Word', () => {
    expect(saysWord('Uh, chef—', 'painter')).toBe(false);
    expect(saysWord('I said pizza.', 'chef')).toBe(false);
    expect(saysWord('', 'chef')).toBe(false);
  });

  it('does not match raw substrings or only part of a multi-word Word', () => {
    expect(saysWord('education', 'cat')).toBe(false);
    expect(saysWord('a catalogue', 'cat')).toBe(false);
    expect(saysWord('scatter', 'cat')).toBe(false);
    expect(saysWord('something cold, ice?', 'ice cream')).toBe(false);
    expect(saysWord('a fighter', 'firefighter')).toBe(false);
  });
});
