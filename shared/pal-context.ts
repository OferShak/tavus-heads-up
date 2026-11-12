// What the PAL is told about the game. Built in one place so the Worker (conversation creation) and the
// Stage (live context overwrites) always send the same shape. Overwrites replace the whole conversational
// context, so every variant carries the Player block.

import { CATEGORIES, type CategoryId, type Outcome } from './game';
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

// ---------- Clue mode: the Clue PAL guesses (ADR 0004) ----------
// The Clue PAL is NEVER given the current Word: no builder below takes it. It only hears a Word in its Reveal,
// after its own tilt. `stats` are the Player's Clue mode Training stats (optional: just the name without them).

function cluePlayerBlock(nickname: string, stats: PlayerSummary | null = null): string {
  const first = `PLAYER: ${nickname || 'the Player'}. They give the clues; you guess.`;
  if (!stats || stats.roundsPlayed === 0) return first;
  const bests = (Object.entries(stats.bests) as [CategoryId, number][])
    .map(([c, n]) => `${CATEGORIES[c].name} ${n}`)
    .join(', ');
  const lines = [
    first,
    `${stats.roundsPlayed} Clue Rounds played together so far.`,
    bests && `Personal bests together: ${bests}.`,
    stats.fouls > 0 && `Fouls so far (said the word in their clues): ${stats.fouls}.`,
    stats.mostPassed.length > 0 && `Words you two pass most: ${stats.mostPassed.map((w) => w.word).join(', ')}.`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function clueLobbyContext(nickname: string, stats: PlayerSummary | null = null): string {
  return [
    'GAME STATE: no Round is running. There is NO word on your forehead right now.',
    cluePlayerBlock(nickname, stats),
    "Chat briefly (one or two sentences), trash-talk a little, and tell them to pick a Category on their phone; you'll do the guessing.",
  ].join('\n');
}

export function clueCountdownContext(nickname: string, category: CategoryId, stats: PlayerSummary | null = null): string {
  return [
    `GAME STATE: a ${CATEGORIES[category].name} Round is about to start. You're guessing. Hype them up in a few words, nothing more.`,
    cluePlayerBlock(nickname, stats),
  ].join('\n');
}

/** wordNumber: 1-based position of the Word in play. score: Got its so far. */
export function clueRoundContext(nickname: string, category: CategoryId, wordNumber: number, score: number, stats: PlayerSummary | null = null): string {
  return [
    `GAME STATE: Round in progress. Category: ${CATEGORIES[category].name}. You're on word #${wordNumber}. Score so far: ${score}.`,
    "You can't see the word: guess only from their clues, faces and miming. Earlier words are closed.",
    'Call tilt only on their say-so: down when they say you got it, up when they say skip it.',
    cluePlayerBlock(nickname, stats),
  ].join('\n');
}

/** The Reveal, told to the PAL after its tilt: the Word just tilted, the outcome, and a Foul line when fouled. */
export function clueRevealMessage(word: string, outcome: Outcome, foul: boolean): string {
  const lines = [
    outcome === 'got' ? `Reveal: you got it, the word was "${word}".` : `Reveal: you passed, the word was "${word}".`,
    outcome === 'got' && `If your last guess when they said yes wasn't "${word}", they lied to you: call it out.`,
    foul && `FOUL: their clues said "${word}" itself. Call the Foul out in character; the tilt still stands.`,
    'React in one short line, then wait for their next clue. A new word is on your forehead now.',
  ];
  return `[${lines.filter(Boolean).join(' ')}]`;
}

export function clueRecapContext(nickname: string, s: RoundSummary, personalBest: boolean, stats: PlayerSummary | null = null): string {
  const passed = s.words.filter((w) => w.outcome === 'pass').map((w) => w.word);
  const fouled = s.words.filter((w) => w.foul).map((w) => w.word);
  return [
    `GAME STATE: the ${CATEGORIES[s.category].name} Round just ended. There is NO word on your forehead right now.`,
    `Together you got ${s.gotIt} and passed ${s.passed}${personalBest ? ' (a new personal best!)' : ''}.`,
    passed.length > 0 && `Passed words (fine to say now): ${passed.join(', ')}.`,
    fouled.length > 0 && `Fouls (they said the word in their clues): ${fouled.join(', ')}. Tease them about it.`,
    cluePlayerBlock(nickname, stats),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Maya's custom_greeting when her conversation starts (the swap into Clue mode): her turn to guess. */
export function clueGreeting(nickname: string): string {
  return nickname
    ? `${nickname}! My turn to guess. Pick a category on your phone and start clueing me!`
    : `My turn to guess! Pick a category on your phone and start clueing me!`;
}

/**
 * One line for the new friend's conversational_context when the Mode changes (ADR 0004), e.g.
 * "Sam just scored 9 in Animals in Guess mode." Null before any Round.
 */
export function swapRecap(nickname: string, last: RoundSummary | null): string | null {
  if (!last) return null;
  const mode = last.mode === 'clue' ? 'Clue' : 'Guess';
  const fouls = last.mode === 'clue' && last.fouls ? `, with ${last.fouls} Foul${last.fouls === 1 ? '' : 's'}` : '';
  return `${nickname || 'The Player'} just scored ${last.gotIt} in ${CATEGORIES[last.category].name} in ${mode} mode${fouls}.`;
}
