/**
 * Phase 7 — web test setup.
 *
 * Loaded once per test worker (via `setupFiles` in vitest.config). Wires the
 * jest-dom matcher set onto vitest's `expect` so test files can use
 * `.toHaveTextContent`, `.toBeInTheDocument`, etc., and stubs the bits of
 * `localStorage` that exist in jsdom but log noisy warnings under load.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Drop mounted React trees between tests so component state never leaks.
afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore — tests that touched localStorage may have already cleared */
  }
});
