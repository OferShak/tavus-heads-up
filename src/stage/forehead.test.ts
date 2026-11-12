import { describe, expect, it } from 'vitest';
import { REVEAL_MS, TILT_UNLOCK_MS } from '../../shared/game';
import { foreheadStep, foreheadView, INITIAL_FOREHEAD, nextForeheadDeadline, type ForeheadEvent, type ForeheadState } from './forehead';

const ZEBRA = { wordId: 'a1', word: 'Zebra' };
const OTTER = { wordId: 'a2', word: 'Otter' };

/** Feed events at the given times; returns the final state. */
function play(events: [number, ForeheadEvent][], from: ForeheadState = INITIAL_FOREHEAD): ForeheadState {
  return events.reduce((s, [now, e]) => foreheadStep(s, e, now).state, from);
}

describe('PAL forehead lifecycle', () => {
  it('is hidden before a Round', () => {
    expect(foreheadView(INITIAL_FOREHEAD)).toEqual({ screen: { kind: 'hidden' }, tip: 'upright' });
  });

  it('comes up for the countdown, then shows the first Word', () => {
    const s = play([
      [0, { type: 'countdown', n: 3 }],
      [1000, { type: 'countdown', n: 2 }],
    ]);
    expect(foreheadView(s)).toEqual({ screen: { kind: 'countdown', n: 2 }, tip: 'upright' });
    const s2 = play([[3000, { type: 'word', ...ZEBRA }]], s);
    expect(foreheadView(s2)).toEqual({ screen: { kind: 'word', word: 'Zebra' }, tip: 'upright' });
  });
});

/** Playing Zebra since t=3000. */
const onZebra = () => play([[0, { type: 'countdown', n: 3 }], [3000, { type: 'word', ...ZEBRA }]]);

describe('PAL tilt', () => {
  it.each([
    ['got', 'forward'],
    ['pass', 'back'],
  ] as const)('%s tips %s at once, flashes the finished Word and asks to forward the tilt', (outcome, tip) => {
    const r = foreheadStep(onZebra(), { type: 'tilt', outcome }, 5000);
    expect(r.forward).toEqual({ wordId: 'a1', outcome });
    expect(foreheadView(r.state)).toEqual({ screen: { kind: 'flash', outcome, word: 'Zebra' }, tip });
  });

  it('comes back upright with the next Word once the flash is over', () => {
    const s = play(
      [
        [5000, { type: 'tilt', outcome: 'got' }],
        [5050, { type: 'word', ...OTTER }],
      ],
      onZebra(),
    );
    expect(foreheadView(play([[5000 + REVEAL_MS - 1, { type: 'tick' }]], s)).screen.kind).toBe('flash');
    expect(foreheadView(play([[5000 + REVEAL_MS, { type: 'tick' }]], s))).toEqual({
      screen: { kind: 'word', word: 'Otter' },
      tip: 'upright',
    });
  });

  it('holds the flash past REVEAL_MS while the Room is slow to send the next Word', () => {
    const s = play(
      [
        [5000, { type: 'tilt', outcome: 'pass' }],
        [5000 + REVEAL_MS, { type: 'tick' }],
        [6200, { type: 'tick' }],
      ],
      onZebra(),
    );
    expect(foreheadView(s)).toEqual({ screen: { kind: 'flash', outcome: 'pass', word: 'Zebra' }, tip: 'back' });
    expect(foreheadView(play([[6300, { type: 'word', ...OTTER }]], s))).toEqual({
      screen: { kind: 'word', word: 'Otter' },
      tip: 'upright',
    });
  });
});

describe('tilt guard (one tilt per Word, like the Controller)', () => {
  it('ignores a double tilt: only the first is forwarded', () => {
    const first = foreheadStep(onZebra(), { type: 'tilt', outcome: 'got' }, 5000);
    const second = foreheadStep(first.state, { type: 'tilt', outcome: 'pass' }, 5010);
    expect(second.forward).toBeNull();
    expect(foreheadView(second.state)).toEqual(foreheadView(first.state));
  });

  it('ignores a tilt during the flash, even once the next Word is in', () => {
    const s = play(
      [
        [5000, { type: 'tilt', outcome: 'got' }],
        [5050, { type: 'word', ...OTTER }],
      ],
      onZebra(),
    );
    const r = foreheadStep(s, { type: 'tilt', outcome: 'pass' }, 5300);
    expect(r.forward).toBeNull();
    expect(foreheadView(r.state).screen).toEqual({ kind: 'flash', outcome: 'got', word: 'Zebra' });
  });

  it('ignores a tilt for a Word already tilted while the Room has not moved on', () => {
    const s = play([[5000, { type: 'tilt', outcome: 'got' }], [5000 + REVEAL_MS + 100, { type: 'tick' }]], onZebra());
    expect(foreheadStep(s, { type: 'tilt', outcome: 'got' }, 5000 + REVEAL_MS + 200).forward).toBeNull();
  });

  it('accepts a tilt on the next Word once the flash is over', () => {
    const s = play(
      [
        [5000, { type: 'tilt', outcome: 'got' }],
        [5050, { type: 'word', ...OTTER }],
        [5000 + REVEAL_MS, { type: 'tick' }],
      ],
      onZebra(),
    );
    expect(foreheadStep(s, { type: 'tilt', outcome: 'pass' }, 6000).forward).toEqual({ wordId: 'a2', outcome: 'pass' });
  });

  it('unlocks a lost tilt: no new Word TILT_UNLOCK_MS after it, the same Word is back and can be tilted again', () => {
    const tilted = play([[5000, { type: 'tilt', outcome: 'got' }]], onZebra());
    const before = play([[5000 + TILT_UNLOCK_MS - 1, { type: 'tick' }]], tilted);
    expect(foreheadView(before).screen.kind).toBe('flash');
    expect(foreheadStep(before, { type: 'tilt', outcome: 'got' }, 5000 + TILT_UNLOCK_MS - 1).forward).toBeNull();

    const after = play([[5000 + TILT_UNLOCK_MS, { type: 'tick' }]], tilted);
    expect(foreheadView(after)).toEqual({ screen: { kind: 'word', word: 'Zebra' }, tip: 'upright' });
    expect(foreheadStep(after, { type: 'tilt', outcome: 'got' }, 8000).forward).toEqual({ wordId: 'a1', outcome: 'got' });
  });

  it('unlocks on a late tilt even without a tick in between', () => {
    const tilted = play([[5000, { type: 'tilt', outcome: 'got' }]], onZebra());
    expect(foreheadStep(tilted, { type: 'tilt', outcome: 'pass' }, 5000 + TILT_UNLOCK_MS).forward).toEqual({
      wordId: 'a1',
      outcome: 'pass',
    });
  });

  it('ignores tilts with no Word in play (lobby, countdown)', () => {
    expect(foreheadStep(INITIAL_FOREHEAD, { type: 'tilt', outcome: 'got' }, 0).forward).toBeNull();
    const counting = play([[0, { type: 'countdown', n: 3 }]]);
    const r = foreheadStep(counting, { type: 'tilt', outcome: 'got' }, 100);
    expect(r.forward).toBeNull();
    expect(foreheadView(r.state).screen).toEqual({ kind: 'countdown', n: 3 });
  });
});

