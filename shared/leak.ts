// Leak guard: did the PAL say the Word, or a part of it? Logged as a stat, never scored.

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Parts of the Word that count as a leak: each token of 3+ letters, plus the joined form ("icecream"). */
function parts(word: string): string[] {
  const t = tokens(word);
  const out = t.filter((p) => p.length >= 3);
  if (t.length > 1) out.push(t.join(''));
  return out;
}

/** A spoken token leaks a part if it is that part plus at most a short suffix (plurals, "-y", "-ing"). */
const MAX_SUFFIX = 3;

export function leaksWord(utterance: string, word: string): boolean {
  const said = tokens(utterance);
  return parts(word).some((p) => said.some((s) => s.startsWith(p) && s.length - p.length <= MAX_SUFFIX));
}
