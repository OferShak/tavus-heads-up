// The Clue mode director: the Clue PAL (Maya) guesses, the Player gives Clues (ADR 0004, write-up "Stretch: Clue mode").
// Plain class with injected I/O and timers, like PalDirector, so it can be unit tested without a call. It runs only
// while the friend in the call is the Clue friend; none of Guess mode's machinery (Silence nudges, Tilt nudges,
// Heard it, Word QR, leak guard) exists here.
//
// The PAL is NEVER given the current Word. It gets the lobby / countdown / Round (Word number and score) / recap
// contexts from shared/pal-context.ts, and hears a Word only in its Reveal, after its own tilt.
//
// PAL tilt: the `tilt` tool call (direction down|up) becomes `pal_tilt` for the current Word; the Room scores it and
//   broadcasts the tilt event (with `foul`), which triggers the Reveal (see REVEAL_STRATEGY) and the next Word's
//   Round context.
// Utterances → `said` for the Foul rule. An utterance arrives at the end of a turn, so it is attributed to the Word
//   that was current when that speaker STARTED the turn: a Clue spoken before the tilt still counts for its Word, and
//   the Player saying the old Word after the Reveal lands on the new Word (no Foul). With `seq` on Tavus events, the
//   order is taken from it (a late-delivered event is placed where it happened); without it, arrival order.

import type { Mode, Outcome, Who } from '../../shared/game';
import {
  clueCountdownContext,
  clueLobbyContext,
  clueRecapContext,
  clueRevealMessage,
  clueRoundContext,
  swapRecap,
} from '../../shared/pal-context';
import type { ClientMsg, PlayerSummary, RoomEvent, Snapshot } from '../../shared/protocol';
import { toolName, type TavusEvent } from './director';

/** Tavus events carry `seq` for reconciling out-of-order delivery. */
export type ClueTavusEvent = TavusEvent & { seq?: number };

export interface ClueDirectorDeps {
  /** Send a Tavus interaction (`conversation.*`) over the call's data channel. */
  interact(eventType: string, properties?: Record<string, unknown>): void;
  /** Report to the Room. */
  report(msg: ClientMsg): void;
  now(): number;
  /** Debug panel (`?debug`): every tilt tool call, raw, with what the director did with it. */
  log?(label: string, data: unknown): void;
  /** set_emotion on each Reveal. Off for clean latency measurements. */
  reactions?: boolean;
  /** How the Reveal reaches the PAL. Default: REVEAL_STRATEGIES[REVEAL_STRATEGY]. */
  reveal?: RevealStrategy;
  /** A PAL tilt was just sent to the Room (once per sent `pal_tilt`): the Stage tips the PAL forehead phone at once. */
  onTilt?(outcome: Outcome): void;
}

/**
 * How the Reveal is delivered after a PAL tilt. Always: the next Word's Round context (never naming it), then
 * `conversation.respond` with the Reveal so the PAL reacts out loud. A live Tavus spike picks the best one.
 */
export interface RevealStrategy {
  /** `conversation.interrupt` first: cuts off the PAL's tilt filler ("okay, skipping!") so the Reveal lands now. */
  interrupt: boolean;
  /** How the Round context reaches the PAL: replace it (like Guess mode's new Word) or append to it. */
  context: 'overwrite' | 'append';
}

export const REVEAL_STRATEGIES = {
  /** Same as director.ts for a new Word: overwrite_llm_context + respond. */
  overwrite: { interrupt: false, context: 'overwrite' },
  /** append_llm_context + respond: keeps the earlier context (e.g. the swap recap line) but grows each Word. */
  append: { interrupt: false, context: 'append' },
  'interrupt-overwrite': { interrupt: true, context: 'overwrite' },
  'interrupt-append': { interrupt: true, context: 'append' },
} as const satisfies Record<string, RevealStrategy>;

export type RevealStrategyName = keyof typeof REVEAL_STRATEGIES;

/** The Reveal delivery in use. The Stage's `?reveal=<name>` overrides it for the live spike. */
export const REVEAL_STRATEGY: RevealStrategyName = 'overwrite';

export function isRevealStrategyName(v: unknown): v is RevealStrategyName {
  return typeof v === 'string' && Object.hasOwn(REVEAL_STRATEGIES, v);
}