describe("time's up", () => {
  it("shows Time's up for REVEAL_MS, then the phone goes away", () => {
    const s = play([[60_000, { type: 'timesUp' }]], onZebra());
    expect(foreheadView(s)).toEqual({ screen: { kind: 'timesUp' }, tip: 'upright' });
    expect(foreheadView(play([[60_000 + REVEAL_MS - 1, { type: 'tick' }]], s)).screen.kind).toBe('timesUp');
    expect(foreheadView(play([[60_000 + REVEAL_MS, { type: 'tick' }]], s)).screen).toEqual({ kind: 'hidden' });
  });

  it('lets a running flash finish first, without waiting for a next Word', () => {
    const s = play(
      [
        [59_800, { type: 'tilt', outcome: 'got' }],
        [60_000, { type: 'timesUp' }],
      ],
      onZebra(),
    );
    expect(foreheadView(s).screen).toEqual({ kind: 'flash', outcome: 'got', word: 'Zebra' });
    const flashDone = play([[59_800 + REVEAL_MS, { type: 'tick' }]], s);
    expect(foreheadView(flashDone)).toEqual({ screen: { kind: 'timesUp' }, tip: 'upright' });
    expect(foreheadView(play([[59_800 + 2 * REVEAL_MS, { type: 'tick' }]], flashDone)).screen).toEqual({ kind: 'hidden' });
  });

  it('ignores tilts and late Words once time is up', () => {
    const s = play([[60_000, { type: 'timesUp' }]], onZebra());
    const r = foreheadStep(s, { type: 'tilt', outcome: 'got' }, 60_100);
    expect(r.forward).toBeNull();
    expect(foreheadView(play([[60_200, { type: 'word', ...OTTER }]], r.state)).screen).toEqual({ kind: 'timesUp' });
  });

  it("still shows Time's up for REVEAL_MS when it lands on a tilt the Room never answered", () => {
    const s = play(
      [
        [58_000, { type: 'tilt', outcome: 'got' }],
        [60_000, { type: 'timesUp' }],
      ],
      onZebra(),
    );
    expect(foreheadView(s).screen).toEqual({ kind: 'timesUp' });
    expect(foreheadView(play([[60_000 + REVEAL_MS, { type: 'tick' }]], s)).screen).toEqual({ kind: 'hidden' });
  });

  it('stays hidden when no phone was up (the Stage joined at the recap)', () => {
    expect(foreheadView(play([[0, { type: 'timesUp' }]])).screen).toEqual({ kind: 'hidden' });
  });
});

describe('nextForeheadDeadline (when the caller should tick)', () => {
  it('is null with nothing timed going on', () => {
    expect(nextForeheadDeadline(INITIAL_FOREHEAD, 0)).toBeNull();
    expect(nextForeheadDeadline(onZebra(), 4000)).toBeNull();
  });

  it('is the flash end, then the lost-tilt unlock', () => {
    const s = play([[5000, { type: 'tilt', outcome: 'got' }]], onZebra());
    expect(nextForeheadDeadline(s, 5000)).toBe(5000 + REVEAL_MS);
    expect(nextForeheadDeadline(s, 5000 + REVEAL_MS)).toBe(5000 + TILT_UNLOCK_MS);
  });

  it("is when Time's up goes away", () => {
    const s = play([[60_000, { type: 'timesUp' }]], onZebra());
    expect(nextForeheadDeadline(s, 60_000)).toBe(60_000 + REVEAL_MS);
  });
});

describe('hidden outside a Round', () => {
  it('goes away at once in the lobby, and comes back for the next countdown', () => {
    const s = play([[5000, { type: 'tilt', outcome: 'got' }], [5100, { type: 'hide' }]], onZebra());
    expect(foreheadView(s)).toEqual({ screen: { kind: 'hidden' }, tip: 'upright' });
    expect(foreheadStep(s, { type: 'tilt', outcome: 'got' }, 5200).forward).toBeNull();
    expect(foreheadView(play([[9000, { type: 'countdown', n: 3 }]], s)).screen).toEqual({ kind: 'countdown', n: 3 });
  });
});
