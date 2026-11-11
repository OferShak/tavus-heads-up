import { describe, expect, it } from 'vitest';
import { encodeWordQr, parseWordQr } from './qr';

describe('Word QR payload', () => {
  it('round-trips, including multi-word Words', () => {
    expect(parseWordQr(encodeWordQr('a17', 'giraffe'))).toEqual({ wordId: 'a17', word: 'giraffe' });
    expect(parseWordQr(encodeWordQr('f05', 'ice cream'), 'f05')).toEqual({ wordId: 'f05', word: 'ice cream' });
  });

  it('stays short enough for a low-density QR', () => {
    expect(encodeWordQr('j50', 'real estate agent').length).toBeLessThanOrEqual(32);
  });

  it('ignores stray QRs without our prefix', () => {
    expect(parseWordQr('https://example.com')).toBeNull();
    expect(parseWordQr('omh:')).toBeNull();
    expect(parseWordQr('omh:a17:')).toBeNull();
    expect(parseWordQr('omh::giraffe')).toBeNull();
  });

  it('rejects stale decodes of a previous Word', () => {
    expect(parseWordQr('omh:a16:zebra', 'a17')).toBeNull();
  });
});
