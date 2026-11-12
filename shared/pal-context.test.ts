import { describe, expect, it } from 'vitest';
import {
  clueCountdownContext,
  clueGreeting,
  clueLobbyContext,
  clueRecapContext,
  clueRevealMessage,
  clueRoundContext,
  swapRecap,
} from './pal-context';
import type { PlayerSummary } from './protocol';
import type { RoundSummary } from './room';

const clueStats = (over: Partial<PlayerSummary> = {}): PlayerSummary => ({
  mode: 'clue',
  nickname: 'Sam',
  roundsPlayed: 4,
  bests: { animals: 11 },
  wordsPerMinute: 8,
  reactionLagMs: null,
  mostPassed: [{ word: 'otter', passes: 2 }],
  tiltSlips: 0,
  passedAfterHeard: 0,
  gotUnheard: 0,
  fouls: 3,
  ...over,
});

const summary = (over: Partial<RoundSummary> = {}): RoundSummary => ({
  index: 1,
  category: 'animals',
  mode: 'clue',
  gotIt: 9,
  passed: 2,
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
});

describe('Clue PAL context', () => {
  it('lobby: no Round, no Word, the Player gives the Clues', () => {
    const c = clueLobbyContext('Sam');
    expect(c).toMatch(/^GAME STATE: no Round is running/);
    expect(c).toContain('NO word');
    expect(c).toContain('PLAYER: Sam.');
    expect(c).toMatch(/pick a Category on their phone/);
    expect(clueLobbyContext('')).toContain('PLAYER: the Player.');
  });

  it('countdown: names the Category, no Word yet', () => {
    const c = clueCountdownContext('Sam', 'food');
    expect(c).toContain('Food & Drink Round is about to start');
    expect(c).toContain('PLAYER: Sam.');
  });

  it('Round on: Category, Word number and score, never the current Word', () => {
    const c = clueRoundContext('Sam', 'animals', 4, 3);
    expect(c).toContain('Category: Animals');
    expect(c).toContain('word #4');
    expect(c).toContain('Score so far: 3');
    expect(c).toMatch(/can't see the word/i);
    expect(c).toContain('tilt');
    expect(c).toContain('PLAYER: Sam.');
  });

  it('Reveal on Got it: names the Word, one short line, calls out a lie, waits for the next Clue', () => {
    const m = clueRevealMessage('giraffe', 'got', false);
    expect(m).toMatch(/^\[.*\]$/s);
    expect(m).toContain('"giraffe"');
    expect(m).toMatch(/got it/i);
    expect(m).toMatch(/one short line/);
    expect(m).toMatch(/lie/);
    expect(m).toMatch(/wait for (their|the) next clue/i);
    expect(m).not.toMatch(/foul/i);
  });

  it('Reveal on Pass: names the Word, no lie call-out', () => {
    const m = clueRevealMessage('giraffe', 'pass', false);
    expect(m).toContain('"giraffe"');
    expect(m).toMatch(/pass/i);
    expect(m).not.toMatch(/lie/);
  });

  it('Reveal adds a Foul line when the Clues said the Word; the tilt stands', () => {
    const m = clueRevealMessage('giraffe', 'got', true);
    expect(m).toMatch(/foul/i);
    expect(m).toMatch(/still stands/);
    expect(m).toMatch(/^\[.*\]$/s);
  });

  it('recap after a Clue Round: score, Fouls, passed Words', () => {
    const c = clueRecapContext(
      'Sam',
      summary({
        fouls: 2,
        words: [
          { wordId: 'a', word: 'giraffe', outcome: 'got', foul: true },
          { wordId: 'b', word: 'lion', outcome: 'pass' },
          { wordId: 'c', word: 'zebra', outcome: 'unfinished', foul: true },
        ],
      }),
      true,
    );
    expect(c).toContain('Animals Round just ended');
    expect(c).toContain('NO word');
    expect(c).toContain('got 9 and passed 2');
    expect(c).toContain('new personal best');
    expect(c).toContain('Fouls (they said the word in their clues): giraffe, zebra.');
    expect(c).toContain('Passed words (fine to say now): lion.');
    expect(c).toContain('PLAYER: Sam.');
  });

  it('recap with no Fouls says nothing about Fouls', () => {
    const c = clueRecapContext('Sam', summary({ fouls: 0 }), false);
    expect(c).not.toMatch(/foul/i);
    expect(c).not.toContain('personal best');
  });
});

describe('Clue PAL context with Clue mode Training stats', () => {
  it('adds Rounds played, bests, Fouls and most-passed Words to the Player block', () => {
    for (const c of [
      clueLobbyContext('Sam', clueStats()),
      clueCountdownContext('Sam', 'animals', clueStats()),
      clueRoundContext('Sam', 'animals', 1, 0, clueStats()),
      clueRecapContext('Sam', summary(), false, clueStats()),
    ]) {
      expect(c).toContain('PLAYER: Sam.');
      expect(c).toContain('4 Clue Rounds played together so far.');
      expect(c).toContain('Personal bests together: Animals 11.');
      expect(c).toContain('Fouls so far (said the word in their clues): 3.');
      expect(c).toContain('Words you two pass most: otter.');
    }
  });

  it('says nothing more for a first Clue Round or a Foul-free record', () => {
    expect(clueLobbyContext('Sam', clueStats({ roundsPlayed: 0 }))).toBe(clueLobbyContext('Sam'));
    const c = clueLobbyContext('Sam', clueStats({ fouls: 0, mostPassed: [] }));
    expect(c).not.toMatch(/foul/i);
    expect(c).not.toContain('pass most');
  });
});

describe('clueGreeting', () => {
  it("is short, Maya's turn to guess, and names the Player when known", () => {
    expect(clueGreeting('Sam')).toMatch(/^Sam! My turn to guess\./);
    expect(clueGreeting('')).toMatch(/^My turn to guess!/);
    expect(clueGreeting('Sam').length).toBeLessThan(90);
  });
});

describe('swapRecap', () => {
  it('is one line naming the last score, Category and Mode', () => {
    expect(swapRecap('Sam', summary({ mode: 'guess', gotIt: 9 }))).toBe('Sam just scored 9 in Animals in Guess mode.');
    expect(swapRecap('', summary({ mode: 'clue', category: 'jobs', gotIt: 5, fouls: 2 }))).toBe(
      'The Player just scored 5 in Jobs in Clue mode, with 2 Fouls.',
    );
  });

  it('treats a stored summary without a Mode as Guess mode, and says nothing before any Round', () => {
    expect(swapRecap('Sam', summary({ mode: undefined, gotIt: 1 }))).toBe('Sam just scored 1 in Animals in Guess mode.');
    expect(swapRecap('Sam', null)).toBeNull();
  });
});
