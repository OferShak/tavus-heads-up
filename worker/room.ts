import { DurableObject } from 'cloudflare:workers';
import { CATEGORIES, FRIENDS, isCategoryId, isMode, type Mode, type Outcome, type Who } from '../shared/game';
import { clueGreeting, clueLobbyContext, greeting, lobbyContext, swapRecap } from '../shared/pal-context';
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
  markSaid,
  markSilenceNudge,
  nextAlarmAt,
  selectMode,
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

/** PAL statuses that hold a Guard lease (and maybe a live conversation). */
const LIVE: PalState['status'][] = ['starting', 'joining', 'ready'];

/** Tavus settings, from env unless a test overrides them (see `tavusOverride`). */
interface TavusConfig {
  apiKey: string;
  palIds: Record<Mode, string>;
  testMode: boolean;
  fetch: typeof fetch;
}

/** Rooms stored before Clue mode existed have no Mode: they were Guess mode. */
function withModes(s: RoomState): RoomState {
  if (s.mode && (!s.round || s.round.mode)) return s;
  return { ...s, mode: s.mode ?? 'guess', round: s.round ? { ...s.round, mode: s.round.mode ?? 'guess' } : null };
}

/**
 * One Durable Object per Room: the single authority for game state (ADR 0002). It owns the WebSockets to
 * the Stage and the Controller, the Round timer (alarm), and the Tavus conversation lifecycle.
 * State is persisted on every change so the object can hibernate between messages.
 */
export class Room extends DurableObject<Env> {
  /** Test seam (set through runInDurableObject): replaces env Tavus settings and the fetch used for Tavus calls. */
  tavusOverride: Partial<TavusConfig> | null = null;

  /**
   * PAL lifecycle operations (start, swap, end) run one at a time. Tavus calls are outgoing fetches, which let other
   * messages in mid-operation; serializing keeps rapid Mode toggling from overlapping two conversations.
   */
  private palQueue: Promise<void> = Promise.resolve();

  private get state(): RoomState | null {
    const s = this.ctx.storage.kv.get<RoomState>('room');
    return s ? withModes(s) : null;
  }

  private save(s: RoomState) {
    this.ctx.storage.kv.put('room', s);
  }

  /** The Player's Training stats for one Mode, cached from PlayerStats (on join and at each Round's end). */
  private stats(mode: Mode): PlayerSummary | null {
    const byMode = this.ctx.storage.kv.get<Partial<Record<Mode, PlayerSummary>>>('statsByMode');
    if (byMode) return byMode[mode] ?? null;
    // Rooms stored before Modes existed cached one Guess mode summary.
    const legacy = mode === 'guess' ? this.ctx.storage.kv.get<Omit<PlayerSummary, 'mode' | 'fouls'>>('stats') : undefined;
    return legacy ? { ...legacy, mode: 'guess', fouls: 0 } : null;
  }

