import { DurableObject } from 'cloudflare:workers';
import { CATEGORIES, isCategoryId } from '../shared/game';
import { greeting, lobbyContext } from '../shared/pal-context';
import { parseClientMsg, type ClientMsg, type PlayerSummary, type Role, type RoomEvent, type ServerMsg, type Snapshot } from '../shared/protocol';
import {
  applyTilt,
  beginPlay,
  closeRoom,
  createRoom,
  endRound,
  joinController,
  markClueLatency,
  markDecoded,
  markHeard,
  markLeak,
  markNudge,
  markSilenceNudge,
  nextAlarmAt,
  setPal,
  startRound,
  type Draw,
  type PalState,
  type RoomState,
} from '../shared/room';
import { drawWord } from '../shared/words';
import { createConversation, endConversation } from './tavus';

/** A Guard lease outlives Tavus's own 600s max_call_duration, so a dead Room can't hold a slot forever. */
const LEASE_MS = 11 * 60_000;
/** Forget an abandoned Room this long after its last socket closes. */
const CLEANUP_MS = 30 * 60_000;

type PersonalBest = Snapshot['personalBest'];

/**
 * One Durable Object per Room: the single authority for game state (ADR 0002). It owns the WebSockets to
 * the Stage and the Controller, the Round timer (alarm), and the Tavus conversation lifecycle.
 * State is persisted on every change so the object can hibernate between messages.
 */
export class Room extends DurableObject<Env> {
  private get state(): RoomState | null {
    return this.ctx.storage.kv.get<RoomState>('room') ?? null;
  }

  private save(s: RoomState) {
    this.ctx.storage.kv.put('room', s);
  }

  private get stats(): PlayerSummary | null {
    return this.ctx.storage.kv.get<PlayerSummary>('stats') ?? null;
  }

  private get personalBest(): PersonalBest {
    return this.ctx.storage.kv.get<PersonalBest>('pb') ?? null;
  }

  /** Create the Room. Returns false if this code is already in use. */
  async init(code: string): Promise<boolean> {
    if (this.state) return false;
    this.save(createRoom(code, Date.now()));
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
    return true;
  }

