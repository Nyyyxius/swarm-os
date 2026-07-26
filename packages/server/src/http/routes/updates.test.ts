/**
 * The update router's own rules — not the state machine's.
 *
 * Four things belong to this layer and are therefore what is tested here:
 * body validation, the status codes (202 for work that outlives the request,
 * 409 for a run already in flight, 503 when no apply machine is attached), the
 * route ORDER — `GET /updates/:id` must not swallow `/updates/apply` — and the
 * 120 s floor on `/updates/apply-now`, which no other layer checks.
 *
 * The runner is a light double: its semantics have their own suite in
 * `modules/updates/runner.test.ts`, and standing up SQLite plus a fake host
 * here would test that module a second time rather than this router.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createUpdatesRouter } from './updates.js';
import type { UpdateService } from '../../modules/updates/index.js';
import {
  MIN_GRACE_SECONDS,
  UpdateBusyError,
  UpdateInvalidInputError,
  type UpdateRunner,
} from '../../modules/updates/runner.js';

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

interface Calls {
  apply: unknown[];
  schedule: unknown[];
  cancel: unknown[];
  cancelSchedule: number;
  applyNow: Array<string | undefined>;
}

function makeRunner(over: Partial<UpdateRunner> = {}): { runner: UpdateRunner; calls: Calls } {
  const calls: Calls = { apply: [], schedule: [], cancel: [], cancelSchedule: 0, applyNow: [] };
  const runner = {
    apply: async (input: unknown) => {
      calls.apply.push(input);
      return { runId: 'run-1' };
    },
    schedule: (input: unknown) => {
      calls.schedule.push(input);
      return { runId: 'run-1', at: '2026-07-27T02:00:00.000Z' };
    },
    cancel: (id?: string) => {
      calls.cancel.push(id);
      return true;
    },
    cancelSchedule: () => {
      calls.cancelSchedule += 1;
      return true;
    },
    applyNow: (id?: string) => {
      calls.applyNow.push(id);
      return true;
    },
    currentRun: () => null,
    listRuns: () => [],
    getRun: (id: string) => (id === 'run-1' ? { id: 'run-1', state: 'preflight' } : null),
    scriptDescriptor: () => ({ version: '1.0.0', sha256: 'abc' }),
    ...over,
  } as unknown as UpdateRunner;
  return { runner, calls };
}

function service(runner: UpdateRunner | null): UpdateService {
  return {
    runner,
    getFullState: () => ({ system: { current: '0.5.0' }, run: null }),
    dismiss: (v: string | null) => ({ dismissedVersion: v }),
  } as unknown as UpdateService;
}

async function serve(updates: UpdateService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createUpdatesRouter(updates));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function post(base: string, p: string, body: unknown): Promise<Response> {
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /updates/apply', () => {
  it('answers 202 with the runId — the run outlives the request', async () => {
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply', { targetVersion: '0.6.0', graceSeconds: 300 });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { runId: string }).runId).toBe('run-1');
    expect(calls.apply[0]).toEqual({ kind: 'system', targetVersion: '0.6.0', graceSeconds: 300 });
  });

  it('answers 409 when a run is already in flight', async () => {
    // Two `docker compose up` on one project would have the second fighting
    // the first's verification window.
    const { runner } = makeRunner({
      apply: async () => {
        throw new UpdateBusyError('run-0');
      },
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply', { targetVersion: '0.6.0' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { runId: string }).runId).toBe('run-0');
  });

  it('answers 400 for a bad body, and never reaches the runner', async () => {
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    for (const body of [
      {},
      { targetVersion: '' },
      { targetVersion: 'x'.repeat(100) },
      { targetVersion: '0.6.0', graceSeconds: -5 },
      { targetVersion: '0.6.0', graceSeconds: 'soon' },
      { targetVersion: '0.6.0', graceSeconds: 999_999 },
    ]) {
      expect((await post(base, '/updates/apply', body)).status).toBe(400);
    }
    expect(calls.apply).toHaveLength(0);
  });

  it('refuses kind:"plugins" — plugin upgrades are hot and have their own route', async () => {
    const { runner } = makeRunner();
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply', { kind: 'plugins', targetVersion: '1.0.0' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('/plugins/');
  });

  it('surfaces the runner’s own input errors as 400', async () => {
    const { runner } = makeRunner({
      apply: async () => {
        throw new UpdateInvalidInputError('SWARM_OS_IMAGE is not set');
      },
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply', { targetVersion: '0.6.0' });
    expect(res.status).toBe(400);
  });
});

/**
 * `POST /updates/apply-now` — the only route with a rule of its own that is
 * about SAFETY rather than about HTTP: the 120 s floor. The runner's
 * `applyNow()` truncates whatever window it is given, so if this handler does
 * not check, nothing does.
 */
