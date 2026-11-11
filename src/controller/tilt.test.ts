import { describe, expect, it } from 'vitest';
import { INITIAL_TILT, screenPitch, tiltStep, type TiltState } from './tilt';
import type { Outcome } from '../../shared/game';

describe('screenPitch', () => {
  it('is +90 flat face-up, -90 face-down, ~0 upright', () => {
    expect(screenPitch(0, 0)).toBeCloseTo(90);
    expect(screenPitch(180, 0)).toBeCloseTo(-90);
    expect(screenPitch(90, 0)).toBeCloseTo(0); // portrait upright
    expect(screenPitch(0, -90)).toBeCloseTo(0); // landscape upright
  });

  it('is continuous through the landscape gamma wrap (-90 → +90 with beta flipping to 180)', () => {
    // Landscape on the forehead, nodding down 10° past vertical: gamma wraps to +80, beta to ~180.
    expect(screenPitch(0, -80)).toBeCloseTo(10); // 10° back: screen slightly up
    expect(screenPitch(180, 80)).toBeCloseTo(-10); // 10° forward: screen slightly down
    expect(screenPitch(-180, 80)).toBeCloseTo(-10);
  });

  it('works the same in the other landscape direction', () => {
    expect(screenPitch(0, 80)).toBeCloseTo(10);
    expect(screenPitch(180, -50)).toBeCloseTo(-40);
  });
});

function run(pitches: number[]): Outcome[] {
  let s: TiltState = INITIAL_TILT;
  const fired: Outcome[] = [];
  for (const p of pitches) {
    const r = tiltStep(s, p);
    s = r.state;
    if (r.fire) fired.push(r.fire);
  }
  return fired;
}

describe('tiltStep', () => {
  it('nod down = Got it, tilt back = Pass', () => {
    expect(run([0, -40])).toEqual(['got']);
    expect(run([0, 40])).toEqual(['pass']);
  });

  it('does not fire before the phone was upright (picked up from the table)', () => {
    expect(run([80, 60, 40])).toEqual([]);
    expect(run([80, 60, 10, 40])).toEqual(['pass']);
  });

  it('must return to neutral before the next tilt fires', () => {
    expect(run([0, -40, -60, -40, -30])).toEqual(['got']);
    expect(run([0, -40, -25, -10, -45])).toEqual(['got', 'got']);
  });

  it('ignores small wobbles', () => {
    expect(run([0, 15, -20, 30, -34, 5])).toEqual([]);
  });
});
