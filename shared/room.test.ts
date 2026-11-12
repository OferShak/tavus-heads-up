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
  markSaid,
  markSilenceNudge,
  nextAlarmAt,
  selectMode,
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

function lobby(): RoomState {
  const j = joinController(createRoom('ABCD', T0), { playerId: 'p1', nickname: 'Ofer' });
  if (!j.ok) throw new Error();
  return j.state;
}

/** A Clue Round in play with the Clue PAL (Maya) in the call. */
function playingClue(): RoomState {
  let s = selectMode(lobby(), 'clue');
  s = setPal(s, { status: 'ready', mode: 'clue' });
  s = startRound(s, 'animals', T0);
  return beginPlay(s, T0 + COUNTDOWN_MS, draw);
}

describe('Mode', () => {
  it('defaults to Guess mode', () => {
    expect(createRoom('ABCD', T0).mode).toBe('guess');
    expect(playing().round!.mode).toBe('guess');
  });

  it('can be selected in the lobby or recap only', () => {
    expect(selectMode(lobby(), 'clue').mode).toBe('clue');
    const recap = endRound(playing());
    expect(selectMode(recap, 'clue').mode).toBe('clue');
    const waiting = createRoom('ABCD', T0);
    expect(selectMode(waiting, 'clue')).toBe(waiting);
    const s = playing();
    expect(selectMode(s, 'clue')).toBe(s);
    const countdown = startRound(setPal(lobby(), { status: 'ready' }), 'animals', T0);
    expect(selectMode(countdown, 'clue')).toBe(countdown);
  });

  it('returns the same state when the Mode is unchanged', () => {
    const s = lobby();
    expect(selectMode(s, 'guess')).toBe(s);
  });

  it("starts a Round only when the PAL in the call is the selected Mode's friend (or offline)", () => {
    const clue = selectMode(lobby(), 'clue');
    expect(canStartRound(setPal(clue, { status: 'ready' }))).toBe(false); // no mode: the Guess friend
    expect(canStartRound(setPal(clue, { status: 'ready', mode: 'guess' }))).toBe(false);
    expect(canStartRound(setPal(clue, { status: 'ready', mode: 'clue' }))).toBe(true);
    expect(canStartRound(setPal(clue, { status: 'offline' }))).toBe(true);
    expect(canStartRound(setPal(lobby(), { status: 'ready', mode: 'clue' }))).toBe(false);
    expect(canStartRound(setPal(lobby(), { status: 'ready', mode: 'guess' }))).toBe(true);
  });

  it('records the selected Mode on the Round and its summary', () => {
    const s = playingClue();
    expect(s.round!.mode).toBe('clue');
    expect(endRound(s).lastSummary!.mode).toBe('clue');
    expect(endRound(playing()).lastSummary!.mode).toBe('guess');
  });

  it('never repeats a Word across Modes', () => {
    const passAll = (s: RoomState, n: number, at: number, by: 'player' | 'pal') => {
      for (let i = 0; i < n; i++) {
        const r = applyTilt(s, s.round!.current!.wordId, 'pass', at + i, draw, by);
        if (!r.accepted) throw new Error();
        s = r.state;
      }
      return s;
    };
    const drawn = (s: RoomState) => s.round!.results.map((r) => r.wordId).concat(s.round!.current ? [s.round!.current.wordId] : []);

    // Guess, then Clue.
    let s = passAll(playing(), 3, T0 + 4000, 'player');
    const guessWords = drawn(s);
    s = selectMode(endRound(s), 'clue');
    s = beginPlay(startRound(setPal(s, { status: 'ready', mode: 'clue' }), 'animals', T0 + 70_000), T0 + 73_000, draw);
    s = passAll(s, 3, T0 + 74_000, 'pal');
    expect(drawn(s).filter((w) => guessWords.includes(w))).toEqual([]);

    // Clue, then Guess.
    let c = passAll(playingClue(), 3, T0 + 4000, 'pal');
    const clueWords = drawn(c);
    c = selectMode(endRound(c), 'guess');
    c = beginPlay(startRound(setPal(c, { status: 'ready', mode: 'guess' }), 'animals', T0 + 70_000), T0 + 73_000, draw);
    expect(c.round!.mode).toBe('guess');
    expect(clueWords).not.toContain(c.round!.current!.wordId);
    expect(new Set(c.used).size).toBe(c.used.length);
  });
});

describe('who tilts', () => {
  it('Guess Rounds accept only the Player tilt', () => {
    const s = playing();
    expect(applyTilt(s, 'w0', 'got', T0 + 5000, draw, 'pal')).toEqual({ accepted: false, state: s });
    const r = applyTilt(s, 'w0', 'got', T0 + 5000, draw, 'player');
    expect(r.accepted && r.result.by).toBe('player');
  });

  it('Clue Rounds accept only the PAL tilt; the Controller is idle', () => {
    const s = playingClue();
    expect(applyTilt(s, 'w0', 'got', T0 + 5000, draw).accepted).toBe(false); // default: the Player
    expect(applyTilt(s, 'w0', 'got', T0 + 5000, draw, 'player').accepted).toBe(false);
    const r = applyTilt(s, 'w0', 'got', T0 + 5000, draw, 'pal');
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.result).toMatchObject({ wordId: 'w0', outcome: 'got', by: 'pal' });
    expect(r.state.round!.current!.wordId).toBe('w1');
  });

  it('keeps first-tilt-wins and stale wordId rules for the PAL tilt', () => {
    const r1 = applyTilt(playingClue(), 'w0', 'pass', T0 + 5000, draw, 'pal');
    if (!r1.accepted) throw new Error();
    expect(applyTilt(r1.state, 'w0', 'got', T0 + 5050, draw, 'pal').accepted).toBe(false);
    expect(applyTilt(r1.state, 'w9', 'got', T0 + 5050, draw, 'pal').accepted).toBe(false);
    expect(applyTilt(r1.state, 'w1', 'got', r1.state.round!.endsAt, draw, 'pal').accepted).toBe(false);
  });
});

