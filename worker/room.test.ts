import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ServerMsg, Snapshot } from '../shared/protocol';
import type { RoomState } from '../shared/room';
import type { Room } from './room';

const BASE = 'https://omh.test';

async function newRoom(): Promise<string> {
  const res = await exports.default.fetch(`${BASE}/api/rooms`, { method: 'POST' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

/** A WebSocket client that records every message and can wait for one matching a predicate. */
async function connect(code: string, role: 'stage' | 'controller') {
  const res = await exports.default.fetch(`${BASE}/ws/${code}?role=${role}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data as string) as ServerMsg;
    const w = waiters.find((x) => x.pred(m));
    if (!w) return void msgs.push(m);
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(m);
  });
  return {
    ws,
    msgs,
    send: (m: object) => ws.send(JSON.stringify(m)),
    next(pred: (m: ServerMsg) => boolean): Promise<ServerMsg> {
      const seen = msgs.find(pred);
      if (seen) {
        msgs.splice(msgs.indexOf(seen), 1);
        return Promise.resolve(seen);
      }
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    async state(pred: (s: Snapshot) => boolean): Promise<Snapshot> {
      for (;;) {
        const m = await this.next((x) => x.t === 'state');
        if (m.t === 'state' && pred(m.state)) return m.state;
      }
    },
  };
}

const roomStub = (code: string) => env.ROOM.get(env.ROOM.idFromName(code));

describe('Room Durable Object', () => {
  it('creates rooms with distinct readable codes', async () => {
    const a = await newRoom();
    const b = await newRoom();
    expect(a).toMatch(/^[A-HJKMNP-Z2-9]{5}$/);
    expect(a).not.toBe(b);
    const info = await exports.default.fetch(`${BASE}/api/rooms/${a}`);
    expect(await info.json()).toMatchObject({ code: a, phase: 'waiting' });
    expect((await exports.default.fetch(`${BASE}/api/rooms/ZZZZZ`)).status).toBe(404);
  });

  it('refuses sockets for unknown rooms', async () => {
    const res = await exports.default.fetch(`${BASE}/ws/ZZZZ9?role=stage`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
  });

  it('plays a full Round: join → start → countdown → tilts → recap with Training stats', async () => {
    const code = await newRoom();
    const stage = await connect(code, 'stage');
    stage.send({ t: 'hello', role: 'stage' });
    await stage.state((s) => s.phase === 'waiting');

    const phone = await connect(code, 'controller');
    phone.send({ t: 'hello', role: 'controller', playerId: 'player-1', nickname: 'Ofer' });
    // No Tavus key in tests → PAL is "offline" and the game is still playable.
    const lobby = await phone.state((s) => s.phase === 'lobby' && s.pal.status === 'offline');
    expect(lobby.player).toEqual({ nickname: 'Ofer' });
    expect(lobby.stageConnected).toBe(true);

    phone.send({ t: 'start', category: 'animals' });
    const countdown = await stage.state((s) => s.phase === 'countdown');
    expect(countdown.round?.category).toBe('animals');
    expect(countdown.round?.current).toBeNull();

    await runDurableObjectAlarm(roomStub(code));
    const play = await phone.state((s) => s.phase === 'playing');
    const first = play.round!.current!;
    expect(first.position).toBe(0);
    // The Stage gets the Room's copy too (fallback injection + leak guard), but never the conversation URL leaks to the phone.
    const stagePlay = await stage.state((s) => s.phase === 'playing');
    expect(stagePlay.round!.current!.wordId).toBe(first.wordId);
    expect(play.pal.conversationUrl).toBeUndefined();

    // Stage reports: QR decoded, PAL heard it.
    stage.send({ t: 'decoded', wordId: first.wordId, source: 'qr' });
    stage.send({ t: 'heard', wordId: first.wordId });
    await phone.state((s) => s.round?.current?.heardAt !== undefined);

    // Stale tilt is ignored; the right one advances and is broadcast as an event to both clients.
    phone.send({ t: 'tilt', wordId: 'nope', outcome: 'got', via: 'tilt' });
    phone.send({ t: 'tilt', wordId: first.wordId, outcome: 'got', via: 'tilt' });
    const tiltMsg = await stage.next((m) => m.t === 'state' && m.event?.kind === 'tilt');
    if (tiltMsg.t !== 'state' || tiltMsg.event?.kind !== 'tilt') throw new Error();
    expect(tiltMsg.event.result).toMatchObject({ wordId: first.wordId, outcome: 'got' });
    expect(tiltMsg.state.round!.gotIt).toBe(1);
    const second = tiltMsg.state.round!.current!;
    expect(second.wordId).not.toBe(first.wordId);
    expect(second.position).toBe(1);

    // Double tilt on the same word (phone bounce) only counts once.
    phone.send({ t: 'tilt', wordId: second.wordId, outcome: 'pass', via: 'tap' });
    phone.send({ t: 'tilt', wordId: second.wordId, outcome: 'pass', via: 'tap' });
    await phone.state((s) => s.round?.passed === 1);

    // Late Heard it for the Word just passed (tool call landed after the tilt): a Tilt slip, still a Pass.
    await stage.state((s) => s.round?.passed === 1);
    stage.msgs.length = 0;
    stage.send({ t: 'heard', wordId: second.wordId });
    await stage.next((m) => m.t === 'state');

    // Time's up.
    await runDurableObjectAlarm(roomStub(code));
    const recap = await stage.state((s) => s.phase === 'recap');
    // PAL offline in tests, so the unheard Got it is not a slip.
    expect(recap.lastSummary).toMatchObject({ gotIt: 1, passed: 1, qrDecoded: 1, heardCount: 2, passedAfterHeard: 1, gotUnheard: 0 });
    expect(recap.lastSummary!.words.map((w) => w.outcome)).toEqual(['got', 'pass', 'unfinished']);
    expect(recap.lastSummary!.words[1].slip).toBe('passed_after_heard');
    expect(recap.stats).toMatchObject({ nickname: 'Ofer', roundsPlayed: 1, bests: { animals: 1 }, tiltSlips: 1, passedAfterHeard: 1, gotUnheard: 0 });
    expect(recap.personalBest).toEqual({ category: 'animals', score: 1, previous: null });

    // Training stats persist per Player, across Rooms.
    const stats = await env.PLAYER_STATS.get(env.PLAYER_STATS.idFromName('player-1')).getSummary();
    expect(stats.roundsPlayed).toBe(1);
    expect(stats.mostPassed).toEqual([{ word: recap.lastSummary!.words[1].word, passes: 1 }]);

    // Done closes the Room.
    phone.send({ t: 'done' });
    await stage.state((s) => s.phase === 'closed');
    stage.ws.close();
    phone.ws.close();
  });

  it('turns away a second phone', async () => {
    const code = await newRoom();
    const a = await connect(code, 'controller');
    a.send({ t: 'hello', role: 'controller', playerId: 'p-a' });
    await a.state((s) => s.phase === 'lobby');
    const b = await connect(code, 'controller');
    b.send({ t: 'hello', role: 'controller', playerId: 'p-b' });
    const err = await b.next((m) => m.t === 'error');
    expect(err).toMatchObject({ t: 'error', code: 'room_taken' });
    a.ws.close();
  });

  it('does not start a Round before the PAL is ready or offline', async () => {
    const code = await newRoom();
    // No Stage connected → PAL stays idle, so Start is refused.
    const phone = await connect(code, 'controller');
    phone.send({ t: 'hello', role: 'controller', playerId: 'p-idle' });
    const lobby = await phone.state((s) => s.phase === 'lobby');
    expect(lobby.pal.status).toBe('idle');
    phone.send({ t: 'start', category: 'jobs' });
    phone.send({ t: 'hello', role: 'controller', playerId: 'p-idle' });
    const after = await phone.state(() => true);
    expect(after.phase).toBe('lobby');
    phone.ws.close();
  });
});

/**
 * A fake Tavus API: records calls, numbers conversations conv-1, conv-2, … and can hold creates until released.
 * Injected into the Room with the tavusOverride test seam, so no test reaches the real API (even with a key in .dev.vars).
 */
function fakeTavus() {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  let n = 0;
  let gate: Promise<void> | null = null;
  let open = () => {};
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/end')) return new Response('{}');
    const id = `conv-${++n}`;
    if (gate) await gate;
    return new Response(JSON.stringify({ conversation_id: id, conversation_url: `https://tavus.daily.co/${id}` }));
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    creates: () => calls.filter((c) => !c.url.endsWith('/end')).map((c) => c.body!),
    ends: () => calls.filter((c) => c.url.endsWith('/end')).map((c) => c.url.split('/').at(-2)),
    hold() {
      gate = new Promise((r) => (open = r));
    },
    release() {
      gate = null;
      open();
    },
  };
}

const guard = () => env.GUARD.get(env.GUARD.idFromName('global'));

/** A Room with both PALs configured against a fake Tavus, the Stage connected and Anna (Guess mode) in the call. */
async function palRoom(playerId: string, clueId = 'pal-clue') {
  const code = await newRoom();
  const tavus = fakeTavus();
  await runInDurableObject(roomStub(code), (room: Room) => {
    room.tavusOverride = { apiKey: 'k', palIds: { guess: 'pal-guess', clue: clueId }, testMode: false, fetch: tavus.fetch };
  });
  const stage = await connect(code, 'stage');
  stage.send({ t: 'hello', role: 'stage' });
  await stage.state((s) => s.phase === 'waiting');
  const phone = await connect(code, 'controller');
  phone.send({ t: 'hello', role: 'controller', playerId, nickname: 'Sam' });
  const joining = await stage.state((s) => s.pal.status === 'joining');
  expect(joining.pal).toMatchObject({ mode: 'guess', conversationId: 'conv-1' });
  stage.send({ t: 'pal', status: 'joined' });
  await phone.state((s) => s.pal.status === 'ready');
  return { code, tavus, stage, phone };
}

type Client = Awaited<ReturnType<typeof connect>>;

/** Countdown → playing. Returns the Stage's and the phone's first playing snapshots. */
async function startRound(code: string, stage: Client, phone: Client, category: string) {
  phone.send({ t: 'start', category });
  await stage.state((s) => s.phase === 'countdown');
  await runDurableObjectAlarm(roomStub(code));
  return { stage: await stage.state((s) => s.phase === 'playing'), phone: await phone.state((s) => s.phase === 'playing') };
}

async function tiltEvent(c: Client) {
  const m = await c.next((x) => x.t === 'state' && x.event?.kind === 'tilt');
  if (m.t !== 'state' || m.event?.kind !== 'tilt') throw new Error('no tilt event');
  return { state: m.state, result: m.event.result };
}

describe('Clue mode', () => {
  it('plays a Clue Round after a Guess Round: swap to Maya, PAL tilts, Fouls, per-Mode stats, no repeated Words', async () => {
    const { code, tavus, stage, phone } = await palRoom('clue-1');
    expect(tavus.creates()[0]).toMatchObject({ pal_id: 'pal-guess' });
    expect(String(tavus.creates()[0].custom_greeting)).toContain('Sam');

    // A Guess Round first (Anna clues, the phone tilts).
    const guess = await startRound(code, stage, phone, 'animals');
    expect(guess.phone.round).toMatchObject({ mode: 'guess' });
    expect(guess.phone.round!.current).not.toBeNull();
    phone.send({ t: 'tilt', wordId: guess.phone.round!.current!.wordId, outcome: 'got', via: 'tilt' });
    const gt = await tiltEvent(stage);
    expect(gt.result).toMatchObject({ outcome: 'got', by: 'player' });
    await runDurableObjectAlarm(roomStub(code));
    const guessRecap = await stage.state((s) => s.phase === 'recap');
    const guessWords = guessRecap.lastSummary!.words.map((w) => w.wordId);

    // Pick Clue mode: Anna's conversation ends, Maya's starts with her own PAL, lobby context and a one-line recap.
    phone.send({ t: 'mode', mode: 'clue' });
    const swapped = await stage.state((s) => s.pal.status === 'joining' && s.pal.mode === 'clue');
    expect(swapped.mode).toBe('clue');
    expect(swapped.pal.conversationId).toBe('conv-2');
    expect(tavus.ends()).toEqual(['conv-1']);
    const endAt = tavus.calls.findIndex((c) => c.url.endsWith('/conv-1/end'));
    const createAt = tavus.calls.findIndex((c) => c.body?.pal_id === 'pal-clue');
    expect(endAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(endAt);
    const maya = tavus.creates()[1];
    expect(maya.pal_id).toBe('pal-clue');
    expect(String(maya.conversational_context)).toContain('NO word on your forehead');
    expect(String(maya.conversational_context)).toContain('Sam just scored 1 in Animals in Guess mode.');
    expect(String(maya.custom_greeting)).toMatch(/My turn to guess/);
    // Stats follow the selected Mode.
    expect(swapped.stats).toMatchObject({ mode: 'clue', roundsPlayed: 0, fouls: 0 });

    stage.send({ t: 'pal', status: 'joined' });
    await phone.state((s) => s.pal.status === 'ready' && s.pal.mode === 'clue');

    // Same Category: the Room never repeats a Word, across Modes.
    const clue = await startRound(code, stage, phone, 'animals');
    expect(clue.phone.round).toMatchObject({ mode: 'clue', current: null });
    const first = clue.stage.round!.current!;
    expect(first.word).toBeTruthy();
    expect(guessWords).not.toContain(first.wordId);

    // The phone has no role in a Clue Round: its tilt is ignored.
    phone.send({ t: 'tilt', wordId: first.wordId, outcome: 'got', via: 'tilt' });
    // The Player says the Word before the PAL did: a Foul. Then the PAL tilts on their say-so.
    stage.send({ t: 'said', wordId: first.wordId, who: 'player', text: `it's a ${first.word}, come on` });
    stage.send({ t: 'pal_tilt', wordId: first.wordId, outcome: 'got' });
    const t1 = await tiltEvent(stage);
    expect(t1.result).toMatchObject({ wordId: first.wordId, word: first.word, outcome: 'got', by: 'pal', foul: true });
    expect(t1.state.round).toMatchObject({ gotIt: 1, passed: 0 });
    const second = t1.state.round!.current!;
    expect(guessWords).not.toContain(second.wordId);
    const phoneAfter = await phone.state((s) => s.round?.gotIt === 1);
    expect(phoneAfter.round!.current).toBeNull();

    // PAL says it first, then the Player confirms: no Foul. Stage-only messages from the phone are ignored.
    phone.send({ t: 'pal_tilt', wordId: second.wordId, outcome: 'got' });
    phone.send({ t: 'said', wordId: second.wordId, who: 'player', text: second.word });
    stage.send({ t: 'said', wordId: second.wordId, who: 'pal', text: `${second.word}?` });
    stage.send({ t: 'said', wordId: second.wordId, who: 'player', text: `yes ${second.word}!` });
    stage.send({ t: 'pal_tilt', wordId: second.wordId, outcome: 'pass' });
    const t2 = await tiltEvent(stage);
    expect(t2.result).toMatchObject({ wordId: second.wordId, outcome: 'pass', by: 'pal' });
    expect(t2.result.foul).toBeUndefined();
    expect(t2.state.round).toMatchObject({ gotIt: 1, passed: 1 });

    await runDurableObjectAlarm(roomStub(code));
    const recap = await stage.state((s) => s.phase === 'recap');
    expect(recap.lastSummary).toMatchObject({ mode: 'clue', gotIt: 1, passed: 1, fouls: 1 });
    expect(recap.lastSummary!.words.slice(0, 2)).toMatchObject([{ wordId: first.wordId, foul: true }, { wordId: second.wordId, outcome: 'pass' }]);
    expect(recap.stats).toMatchObject({ mode: 'clue', nickname: 'Sam', roundsPlayed: 1, bests: { animals: 1 }, fouls: 1, reactionLagMs: null, tiltSlips: 0 });
    expect(recap.personalBest).toEqual({ category: 'animals', score: 1, previous: null });

    // Guess mode stats are kept apart.
    const player = env.PLAYER_STATS.get(env.PLAYER_STATS.idFromName('clue-1'));
    expect(await player.getSummary('guess')).toMatchObject({ mode: 'guess', roundsPlayed: 1, bests: { animals: 1 }, fouls: 0 });
    expect(await player.getSummary('clue')).toMatchObject({ roundsPlayed: 1, fouls: 1, mostPassed: [{ word: second.word, passes: 1 }] });

    // Done ends Maya's conversation and frees the Guard slot.
    phone.send({ t: 'done' });
    await stage.state((s) => s.phase === 'closed');
    expect(tavus.ends()).toEqual(['conv-1', 'conv-2']);
    expect(await guard().active()).toBe(0);
    stage.ws.close();
    phone.ws.close();
  });

  it('rapid Mode toggling ends every stale conversation and keeps one Guard lease', async () => {
    const { tavus, stage, phone } = await palRoom('clue-toggle');
    expect(await guard().active()).toBe(1);

    // Toggles that land while Maya is still being created: Maya joins, then Anna comes back.
    tavus.hold();
    phone.send({ t: 'mode', mode: 'clue' });
    const starting = await stage.state((s) => s.pal.status === 'starting' && s.pal.mode === 'clue');
    expect(starting.pal.conversationUrl).toBeUndefined();
    phone.send({ t: 'mode', mode: 'guess' });
    await phone.state((s) => s.mode === 'guess');
    expect(await guard().active()).toBe(1);
    tavus.release();
    await stage.state((s) => s.pal.status === 'joining' && s.pal.mode === 'guess' && s.pal.conversationId === 'conv-3');
    expect(tavus.creates().map((c) => c.pal_id)).toEqual(['pal-guess', 'pal-clue', 'pal-guess']);
    expect(tavus.ends()).toEqual(['conv-1', 'conv-2']);
    expect(await guard().active()).toBe(1);

    // Toggles that all land before the create returns collapse into one swap.
    tavus.hold();
    phone.send({ t: 'mode', mode: 'clue' });
    phone.send({ t: 'mode', mode: 'guess' });
    phone.send({ t: 'mode', mode: 'clue' });
    for (const mode of ['clue', 'guess', 'clue']) await phone.state((s) => s.mode === mode);
    tavus.release();
    const final = await stage.state((s) => s.pal.status === 'joining' && s.pal.mode === 'clue');
    expect(final.pal.conversationId).toBe('conv-4');
    // A late "left" naming an old call doesn't end the new one.
    stage.send({ t: 'pal', status: 'left', conversationId: 'conv-3' });
    stage.send({ t: 'pal', status: 'joined' });
    await stage.state((s) => s.pal.status === 'ready');
    expect(tavus.creates()).toHaveLength(4);
    expect(tavus.ends()).toEqual(['conv-1', 'conv-2', 'conv-3']);
    expect(await guard().active()).toBe(1);

    phone.send({ t: 'done' });
    await stage.state((s) => s.phase === 'closed');
    expect(tavus.ends()).toEqual(['conv-1', 'conv-2', 'conv-3', 'conv-4']);
    expect(await guard().active()).toBe(0);
    stage.ws.close();
    phone.ws.close();
  });

  it('reports a PAL error when the Clue PAL is not set up, and brings Anna back on Guess mode', async () => {
    const { tavus, stage, phone } = await palRoom('clue-missing', '');
    phone.send({ t: 'mode', mode: 'clue' });
    const err = await phone.state((s) => s.pal.status === 'error');
    expect(err.pal).toMatchObject({ mode: 'clue' });
    expect(err.pal.error).toMatch(/Maya.*TAVUS_CLUE_PAL_ID/);
    expect(tavus.ends()).toEqual(['conv-1']);
    expect(await guard().active()).toBe(0);

    // No Clue Round without Maya.
    phone.send({ t: 'start', category: 'food' });
    phone.send({ t: 'hello', role: 'controller', playerId: 'clue-missing', nickname: 'Sam' });
    expect((await phone.state(() => true)).phase).toBe('lobby');

    phone.send({ t: 'mode', mode: 'guess' });
    const back = await stage.state((s) => s.pal.status === 'joining' && s.pal.mode === 'guess');
    expect(back.pal.conversationId).toBe('conv-2');
    expect(tavus.creates().map((c) => c.pal_id)).toEqual(['pal-guess', 'pal-guess']);
    expect(await guard().active()).toBe(1);

    phone.send({ t: 'done' });
    await stage.state((s) => s.phase === 'closed');
    expect(await guard().active()).toBe(0);
    stage.ws.close();
    phone.ws.close();
  });

  it('plays Clue mode with the PAL offline (no Tavus key)', async () => {
    const code = await newRoom();
    await runInDurableObject(roomStub(code), (room: Room) => {
      room.tavusOverride = { apiKey: '', palIds: { guess: '', clue: '' } };
    });
    const stage = await connect(code, 'stage');
    stage.send({ t: 'hello', role: 'stage' });
    const phone = await connect(code, 'controller');
    phone.send({ t: 'hello', role: 'controller', playerId: 'clue-offline' });
    await phone.state((s) => s.pal.status === 'offline');
    phone.send({ t: 'mode', mode: 'clue' });
    const lobby = await phone.state((s) => s.mode === 'clue');
    expect(lobby.pal.status).toBe('offline');
    const { stage: play } = await startRound(code, stage, phone, 'jobs');
    expect(play.round).toMatchObject({ mode: 'clue' });
    stage.send({ t: 'pal_tilt', wordId: play.round!.current!.wordId, outcome: 'got' });
    expect((await tiltEvent(stage)).result).toMatchObject({ by: 'pal' });
    stage.ws.close();
    phone.ws.close();
  });

  it('reads Rooms stored before Clue mode as Guess mode', async () => {
    const code = await newRoom();
    await runInDurableObject(roomStub(code), (_room: Room, state) => {
      const s = state.storage.kv.get<RoomState>('room')!;
      const { mode: _m, ...legacy } = { ...s, phase: 'recap' as const, player: { playerId: 'legacy-1', nickname: 'Old' }, pal: { status: 'offline' as const } };
      state.storage.kv.put('room', legacy);
      state.storage.kv.put('stats', { nickname: 'Old', roundsPlayed: 3, bests: { food: 2 }, wordsPerMinute: 2, reactionLagMs: 900, mostPassed: [], tiltSlips: 0, passedAfterHeard: 0, gotUnheard: 0 });
    });
    const stage = await connect(code, 'stage');
    stage.send({ t: 'hello', role: 'stage' });
    const snap = await stage.state(() => true);
    expect(snap.mode).toBe('guess');
    expect(snap.pal.mode).toBe('guess');
    expect(snap.stats).toMatchObject({ mode: 'guess', fouls: 0, roundsPlayed: 3, reactionLagMs: 900 });
    stage.ws.close();
  });
});

describe('Guard', () => {
  it('caps concurrent conversations and frees slots on release', async () => {
    const g = env.GUARD.get(env.GUARD.idFromName('test-guard'));
    expect(await g.acquire('R1', 60_000, 1)).toBe(true);
    expect(await g.acquire('R1', 60_000, 1)).toBe(true); // same room refreshes its lease
    expect(await g.acquire('R2', 60_000, 1)).toBe(false);
    await g.release('R1');
    expect(await g.acquire('R2', 60_000, 1)).toBe(true);
  });

  it('expires leases from rooms that died without releasing', async () => {
    const g = env.GUARD.get(env.GUARD.idFromName('test-guard-ttl'));
    expect(await g.acquire('R1', -1, 1)).toBe(true);
    expect(await g.acquire('R2', 60_000, 1)).toBe(true);
  });
});
