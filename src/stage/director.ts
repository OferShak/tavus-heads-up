// The PAL director: turns Room state changes into Tavus interactions, and Tavus events into Room reports.
// Plain class with injected I/O and timers so it can be unit tested without a call.
//
// Word transition (write-up decision 6):
//   Room pushes the next Word → interrupt the stale clue (+ quick reaction) → wait for the Word QR from the
//   camera (fallback: the Room's copy after QR_FALLBACK_MS) → overwrite the PAL's context → respond to
//   start clueing. Heard it (tool call) starts Tilt nudges. Every PAL utterance is checked for leaks.
//
// Heard it is guarded against the PAL drifting back to a closed Word (ADR 0005): word_guessed carries no word,
//   and the PAL has called it for an earlier Word. The Player's utterances are kept per Word (routed like tool
//   calls). A call is trusted unless the Player's words say a closed Word (any Word tilted in this Room) and not
//   the Word in play; then it is rejected out loud. A call no speech confirms yet waits up to HEARD_CONFIRM_MS for
//   the utterance, and counts on timeout, on a tilt of that Word, or when the next Word is injected. Trusting the
//   PAL needs the PAL to have had the Word: one replaced before it was ever injected counts only if the Player
//   said it. A Got it tilt on a Word the Player's words say is Heard it too, with or without the PAL's call.
//
// Tilt slips (the tilt disagrees with Heard it): the tilt stays final, but the PAL reacts like a friend would.
//   No cheer for a "got" it never heard; "you had it!" for a pass on a Word it heard. Until the next Word is
//   injected the PAL's context still holds the previous Word, so a tool call in that window belongs to it.
//
// Silence nudges (Guess mode): Tavus is turn-based, so after a Clue the PAL waits for the Player. A silence clock
//   runs per Word while it is clueable (playing, injected, not Heard it, no word_guessed pending). Anyone stopping
//   speaking (re)arms it at SILENCE_NUDGE_MS; anyone starting clears it. When it fires, the PAL gets an escalating
//   Silence nudge prompt; if the PAL hasn't spoken on this Word since injection, it is a first-clue rescue instead
//   (NEW_WORD_PROMPT again, not counted). Either way FIRST_CLUE_RESCUE_MS is armed next, in case the PAL stays mute.
//   Speaking events, per docs.tavus.io (event-schemas/conversation-started-stopped-speaking, checked 2026-11):
//   `conversation.started_speaking` / `conversation.stopped_speaking` with properties.role "pal" | "user", plus a
//   legacy PAL duplicate with role "replica". The older `conversation.replica.*` / `conversation.user.*` names are
//   no longer documented there; they are still accepted.

import {
  FIRST_CLUE_RESCUE_MS,
  HEARD_CONFIRM_MS,
  NUDGE_DELAYS_MS,
  QR_FALLBACK_MS,
  SILENCE_NUDGE_MS,
  type CategoryId,
} from '../../shared/game';
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
/** Correction when a word_guessed is rejected (the Player said a closed Word), so the PAL's "tilt it down!" filler doesn't stand. */
export const PREV_WORD_CORRECTION = 'Wait, no! We already did that one!';

export const NEW_WORD_PROMPT = '[New word. Give your first clue now.]';
export const CALL_OUT_UNHEARD_PROMPT =
  '[New word. They tilted "got it" on the last word, but you never heard them say it. Call that out in a few playful words like a friend would; it\'s too late for that one. Then give your first clue for the new word. Don\'t discuss the last word again.]';
export const HAD_IT_PROMPT =
  '[New word. They passed the last word even though they had said it. Tease them in a few words; it\'s too late for that one. Then give your first clue for the new word. Don\'t discuss the last word again.]';
export const ROUND_START_PROMPT = '[Round starting. Hype them up in five words or fewer.]';
export const ROUND_END_PROMPT = '[Round over. React to their score in one or two sentences, then tell them to go again.]';
/** Silence nudge ladder: n=1, n=2, then n≥3 repeats until the Word changes. */
export const SILENCE_NUDGE_FRESH_PROMPT =
  '[They went quiet. Give a fresh clue from a new angle, more obvious than before. Never say the word or any part of it.]';
