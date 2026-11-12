// Foul (Clue mode): did the Player's own Clues say the Word? Judged one transcribed utterance at a time.

import type { Who } from './game';
import { saysWord } from './guess';

/** What one utterance means for the Foul rule: the PAL said the Word, the Player fouled it, or nothing. */
export type SaidVerdict = 'pal_said' | 'foul' | null;

/**
 * The Player's speech fouls the Word only until the PAL's own speech has said it: once the PAL guessed it,
 * "yes, giraffe!" is just confirming, like real friends. Matches like saysWord (whole Word, plurals, split or
 * merged forms), so part of a multi-word Word is not a Foul.
 */
export function judgeSaid(word: string, who: Who, text: string, palHasSaid: boolean): SaidVerdict {
  if (!saysWord(text, word)) return null;
  if (who === 'pal') return 'pal_said';
  return palHasSaid ? null : 'foul';
}
