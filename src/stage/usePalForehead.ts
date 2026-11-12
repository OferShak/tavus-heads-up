import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Outcome } from '../../shared/game';
import type { Phase } from '../../shared/room';
import {
  foreheadStep,
  foreheadView,
  INITIAL_FOREHEAD,
  nextForeheadDeadline,
  type ForeheadEvent,
  type ForeheadState,
  type ForeheadView,
  type ForeheadWord,
} from './forehead';

/** What the PAL forehead needs from the Room snapshot. */
export interface ForeheadRoom {
  phase: Phase;
  /** Seconds left in the countdown (3, 2, 1) while phase is 'countdown', else null. */
  countdown: number | null;
  /** The Room's current Word while playing. */
  current: ForeheadWord | null;
}

export interface PalForehead {
  view: ForeheadView;
  /**
   * A PAL tilt (its `tilt` tool call). The phone tips at once; `forward` is the tilt to send to the Room,
   * or null when the guard ignored it (already tilted this Word, mid-flash, or no Word in play).
   */
  tilt(outcome: Outcome): { forward: { wordId: string; outcome: Outcome } | null };
}

/** The Room phase as a forehead event; the step is idempotent, so re-sending the same one is harmless. */
function roomEvent({ phase, countdown, current }: ForeheadRoom): ForeheadEvent | null {
  if (phase === 'countdown') return countdown !== null ? { type: 'countdown', n: countdown } : null;
  if (phase === 'playing') return current ? { type: 'word', ...current } : null;
  if (phase === 'recap') return { type: 'timesUp' };
  return { type: 'hide' };
}

/** Runs the PAL forehead state machine against the wall clock; the timers for flashes and time's up live here. */
export function usePalForehead(room: ForeheadRoom): PalForehead {
  // The ref is the source of truth so tilt() can answer synchronously; the state only drives renders.
  const ref = useRef<ForeheadState>(INITIAL_FOREHEAD);
  const [state, setState] = useState<ForeheadState>(INITIAL_FOREHEAD);

  const dispatch = useCallback((e: ForeheadEvent) => {
    const r = foreheadStep(ref.current, e, Date.now());
    if (r.state !== ref.current) {
      ref.current = r.state;
      setState(r.state);
    }
    return r;
  }, []);

  const { phase, countdown } = room;
  const wordId = room.current?.wordId;
  const word = room.current?.word;
  useEffect(() => {
    const e = roomEvent({ phase, countdown, current: wordId !== undefined && word !== undefined ? { wordId, word } : null });
    if (e) dispatch(e);
  }, [phase, countdown, wordId, word, dispatch]);

  // A tick can change nothing (flash over, Room not answered yet), so it re-arms for the next deadline itself.
  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const at = nextForeheadDeadline(ref.current, Date.now());
      if (at === null) return;
      id = setTimeout(() => {
        dispatch({ type: 'tick' });
        arm();
      }, Math.max(0, at - Date.now()));
    };
    arm();
    return () => clearTimeout(id);
  }, [state, dispatch]);

  const tilt = useCallback((outcome: Outcome) => ({ forward: dispatch({ type: 'tilt', outcome }).forward }), [dispatch]);
  const view = useMemo(() => foreheadView(state), [state]);
  return { view, tilt };
}