export const SILENCE_NUDGE_RHYME_PROMPT =
  '[Still quiet. Give a "sounds like" or rhyming clue now. Never say the word or any part of it.]';
export const SILENCE_NUDGE_PASS_PROMPT =
  '[They\'re stuck. Tell them "just pass it!" in a few words, then give one more clue. Never say the word or any part of it.]';

export function silenceNudgePrompt(n: number): string {
  if (n <= 1) return SILENCE_NUDGE_FRESH_PROMPT;
  if (n === 2) return SILENCE_NUDGE_RHYME_PROMPT;
  return SILENCE_NUDGE_PASS_PROMPT;
}

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
  /** Silence clock: fires a Silence nudge (or a first-clue rescue). Runs only while the Word is clueable. */
  silenceTimer?: unknown;
  /** The PAL started speaking on this Word since it was injected. Until then a firing clock is a rescue. */
  palSpoke: boolean;
  silenceNudges: number;
  /** The Player's utterances while this Word was in the PAL's context. */
  said: string[];
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
  /** The Word reached the PAL's context. If not (two fast tilts), a call for it needs the Player to have said it. */
  injected: boolean;
}

type TiltInfo = Extract<RoomEvent, { kind: 'tilt' }>['result'];

/** A word_guessed call no speech has confirmed yet, waiting briefly for the Player's utterance. */
interface PendingHeard {
  wordId: string;
  word: string;
  /** The PAL had this Word in its context, so the call counts unless speech says a closed Word. */
  trusted: boolean;
  timer: unknown;
}

