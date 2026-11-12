// The PAL director: turns Room state changes into Tavus interactions, and Tavus events into Room reports.
// Plain class with injected I/O and timers so it can be unit tested without a call.
//
// Word transition (write-up decision 6):
//   Room pushes the next Word → interrupt the stale clue (+ quick reaction) → wait for the Word QR from the
//   camera (fallback: the Room's copy after QR_FALLBACK_MS) → overwrite the PAL's context → respond to
//   start clueing. Heard it (tool call) starts Tilt nudges. Every PAL utterance is checked for leaks.
//
// Heard it is confirmed against the Player's own words: word_guessed carries no word, and the PAL has called it
//   for an earlier Word it drifted back to. The Player's utterances are kept per Word (routed like tool calls),
//   and a call only counts if that Word's speech says the Word, waiting up to HEARD_CONFIRM_MS for it.
//
// Tilt slips (the tilt disagrees with Heard it): the tilt stays final, but the PAL reacts like a friend would.
//   No cheer for a "got" it never heard; "you had it!" for a pass on a Word it heard. Until the next Word is
//   injected the PAL's context still holds the previous Word, so a tool call in that window belongs to it.

import { HEARD_CONFIRM_MS, NUDGE_DELAYS_MS, QR_FALLBACK_MS, type CategoryId } from '../../shared/game';
import { saysWord } from '../../shared/guess';
import { leaksWord } from '../../shared/leak';
import { countdownContext, lobbyContext, recapContext, wordContext } from '../../shared/pal-context';
import type { ClientMsg, RoomEvent, Snapshot } from '../../shared/protocol';
import { parseWordQr } from '../../shared/qr';
import type { DecodeSource } from '../../shared/room';

export interface TavusEvent {
  event_type?: string;
  inference_id?: string;
  properties?: Record<string, unknown>;
}

export interface DirectorDeps {
  /** Send a Tavus interaction (`conversation.*`) over the call's data channel. */
  interact(eventType: string, properties?: Record<string, unknown>): void;
  /** Report to the Room. */
  report(msg: ClientMsg): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** Quick spoken reaction on each tilt, via echo. Off for clean latency measurements. */
  reactions?: boolean;
  rng?: () => number;
}

const GOT_LINES = ['Yes!', 'Boom!', 'Nailed it!', 'Easy!', 'There it is!'];
const PASS_LINES = ['Skip it!', 'Next!', 'Fine, next!', 'Moving on!'];
const HAD_IT_LINES = ['You had it!', 'Wait, you said it!', 'No! You got that one!'];
const NUDGE_LINES = ['Tilt it down!', 'You got it, tilt it!', 'Tilt! Tilt!'];
/** Corrections when a word_guessed is rejected, so the PAL's "tilt it down!" filler doesn't stand. */
export const PREV_WORD_CORRECTION = 'Wait, no! That was the last one. New word!';
export const NOT_QUITE_CORRECTION = 'Hang on, not quite!';

export const NEW_WORD_PROMPT = '[New word. Give your first clue now.]';
export const CALL_OUT_UNHEARD_PROMPT =
  '[New word. They tilted "got it" on the last word, but you never heard them say it. Call that out in a few playful words like a friend would; it\'s too late for that one. Then give your first clue for the new word. Don\'t discuss the last word again.]';
export const HAD_IT_PROMPT =
  '[New word. They passed the last word even though they had said it. Tease them in a few words; it\'s too late for that one. Then give your first clue for the new word. Don\'t discuss the last word again.]';
export const ROUND_START_PROMPT = '[Round starting. Hype them up in five words or fewer.]';
export const ROUND_END_PROMPT = '[Round over. React to their score in one or two sentences, then tell them to go again.]';

interface WordCtx {
  wordId: string;
  word: string;
  category: CategoryId;
  arrivedAt: number;
  injected: boolean;
  injectedAt?: number;
  fallbackTimer?: unknown;
  nudgeTimers: unknown[];
  heard: boolean;
  leaked: boolean;
  clueMeasured: boolean;
  /** The Player's utterances while this Word was in the PAL's context. */
  said: string[];
  /** The Word the tilt replaced, to tell "said the last one" apart from a plain miss. */
  prevWord?: string;
}

