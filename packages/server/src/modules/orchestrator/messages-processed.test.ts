import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Mailbox } from './mailbox.js';
import { Session, type SessionView } from './session.js';
import { Orchestrator } from './index.js';
import { readInbox, type MessagingDeps } from './messaging.js';
import { NoOpPersistence, sessionToRow, rowToSessionView } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { SwarmDb, type OrchestratorRow, type SessionRow } from '../db/index.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 1 (docs/monitoring-agents.md) — the "messages processed" /
 * "inbox count" fields of `SessionView`.
 *
 * The contract under test, in one line: the counter measures what an AGENT
 * took, so `read()` is the only thing that may move it, and what it moves has
 * to reach `toView()` — everything durable (DB row, `GET /sessions/:id`) is
 * built from there and nothing else.
 */

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];

function makeConfig(): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
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
    maxInboxSize: 100,
    idleThresholdMs: 50,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
  } as unknown as Config;
}

/** A live orchestrator with a spawned lead, both wired to fake PTYs. */
function makeOrchWithLead(): { orch: Orchestrator; lead: Session } {
  const config = makeConfig();
  const orch = new Orchestrator(
    {
      name: 'monitoring',
      role: 'co',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    { persistence: new NoOpPersistence() },
  );
  const lead = orch.start({
    agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
  });
  openSessions.push(lead);
  return { orch, lead };
}

function makeDeps(orch: Orchestrator): MessagingDeps {
  return {
    orchestrator: orch,
    mailbox: orch.mailbox,
    defaults: { maxMessageSizeBytes: 1024, idleThresholdMs: 50 },
  };
}

/** The bits of a SessionView the conversion helpers actually care about. */
function makeView(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'sess-1',
    orchestratorId: 'orch-1',
    name: 'lead',
    role: 'r',
    type: 'lead',
    cwd: '/workspace/x',
    model: 'm',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    provider: 'claude',
    status: 'running',
    pid: 42,
    startedAt: '2026-08-30T10:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/data/logs/orch-1/sess-1.log',
    lastActivityAt: '2026-08-30T10:01:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-msgproc-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
  // Same drain as messaging.test.ts: let queued log writes land before the
  // tmp dir goes away, and clear any armed context-reset timer.
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Mailbox.messagesProcessed', () => {
  it('credits a drain with the number of messages it returned, not with 1', () => {
    const mb = new Mailbox();
    for (let i = 0; i < 3; i++) mb.push('s1', { from: 'lead', content: `m${i}` });
    expect(mb.messagesProcessed('s1')).toBe(0); // pushes don't count — reads do

    expect(mb.read('s1')).toHaveLength(3);
    expect(mb.messagesProcessed('s1')).toBe(3);
    // …and `readCount` still counts drains, so the two are not the same number.
    expect(mb.readCount('s1')).toBe(1);
  });

  it('accumulates across drains and is per session', () => {
    const mb = new Mailbox();
    mb.push('s1', { from: 'lead', content: 'a' });
    mb.read('s1');
    mb.push('s1', { from: 'lead', content: 'b' });
    mb.push('s1', { from: 'lead', content: 'c' });
    mb.read('s1');
    mb.push('s2', { from: 'lead', content: 'd' });
    mb.read('s2');

    expect(mb.messagesProcessed('s1')).toBe(3);
    expect(mb.messagesProcessed('s2')).toBe(1);
    expect(mb.messagesProcessed('never-seen')).toBe(0);
  });

  it('does not move on an empty drain', () => {
    const mb = new Mailbox();
    expect(mb.read('s1')).toEqual([]);
    mb.push('s1', { from: 'lead', content: 'a' });
    mb.read('s1');
    mb.read('s1');
    expect(mb.messagesProcessed('s1')).toBe(1);
  });

  it('does not count cap evictions — a dropped message was never read', () => {
    const mb = new Mailbox({ maxSize: 2 });
    for (let i = 0; i < 5; i++) mb.push('s1', { from: 'lead', content: `m${i}` });
    expect(mb.size('s1')).toBe(2); // three evicted
    expect(mb.messagesProcessed('s1')).toBe(0);

    mb.read('s1');
    expect(mb.messagesProcessed('s1')).toBe(2); // only what survived + was read
  });

  it('does not count removeSession or clearAll — a wipe is not a read', () => {
    const mb = new Mailbox();
    mb.push('s1', { from: 'lead', content: 'a' });
    mb.push('s2', { from: 'lead', content: 'b' });
    mb.push('s2', { from: 'lead', content: 'c' });

    mb.removeSession('s1');
    expect(mb.messagesProcessed('s1')).toBe(0);

    mb.clearAll();
    expect(mb.messagesProcessed('s2')).toBe(0);
    expect(mb.totalSize()).toBe(0);
  });

  it('survives clearAll monotonically once a real read happened', () => {
    const mb = new Mailbox();
    mb.push('s1', { from: 'lead', content: 'a' });
    mb.read('s1');
    mb.push('s1', { from: 'lead', content: 'b' });
    mb.clearAll();
    expect(mb.messagesProcessed('s1')).toBe(1);
  });
});

