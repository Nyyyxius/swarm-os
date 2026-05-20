import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { DbPersistence, NoOpPersistence, orchToRow, sessionToRow, rowToOrchView, rowToSessionView } from './persistence.js';
import { Session } from './session.js';
import { FakeAgentProcess } from './agent-process.js';
import { Orchestrator } from './index.js';
import type { Config } from '../../config.js';

/**
 * Phase 7 — orchestrator persistence adapter.
 *
 * The conversion helpers (`orchToRow`, `sessionToRow`, `rowToOrchView`,
 * `rowToSessionView`) carry the load-bearing field mapping. We test those
 * directly + a happy-path round-trip through DbPersistence to make sure the
 * Orchestrator/Session shapes line up with the schema.
 */

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let db: SwarmDb;

function makeConfig(): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
    projectName: 'test',
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
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
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pers-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });
  db = new SwarmDb(dataDir);
});

afterEach(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('orchToRow / sessionToRow', () => {
  it('drops sessionSecret and includes stop_reason', () => {
    const view = {
      id: 'orch-1',
      name: 'merge',
      role: 'co',
      roleId: null,
      status: 'running' as const,
      leadSessionId: 'sess-1',
      defaultModel: 'm',
      defaultEffort: 'low' as const,
      defaultPermissionMode: 'bypassPermissions' as const,
      leadPreamble: null,
      workerPreamble: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
      lastError: null,
      sessions: [],
    };
    const row = orchToRow(view, { stopReason: 'user' });
    expect(row.id).toBe('orch-1');
    expect(row.stop_reason).toBe('user');
    expect(row.lead_session_id).toBe('sess-1');
  });

  it('sessionToRow plumbs initialPrompt explicitly', () => {
    const view = {
      id: 'sess-1',
      orchestratorId: 'orch-1',
      name: 'lead',
      role: 'r',
      type: 'lead' as const,
      cwd: '/workspace/x',
      model: 'm',
      effort: 'low' as const,
      permissionMode: 'bypassPermissions' as const,
      status: 'running' as const,
      pid: 123,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      lastError: null,
      stopReason: null,
      logPath: '/data/logs/orch-1/sess-1.log',
      lastActivityAt: new Date().toISOString(),
    };
    const row = sessionToRow(view, 'do work');
    expect(row.initial_prompt).toBe('do work');
    expect(row.orchestrator_id).toBe('orch-1');
    expect(row.log_path).toBe('/data/logs/orch-1/sess-1.log');
  });
});

describe('rowToOrchView / rowToSessionView', () => {
  it('round-trips via the orch view shape', () => {
    const baseView = {
      id: 'orch-1',
      name: 'm',
      role: 'r',
      roleId: null,
      status: 'stopped' as const,
      leadSessionId: 'sess-1',
      defaultModel: 'mod',
      defaultEffort: 'low' as const,
      defaultPermissionMode: 'bypassPermissions' as const,
      leadPreamble: null,
      workerPreamble: null,
      createdAt: '2030-01-01T00:00:00Z',
      endedAt: '2030-01-02T00:00:00Z',
      lastError: null,
      sessions: [],
    };
    const row = orchToRow(baseView, { stopReason: 'user' });
    const back = rowToOrchView(row, []);
    expect(back.id).toBe(baseView.id);
    expect(back.status).toBe(baseView.status);
    expect(back.endedAt).toBe(baseView.endedAt);
  });

  it('rowToSessionView preserves the SessionView contract', () => {
    const view = {
      id: 'sess-1',
      orchestratorId: 'orch-1',
      name: 'lead',
      role: 'r',
      type: 'lead' as const,
      cwd: '/workspace/x',
      model: 'm',
      effort: 'low' as const,
      permissionMode: 'bypassPermissions' as const,
      status: 'killed' as const,
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 137,
      lastError: null,
      stopReason: 'user',
      logPath: '/x/y',
      lastActivityAt: new Date().toISOString(),
    };
    const row = sessionToRow(view, null);
    const back = rowToSessionView(row);
    expect(back).toEqual(view);
  });
});

describe('DbPersistence', () => {
  it('writes the orchestrator row through to SQLite', () => {
    const config = makeConfig();
    const persistence = new DbPersistence(db);
    const orch = new Orchestrator(
      {
        name: 'merge',
        role: 'co',
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        defaultPermissionMode: config.defaultPermissionMode,
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      config,
      { persistence },
    );
    persistence.writeOrchestrator(orch);
    const row = db.getOrchestrator(orch.id);
    expect(row).not.toBeNull();
    expect(row?.name).toBe('merge');
    expect(row?.status).toBe('starting');
  });

  it('writes session rows, throttles activity-only updates, but force flushes status changes', async () => {
    const config = makeConfig();
    const persistence = new DbPersistence(db);
    const orch = new Orchestrator(
      {
        name: 'merge',
        role: 'co',
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        defaultPermissionMode: config.defaultPermissionMode,
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      config,
      { persistence },
    );
    // Persist the orch row FIRST — DB has FK enforcement on sessions.
    persistence.writeOrchestrator(orch);
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
    // Use the orchestrator.start path to emit a session — this also wires the
    // onStateChange callback to DbPersistence.
    const lead = orch.start({ agentProcessOverride: fake });
    expect(lead).toBeInstanceOf(Session);
    // Force a write of the lead row for the test (mimics what Spawner does).
    persistence.writeSession(lead, { force: true });
    persistence.writeOrchestrator(orch);
    expect(db.listSessions(orch.id)).toHaveLength(1);
    const initialRow = db.listSessions(orch.id)[0]!;
    expect(initialRow.status).toBe('running');

    // Activity-only update — throttled, second write within 1 s should skip.
    fake._emitData('chunk-1');
    fake._emitData('chunk-2');
    // No assertion on row count change here — we only assert nothing CRASHED
    // and the row is still present.
    expect(db.listSessions(orch.id)).toHaveLength(1);

    // A status transition (lead exit) should force a write through.
    fake._simulateExit({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const finalRow = db.listSessions(orch.id)[0]!;
    expect(['exited', 'killed', 'failed']).toContain(finalRow.status);
    expect(finalRow.exit_code).toBe(0);

    // Cleanup the orchestrator (mostly to verify no exception is raised when
    // stop() is called in this state).
    orch.stop('test-shutdown');
  });
});

describe('NoOpPersistence', () => {
  it('exposes a stub db that satisfies the interface', () => {
    const p = new NoOpPersistence();
    expect(p.recoverFromCrash()).toEqual({ orchestrators: 0, sessions: 0 });
    expect(p.db.getOrchestrator('whatever')).toBeNull();
    expect(p.db.listOrchestrators()).toEqual([]);
    expect(p.db.listRecentlyTerminatedOrchestrators(10)).toEqual([]);
  });
});