/** The Word a tilt just replaced, kept until the next Word is injected. */
interface PrevWord {
  wordId: string;
  word: string;
  /** The Player's utterances for this Word, including those after the tilt and before the next injection. */
  said: string[];
  outcome: 'got' | 'pass';
  heard: boolean;
  /** Heard it arrived after the tilt, before the next Word was injected. */
  heardLate: boolean;
}

type TiltInfo = Extract<RoomEvent, { kind: 'tilt' }>['result'];

/** A word_guessed call waiting for the Player's words to say its Word. */
interface PendingHeard {
  wordId: string;
  word: string;
  timer: unknown;
}

export class PalDirector {
  private phase: Snapshot['phase'] | null = null;
  private snap: Snapshot | null = null;
  private word: WordCtx | null = null;
  private prev: PrevWord | null = null;
  private seenUtterances = new Set<string>();
  private pending: PendingHeard | null = null;
  /** Any user utterance seen in this call. If none ever arrives, word_guessed is trusted as-is. */
  private userSpeechSeen = false;
  /** True once the PAL is in the call: interactions before that are dropped by Tavus. */
  private live = false;

  constructor(private d: DirectorDeps) {}

  setLive(live: boolean) {
    this.live = live;
  }

  private send(eventType: string, properties?: Record<string, unknown>) {
    if (this.live) this.d.interact(eventType, properties);
  }

  private pick(lines: string[]) {
    return lines[Math.floor((this.d.rng ?? Math.random)() * lines.length)];
  }

  private ctxArgs(): [string, Snapshot['stats']] {
    return [this.snap?.player?.nickname ?? '', this.snap?.stats ?? null];
  }

  // ---------- Room → PAL ----------

  onSnapshot(s: Snapshot, event?: RoomEvent) {
    const prev = this.phase;
    this.snap = s;
    this.phase = s.phase;

    if (event?.kind === 'round_start' && s.round) {
      this.dropWord();
      this.send('conversation.interrupt');
      this.send('conversation.overwrite_llm_context', { context: countdownContext(...this.ctxArgs(), s.round.category) });
      this.send('conversation.respond', { text: ROUND_START_PROMPT });
      return;
    }

    if (s.phase === 'playing' && s.round?.current && s.round.current.wordId !== this.word?.wordId) {
      const tilt = event?.kind === 'tilt' ? event.result : null;
      this.newWord(s.round.current.wordId, s.round.current.word, s.round.category, tilt);
      return;
    }

    if (event?.kind === 'round_end' && s.lastSummary) {
      this.dropWord();
      this.send('conversation.interrupt');
      this.send('conversation.set_emotion', { emotion: '' });
      this.send('conversation.overwrite_llm_context', {
        context: recapContext(...this.ctxArgs(), s.lastSummary, s.personalBest !== null),
      });
      this.send('conversation.respond', { text: ROUND_END_PROMPT });
      return;
    }

    if (prev === 'playing' && s.phase !== 'playing') this.dropWord();
  }

  /** The PAL just joined: make sure it knows the current state (it was created with the lobby context). */
  onPalJoined() {
    if (this.live) return;
    this.live = true;
    this.userSpeechSeen = false;
    if (this.snap && this.snap.phase !== 'playing') {
      this.send('conversation.overwrite_llm_context', { context: lobbyContext(...this.ctxArgs()) });
      return;
    }
    // Rejoined mid-Round (Stage reload or reconnect): the injection happened while nobody was listening.
    const w = this.word;
    if (w?.injected) {
      w.injectedAt = this.d.now();
      this.send('conversation.overwrite_llm_context', { context: wordContext(...this.ctxArgs(), w.category, w.word) });
      this.send('conversation.respond', { text: NEW_WORD_PROMPT });
    }
  }