export class PalDirector {
  private phase: Snapshot['phase'] | null = null;
  private snap: Snapshot | null = null;
  private word: WordCtx | null = null;
  private prev: PrevWord | null = null;
  private seenUtterances = new Set<string>();
  private pending: PendingHeard | null = null;
  /** Closed Words: every Word tilted since creation or dispose (a Room never repeats a Word). */
  private closed = new Set<string>();
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
      w.palSpoke = false;
      this.send('conversation.overwrite_llm_context', { context: wordContext(...this.ctxArgs(), w.category, w.word) });
      this.send('conversation.respond', { text: NEW_WORD_PROMPT });
      this.armSilence(FIRST_CLUE_RESCUE_MS);
    }
  }

  private newWord(wordId: string, word: string, category: CategoryId, tilt?: TiltInfo | null) {
    const old = this.word;
    // A held word_guessed is settled before its Word leaves: a tilt on the held Word counts it before the echo
    // is chosen ("Yes!" then a fast tilt gets a cheer), and a held call for the previous Word would be orphaned.
    this.settlePending();
    this.dropWord();
    if (tilt) {
      const same = old?.wordId === tilt.wordId;
      let heard = (same && old.heard) || tilt.heardAt !== undefined;
      const said = same ? old.said : [];
      // A Got it on a Word the Player's words say is Heard it, even if the PAL missed the call: the tilt confirms it.
      if (!heard && tilt.outcome === 'got' && said.some((s) => saysWord(s, tilt.word))) {
        heard = true;
        this.d.report({ t: 'heard', wordId: tilt.wordId });
      }
      const injected = same && old.injected;
      this.prev = { wordId: tilt.wordId, word: tilt.word, said, outcome: tilt.outcome, heard, heardLate: false, injected };
      this.closed.add(tilt.word);
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
      palSpoke: false,
      silenceNudges: 0,
      said: [],
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
    // A call still held for the previous Word resolves now, so the prompt below reflects it.
    this.settlePending();
    w.injected = true;
    w.injectedAt = this.d.now();
    this.d.clearTimer(w.fallbackTimer);
    this.d.report({ t: 'decoded', wordId: w.wordId, source });
    this.send('conversation.set_emotion', { emotion: '' });
    this.send('conversation.overwrite_llm_context', { context: wordContext(...this.ctxArgs(), w.category, w.word) });
    this.send('conversation.respond', { text: this.newWordPrompt() });
    this.prev = null;
    this.armSilence(FIRST_CLUE_RESCUE_MS);
  }

  /** Prompt for the injected Word: calls out a Tilt slip on the previous Word the echo couldn't cover. */
  private newWordPrompt() {
    const p = this.prev;
    if (!p || this.d.reactions === false) return NEW_WORD_PROMPT;
    if (p.outcome === 'got' && !p.heard) return CALL_OUT_UNHEARD_PROMPT;
    if (p.outcome === 'pass' && p.heardLate) return HAD_IT_PROMPT;
    return NEW_WORD_PROMPT;
  }

  private dropWord() {
    this.clearPending();
    this.prev = null;
    const w = this.word;
    if (!w) return;
    this.d.clearTimer(w.fallbackTimer);
    w.nudgeTimers.forEach((t) => this.d.clearTimer(t));
    this.stopSilence(w);
    this.word = null;
  }

  // ---------- Silence nudges ----------

  /** Whether the PAL should be clueing the current Word: Heard it hands over to Tilt nudges, a pending call waits. */
  private clueable(w: WordCtx): boolean {
    return this.live && this.phase === 'playing' && w === this.word && w.injected && !w.heard && !this.pending;
  }

  private stopSilence(w: WordCtx | null = this.word) {
    if (!w || w.silenceTimer === undefined) return;
    this.d.clearTimer(w.silenceTimer);
    w.silenceTimer = undefined;
  }

  /**
   * (Re)start the silence clock on the current Word, if it is clueable. Until the PAL has spoken on this Word the
   * next firing is a first-clue rescue, so it always waits FIRST_CLUE_RESCUE_MS: a late stopped_speaking (e.g. the
   * tilt-reaction echo ending just after injection) must not pull the rescue in and double the respond.
   */
  private armSilence(ms: number) {
    const w = this.word;
    this.stopSilence(w);
    if (!w || !this.clueable(w)) return;
    w.silenceTimer = this.d.setTimer(() => this.onSilence(w), w.palSpoke ? ms : FIRST_CLUE_RESCUE_MS);
  }

  private onSilence(w: WordCtx) {
    w.silenceTimer = undefined;
    if (!this.clueable(w)) return;
    if (w.palSpoke) {
      w.silenceNudges += 1;
      this.d.report({ t: 'silence_nudge', wordId: w.wordId });
      this.send('conversation.respond', { text: silenceNudgePrompt(w.silenceNudges) });
    } else {
      // First-clue rescue: the injection's respond produced no speech. Not a Silence nudge.
      this.send('conversation.respond', { text: NEW_WORD_PROMPT });
    }
    // If the PAL answers, its stopped-speaking re-arms at SILENCE_NUDGE_MS; if it stays mute, try again.
    this.armSilence(FIRST_CLUE_RESCUE_MS);
  }

  private onPalStartedSpeaking() {
    const w = this.word;
    if (!w) return;
    if (w.injected) w.palSpoke = true;
    this.stopSilence(w);
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
        if (role === 'user') {
          this.onPlayerSpeech(p.speech);
          // The Player finished a turn: restart the silence clock. Bracketed text may be our own
          // conversation.respond prompt echoed back, not the Player.
          if (!isAppPrompt(p.speech)) this.armSilence(SILENCE_NUDGE_MS);
          return;
        }
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
      case 'conversation.user.started_speaking':
      case 'conversation.utterance.streaming': {
        const user = ev.event_type === 'conversation.user.started_speaking' || (ev.event_type === 'conversation.started_speaking' && role === 'user');
        if (user) return this.stopSilence();
        if (ev.event_type !== 'conversation.replica.started_speaking' && !isPal) return;
        const w = this.word;
        if (w?.injectedAt !== undefined && !w.clueMeasured) {
          w.clueMeasured = true;
          this.d.report({ t: 'clue_latency', wordId: w.wordId, ms: this.d.now() - w.injectedAt });
        }
        // Streaming text isn't a speaking boundary: only started/stopped drive the silence clock.
        if (ev.event_type !== 'conversation.utterance.streaming') this.onPalStartedSpeaking();
        return;
      }
      case 'conversation.stopped_speaking':
      case 'conversation.replica.stopped_speaking':
      case 'conversation.user.stopped_speaking': {
        const legacy = ev.event_type !== 'conversation.stopped_speaking';
        if (legacy || isPal || role === 'user') this.armSilence(SILENCE_NUDGE_MS);
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
    if (pend && pend.wordId === t.wordId) {
      // The utterance behind a held call: the Word confirms it, a closed Word rejects it, anything else leaves it
      // to the PAL's judgment (counts now if the PAL had the Word, else keeps waiting for the Word).
      if (saysWord(speech, t.word)) {
        this.clearPending();
        this.acceptHeard(t.wordId);
      } else if (this.saysClosedWord(speech, t.word)) {
        this.clearPending();
        this.rejectHeard(t.wordId);
      } else if (pend.trusted) {
        this.clearPending();
        this.acceptHeard(t.wordId);
      }
      return;
    }
    // A Got it tilt the PAL never confirmed, then the Player's words for it land before the next injection:
    // the tilt plus the words make it Heard it, so the injection doesn't call out a slip that didn't happen.
    if ('outcome' in t && t.outcome === 'got' && !t.heard && saysWord(speech, t.word)) {
      this.acceptHeard(t.wordId);
    }
  }

  /** The utterance says a closed Word (one already tilted) and not the Word in play: the PAL drifted back. */
  private saysClosedWord(speech: string, word: string): boolean {
    if (saysWord(speech, word)) return false;
    for (const c of this.closed) if (c !== word && saysWord(speech, c)) return true;
    return false;
  }

  private onHeard() {
    const t = this.speechTarget();
    if (!t || t.heard || this.pending) return;
    // Trusting the PAL needs the PAL to have had the Word: not one a fast tilt replaced before injection.
    const trusted = t.injected;
    // Without any user utterance in this call there is nothing to check against: trust the call.
    if ((trusted && !this.userSpeechSeen) || t.said.some((s) => saysWord(s, t.word))) {
      this.acceptHeard(t.wordId);
      return;
    }
    // The Player's latest words say a closed Word (the PAL drifted back to it): reject now, before its
    // "tilt it down!" filler gets them to tilt. Waiting out the hold would come too late.
    const last = t.said.at(-1);
    if (last !== undefined && this.saysClosedWord(last, t.word)) {
      this.rejectHeard(t.wordId);
      return;
    }
    // The tool call can land before the utterance that triggered it: give the Player's words a short window.
    const pend: PendingHeard = { wordId: t.wordId, word: t.word, trusted, timer: undefined };
    pend.timer = this.d.setTimer(() => {
      if (this.pending !== pend) return;
      this.settlePending();
      // A held call that didn't become Heard it for the current Word (untrusted, or for the previous Word) held the
      // silence clock: restart it. No-op if it was accepted (Heard it hands over to Tilt nudges).
      this.armSilence(SILENCE_NUDGE_MS);
    }, HEARD_CONFIRM_MS);
    this.pending = pend;
    // No Silence nudge while the call waits to be confirmed.
    this.stopSilence();
  }

  /** Resolve a held call now (hold over, or its Word is leaving the PAL's context): it counts if the PAL had the Word. */
  private settlePending() {
    const pend = this.pending;
    if (!pend) return;
    this.clearPending();
    if (pend.trusted) this.acceptHeard(pend.wordId);
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
    // Tilt nudges own this Word now: the silence clock stops for good.
    this.stopSilence(w);
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

  /** The PAL called word_guessed but the Player said a closed Word: cut off its "tilt it!" filler and correct it. */
  private rejectHeard(wordId: string) {
    const w = this.word;
    // Only correct out loud while that Word is still the one being clued; after a tilt the next Word takes over.
    if (!w || !w.injected || w.wordId !== wordId || this.phase !== 'playing') return;
    this.send('conversation.interrupt');
    // Clueable again: restart the silence clock.
    this.armSilence(SILENCE_NUDGE_MS);
    if (this.d.reactions === false) return;
    this.send('conversation.echo', { modality: 'text', text: PREV_WORD_CORRECTION, done: true });
  }

  dispose() {
    this.dropWord();
    this.closed.clear();
  }
}

/** Our conversation.respond prompts are wrapped in [square brackets]; one echoed back as a user utterance isn't the Player. */
function isAppPrompt(speech: string): boolean {
  return /^\s*\[[\s\S]*\]\s*$/.test(speech);
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
