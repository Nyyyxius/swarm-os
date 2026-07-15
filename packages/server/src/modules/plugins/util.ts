/**
 * Small generic helpers for the plugin host. (The `withTimeout` in
 * `discord/portal.ts` is fetch-specific — this one is promise-generic.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Name of the install work area under `<pluginsDir>`. Dotfile ⇒ scan skips it. */
export const STAGING_DIRNAME = '.staging';

/** `<pluginsDir>/.staging` — install staging root (always under dataDir). */
export function stagingRoot(pluginsDir: string): string {
  return path.join(pluginsDir, STAGING_DIRNAME);
}

/**
 * Move `src` → `dst`. Prefers an atomic `fs.rename`; on a cross-device rename
 * (`EXDEV` — e.g. staging on a different mount) it falls back to a recursive
 * copy + delete (red-team M3). Both operands live under `<pluginsDir>` in our
 * pipeline so the rename path is the norm.
 */
export function moveDir(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Swap a staged folder into `<pluginsDir>/<name>`: move any existing folder
 * aside (into `.staging`, same device), move the staged folder in, roll back
 * on failure, then delete the old. There is no POSIX primitive to swap two
 * directories atomically, so a crash strictly between the two renames leaves
 * the target briefly absent — benign here (the boot activation records an
 * error and the operator re-installs; documented in the plan). The common
 * failure (the second rename throwing) rolls back to the old code.
 */
export function swapPluginDir(pluginsDir: string, name: string, stagingDir: string): void {
  const target = path.join(pluginsDir, name);
  const root = stagingRoot(pluginsDir);
  fs.mkdirSync(root, { recursive: true });
  const backup = path.join(root, `.bak-${name}-${randomUUID()}`);
  const hadOld = fs.existsSync(target);
  if (hadOld) moveDir(target, backup);
  try {
    moveDir(stagingDir, target);
  } catch (err) {
    // New folder never landed — restore the old one so the plugin isn't lost.
    // (On the same-device norm `renameSync` fails atomically so `target` is
    // absent; the `existsSync` guard also skips restoring over a partial
    // EXDEV copy — an unreachable path here since both operands share the FS.)
    if (hadOld && !fs.existsSync(target)) {
      try {
        moveDir(backup, target);
      } catch {
        /* best-effort rollback — the .bak stays for boot cleanup */
      }
    }
    throw err;
  }
  if (hadOld) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      /* leftover .bak is purged with the rest of .staging at next boot */
    }
  }
}

/** True for anything with a callable `.then` (a Promise or a thenable). */
export function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (
    x != null &&
    (typeof x === 'object' || typeof x === 'function') &&
    typeof (x as { then?: unknown }).then === 'function'
  );
}

/**
 * Resolve `promise`, or reject with a timeout `Error` after `ms`. The timer is
 * `unref`'d so it never keeps the event loop alive, and cleared on settle.
 * `label` is folded into the timeout message for a legible `last_error`.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