describe('Fouls (Clue mode)', () => {
  const palTilt = (s: RoomState, outcome: 'got' | 'pass', at: number) => {
    const r = applyTilt(s, s.round!.current!.wordId, outcome, at, draw, 'pal');
    if (!r.accepted) throw new Error();
    return r;
  };

  it("fouls the Word when the Player's speech says it before the PAL has", () => {
    const s = markSaid(playingClue(), 'w0', 'player', 'it rhymes with... word0!', T0 + 4000);
    expect(s.round!.current!.foul).toBe(true);
    const r = palTilt(s, 'got', T0 + 5000);
    expect(r.result.foul).toBe(true);
  });

  it('lets the Player confirm the Word once the PAL has said it', () => {
    let s = markSaid(playingClue(), 'w0', 'pal', 'Is it word0?', T0 + 4000);
    expect(s.round!.current!.palSaidAt).toBe(T0 + 4000);
    s = markSaid(s, 'w0', 'player', 'Yes, word0!', T0 + 4500);
    expect(s.round!.current!.foul).toBeUndefined();
    expect(palTilt(s, 'got', T0 + 5000).result.foul).toBeUndefined();
  });

  it('keeps the first PAL mention and ignores speech that does not say the Word', () => {
    let s = markSaid(playingClue(), 'w0', 'pal', 'word0?', T0 + 4000);
    s = markSaid(s, 'w0', 'pal', 'word0!!', T0 + 4500);
    expect(s.round!.current!.palSaidAt).toBe(T0 + 4000);
    const quiet = playingClue();
    expect(markSaid(quiet, 'w0', 'player', 'it has a long neck', T0 + 4000)).toBe(quiet);
    expect(markSaid(quiet, 'w0', 'pal', 'a zebra?', T0 + 4000)).toBe(quiet);
  });

  it('ignores stale Words, Guess Rounds and speech outside play', () => {
    const s = playingClue();
    expect(markSaid(s, 'w9', 'player', 'word9', T0 + 4000)).toBe(s);
    const g = playing();
    expect(markSaid(g, 'w0', 'player', 'word0', T0 + 4000)).toBe(g);
    const done = endRound(s);
    expect(markSaid(done, 'w0', 'player', 'word0', T0 + 70_000)).toBe(done);
  });

  it('records an utterance landing just after the tilt on the Word just tilted', () => {
    let s = palTilt(playingClue(), 'got', T0 + 5000).state;
    s = markSaid(s, 'w0', 'player', 'word0, come on!', T0 + 5200);
    expect(s.round!.results[0].foul).toBe(true);
    expect(s.round!.current!.foul).toBeUndefined();

    let t = palTilt(playingClue(), 'got', T0 + 5000).state;
    t = markSaid(t, 'w0', 'pal', 'word0!', T0 + 5100);
    t = markSaid(t, 'w0', 'player', 'yes, word0!', T0 + 5200);
    expect(t.round!.results[0]).toMatchObject({ palSaidAt: T0 + 5100 });
    expect(t.round!.results[0].foul).toBeUndefined();
  });

  it('ignores older Words once another tilt has happened', () => {
    let s = palTilt(playingClue(), 'pass', T0 + 5000).state;
    s = palTilt(s, 'pass', T0 + 6000).state;
    expect(markSaid(s, 'w0', 'player', 'word0', T0 + 6100)).toBe(s);
  });

  it('summarizes Fouls and leaves Guess-only numbers out of Clue Rounds', () => {
    let s = markSaid(playingClue(), 'w0', 'player', 'word0', T0 + 4000);
    s = palTilt(s, 'got', T0 + 5000).state; // fouled Got it
    s = palTilt(s, 'got', T0 + 6000).state; // clean Got it the PAL never said: no Tilt slip in Clue mode
    s = palTilt(s, 'pass', T0 + 7000).state;
    s = markSaid(s, 'w2', 'player', 'it was word2!', T0 + 7100); // late Foul on the Pass
    s = markSaid(s, 'w3', 'player', 'word3', T0 + 8000); // unfinished, fouled
    const sum = endRound(s).lastSummary!;
    expect(sum).toMatchObject({
      mode: 'clue',
      gotIt: 2,
      passed: 1,
      fouls: 3,
      reactionLagMs: null,
      heardCount: 0,
      qrDecoded: 0,
      qrFallback: 0,
      qrDecodeMs: null,
      clueLatencyMs: null,
      leaks: 0,
      nudges: 0,
      silenceNudges: 0,
      passedAfterHeard: 0,
      gotUnheard: 0,
    });
    expect(sum.words.map((w) => w.foul)).toEqual([true, undefined, true, true]);
    expect(sum.words.some((w) => 'slip' in w)).toBe(false);
    expect('foul' in sum.words[1]).toBe(false);
  });

  it('keeps Guess Round summaries free of Fouls', () => {
    const sum = endRound(playing()).lastSummary!;
    expect('fouls' in sum).toBe(false);
  });
});
