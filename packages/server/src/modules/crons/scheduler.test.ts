import { describe, it, expect, afterEach } from 'vitest';
import { CronScheduler, isValidCron, type CronFireResult } from './scheduler.js';
import type { CronScriptResult, CronScriptRunner } from './runner.js';
import type { CronRecord, CronRun, CronStore, RecordRunInput } from './store.js';
import { Mailbox } from '../orchestrator/mailbox.js';
import type { Session } from '../orchestrator/session.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Spawner } from '../spawner/index.js';

/**
 * The scheduler only touches a thin slice of each collaborator:
 *  - CronStore: list(), get(id), recordRun()
 *  - Spawner: listActive()
 *  - Orchestrator: id, roleId, lead, mailbox, getSession()
 *  - Session: id, status, idleSince, notifySignal()
 * so we fake exactly that surface rather than standing up the real classes (the
 * store's own persistence is covered by test/integration/crons.test.ts).
 */

const FIRE = new Date('2026-06-18T20:00:00.000Z');
const DEFAULTS = { maxMessageSizeBytes: 4096, idleThresholdMs: 50 };

function fakeSession(id: string): Session {
  // idleSince=0 (epoch) → always idle → exercises the notifySignal path.
  return { id, status: 'running', idleSince: 0, notifySignal: () => {} } as unknown as Session;
}

interface FakeOrch {
  orch: Orchestrator;
  mailbox: Mailbox;
}

function fakeOrch(opts: { id: string; roleId: string | null; lead: Session | null }): FakeOrch {
  const mailbox = new Mailbox({ maxSize: 100 });
  const sessions = new Map<string, Session>();
  if (opts.lead) sessions.set(opts.lead.id, opts.lead);
  const orch = {
    id: opts.id,
    roleId: opts.roleId,
    lead: opts.lead,
    mailbox,
    getSession: (sid: string) => sessions.get(sid),
  } as unknown as Orchestrator;
  return { orch, mailbox };
}

function makeCron(p: Partial<CronRecord> & { id: string; name: string; roleId: string }): CronRecord {
  return {
    schedule: '0 6,12,20 * * *',
    action: 'message',
    message: 'tick',
    scriptPath: null,
    scriptArgs: null,
    interpreter: null,
    timeoutMs: null,
    paused: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...p,
  };
}

/** In-memory CronStore double: the three methods the scheduler calls. */
function makeDeps(crons: CronRecord[], orchs: Orchestrator[]) {
  const runs: RecordRunInput[] = [];
  const store = {
    list: () => crons,
    get: (id: string) => crons.find((c) => c.id === id) ?? null,
    recordRun: (input: RecordRunInput): CronRun => {
      runs.push(input);
      return {
        // Honour the pre-allocated id the script path passes in, the way the
        // real store does — the 202's `runId` must match the journalled row.
        id: input.id ?? `run-${runs.length}`,
        cronId: input.cronId,
        firedAt: String(input.firedAt),
        kind: input.kind,
        outcome: input.outcome,
        exitCode: null,
        durationMs: null,
        outputExcerpt: input.outputExcerpt ?? null,
        deliveredTo: [...(input.deliveredTo ?? [])],
      };
    },
  } as unknown as CronStore;
  const spawner = { listActive: () => orchs } as unknown as Spawner;
  return { store, spawner, runs };
}

/**
 * Script-runner double. The real runner is covered by `runner.test.ts` (with
 * real child processes); what the SCHEDULER owes us is the wiring around it —
 * outcome mapping, the overlap guard held for the child's whole lifetime, and
 * the shutdown journalling — so here the child is just a promise we resolve.
 */
function makeRunner(): {
  runner: CronScriptRunner;
  /** Settle the pending run with this result. */
  finish: (result: Partial<CronScriptResult>) => Promise<void>;
  killed: number;
  calls: Array<{ cronId: string; scriptPath: string }>;
} {
  let resolveRun: ((r: CronScriptResult) => void) | null = null;
  const state = {
    killed: 0,
    calls: [] as Array<{ cronId: string; scriptPath: string }>,
  };
  const runner = {
    run: (input: { cronId: string; scriptPath: string }) => {
      state.calls.push({ cronId: input.cronId, scriptPath: input.scriptPath });
      return new Promise<CronScriptResult>((resolve) => {
        resolveRun = resolve;
      });
    },
    killAll: () => {
      state.killed += 1;
      return [];
    },
  } as unknown as CronScriptRunner;
  return {
    runner,
    finish: async (result) => {
      resolveRun?.({
        ok: true,
        wake: false,
        message: null,
        exitCode: 0,
        excerpt: null,
        ...result,
      });
      // Two turns: one for the runner promise, one for the scheduler's own
      // `finally` (which journals the run).
      await Promise.resolve();
      await Promise.resolve();
    },
    get killed() {
      return state.killed;
    },
    get calls() {
      return state.calls;
    },
  };
}