  private cacheStats(stats: Partial<Record<Mode, PlayerSummary>>) {
    const byMode = this.ctx.storage.kv.get<Partial<Record<Mode, PlayerSummary>>>('statsByMode') ?? {};
    this.ctx.storage.kv.put('statsByMode', { ...byMode, ...stats });
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
    // Clue mode: the Word is on the PAL's forehead (Stage) only. The phone must not show it, or the PAL could read it.
    const current = r?.current && (r.mode === 'guess' || role === 'stage') ? r.current : null;
    return {
      code: s.code,
      phase: s.phase,
      mode: s.mode,
      serverNow: Date.now(),
      player: s.player ? { nickname: s.player.nickname } : null,
      stageConnected: this.sockets('stage').length > 0,
      controllerConnected: this.sockets('controller').length > 0,
      pal: {
        status: s.pal.status,
        error: s.pal.error,
        mode: s.pal.mode ?? 'guess',
        // Only the Stage joins the call.
        ...(role === 'stage' ? { conversationId: s.pal.conversationId, conversationUrl: s.pal.conversationUrl } : {}),
      },
      round: r
        ? {
            index: r.index,
            category: r.category,
            mode: r.mode,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            current: current
              ? { wordId: current.wordId, word: current.word, position: current.position, shownAt: current.shownAt, heardAt: current.heardAt }
              : null,
            gotIt: r.results.filter((x) => x.outcome === 'got').length,
            passed: r.results.filter((x) => x.outcome === 'pass').length,
          }
        : null,
      lastSummary: s.lastSummary,
      stats: this.stats(s.mode),
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
      await this.endPal('ended');
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
        this.cacheStats(await player.getSummaries());
        const first = s.phase === 'waiting';
        this.commit(j.state, first ? { kind: 'player_joined' } : undefined);
        await this.ensurePal();
        return;
      }
      case 'start': {
        if (!isCategoryId(msg.category) || !s.player) return;
        const passCounts = await this.playerStats(s.player.playerId).getPassCounts(s.mode);
        this.ctx.storage.kv.put('passCounts', passCounts);
        const next = startRound(this.state!, msg.category, Date.now());
        if (next === this.state) return;
        this.ctx.storage.kv.delete('pb');
        this.commit(next, { kind: 'round_start' });
        await this.scheduleAlarm(next);
        return;
      }
      case 'mode': {
        if (!isMode(msg.mode)) return;
        const next = selectMode(s, msg.mode);
        if (next === s) return;
        this.commit(next);
        await this.palOp(() => this.followMode());
        return;
      }
      case 'tilt':
        // Clue Rounds: the Controller has no role, so the pure logic rejects the Player's tilt.
        this.tilt(s, msg.wordId, msg.outcome, 'player');
        return;
      case 'reconnect_pal':
        await this.ensurePal(true);
        return;
      case 'done': {
        await this.endPal('ended');
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
        // Only about the call the Stage was given: once swapped (ADR 0004), a report about the old call is ignored.
        const about = typeof msg.conversationId === 'string' ? msg.conversationId : s.pal.conversationId;
        if (about !== s.pal.conversationId) return;
        if (msg.status === 'joined' && s.pal.status === 'joining') this.commit(setPal(s, { ...s.pal, status: 'ready' }));
        else if (msg.status === 'left' && about) await this.endPal('ended', undefined, about);
        else if (msg.status === 'error' && about) await this.endPal('error', msg.error, about);
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
      case 'pal_tilt':
        this.tilt(s, msg.wordId, msg.outcome, 'pal');
        return;
      case 'said':
        if (typeof msg.text !== 'string' || (msg.who !== 'player' && msg.who !== 'pal')) return;
        // Foul / palSaidAt aren't in the Snapshot (the Foul travels with the Reveal), so nothing to broadcast.
        this.save(markSaid(s, msg.wordId, msg.who, msg.text, now));
        return;
    }
  }

