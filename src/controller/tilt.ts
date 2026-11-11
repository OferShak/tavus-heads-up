import type { Outcome } from '../../shared/game';

/** Fire a tilt past this angle. */
export const TILT_FIRE_DEG = 35;
/** Must come back within this angle (upright on the forehead) before the next tilt can fire. */
export const TILT_NEUTRAL_DEG = 20;

const RAD = Math.PI / 180;

/**
 * Pitch of the screen's normal above the horizon, in degrees, from DeviceOrientationEvent beta/gamma.
 * +90 = screen faces the ceiling, -90 = the floor, 0 = upright on the forehead.
 *
 * The world-vertical component of the device z axis is cos(beta)·cos(gamma) (W3C Z-X'-Y'' Euler angles).
 * Unlike raw gamma, it is continuous through the ±90° wrap you hit when a landscape phone stands upright,
 * and it does not depend on landscape vs portrait, so no screen.orientation.angle normalization is needed.
 */
export function screenPitch(beta: number, gamma: number): number {
  const up = Math.cos(beta * RAD) * Math.cos(gamma * RAD);
  return Math.asin(Math.max(-1, Math.min(1, up))) / RAD;
}

export interface TiltState {
  armed: boolean;
}

export const INITIAL_TILT: TiltState = { armed: false };

/**
 * Nod down (screen to the floor) = Got it; tilt back (screen to the ceiling) = Pass.
 * Starts disarmed: the phone must be seen upright first, so picking it up off a table can't fire.
 */
export function tiltStep(s: TiltState, pitch: number): { state: TiltState; fire?: Outcome } {
  if (!s.armed) return Math.abs(pitch) < TILT_NEUTRAL_DEG ? { state: { armed: true } } : { state: s };
  if (pitch <= -TILT_FIRE_DEG) return { state: { armed: false }, fire: 'got' };
  if (pitch >= TILT_FIRE_DEG) return { state: { armed: false }, fire: 'pass' };
  return { state: s };
}