/** A script cron, ready to fire. */
function makeScriptCron(id: string, name: string, roleId: string): CronRecord {
  return makeCron({
    id,
    name,
    roleId,
    action: 'script',
    message: null,
    scriptPath: '/data/crons/x.py',
    interpreter: 'python3',
  });
}

let live: CronScheduler | null = null;
afterEach(() => {
  live?.stop();
  live = null;
});

describe('isValidCron', () => {
  it('accepts a 5-field expression', () => {
    expect(isValidCron('0 6,12,20 * * *')).toBe(true);
    expect(isValidCron('*/2 * * * *')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });
});

describe('CronScheduler.fire — action=message', () => {
  it('delivers the rendered message to the lead of every live instance of the role', () => {
    const cron = makeCron({
      id: 'c1',
      name: 'analysis-cycle',
      roleId: 'rA',
      message: 'run cycle cycle_window_id={{fire}}',
    });
    const o1 = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const o2 = fakeOrch({ id: 'o2', roleId: 'rA', lead: fakeSession('lead2') });
    const other = fakeOrch({ id: 'o3', roleId: 'rB', lead: fakeSession('leadX') }); // different role
    const { store, spawner, runs } = makeDeps([cron], [o1.orch, o2.orch, other.orch]);

    const sched = new CronScheduler({
      store,
      spawner,
      defaults: DEFAULTS,
      timezone: 'UTC',
      enabled: true,
      now: () => FIRE,
    });
    sched.fire('c1', 'tick');

    const m1 = o1.mailbox.peek('lead1');
    const m2 = o2.mailbox.peek('lead2');
    expect(m1).toHaveLength(1);
    expect(m1[0].content).toBe('run cycle cycle_window_id=2026-06-18T20:00Z');
    // The `from` is the cron's identity, not `system` (docs §2.1.5).
    expect(m1[0].from).toBe('cron:analysis-cycle');
    expect(m2).toHaveLength(1);
    // The orchestrator of a different role is untouched.
    expect(other.mailbox.peek('leadX')).toHaveLength(0);
    // …and the tick is journalled with who it reached.
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('wake');
    expect(runs[0].deliveredTo).toEqual(['o1', 'o2']);
  });

  it('skips an instance whose lead is absent, without throwing', () => {
    const cron = makeCron({ id: 'c1', name: 'c1', roleId: 'rA', message: 'tick {{fire}}' });
    const withLead = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const noLead = fakeOrch({ id: 'o2', roleId: 'rA', lead: null });
    const { store, spawner } = makeDeps([cron], [noLead.orch, withLead.orch]);
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    expect(() => sched.fire('c1', 'tick')).not.toThrow();
    expect(withLead.mailbox.peek('lead1')).toHaveLength(1);
  });

  it('records a noop when no live instance of the role exists', () => {
    const cron = makeCron({ id: 'c1', name: 'c1', roleId: 'rA' });
    const { store, spawner, runs } = makeDeps([cron], []);
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    expect(() => sched.fire('c1', 'tick')).not.toThrow();
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('noop');
  });

  it('does nothing for an unknown cron id', () => {
    const o = fakeOrch({ id: 'o1', roleId: 'rB', lead: fakeSession('lead1') });
    const { store, spawner, runs } = makeDeps([], [o.orch]);
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    expect(sched.fire('nope', 'manual')).toBeNull();
    expect(o.mailbox.peek('lead1')).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });

  it('records an error run for a script cron when no runner is wired', async () => {
    const cron = makeScriptCron('c1', 'c1', 'rA');
    const o = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const { store, spawner, runs } = makeDeps([cron], [o.orch]);
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    sched.fire('c1', 'manual');
    await new Promise((r) => setTimeout(r, 0));
    expect(runs[0]?.outcome).toBe('error');
    expect(String(runs[0]?.outputExcerpt)).toContain('no script runner');
    expect(o.mailbox.peek('lead1')).toHaveLength(0);
    // …and the guard is released, so the cron is not wedged forever.
    expect(sched.isRunning('c1')).toBe(false);
  });
});

describe('CronScheduler.fire — action=script', () => {
  /** Build a scheduler with one script cron and one live instance of its role. */
  function setup() {
    const cron = makeScriptCron('c1', 'nightly', 'rA');
    const o = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const { store, spawner, runs } = makeDeps([cron], [o.orch]);
    const r = makeRunner();
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
      runner: r.runner,
    });
    return { sched, runs, o, r };
  }

  it('returns a runId immediately and journals nothing until the child exits', async () => {
    const { sched, runs, r } = setup();
    const fired = sched.fire('c1', 'manual');
    // 202-worthy straight away: the route must not wait for a script that may
    // outlive Node's request timeout.
    expect(fired?.runId).toMatch(/^run_/);
    expect(fired?.run).toBeNull();
    expect(runs).toHaveLength(0);
    expect(sched.isRunning('c1')).toBe(true);

    await r.finish({ ok: true, wake: false });
    expect(runs).toHaveLength(1);
    // The row lands under the id the caller was already handed.
    expect(runs[0]?.id).toBe(fired?.runId);
    expect(sched.isRunning('c1')).toBe(false);
  });

  it('wake:true delivers through the SAME primitive as a message cron', async () => {
    const { sched, runs, o, r } = setup();
    sched.fire('c1', 'tick');
    await r.finish({ ok: true, wake: true, message: 'JIRA-42 moved to review' });

    const inbox = o.mailbox.peek('lead1');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toBe('JIRA-42 moved to review');
    // Same sender identity as a template cron — §2.1.5.
    expect(inbox[0]?.from).toBe('cron:nightly');
    expect(runs[0]?.outcome).toBe('wake');
    expect(runs[0]?.deliveredTo).toEqual(['o1']);
  });

  it('wake:false is a skip — the cheap case a script cron exists for', async () => {
    const { sched, runs, o, r } = setup();
    sched.fire('c1', 'tick');
    await r.finish({ ok: true, wake: false });
    expect(runs[0]?.outcome).toBe('skip');
    expect(o.mailbox.peek('lead1')).toHaveLength(0);
  });

  it('a failed run is an error, carrying the runner’s reason and exit code', async () => {
    const { sched, runs, o, r } = setup();
    sched.fire('c1', 'tick');
    await r.finish({ ok: false, exitCode: 3, excerpt: 'script exited with code 3' });
    expect(runs[0]?.outcome).toBe('error');
    expect(runs[0]?.exitCode).toBe(3);
    expect(String(runs[0]?.outputExcerpt)).toContain('exited with code 3');
    expect(o.mailbox.peek('lead1')).toHaveLength(0);
  });

  it('a wake with no live instance of the role is a noop, not an error', async () => {
    const cron = makeScriptCron('c1', 'nightly', 'rA');
    const { store, spawner, runs } = makeDeps([cron], []);
    const r = makeRunner();
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
      runner: r.runner,
    });
    sched.fire('c1', 'tick');
    await r.finish({ ok: true, wake: true, message: 'wake up' });
    expect(runs[0]?.outcome).toBe('noop');
  });

  it('holds the overlap guard for the CHILD’s whole lifetime (tick + manual)', async () => {
    const { sched, runs, r } = setup();
    sched.fire('c1', 'tick');
    // The child is still running: a second fire — from the cadence or from an
    // operator's RUN NOW — must be refused, not queued. Releasing the guard at
    // LAUNCH (rather than in the async continuation) is the bug this guards.
    const second = sched.fire('c1', 'manual');
    expect(second?.run?.outcome).toBe('overlap');
    expect(r.calls).toHaveLength(1);

    await r.finish({ ok: true, wake: false });
    expect(runs.map((x) => x.outcome)).toEqual(['overlap', 'skip']);
    // Only now is a new run allowed.
    expect(sched.isRunning('c1')).toBe(false);
    sched.fire('c1', 'tick');
    expect(r.calls).toHaveLength(2);
    await r.finish({ ok: true, wake: false });
  });

  it('a PATCH-driven reload() during a run does not release the guard', async () => {
    const { sched, r } = setup();
    sched.fire('c1', 'tick');
    sched.reload();
    expect(sched.isRunning('c1')).toBe(true);
    await r.finish({ ok: true, wake: false });
  });
});

