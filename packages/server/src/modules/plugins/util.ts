/**
 * Small generic helpers for the plugin host. (The `withTimeout` in
 * `discord/portal.ts` is fetch-specific — this one is promise-generic.)
 */

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