export const CLUE_ROUND_START_PROMPT = "[Round starting. You're guessing. Hype them up in five words or fewer.]";
export const CLUE_GO_PROMPT = '[The Round is on. Say "go!" or similar in three words or fewer, then listen for their first clue.]';
export const CLUE_ROUND_END_PROMPT = '[Round over. React to your score together in one or two sentences, then tell them to go again.]';

/** A turn longer than this is unlikely in a 60s Round; an older unanswered start (noise, no utterance) is dropped. */
export const TURN_MAX_MS = 15_000;

/** A word in the Round and the event order from which it was current on the Stage. */
interface Boundary {
  wordId: string;
  from: number;
}

interface TurnStart {
  order: number;
  at: number;
}

export class ClueDirector {
  private snap: Snapshot | null = null;
  /** Words of the current Clue Round, oldest first. The last one is current. */
  private words: Boundary[] = [];
  /** The wordId a pal_tilt was sent for, until the Room moves on: one tilt per Word in flight. */
  private tiltSentFor: string | null = null;
  private seenToolCalls = new Set<string>();
  /** Recent conversation.respond texts, normalized: Tavus echoes them back as user utterances. */
  private recentResponds: string[] = [];
  private seenPalUtterances = new Set<string>();
  /** Turn starts not yet matched to an utterance, per speaker. */
  private starts: Record<Who, TurnStart[]> = { player: [], pal: [] };
  /** Highest event order seen (`seq`, or arrival order without it). */
  private lastOrder = 0;
  private live = false;

  constructor(private d: ClueDirectorDeps) {}

  setLive(live: boolean) {
    this.live = live;
  }

  private send(eventType: string, properties?: Record<string, unknown>) {
    if (!this.live) return;
    if (eventType === 'conversation.respond' && typeof properties?.text === 'string') {
      this.recentResponds = [...this.recentResponds, normalizeSpeech(properties.text)].slice(-RESPOND_ECHO_MEMORY);
    }
    this.d.interact(eventType, properties);
  }

  private get strategy(): RevealStrategy {
    return this.d.reveal ?? REVEAL_STRATEGIES[REVEAL_STRATEGY];
  }

  private nickname() {
    return this.snap?.player?.nickname ?? '';
  }

  /** snap.stats is for the Room's selected Mode; only Clue mode stats belong in Maya's context. */
  private stats(): PlayerSummary | null {
    const st = this.snap?.stats ?? null;
    return st?.mode === 'clue' ? st : null;
  }

  private clueRound(s: Snapshot = this.snap!) {
    return s?.round?.mode === 'clue' ? s.round : null;
  }

  private roundContext(): string | null {
    const r = this.clueRound();
    if (!r?.current) return null;
    return clueRoundContext(this.nickname(), r.category, r.current.position + 1, r.gotIt, this.stats());
  }

  private get currentWordId(): string | null {
    return this.words.at(-1)?.wordId ?? null;
  }

  // ---------- Room → PAL ----------

  onSnapshot(s: Snapshot, event?: RoomEvent) {
    this.snap = s;
    const round = this.clueRound(s);

    if (event?.kind === 'round_start' && round) {
      this.resetRound();
      this.send('conversation.interrupt');
      this.send('conversation.overwrite_llm_context', { context: clueCountdownContext(this.nickname(), round.category, this.stats()) });
      this.send('conversation.respond', { text: CLUE_ROUND_START_PROMPT });
      return;
    }

    if (s.phase === 'playing' && round?.current) {
      const cur = round.current;
      if (cur.wordId === this.currentWordId) return;
      const first = this.words.length === 0;
      this.words.push({ wordId: cur.wordId, from: this.lastOrder });
      this.tiltSentFor = null;
      const tilt = event?.kind === 'tilt' && event.result.by === 'pal' ? event.result : null;
      if (tilt) this.reveal(tilt.word, tilt.outcome, tilt.foul === true);
      else this.sendRoundContext(first && cur.position === 0 ? CLUE_GO_PROMPT : null);
      return;
    }

    if (event?.kind === 'round_end' && s.lastSummary?.mode === 'clue') {
      this.resetRound();
      this.send('conversation.interrupt');
      this.send('conversation.set_emotion', { emotion: '' });
      this.send('conversation.overwrite_llm_context', {
        context: clueRecapContext(this.nickname(), s.lastSummary, s.personalBest !== null, this.stats()),
      });
      this.send('conversation.respond', { text: CLUE_ROUND_END_PROMPT });
      return;
    }

    if (s.phase !== 'playing') this.resetRound();
  }