describe('CronScheduler.stop — shutdown with a run in flight', () => {
  it('kills the children and journals the run as an error before the DB closes', async () => {
    const cron = makeScriptCron('c1', 'nightly', 'rA');
    const { store, spawner, runs } = makeDeps([cron], []);
    const r = makeRunner();
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
      runner: r.runner,
    });
    const fired = sched.fire('c1', 'manual');
    expect(runs).toHaveLength(0);

    // Synchronous, because index.ts walks straight on to db.close().
    sched.stop();
    expect(r.killed).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(fired?.runId);
    expect(runs[0]?.outcome).toBe('error');
    expect(String(runs[0]?.outputExcerpt)).toContain('shutdown');
    expect(sched.isRunning('c1')).toBe(false);

    // The killed child settles a moment later — and must NOT write a second row
    // (the database may already be closed by then).
    await r.finish({ ok: false, excerpt: 'killed' });
    expect(runs).toHaveLength(1);
  });

  it('is a no-op for a scheduler with nothing in flight', () => {
    const { store, spawner, runs } = makeDeps([makeCron({ id: 'c1', name: 'a', roleId: 'rA' })], []);
    const sched = new CronScheduler({ store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true });
    sched.start();
    expect(() => sched.stop()).not.toThrow();
    expect(runs).toHaveLength(0);
  });
});

