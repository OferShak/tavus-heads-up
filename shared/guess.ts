// Did the Player say the Word? Used to confirm the PAL's word_guessed call (Heard it) against the Player's own speech.

import { tokens } from './leak';

/** Endings a spoken form may add to the Word: plurals and other short suffixes ("painters", "baked"). */
const SUFFIXES = ['', 's', 'es', 'ed', 'd', 'ing'];
const MAX_SUFFIX_LEN = 3;

function matchesWithSuffix(said: string, target: string): boolean {
  if (SUFFIXES.some((s) => said === target + s)) return true;
  // y → ies plural ("butterfly" → "butterflies").
  return target.endsWith('y') && said === target.slice(0, -1) + 'ies';
}

/**
 * True if the utterance says the Word, case and punctuation aside. Compares whole tokens, never raw substrings
 * ("education" does not say "cat"), and joins runs of consecutive tokens so split or merged forms match
 * ("fire fighter" says "firefighter", "icecream" says "ice cream").
 */
export function saysWord(utterance: string, word: string): boolean {
  const target = tokens(word).join('');
  if (!target) return false;
  const said = tokens(utterance);
  const maxLen = target.length + MAX_SUFFIX_LEN;
  for (let i = 0; i < said.length; i++) {
    let run = '';
    for (let j = i; j < said.length; j++) {
      run += said[j];
      if (run.length > maxLen) break;
      if (matchesWithSuffix(run, target)) return true;
    }
  }
  return false;
}
