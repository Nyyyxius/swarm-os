/**
 * The seam between `UpdateRunner` and `Spawner` (§D.5, §D.6).
 *
 * Everything here runs against a fake spawner: the point of these tests is the
 * BRIDGE — one warning round shared by N `warnLead` calls, a read receipt that
 * comes from the pre-minted id leaving the mailbox, a deadline that is honoured
 * whatever the spawner does — not the spawner's own behaviour, which
 * `spawner/warn-leads.test.ts` already pins down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import { SwarmDb } from '../db/index.js';
import {
  deriveLeadNoticeState,
  type LeadWarning,
  type LeadWarningStatus,
  type TeamReconciliation,
  type TeamSnapshotEntry,
} from '../spawner/index.js';
import { UpdateRunner, type ActiveTeam } from './runner.js';
import { UpdateStore, type UpdateRunRow } from './store.js';
import {
  SpawnerTeamsPort,
  buildUpdateResumeBanner,
  findInFlightRun,
  parseTeamsSnapshot,
  reconcileUpdateTeams,
  startUpdateRunnerAtBoot,
  type ReconcilableSpawner,
  type WarnableSpawner,
} from './teams-port.js';

// ---------------------------------------------------------------------------
// A spawner that only knows how to answer the four calls the port makes.
// ---------------------------------------------------------------------------

interface FakeLead {
  orchId: string;
  name: string;
  leadId: string | null;
  /** Polls before the notice is reported as read; Infinity ⇒ never. */
  readsAfterPolls: number;
  signalled: boolean;
  /**
   * Polls after which this lead is gone — the session died mid-window, so its
   * mailbox went with it (`stop()` wipes it) and there is no PTY left. The real
   * `Spawner.leadNoticeStatus` can then never see a read: the notice left the
   * queue with nothing draining it, and `readCount` never moved past the
   * baseline. Infinity ⇒ it survives the window.
   */
  diesAfterPolls: number;
}

class FakeSpawner implements WarnableSpawner, ReconcilableSpawner {
  warnCalls: Array<{ text: string; deadlineMs: number; idleMs?: number }> = [];
  statusCalls = 0;
  /** One entry per `cancelLeadNotices` call: the notice ids it was given. */
  cancelCalls: string[][] = [];
  reconcileCalls: TeamSnapshotEntry[][] = [];
  warnThrows: Error | null = null;
  statusThrows: Error | null = null;
  cancelThrows: Error | null = null;
  private readonly polls = new Map<string, number>();

  constructor(private readonly leads: FakeLead[]) {}

  snapshotLiveTeams(): TeamSnapshotEntry[] {
    return this.leads.map((l) => ({ orch_id: l.orchId, orch_name: l.name, lead_id: l.leadId }));
  }

  warnLeads(text: string, opts: { deadlineMs: number; idleMs?: number }): LeadWarning[] {
    this.warnCalls.push({ text, deadlineMs: opts.deadlineMs, idleMs: opts.idleMs });
    if (this.warnThrows) throw this.warnThrows;
    // Same rule as the real one: an orchestrator without a live lead is skipped.
    return this.leads
      .filter((l) => l.leadId !== null)
      .map((l) => ({
        orch_id: l.orchId,
        orch_name: l.name,
        lead_id: l.leadId as string,
        notice_id: `notice-${l.orchId}`,
        queued: true,
        armed: l.signalled,
      }));
  }

  leadNoticeStatus(warnings: LeadWarning[]): LeadWarningStatus[] {
    this.statusCalls++;
    if (this.statusThrows) throw this.statusThrows;
    return warnings.map((w) => {
      const lead = this.leads.find((l) => l.orchId === w.orch_id);
      const seen = (this.polls.get(w.orch_id) ?? 0) + 1;
      this.polls.set(w.orch_id, seen);
      // A dead lead can never be credited with a read: the only path to
      // `read: true` in the real spawner is an agent draining the inbox that
      // still held our notice id, and there is no agent left to drain it.
      const dead = lead !== undefined && seen > lead.diesAfterPolls;
      const read = lead !== undefined && !dead && seen >= lead.readsAfterPolls;
      // The PTY notice that already fired is not un-fired by the session dying.
      const signalled = lead?.signalled ?? false;
      // The trichotomy is IMPORTED, never restated: a copy of this rule kept
      // this suite green through two independent changes to the real one.
      return { ...w, signalled, read, state: deriveLeadNoticeState({ read, signalled }) };
    });
  }

  cancelLeadNotices(warnings: LeadWarning[]): number {
    this.cancelCalls.push(warnings.map((w) => w.notice_id));
    if (this.cancelThrows) throw this.cancelThrows;
    return warnings.filter((w) => w.armed).length;
  }

  reconcileTeams(snapshot: TeamSnapshotEntry[]): TeamReconciliation {
    this.reconcileCalls.push(snapshot);
    const teams = snapshot.map((s) => ({
      ...s,
      back: this.leads.some((l) => l.orchId === s.orch_id),
      status: null,
      lead_id_now: s.lead_id,
      reason: (this.leads.some((l) => l.orchId === s.orch_id) ? 'ok' : 'absent') as 'ok' | 'absent',
    }));
    return {
      teams,
      back: teams.filter((t) => t.back).length,
      missing: teams.filter((t) => !t.back).length,
    };
  }
}

const lead = (over: Partial<FakeLead> = {}): FakeLead => ({
  orchId: 'orch-1',
  name: 'TEAM-1',
  leadId: 'lead-1',
  readsAfterPolls: Number.POSITIVE_INFINITY,
  signalled: true,
  diesAfterPolls: Number.POSITIVE_INFINITY,
  ...over,
});