describe('CronScheduler.reload / start / stop', () => {
  it('arms one cron per non-paused row and ignores the rest', () => {
    const crons = [
      makeCron({ id: 'c1', name: 'a', roleId: 'rA' }),
      makeCron({ id: 'c2', name: 'b', roleId: 'rB', paused: true }),
      makeCron({ id: 'c3', name: 'c', roleId: 'rC', schedule: '*/5 * * * *' }),
    ];
    const { store, spawner } = makeDeps(crons, []);
    live = new CronScheduler({ store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true });
    live.start();
    expect(live.armedCount).toBe(2);
    // A paused cron has no next run to advertise.
    expect(live.nextRun('c2')).toBeNull();
    expect(live.nextRun('c1')).toBeInstanceOf(Date);
    live.stop();
    expect(live.armedCount).toBe(0);
  });

  it('does not arm anything when disabled', () => {
    const { store, spawner } = makeDeps([makeCron({ id: 'c1', name: 'a', roleId: 'rA' })], []);
    live = new CronScheduler({ store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: false });
    live.start();
    expect(live.armedCount).toBe(0);
    expect(live.nextRun('c1')).toBeNull();
  });

  it('a manual fire still works while cadence is disabled (explicit operator gesture)', () => {
    const cron = makeCron({ id: 'c1', name: 'c1', roleId: 'rA', message: 'hello' });
    const o = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const { store, spawner } = makeDeps([cron], [o.orch]);
    live = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: false, now: () => FIRE,
    });
    live.start();
    live.fire('c1', 'manual');
    expect(o.mailbox.peek('lead1')).toHaveLength(1);
  });

  it('reload() re-arms after the cron set changes', () => {
    const crons: CronRecord[] = [makeCron({ id: 'c1', name: 'a', roleId: 'rA' })];
    const { store, spawner } = makeDeps(crons, []);
    live = new CronScheduler({ store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true });
    live.start();
    expect(live.armedCount).toBe(1);
    crons.push(makeCron({ id: 'c2', name: 'b', roleId: 'rB', schedule: '*/10 * * * *' }));
    live.reload();
    expect(live.armedCount).toBe(2);
    // …and pausing one disarms it on the next reload.
    crons[0].paused = true;
    live.reload();
    expect(live.armedCount).toBe(1);
    expect(live.nextRun('c1')).toBeNull();
  });

  it('an invalid stored expression is skipped, never thrown', () => {
    const { store, spawner } = makeDeps(
      [makeCron({ id: 'c1', name: 'a', roleId: 'rA', schedule: 'not a cron' })],
      [],
    );
    live = new CronScheduler({ store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true });
    expect(() => live?.start()).not.toThrow();
    expect(live.armedCount).toBe(0);
  });
});

describe('CronScheduler — overlap guard', () => {
  it('records an overlap instead of starting a second concurrent run', () => {
    const cron = makeCron({ id: 'c1', name: 'c1', roleId: 'rA', message: 'x' });
    const o = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const { store, spawner, runs } = makeDeps([cron], [o.orch]);
    const sched = new CronScheduler({
      store, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    // Re-enter fire() from inside a delivery: the mailbox push is what runs
    // while the guard is held, so this is the closest synchronous stand-in for
    // the Lot 2 async runner still being in flight.
    let reentrantRun: CronFireResult | null = null;
    let running = false;
    const origPeek = o.orch.mailbox.push.bind(o.orch.mailbox);
    o.orch.mailbox.push = ((sid: string, msg: { from: string; content: string }) => {
      if (!running) {
        running = true;
        expect(sched.isRunning('c1')).toBe(true);
        reentrantRun = sched.fire('c1', 'manual');
      }
      return origPeek(sid, msg);
    }) as typeof o.orch.mailbox.push;

    sched.fire('c1', 'tick');
    expect(reentrantRun).not.toBeNull();
    expect(reentrantRun!.run?.outcome).toBe('overlap');
    // The guard is released once the run is over.
    expect(sched.isRunning('c1')).toBe(false);
    // One overlap + one real tick, both journalled.
    expect(runs.map((r) => r.outcome).sort()).toEqual(['overlap', 'wake']);
  });
});