  private newWord(wordId: string, word: string, category: CategoryId, tilt?: TiltInfo | null) {
    const old = this.word;
    // A pending word_guessed survives the tilt: its Word becomes the previous one and can still be confirmed.
    this.dropWord(true);
    if (tilt) {
      const same = old?.wordId === tilt.wordId;
      const heard = (same && old.heard) || tilt.heardAt !== undefined;
      const said = same ? old.said : [];
      this.prev = { wordId: tilt.wordId, word: tilt.word, said, outcome: tilt.outcome, heard, heardLate: false };
    }
    this.word = {
      wordId,
      word,
      category,
      arrivedAt: this.d.now(),
      injected: false,
      nudgeTimers: [],
      heard: false,
      leaked: false,
      clueMeasured: false,
      said: [],
      prevWord: tilt?.word ?? old?.word,
    };
    // Cut off the stale clue immediately; react while the camera reads the next Word.
    this.send('conversation.interrupt');
    const p = this.prev;
    if (p && this.d.reactions !== false) {
      // A friend who didn't hear the answer doesn't cheer: got + not heard gets no echo.
      const lines = p.outcome === 'got' ? (p.heard ? GOT_LINES : null) : p.heard ? HAD_IT_LINES : PASS_LINES;
      if (lines) {
        this.send('conversation.set_emotion', { emotion: p.outcome === 'got' ? 'happiness' : 'surprise' });
        this.send('conversation.echo', { modality: 'text', text: this.pick(lines), done: true });
      }
    }
    const w = this.word;
    w.fallbackTimer = this.d.setTimer(() => this.inject(w, 'fallback'), QR_FALLBACK_MS);
  }

  /** Word QR seen by the camera. */
  onQr(payload: string) {
    const w = this.word;
    if (!w || w.injected) return;
    if (parseWordQr(payload, w.wordId)) this.inject(w, 'qr');
  }

  private inject(w: WordCtx, source: DecodeSource) {
    if (w !== this.word || w.injected) return;
    w.injected = true;
    w.injectedAt = this.d.now();
    this.d.clearTimer(w.fallbackTimer);
    this.d.report({ t: 'decoded', wordId: w.wordId, source });
    this.send('conversation.set_emotion', { emotion: '' });
    this.send('conversation.overwrite_llm_context', { context: wordContext(...this.ctxArgs(), w.category, w.word) });
    this.send('conversation.respond', { text: this.newWordPrompt() });
    this.prev = null;
  }

  /** Prompt for the injected Word: calls out a Tilt slip on the previous Word the echo couldn't cover. */
  private newWordPrompt() {
    const p = this.prev;
    if (!p || this.d.reactions === false) return NEW_WORD_PROMPT;
    if (p.outcome === 'got' && !p.heard) return CALL_OUT_UNHEARD_PROMPT;
    if (p.outcome === 'pass' && p.heardLate) return HAD_IT_PROMPT;
    return NEW_WORD_PROMPT;
  }

  private dropWord(keepPending = false) {
    if (!keepPending) this.clearPending();
    this.prev = null;
    const w = this.word;
    if (!w) return;
    this.d.clearTimer(w.fallbackTimer);
    w.nudgeTimers.forEach((t) => this.d.clearTimer(t));
    this.word = null;
  }

  // ---------- PAL → Room ----------

  onTavusEvent(ev: TavusEvent) {
    const p = ev.properties ?? {};
    const role = p.role as string | undefined;
    const isPal = role === 'pal' || role === 'replica';
    switch (ev.event_type) {
      case 'conversation.tool_call':
        if (toolName(p) === 'word_guessed') this.onHeard();
        return;
      case 'conversation.utterance': {
        if (typeof p.speech !== 'string') return;
        // Tavus sends each user turn once (role "user"); a repeat would be harmless, matching is idempotent.
        if (role === 'user') return this.onPlayerSpeech(p.speech);
        if (!isPal) return;
        // Tavus sends PAL events twice (role "pal" and legacy "replica"); check each utterance once.
        const key = `${ev.inference_id ?? ''}:${p.speech}`;
        if (this.seenUtterances.has(key)) return;
        this.seenUtterances.add(key);
        const w = this.word;
        if (w && !w.leaked && leaksWord(p.speech, w.word)) {
          w.leaked = true;
          this.d.report({ t: 'leak', wordId: w.wordId });
        }
        return;
      }
      case 'conversation.started_speaking':
      case 'conversation.replica.started_speaking':
      case 'conversation.utterance.streaming': {
        if (ev.event_type !== 'conversation.replica.started_speaking' && !isPal) return;
        const w = this.word;
        if (w?.injectedAt !== undefined && !w.clueMeasured) {
          w.clueMeasured = true;
          this.d.report({ t: 'clue_latency', wordId: w.wordId, ms: this.d.now() - w.injectedAt });
        }
        return;
      }
    }
  }

