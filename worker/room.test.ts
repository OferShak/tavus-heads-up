import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ServerMsg, Snapshot } from '../shared/protocol';

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
