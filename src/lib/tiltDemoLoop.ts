// Tilt demos: small phones (the PAL forehead drawing) acting out the Guess mode gestures, since the Player can't read
// the phone once it is on their forehead. Pure frame logic with time passed in; the components own the timers
// (useLoopElapsed).
//
// Lobby demo (Controller, before the Round): two phones. One loop: both upright, the Got it phone tips forward and
// flashes, both upright, the Pass phone tips back and flashes. Never both tipped at once.
//
// Nudge demo (Stage, after a Tilt nudge): one phone, faster: upright, tips forward and flashes Got it, repeat.

import type { Outcome } from '../../shared/game';
import type { ForeheadView } from '../stage/forehead';

/** How long both phones rest upright between tips. */
export const DEMO_UPRIGHT_MS = 1_200;
/** How long a phone stays tipped, flashing its Reveal. Longer than the game's REVEAL_MS so the flash can be read. */
export const DEMO_TIPPED_MS = 1_000;
export const DEMO_CYCLE_MS = 2 * (DEMO_UPRIGHT_MS + DEMO_TIPPED_MS);

/** The Word the demo Reveals. Upright it shows ??? : the Player never sees the Word on their own forehead. */
export const DEMO_WORD = 'Giraffe';

const UPRIGHT: ForeheadView = { screen: { kind: 'word', word: '???' }, tip: 'upright' };

const tipped = (outcome: Outcome): ForeheadView => ({
  screen: { kind: 'flash', outcome, word: DEMO_WORD },
  tip: outcome === 'got' ? 'forward' : 'back',
});

/** `elapsed` folded into one cycle, also for negative values. */
const inCycle = (elapsed: number, cycle: number) => ((elapsed % cycle) + cycle) % cycle;

export interface TiltDemoFrame {
  got: ForeheadView;
  pass: ForeheadView;
  /** ms from now until the frame changes. */
  next: number;
}

/** Reduced motion: no loop, each phone just shows its flash. */
export const TILT_DEMO_STILL: Omit<TiltDemoFrame, 'next'> = { got: tipped('got'), pass: tipped('pass') };

/** Both phones `elapsed` ms after the demo started. */
export function tiltDemoFrame(elapsed: number): TiltDemoFrame {
  const t = inCycle(elapsed, DEMO_CYCLE_MS);
  const gotAt = DEMO_UPRIGHT_MS;
  const gotEnd = gotAt + DEMO_TIPPED_MS;
  const passAt = gotEnd + DEMO_UPRIGHT_MS;
  if (t < gotAt) return { got: UPRIGHT, pass: UPRIGHT, next: gotAt - t };
  if (t < gotEnd) return { got: tipped('got'), pass: UPRIGHT, next: gotEnd - t };
  if (t < passAt) return { got: UPRIGHT, pass: UPRIGHT, next: passAt - t };
  return { got: UPRIGHT, pass: tipped('pass'), next: DEMO_CYCLE_MS - t };
}

/** Nudge demo: a short rest upright, then a long tip so the Got it flash reads at a glance. */
export const NUDGE_UPRIGHT_MS = 500;
export const NUDGE_TIPPED_MS = 900;
export const NUDGE_CYCLE_MS = NUDGE_UPRIGHT_MS + NUDGE_TIPPED_MS;

export interface NudgeDemoFrame {
  view: ForeheadView;
  /** ms from now until the frame changes. */
  next: number;
}

/** Reduced motion: no loop, the phone just shows the Got it flash. */
export const NUDGE_DEMO_STILL: ForeheadView = tipped('got');

/** The nudge phone `elapsed` ms after the demo started. */
export function nudgeDemoFrame(elapsed: number): NudgeDemoFrame {
  const t = inCycle(elapsed, NUDGE_CYCLE_MS);
  if (t < NUDGE_UPRIGHT_MS) return { view: UPRIGHT, next: NUDGE_UPRIGHT_MS - t };
  return { view: tipped('got'), next: NUDGE_CYCLE_MS - t };
}
