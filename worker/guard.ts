import { DurableObject } from 'cloudflare:workers';

/**
 * Global concurrency guard (one instance, named "global"): caps live PAL conversations so a public URL
 * can't drain Tavus minutes. Leases expire on their own in case a Room dies without releasing.
 */
export class Guard extends DurableObject<Env> {
  private leases(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>('leases') ?? {};
  }

  async acquire(roomCode: string, ttlMs: number, cap: number): Promise<boolean> {
    const now = Date.now();
    const live = Object.fromEntries(Object.entries(this.leases()).filter(([, exp]) => exp > now));
    if (!(roomCode in live) && Object.keys(live).length >= cap) {
      this.ctx.storage.kv.put('leases', live);
      return false;
    }
    live[roomCode] = now + ttlMs;
    this.ctx.storage.kv.put('leases', live);
    return true;
  }

  async release(roomCode: string): Promise<void> {
    const leases = this.leases();
    delete leases[roomCode];
    this.ctx.storage.kv.put('leases', leases);
  }

  async active(): Promise<number> {
    const now = Date.now();
    return Object.values(this.leases()).filter((exp) => exp > now).length;
  }
}
