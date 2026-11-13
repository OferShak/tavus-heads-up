import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from './index';

const health = async (e: Env) => (await worker.fetch(new Request('https://omh.test/api/health'), e)).json();

describe('/api/health', () => {
  it('reports pal: false with the test config (no key, no PAL ids)', async () => {
    const res = await exports.default.fetch('https://omh.test/api/health');
    expect(await res.json()).toEqual({ ok: true, pal: false });
  });

  it('needs the key and both PAL ids for pal: true', async () => {
    const full = { ...env, TAVUS_API_KEY: 'k', TAVUS_PAL_ID: 'p1', TAVUS_CLUE_PAL_ID: 'p2' } as Env;
    expect(await health(full)).toEqual({ ok: true, pal: true });
    expect(await health({ ...full, TAVUS_API_KEY: '' } as Env)).toEqual({ ok: true, pal: false });
    expect(await health({ ...full, TAVUS_PAL_ID: '' } as Env)).toEqual({ ok: true, pal: false });
    expect(await health({ ...full, TAVUS_CLUE_PAL_ID: '' } as Env)).toEqual({ ok: true, pal: false });
  });
});
