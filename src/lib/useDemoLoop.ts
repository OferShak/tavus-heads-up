// Timer and reduced-motion hooks for the tilt demos (tiltDemoLoop.ts). Shared by the Controller and the Stage, so it
// lives outside both chunks and imports no CSS.

import { useEffect, useState } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => typeof matchMedia === 'function' && matchMedia(REDUCE).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(REDUCE);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

/**
 * Time since the loop started, updated only when the frame changes. `nextIn(elapsed)` says how many ms until the
 * frame after `elapsed` changes; pass a module-level function (it is an effect dependency).
 */
export function useLoopElapsed(running: boolean, nextIn: (elapsed: number) => number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = performance.now() - start;
      setElapsed(t);
      id = setTimeout(tick, nextIn(t));
    };
    id = setTimeout(tick, nextIn(0));
    return () => clearTimeout(id);
  }, [running, nextIn]);
  return elapsed;
}
