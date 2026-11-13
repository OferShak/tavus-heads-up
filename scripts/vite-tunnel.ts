// Dev only: tell the Stage which origin a phone can reach, and open a Cloudflare Quick Tunnel
// (HTTPS, so DeviceOrientation tilt works on the phone). Always on under `npm run dev`: a phone always
// joins. The tunnel makes the dev server public while it runs. Without cloudflared it warns and the
// dev server keeps running on the LAN address.

import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Plugin } from 'vite';

export const DEV_ORIGIN_PATH = '/__omh/dev-origin';

const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** First non-internal IPv4, so a phone on the same Wi-Fi can reach a localhost Stage. */
function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/**
 * `GET /__omh/dev-origin` → `{ tunnel, lan, tunnelEnabled }`. Registered directly in configureServer, and
 * placed before `cloudflare()` in the plugin list, so it runs before the Worker middleware.
 */
export function devOrigin(): Plugin {
  const state = { tunnel: null as string | null, lan: null as string | null, tunnelEnabled: true };
  let child: ChildProcess | null = null;
  /** Children we killed ourselves (server restart/close): their exit is expected, not worth a warning. */
  const killed = new WeakSet<ChildProcess>();

  const stop = () => {
    if (child && child.exitCode === null) {
      killed.add(child);
      child.kill('SIGTERM');
    }
    child = null;
  };

  return {
    name: 'omh-dev-origin',
    apply: 'serve',
    configureServer(server) {
      const log = server.config.logger;

      server.middlewares.use(DEV_ORIGIN_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(state));
      });

      const http = server.httpServer;
      if (!http) return;

      http.once('listening', () => {
        const port = (http.address() as AddressInfo | null)?.port ?? server.config.server.port ?? 5173;
        const ip = lanIPv4();
        state.lan = ip ? `http://${ip}:${port}` : null;

        log.info(`Starting a Cloudflare Quick Tunnel to http://localhost:${port}…`, { timestamp: true });
        let output = '';
        try {
          child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (e) {
          log.warn(`Tunnel not started (${String(e)}). The dev server keeps running without it.`);
          return;
        }
        const proc = child;
        const onData = (buf: Buffer) => {
          if (state.tunnel) return;
          output = (output + buf.toString()).slice(-4000);
          const m = output.match(TUNNEL_URL);
          if (!m) return;
          state.tunnel = m[0];
          log.info(
            [
              '',
              `  Phone join URL: ${m[0]}`,
              `  Open http://localhost:${port} on the laptop (camera needs localhost); the Join QR points phones at the tunnel.`,
              '',
            ].join('\n'),
          );
        };
        proc.stdout?.on('data', onData);
        proc.stderr?.on('data', onData);
        proc.on('error', (e: NodeJS.ErrnoException) => {
          log.warn(
            e.code === 'ENOENT'
              ? 'cloudflared not found on PATH (brew install cloudflared). Running without a tunnel.'
              : `cloudflared failed: ${e.message}. Running without a tunnel.`,
          );
          state.tunnelEnabled = false;
        });
        proc.on('exit', (code, signal) => {
          if (child === proc) child = null;
          state.tunnel = null;
          state.tunnelEnabled = false;
          if (killed.has(proc)) return;
          const tail = output.trim().split('\n').slice(-5).join('\n');
          log.warn(`cloudflared exited (${signal ?? `code ${code}`}). Running without a tunnel.${tail ? `\n${tail}` : ''}`);
        });
      });

      http.once('close', stop);
      process.once('exit', stop);
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.once(sig, () => {
          stop();
          // Keep the default behaviour (exit) when nobody else handles the signal.
          if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        });
      }
    },
  };
}
