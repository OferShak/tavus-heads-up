// Word QR payload: `omh:<wordId>:<word>` (ADR 0003).

const PREFIX = 'omh:';

export function encodeWordQr(wordId: string, word: string): string {
  return `${PREFIX}${wordId}:${word}`;
}

export interface WordQr {
  wordId: string;
  word: string;
}

/** Returns the decoded Word only if the payload is ours and matches the current wordId. */
export function parseWordQr(payload: string, currentWordId?: string): WordQr | null {
  if (!payload.startsWith(PREFIX)) return null;
  const rest = payload.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const wordId = rest.slice(0, sep);
  const word = rest.slice(sep + 1).trim();
  if (!word) return null;
  if (currentWordId !== undefined && wordId !== currentWordId) return null;
  return { wordId, word };
}
