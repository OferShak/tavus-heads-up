import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARD_CONFIRM_MS, NUDGE_DELAYS_MS, QR_FALLBACK_MS } from '../../shared/game';
import type { ClientMsg, RoomEvent, Snapshot } from '../../shared/protocol';
import { encodeWordQr } from '../../shared/qr';
import type { Phase, RoundSummary } from '../../shared/room';
import {
  CALL_OUT_UNHEARD_PROMPT,
  HAD_IT_PROMPT,
  NEW_WORD_PROMPT,
  NOT_QUITE_CORRECTION,
  PalDirector,
  PREV_WORD_CORRECTION,
  ROUND_END_PROMPT,
  ROUND_START_PROMPT,
  toolName,
} from './director';

type Sent = { type: string; props?: Record<string, unknown> };

function snap(phase: Phase, word?: { wordId: string; word: string }, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    code: 'ABCDE',
    phase,
    serverNow: Date.now(),
    player: { nickname: 'Sam' },
    stageConnected: true,
    controllerConnected: true,
    pal: { status: 'ready', conversationId: 'c1', conversationUrl: 'https://tavus.daily.co/c1' },
    round:
      phase === 'waiting' || phase === 'lobby'
        ? null
        : {
            index: 1,
            category: 'animals',
            startsAt: 0,
            endsAt: 60_000,
            current: word ? { ...word, position: 0, shownAt: Date.now() } : null,
            gotIt: 0,
            passed: 0,
          },
    lastSummary: null,
    stats: null,
    personalBest: null,
    ...extra,
  };
}

const tiltEvent = (wordId: string, word: string, outcome: 'got' | 'pass', heardAt?: number): RoomEvent => ({
  kind: 'tilt',
  result: { wordId, word, outcome, tiltAt: Date.now(), ...(heardAt !== undefined ? { heardAt } : {}) },
});

// Tests that send no user utterances rely on the fallback: with no Player speech in the call, word_guessed is trusted.
const toolCall = { event_type: 'conversation.tool_call', properties: { name: 'word_guessed' } };

const summary: RoundSummary = {
  index: 1,
  category: 'animals',
  gotIt: 3,
  passed: 1,
  words: [],
  reactionLagMs: null,
  heardCount: 0,
  qrDecoded: 0,
  qrFallback: 0,
  qrDecodeMs: null,
  clueLatencyMs: null,
  leaks: 0,
  nudges: 0,
  passedAfterHeard: 0,
  gotUnheard: 0,
};

