import { defineConfig } from 'vitest/config';

/**
 * Workspace-level Vitest config (Phase 7).
 *
 * Vitest 4 deprecated `defineWorkspace`; instead the root config now uses
 * `test.projects` to enumerate per-package configs. The actual test
 * environments / coverage thresholds are declared in each project file.
 *
 * Coverage thresholds intentionally low for now (plan §6 Phase 7 — first
 * pass focuses on the load-bearing units, not blanket coverage). Bumping
 * these values is a deliberate decision, not a metric to game.
 */
export default defineConfig({
  test: {
    projects: [
      './packages/server/vitest.config.ts',
      './packages/web/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Don't try to instrument generated bundles, scripts, or test fixtures.
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/scripts/**',
        '**/*.config.{ts,js,mjs}',
        'eslint.config.js',
        // Exercised by integration tests that can't easily report through
        // v8 coverage (separate http server processes); excluded from the
        // numeric threshold to keep them honest.
        '**/src/index.ts',
        '**/src/main.tsx',
        '**/src/App.tsx',
        // Phase 6 PWA assets — pure HTML/CSS, nothing to instrument.
        '**/public/**',
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        // No branch / statement floor — too noisy on the small surface; lines
        // and functions already gate the meaningful drift.
      },
    },
  },
});
