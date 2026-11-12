import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Vitest `onUnhandledError` filter for one known race, matched by exact shape
 * so the suite's exit code stays honest.
 *
 * `Session._openLog` (src/modules/orchestrator/session.ts) opens
 * `<logsDir>/<orchId>/<sessionId>.log` with `fs.createWriteStream`, which opens
 * the file asynchronously and has no `'error'` listener. Tests that start a
 * session and then `rmSync` their tmp dir in `afterEach`
 * (orchestrator/persistence.test.ts, providers/gemini.test.ts) can delete the
 * directory before that open runs; the stream then emits ENOENT as an uncaught
 * exception. No assertion is affected, but Vitest reports "Errors 1" and exits
 * 1, which makes the exit code useless in CI.
 *
 * The real fix belongs in session.ts (listen for the stream's `'error'` event
 * and drop the stream). Once it lands, delete this file and its two imports
 * (root `vitest.config.ts` and `packages/server/vitest.config.ts`).
 *
 * Anything that is not exactly this error, an `open` ENOENT on a `.log` file
 * two levels below a `logs/` directory inside the OS temp dir, is still
 * reported and still fails the run.
 *
 * Vitest only reads `onUnhandledError` from the config it was started with,
 * which is why both the root config and the server project config use it.
 */
export function ignoreOrphanSessionLogOpen(error: unknown): boolean | void {
  const e = error as { code?: unknown; syscall?: unknown; path?: unknown };
  if (e.code !== 'ENOENT' || e.syscall !== 'open' || typeof e.path !== 'string') return;
  const file = path.resolve(e.path);
  const underTmp = file.startsWith(path.resolve(os.tmpdir()) + path.sep);
  const isSessionLog = /[\\/]logs[\\/][^\\/]+[\\/][^\\/]+\.log$/.test(file);
  if (underTmp && isSessionLog) return false;
}