describe('PalDirector', () => {
  let sent: Sent[];
  let reports: ClientMsg[];
  let d: PalDirector;

  const types = () => sent.map((s) => s.type);
  const make = (reactions = true) =>
    new PalDirector({
      interact: (type, props) => sent.push({ type, props }),
      report: (m) => reports.push(m),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      reactions,
      rng: () => 0,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    reports = [];
    d = make();
    d.onSnapshot(snap('lobby'));
    d.onPalJoined();
    sent = [];
  });

  afterEach(() => {
    d.dispose();
    vi.useRealTimers();
  });

  /** Put the director mid-Round with word w1 injected. */
  function playW1() {
    d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
    d.onQr(encodeWordQr('w1', 'giraffe'));
    sent = [];
    reports = [];
  }

  it('on a tilt: interrupts, reacts via echo, then injects the Room copy after QR_FALLBACK_MS', () => {
    playW1();
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got', Date.now()));

    expect(types()).toEqual(['conversation.interrupt', 'conversation.set_emotion', 'conversation.echo']);
    expect(sent[1].props).toEqual({ emotion: 'happiness' });
    expect(sent[2].props).toMatchObject({ modality: 'text', text: 'Yes!', done: true });
    expect(reports).toEqual([]);

    vi.advanceTimersByTime(QR_FALLBACK_MS - 1);
    expect(types()).not.toContain('conversation.overwrite_llm_context');

    vi.advanceTimersByTime(1);
    expect(reports).toEqual([{ t: 'decoded', wordId: 'w2', source: 'fallback' }]);
    const tail = types().slice(3);
    expect(tail).toEqual(['conversation.set_emotion', 'conversation.overwrite_llm_context', 'conversation.respond']);
    expect(String(sent[4].props?.context)).toContain('"penguin"');
    expect(sent[5].props).toEqual({ text: NEW_WORD_PROMPT });
  });

  it('skips the reaction echo when reactions are off', () => {
    d = make(false);
    d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
    d.onPalJoined();
    d.onQr(encodeWordQr('w1', 'giraffe'));
    sent = [];
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'pass'));
    expect(types()).toEqual(['conversation.interrupt']);
  });

  describe('Tilt slips', () => {
    const tiltTo = (outcome: 'got' | 'pass', heardAt?: number) =>
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', outcome, heardAt));
    const respondText = () => sent.find((s) => s.type === 'conversation.respond')?.props?.text;

    it('got + heard: cheers', () => {
      playW1();
      d.onTavusEvent(toolCall);
      sent = [];
      tiltTo('got');
      expect(types()).toEqual(['conversation.interrupt', 'conversation.set_emotion', 'conversation.echo']);
      expect(sent[1].props).toEqual({ emotion: 'happiness' });
      expect(sent[2].props).toMatchObject({ text: 'Yes!' });
    });

    it('pass + not heard: skip line', () => {
      playW1();
      tiltTo('pass');
      expect(types()).toEqual(['conversation.interrupt', 'conversation.set_emotion', 'conversation.echo']);
      expect(sent[1].props).toEqual({ emotion: 'surprise' });
      expect(sent[2].props).toMatchObject({ text: 'Skip it!' });
    });

    it('pass + heard (via the Room snapshot): "you had it"', () => {
      playW1();
      tiltTo('pass', Date.now());
      expect(types()).toEqual(['conversation.interrupt', 'conversation.set_emotion', 'conversation.echo']);
      expect(sent[1].props).toEqual({ emotion: 'surprise' });
      expect(sent[2].props).toMatchObject({ text: 'You had it!' });
      vi.advanceTimersByTime(QR_FALLBACK_MS);
      expect(respondText()).toBe(NEW_WORD_PROMPT); // the echo already covered it
    });

    it('got + not heard: no cheer, then calls it out at injection', () => {
      playW1();
      tiltTo('got');
      expect(types()).toEqual(['conversation.interrupt']);
      vi.advanceTimersByTime(QR_FALLBACK_MS);
      expect(respondText()).toBe(CALL_OUT_UNHEARD_PROMPT);
      expect(String(respondText())).not.toContain('giraffe');
    });

    it('a late tool call before injection is Heard it for the previous Word, without nudges (pass → HAD_IT)', () => {
      playW1();
      tiltTo('pass');
      d.onTavusEvent(toolCall);
      d.onTavusEvent(toolCall); // duplicate ignored
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      d.onQr(encodeWordQr('w2', 'penguin'));
      expect(respondText()).toBe(HAD_IT_PROMPT);
      expect(String(respondText())).not.toContain('giraffe');
      reports = [];
      vi.advanceTimersByTime(20_000);
      expect(reports.filter((r) => r.t === 'nudge')).toEqual([]);
    });

    it('a late tool call before injection on a got → NEW_WORD prompt', () => {
      playW1();
      tiltTo('got');
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      vi.advanceTimersByTime(QR_FALLBACK_MS);
      expect(respondText()).toBe(NEW_WORD_PROMPT);
      reports = [];
      vi.advanceTimersByTime(20_000);
      expect(reports.filter((r) => r.t === 'nudge')).toEqual([]);
    });

    it('a tool call before the first Word of a Round is injected is ignored', () => {
      d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([]);
    });

    it('a tool call after injection still applies to the current Word, with nudges', () => {
      playW1();
      tiltTo('got');
      d.onQr(encodeWordQr('w2', 'penguin'));
      reports = [];
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w2' }]);
      vi.advanceTimersByTime(NUDGE_DELAYS_MS[0]);
      expect(reports).toContainEqual({ t: 'nudge', wordId: 'w2' });
    });

    it('reactions off: no echoes and always NEW_WORD_PROMPT', () => {
      d = make(false);
      d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
      d.onPalJoined();
      d.onQr(encodeWordQr('w1', 'giraffe'));
      const cases: [string, 'got' | 'pass', boolean, boolean][] = [
        ['w2', 'got', false, false], // got unheard
        ['w3', 'pass', true, false], // pass heard
        ['w4', 'pass', false, true], // pass, heard late
      ];
      let prevId = 'w1';
      for (const [id, outcome, heard, late] of cases) {
        sent = [];
        d.onSnapshot(snap('playing', { wordId: id, word: 'word' + id }), tiltEvent(prevId, 'x', outcome, heard ? Date.now() : undefined));
        if (late) d.onTavusEvent(toolCall);
        vi.advanceTimersByTime(QR_FALLBACK_MS);
        expect(types()).not.toContain('conversation.echo');
        expect(respondText()).toBe(NEW_WORD_PROMPT);
        prevId = id;
      }
    });
  });

  describe('Heard it is confirmed against the Player\'s own words', () => {
    const userSays = (speech: string) =>
      d.onTavusEvent({ event_type: 'conversation.utterance', properties: { role: 'user', speech } });

    it('regression: a word_guessed for the previous Word after a call-out does not credit the new Word', () => {
      // Real transcript: "chef" clued, Player says "Pizza" and tilts Got it (a Tilt slip). "painter" is injected with
      // the call-out prompt; the PAL drifts back to chef, the Player says "chef", and the PAL calls word_guessed.
      d.onSnapshot(snap('playing', { wordId: 'w1', word: 'chef' }));
      d.onQr(encodeWordQr('w1', 'chef'));
      userSays('Pizza.');
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'painter' }), tiltEvent('w1', 'chef', 'got'));
      d.onQr(encodeWordQr('w2', 'painter'));
      reports = [];
      sent = [];
      userSays('I said pizza.');
      userSays('Uh, chef—');
      d.onTavusEvent(toolCall);
      // The Player's latest words say the last Word: the filler is cut off and corrected at once, no hold.
      expect(types()).toEqual(['conversation.interrupt', 'conversation.echo']);
      expect(sent[1].props).toMatchObject({ modality: 'text', text: PREV_WORD_CORRECTION, done: true });
      vi.advanceTimersByTime(20_000);
      expect(reports.filter((r) => r.t === 'heard')).toEqual([]);
      expect(reports.filter((r) => r.t === 'nudge')).toEqual([]);
      expect(types()).toEqual(['conversation.interrupt', 'conversation.echo']);
    });

    it('an older utterance of the previous Word followed by a newer miss still uses the hold', () => {
      d.onSnapshot(snap('playing', { wordId: 'w1', word: 'chef' }));
      d.onQr(encodeWordQr('w1', 'chef'));
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'painter' }), tiltEvent('w1', 'chef', 'got'));
      d.onQr(encodeWordQr('w2', 'painter'));
      sent = [];
      reports = [];
      userSays('chef?');
      userSays('a plumber?');
      d.onTavusEvent(toolCall);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(HEARD_CONFIRM_MS);
      expect(types()).toEqual(['conversation.interrupt', 'conversation.echo']);
      expect(sent[1].props).toMatchObject({ text: PREV_WORD_CORRECTION });
      expect(reports.filter((r) => r.t === 'heard')).toEqual([]);
    });

    it('a correct guess is still Heard it, with nudges', () => {
      playW1();
      userSays("it's a giraffe!");
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      vi.advanceTimersByTime(NUDGE_DELAYS_MS[0]);
      expect(reports).toContainEqual({ t: 'nudge', wordId: 'w1' });
      expect(types()).not.toContain('conversation.interrupt');
    });

    it('a tool call that lands before the utterance is accepted when a matching one arrives in the window', () => {
      playW1();
      userSays('a zebra?');
      d.onTavusEvent(toolCall);
      d.onTavusEvent(toolCall); // a duplicate while waiting is ignored
      expect(reports).toEqual([]);
      vi.advanceTimersByTime(HEARD_CONFIRM_MS - 1);
      userSays('Giraffes!');
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      vi.advanceTimersByTime(NUDGE_DELAYS_MS[0]);
      expect(reports).toContainEqual({ t: 'nudge', wordId: 'w1' });
      expect(types()).not.toContain('conversation.interrupt');
    });

    it('rejects a tool call when no matching utterance arrives in the window, with a correction', () => {
      playW1();
      userSays('a zebra?');
      d.onTavusEvent(toolCall);
      vi.advanceTimersByTime(HEARD_CONFIRM_MS - 1);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(types()).toEqual(['conversation.interrupt', 'conversation.echo']);
      expect(sent[1].props).toMatchObject({ text: NOT_QUITE_CORRECTION });
      vi.advanceTimersByTime(20_000);
      expect(reports).toEqual([]);

      // A later, real guess for the same Word still counts.
      userSays('giraffe');
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
    });

    it('reactions off: still rejects, but without the correction echo', () => {
      d = make(false);
      d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
      d.onPalJoined();
      d.onQr(encodeWordQr('w1', 'giraffe'));
      sent = [];
      reports = [];
      userSays('a zebra?');
      d.onTavusEvent(toolCall);
      vi.advanceTimersByTime(20_000);
      expect(reports).toEqual([]);
      expect(types()).toEqual(['conversation.interrupt']);
    });

    it('trusts the tool call when the call never delivered any user utterance (fallback)', () => {
      playW1();
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
    });

    it('late Heard it (tool call between tilt and injection) still counts when the Player said the previous Word', () => {
      playW1();
      userSays('giraffe!');
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'pass'));
      d.onTavusEvent(toolCall);
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      d.onQr(encodeWordQr('w2', 'penguin'));
      expect(sent.find((s) => s.type === 'conversation.respond')?.props?.text).toBe(HAD_IT_PROMPT);
      reports = [];
      vi.advanceTimersByTime(20_000);
      expect(reports.filter((r) => r.t === 'nudge')).toEqual([]);
    });

    it('a pending tool call survives the tilt and is confirmed by speech before the next injection', () => {
      playW1();
      userSays('a zebra?');
      d.onTavusEvent(toolCall);
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
      userSays('giraffe');
      expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);
      vi.advanceTimersByTime(QR_FALLBACK_MS);
      expect(sent.find((s) => s.type === 'conversation.respond')?.props?.text).toBe(NEW_WORD_PROMPT);
    });

    it('late tool call without the previous Word in the Player\'s speech is rejected silently', () => {
      playW1();
      userSays('a zebra?');
      d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
      sent = [];
      d.onTavusEvent(toolCall);
      vi.advanceTimersByTime(HEARD_CONFIRM_MS);
      expect(reports.filter((r) => r.t === 'heard')).toEqual([]);
      expect(types()).toEqual(['conversation.set_emotion', 'conversation.overwrite_llm_context', 'conversation.respond']);
      expect(sent[2].props?.text).toBe(CALL_OUT_UNHEARD_PROMPT);
    });
  });

  it('injects as soon as the Word QR is decoded, with source qr, and cancels the fallback', () => {
    playW1();
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'pass'));
    sent = [];
    vi.advanceTimersByTime(400);
    d.onQr(encodeWordQr('w2', 'penguin'));

    expect(reports).toEqual([{ t: 'decoded', wordId: 'w2', source: 'qr' }]);
    expect(types()).toEqual(['conversation.set_emotion', 'conversation.overwrite_llm_context', 'conversation.respond']);

    vi.advanceTimersByTime(QR_FALLBACK_MS * 2);
    d.onQr(encodeWordQr('w2', 'penguin'));
    expect(reports).toHaveLength(1);
    expect(types()).toHaveLength(3);
  });

  it('ignores a stale Word QR and a foreign QR', () => {
    playW1();
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
    sent = [];
    d.onQr(encodeWordQr('w1', 'giraffe')); // previous Word still on the phone
    d.onQr('https://example.com/menu');
    d.onQr('omh:w2'); // malformed
    expect(reports).toEqual([]);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(QR_FALLBACK_MS);
    expect(reports).toEqual([{ t: 'decoded', wordId: 'w2', source: 'fallback' }]);
  });

  it('word_guessed tool call reports heard and schedules Tilt nudges, cancelled by the next Word', () => {
    playW1();
    d.onTavusEvent({ event_type: 'conversation.tool_call', properties: { name: 'word_guessed', arguments: '{}' } });
    expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }]);

    // A second call for the same Word is ignored.
    d.onTavusEvent({ event_type: 'conversation.tool_call', properties: { name: 'word_guessed' } });
    expect(reports).toHaveLength(1);

    vi.advanceTimersByTime(NUDGE_DELAYS_MS[0]);
    expect(reports).toEqual([{ t: 'heard', wordId: 'w1' }, { t: 'nudge', wordId: 'w1' }]);
    expect(sent.at(-1)).toMatchObject({ type: 'conversation.echo', props: { text: 'Tilt it down!' } });

    vi.advanceTimersByTime(NUDGE_DELAYS_MS[1] - NUDGE_DELAYS_MS[0]);
    expect(reports.filter((r) => r.t === 'nudge')).toHaveLength(2);

    // Next Word: a fresh heard schedules nudges, which the Word after that cancels.
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
    d.onQr(encodeWordQr('w2', 'penguin'));
    d.onTavusEvent({ event_type: 'conversation.tool_call', properties: { function: { name: 'word_guessed' } } });
    vi.advanceTimersByTime(1_000);
    d.onSnapshot(snap('playing', { wordId: 'w3', word: 'zebra' }), tiltEvent('w2', 'penguin', 'got'));
    reports = [];
    vi.advanceTimersByTime(10_000);
    expect(reports.filter((r) => r.t === 'nudge')).toEqual([]);
  });

  it('ignores word_guessed outside a Round', () => {
    d.onTavusEvent({ event_type: 'conversation.tool_call', properties: { name: 'word_guessed' } });
    expect(reports).toEqual([]);
  });

  it('reports a leak once, deduping the pal/replica copies of the same utterance', () => {
    playW1();
    const say = (role: string, speech: string, inference_id = 'i1') =>
      d.onTavusEvent({ event_type: 'conversation.utterance', inference_id, properties: { role, speech } });

    say('user', 'is it a giraffe?'); // the Player saying it is fine
    expect(reports).toEqual([]);

    say('pal', 'Tall spotted thing, starts with giraff...');
    say('replica', 'Tall spotted thing, starts with giraff...');
    expect(reports).toEqual([]); // "giraff" is a prefix of the part, not the part plus a suffix

    say('pal', 'Long neck! Giraffes eat leaves!', 'i2');
    say('replica', 'Long neck! Giraffes eat leaves!', 'i2');
    say('pal', 'Seriously, giraffe!', 'i3');
    expect(reports).toEqual([{ t: 'leak', wordId: 'w1' }]);
  });

  it('measures injection to first PAL speech once per Word', () => {
    playW1();
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
    d.onTavusEvent({ event_type: 'conversation.replica.started_speaking' }); // the reaction echo, before injection
    vi.advanceTimersByTime(200);
    d.onQr(encodeWordQr('w2', 'penguin'));
    vi.advanceTimersByTime(900);
    d.onTavusEvent({ event_type: 'conversation.started_speaking', properties: { role: 'user' } });
    d.onTavusEvent({ event_type: 'conversation.started_speaking', properties: { role: 'replica' } });
    d.onTavusEvent({ event_type: 'conversation.replica.started_speaking' });
    expect(reports.filter((r) => r.t === 'clue_latency')).toEqual([{ t: 'clue_latency', wordId: 'w2', ms: 900 }]);
  });

  it('sends the round_start and round_end prompts', () => {
    d.onSnapshot(snap('countdown'), { kind: 'round_start' });
    expect(types()).toEqual(['conversation.interrupt', 'conversation.overwrite_llm_context', 'conversation.respond']);
    expect(String(sent[1].props?.context)).toContain('Animals Round is about to start');
    expect(sent[2].props).toEqual({ text: ROUND_START_PROMPT });

    d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
    sent = [];
    d.onSnapshot(snap('recap', undefined, { lastSummary: summary }), { kind: 'round_end' });
    expect(types()).toEqual([
      'conversation.interrupt',
      'conversation.set_emotion',
      'conversation.overwrite_llm_context',
      'conversation.respond',
    ]);
    expect(String(sent[2].props?.context)).toContain('They got 3 and passed 1');
    expect(sent[3].props).toEqual({ text: ROUND_END_PROMPT });

    // The pending fallback for w1 died with the Round.
    sent = [];
    vi.advanceTimersByTime(QR_FALLBACK_MS);
    expect(sent).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('sends nothing to Tavus before the PAL is live, but still reports to the Room', () => {
    d = make();
    d.onSnapshot(snap('lobby'));
    d.onSnapshot(snap('countdown'), { kind: 'round_start' });
    d.onSnapshot(snap('playing', { wordId: 'w1', word: 'giraffe' }));
    vi.advanceTimersByTime(QR_FALLBACK_MS);
    expect(sent).toEqual([]);
    expect(reports).toEqual([{ t: 'decoded', wordId: 'w1', source: 'fallback' }]);

    // Joining mid-Round brings the PAL up to date with the current Word.
    d.onPalJoined();
    expect(types()).toEqual(['conversation.overwrite_llm_context', 'conversation.respond']);
    expect(String(sent[0].props?.context)).toContain('"giraffe"');

    // A duplicate join signal (participant + system event) does nothing.
    d.onPalJoined();
    expect(sent).toHaveLength(2);

    // After the PAL leaves, interactions are dropped again.
    d.setLive(false);
    sent = [];
    d.onSnapshot(snap('playing', { wordId: 'w2', word: 'penguin' }), tiltEvent('w1', 'giraffe', 'got'));
    vi.advanceTimersByTime(QR_FALLBACK_MS);
    expect(sent).toEqual([]);
  });

  it('gives the PAL the lobby context when it joins outside a Round', () => {
    d = make();
    d.onSnapshot(snap('lobby'));
    d.onPalJoined();
    expect(types()).toEqual(['conversation.overwrite_llm_context']);
    expect(String(sent[0].props?.context)).toContain('NO secret word');
  });
});

describe('toolName', () => {
  it('accepts the tool_call shapes seen in the wild', () => {
    expect(toolName({ name: 'word_guessed' })).toBe('word_guessed');
    expect(toolName({ function: { name: 'word_guessed' } })).toBe('word_guessed');
    expect(toolName({ tool_call: { name: 'word_guessed' } })).toBe('word_guessed');
    expect(toolName({})).toBeUndefined();
  });
});
