import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb, type OrchestratorRow, type SessionRow } from '../db/index.js';
import { DbPersistence } from '../orchestrator/persistence.js';
import { Spawner, SpawnerError } from './index.js';
import type { Config } from '../../config.js';

/**
 * On-demand team restart (`Spawner.restartOrchestrator`). Backs the desktop
 * RESTART / REACTIVATE button: a terminal orchestrator (typically left behind
 * by a server restart where the resumed lead died) is relaunched in place,
 * reusing the SAME id/config/history via the auto-resume mechanic.
 *
 * `skipSpawn:true` is threaded through so the resume path mints a session
 * without a real claude subprocess (same test hook `create`/`start` use).
 */

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let db: SwarmDb;
let spawner: Spawner | null = null;

function makeConfig(): Config {
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
  } as Config;
}

/** Write a terminal orch row + its lead session row straight to SQLite —
 *  mirrors the "server rebooted, lead died, row is history-only" state. */
function seedDeadTeam(opts: { resumeCount?: number } = {}): { orchId: string; leadId: string } {
  const orchId = 'orch-dead-1';
  const leadId = 'lead-dead-1';
  const now = '2030-01-01T00:00:00.000Z';
  const orch: OrchestratorRow = {
    id: orchId,
    name: 'TEAM',
    role: 'co',
    role_id: null,
    status: 'stopped',
    lead_session_id: leadId,
    default_model: 'm',
    default_effort: 'low',
    default_permission_mode: 'bypassPermissions',
    default_provider: 'claude',
    lead_preamble: null,
    worker_preamble: null,
    created_at: now,
    ended_at: now,
    hidden_at: null,
    last_error: null,
    stop_reason: 'lead-stopped',
    last_resumed_at: now,
    resume_count: opts.resumeCount ?? 1,
  };
  db.upsertOrchestrator(orch);
  const lead: SessionRow = {
    id: leadId,
    orchestrator_id: orchId,
    name: 'TEAM-lead',
    role: 'co',
    type: 'lead',
    cwd: tmpRoot,
    initial_prompt: 'do work',
    model: 'm',
    effort: 'low',
    permission_mode: 'bypassPermissions',
    provider: 'claude',
    status: 'failed',
    pid: null,
    started_at: now,
    ended_at: now,
    exit_code: 1,
    last_error: 'exit code 1',
    stop_reason: null,
    log_path: path.join(logsDir, orchId, `${leadId}.log`),
    last_activity_at: now,
    hidden_at: null,
  };
  db.upsertSession(lead);
  return { orchId, leadId };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-restart-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });
  db = new SwarmDb(dataDir);
  spawner = null;
});

afterEach(async () => {
  // Tear down live orchestrators FIRST so their log write-streams close
  // before we delete tmpRoot — otherwise a late async flush hits a missing
  // file and surfaces as an unhandled stream 'error'.
  spawner?.shutdownAll('test-teardown');
  await new Promise((r) => setTimeout(r, 50));
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Spawner.restartOrchestrator', () => {
  it('relaunches a terminal, history-only team in place (same id, fresh lead, bumps resume_count)', () => {
    const persistence = new DbPersistence(db);
    spawner = new Spawner(makeConfig(), { persistence });
    const { orchId, leadId } = seedDeadTeam({ resumeCount: 1 });

    // Not in the live map before restart — purely a DB history row.
    expect(spawner.get(orchId)).toBeUndefined();

    const orch = spawner.restartOrchestrator(orchId, { skipSpawn: true });

    // Same orchestrator identity, now live and running.
    expect(orch.id).toBe(orchId);
    expect(orch.status).toBe('running');
    expect(spawner.get(orchId)).toBe(orch);
    // Fresh start ⇒ a brand-new lead session (the dead one stays in history).
    expect(orch.leadSessionId).toBeTruthy();
    expect(orch.leadSessionId).not.toBe(leadId);

    // Persisted back as running with config/createdAt preserved and an
    // incremented restart audit; the terminal `ended_at` is cleared.
    const row = db.getOrchestrator(orchId);
    expect(row?.status).toBe('running');
    expect(row?.created_at).toBe('2030-01-01T00:00:00.000Z');
    expect(row?.resume_count).toBe(2);
    expect(row?.ended_at).toBeNull();
  });

  it('throws NOT_FOUND for an unknown orchestrator id', () => {
    spawner = new Spawner(makeConfig(), { persistence: new DbPersistence(db) });
    let err: unknown;
    try {
      spawner.restartOrchestrator('nope');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpawnerError);
    expect((err as SpawnerError).code).toBe('NOT_FOUND');
    expect((err as SpawnerError).httpStatus).toBe(404);
  });

  it('throws ALREADY_RUNNING when the team is live and not terminal', () => {
    const persistence = new DbPersistence(db);
    spawner = new Spawner(makeConfig(), { persistence });
    const { orchestrator } = spawner.create(
      {
        name: 'LIVE',
        role: 'co',
        defaultModel: 'm',
        defaultEffort: 'low',
        defaultPermissionMode: 'bypassPermissions',
        defaultProvider: 'claude',
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      { skipSpawn: true },
    );
    expect(orchestrator.status).toBe('running');

    let err: unknown;
    try {
      spawner.restartOrchestrator(orchestrator.id, { skipSpawn: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpawnerError);
    expect((err as SpawnerError).code).toBe('ALREADY_RUNNING');
    expect((err as SpawnerError).httpStatus).toBe(409);
  });
});
