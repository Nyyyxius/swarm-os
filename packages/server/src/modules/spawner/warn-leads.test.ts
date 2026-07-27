import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config.js';

/**
 * update_system D.5 / D.6 — `Spawner.warnLeads` / `leadNoticeStatus` /
 * `snapshotLiveTeams` / `reconcileTeams`.
 *
 * These paths need a lead with a LIVE PTY (an armed notice is refused without
 * one), so we swap `PtyAgentProcess` for the in-repo `FakeAgentProcess`
 * instead of using `skipSpawn` — same seam the session tests use, but applied
 * one level up, where `Orchestrator.start()` constructs the Session itself.
 */
vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/agent-process.js')>();
  return { ...actual, PtyAgentProcess: actual.FakeAgentProcess };
});

// Imported below the mock for readability — vitest hoists `vi.mock` above
// every import anyway, so the module registry is already patched.
import { Spawner } from './index.js';
import type { Session } from '../orchestrator/session.js';

type SpawnerT = InstanceType<typeof Spawner>;

/**
 * Drive PTY output through the fake process so `Session._idleSince` moves
 * exactly like it would for a lead that is mid-turn. The agent handle is
 * private (nothing in production has any business writing to it), hence the
 * cast — this is the one place that needs to simulate the agent talking.
 */
function pumpPtyOutput(lead: Session, chunk = 'working...'): void {
  (lead as unknown as { agent: { _emitData: (s: string) => void } }).agent._emitData(chunk);
}

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let spawner: SpawnerT | null = null;

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 0,
    projectName: 'test',
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 5,
    idleThresholdMs: 20,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...over,
  } as Config;
}

