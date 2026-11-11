import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['shared/**/*.test.ts', 'src/**/*.test.ts'], environment: 'node' },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
        test: { name: 'worker', include: ['worker/**/*.test.ts'] },
      },
    ],
  },
});