  /** Where the PAL's context is: the injected Word, or the previous Word between a tilt and the next injection. */
  private speechTarget(): WordCtx | PrevWord | null {
    const w = this.word;
    if (!w || this.phase !== 'playing') return null;
    return w.injected ? w : this.prev;
  }

  private onPlayerSpeech(speech: string) {
    this.userSpeechSeen = true;
    const t = this.speechTarget();
    if (!t) return;
    t.said.push(speech);
    const pend = this.pending;
    if (pend && pend.wordId === t.wordId && saysWord(speech, t.word)) {
      this.clearPending();
      this.acceptHeard(t.wordId);
    }
  }

  private onHeard() {
    const t = this.speechTarget();
    if (!t || t.heard || this.pending) return;
    // Fallback: if Tavus never delivered a user utterance in this call, trust the tool call (no way to check).
    if (!this.userSpeechSeen || t.said.some((s) => saysWord(s, t.word))) {
      this.acceptHeard(t.wordId);
      return;
    }
    // The Player's latest words say the previous Word (the PAL drifted back to it): reject now, before its
    // "tilt it down!" filler gets them to tilt. Waiting out the hold would come too late.
    const w = this.word;
    const last = t === w ? w.said.at(-1) : undefined;
    if (w && last !== undefined && w.prevWord !== undefined && saysWord(last, w.prevWord) && !saysWord(last, w.word)) {
      this.rejectHeard(w.wordId);
      return;
    }
    // The tool call can land before the utterance that triggered it: give the Player's words a short window.
    const pend: PendingHeard = { wordId: t.wordId, word: t.word, timer: undefined };
    pend.timer = this.d.setTimer(() => {
      if (this.pending !== pend) return;
      this.pending = null;
      this.rejectHeard(pend.wordId);
    }, HEARD_CONFIRM_MS);
    this.pending = pend;
  }

  private clearPending() {
    if (this.pending) this.d.clearTimer(this.pending.timer);
    this.pending = null;
  }

  /** Heard it for a Word that is still the injected Word or the previous one. */
  private acceptHeard(wordId: string) {
    const w = this.word;
    if (!w || this.phase !== 'playing') return;
    if (!w.injected || w.wordId !== wordId) {
      // The PAL's context still holds the previous Word: this is a late Heard it for it. No nudges (already tilted).
      const p = this.prev;
      if (p && p.wordId === wordId && !p.heard) {
        p.heard = p.heardLate = true;
        this.d.report({ t: 'heard', wordId: p.wordId });
      }
      return;
    }
    if (w.heard) return;
    w.heard = true;
    this.d.report({ t: 'heard', wordId: w.wordId });
    // Tilt nudges: the PAL said "yes!" but the phone hasn't moved.
    w.nudgeTimers = NUDGE_DELAYS_MS.map((ms) =>
      this.d.setTimer(() => {
        if (this.word !== w) return;
        this.d.report({ t: 'nudge', wordId: w.wordId });
        this.send('conversation.echo', { modality: 'text', text: this.pick(NUDGE_LINES), done: true });
      }, ms),
    );
  }

  /** The PAL called word_guessed but the Player never said the Word: cut off its "tilt it!" filler and correct it. */
  private rejectHeard(wordId: string) {
    const w = this.word;
    // Only correct out loud while that Word is still the one being clued; after a tilt the next Word takes over.
    if (!w || !w.injected || w.wordId !== wordId || this.phase !== 'playing') return;
    this.send('conversation.interrupt');
    if (this.d.reactions === false) return;
    const saidPrev = w.prevWord !== undefined && w.said.some((s) => saysWord(s, w.prevWord!));
    this.send('conversation.echo', { modality: 'text', text: saidPrev ? PREV_WORD_CORRECTION : NOT_QUITE_CORRECTION, done: true });
  }

  dispose() {
    this.dropWord();
  }
}

/** The tool_call payload schema is undocumented; accept the shapes seen in the wild. */
export function toolName(p: Record<string, unknown>): string | undefined {
  if (typeof p.name === 'string') return p.name;
  const fn = p.function as { name?: unknown } | undefined;
  if (fn && typeof fn.name === 'string') return fn.name;
  const tc = p.tool_call as { name?: unknown } | undefined;
  if (tc && typeof tc.name === 'string') return tc.name;
  return undefined;
}
