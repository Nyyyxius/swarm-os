import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * Server package — Phase 7 test config.
 *
 * - Node environment (no DOM globals leaking into server tests).
 * - Globals OFF so every test file has to `import { describe, it, expect }`
 *   explicitly. Cuts down on hidden coupling to vitest internals and keeps
 *   the test files readable as ESM modules in their own right.
 * - 10 s test timeout for the integration suite (real HTTP listeners need a
 *   bit of margin on cold-start; unit tests finish in <50 ms each).
 */
export default defineConfig({
  test: {
    name: 'server',
    root: path.dirname(new URL(import.meta.url).pathname),
    environment: 'node',
    globals: false,
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // We use forks (vs threads) so the SQLite native binding loads cleanly
    // per worker, and disable file parallelism so the singleton event bus +
    // global ports state stays predictable during integration tests. Tests
    // within a file still run sequentially via `describe` ordering. Vitest 4
    // collapsed the previous `pool` + `poolOptions` shape into top-level
    // options.
    pool: 'forks',
    fileParallelism: false,
  },
});
