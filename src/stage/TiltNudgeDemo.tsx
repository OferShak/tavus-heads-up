import { NUDGE_DEMO_STILL, nudgeDemoFrame } from '../lib/tiltDemoLoop';
import { useLoopElapsed, useReducedMotion } from '../lib/useDemoLoop';
import { PalForehead } from './PalForehead';

const nextIn = (elapsed: number) => nudgeDemoFrame(elapsed).next;

/**
 * Shown with a Tilt nudge (Guess mode): one small phone nodding down to Got it, docked over the Self-view so it reads
 * as "your phone, do this". Place inside `.stage-hero`; styles in stage.css. The phone is decorative and the caption
 * is plain text: the PAL already says it aloud and "Heard it" already has role=status, so no live region here.
 */
export function TiltNudgeDemo() {
  const still = useReducedMotion();
  const elapsed = useLoopElapsed(!still, nextIn);
  const view = still ? NUDGE_DEMO_STILL : nudgeDemoFrame(elapsed).view;
  return (
    <div className="stage-nudge">
      <div className="stage-nudge-phone" aria-hidden="true">
        <PalForehead view={view} />
      </div>
      <p className="stage-nudge-caption">Nod down!</p>
    </div>
  );
}
