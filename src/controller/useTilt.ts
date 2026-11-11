import { useEffect, useRef, useState } from 'react';
import type { Outcome } from '../../shared/game';
import { INITIAL_TILT, screenPitch, tiltStep, type TiltState } from './tilt';

export interface OrientationStep {
  state: TiltState;
  fire?: Outcome;
  /** False when the event carried no angles (desktop browsers fire one empty event). */
  valid: boolean;
}

/**
 * One deviceorientation reading. While disabled the state stays disarmed, so once input is enabled
 * again (a new Word) the phone has to come back upright before the next tilt can fire.
 */
export function orientationStep(s: TiltState, beta: number | null, gamma: number | null, enabled: boolean): OrientationStep {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return { state: s, valid: false };
  if (!enabled) return { state: INITIAL_TILT, valid: true };
  return { ...tiltStep(s, screenPitch(beta, gamma)), valid: true };
}

type PermissionResult = 'granted' | 'denied' | 'default' | 'prompt';
type OrientationCtor = { requestPermission?: () => Promise<PermissionResult> };

export type TiltPermission = 'not-needed' | 'unasked' | 'granted' | 'denied';

export function initialTiltPermission(): TiltPermission {
  const D = (globalThis as { DeviceOrientationEvent?: OrientationCtor }).DeviceOrientationEvent;
  return typeof D?.requestPermission === 'function' ? 'unasked' : 'not-needed';
}

/**
 * iOS needs DeviceOrientationEvent.requestPermission() inside a user gesture. The call happens
 * synchronously (before the first await), so calling this from a tap handler counts as the gesture.
 */
export async function requestTiltPermission(): Promise<TiltPermission> {
  const D = (globalThis as { DeviceOrientationEvent?: OrientationCtor }).DeviceOrientationEvent;
  if (typeof D?.requestPermission !== 'function') return 'not-needed';
  try {
    return (await D.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/**
 * DeviceOrientation → screenPitch → tiltStep. Calls `onTilt` when a tilt fires while `enabled`.
 * The tilt state is reset to disarmed whenever `enabled` is off or `resetKey` changes.
 * `available` turns true once a real reading arrives (permission granted and a sensor present).
 */
export function useTilt(enabled: boolean, onTilt: (outcome: Outcome) => void, resetKey?: string | null): { available: boolean } {
  const [available, setAvailable] = useState(false);
  const stateRef = useRef<TiltState>(INITIAL_TILT);
  const enabledRef = useRef(enabled);
  const onTiltRef = useRef(onTilt);
  const keyRef = useRef(resetKey);
  const seenKeyRef = useRef(resetKey);
  const availableRef = useRef(false);
  enabledRef.current = enabled;
  onTiltRef.current = onTilt;
  keyRef.current = resetKey;

  useEffect(() => {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    const onEvent = (e: DeviceOrientationEvent) => {
      if (seenKeyRef.current !== keyRef.current) {
        seenKeyRef.current = keyRef.current;
        stateRef.current = INITIAL_TILT;
      }
      const r = orientationStep(stateRef.current, e.beta, e.gamma, enabledRef.current);
      if (!r.valid) return;
      if (!availableRef.current) {
        availableRef.current = true;
        setAvailable(true);
      }
      stateRef.current = r.state;
      if (r.fire) onTiltRef.current(r.fire);
    };
    window.addEventListener('deviceorientation', onEvent);
    return () => window.removeEventListener('deviceorientation', onEvent);
  }, []);

  return { available };
}
