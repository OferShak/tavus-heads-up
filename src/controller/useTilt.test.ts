import { describe, expect, it } from 'vitest';
import { INITIAL_TILT, type TiltState } from './tilt';
import { orientationStep } from './useTilt';

// Portrait: beta 90 = upright on the forehead, beta 140 = nodded down (screen to the floor), beta 40 = tilted back.
const UPRIGHT = [90, 0] as const;
const DOWN = [140, 0] as const;
const UP = [40, 0] as const;

function run(readings: (readonly [number, number])[], enabled = true, s: TiltState = INITIAL_TILT) {
  const fired: string[] = [];
  for (const [b, g] of readings) {
    const r = orientationStep(s, b, g, enabled);
    s = r.state;
    if (r.fire) fired.push(r.fire);
  }
  return { fired, state: s };
}

describe('orientationStep', () => {
  it('ignores empty readings (desktop browsers send nulls)', () => {
    const armed = { armed: true };
    expect(orientationStep(armed, null, null, true)).toEqual({ state: armed, valid: false });
    expect(orientationStep(armed, 90, null, true).valid).toBe(false);
  });

  it('fires Got it on a nod down and Pass on a tilt back, after seeing upright', () => {
    expect(run([UPRIGHT, DOWN]).fired).toEqual(['got']);
    expect(run([UPRIGHT, UP]).fired).toEqual(['pass']);
  });

  it('never fires while disabled and stays disarmed, so the next Word needs upright first', () => {
    const disabled = run([UPRIGHT, DOWN, UPRIGHT], false);
    expect(disabled.fired).toEqual([]);
    expect(disabled.state).toEqual(INITIAL_TILT);
    // Re-enabled while still tilted down: nothing until it comes back upright.
    expect(run([DOWN, DOWN], true, disabled.state).fired).toEqual([]);
    expect(run([DOWN, UPRIGHT, DOWN], true, disabled.state).fired).toEqual(['got']);
  });
});