function createTeam(s: SpawnerT, name: string) {
  return s.create({
    name,
    role: 'co',
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    leadPreamble: null,
    workerPreamble: null,
    lead: { cwd: tmpRoot, prompt: 'do work', preamble: null },
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-warn-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir, path.join(tmpRoot, 'claude-runtime')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  spawner = null;
});

afterEach(async () => {
  spawner?.shutdownAll('test-teardown');
  await new Promise((r) => setTimeout(r, 50));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Spawner.warnLeads (D.5)', () => {
  it('queues a pre-minted mailbox row and arms the PTY notice for every live lead', async () => {
    spawner = new Spawner(makeConfig());
    const a = createTeam(spawner, 'ALPHA');
    const b = createTeam(spawner, 'BETA');

    const warned = spawner.warnLeads('[swarm-os] update in 2 minutes', {
      idleMs: 20,
      deadlineMs: 2000,
    });
    expect(warned).toHaveLength(2);
    expect(warned.map((w) => w.orch_name).sort()).toEqual(['ALPHA', 'BETA']);
    expect(warned.every((w) => w.queued && w.armed)).toBe(true);

    // The pre-minted id is really the id sitting in the inbox — that identity
    // is the whole read-receipt mechanism.
    for (const w of warned) {
      const orch = w.orch_id === a.orchestrator.id ? a.orchestrator : b.orchestrator;
      expect(orch.mailbox.peek(w.lead_id).map((m) => m.id)).toContain(w.notice_id);
    }

    // Before the idle boundary nothing has been delivered.
    let status = spawner.leadNoticeStatus(warned);
    expect(status.every((s) => s.state === 'never_idle')).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    status = spawner.leadNoticeStatus(warned);
    expect(status.every((s) => s.signalled)).toBe(true);
    expect(status.every((s) => s.state === 'queued_unread')).toBe(true);
    expect(status.some((s) => s.read)).toBe(false);
  });

  it('reports `read` only once an agent actually drains the inbox', async () => {
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'GAMMA');
    const warned = spawner.warnLeads('update incoming', { idleMs: 20, deadlineMs: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(spawner.leadNoticeStatus(warned)[0]?.state).toBe('queued_unread');

    // `team.read_inbox` — the destructive drain. Only an agent does this.
    orchestrator.mailbox.read(warned[0]!.lead_id);

    const after = spawner.leadNoticeStatus(warned)[0]!;
    expect(after.read).toBe(true);
    expect(after.state).toBe('read');
  });

  it('does not mistake a dying lead for a read — stop() wipes the mailbox', async () => {
    // The single most likely event of an update window. `_onLeadExit` calls
    // `Orchestrator.stop()`, which calls `mailbox.clearAll()`: our notice row
    // disappears without any agent having gone near it. Inferring `read` from
    // that absence is the exact lie the pre-minted id exists to prevent.
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'THETA');
    const warned = spawner.warnLeads('update in 2 minutes', { idleMs: 20, deadlineMs: 2000 });
    const leadId = warned[0]!.lead_id;
    await new Promise((r) => setTimeout(r, 300));
    // The notice reached the PTY but nobody has drained the inbox yet.
    expect(spawner.leadNoticeStatus(warned)[0]?.state).toBe('queued_unread');

    orchestrator.stop('lead-stopped');
    // The row is gone, and the orchestrator is still in the live map — so the
    // `if (orch)` guard does not save us here.
    expect(orchestrator.mailbox.peek(leadId)).toHaveLength(0);
    expect(orchestrator.mailbox.peek(leadId).length).toBeLessThan(makeConfig().maxInboxSize);

    const after = spawner.leadNoticeStatus(warned)[0]!;
    expect(after.read).toBe(false);
    expect(after.state).toBe('queued_unread');
  });

  it('a lead that dies before ever going idle is recorded never_idle, not read', () => {
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'IOTA');
    // Long idle window: the armed notice cannot have fired yet.
    const warned = spawner.warnLeads('update in 2 minutes', { idleMs: 5000, deadlineMs: 9000 });
    expect(spawner.leadNoticeStatus(warned)[0]?.state).toBe('never_idle');

    orchestrator.stop('lead-stopped');

    const after = spawner.leadNoticeStatus(warned)[0]!;
    expect(after.signalled).toBe(false);
    expect(after.read).toBe(false);
    expect(after.state).toBe('never_idle');
  });

  it('shutdownForRestart is the same door and must not fabricate a read either', async () => {
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'KAPPA');
    const warned = spawner.warnLeads('applying NOW', { idleMs: 20, deadlineMs: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(spawner.leadNoticeStatus(warned)[0]?.state).toBe('queued_unread');

    orchestrator.shutdownForRestart('server-restart');

    const after = spawner.leadNoticeStatus(warned)[0]!;
    expect(after.read).toBe(false);
    expect(after.state).toBe('queued_unread');
  });

  it('a genuine read still counts even if the lead dies right after it', async () => {
    // The other half of the contract: the liveness of the lead is NOT the
    // criterion. An agent that drained the inbox and then exited really was
    // warned, and the record must say so.
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'LAMBDA');
    const warned = spawner.warnLeads('update incoming', { idleMs: 20, deadlineMs: 2000 });
    await new Promise((r) => setTimeout(r, 300));

    orchestrator.mailbox.read(warned[0]!.lead_id);
    orchestrator.stop('lead-stopped');

    const after = spawner.leadNoticeStatus(warned)[0]!;
    expect(after.read).toBe(true);
    expect(after.state).toBe('read');
  });

  it('does not mistake a cap eviction for a read — it re-pushes the notice instead', () => {
    // maxInboxSize is 5 here: 5 further messages evict our notice.
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'DELTA');
    const warned = spawner.warnLeads('update incoming', { idleMs: 5000, deadlineMs: 9000 });
    const leadId = warned[0]!.lead_id;
    for (let i = 0; i < 5; i++) {
      orchestrator.mailbox.push(leadId, { from: 'noise', content: `msg-${i}` });
    }
    // Our notice is gone from the queue…
    expect(orchestrator.mailbox.peek(leadId).map((m) => m.id)).not.toContain(warned[0]!.notice_id);

    const status = spawner.leadNoticeStatus(warned)[0]!;
    // …but that is eviction, not consumption: the queue is still AT the cap.
    expect(status.read).toBe(false);
    expect(status.state).toBe('never_idle');
    // And the notice was put back so a later real read is still observable.
    expect(orchestrator.mailbox.peek(leadId).map((m) => m.id)).toContain(warned[0]!.notice_id);
  });

  it('reports never_idle for a lead that talks through the whole window', async () => {
    spawner = new Spawner(makeConfig());
    createTeam(spawner, 'EPSILON');
    const warned = spawner.warnLeads('update in 2 minutes', { idleMs: 100, deadlineMs: 150 });
    const lead = spawner.listActive()[0]!.lead!;
    // A lead mid-turn: PTY bytes keep resetting the idle clock, so the naive
    // "inject if idle right now" path would never fire either — the point is
    // that we say so instead of staying silent.
    const pump = setInterval(() => pumpPtyOutput(lead), 20);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(pump);

    const status = spawner.leadNoticeStatus(warned)[0]!;
    expect(status.signalled).toBe(false);
    expect(status.state).toBe('never_idle');
  });

  it('cancelLeadNotices drops the armed notices but keeps the mailbox rows', async () => {
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'ZETA');
    const warned = spawner.warnLeads('update in 2 minutes', { idleMs: 5000, deadlineMs: 9000 });
    expect(spawner.cancelLeadNotices(warned)).toBe(1);
    expect(spawner.cancelLeadNotices(warned)).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    // Nothing was injected, and the operator's message is still readable.
    expect(spawner.leadNoticeStatus(warned)[0]?.signalled).toBe(false);
    expect(orchestrator.mailbox.peek(warned[0]!.lead_id).map((m) => m.id)).toContain(
      warned[0]!.notice_id,
    );
  });

  it('a second round supersedes the first without reporting a phantom delivery', async () => {
    spawner = new Spawner(makeConfig());
    createTeam(spawner, 'ETA');
    const first = spawner.warnLeads('update in 5 minutes', { idleMs: 5000, deadlineMs: 9000 });
    const second = spawner.warnLeads('applying NOW', { idleMs: 20, deadlineMs: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    // Only the second notice fired; the first must not claim it did.
    expect(spawner.leadNoticeStatus(second)[0]?.signalled).toBe(true);
    expect(spawner.leadNoticeStatus(first)[0]?.signalled).toBe(false);
  });
});

