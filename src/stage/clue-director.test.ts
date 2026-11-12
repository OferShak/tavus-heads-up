import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clueRevealMessage } from '../../shared/pal-context';
import type { ClientMsg, PlayerSummary, RoomEvent, Snapshot } from '../../shared/protocol';
import type { Phase, RoundSummary } from '../../shared/room';
import {
  CLUE_GO_PROMPT,
  CLUE_ROUND_END_PROMPT,
  CLUE_ROUND_START_PROMPT,
  ClueDirector,
  REVEAL_STRATEGIES,
  REVEAL_STRATEGY,
  TURN_MAX_MS,
  routeOf,
  tiltDirection,
  type ClueTavusEvent,
  type RevealStrategy,
} from './clue-director';
import { PalDirector } from './director';
import { DirectorRouter } from './director-router';

type Sent = { type: string; props?: Record<string, unknown> };

interface W {
  wordId: string;
  word: string;
  position?: number;
}

function snap(phase: Phase, word?: W, extra: Partial<Snapshot> = {}, round: Partial<NonNullable<Snapshot['round']>> = {}): Snapshot {
  return {
    code: 'ABCDE',
    phase,
    mode: 'clue',
    serverNow: Date.now(),
    player: { nickname: 'Sam' },
    stageConnected: true,
    controllerConnected: true,
    pal: { status: 'ready', conversationId: 'c2', conversationUrl: 'https://tavus.daily.co/c2', mode: 'clue' },
    round:
      phase === 'waiting' || phase === 'lobby'
        ? null
        : {
            index: 1,
            category: 'animals',
            mode: 'clue',
            startsAt: 0,
            endsAt: 60_000,
            current: word ? { wordId: word.wordId, word: word.word, position: word.position ?? 0, shownAt: Date.now() } : null,
            gotIt: 0,
            passed: 0,
            ...round,
          },
    lastSummary: null,
    stats: null,
    personalBest: null,
    ...extra,
  };
}

const W1: W = { wordId: 'w1', word: 'giraffe', position: 0 };
const W2: W = { wordId: 'w2', word: 'penguin', position: 1 };
const W3: W = { wordId: 'w3', word: 'octopus', position: 2 };

const tiltEv = (w: W, outcome: 'got' | 'pass', foul = false): RoomEvent => ({
  kind: 'tilt',
  result: { wordId: w.wordId, word: w.word, outcome, tiltAt: Date.now(), by: 'pal', ...(foul ? { foul: true } : {}) },
});

const tiltCall = (direction: string, inference_id = `inf-${Math.random()}`, shape: 'string' | 'object' | 'function' = 'string'): ClueTavusEvent => ({
  event_type: 'conversation.tool_call',
  inference_id,
  properties:
    shape === 'function'
      ? { function: { name: 'tilt', arguments: JSON.stringify({ direction }) } }
      : { name: 'tilt', arguments: shape === 'string' ? JSON.stringify({ direction }) : { direction } },
});

const started = (role: 'user' | 'pal' | 'replica', seq?: number): ClueTavusEvent => ({
  event_type: 'conversation.started_speaking',
  properties: { role },
  ...(seq !== undefined ? { seq } : {}),
});
const utter = (role: 'user' | 'pal' | 'replica', speech: string, seq?: number, inference_id?: string): ClueTavusEvent => ({
  event_type: 'conversation.utterance',
  ...(inference_id ? { inference_id } : {}),
  properties: { role, speech },
  ...(seq !== undefined ? { seq } : {}),
});

const clueStats: PlayerSummary = {
  mode: 'clue',
  nickname: 'Sam',
  roundsPlayed: 4,
  bests: { animals: 11 },
  wordsPerMinute: 9,
  reactionLagMs: null,
  mostPassed: [],
  tiltSlips: 0,
  passedAfterHeard: 0,
  gotUnheard: 0,
  fouls: 2,
};

