import { describe, expect, it } from 'vitest';
import {
  DEMO_CYCLE_MS,
  DEMO_TIPPED_MS,
  DEMO_UPRIGHT_MS,
  DEMO_WORD,
  NUDGE_CYCLE_MS,
  NUDGE_DEMO_STILL,
  NUDGE_TIPPED_MS,
  NUDGE_UPRIGHT_MS,
  TILT_DEMO_STILL,
  nudgeDemoFrame,
  tiltDemoFrame,
} from './tiltDemoLoop';

const upright = { screen: { kind: 'word', word: '???' }, tip: 'upright' };
const got = { screen: { kind: 'flash', outcome: 'got', word: DEMO_WORD }, tip: 'forward' };
const pass = { screen: { kind: 'flash', outcome: 'pass', word: DEMO_WORD }, tip: 'back' };

const U = DEMO_UPRIGHT_MS;
const T = DEMO_TIPPED_MS;

describe('tilt demo loop', () => {
  it.each([
    ['both upright at the start', 0, upright, upright, U],
    ['Got it tips forward and flashes', U, got, upright, T],
    ['both upright again', U + T, upright, upright, U],
    ['Pass tips back and flashes', 2 * U + T, upright, pass, T],
    ['loops back to upright', DEMO_CYCLE_MS, upright, upright, U],
  ] as const)('%s', (_, at, gotView, passView, next) => {
    expect(tiltDemoFrame(at)).toEqual({ got: gotView, pass: passView, next });
  });

  it('counts down to the next change from inside a step', () => {
    expect(tiltDemoFrame(U + 400).next).toBe(T - 400);
    expect(tiltDemoFrame(DEMO_CYCLE_MS - 1).next).toBe(1);
  });

  it('never tips both phones at once', () => {
    for (let t = 0; t < 2 * DEMO_CYCLE_MS; t += 50) {
      const f = tiltDemoFrame(t);
      expect(f.got.tip === 'upright' || f.pass.tip === 'upright').toBe(true);
    }
  });

  it('never shows the Word while upright', () => {
    for (let t = 0; t < DEMO_CYCLE_MS; t += 50) {
      for (const v of [tiltDemoFrame(t).got, tiltDemoFrame(t).pass]) {
        if (v.tip === 'upright') expect(v.screen).toEqual(upright.screen);
      }
    }
  });

  it('holds each flash still under reduced motion', () => {
    expect(TILT_DEMO_STILL).toEqual({ got, pass });
  });
});

describe('nudge demo loop', () => {
  const NU = NUDGE_UPRIGHT_MS;
  const NT = NUDGE_TIPPED_MS;

  it('is faster than the lobby demo', () => {
    expect(NU).toBe(500);
    expect(NT).toBe(900);
  });

  it.each([
    ['upright at the start', 0, upright, NU],
    ['tips forward and flashes Got it', NU, got, NT],
    ['loops back to upright', NUDGE_CYCLE_MS, upright, NU],
  ] as const)('%s', (_, at, view, next) => {
    expect(nudgeDemoFrame(at)).toEqual({ view, next });
  });

  it('counts down to the next change from inside a step', () => {
    expect(nudgeDemoFrame(200).next).toBe(NU - 200);
    expect(nudgeDemoFrame(NUDGE_CYCLE_MS - 1).next).toBe(1);
  });

  it('only ever nods down, never shows the Word upright', () => {
    for (let t = 0; t < 2 * NUDGE_CYCLE_MS; t += 50) {
      expect([upright, got]).toContainEqual(nudgeDemoFrame(t).view);
    }
  });

  it('holds the Got it flash still under reduced motion', () => {
    expect(NUDGE_DEMO_STILL).toEqual(got);
  });
});
