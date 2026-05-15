import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

/**
 * Web package — Phase 7 test config.
 *
 * jsdom because `@testing-library/react` needs a DOM. Globals OFF for the
 * same reason as the server config.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    root: path.dirname(new URL(import.meta.url).pathname),
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 5_000,
  },
});