describe('POST /updates/apply-now', () => {
  /** A run in its warning window, opened `agoSeconds` ago. */
  function warningRun(agoSeconds: number, over: Record<string, unknown> = {}): unknown {
    return {
      id: 'run-1',
      state: 'warning_teams',
      warnedAt: new Date(Date.now() - agoSeconds * 1000).toISOString(),
      graceRemainingSeconds: Math.max(0, 300 - agoSeconds),
      ...over,
    };
  }

  it('truncates the window once the floor has elapsed', async () => {
    const { runner, calls } = makeRunner({
      currentRun: () => warningRun(200),
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply-now', {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });
    // Always addressed to a specific run, never to "whatever is in flight now":
    // between the read and the call the current run could be a different one.
    expect(calls.applyNow).toEqual(['run-1']);
  });

  it('refuses inside the floor and says how long is left, without truncating', async () => {
    // 30 s in: a lead mid-turn has had no realistic chance to reach an idle
    // boundary, read the notice and wrap up. The window is not the operator's
    // to end yet, and answering 202 then applying 90 s later would be a
    // different question than the one asked.
    const { runner, calls } = makeRunner({
      currentRun: () => warningRun(30),
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply-now', {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; remainingSeconds: number };
    expect(body.remainingSeconds).toBeGreaterThan(85);
    expect(body.remainingSeconds).toBeLessThanOrEqual(90);
    expect(body.error).toContain(`${MIN_GRACE_SECONDS} s`);
    expect(body.error).toContain(`${body.remainingSeconds} s`);
    expect(calls.applyNow).toHaveLength(0);
  });

  it('refuses a window whose start was never recorded — an unprovable floor is not elapsed', async () => {
    const { runner, calls } = makeRunner({
      currentRun: () => warningRun(200, { warnedAt: null }),
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply-now', {});
    expect(res.status).toBe(409);
    expect(calls.applyNow).toHaveLength(0);
  });

  it('409s when nothing is in flight', async () => {
    const { runner, calls } = makeRunner({ currentRun: () => null } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply-now', {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no update run is in flight');
    expect(calls.applyNow).toHaveLength(0);
  });

  it('409s a run that is not in its warning window', async () => {
    // `scheduled` has no window yet; past `preflight` the host updater owns the
    // outcome. Both are "nothing left to shorten", not "not found".
    for (const state of ['scheduled', 'preflight', 'applying', 'success']) {
      const { runner, calls } = makeRunner({
        currentRun: () => warningRun(200, { state }),
      } as Partial<UpdateRunner>);
      const base = await serve(service(runner));
      const res = await post(base, '/updates/apply-now', {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(state);
      expect(calls.applyNow).toHaveLength(0);
    }
  });

  it('takes an explicit runId, and 404s one that does not exist', async () => {
    const { runner, calls } = makeRunner({
      getRun: (id: string) => (id === 'run-7' ? warningRun(200, { id: 'run-7' }) : null),
    } as unknown as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    expect((await post(base, '/updates/apply-now', { runId: 'run-7' })).status).toBe(200);
    expect(calls.applyNow).toEqual(['run-7']);
    expect((await post(base, '/updates/apply-now', { runId: 'nope' })).status).toBe(404);
    expect(calls.applyNow).toHaveLength(1);
  });

  it('409s when the window ended between the read and the call', async () => {
    const { runner } = makeRunner({
      currentRun: () => warningRun(200),
      applyNow: () => false,
    } as unknown as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/apply-now', {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('already ended');
  });

  it('answers 503 with no runner attached, like every other write route', async () => {
    const base = await serve(service(null));
    expect((await post(base, '/updates/apply-now', {})).status).toBe(503);
  });

  it('is not shadowed by /updates/:id', async () => {
    const { runner, calls } = makeRunner({
      currentRun: () => warningRun(200),
    } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    expect((await post(base, '/updates/apply-now', {})).status).toBe(200);
    expect(calls.applyNow).toHaveLength(1);
  });
});

describe('scheduling routes', () => {
  it('POST /updates/schedule answers 202 and passes the datetime through', async () => {
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    const res = await post(base, '/updates/schedule', {
      at: '2026-07-27T02:00:00Z',
      targetVersion: '0.6.0',
    });
    expect(res.status).toBe(202);
    expect(calls.schedule[0]).toMatchObject({ at: '2026-07-27T02:00:00Z', targetVersion: '0.6.0' });
  });

  it('POST /updates/schedule rejects a missing or empty `at`', async () => {
    const { runner } = makeRunner();
    const base = await serve(service(runner));
    expect((await post(base, '/updates/schedule', { targetVersion: '0.6.0' })).status).toBe(400);
    expect((await post(base, '/updates/schedule', { at: '  ', targetVersion: '0.6.0' })).status).toBe(400);
  });

  it('DELETE /updates/schedule reports 404 when there was nothing scheduled', async () => {
    const { runner } = makeRunner({ cancelSchedule: () => false } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    expect((await fetch(`${base}/updates/schedule`, { method: 'DELETE' })).status).toBe(404);
  });

  it('DELETE /updates/schedule cancels an armed one', async () => {
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    expect((await fetch(`${base}/updates/schedule`, { method: 'DELETE' })).status).toBe(200);
    expect(calls.cancelSchedule).toBe(1);
  });
});

describe('POST /updates/cancel', () => {
  it('cancels the run in its warning window', async () => {
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    expect((await post(base, '/updates/cancel', { runId: 'run-1' })).status).toBe(200);
    expect(calls.cancel[0]).toBe('run-1');
  });

  it('answers 409 once the host updater owns the outcome', async () => {
    const { runner } = makeRunner({ cancel: () => false } as Partial<UpdateRunner>);
    const base = await serve(service(runner));
    const res = await post(base, '/updates/cancel', {});
    expect(res.status).toBe(409);
  });
});

describe('GET /updates/:id', () => {
  it('returns the run detail', async () => {
    const { runner } = makeRunner();
    const base = await serve(service(runner));
    const res = await fetch(`${base}/updates/run-1`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: { id: string } }).run.id).toBe('run-1');
  });

  it('404s an unknown id', async () => {
    const { runner } = makeRunner();
    const base = await serve(service(runner));
    expect((await fetch(`${base}/updates/nope`)).status).toBe(404);
  });

  it('does NOT shadow the sibling routes', async () => {
    // Express matches in declaration order, so `/updates/:id` has to come last
    // or `POST /updates/apply` would arrive as a run lookup for "apply".
    const { runner, calls } = makeRunner();
    const base = await serve(service(runner));
    expect((await post(base, '/updates/apply', { targetVersion: '0.6.0' })).status).toBe(202);
    expect((await post(base, '/updates/dismiss', { version: '0.6.0' })).status).toBe(200);
    expect(calls.apply).toHaveLength(1);
  });
});

describe('with no runner attached', () => {
  it('still serves GET /updates and POST /updates/dismiss', async () => {
    const base = await serve(service(null));
    expect((await fetch(`${base}/updates`)).status).toBe(200);
    expect((await post(base, '/updates/dismiss', { version: '0.6.0' })).status).toBe(200);
  });

  it('answers 503 on every write route rather than pretending', async () => {
    const base = await serve(service(null));
    expect((await post(base, '/updates/apply', { targetVersion: '0.6.0' })).status).toBe(503);
    expect((await post(base, '/updates/apply-now', {})).status).toBe(503);
    expect((await post(base, '/updates/schedule', { at: '2026-01-01T00:00:00Z', targetVersion: '1' })).status).toBe(503);
    expect((await fetch(`${base}/updates/schedule`, { method: 'DELETE' })).status).toBe(503);
    expect((await post(base, '/updates/cancel', {})).status).toBe(503);
    expect((await fetch(`${base}/updates/run-1`)).status).toBe(503);
  });
});

describe('POST /updates/dismiss (unchanged behaviour)', () => {
  it('accepts a version and an explicit null, but not a missing field', async () => {
    const base = await serve(service(null));
    expect((await post(base, '/updates/dismiss', { version: '0.6.0' })).status).toBe(200);
    expect((await post(base, '/updates/dismiss', { version: null })).status).toBe(200);
    expect((await post(base, '/updates/dismiss', {})).status).toBe(400);
  });
});
