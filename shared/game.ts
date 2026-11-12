// Domain types and tuning constants shared by the Worker (Room authority) and the browser (Stage, Controller).
// Terms follow CONTEXT.md.

import animals from './decks/animals.json';
import food from './decks/food.json';
import jobs from './decks/jobs.json';

export const ROUND_MS = 60_000;
export const COUNTDOWN_MS = 3_000;
/** Stage waits this long for the Word QR before injecting the Room's copy (ADR 0003). */
export const QR_FALLBACK_MS = 1_500;
/** Tilt nudges after Heard it with no tilt. */
export const NUDGE_DELAYS_MS = [2_500, 6_000] as const;
/** How long a word_guessed call waits for the Player's own words to say the Word before it is rejected. */
export const HEARD_CONFIRM_MS = 1_500;
/** How long the Controller shows the revealed Word after a tilt. */
export const REVEAL_MS = 600;
/** Silence after a Clue (PAL or Player stopped speaking) before the PAL gives a Silence nudge. */
export const SILENCE_NUDGE_MS = 2_500;
/** After injecting a Word or firing a Silence nudge: if the PAL hasn't spoken by then, push it again. */
export const FIRST_CLUE_RESCUE_MS = 4_000;
/** Silence nudges on one Word that make it a Freeze in the Round recap. */
export const FREEZE_NUDGES = 3;

export type Level = 'easy' | 'medium' | 'hard';
export type CategoryId = 'animals' | 'food' | 'jobs';
export type Outcome = 'got' | 'pass';

export interface Word {
  id: string;
  word: string;
  level: Level;
}

export interface Category {
  id: CategoryId;
  name: string;
  blurb: string;
  words: Word[];
}

export const CATEGORIES: Record<CategoryId, Category> = {
  animals: { id: 'animals', name: 'Animals', blurb: 'Easy', words: animals as Word[] },
  food: { id: 'food', name: 'Food & Drink', blurb: 'Medium', words: food as Word[] },
  jobs: { id: 'jobs', name: 'Jobs', blurb: 'Hard', words: jobs as Word[] },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export function isCategoryId(v: unknown): v is CategoryId {
  return typeof v === 'string' && v in CATEGORIES;
}
