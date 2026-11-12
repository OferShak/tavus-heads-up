import { describe, expect, it } from 'vitest';
import { isMode } from './game';

describe('isMode', () => {
  it('accepts only the two Modes', () => {
    expect(isMode('guess')).toBe(true);
    expect(isMode('clue')).toBe(true);
    expect(isMode('reverse')).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });
});