describe('Session mirror at the drain point', () => {
  it('readInbox pushes the drained count onto the Session', () => {
    const { orch, lead } = makeOrchWithLead();
    const deps = makeDeps(orch);
    for (let i = 0; i < 4; i++) orch.mailbox.push(lead.id, { from: 'human', content: `m${i}` });

    expect(readInbox(deps, lead.id)).toHaveLength(4);
    expect(lead.messagesProcessed).toBe(4);
    expect(lead.toView().messagesProcessed).toBe(4);
    // Mailbox and Session agree — one drain, one increment on each side.
    expect(orch.mailbox.messagesProcessed(lead.id)).toBe(4);
  });

  it('accumulates over successive drains and ignores empty ones', () => {
    const { orch, lead } = makeOrchWithLead();
    const deps = makeDeps(orch);

    orch.mailbox.push(lead.id, { from: 'human', content: 'a' });
    readInbox(deps, lead.id);
    readInbox(deps, lead.id); // empty — no credit
    orch.mailbox.push(lead.id, { from: 'human', content: 'b' });
    orch.mailbox.push(lead.id, { from: 'human', content: 'c' });
    readInbox(deps, lead.id);

    expect(lead.messagesProcessed).toBe(3);
    expect(orch.mailbox.messagesProcessed(lead.id)).toBe(3);
  });

  it('does not throw when the session is already gone', () => {
    const { orch } = makeOrchWithLead();
    const deps = makeDeps(orch);
    orch.mailbox.push('ghost-session', { from: 'human', content: 'a' });
    expect(() => readInbox(deps, 'ghost-session')).not.toThrow();
    expect(orch.mailbox.messagesProcessed('ghost-session')).toBe(1);
  });
});

describe('toView monitoring fields', () => {
  it('Orchestrator.toView decorates each session with its live inboxCount', () => {
    const { orch, lead } = makeOrchWithLead();
    const deps = makeDeps(orch);
    orch.mailbox.push(lead.id, { from: 'human', content: 'a' });
    orch.mailbox.push(lead.id, { from: 'human', content: 'b' });

    const queued = orch.toView().sessions.find((s) => s.id === lead.id)!;
    expect(queued.inboxCount).toBe(2);
    expect(queued.messagesProcessed).toBe(0);
    expect(queued.contextResetPending).toBe(false);

    readInbox(deps, lead.id);
    const drained = orch.toView().sessions.find((s) => s.id === lead.id)!;
    expect(drained.inboxCount).toBe(0);
    expect(drained.messagesProcessed).toBe(2);
  });

  it('reports an armed context reset until it fires', () => {
    const { orch, lead } = makeOrchWithLead();
    expect(lead.toView().contextResetPending).toBe(false);

    // A long idle window keeps it armed for the duration of the test.
    expect(lead.requestContextReset('/compact', { idleMs: 60_000 })).toBe(true);
    expect(lead.toView().contextResetPending).toBe(true);
    expect(orch.toView().sessions.find((s) => s.id === lead.id)!.contextResetPending).toBe(true);
  });

  it('Session.toView never carries inboxCount — the mailbox is not its business', () => {
    const { lead } = makeOrchWithLead();
    expect('inboxCount' in lead.toView()).toBe(false);
  });
});

