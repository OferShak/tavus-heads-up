import { describe, expect, it } from 'vitest';
import { COUNTDOWN_MS, FREEZE_NUDGES, ROUND_MS, type Word } from './game';
import {
  applyTilt,
  beginPlay,
  canStartRound,
  createRoom,
  endRound,
  joinController,
  markDecoded,
  markHeard,
  markLeak,
  markNudge,
  markSilenceNudge,
  nextAlarmAt,
  setPal,
  startRound,
  type Draw,
  type RoomState,
} from './room';

const T0 = 1_000_000;
const words: Word[] = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, word: `word${i}`, level: 'easy' }));
/** Deterministic draw: first unused word. */
const draw: Draw = (_pos, used) => words.find((w) => !used.has(w.id))!;

function playing(pal: 'ready' | 'offline' = 'ready'): RoomState {
  let s = createRoom('ABCD', T0);
  const j = joinController(s, { playerId: 'p1', nickname: 'Ofer' });
  if (!j.ok) throw new Error();
  s = setPal(j.state, { status: pal });
  s = startRound(s, 'animals', T0);
  return beginPlay(s, T0 + COUNTDOWN_MS, draw);
}

describe('joining', () => {
  it('moves waiting → lobby when the Controller joins', () => {
    const j = joinController(createRoom('ABCD', T0), { playerId: 'p1', nickname: '' });
    expect(j.ok && j.state.phase).toBe('lobby');
  });

  it('lets the same phone reconnect but turns away a second one', () => {
    const j = joinController(createRoom('ABCD', T0), { playerId: 'p1', nickname: '' });
    if (!j.ok) throw new Error();
    expect(joinController(j.state, { playerId: 'p1', nickname: 'x' }).ok).toBe(true);
    expect(joinController(j.state, { playerId: 'p2', nickname: '' })).toEqual({ ok: false, reason: 'room_taken' });
  });
});

describe('starting a Round', () => {
  it('waits for the PAL to be in the call (or offline dev mode)', () => {
    const j = joinController(createRoom('ABCD', T0), { playerId: 'p1', nickname: '' });
    if (!j.ok) throw new Error();
    expect(canStartRound(j.state)).toBe(false);
    expect(startRound(j.state, 'animals', T0)).toBe(j.state);
    expect(canStartRound(setPal(j.state, { status: 'offline' }))).toBe(true);
  });

  it('counts down, then draws the first Word and runs 60s', () => {
    const j = joinController(createRoom('ABCD', T0), { playerId: 'p1', nickname: '' });
    if (!j.ok) throw new Error();
    const s = startRound(setPal(j.state, { status: 'ready' }), 'food', T0);
    expect(s.phase).toBe('countdown');
    expect(nextAlarmAt(s)).toBe(T0 + COUNTDOWN_MS);
    const p = beginPlay(s, T0 + COUNTDOWN_MS, draw);
    expect(p.phase).toBe('playing');
    expect(p.round!.current!.wordId).toBe('w0');
    expect(nextAlarmAt(p)).toBe(T0 + COUNTDOWN_MS + ROUND_MS);
  });
});

describe('tilts', () => {
  it('accepts the first tilt for the current Word and advances', () => {
    const s = playing();
    const r = applyTilt(s, 'w0', 'got', T0 + 5000, draw);
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.result).toMatchObject({ wordId: 'w0', outcome: 'got' });
    expect(r.state.round!.current!.wordId).toBe('w1');
    expect(r.state.round!.current!.position).toBe(1);
  });

  it('ignores a stale or duplicate tilt', () => {
    const s = playing();
    const r1 = applyTilt(s, 'w0', 'got', T0 + 5000, draw);
    if (!r1.accepted) throw new Error();
    const dup = applyTilt(r1.state, 'w0', 'pass', T0 + 5050, draw);
    expect(dup.accepted).toBe(false);
    expect(dup.state).toBe(r1.state);
  });

  it('ignores tilts outside a playing Round or after time is up', () => {
    const s = playing();
    expect(applyTilt(s, 'w0', 'got', s.round!.endsAt, draw).accepted).toBe(false);
    expect(applyTilt(endRound(s), 'w0', 'got', T0, draw).accepted).toBe(false);
  });

  it('never repeats a Word within the Room, across Rounds', () => {
    let s = playing();
    for (let i = 0; i < 5; i++) {
      const r = applyTilt(s, s.round!.current!.wordId, 'pass', T0 + 4000 + i, draw);
      if (!r.accepted) throw new Error();
      s = r.state;
    }
    s = endRound(s);
    s = beginPlay(startRound(s, 'animals', T0 + 70_000), T0 + 73_000, draw);
    const seen = s.used;
    expect(new Set(seen).size).toBe(seen.length);
    expect(s.round!.current!.wordId).toBe('w6');
  });
});

