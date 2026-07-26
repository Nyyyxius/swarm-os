import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import type { OrchestratorRow, SessionRow } from '../db/index.js';

/**
 * update_system D.5 — the post-restart banner threading:
 *
 *   Spawner.resumeFromDb({ resumeBanner })
 *     → Orchestrator.resume({ banner })
 *       → buildResumeNotice(logPath, banner)   ← LEAD ONLY
 *
 * The banner is the only channel that survives the container being recreated
 * (the pre-update mailbox row is wiped by `shutdownForRestart` → `clearAll()`),
 * so what matters here is (a) it reaches the lead, (b) it does NOT reach the
 * workers, (c) callers that pass nothing get the exact previous behaviour.
 *
 * Two seams are faked: the PTY (so a resume can complete without a real
 * `claude` binary) and `buildResumeNotice` (wrapped, not replaced — the real
 * implementation still runs, we only record the arguments).
 */
const noticeCalls = vi.hoisted(() => [] as Array<{ logPath: string | null; banner?: string | null }>);

vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/agent-process.js')>();
  return { ...actual, PtyAgentProcess: actual.FakeAgentProcess };
});

vi.mock('../orchestrator/log-tail-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/log-tail-reader.js')>();
  return {
    ...actual,
    buildResumeNotice: (logPath: string | null, banner?: string | null) => {
      noticeCalls.push({ logPath, banner });
      return actual.buildResumeNotice(logPath, banner);
    },
  };
});

// Kept below the mocks for readability — vitest hoists `vi.mock` above every
// import anyway, so the module registry is already patched.
import { Spawner } from './index.js';

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let spawner: InstanceType<typeof Spawner> | null = null;

function makeConfig(): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 0,
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
  } as Config;
}

const TS = '2030-01-01T00:00:00.000Z';

function makeRows(): Array<{ orch: OrchestratorRow; sessions: SessionRow[] }> {
  const orchId = 'orch-resume-1';
  const orch: OrchestratorRow = {
    id: orchId,
    name: 'TEAM',
    role: 'co',
    role_id: null,
    status: 'interrupted',
    lead_session_id: 'lead-1',
    default_model: 'm',
    default_effort: 'low',
    default_permission_mode: 'bypassPermissions',
    lead_preamble: null,
    worker_preamble: null,
    created_at: TS,
    ended_at: null,
    hidden_at: null,
    last_error: null,
    stop_reason: null,
    last_resumed_at: null,
    resume_count: 0,
  } as unknown as OrchestratorRow;

  const session = (id: string, type: 'lead' | 'worker'): SessionRow => ({
    id,
    orchestrator_id: orchId,
    name: `TEAM-${id}`,
    role: 'co',
    type,
    cwd: tmpRoot,
    initial_prompt: 'do work',
    model: 'm',
    effort: 'low',
    permission_mode: 'bypassPermissions',
    status: 'interrupted',
    pid: null,
    started_at: TS,
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: path.join(logsDir, orchId, `${id}.log`),
    last_activity_at: TS,
    hidden_at: null,
  });

  return [{ orch, sessions: [session('lead-1', 'lead'), session('worker-1', 'worker')] }];
}

beforeEach(() => {
  noticeCalls.length = 0;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-resume-banner-'));
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

describe('Spawner.resumeFromDb — resumeBanner threading (D.5)', () => {
  it('passes the banner to the LEAD only, never to workers', async () => {
    spawner = new Spawner(makeConfig());
    const banner = '## Server updated\nswarm-os is now v9.9.9.';
    const res = await spawner.resumeFromDb(makeRows(), { staggerMs: 0, resumeBanner: banner });

    expect(res.resumed).toBe(1);
    expect(res.failed).toEqual([]);
    expect(noticeCalls).toHaveLength(2);

    const lead = noticeCalls.find((c) => c.logPath?.includes('lead-1'));
    const worker = noticeCalls.find((c) => c.logPath?.includes('worker-1'));
    expect(lead?.banner).toBe(banner);
    // The worker call is the untouched one-arg call site.
    expect(worker?.banner).toBeUndefined();
  });

  it('keeps the default path byte-identical when no banner is supplied', async () => {
    spawner = new Spawner(makeConfig());
    const res = await spawner.resumeFromDb(makeRows(), { staggerMs: 0 });

    expect(res.resumed).toBe(1);
    expect(noticeCalls).toHaveLength(2);
    // `undefined` banner ⇒ `buildResumeNotice` returns exactly what it always
    // did (proved byte-for-byte in log-tail-reader.test.ts).
    for (const call of noticeCalls) expect(call.banner ?? undefined).toBeUndefined();
  });
});