  /** A tilt from whoever is guessing (`by`); broadcast with `foul` and `by` so the Stage can send the Reveal. */
  private tilt(s: RoomState, wordId: string, outcome: Outcome, by: Who) {
    const r = applyTilt(s, wordId, outcome === 'pass' ? 'pass' : 'got', Date.now(), this.draw(s), by);
    if (!r.accepted) return;
    const { heardAt, tiltAt, foul } = r.result;
    this.commit(r.state, { kind: 'tilt', result: { wordId: r.result.wordId, word: r.result.word, outcome: r.result.outcome, heardAt, tiltAt, foul, by } });
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
        this.cacheStats({ [rec.summary.mode]: rec.summary });
        this.ctx.storage.kv.put('pb', rec.personalBest);
      }
      this.commit(next, { kind: 'round_end' });
      return;
    }
    // Cleanup alarm: nobody came back.
    if (this.sockets().length === 0) {
      await this.endPal('ended');
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

  private tavus(): TavusConfig {
    const o = this.tavusOverride ?? {};
    return {
      apiKey: o.apiKey ?? this.env.TAVUS_API_KEY,
      palIds: o.palIds ?? { guess: this.env.TAVUS_PAL_ID, clue: this.env.TAVUS_CLUE_PAL_ID },
      testMode: o.testMode ?? this.env.TAVUS_TEST_MODE === '1',
      fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    };
  }

  /** Run a PAL lifecycle operation after the ones already queued (see palQueue). */
  private palOp(op: () => Promise<void>): Promise<void> {
    const run = this.palQueue.then(op);
    this.palQueue = run.catch(() => undefined);
    return run;
  }

  /** Start the PAL once there is real intent: a phone joined and the Stage is there to join the call. */
  private ensurePal(retry = false): Promise<void> {
    return this.palOp(async () => {
      const s = this.state!;
      const startable = s.pal.status === 'idle' || (retry && ['ended', 'error', 'busy'].includes(s.pal.status));
      if (startable) await this.startPal(s.mode);
    });
  }

  /**
   * After a Mode change (ADR 0004): if the other Mode's friend is in the call (or being started), swap. If the PAL
   * failed or was busy for the other friend, try the selected Mode's friend instead (picking a Mode is intent).
   */
  private async followMode() {
    const s = this.state!;
    const palMode = s.pal.mode ?? 'guess';
    if (palMode === s.mode) return;
    if (LIVE.includes(s.pal.status)) await this.swapPal(s);
    else if (s.pal.status === 'error' || s.pal.status === 'busy') await this.startPal(s.mode);
  }

  /**
   * End the live conversation and start one with the selected Mode's friend, told the last Round in one line. The
   * Guard lease is per Room, so it is kept across the swap (startPal's acquire refreshes it): no other Room can take
   * the slot in between, and there is never a second lease.
   */
  private async swapPal(s: RoomState) {
    const old = s.pal.conversationId;
    // The Stage leaves the old call as soon as the snapshot loses its URL.
    this.commit(setPal(s, { status: 'starting', mode: s.mode }));
    const t = this.tavus();
    if (old && t.apiKey) await endConversation(t.apiKey, old, t.fetch).catch(() => undefined);
    await this.startPal(s.mode, swapRecap(s.player?.nickname ?? '', s.lastSummary));
  }

  /** Create a conversation with `mode`'s friend. Runs inside palOp. A held lease (swap) is refreshed, not doubled. */
  private async startPal(mode: Mode, recap: string | null = null) {
    let s = this.state!;
    if (!s.player || s.phase === 'closed' || this.sockets('stage').length === 0) {
      // Nothing to start for; a swap that got here already ended the old conversation, so give its slot back.
      if (LIVE.includes(s.pal.status)) await this.endPalNow('ended');
      return;
    }

    const t = this.tavus();
    const palId = t.palIds[mode];
    if (!t.apiKey || (mode === 'guess' && !palId)) {
      if (LIVE.includes(s.pal.status)) await this.guard().release(s.code);
      this.commit(setPal(s, { status: 'offline', mode, error: 'No Tavus key/PAL configured: playing without the PAL.' }));
      return;
    }
    if (!palId) {
      if (LIVE.includes(s.pal.status)) await this.guard().release(s.code);
      const name = FRIENDS[mode].name;
      this.commit(setPal(s, { status: 'error', mode, error: `${name} (the Clue mode PAL) isn't set up: TAVUS_CLUE_PAL_ID is empty.` }));
      return;
    }

    this.commit(setPal(s, { status: 'starting', mode }));
    const cap = Number(this.env.MAX_CONCURRENT) || 1;
    if (!(await this.guard().acquire(s.code, LEASE_MS, cap))) {
      this.commit(setPal(this.state!, { status: 'busy', mode, error: 'The PAL is busy with another player. Try again in a few minutes.' }));
      return;
    }

    const nickname = s.player.nickname;
    const context = mode === 'clue' ? clueLobbyContext(nickname, this.stats('clue')) : lobbyContext(nickname, this.stats('guess'));
    const r = await createConversation(
      {
        apiKey: t.apiKey,
        palId,
        name: `Over My Head ${s.code}`,
        context: recap ? `${context}\n${recap}` : context,
        greeting: mode === 'clue' ? clueGreeting(nickname) : greeting(nickname),
        testMode: t.testMode,
      },
      t.fetch,
    ).catch((e: unknown) => ({ ok: false as const, busy: false, error: String(e) }));

    s = this.state!;
    if (!r.ok) {
      await this.guard().release(s.code);
      this.commit(setPal(s, r.busy ? { status: 'busy', mode, error: 'The PAL is busy right now. Try again in a few minutes.' } : { status: 'error', mode, error: r.error }));
      return;
    }
    if (t.testMode) {
      // Created with test_mode: the PAL never joins and no minutes are used. Play on without it.
      await this.guard().release(s.code);
      this.commit(setPal(s, { status: 'offline', mode, conversationId: r.conversationId, error: 'Tavus test mode: conversation created, PAL not joining.' }));
      return;
    }
    this.commit(setPal(s, { status: 'joining', mode, conversationId: r.conversationId, conversationUrl: r.conversationUrl, startedAt: Date.now() }));
  }

  /**
   * End the conversation and give the Guard lease back. Queued behind any start or swap in flight, so it ends what
   * that created. `onlyIf`: a Stage report about a specific conversation, ignored once that one is gone (swapped).
   */
  private endPal(status: 'ended' | 'error', error?: string, onlyIf?: string): Promise<void> {
    return this.palOp(() => this.endPalNow(status, error, onlyIf));
  }

  /** endPal's body, for use inside a palOp (queueing it there would wait on itself). */
  private async endPalNow(status: 'ended' | 'error', error?: string, onlyIf?: string) {
    const s = this.state;
    if (!s || (onlyIf !== undefined && s.pal.conversationId !== onlyIf)) return;
    const id = s.pal.conversationId;
    const hadSlot = LIVE.includes(s.pal.status);
    if (!id && !hadSlot) return;
    this.commit(setPal(s, { status, error, mode: s.pal.mode }));
    if (hadSlot) await this.guard().release(s.code);
    const t = this.tavus();
    if (id && t.apiKey && s.pal.status !== 'offline') {
      await endConversation(t.apiKey, id, t.fetch).catch(() => undefined);
    }
  }
}