describe('Spawner.snapshotLiveTeams / reconcileTeams (D.6)', () => {
  it('snapshots orch id, name and lead id for every live team', () => {
    spawner = new Spawner(makeConfig());
    const a = createTeam(spawner, 'ALPHA');
    const snapshot = spawner.snapshotLiveTeams();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({
      orch_id: a.orchestrator.id,
      orch_name: 'ALPHA',
      lead_id: a.lead.id,
    });
  });

  it('reconciles a snapshot against what actually came back', () => {
    spawner = new Spawner(makeConfig());
    const a = createTeam(spawner, 'ALPHA');
    const b = createTeam(spawner, 'BETA');
    const snapshot = spawner.snapshotLiveTeams();

    // BETA never came back (the classic failed-resume: the DB row is
    // `interrupted` and would tell us nothing).
    b.orchestrator.stop('simulated-resume-failure');
    const rec = spawner.reconcileTeams(snapshot);
    expect(rec.teams).toHaveLength(2);
    expect(rec.back).toBe(1);
    expect(rec.missing).toBe(1);

    const alpha = rec.teams.find((t) => t.orch_id === a.orchestrator.id)!;
    expect(alpha.back).toBe(true);
    expect(alpha.reason).toBe('ok');
    expect(alpha.lead_id_now).toBe(a.lead.id);

    const beta = rec.teams.find((t) => t.orch_id === b.orchestrator.id)!;
    expect(beta.back).toBe(false);
    expect(beta.reason).toBe('not_running');
    expect(beta.orch_name).toBe('BETA');
  });

  it('marks a team absent from the live map as `absent`', () => {
    spawner = new Spawner(makeConfig());
    const rec = spawner.reconcileTeams([
      { orch_id: 'ghost', orch_name: 'GHOST', lead_id: 'lead-ghost' },
    ]);
    expect(rec.teams[0]).toEqual({
      orch_id: 'ghost',
      orch_name: 'GHOST',
      lead_id: 'lead-ghost',
      back: false,
      status: null,
      lead_id_now: null,
      reason: 'absent',
    });
    expect(rec.missing).toBe(1);
  });
});
