/**
 * Shared cron validation (`validate.ts`) — the single implementation behind the
 * REST route and the `api.crons.*` plugin façade.
 *
 * These cases are the ones a future edit is most likely to break silently,
 * because neither caller re-implements them any more: the merge semantics of a
 * patch (`undefined` = leave alone, `null` = clear), the materialisation of the
 * script timeout, and the invariants checked against the MERGED cron rather
 * than the incoming keys.
 */

import { describe, it, expect } from 'vitest';
import { validateCronInit, validateCronPatch } from './validate.js';
import { DEFAULT_CRON_TIMEOUT_MS, type CronRecord } from './store.js';

const NEVER = '0 3 1 1 *';

const messageCron: CronRecord = {
  id: 'cron_abc',
  name: 'daily',
  roleId: 'role_1',
  schedule: NEVER,
  action: 'message',
  message: 'wake up',
  scriptPath: null,
  scriptArgs: null,
  interpreter: null,
  timeoutMs: null,
  paused: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A role lookup that knows exactly one role. */
const roles = { get: (id: string) => (id === 'role_1' ? { id } : null) };
/** Stand-in for the runner's containment probe: only `/workspace/*` resolves. */
const resolveScriptPath = async (p: string): Promise<string> => {
  if (!p.startsWith('/workspace/')) throw new Error(`script path escapes the workspace: ${p}`);
  return p;
};

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

describe('validateCronInit', () => {
  it('accepts a minimal message cron and defaults `paused`', async () => {
    const init = ok(
      await validateCronInit(
        { name: ' daily ', roleId: 'role_1', schedule: NEVER, action: 'message', message: 'hi' },
        { roles },
      ),
    );
    // The name is trimmed — it becomes the `cron:<name>` sender.
    expect(init.name).toBe('daily');
    expect(init.paused).toBe(false);
    // A message cron has no run budget; `null` must not become the script default.
    expect(init.timeoutMs).toBeNull();
  });

  it('materialises the default timeout for a script cron, and keeps an explicit one', async () => {
    const deps = { roles, resolveScriptPath };
    const implicit = ok(
      await validateCronInit(
        {
          name: 'nightly',
          roleId: 'role_1',
          schedule: NEVER,
          action: 'script',
          scriptPath: '/workspace/tick.py',
          interpreter: 'python3',
        },
        deps,
      ),
    );
    expect(implicit.timeoutMs).toBe(DEFAULT_CRON_TIMEOUT_MS);

    const explicit = ok(
      await validateCronInit(
        {
          name: 'nightly2',
          roleId: 'role_1',
          schedule: NEVER,
          action: 'script',
          scriptPath: '/workspace/tick.py',
          interpreter: 'python3',
          timeoutMs: 5000,
        },
        deps,
      ),
    );
    expect(explicit.timeoutMs).toBe(5000);
  });

  it('refuses a 6-field (per-second) expression even though croner accepts it', async () => {
    const r = await validateCronInit(
      { name: 'persec', roleId: 'role_1', schedule: '* * * * * *', action: 'message', message: 'x' },
      { roles },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly 5 fields/);
  });

  it('refuses an unknown role with the UNKNOWN_ROLE code', async () => {
    const r = await validateCronInit(
      { name: 'x', roleId: 'role_nope', schedule: NEVER, action: 'message', message: 'x' },
      { roles },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNKNOWN_ROLE');
  });

  it('refuses a script cron when the server has no runner', async () => {
    const r = await validateCronInit(
      {
        name: 'x',
        roleId: 'role_1',
        schedule: NEVER,
        action: 'script',
        scriptPath: '/workspace/tick.py',
        interpreter: 'python3',
      },
      { roles },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INVALID_SCRIPT');
      expect(r.error).toMatch(/no script runner configured/);
    }
  });

  it('skips the role check when no role lookup is wired', async () => {
    const init = ok(
      await validateCronInit({
        name: 'x',
        roleId: 'role_whatever',
        schedule: NEVER,
        action: 'message',
        message: 'x',
      }),
    );
    expect(init.roleId).toBe('role_whatever');
  });
});

describe('validateCronPatch', () => {
  it('only carries the keys actually present', async () => {
    const patch = ok(await validateCronPatch(messageCron, { paused: true }, { roles }));
    expect(patch).toEqual({ paused: true });
  });

  it('treats an explicit null as a value, not as "leave alone"', async () => {
    const scriptCron: CronRecord = {
      ...messageCron,
      action: 'script',
      message: null,
      scriptPath: '/workspace/tick.py',
      scriptArgs: ['--once'],
      interpreter: 'python3',
      timeoutMs: 5000,
    };
    const patch = ok(
      await validateCronPatch(scriptCron, { scriptArgs: null }, { roles, resolveScriptPath }),
    );
    expect(patch.scriptArgs).toBeNull();
    // The explicit budget is untouched — materialisation only fills a gap.
    expect(patch.timeoutMs).toBeUndefined();
  });

  it('checks the invariants against the MERGED cron', async () => {
    // Clearing the template of a cron that stays `message` leaves nothing to
    // deliver — refused even though `action` was not part of the patch.
    const cleared = await validateCronPatch(messageCron, { message: null }, { roles });
    expect(cleared.ok).toBe(false);

    // Switching to `script` without supplying a path is refused for the same
    // reason, read from the other side of the merge.
    const switched = await validateCronPatch(
      messageCron,
      { action: 'script' },
      { roles, resolveScriptPath },
    );
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error).toMatch(/scriptPath is required/);
  });

  it('materialises the default timeout when a cron becomes a script cron', async () => {
    const patch = ok(
      await validateCronPatch(
        messageCron,
        { action: 'script', scriptPath: '/workspace/tick.py', interpreter: 'python3' },
        { roles, resolveScriptPath },
      ),
    );
    expect(patch.timeoutMs).toBe(DEFAULT_CRON_TIMEOUT_MS);
  });

  it('refuses a script path outside the allowed roots', async () => {
    const r = await validateCronPatch(
      messageCron,
      { action: 'script', scriptPath: '/etc/passwd', interpreter: 'bash' },
      { roles, resolveScriptPath },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INVALID_SCRIPT');
      expect(r.error).toMatch(/escapes the workspace/);
    }
  });
});
