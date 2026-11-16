import { TILT_DEMO_STILL, tiltDemoFrame } from '../lib/tiltDemoLoop';
import { useLoopElapsed, useReducedMotion } from '../lib/useDemoLoop';
import { PalForehead } from '../stage/PalForehead';
import './controller.css';

const nextIn = (elapsed: number) => tiltDemoFrame(elapsed).next;

/**
 * The two Guess mode gestures on two small phones (the PAL forehead drawing), each with its caption. The phones are
 * decorative; the captions carry the meaning.
 */
export function TiltDemo() {
  const still = useReducedMotion();
  const elapsed = useLoopElapsed(!still, nextIn);
  const frame = still ? TILT_DEMO_STILL : tiltDemoFrame(elapsed);
  return (
    <div className="ctl-tiltdemo">
      <div className="ctl-tiltdemo-side">
        <div className="ctl-tiltdemo-phone" aria-hidden="true">
          <PalForehead view={frame.got} />
        </div>
        <p className="ctl-tiltdemo-caption">Nod down: Got it</p>
      </div>
      <div className="ctl-tiltdemo-side">
        <div className="ctl-tiltdemo-phone" aria-hidden="true">
          <PalForehead view={frame.pass} />
        </div>
        <p className="ctl-tiltdemo-caption">Tilt back: Pass</p>
      </div>
    </div>
  );
}
