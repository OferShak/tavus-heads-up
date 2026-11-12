import { describe, expect, it } from 'vitest';
import { judgeSaid } from './foul';

describe('judgeSaid (Clue mode Foul rule)', () => {
  it('fouls when the Player says the Word before the PAL has', () => {
    expect(judgeSaid('giraffe', 'player', 'Long neck, like a giraffe!', false)).toBe('foul');
  });

  it('counts plurals and split or merged forms, like saysWord', () => {
    expect(judgeSaid('giraffe', 'player', 'two giraffes', false)).toBe('foul');
    expect(judgeSaid('firefighter', 'player', 'a fire fighter puts out fires', false)).toBe('foul');
    expect(judgeSaid('ice cream', 'player', 'icecream in a cone', false)).toBe('foul');
  });

  it('does not foul on part of the Word or a different Word', () => {
    expect(judgeSaid('firefighter', 'player', 'puts out a fire', false)).toBeNull();
    expect(judgeSaid('giraffe', 'player', 'tall, spotty, eats leaves', false)).toBeNull();
    expect(judgeSaid('cat', 'player', 'education', false)).toBeNull();
  });

  it('records when the PAL says the Word', () => {
    expect(judgeSaid('giraffe', 'pal', 'Is it a giraffe?', false)).toBe('pal_said');
    expect(judgeSaid('giraffe', 'pal', 'Is it a zebra?', false)).toBeNull();
  });

  it('lets the Player confirm once the PAL has said the Word ("yes, giraffe!")', () => {
    expect(judgeSaid('giraffe', 'player', 'Yes, giraffe!', true)).toBeNull();
  });
});
