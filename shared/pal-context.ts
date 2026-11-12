// What the PAL is told about the game. Built in one place so the Worker (conversation creation) and the
// Stage (live context overwrites) always send the same shape. Overwrites replace the whole conversational
// context, so every variant carries the Player block.

import { CATEGORIES, type CategoryId } from './game';
import type { PlayerSummary } from './protocol';
import type { RoundSummary } from './room';

export function playerBlock(nickname: string, stats: PlayerSummary | null): string {
  const name = nickname || 'the Player';
  if (!stats || stats.roundsPlayed === 0) return `PLAYER: ${name}. First time training with you.`;
  const bests = (Object.entries(stats.bests) as [CategoryId, number][])
    .map(([c, n]) => `${CATEGORIES[c].name} ${n}`)
    .join(', ');
  const lines = [
    `PLAYER: ${name}. ${stats.roundsPlayed} Rounds played with you so far.`,
    bests && `Personal bests: ${bests}.`,
    stats.reactionLagMs !== null && `Average reaction lag (you say "yes" → they tilt): ${(stats.reactionLagMs / 1000).toFixed(1)}s.`,
    stats.mostPassed.length > 0 && `Words they pass most: ${stats.mostPassed.map((w) => w.word).join(', ')}.`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function lobbyContext(nickname: string, stats: PlayerSummary | null): string {
  return [
    'GAME STATE: no Round is running. There is NO secret word right now.',
    playerBlock(nickname, stats),
    'Chat briefly (one or two sentences), trash-talk a little, and tell them to pick a Category on their phone and put it on their forehead.',
  ].join('\n');
}

export function countdownContext(nickname: string, stats: PlayerSummary | null, category: CategoryId): string {
  return [
    `GAME STATE: a ${CATEGORIES[category].name} Round is about to start. No secret word yet. Hype them up in a few words, nothing more.`,
    playerBlock(nickname, stats),
  ].join('\n');
}

export function wordContext(nickname: string, stats: PlayerSummary | null, category: CategoryId, word: string): string {
  return [
    `GAME STATE: Round in progress. Category: ${CATEGORIES[category].name}.`,
    `CURRENT SECRET WORD: "${word}". Never say it or any part of it. Clue only this word; earlier words are gone.`,
    `Earlier words are closed: if the Player says one it doesn't count, so tell them that one's gone and keep clueing the current word. Only call word_guessed for the CURRENT SECRET WORD.`,
    playerBlock(nickname, stats),
  ].join('\n');
}

export function recapContext(nickname: string, stats: PlayerSummary | null, s: RoundSummary, personalBest: boolean): string {
  const passed = s.words.filter((w) => w.outcome === 'pass').map((w) => w.word);
  const slipped = (slip: NonNullable<RoundSummary['words'][number]['slip']>) => s.words.filter((w) => w.slip === slip).map((w) => w.word);
  const passedAfterHeard = slipped('passed_after_heard');
  const gotUnheard = slipped('got_unheard');
  const froze = s.words.filter((w) => w.freeze).map((w) => w.word);
  return [
    `GAME STATE: the ${CATEGORIES[s.category].name} Round just ended. There is NO secret word right now.`,
    `They got ${s.gotIt} and passed ${s.passed}${personalBest ? ' (a new personal best!)' : ''}.`,
    passed.length > 0 && `Passed words (fine to say now): ${passed.join(', ')}.`,
    passedAfterHeard.length > 0 && `Passed even though they'd already said it: ${passedAfterHeard.join(', ')}. Tease them about it.`,
    gotUnheard.length > 0 && `Tilted Got it but you never heard them say it: ${gotUnheard.join(', ')}. Call it out playfully.`,
    froze.length > 0 && `They froze on: ${froze.join(', ')} (you had to tell them to pass). Tease them about it.`,
    playerBlock(nickname, stats),
  ]
    .filter(Boolean)
    .join('\n');
}

export function greeting(nickname: string): string {
  return nickname
    ? `Hey ${nickname}! Think you can keep up? Pick a category on your phone and stick it on your forehead.`
    : `Hey! Think you can keep up? Pick a category on your phone and stick it on your forehead.`;
}