describe('ClueDirector', () => {
  let sent: Sent[];
  let reports: ClientMsg[];
  let logs: { label: string; data: unknown }[];
  let d: ClueDirector;

  const make = (reveal?: RevealStrategy, reactions = true) =>
    new ClueDirector({
      interact: (type, props) => sent.push({ type, props }),
      report: (m) => reports.push(m),
      now: () => Date.now(),
      log: (label, data) => logs.push({ label, data }),
      reactions,
      reveal,
    });

  const said = () => reports.filter((r): r is Extract<ClientMsg, { t: 'said' }> => r.t === 'said');
  const tilts = () => reports.filter((r): r is Extract<ClientMsg, { t: 'pal_tilt' }> => r.t === 'pal_tilt');

  function start(dir = make()) {
    d = dir;
    d.onSnapshot(snap('lobby'));
    d.onPalJoined();
    d.onSnapshot(snap('countdown'), { kind: 'round_start' });
    d.onSnapshot(snap('playing', W1));
    sent = [];
    reports = [];
    logs = [];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    reports = [];
    logs = [];
    d = make();
  });

  afterEach(() => {
    d.dispose();
    vi.useRealTimers();
  });

  describe('contexts', () => {
    it('briefs the PAL on join, countdown, the first Word and the recap, never naming the Word', () => {
      d.onSnapshot(snap('lobby', undefined, { stats: clueStats }));
      d.onPalJoined();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('conversation.overwrite_llm_context');
      expect(sent[0].props?.context).toContain('There is NO word on your forehead');
      expect(sent[0].props?.context).toContain('Fouls so far');

      sent = [];
      d.onSnapshot(snap('countdown'), { kind: 'round_start' });
      expect(sent.map((s) => s.type)).toEqual(['conversation.interrupt', 'conversation.overwrite_llm_context', 'conversation.respond']);
      expect(sent[2].props?.text).toBe(CLUE_ROUND_START_PROMPT);

      sent = [];
      d.onSnapshot(snap('playing', W1));
      expect(sent.map((s) => s.type)).toEqual(['conversation.overwrite_llm_context', 'conversation.respond']);
      expect(sent[0].props?.context).toContain("You're on word #1. Score so far: 0.");
      expect(sent[1].props?.text).toBe(CLUE_GO_PROMPT);
      expect(JSON.stringify(sent)).not.toMatch(/giraffe/i);

      sent = [];
      const summary: RoundSummary = {
        index: 1,
        category: 'animals',
        mode: 'clue',
        gotIt: 1,
        passed: 0,
        words: [{ wordId: 'w1', word: 'giraffe', outcome: 'got', foul: true }],
        fouls: 1,
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
      };
      d.onSnapshot({ ...snap('recap'), lastSummary: summary }, { kind: 'round_end' });
      expect(sent.map((s) => s.type)).toEqual([
        'conversation.interrupt',
        'conversation.set_emotion',
        'conversation.overwrite_llm_context',
        'conversation.respond',
      ]);
      expect(sent[2].props?.context).toContain('Fouls (they said the word in their clues): giraffe');
      expect(sent[3].props?.text).toBe(CLUE_ROUND_END_PROMPT);
    });

    it("leaves out Guess mode stats (snap.stats follows the selected Mode)", () => {
      d.onSnapshot(snap('lobby', undefined, { stats: { ...clueStats, mode: 'guess', fouls: 0 } }));
      d.onPalJoined();
      expect(sent[0].props?.context).not.toContain('Clue Rounds played');
    });

    it('adds the swap recap line when it joins after a Round with the other friend', () => {
      const last = { index: 1, category: 'animals', mode: 'guess', gotIt: 9, passed: 2, words: [] } as unknown as RoundSummary;
      d.onSnapshot({ ...snap('recap'), lastSummary: last });
      d.onPalJoined();
      expect(sent[0].props?.context).toContain('Sam just scored 9 in Animals in Guess mode.');
    });

    it('sends nothing before the PAL is in the call', () => {
      d.onSnapshot(snap('lobby'));
      d.onSnapshot(snap('countdown'), { kind: 'round_start' });
      d.onSnapshot(snap('playing', W1));
      expect(sent).toEqual([]);
    });

    it('re-briefs the current Round (Word number, not the Word) when it joins mid-Round', () => {
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }));
      d.onPalJoined();
      expect(sent.map((s) => s.type)).toEqual(['conversation.overwrite_llm_context']);
      expect(sent[0].props?.context).toContain("You're on word #2. Score so far: 1.");
      expect(JSON.stringify(sent)).not.toMatch(/penguin/i);
    });
  });

  describe('PAL tilt', () => {
    it('turns a tilt tool call into pal_tilt for the current Word (down = got, up = pass)', () => {
      start();
      d.onTavusEvent(tiltCall('down'));
      expect(tilts()).toEqual([{ t: 'pal_tilt', wordId: 'w1', outcome: 'got' }]);
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      d.onTavusEvent(tiltCall('up', 'i2', 'object'));
      expect(tilts().at(-1)).toEqual({ t: 'pal_tilt', wordId: 'w2', outcome: 'pass' });
    });

    it('reads direction from the payload shapes seen in the wild', () => {
      expect(tiltDirection({ name: 'tilt', arguments: '{"direction":"down"}' })).toBe('down');
      expect(tiltDirection({ name: 'tilt', arguments: { direction: 'up' } })).toBe('up');
      expect(tiltDirection({ function: { name: 'tilt', arguments: '{"direction":" UP "}' } })).toBe('up');
      expect(tiltDirection({ tool_call: { name: 'tilt', arguments: { direction: 'down' } } })).toBe('down');
      expect(tiltDirection({ name: 'tilt', direction: 'down' })).toBe('down');
      expect(tiltDirection({ name: 'tilt', arguments: 'not json' })).toBeNull();
      expect(tiltDirection({ name: 'tilt', arguments: { direction: 'sideways' } })).toBeNull();
    });

    it('de-duplicates by inference_id, even after the Room moved to the next Word', () => {
      start();
      d.onTavusEvent(tiltCall('down', 'same'));
      d.onTavusEvent(tiltCall('down', 'same'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      d.onTavusEvent(tiltCall('down', 'same'));
      expect(tilts()).toEqual([{ t: 'pal_tilt', wordId: 'w1', outcome: 'got' }]);
    });

    it('sends one tilt per Word while the first is in flight', () => {
      start();
      d.onTavusEvent(tiltCall('down', 'a'));
      d.onTavusEvent(tiltCall('up', 'b'));
      expect(tilts()).toHaveLength(1);
      expect(logs.map((l) => (l.data as { action: string }).action)).toEqual(['sent', 'in_flight']);
    });

    it('handles the live payload shape: function.arguments JSON string with response_to_user, deduped by its call id', () => {
      start();
      const live = (inference_id?: string): ClueTavusEvent => ({
        event_type: 'conversation.tool_call',
        ...(inference_id ? { inference_id } : {}),
        properties: {
          function: {
            name: 'tilt',
            arguments: JSON.stringify({ response_to_user: '<emotion value="elated"/>Yes! I knew it!', direction: 'down' }),
          },
          id: 'call_abc',
          type: 'function',
        },
      });
      d.onTavusEvent(live('inf-1'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      // Same call id redelivered with another (or no) inference_id after the Room moved on: still a duplicate.
      d.onTavusEvent(live('inf-2'));
      d.onTavusEvent(live());
      expect(tilts()).toEqual([{ t: 'pal_tilt', wordId: 'w1', outcome: 'got' }]);
    });

    it('ignores tilts outside a playing Clue Round', () => {
      d.onSnapshot(snap('lobby'));
      d.onPalJoined();
      d.onTavusEvent(tiltCall('down'));
      d.onSnapshot(snap('countdown'), { kind: 'round_start' });
      d.onTavusEvent(tiltCall('down'));
      d.onSnapshot({ ...snap('recap'), round: null });
      d.onTavusEvent(tiltCall('down'));
      // A Guess mode Round: not ours.
      d.onSnapshot(snap('playing', W1, {}, { mode: 'guess' }));
      d.onTavusEvent(tiltCall('down'));
      expect(tilts()).toEqual([]);
      expect(logs.every((l) => (l.data as { action: string }).action === 'outside_round')).toBe(true);
    });

    it('ignores other tools and bad directions, and logs every tilt payload raw', () => {
      start();
      d.onTavusEvent({ event_type: 'conversation.tool_call', inference_id: 'x', properties: { name: 'word_guessed' } });
      const bad = tiltCall('left', 'y');
      d.onTavusEvent(bad);
      expect(tilts()).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0].label).toBe('clue: tilt tool_call');
      expect(logs[0].data).toMatchObject({ action: 'bad_direction', raw: bad });
    });
  });

  describe('Reveal', () => {
    it('on the Room tilt event: next Round context (overwrite), then the Reveal as respond', () => {
      start();
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      expect(sent.map((s) => s.type)).toEqual(['conversation.set_emotion', 'conversation.overwrite_llm_context', 'conversation.respond']);
      expect(sent[0].props?.emotion).toBe('happiness');
      expect(sent[1].props?.context).toContain("You're on word #2. Score so far: 1.");
      expect(sent[2].props?.text).toBe(clueRevealMessage('giraffe', 'got', false));
      expect(sent[2].props?.text).not.toContain('FOUL');
      expect(JSON.stringify(sent)).not.toMatch(/penguin/i);
    });

    it('carries the Foul line when the Room says the Word was fouled', () => {
      start();
      d.onSnapshot(snap('playing', W2, {}, { passed: 1 }), tiltEv(W1, 'pass', true));
      const respond = sent.find((s) => s.type === 'conversation.respond');
      expect(respond?.props?.text).toBe(clueRevealMessage('giraffe', 'pass', true));
      expect(respond?.props?.text).toContain('FOUL');
      expect(sent.find((s) => s.type === 'conversation.set_emotion')?.props?.emotion).toBe('surprise');
    });

    it('defaults to the overwrite strategy', () => {
      expect(REVEAL_STRATEGY).toBe('overwrite');
      expect(REVEAL_STRATEGIES[REVEAL_STRATEGY]).toEqual({ interrupt: false, context: 'overwrite' });
    });

    it('can append the context and interrupt first', () => {
      start(make(REVEAL_STRATEGIES['interrupt-append'], false));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      expect(sent.map((s) => s.type)).toEqual(['conversation.interrupt', 'conversation.append_llm_context', 'conversation.respond']);
    });

    it('no Reveal for a word change without a PAL tilt (e.g. a resync)', () => {
      start();
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }));
      expect(sent.map((s) => s.type)).toEqual(['conversation.overwrite_llm_context']);
    });
  });

  describe('utterances → said', () => {
    it('forwards Player and PAL utterances for the current Word', () => {
      start();
      d.onTavusEvent(started('user'));
      d.onTavusEvent(utter('user', 'long neck, very tall'));
      d.onTavusEvent(started('pal'));
      d.onTavusEvent(started('replica'));
      d.onTavusEvent(utter('pal', 'Giraffe?', undefined, 'i1'));
      d.onTavusEvent(utter('replica', 'Giraffe?', undefined, 'i1'));
      expect(said()).toEqual([
        { t: 'said', wordId: 'w1', who: 'player', text: 'long neck, very tall' },
        { t: 'said', wordId: 'w1', who: 'pal', text: 'Giraffe?' },
      ]);
    });

    it('a Clue spoken before the tilt counts for its Word even if the utterance lands after the Reveal', () => {
      start();
      d.onTavusEvent(started('user'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      d.onTavusEvent(utter('user', 'it is a giraffe'));
      expect(said()).toEqual([{ t: 'said', wordId: 'w1', who: 'player', text: 'it is a giraffe' }]);
    });

    it('"yes, giraffe!" after the PAL guessed it goes to that Word, after the PAL\'s own guess', () => {
      start();
      d.onTavusEvent(started('pal'));
      d.onTavusEvent(utter('pal', 'Is it a giraffe?', undefined, 'i1'));
      d.onTavusEvent(started('user'));
      d.onTavusEvent(tiltCall('down'));
      d.onTavusEvent(utter('user', 'Yes, giraffe!'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      expect(said().map((s) => [s.wordId, s.who])).toEqual([
        ['w1', 'pal'],
        ['w1', 'player'],
      ]);
    });

    it('the Player saying the old Word after the Reveal lands on the new Word (no Foul for either)', () => {
      start();
      d.onTavusEvent(tiltCall('down'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      d.onTavusEvent(started('user'));
      d.onTavusEvent(utter('user', 'giraffe, I knew it'));
      expect(said()).toEqual([{ t: 'said', wordId: 'w2', who: 'player', text: 'giraffe, I knew it' }]);
    });

    it('without speaking events, an utterance goes to the Word current when it arrives', () => {
      start();
      d.onTavusEvent(utter('user', 'stripes'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      d.onTavusEvent(utter('user', 'flightless'));
      expect(said().map((s) => s.wordId)).toEqual(['w1', 'w2']);
    });

    it('drops a stale turn start that never got an utterance', () => {
      start();
      d.onTavusEvent(started('user'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      vi.advanceTimersByTime(TURN_MAX_MS + 1);
      d.onTavusEvent(started('user'));
      d.onTavusEvent(utter('user', 'black and white bird'));
      expect(said().map((s) => s.wordId)).toEqual(['w2']);
    });

    it('ignores our own bracketed prompts echoed back as user speech, and speech outside a Round', () => {
      start();
      d.onTavusEvent(utter('user', '[Round starting. Hype them up.]'));
      expect(said()).toEqual([]);
      d.onSnapshot({ ...snap('recap'), round: null });
      d.onTavusEvent(utter('user', 'that was fun'));
      expect(said()).toEqual([]);
    });

    it('ignores the Reveal echoed back as a user utterance, even without its leading "["', () => {
      start();
      d.onTavusEvent(started('user'));
      d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
      const reveal = clueRevealMessage('giraffe', 'got', false);
      d.onTavusEvent(utter('user', ` ${reveal.slice(1)}`));
      d.onTavusEvent(utter('user', reveal.slice(1, -1).replace(/ /g, '  ')));
      // A partial echo (long enough) is ignored too; a short Player line is not.
      d.onTavusEvent(utter('user', reveal.slice(1, 60)));
      d.onTavusEvent(utter('user', 'yes'));
      expect(said()).toEqual([{ t: 'said', wordId: 'w1', who: 'player', text: 'yes' }]);
    });

    describe('with seq', () => {
      it('places a late-delivered turn start before the Reveal by its seq', () => {
        start();
        d.onTavusEvent(utter('pal', 'Tall horse?', 10, 'i1'));
        // The tilt event reaches the Stage after seq 10; then the Player's start with seq 9 is delivered late.
        d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
        d.onTavusEvent(started('user', 9));
        d.onTavusEvent(utter('user', 'yes giraffe', 12));
        expect(said().at(-1)).toEqual({ t: 'said', wordId: 'w1', who: 'player', text: 'yes giraffe' });
      });

      it("keeps the next turn's start for the next utterance when it arrives before this turn's utterance", () => {
        start();
        d.onTavusEvent(started('user', 1));
        d.onSnapshot(snap('playing', W2, {}, { gotIt: 1 }), tiltEv(W1, 'got'));
        d.onTavusEvent(started('user', 5));
        d.onSnapshot(snap('playing', W3, {}, { gotIt: 2 }), tiltEv(W2, 'got'));
        // Utterance for the first turn (seq 3) arrives now, then the one for the second turn (seq 7).
        d.onTavusEvent(utter('user', 'first', 3));
        d.onTavusEvent(utter('user', 'second', 7));
        expect(said().map((s) => [s.text, s.wordId])).toEqual([
          ['first', 'w1'],
          ['second', 'w2'],
        ]);
      });
    });
  });

  it('routes by the Round Mode during a Round, else by the friend in the call', () => {
    expect(routeOf(snap('playing', W1))).toBe('clue');
    expect(routeOf(snap('playing', W1, { pal: { status: 'ready', mode: 'guess' } }, { mode: 'guess' }))).toBe('guess');
    expect(routeOf(snap('recap', undefined, { pal: { status: 'starting', mode: 'guess' } }))).toBe('guess');
    expect(routeOf(snap('lobby', undefined, { pal: { status: 'joining', mode: 'clue' } }))).toBe('clue');
    expect(routeOf({ ...snap('lobby'), pal: { status: 'ready' } })).toBe('guess');
  });

  describe('guard: the PAL never gets the current Word before its tilt', () => {
    it('across a scripted Clue Round through the Stage router (with the Guess director wired in)', () => {
      const out: { type: string; json: string }[] = [];
      const deps = {
        interact: (type: string, props?: Record<string, unknown>) => out.push({ type, json: JSON.stringify(props ?? {}) }),
        report: (m: ClientMsg) => reports.push(m),
        now: () => Date.now(),
        setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimer: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
      };
      const guess = new PalDirector(deps);
      const clue = new ClueDirector(deps);
      const router = new DirectorRouter(guess, clue, { now: () => Date.now() });
      const words = [W1, W2, W3, { wordId: 'w4', word: 'kangaroo', position: 3 }];
      /** Index into `out` from which each word may appear: its tilt. */
      const tiltedAt = new Map<string, number>();

      router.onSnapshot(snap('lobby'));
      router.onPalJoined();
      router.onSnapshot(snap('countdown'), { kind: 'round_start' });
      vi.advanceTimersByTime(3_000);
      let score = 0;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const prev = words[i - 1];
        const s = snap('playing', w, {}, { gotIt: score });
        if (prev) {
          tiltedAt.set(prev.wordId, out.length);
          router.onSnapshot(s, tiltEv(prev, i % 2 ? 'got' : 'pass', i === 2));
        } else router.onSnapshot(s);
        // The Room's copy and the Word QR fallback must not reach the PAL in Clue mode.
        vi.advanceTimersByTime(5_000);
        router.onQr(`omh:${w.wordId}:${w.word}`);
        router.onTavusEvent(started('user'));
        router.onTavusEvent(utter('user', `it rhymes with something, ${w.word}`));
        router.onTavusEvent(started('pal'));
        router.onTavusEvent(utter('pal', 'Is it a hippo?', undefined, `p${i}`));
        router.onTavusEvent({ event_type: 'conversation.stopped_speaking', properties: { role: 'pal' } });
        vi.advanceTimersByTime(10_000);
        router.onTavusEvent(tiltCall('down', `t${i}`));
        if (i % 2) score += 1;
      }
      router.onSnapshot({ ...snap('recap'), round: null }, { kind: 'round_end' });

      expect(out.length).toBeGreaterThan(5);
      for (const w of words) {
        const until = tiltedAt.get(w.wordId) ?? out.length;
        const leaked = out.slice(0, until).filter((e) => e.json.toLowerCase().includes(w.word));
        expect(leaked, `${w.word} reached the PAL before its tilt`).toEqual([]);
      }
      // Guess mode machinery never ran: no decoded / clue_latency / silence nudges.
      expect(reports.filter((r) => r.t === 'decoded' || r.t === 'clue_latency' || r.t === 'silence_nudge' || r.t === 'heard')).toEqual([]);
      router.dispose();
    });
  });
});