const team = (orchId: string, name = orchId, leadId: string | null = `${orchId}-lead`): ActiveTeam => ({
  orchestratorId: orchId,
  name,
  leadSessionId: leadId,
});

// ---------------------------------------------------------------------------

describe('SpawnerTeamsPort.listActiveTeams', () => {
  it('projects the spawner snapshot into the port shape', () => {
    const port = new SpawnerTeamsPort(
      new FakeSpawner([lead(), lead({ orchId: 'orch-2', name: 'TEAM-2', leadId: null })]),
    );
    expect(port.listActiveTeams()).toEqual([
      { orchestratorId: 'orch-1', name: 'TEAM-1', leadSessionId: 'lead-1' },
      { orchestratorId: 'orch-2', name: 'TEAM-2', leadSessionId: null },
    ]);
  });
});

describe('SpawnerTeamsPort.warnLead', () => {
  it('reports `read` once the pre-minted id has left the mailbox', async () => {
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 2 })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update in 5m', {
      deadlineMs: Date.now() + 5_000,
    });
    expect(outcome).toEqual({ signalled: true, read: true, state: 'read' });
    // Resolved on the read, not by waiting out the 5 s window.
    expect(spawner.statusCalls).toBeLessThan(10);
  });

  it('reports `never_idle` for a lead that never reaches an idle boundary', async () => {
    const spawner = new FakeSpawner([lead({ signalled: false })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update', {
      deadlineMs: Date.now() + 60,
    });
    expect(outcome).toEqual({ signalled: false, read: false, state: 'never_idle' });
  });

  it('reports `queued_unread` for a lead that was signalled but never read it', async () => {
    const spawner = new FakeSpawner([lead({ signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update', {
      deadlineMs: Date.now() + 60,
    });
    expect(outcome).toEqual({ signalled: true, read: false, state: 'queued_unread' });
  });

  /**
   * The lead dies inside the window (crash, `stop()`, a team destroyed by the
   * operator). Its mailbox goes with it, so our notice leaves the queue with
   * NOBODY having drained it — the one shape that could be mistaken for a read.
   * It must not be: `read` comes only from `readCount` moving past the baseline
   * we took when we queued the notice, and this record is the operator's
   * evidence that the lead was cut off without ever seeing the warning.
   */
  it('never credits a lead that dies mid-window with a read', async () => {
    // Would have read at poll 3 — but it is gone from poll 2 onwards.
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 3, diesAfterPolls: 1, signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update', {
      deadlineMs: Date.now() + 80,
    });
    expect(outcome.read).toBe(false);
    // Signalled stays true: the PTY notice really did fire before it died.
    expect(outcome).toEqual({ signalled: true, read: false, state: 'queued_unread' });
  });

  it('a lead that dies before anything reached it is never_idle, not read', async () => {
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 2, diesAfterPolls: 0, signalled: false })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update', {
      deadlineMs: Date.now() + 80,
    });
    expect(outcome).toEqual({ signalled: false, read: false, state: 'never_idle' });
  });

  it('reports `no_lead` when the team has no live lead to warn', async () => {
    const spawner = new FakeSpawner([lead({ orchId: 'orch-1', leadId: null })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1', 'TEAM-1', null), 'update', {
      deadlineMs: Date.now() + 5_000,
    });
    expect(outcome).toEqual({ signalled: false, read: false, state: 'no_lead' });
  });

  it('resolves BY the deadline even when nobody ever reads', async () => {
    const spawner = new FakeSpawner([lead(), lead({ orchId: 'orch-2', leadId: 'lead-2' })]);
    // A poll interval far longer than the window: the deadline must be its own
    // timer, not a consequence of the poll cadence.
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 10_000 });
    const started = Date.now();
    const deadlineMs = started + 80;
    const outcomes = await Promise.all([
      port.warnLead(team('orch-1'), 'update', { deadlineMs }),
      port.warnLead(team('orch-2'), 'update', { deadlineMs }),
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(2_000);
    for (const o of outcomes) expect(o.read).toBe(false);
  });

  it('warns ONCE per window however many teams ask, and shares the handles', async () => {
    const spawner = new FakeSpawner([
      lead({ orchId: 'orch-1', leadId: 'lead-1', readsAfterPolls: 1 }),
      lead({ orchId: 'orch-2', leadId: 'lead-2', readsAfterPolls: 1 }),
      lead({ orchId: 'orch-3', leadId: 'lead-3', readsAfterPolls: 1 }),
    ]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const deadlineMs = Date.now() + 5_000;
    const outcomes = await Promise.all([
      port.warnLead(team('orch-1'), 'update', { deadlineMs }),
      port.warnLead(team('orch-2'), 'update', { deadlineMs }),
      port.warnLead(team('orch-3'), 'update', { deadlineMs }),
    ]);
    expect(spawner.warnCalls).toHaveLength(1);
    expect(port.currentWarnings()).toHaveLength(3);
    for (const o of outcomes) expect(o.state).toBe('read');
  });

  it('converts the runner\'s absolute deadline into the duration armNotice expects', async () => {
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 1 })]);
    const NOW = 1_700_000_000_000;
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5, now: () => NOW });
    await port.warnLead(team('orch-1'), 'update', { deadlineMs: NOW + 300_000 });
    // NOT the epoch timestamp: `armNotice` does `deadlineAt = Date.now() + this`.
    expect(spawner.warnCalls[0]?.deadlineMs).toBe(300_000);
  });

  it('starts a fresh round for a new window', async () => {
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 1 })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    await port.warnLead(team('orch-1'), 'update in 5m', { deadlineMs: Date.now() + 5_000 });
    await port.warnLead(team('orch-1'), 'applying now', { deadlineMs: Date.now() + 9_000 });
    expect(spawner.warnCalls.map((c) => c.text)).toEqual(['update in 5m', 'applying now']);
  });

  it('a throwing spawner is a never_idle record, not a rejection, and is not retried per team', async () => {
    const spawner = new FakeSpawner([lead(), lead({ orchId: 'orch-2', leadId: 'lead-2' })]);
    spawner.warnThrows = new Error('spawner exploded');
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const deadlineMs = Date.now() + 5_000;
    const outcomes = await Promise.all([
      port.warnLead(team('orch-1'), 'update', { deadlineMs }),
      port.warnLead(team('orch-2'), 'update', { deadlineMs }),
    ]);
    for (const o of outcomes) {
      expect(o).toEqual({ signalled: false, read: false, state: 'never_idle' });
    }
    expect(spawner.warnCalls).toHaveLength(1);
  });

  it('a throwing leadNoticeStatus settles instead of spinning', async () => {
    const spawner = new FakeSpawner([lead()]);
    spawner.statusThrows = new Error('status exploded');
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const outcome = await port.warnLead(team('orch-1'), 'update', {
      deadlineMs: Date.now() + 10_000,
    });
    expect(outcome).toEqual({ signalled: false, read: false, state: 'never_idle' });
  });
});