describe('Heard it and Training stats', () => {
  it('records Heard it once and never scores from it', () => {
    let s = playing();
    s = markHeard(s, 'w0', T0 + 4000);
    s = markHeard(s, 'w0', T0 + 4500);
    expect(s.round!.current!.heardAt).toBe(T0 + 4000);
    expect(s.round!.results).toHaveLength(0);
  });

  it('ignores Heard it for a stale Word', () => {
    const s = playing();
    expect(markHeard(s, 'w9', T0)).toBe(s);
  });

  it('summarizes score, Reaction lag, QR decode and leaks', () => {
    let s = playing();
    const t = T0 + COUNTDOWN_MS;
    s = markDecoded(s, 'w0', 'qr', t + 400);
    s = markHeard(s, 'w0', t + 3000);
    s = markNudge(s, 'w0');
    let r = applyTilt(s, 'w0', 'got', t + 3800, draw);
    if (!r.accepted) throw new Error();
    s = markDecoded(r.state, 'w1', 'fallback', t + 5300);
    s = markLeak(s, 'w1');
    r = applyTilt(s, 'w1', 'pass', t + 9000, draw);
    if (!r.accepted) throw new Error();
    s = markHeard(r.state, 'w2', t + 10_000);
    r = applyTilt(s, 'w2', 'got', t + 11_000, draw);
    if (!r.accepted) throw new Error();
    const done = endRound(r.state);

    expect(done.phase).toBe('recap');
    expect(done.roundsPlayed).toBe(1);
    expect(done.lastSummary).toMatchObject({
      gotIt: 2,
      passed: 1,
      reactionLagMs: 900, // (800 + 1000) / 2
      heardCount: 2,
      qrDecoded: 1,
      qrFallback: 1,
      qrDecodeMs: 400,
      leaks: 1,
      nudges: 1,
      passedAfterHeard: 0,
      gotUnheard: 0,
    });
    expect(done.lastSummary!.words.map((w) => w.outcome)).toEqual(['got', 'pass', 'got', 'unfinished']);
  });
});

describe('Tilt slips', () => {
  const tilt = (s: RoomState, outcome: 'got' | 'pass', at: number) => {
    const r = applyTilt(s, s.round!.current!.wordId, outcome, at, draw);
    if (!r.accepted) throw new Error();
    return r.state;
  };

  it('records a late Heard it on the Word just tilted, outside Reaction lag', () => {
    let s = tilt(playing(), 'got', T0 + 5000);
    s = markHeard(s, 'w0', T0 + 5200);
    expect(s.round!.results[0].heardAt).toBe(T0 + 5200);
    expect(s.round!.current!.heardAt).toBeUndefined();
    // First call wins.
    expect(markHeard(s, 'w0', T0 + 5300)).toBe(s);
    expect(endRound(s).lastSummary).toMatchObject({ reactionLagMs: null, heardCount: 1, gotUnheard: 0 });
  });

  it('ignores Heard it for older or unknown Words, and outside play', () => {
    let s = tilt(playing(), 'pass', T0 + 5000);
    s = tilt(s, 'pass', T0 + 6000);
    expect(markHeard(s, 'w0', T0 + 6100)).toBe(s);
    expect(markHeard(s, 'w9', T0 + 6100)).toBe(s);
    const done = endRound(s);
    expect(markHeard(done, 'w1', T0 + 6100)).toBe(done);
  });

  it('counts Pass after Heard it and Got it never heard, and tags those Words', () => {
    let s = playing();
    s = markHeard(s, 'w0', T0 + 4000);
    s = tilt(s, 'pass', T0 + 4500); // passed after heard
    s = tilt(s, 'got', T0 + 6000); // got unheard
    s = markHeard(s, 'w2', T0 + 7000);
    s = tilt(s, 'got', T0 + 7500); // clean Got it
    s = tilt(s, 'pass', T0 + 9000); // clean Pass
    s = markHeard(s, 'w3', T0 + 9100); // late Heard it on a Pass: still a slip
    const sum = endRound(s).lastSummary!;
    expect(sum).toMatchObject({ gotIt: 2, passed: 2, passedAfterHeard: 2, gotUnheard: 1 });
    expect(sum.words.map((w) => w.slip)).toEqual(['passed_after_heard', 'got_unheard', undefined, 'passed_after_heard', undefined]);
    expect('slip' in sum.words[2]).toBe(false);
  });

  it('does not count Got it as unheard when the PAL was not in the call', () => {
    const s = tilt(playing('offline'), 'got', T0 + 5000);
    expect(s.round!.results[0].palReady).toBe(false);
    expect(endRound(s).lastSummary).toMatchObject({ gotIt: 1, gotUnheard: 0 });
  });
});

describe('Silence nudges', () => {
  const tilt = (s: RoomState, outcome: 'got' | 'pass', at: number) => {
    const r = applyTilt(s, s.round!.current!.wordId, outcome, at, draw);
    if (!r.accepted) throw new Error();
    return r.state;
  };
  const nudge = (s: RoomState, wordId: string, n: number) => {
    for (let i = 0; i < n; i++) s = markSilenceNudge(s, wordId);
    return s;
  };

  it('counts per current Word and carries the count onto the result', () => {
    let s = markSilenceNudge(playing(), 'w0');
    expect(s.round!.current!.silenceNudges).toBe(1);
    expect(markSilenceNudge(s, 'w9')).toBe(s); // not the current Word
    s = tilt(s, 'pass', T0 + 5000);
    expect(s.round!.results[0].silenceNudges).toBe(1);
    expect(markSilenceNudge(s, 'w0')).toBe(s); // already tilted
    const done = endRound(s);
    expect(markSilenceNudge(done, 'w1')).toBe(done); // outside play
  });

  it('totals Silence nudges and flags a Freeze at FREEZE_NUDGES', () => {
    let s = nudge(playing(), 'w0', FREEZE_NUDGES - 1);
    s = tilt(s, 'got', T0 + 5000);
    s = nudge(s, 'w1', FREEZE_NUDGES);
    s = tilt(s, 'pass', T0 + 9000);
    s = nudge(s, 'w2', FREEZE_NUDGES + 1); // unfinished at the buzzer
    const sum = endRound(s).lastSummary!;
    expect(sum.silenceNudges).toBe(3 * FREEZE_NUDGES);
    expect(sum.words.map((w) => w.freeze)).toEqual([undefined, true, true]);
    expect('freeze' in sum.words[0]).toBe(false);
    expect(endRound(playing()).lastSummary!.silenceNudges).toBe(0);
  });
});
