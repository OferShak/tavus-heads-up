// Routes the Stage's Room snapshots and Tavus events to the director for the friend in the call (ADR 0004):
// PalDirector for Guess mode (Anna gives Clues), ClueDirector for Clue mode (Maya guesses). Only one is active; the
// other gets nothing and is kept off the call, so Guess mode's Word injection can never reach Maya and Clue mode
// changes can't touch Guess mode. Also measures the friend swap for the write-up.

import type { Mode } from '../../shared/game';
import type { RoomEvent, Snapshot } from '../../shared/protocol';
import { routeOf, type ClueTavusEvent } from './clue-director';
import type { TavusEvent } from './director';

export interface StageDirector {
  onSnapshot(s: Snapshot, event?: RoomEvent): void;
  onTavusEvent(ev: TavusEvent): void;
  onPalJoined(): void;
  setLive(live: boolean): void;
  dispose(): void;
}

export interface GuessStageDirector extends StageDirector {
  onQr(payload: string): void;
}

/** Friend swap: from the PAL going to `starting` for the other Mode to the new friend's first speech. */
export interface SwapMeasure {
  from: Mode;
  to: Mode;
  /** starting → the new friend joined the call. */
  joinMs: number | null;
  /** starting → the new friend's first speech. */
  ms: number;
}

interface PendingSwap {
  from: Mode;
  to: Mode;
  startedAt: number;
  joinedAt: number | null;
}

const SPEAKING = new Set(['conversation.started_speaking', 'conversation.replica.started_speaking']);

export class DirectorRouter {
  private route: Mode = 'guess';
  /** The friend of the last snapshot with a conversation under way. */
  private friend: Mode | null = null;
  private swap: PendingSwap | null = null;

  constructor(
    private guess: GuessStageDirector,
    private clue: StageDirector,
    private d: { now(): number; onSwap?(m: SwapMeasure): void },
  ) {}

  get active(): Mode {
    return this.route;
  }

  private director(m: Mode): StageDirector {
    return m === 'clue' ? this.clue : this.guess;
  }

  onSnapshot(s: Snapshot, event?: RoomEvent) {
    this.trackSwap(s);
    const next = routeOf(s);
    if (next !== this.route) {
      const old = this.director(this.route);
      old.dispose();
      old.setLive(false);
      this.route = next;
    }
    this.director(this.route).onSnapshot(s, event);
  }

  onTavusEvent(ev: TavusEvent) {
    const sw = this.swap;
    if (sw && sw.joinedAt !== null && ev.event_type && SPEAKING.has(ev.event_type)) {
      const role = ev.properties?.role;
      if (ev.event_type === 'conversation.replica.started_speaking' || role === 'pal' || role === 'replica') {
        this.swap = null;
        const now = this.d.now();
        this.d.onSwap?.({ from: sw.from, to: sw.to, joinMs: sw.joinedAt - sw.startedAt, ms: now - sw.startedAt });
      }
    }
    this.director(this.route).onTavusEvent(ev as ClueTavusEvent);
  }

  onPalJoined() {
    if (this.swap && this.swap.joinedAt === null) this.swap.joinedAt = this.d.now();
    this.director(this.route === 'clue' ? 'guess' : 'clue').setLive(false);
    this.director(this.route).onPalJoined();
  }

  /** Word QR from the camera: Guess mode only. */
  onQr(payload: string) {
    if (this.route === 'guess') this.guess.onQr(payload);
  }

  setLive(live: boolean) {
    this.guess.setLive(live);
    this.clue.setLive(live);
  }

  dispose() {
    this.guess.dispose();
    this.clue.dispose();
  }

  private trackSwap(s: Snapshot) {
    const status = s.pal.status;
    const friend = s.pal.mode ?? 'guess';
    if (status === 'starting' && this.friend !== null && friend !== this.friend && this.swap?.to !== friend) {
      this.swap = { from: this.friend, to: friend, startedAt: this.d.now(), joinedAt: null };
    } else if (this.swap && (status === 'error' || status === 'busy' || status === 'ended' || status === 'offline' || friend !== this.swap.to)) {
      this.swap = null;
    }
    if (status === 'starting' || status === 'joining' || status === 'ready') this.friend = friend;
  }
}
