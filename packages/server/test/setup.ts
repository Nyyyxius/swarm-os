/**
 * Phase 7 — server test setup.
 *
 * Loaded once per worker via vitest `setupFiles`. We:
 *
 *  - Pre-set env vars consumed by `loadConfig` so any test that lazily
 *    instantiates the logger picks up `fatal` (silence) by default.
 *  - Silence direct `process.stdout.write` traffic from `pino` so the test
 *    output stays readable. Vitest hijacks `console.*` but not the raw
 *    fd-1 writes that pino emits via `sonic-boom` / `process.stdout`.
 *    Tests that need to assert on log lines monkey-patch
 *    `process.stdout.write` themselves (the verify scripts do this
 *    pattern) — restoring after the test re-enables the silence.
 */

process.env.SWARM_OS_LOG_LEVEL = process.env.SWARM_OS_LOG_LEVEL ?? 'fatal';
process.env.SWARM_OS_LOG_PRETTY = '0';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const REAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

// Drop pino lines (they all serialise as JSON starting with `{"level":...`).
// Anything else (vitest progress bars, console.log from real test code)
// passes through unchanged.
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  if (text.startsWith('{"level":')) {
    // pretend we wrote it
    if (typeof rest[0] === 'function') (rest[0] as () => void)();
    return true;
  }
  return REAL_STDOUT_WRITE(chunk as string, ...(rest as []));
}) as typeof process.stdout.write;