  /** The Round context for the current Word (overwrite), and optionally a prompt to speak. */
  private sendRoundContext(prompt: string | null) {
    const context = this.roundContext();
    if (!context) return;
    this.send('conversation.overwrite_llm_context', { context });
    if (prompt) this.send('conversation.respond', { text: prompt });
  }

  /** The Reveal of the Word just tilted, then the Round context for the next Word (which it never names). */
  private reveal(word: string, outcome: Outcome, foul: boolean) {
    const st = this.strategy;
    if (st.interrupt) this.send('conversation.interrupt');
    if (this.d.reactions !== false) {
      this.send('conversation.set_emotion', { emotion: outcome === 'got' && !foul ? 'happiness' : 'surprise' });
    }
    const context = this.roundContext();
    if (context) {
      this.send(st.context === 'append' ? 'conversation.append_llm_context' : 'conversation.overwrite_llm_context', { context });
    }
    this.send('conversation.respond', { text: clueRevealMessage(word, outcome, foul) });
  }

  /** The PAL just joined: brief it on the current state (it was created with the lobby context and a swap recap). */
  onPalJoined() {
    if (this.live) return;
    this.live = true;
    const s = this.snap;
    if (!s) return;
    if (s.phase === 'playing' && this.clueRound(s)?.current) {
      this.sendRoundContext(null);
      return;
    }
    const round = this.clueRound(s);
    if (s.phase === 'countdown' && round) {
      this.send('conversation.overwrite_llm_context', { context: clueCountdownContext(this.nickname(), round.category, this.stats()) });
      return;
    }
    const recap = swapRecap(this.nickname(), s.lastSummary);
    const lobby = clueLobbyContext(this.nickname(), this.stats());
    this.send('conversation.overwrite_llm_context', { context: recap ? `${lobby}\n${recap}` : lobby });
  }

  private resetRound() {
    this.words = [];
    this.tiltSentFor = null;
    this.starts = { player: [], pal: [] };
  }

  dispose() {
    this.resetRound();
  }

  // ---------- PAL → Room ----------

  /** Event order: `seq` when Tavus sends it, else just after the latest event seen (arrival order). */
  private orderOf(ev: ClueTavusEvent): number {
    const o = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : this.lastOrder + 1e-3;
    this.lastOrder = Math.max(this.lastOrder, o);
    return o;
  }

  onTavusEvent(ev: ClueTavusEvent) {
    const p = ev.properties ?? {};
    const role = p.role as string | undefined;
    const isPal = role === 'pal' || role === 'replica';
    const order = this.orderOf(ev);
    switch (ev.event_type) {
      case 'conversation.tool_call':
        if (toolName(p) === 'tilt') this.onTiltCall(ev);
        return;
      case 'conversation.started_speaking':
        if (role === 'user') this.onStarted('player', order);
        else if (isPal) this.onStarted('pal', order);
        return;
      case 'conversation.user.started_speaking':
        this.onStarted('player', order);
        return;
      case 'conversation.replica.started_speaking':
        this.onStarted('pal', order);
        return;
      case 'conversation.utterance': {
        if (typeof p.speech !== 'string') return;
        if (role === 'user') {
          // Our own bracketed respond text echoed back is not the Player.
          // Seen live: the echo can lose its leading "[", and the Reveal's echo names the Word (it would foul it).
          if (isAppPrompt(p.speech) || this.isRespondEcho(p.speech)) return;
          this.onUtterance('player', p.speech, order);
          return;
        }
        if (!isPal) return;
        // Tavus sends PAL events twice (role "pal" and legacy "replica"): forward each utterance once.
        const key = `${ev.inference_id ?? ''}:${p.speech}`;
        if (this.seenPalUtterances.has(key)) return;
        this.seenPalUtterances.add(key);
        this.onUtterance('pal', p.speech, order);
        return;
      }
    }
  }

  private isRespondEcho(speech: string): boolean {
    const n = normalizeSpeech(speech);
    if (!n) return false;
    // Equal, or a long enough piece of one (a partial echo); short Player lines like "yes" never match.
    return this.recentResponds.some((r) => r === n || (n.length >= RESPOND_ECHO_MIN_PART && r.includes(n)));
  }