describe('persistence round-trip', () => {
  it('carries messagesProcessed through sessionToRow / rowToSessionView', () => {
    const view = makeView({ messagesProcessed: 12 });
    const row = sessionToRow(view, 'do work');
    expect(row.messages_processed).toBe(12);

    const back = rowToSessionView(row);
    expect(back.messagesProcessed).toBe(12);
  });

  it('omits the field (rather than inventing a 0) for a pre-column row', () => {
    const row = sessionToRow(makeView(), null);
    expect(row.messages_processed).toBeNull();

    const back = rowToSessionView(row);
    expect('messagesProcessed' in back).toBe(false);
  });

  it('keeps an explicit 0 distinct from "unknown"', () => {
    const row = sessionToRow(makeView({ messagesProcessed: 0 }), null);
    expect(row.messages_processed).toBe(0);
    expect(rowToSessionView(row).messagesProcessed).toBe(0);
  });

  it('survives a real SQLite write/read through the additive column', () => {
    const db = new SwarmDb(dataDir);
    try {
      const orchRow: OrchestratorRow = {
        id: 'orch-1',
        name: 'monitoring',
        role: 'co',
        role_id: null,
        status: 'running',
        lead_session_id: null,
        default_model: 'm',
        default_effort: 'low',
        default_permission_mode: 'bypassPermissions',
        default_provider: 'claude',
        lead_preamble: null,
        worker_preamble: null,
        created_at: new Date().toISOString(),
        ended_at: null,
        hidden_at: null,
        last_error: null,
        stop_reason: null,
        last_resumed_at: null,
        resume_count: 0,
      };
      db.upsertOrchestrator(orchRow);

      const row = sessionToRow(makeView({ messagesProcessed: 7 }), null);
      db.upsertSession(row);
      expect(db.getSession('sess-1')?.messages_processed).toBe(7);

      // The UPSERT must UPDATE the column too, not just write it once.
      db.upsertSession(sessionToRow(makeView({ messagesProcessed: 9 }), null));
      expect(db.getSession('sess-1')?.messages_processed).toBe(9);

      // A row builder that predates the column still writes (NULL), which is
      // exactly what a legacy caller / plugin looks like.
      const legacy: SessionRow = { ...row, id: 'sess-legacy' };
      delete legacy.messages_processed;
      db.upsertSession(legacy);
      expect(db.getSession('sess-legacy')).not.toBeNull();
      expect(db.getSession('sess-legacy')?.messages_processed).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('resume seed', () => {
  it('a Session built from a persisted row starts at the row value', () => {
    const s = new Session({
      id: 'resumed-1',
      startedAt: '2026-08-30T09:00:00.000Z',
      messagesProcessed: 41,
      orchestratorId: 'orch-1',
      name: 'resumed',
      role: 'tester',
      type: 'lead',
      cwd: tmpRoot,
      initialPrompt: null,
      preamble: null,
      model: 'm',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
    });
    openSessions.push(s);

    expect(s.messagesProcessed).toBe(41);
    expect(s.toView().messagesProcessed).toBe(41);
    s.recordMessagesProcessed(1);
    expect(s.messagesProcessed).toBe(42);
  });

  it('defaults to 0 and clamps a nonsensical seed', () => {
    const build = (seed: number | undefined): Session => {
      const s = new Session({
        id: `seed-${String(seed)}`,
        messagesProcessed: seed,
        orchestratorId: 'orch-1',
        name: 'seeded',
        role: 'tester',
        type: 'worker',
        cwd: tmpRoot,
        initialPrompt: null,
        preamble: null,
        model: 'm',
        effort: 'low',
        permissionMode: 'bypassPermissions',
        logsDir,
        mcpRuntimeDir,
        mcpHost: '127.0.0.1',
        mcpPort: 0,
        agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
      });
      openSessions.push(s);
      return s;
    };
    expect(build(undefined).messagesProcessed).toBe(0);
    expect(build(-5).messagesProcessed).toBe(0);
    expect(build(Number.NaN).messagesProcessed).toBe(0);
  });

  it('recordMessagesProcessed ignores non-positive credits', () => {
    const { lead } = makeOrchWithLead();
    lead.recordMessagesProcessed(0);
    lead.recordMessagesProcessed(-3);
    expect(lead.messagesProcessed).toBe(0);
    lead.recordMessagesProcessed(2);
    expect(lead.messagesProcessed).toBe(2);
  });

  it('addWorker forwards the seed — the resume path for workers', () => {
    const { orch } = makeOrchWithLead();
    const worker = orch.addWorker({
      name: 'w1',
      role: 'tester',
      prompt: 'work',
      cwd: tmpRoot,
      existingId: 'worker-resumed',
      startedAt: '2026-08-30T09:00:00.000Z',
      messagesProcessed: 5,
      agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
    });
    openSessions.push(worker);

    expect(worker.messagesProcessed).toBe(5);
    const view = orch.toView().sessions.find((s) => s.id === 'worker-resumed')!;
    expect(view.messagesProcessed).toBe(5);
    expect(view.inboxCount).toBe(0);
  });
});
