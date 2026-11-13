import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { devOrigin } from './scripts/vite-tunnel.ts';

export default defineConfig({
  // devOrigin (dev server only: Quick Tunnel + join origin) goes before cloudflare() so its dev middleware runs before the Worker's.
  plugins: [react(), devOrigin(), cloudflare()],
  optimizeDeps: { exclude: ['zxing-wasm'] },
  server: {
    port: 5173,
    // The whole app can also run behind an HTTPS tunnel (secure context on the phone, so tilt works).
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.trycloudflare.com'],
  },
});