  async info(): Promise<{ phase: RoomState['phase'] } | null> {
    const s = this.state;
    return s ? { phase: s.phase } : null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'stage' && role !== 'controller') return new Response('bad role', { status: 400 });
    if (!this.state) return new Response('no such room', { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- sockets ----------

  private sockets(role?: Role): WebSocket[] {
    return this.ctx.getWebSockets(role);
  }

  private snapshot(s: RoomState, role: Role): Snapshot {
    const r = s.round;
    return {
      code: s.code,
      phase: s.phase,
      serverNow: Date.now(),
      player: s.player ? { nickname: s.player.nickname } : null,
      stageConnected: this.sockets('stage').length > 0,
      controllerConnected: this.sockets('controller').length > 0,
      pal: {
        status: s.pal.status,
        error: s.pal.error,
        // Only the Stage joins the call.
        ...(role === 'stage' ? { conversationId: s.pal.conversationId, conversationUrl: s.pal.conversationUrl } : {}),
      },
      round: r
        ? {
            index: r.index,
            category: r.category,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            current: r.current
              ? { wordId: r.current.wordId, word: r.current.word, position: r.current.position, shownAt: r.current.shownAt, heardAt: r.current.heardAt }
              : null,
            gotIt: r.results.filter((x) => x.outcome === 'got').length,
            passed: r.results.filter((x) => x.outcome === 'pass').length,
          }
        : null,
      lastSummary: s.lastSummary,
      stats: this.stats,
      personalBest: this.personalBest,
    };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already closing
    }
  }

  private broadcast(s: RoomState, event?: RoomEvent) {
    for (const role of ['stage', 'controller'] as const) {
      const msg: ServerMsg = { t: 'state', state: this.snapshot(s, role), event };
      for (const ws of this.sockets(role)) this.send(ws, msg);
    }
  }

  private commit(s: RoomState, event?: RoomEvent) {
    this.save(s);
    this.broadcast(s, event);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const msg = parseClientMsg(raw);
    const role = this.ctx.getTags(ws)[0] as Role;
    const s = this.state;
    if (!msg || !s) {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'unreadable message' });
      return;
    }
    if (role === 'controller') await this.onController(ws, s, msg);
    else await this.onStage(s, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const s = this.state;
    if (!s) return;
    const others = this.sockets().filter((x) => x !== ws);
    if (others.length === 0) {
      // Both sockets dropped: stop paying for the PAL, and forget the Room later.
      await this.endPal(s, 'ended');
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
    } else {
      this.broadcast(this.state!);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---------- Controller ----------

  private async onController(ws: WebSocket, s: RoomState, msg: ClientMsg) {
    switch (msg.t) {
      case 'hello': {
        if (msg.role !== 'controller' || typeof msg.playerId !== 'string' || !msg.playerId) return;
        const nickname = (msg.nickname ?? '').trim().slice(0, 24);
        const j = joinController(s, { playerId: msg.playerId, nickname });
        if (!j.ok) {
          this.send(ws, { t: 'error', code: j.reason, message: j.reason === 'room_taken' ? 'Someone else is playing in this Room.' : 'This Room is closed.' });
          ws.close(4000, j.reason);
          return;
        }
        const player = this.playerStats(msg.playerId);
        if (nickname) await player.setNickname(nickname);
        this.ctx.storage.kv.put('stats', await player.getSummary());
        const first = s.phase === 'waiting';
        this.commit(j.state, first ? { kind: 'player_joined' } : undefined);
        await this.ensurePal();
        return;
      }
      case 'start': {
        if (!isCategoryId(msg.category) || !s.player) return;
        const passCounts = await this.playerStats(s.player.playerId).getPassCounts();
        this.ctx.storage.kv.put('passCounts', passCounts);
        const next = startRound(this.state!, msg.category, Date.now());
        if (next === this.state) return;
        this.ctx.storage.kv.delete('pb');
        this.commit(next, { kind: 'round_start' });
        await this.scheduleAlarm(next);
        return;
      }
      case 'tilt': {
        const r = applyTilt(s, msg.wordId, msg.outcome === 'pass' ? 'pass' : 'got', Date.now(), this.draw(s));
        if (!r.accepted) return;
        const { wordId, word, outcome, heardAt, tiltAt } = r.result;
        this.commit(r.state, { kind: 'tilt', result: { wordId, word, outcome, heardAt, tiltAt } });
        return;
      }
      case 'reconnect_pal':
        await this.ensurePal(true);
        return;
      case 'done': {
        await this.endPal(s, 'ended');
        this.commit(closeRoom(this.state!));
        await this.ctx.storage.deleteAlarm();
        return;
      }
    }
  }

  // ---------- Stage ----------

  private async onStage(s: RoomState, msg: ClientMsg) {
    const now = Date.now();
    switch (msg.t) {
      case 'hello': {
        // A reconnecting Stage has to re-join the call before the PAL counts as ready again.
        const pal: PalState = s.pal.status === 'ready' ? { ...s.pal, status: 'joining' } : s.pal;
        this.commit(setPal(s, pal));
        await this.ensurePal();
        return;
      }
      case 'pal': {
        if (msg.status === 'joined' && s.pal.status === 'joining') this.commit(setPal(s, { ...s.pal, status: 'ready' }));
        else if (msg.status === 'left' && s.pal.conversationId) await this.endPal(s, 'ended');
        else if (msg.status === 'error') await this.endPal(s, 'error', msg.error);
        return;
      }
      case 'heard':
        // May be for the Word just tilted (late tool call): that marks its result, not `current`, so the
        // snapshot looks unchanged but the save still matters for the Round summary (Tilt slips).
        this.commit(markHeard(s, msg.wordId, now));
        return;
      case 'decoded':
        this.save(markDecoded(s, msg.wordId, msg.source === 'qr' ? 'qr' : 'fallback', now));
        return;
      case 'clue_latency':
        if (typeof msg.ms === 'number' && Number.isFinite(msg.ms)) this.save(markClueLatency(s, msg.wordId, msg.ms));
        return;
      case 'leak':
        this.save(markLeak(s, msg.wordId));
        return;
      case 'nudge':
        this.save(markNudge(s, msg.wordId));
        return;
      case 'silence_nudge':
        this.save(markSilenceNudge(s, msg.wordId));
        return;
    }
  }

  // ---------- Round timer ----------

  private draw(s: RoomState): Draw {
    const category = s.round?.category ?? 'animals';
    const passCounts = this.ctx.storage.kv.get<Record<string, number>>('passCounts') ?? {};
    return (position, used) => drawWord({ words: CATEGORIES[category].words, used, passCounts, position });
  }

  private async scheduleAlarm(s: RoomState) {
    const at = nextAlarmAt(s);
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (s.phase === 'countdown') {
      const next = beginPlay(s, now, this.draw(s));
      this.commit(next);
      await this.scheduleAlarm(next);
      return;
    }
    if (s.phase === 'playing') {
      const next = endRound(s);
      if (next.lastSummary && s.player) {
        const rec = await this.playerStats(s.player.playerId).recordRound(next.lastSummary, now);
        this.ctx.storage.kv.put('stats', rec.summary);
        this.ctx.storage.kv.put('pb', rec.personalBest);
      }
      this.commit(next, { kind: 'round_end' });
      return;
    }
    // Cleanup alarm: nobody came back.
    if (this.sockets().length === 0) {
      await this.endPal(s, 'ended');
      await this.ctx.storage.deleteAll();
    }
  }

  // ---------- PAL conversation lifecycle (write-up decision 7) ----------

  private playerStats(playerId: string) {
    return this.env.PLAYER_STATS.get(this.env.PLAYER_STATS.idFromName(playerId));
  }

  private guard() {
    return this.env.GUARD.get(this.env.GUARD.idFromName('global'));
  }

  /** Start the PAL once there is real intent: a phone joined and the Stage is there to join the call. */
  private async ensurePal(retry = false) {
    let s = this.state!;
    const startable = s.pal.status === 'idle' || (retry && ['ended', 'error', 'busy'].includes(s.pal.status));
    if (!startable || !s.player || s.phase === 'closed' || this.sockets('stage').length === 0) return;

    const apiKey = this.env.TAVUS_API_KEY;
    const palId = this.env.TAVUS_PAL_ID;
    if (!apiKey || !palId) {
      this.commit(setPal(s, { status: 'offline', error: 'No Tavus key/PAL configured: playing without the PAL.' }));
      return;
    }

    this.commit(setPal(s, { status: 'starting' }));
    const cap = Number(this.env.MAX_CONCURRENT) || 1;
    if (!(await this.guard().acquire(s.code, LEASE_MS, cap))) {
      this.commit(setPal(this.state!, { status: 'busy', error: 'The PAL is busy with another player. Try again in a few minutes.' }));
      return;
    }

    const nickname = s.player.nickname;
    const testMode = this.env.TAVUS_TEST_MODE === '1';
    const r = await createConversation({
      apiKey,
      palId,
      name: `Over My Head ${s.code}`,
      context: lobbyContext(nickname, this.stats),
      greeting: greeting(nickname),
      testMode,
    }).catch((e: unknown) => ({ ok: false as const, busy: false, error: String(e) }));

    s = this.state!;
    if (!r.ok) {
      await this.guard().release(s.code);
      this.commit(setPal(s, r.busy ? { status: 'busy', error: 'The PAL is busy right now. Try again in a few minutes.' } : { status: 'error', error: r.error }));
      return;
    }
    if (testMode) {
      // Created with test_mode: the PAL never joins and no minutes are used. Play on without it.
      await this.guard().release(s.code);
      this.commit(setPal(s, { status: 'offline', conversationId: r.conversationId, error: 'Tavus test mode: conversation created, PAL not joining.' }));
      return;
    }
    this.commit(setPal(s, { status: 'joining', conversationId: r.conversationId, conversationUrl: r.conversationUrl, startedAt: Date.now() }));
  }

  private async endPal(s: RoomState, status: 'ended' | 'error', error?: string) {
    const id = s.pal.conversationId;
    const hadSlot = ['starting', 'joining', 'ready'].includes(s.pal.status);
    if (!id && !hadSlot) return;
    this.commit(setPal(s, { status, error }));
    if (hadSlot) await this.guard().release(s.code);
    if (id && this.env.TAVUS_API_KEY && s.pal.status !== 'offline') {
      await endConversation(this.env.TAVUS_API_KEY, id).catch(() => undefined);
    }
  }
}