  private onTiltCall(ev: ClueTavusEvent) {
    const p = ev.properties ?? {};
    const direction = tiltDirection(p);
    const outcome: Outcome | null = direction === 'down' ? 'got' : direction === 'up' ? 'pass' : null;
    const ids = toolCallIds(ev);
    const wordId = this.currentWordId;
    const round = this.snap ? this.clueRound(this.snap) : null;
    let action: string;
    if (ids.some((id) => this.seenToolCalls.has(id))) action = 'duplicate';
    else if (!outcome) action = 'bad_direction';
    else if (this.snap?.phase !== 'playing' || !round?.current || !wordId) action = 'outside_round';
    else if (this.tiltSentFor === wordId) action = 'in_flight';
    else action = 'sent';
    ids.forEach((id) => this.seenToolCalls.add(id));
    this.d.log?.('clue: tilt tool_call', { action, direction: direction ?? null, wordId, raw: ev });
    if (action !== 'sent' || !outcome || !wordId) return;
    this.tiltSentFor = wordId;
    this.d.report({ t: 'pal_tilt', wordId, outcome });
    this.d.onTilt?.(outcome);
  }

  private onStarted(who: Who, order: number) {
    this.starts[who].push({ order, at: this.d.now() });
  }

  /** The wordId current at event order `o`, or null before the Round's first Word. */
  private wordAt(o: number): string | null {
    for (let i = this.words.length - 1; i >= 0; i--) if (this.words[i].from < o) return this.words[i].wordId;
    return null;
  }

  private onUtterance(who: Who, text: string, order: number) {
    const now = this.d.now();
    // This turn's starts: those before the utterance. Later ones belong to the next turn and stay.
    const mine = this.starts[who].filter((s) => s.order < order && now - s.at <= TURN_MAX_MS);
    this.starts[who] = this.starts[who].filter((s) => s.order >= order);
    const first = mine.reduce<TurnStart | null>((a, s) => (a === null || s.order < a.order ? s : a), null);
    const wordId = (first ? this.wordAt(first.order) : null) ?? this.wordAt(order);
    if (!wordId || this.words.length === 0) return;
    this.d.report({ t: 'said', wordId, who, text });
  }
}

/** Our conversation.respond prompts are wrapped in [square brackets]; one echoed back as a user utterance isn't the Player. */
function isAppPrompt(speech: string): boolean {
  return /^\s*\[[\s\S]*\]\s*$/.test(speech);
}

/** The tool_call payload schema is undocumented: arguments may sit in several places, as a JSON string or an object. */
export function toolArguments(p: Record<string, unknown>): Record<string, unknown> | null {
  const fn = p.function as Record<string, unknown> | undefined;
  const tc = p.tool_call as Record<string, unknown> | undefined;
  const candidates = [p.arguments, p.args, p.parameters, p.input, fn?.arguments, tc?.arguments, tc?.args];
  for (const c of candidates) {
    const parsed = parseArgs(c);
    if (parsed) return parsed;
  }
  return null;
}

function parseArgs(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `direction` from the tilt call's arguments (or top level), normalized; null when missing or unknown. */
export function tiltDirection(p: Record<string, unknown>): 'down' | 'up' | null {
  const raw = toolArguments(p)?.direction ?? p.direction;
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase();
  return d === 'down' || d === 'up' ? d : null;
}

/**
 * Ids for de-duplicating a tool call: the inference_id and the call's own id ("call_…", seen live as `id` next to
 * `function`). A call is a duplicate if any of its ids was seen.
 */
function toolCallIds(ev: ClueTavusEvent): string[] {
  const p = ev.properties ?? {};
  const tc = p.tool_call as Record<string, unknown> | undefined;
  const ids = [ev.inference_id, p.tool_call_id, p.id, tc?.id];
  return [...new Set(ids.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/** How many recent respond texts are remembered for echo matching. */
const RESPOND_ECHO_MEMORY = 4;
/** A partial echo must be at least this long (normalized) to match. */
const RESPOND_ECHO_MIN_PART = 24;

/** For echo matching: no brackets, collapsed whitespace, lower case. */
function normalizeSpeech(text: string): string {
  return text.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Which director the Stage routes to: the Round's Mode during a Round, else the friend in the call (ADR 0004). */
export function routeOf(s: Snapshot): Mode {
  const inRound = (s.phase === 'countdown' || s.phase === 'playing') && s.round;
  return (inRound ? (s.round!.mode ?? 'guess') : (s.pal.mode ?? 'guess')) === 'clue' ? 'clue' : 'guess';
}
