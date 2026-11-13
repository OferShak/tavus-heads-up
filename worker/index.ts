import { Room } from './room';
import { PlayerStats } from './player-stats';
import { Guard } from './guard';

export { Room, PlayerStats, Guard };

// No 0/O/1/I/L: the code is typed by hand when a camera can't scan the Join QR.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);

export function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function room(env: Env, code: string) {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

/** Tavus is set up: a key and both Modes' PAL ids. The Stage blocks the game until it is (see /api/health). */
function palConfigured(env: Pick<Env, 'TAVUS_API_KEY' | 'TAVUS_PAL_ID' | 'TAVUS_CLUE_PAL_ID'>): boolean {
  return Boolean(env.TAVUS_API_KEY && env.TAVUS_PAL_ID && env.TAVUS_CLUE_PAL_ID);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/rooms' && request.method === 'POST') {
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        if (await room(env, code).init(code)) return json({ code }, 201);
      }
      return json({ error: 'could not allocate a room' }, 503);
    }

    const roomInfo = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (roomInfo && request.method === 'GET') {
      const code = roomInfo[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'not found' }, 404);
      const info = await room(env, code).info();
      return info ? json({ code, ...info }) : json({ error: 'not found' }, 404);
    }

    const ws = path.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (ws) {
      const code = ws[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response('not found', { status: 404 });
      return room(env, code).fetch(request);
    }

    if (path === '/api/health') return json({ ok: true, pal: palConfigured(env) });

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