/**
 * The window can end BEFORE its deadline — `applyNow()` truncates it, `cancel()`
 * abolishes it — and the round's own timer knows nothing about that. Every test
 * here uses a poll cadence far longer than the test itself, so the only thing
 * that can settle the round is `endWindow`.
 */
describe('SpawnerTeamsPort.endWindow', () => {
  const FAR = 3_600_000;

  it('settles every outstanding warnLead with the state observed so far', async () => {
    const spawner = new FakeSpawner([lead({ signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    const pending = port.warnLead(team('orch-1'), 'update', { deadlineMs: Date.now() + FAR });
    port.endWindow('now');
    await expect(pending).resolves.toEqual({ signalled: true, read: false, state: 'queued_unread' });
    // "Now" is not "cancelled": the update IS happening, so the notices stand.
    expect(spawner.cancelCalls).toHaveLength(0);
  });

  it('observes one last time, so a lead that read it in the final second still counts', async () => {
    // The arming poll sees it unread; the observation inside `endWindow` is the
    // one that catches the read.
    const spawner = new FakeSpawner([lead({ readsAfterPolls: 2 })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    const pending = port.warnLead(team('orch-1'), 'update', { deadlineMs: Date.now() + FAR });
    port.endWindow('deadline');
    await expect(pending).resolves.toEqual({ signalled: true, read: true, state: 'read' });
  });

  it('cancelled stands the armed notices down — and keeps the mailbox rows', async () => {
    const spawner = new FakeSpawner([lead(), lead({ orchId: 'orch-2', leadId: 'lead-2' })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    const deadlineMs = Date.now() + FAR;
    const pending = Promise.all([
      port.warnLead(team('orch-1'), 'update', { deadlineMs }),
      port.warnLead(team('orch-2'), 'update', { deadlineMs }),
    ]);
    port.endWindow('cancelled');
    const outcomes = await pending;
    expect(spawner.cancelCalls).toEqual([['notice-orch-1', 'notice-orch-2']]);
    for (const o of outcomes) expect(o.state).toBe('queued_unread');
    // The handles are kept: a lead really was told, and nothing retracts a
    // message it may already have read.
    expect(port.currentWarnings()).toHaveLength(2);
  });

  it('is total and idempotent: no round, twice, or a throwing spawner', async () => {
    const spawner = new FakeSpawner([lead()]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    // Nothing armed yet.
    expect(() => port.endWindow('cancelled')).not.toThrow();
    expect(spawner.cancelCalls).toHaveLength(0);
    const pending = port.warnLead(team('orch-1'), 'update', { deadlineMs: Date.now() + FAR });
    spawner.cancelThrows = new Error('spawner exploded');
    expect(() => port.endWindow('cancelled')).not.toThrow();
    expect(() => port.endWindow('cancelled')).not.toThrow();
    await expect(pending).resolves.toMatchObject({ state: 'queued_unread' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real runner: the port is what the state machine calls.
// ---------------------------------------------------------------------------

let dir: string;
let db: SwarmDb;
let store: UpdateStore;
let runners: UpdateRunner[];

function config(over: Partial<Config> = {}): Config {
  return {
    dataDir: dir,
    hostDataDir: '/host/data',
    agentTransport: 'ssh',
    port: 8787,
    image: 'ghcr.io/o/r:0.5.0',
    version: '0.5.0',
    ...over,
  } as unknown as Config;
}

function makeRunner(
  over: { teams?: SpawnerTeamsPort; now?: () => number; onSpawn?: () => void } = {},
): { runner: UpdateRunner; spawned: string[][] } {
  const spawned: string[][] = [];
  const runner = new UpdateRunner({
    config: config(),
    store,
    teams: over.teams,
    now: over.now,
    pollIntervalMs: 10,
    installScript: () => ({ path: path.join(dir, 'updater', 'host-update.sh'), sha256: 'sha', version: '1.0.0' }),
    verifyScript: () => undefined,
    spawnJob: async (argv) => {
      // Observed from INSIDE the spawn: the only place that can prove what was
      // already persisted when the container's fate was sealed.
      over.onSpawn?.();
      spawned.push(argv);
      return { jobId: 'job-1' };
    },
    hostRun: async () => ({ code: 0 }),
  });
  runners.push(runner);
  return { runner, spawned };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-port-'));
  db = new SwarmDb(dir);
  store = new UpdateStore(db);
  runners = [];
});

afterEach(() => {
  for (const r of runners) r.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UpdateRunner over SpawnerTeamsPort', () => {
  it('warns every live lead once and persists one record per team', async () => {
    const spawner = new FakeSpawner([
      lead({ orchId: 'orch-1', name: 'alpha', leadId: 'lead-1', readsAfterPolls: 1 }),
      lead({ orchId: 'orch-2', name: 'beta', leadId: 'lead-2', readsAfterPolls: 1 }),
      lead({ orchId: 'orch-3', name: 'gamma', leadId: null }),
    ]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5 });
    const { runner, spawned } = makeRunner({ teams: port });
    // The grace window is floored at 120 s, so skip it once everyone has read.
    const { runId } = await runner.apply({ targetVersion: '0.6.0' });
    await new Promise((r) => setTimeout(r, 60));
    expect(runner.applyNow(runId)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));

    expect(spawner.warnCalls).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    const warned = runner.getRun(runId)?.teamsWarned ?? [];
    expect(warned.map((w) => [w.orch_name, w.state])).toEqual([
      ['alpha', 'read'],
      ['beta', 'read'],
      ['gamma', 'no_lead'],
    ]);
    // The snapshot is persisted BEFORE anything is triggered (§D.6).
    expect(runner.getRun(runId)?.teamsSnapshot.map((t) => t.orchestratorId)).toEqual([
      'orch-1',
      'orch-2',
      'orch-3',
    ]);
  });

  /**
   * THE MIXED WIRE — the half of §D.5 that lives in two packages at once.
   *
   * `teams_warned_json` has to carry SOME teams as `read` and others as not,
   * WHILE the run is still `warning_teams`: that is the state the countdown
   * sentence is rendered in. It was unreachable before — the column was written
   * once, when every `warnLead` had settled — and two changes made by different
   * hands had to meet for it to render: a placeholder row per snapshot team the
   * instant the window opens, and a re-persist as each outcome lands. This test
   * is the proof that they meet, driven through the real runner and asserted on
   * `currentRun()`, which is literally the `run` field of `GET /updates`.
   *
   * It asserts the wire TWICE, because the sentence changes with what has been
   * observed and both halves are operator-facing:
   *
   *  - mid-window (72 s left), the third lead has not been observed at all, and
   *    the wire says `pending`. It used to say `never_idle` here — a verdict
   *    minted before anyone looked, which the screen rendered as "(busy for
   *    4m31)".
   *  - at the deadline (0 s left, still `warning_teams` — the port's deadline
   *    timer is armed before the runner's grace timer for the same instant, and
   *    that ordering is what "records before the spawn" rests on), the same lead
   *    is `never_idle` FROM AN OBSERVATION, and the verdict sentence renders.
   *
   * Both payloads are kept byte-identical in
   * `packages/web/src/lib/updateRun.test.ts` ("the warning window, from the
   * payload the server really sends"), where they are turned into the two
   * sentences. If either side drifts, one of the two tests fails.
   */
  it('carries a MIXED set mid-window: two leads read, one not yet observed', async () => {
    // One clock for the runner and the port, as production has one. Frozen, so
    // the window is over only when this test says it is.
    let clock = Date.parse('2026-07-20T10:00:00.000Z');
    const spawner = new FakeSpawner([
      lead({ orchId: 'orch-1', name: 'alpha', leadId: 'lead-1', readsAfterPolls: 1 }),
      lead({ orchId: 'orch-2', name: 'beta', leadId: 'lead-2', readsAfterPolls: 1 }),
      // Never reaches an idle boundary: nothing is ever typed at it, and it
      // never drains its inbox. The lead the sentence is about.
      lead({ orchId: 'orch-3', name: 'stiix-infra', leadId: 'lead-3', signalled: false }),
    ]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5, now: () => clock });
    const { runner, spawned } = makeRunner({ teams: port, now: () => clock });
    // 343 s so that 271 s in the countdown reads exactly 01:12, and so that the
    // whole window is 5m43 — every number of both sentences, off one clock.
    const { runId } = await runner.apply({ targetVersion: '0.6.0', graceSeconds: 343 });
    await new Promise((r) => setTimeout(r, 60));
    clock += 271_000;

    // What `GET /updates` serves as `run` at this instant.
    const wire = runner.currentRun();
    expect(wire?.id).toBe(runId);
    // Still INSIDE the window: this is the state the sentence is rendered in,
    // and nothing has been spawned yet.
    expect(wire?.state).toBe('warning_teams');
    expect(wire?.terminal).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(wire?.graceRemainingSeconds).toBe(72);
    expect(wire?.warnedAt).toBe('2026-07-20T10:00:00.000Z');
    expect(wire?.teamsSnapshot).toEqual([
      { orchestratorId: 'orch-1', name: 'alpha', leadSessionId: 'lead-1' },
      { orchestratorId: 'orch-2', name: 'beta', leadSessionId: 'lead-2' },
      { orchestratorId: 'orch-3', name: 'stiix-infra', leadSessionId: 'lead-3' },
    ]);
    // MIXED, mid-window: the two that read flipped as they read; the third is
    // still the placeholder written when the window opened, and it claims
    // nothing.
    expect(wire?.teamsWarned).toEqual([
      { orch_id: 'orch-1', orch_name: 'alpha', lead_id: 'lead-1', signalled: true, read: true, state: 'read' },
      { orch_id: 'orch-2', orch_name: 'beta', lead_id: 'lead-2', signalled: true, read: true, state: 'read' },
      { orch_id: 'orch-3', orch_name: 'stiix-infra', lead_id: 'lead-3', signalled: false, read: false, state: 'pending' },
    ]);
    // And the window really is still open on the port side too — the unread
    // lead has not been settled by anything.
    expect(spawner.warnCalls).toHaveLength(1);

    // ── the deadline: the verdict, now that there is one ────────────────────
    clock += 72_000;
    await new Promise((r) => setTimeout(r, 40));
    const settled = runner.currentRun();
    // Still `warning_teams`, and the countdown has run out: the records land
    // before the run leaves this state, which is the whole ordering guarantee.
    expect(settled?.state).toBe('warning_teams');
    expect(settled?.graceRemainingSeconds).toBe(0);
    expect(settled?.teamsWarned).toEqual([
      { orch_id: 'orch-1', orch_name: 'alpha', lead_id: 'lead-1', signalled: true, read: true, state: 'read' },
      { orch_id: 'orch-2', orch_name: 'beta', lead_id: 'lead-2', signalled: true, read: true, state: 'read' },
      { orch_id: 'orch-3', orch_name: 'stiix-infra', lead_id: 'lead-3', signalled: false, read: false, state: 'never_idle' },
    ]);
  });

  /**
   * The other half of the same guarantee: the placeholder exists from the FIRST
   * instant, so the screen can never say "nothing to interrupt" while teams are
   * minutes from being cut off. Asserted on the raw column, before any lead has
   * had the chance to answer.
   */
  it('persists one placeholder row per snapshot team the instant the window opens', async () => {
    const clock = Date.parse('2026-07-20T10:00:00.000Z');
    // Nobody ever reads and nobody is ever signalled: whatever is in the column
    // at this point was put there by the window opening, not by an outcome.
    const spawner = new FakeSpawner([
      lead({ orchId: 'orch-1', name: 'alpha', leadId: 'lead-1', signalled: false }),
      lead({ orchId: 'orch-2', name: 'beta', leadId: 'lead-2', signalled: false }),
    ]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000, now: () => clock });
    const { runner } = makeRunner({ teams: port, now: () => clock });
    await runner.apply({ targetVersion: '0.6.0', graceSeconds: 300 });
    await new Promise((r) => setTimeout(r, 20));

    const view = runner.currentRun();
    expect(view?.state).toBe('warning_teams');
    expect(view?.teamsWarned.map((w) => [w.orch_name, w.state, w.read])).toEqual([
      ['alpha', 'pending', false],
      ['beta', 'pending', false],
    ]);
  });

  /**
   * THE OVER-CLAIM the placeholder used to make, end to end.
   *
   * `warnLead` settles early on a READ and on nothing else, so a lead whose PTY
   * notice fired the instant the round was armed keeps its placeholder row for
   * the whole window. That row used to say `never_idle` — "this lead never
   * reached an idle boundary" — about a lead that demonstrably reached one and
   * was signalled, and the countdown rendered it as "(busy for 4m31)".
   *
   * A placeholder is the ABSENCE of an observation and now says so. The verdict
   * still comes from what was observed, at the end of the window — asserted
   * below on the same run, so the honesty of the placeholder cannot be bought
   * by making the persisted record vaguer.
   */
  it('never claims `never_idle` about a lead whose notice has fired but is unread', async () => {
    let clock = Date.parse('2026-07-20T10:00:00.000Z');
    const spawner = new FakeSpawner([
      // Signalled from the first poll, never reads: the lead the old
      // placeholder libelled for the entire window.
      lead({ orchId: 'orch-1', name: 'stiix-infra', leadId: 'lead-1', signalled: true }),
    ]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5, now: () => clock });
    const { runner } = makeRunner({ teams: port, now: () => clock });
    const { runId } = await runner.apply({ targetVersion: '0.6.0', graceSeconds: 343 });
    await new Promise((r) => setTimeout(r, 60));
    clock += 271_000;
    await new Promise((r) => setTimeout(r, 30));

    // The observation the runner has NOT been given: the notice really did fire.
    // Whatever the placeholder says, `never_idle` is false about this lead.
    expect(spawner.leadNoticeStatus(port.currentWarnings())[0]).toMatchObject({
      signalled: true,
      read: false,
      state: 'queued_unread',
    });
    const midWindow = runner.currentRun();
    expect(midWindow?.state).toBe('warning_teams');
    expect(midWindow?.graceRemainingSeconds).toBe(72);
    expect(midWindow?.teamsWarned).toEqual([
      {
        orch_id: 'orch-1',
        orch_name: 'stiix-infra',
        lead_id: 'lead-1',
        signalled: false,
        read: false,
        state: 'pending',
      },
    ]);

    // The window runs out: the record is now the observation, and `read` is
    // still creditable only from the pre-minted id leaving the mailbox.
    clock += 100_000;
    await new Promise((r) => setTimeout(r, 40));
    expect(runner.getRun(runId)?.teamsWarned).toEqual([
      {
        orch_id: 'orch-1',
        orch_name: 'stiix-infra',
        lead_id: 'lead-1',
        signalled: true,
        read: false,
        state: 'queued_unread',
      },
    ]);
  });

  /**
   * The natural path, which is the one that matters: nobody reads, the window
   * runs out, and the records still land BEFORE the host job is spawned — the
   * post-update screen is built from that column and the container is about to
   * be recreated. It works because the port's deadline timer is armed before
   * the runner's grace timer for the same instant, so the outcomes resolve
   * first and the persisting `.then` runs in the microtask that follows.
   */
  it('persists the records before spawning when the window simply runs out', async () => {
    // One shared clock, exactly as production has one: the port must read the
    // deadline on the same scale the runner minted it on.
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const spawner = new FakeSpawner([lead({ orchId: 'orch-1', name: 'alpha', signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 5, now: () => clock });
    const { runner, spawned } = makeRunner({ teams: port, now: () => clock });
    const { runId } = await runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
    await new Promise((r) => setTimeout(r, 30));
    // The 120 s window elapses.
    clock += 121_000;
    await new Promise((r) => setTimeout(r, 30));

    // Records first, spawn after — and never the other way round.
    expect(runner.getRun(runId)?.teamsWarned.map((w) => w.state)).toEqual(['queued_unread']);
    expect(spawned).toHaveLength(0);
    expect(runner.applyNow(runId)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toHaveLength(1);
  });

  /**
   * §D.5 — the apply-now path, which is the one that used to lose the record.
   * The operator cuts the window short, so the round's deadline timer points at
   * an instant this container will not live to see: unless the truncation is
   * signalled, nothing settles the round and `teams_warned_json` is written by
   * nobody. The poll cadence here is far longer than the whole test, so
   * `endWindow` is the ONLY thing that can settle it — and the assertion is
   * taken from inside the spawn, because "before the spawn" is the property.
   */
  it('persists the records BEFORE the spawn when the operator applies now', async () => {
    const spawner = new FakeSpawner([lead({ orchId: 'orch-1', name: 'alpha', signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    const warnedAtSpawn: Array<string | null> = [];
    let runId = '';
    const { runner, spawned } = makeRunner({
      teams: port,
      onSpawn: () => warnedAtSpawn.push(store.get(runId)?.teams_warned_json ?? null),
    });
    runId = (await runner.apply({ targetVersion: '0.6.0', graceSeconds: 3_600 })).runId;
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toHaveLength(0);

    expect(runner.applyNow(runId)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    expect(spawned).toHaveLength(1);
    expect(warnedAtSpawn).toHaveLength(1);
    expect(JSON.parse(warnedAtSpawn[0] ?? 'null')).toEqual([
      {
        orch_id: 'orch-1',
        orch_name: 'alpha',
        lead_id: 'lead-1',
        signalled: true,
        read: false,
        // Observed, not assumed: the notice was typed at the lead and is still
        // sitting in its inbox.
        state: 'queued_unread',
      },
    ]);
  });

  it('a cancelled run stops typing at the leads and still records what they did', async () => {
    const spawner = new FakeSpawner([lead({ orchId: 'orch-1', name: 'alpha', signalled: true })]);
    const port = new SpawnerTeamsPort(spawner, { pollIntervalMs: 60_000 });
    const { runner, spawned } = makeRunner({ teams: port });
    const { runId } = await runner.apply({ targetVersion: '0.6.0', graceSeconds: 3_600 });
    await new Promise((r) => setTimeout(r, 30));

    expect(runner.cancel(runId)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    // The armed notices are dropped: no restart is coming.
    expect(spawner.cancelCalls).toEqual([['notice-orch-1']]);
    expect(spawned).toHaveLength(0);
    expect(store.get(runId)?.state).toBe('cancelled');
    // But the lead WAS warned, and the row says exactly that.
    expect(runner.getRun(runId)?.teamsWarned.map((w) => [w.orch_name, w.state])).toEqual([
      ['alpha', 'queued_unread'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Boot side.
// ---------------------------------------------------------------------------

function row(over: Partial<UpdateRunRow> = {}): UpdateRunRow {
  return {
    id: 'run-1',
    kind: 'system',
    state: 'applying',
    target_version: '0.6.0',
    scheduled_for: '2026-01-01T00:00:00.000Z',
    warned_at: '2026-01-01T00:00:05.000Z',
    started_at: '2026-01-01T00:00:05.000Z',
    finished_at: null,
    run_dir: '/data/updater/runs/run-1',
    env_file: null,
    env_line_before: null,
    teams_snapshot_json: null,
    teams_warned_json: null,
    teams_reconciled_json: null,
    error: null,
    log_tail: null,
    ...over,
  };
}

describe('findInFlightRun', () => {
  it('picks the newest run that had already reached the host', () => {
    const found = findInFlightRun([
      row({ id: 'a', state: 'applying' }),
      row({ id: 'b', state: 'verifying' }),
    ]);
    expect(found?.id).toBe('b');
  });

  it('ignores runs that never touched anything', () => {
    expect(findInFlightRun([row({ state: 'scheduled' })])).toBeNull();
    expect(findInFlightRun([row({ state: 'warning_teams' })])).toBeNull();
    expect(findInFlightRun([])).toBeNull();
  });
});

describe('buildUpdateResumeBanner', () => {
  it('names the version and when for a completed update', () => {
    const banner = buildUpdateResumeBanner(
      row({ state: 'success', finished_at: '2026-01-01T00:05:00.000Z' }),
    );
    expect(banner).toContain('v0.6.0');
    expect(banner).toContain('2026-01-01T00:05:00.000Z');
    expect(banner).toContain('updated');
  });

  it('says the OLD version is running after a rollback', () => {
    const banner = buildUpdateResumeBanner(row({ state: 'rolled_back' }));
    expect(banner).toContain('rolled back');
    expect(banner).toContain('BEFORE');
  });

  it('does not claim a verdict while the updater is still verifying', () => {
    const banner = buildUpdateResumeBanner(row({ state: 'verifying' }));
    expect(banner).toContain('still verifying');
  });

  it('is null when there is nothing to say', () => {
    expect(buildUpdateResumeBanner(null)).toBeNull();
    expect(buildUpdateResumeBanner(row({ state: 'cancelled' }))).toBeNull();
    expect(buildUpdateResumeBanner(row({ state: 'refused' }))).toBeNull();
  });

  it('degrades to a generic phrase when the target version was never recorded', () => {
    const banner = buildUpdateResumeBanner(row({ state: 'success', target_version: null }));
    expect(banner).toContain('a new version');
  });
});

describe('parseTeamsSnapshot', () => {
  it('reads the port shape the runner persists', () => {
    const snapshot = parseTeamsSnapshot(
      row({
        teams_snapshot_json: JSON.stringify([
          { orchestratorId: 'o1', name: 'alpha', leadSessionId: 'l1' },
          { orchestratorId: 'o2', name: 'beta', leadSessionId: null },
        ]),
      }),
    );
    expect(snapshot).toEqual([
      { orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1' },
      { orch_id: 'o2', orch_name: 'beta', lead_id: null },
    ]);
  });

  it('reads the spawner shape too', () => {
    const snapshot = parseTeamsSnapshot(
      row({ teams_snapshot_json: JSON.stringify([{ orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1' }]) }),
    );
    expect(snapshot).toEqual([{ orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1' }]);
  });

  it('degrades to empty on the scheduled-run metadata, garbage or nothing', () => {
    expect(parseTeamsSnapshot(row({ teams_snapshot_json: '{"graceSeconds":300}' }))).toEqual([]);
    expect(parseTeamsSnapshot(row({ teams_snapshot_json: 'not json' }))).toEqual([]);
    expect(parseTeamsSnapshot(row({ teams_snapshot_json: '[{"nope":1}]' }))).toEqual([]);
    expect(parseTeamsSnapshot(null)).toEqual([]);
  });
});

describe('startUpdateRunnerAtBoot', () => {
  it('reads the in-flight run BEFORE start() and its verdict after', async () => {
    const { runner } = makeRunner();
    const runDir = path.join(dir, 'updater', 'runs', 'run-boot');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'result.json'),
      JSON.stringify({ state: 'success', verify: 'boot_complete', finished_at: '2026-01-01T00:05:00.000Z' }),
    );
    store.insert(
      row({
        id: 'run-boot',
        state: 'applying',
        run_dir: runDir,
        teams_snapshot_json: JSON.stringify([
          { orchestratorId: 'o1', name: 'alpha', leadSessionId: 'l1' },
        ]),
      }),
    );

    const state = await startUpdateRunnerAtBoot(runner, store);

    expect(state.runId).toBe('run-boot');
    expect(state.teams).toEqual([{ orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1' }]);
    // `start()` concluded the run, so the banner reports the real verdict.
    expect(store.get('run-boot')?.state).toBe('success');
    expect(state.banner).toContain('swarm-os was updated');
    expect(state.banner).toContain('v0.6.0');
  });

  it('says nothing when no run was in flight', async () => {
    const { runner } = makeRunner();
    store.insert(row({ id: 'old', state: 'success', finished_at: '2026-01-01T00:05:00.000Z' }));
    const state = await startUpdateRunnerAtBoot(runner, store);
    expect(state).toEqual({ runId: null, banner: null, teams: [] });
  });

  it('never rejects when the runner or the store misbehaves', async () => {
    const boom = { start: () => Promise.reject(new Error('start exploded')) };
    const throwingStore = {
      listActive: (): UpdateRunRow[] => {
        throw new Error('db exploded');
      },
      get: (): UpdateRunRow | null => null,
    };
    await expect(startUpdateRunnerAtBoot(boom, throwingStore)).resolves.toEqual({
      runId: null,
      banner: null,
      teams: [],
    });
  });

  it('is a no-op without a runner or a store', async () => {
    await expect(startUpdateRunnerAtBoot(null, store)).resolves.toEqual({
      runId: null,
      banner: null,
      teams: [],
    });
  });
});

describe('reconcileUpdateTeams', () => {
  it('reports which teams came back', () => {
    const spawner = new FakeSpawner([lead({ orchId: 'o1' })]);
    const result = reconcileUpdateTeams(spawner, [
      { orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1' },
      { orch_id: 'o2', orch_name: 'beta', lead_id: 'l2' },
    ]);
    expect(result?.back).toBe(1);
    expect(result?.missing).toBe(1);
    expect(spawner.reconcileCalls).toHaveLength(1);
  });

  it('does nothing without a snapshot, and swallows a throwing spawner', () => {
    const spawner = new FakeSpawner([]);
    expect(reconcileUpdateTeams(spawner, [])).toBeNull();
    expect(spawner.reconcileCalls).toHaveLength(0);
    const angry: ReconcilableSpawner = {
      reconcileTeams: () => {
        throw new Error('reconcile exploded');
      },
    };
    expect(reconcileUpdateTeams(angry, [{ orch_id: 'o1', orch_name: 'a', lead_id: null }])).toBeNull();
  });
});

/**
 * §D.6 — the verdict has to OUTLIVE the boot that produced it. It is read by
 * the post-update screen, minutes or days later, from a process that never saw
 * this boot's stdout.
 */
describe('reconcileUpdateTeams — persistence', () => {
  const SNAPSHOT = JSON.stringify([
    { orchestratorId: 'o1', name: 'alpha', leadSessionId: 'l1' },
    { orchestratorId: 'o2', name: 'beta', leadSessionId: 'l2' },
  ]);

  function seedFinishedRun(id = 'run-boot'): string {
    const runDir = path.join(dir, 'updater', 'runs', id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'result.json'),
      JSON.stringify({ state: 'success', verify: 'boot_complete', finished_at: '2026-01-01T00:05:00.000Z' }),
    );
    store.insert(row({ id, state: 'applying', run_dir: runDir, teams_snapshot_json: SNAPSHOT }));
    return id;
  }

  it('lands in the run row of the boot it belongs to — the exact production sequence', async () => {
    const id = seedFinishedRun();
    const { runner } = makeRunner();
    // Boot: the run id and the snapshot come out here...
    const state = await startUpdateRunnerAtBoot(runner, store);
    expect(state.runId).toBe(id);
    // ...and this is `index.ts` after auto-resume, exactly as it calls it: the
    // store is an ARGUMENT, from the caller that owns it. Nothing is carried
    // between the two calls by the module itself.
    const spawner = new FakeSpawner([lead({ orchId: 'o1' })]);
    reconcileUpdateTeams(spawner, state.teams, state.runId, store);

    expect(JSON.parse(store.get(id)!.teams_reconciled_json!)).toEqual([
      { orch_id: 'o1', orch_name: 'alpha', lead_id: 'l1', back: true, lead_id_now: 'l1', status: null, reason: 'ok' },
      { orch_id: 'o2', orch_name: 'beta', lead_id: 'l2', back: false, lead_id_now: 'l2', status: null, reason: 'absent' },
    ]);
    const view = runner.getRun(id);
    expect(view?.teamsReconciled.map((t) => [t.orch_name, t.reason])).toEqual([
      ['alpha', 'ok'],
      ['beta', 'absent'],
    ]);
    // Neither of the two columns it could NOT have used is disturbed: the
    // snapshot still holds `ActiveTeam[]`, and the verdict `applyResult` wrote
    // during `start()` is still there.
    expect(view?.teamsSnapshot).toEqual([
      { orchestratorId: 'o1', name: 'alpha', leadSessionId: 'l1' },
      { orchestratorId: 'o2', name: 'beta', leadSessionId: 'l2' },
    ]);
    expect(store.get(id)?.state).toBe('success');
  });

  it('writes nowhere when the boot had no run in flight', async () => {
    store.insert(row({ id: 'old', state: 'success', finished_at: '2026-01-01T00:05:00.000Z' }));
    const { runner } = makeRunner();
    const state = await startUpdateRunnerAtBoot(runner, store);
    expect(state.runId).toBeNull();
    // `index.ts` passes its store on every boot, in flight or not; the run id
    // is what says whether there is a row to write to, and there is not.
    reconcileUpdateTeams(
      new FakeSpawner([]),
      [{ orch_id: 'o1', orch_name: 'a', lead_id: null }],
      state.runId,
      store,
    );
    expect(store.get('old')?.teams_reconciled_json).toBeNull();
  });

  it('two runners in one process do not share a store — the handoff is gone', () => {
    // The module used to remember "the store of the last boot". With two
    // instances alive (which is any test file, and one day two deployments in
    // one process), the second boot's target would answer for the first's run.
    store.insert(row({ id: 'run-a' }));
    const otherDb = new SwarmDb(path.join(dir, 'other'));
    try {
      const other = new UpdateStore(otherDb);
      other.insert(row({ id: 'run-a' }));
      reconcileUpdateTeams(
        new FakeSpawner([]),
        [{ orch_id: 'o1', orch_name: 'alpha', lead_id: null }],
        'run-a',
        other,
      );
      expect(other.get('run-a')?.teams_reconciled_json).not.toBeNull();
      expect(store.get('run-a')?.teams_reconciled_json).toBeNull();
    } finally {
      otherDb.close();
    }
  });

  it('takes an explicit store when a caller has one', () => {
    store.insert(row({ id: 'run-x' }));
    reconcileUpdateTeams(
      new FakeSpawner([]),
      [{ orch_id: 'o1', orch_name: 'alpha', lead_id: null }],
      'run-x',
      store,
    );
    expect(JSON.parse(store.get('run-x')!.teams_reconciled_json!)).toEqual([
      { orch_id: 'o1', orch_name: 'alpha', lead_id: null, back: false, lead_id_now: null, status: null, reason: 'absent' },
    ]);
  });

  it('a store that will not write is a warning, never a failed boot', () => {
    const angry = {
      listActive: (): UpdateRunRow[] => [],
      get: (): UpdateRunRow | null => null,
      patch: (): void => {
        throw new Error('db gone');
      },
    };
    const result = reconcileUpdateTeams(
      new FakeSpawner([]),
      [{ orch_id: 'o1', orch_name: 'a', lead_id: null }],
      'run-x',
      angry,
    );
    // The caller still gets the answer; only the row is missing.
    expect(result?.missing).toBe(1);
  });
});
