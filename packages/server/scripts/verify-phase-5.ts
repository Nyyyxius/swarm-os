/**
 * Phase update_system S5 — verification script.
 *
 * Exercises the 4 per-session lifecycle REST endpoints end-to-end against a
 * fully-wired in-process server (HTTP + MCP + SQLite + Spawner):
 *
 *   - POST /sessions/:id/stop      (worker only)
 *   - POST /sessions/:id/pause     (lead + worker)
 *   - POST /sessions/:id/resume
 *   - POST /sessions/:id/restart   (worker only — new session UUID)
 *
 * Plus error matrices (404 / 409 LEAD_NOT_STOPPABLE / LEAD_NOT_RESTARTABLE /
 * ALREADY_TERMINATED / NOT_PAUSED).
 *
 * Workers are spawned via the orchestrator directly with a `FakeAgentProcess`
 * override so the script doesn't depend on a real `claude` binary (the fake
 * accepts SIGSTOP/SIGCONT without exiting — see agent-process.ts).
 *
 * Run with: pnpm --filter server verify:phase5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Spawner } from '../src/modules/spawner/index.js';
import { McpServer } from '../src/modules/mcp/server.js';
import { SwarmDb } from '../src/modules/db/index.js';
import { DbPersistence } from '../src/modules/orchestrator/persistence.js';
import { startServer } from '../src/http/main.js';
import { loadConfig, _resetConfigCacheForTesting } from '../src/config.js';
import { initRootLogger } from '../src/logger.js';
import { FakeAgentProcess } from '../src/modules/orchestrator/agent-process.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];
function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function dump(obj: unknown): string {
  try {
    return JSON.stringify(obj).slice(0, 300);
  } catch {
    return String(obj);
  }
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-phase5-'));
  const dataDir = path.join(tmp, 'data');
  const workspaceRoot = path.join(tmp, 'workspace');
  const mcpRuntimeDir = path.join(tmp, 'mcp-runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });

  process.env.SWARM_OS_TOKEN = 'verify-phase5';
  process.env.HOOK_TOKEN = 'phase5-hook';
  process.env.SWARM_OS_DATA_DIR = dataDir;
  process.env.SWARM_OS_WORKSPACE_ROOT = workspaceRoot;
  process.env.SWARM_OS_MCP_RUNTIME_DIR = mcpRuntimeDir;
  process.env.SWARM_OS_MCP_PORT = '18990';
  process.env.SWARM_OS_PORT = '18991';
  process.env.SWARM_OS_IDLE_THRESHOLD_MS = '50';
  process.env.SWARM_OS_LOG_LEVEL = 'warn';
  process.env.SWARM_OS_LOG_PRETTY = '0';
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(dataDir, '.claude-runtime');
  _resetConfigCacheForTesting();

  const config = loadConfig();
  initRootLogger(config);
  const db = new SwarmDb(dataDir);
  const persistence = new DbPersistence(db);
  const spawner = new Spawner(config, { persistence });
  const mcp = new McpServer(spawner, config.mcpPort, config);
  await mcp.start();
  const httpHandle = startServer(config, spawner);
  await new Promise((r) => setTimeout(r, 100));

  const baseUrl = `http://127.0.0.1:${config.port}`;
  const authHeaders = { 'X-Auth-Token': config.token, 'Content-Type': 'application/json' };

  // ---- Bootstrap orchestrator + lead (skipSpawn so no real claude) ----
  const { orchestrator, lead } = spawner.create(
    {
      name: 'p5-orch',
      role: 'tester',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: true },
  );

  // Add a worker with a FakeAgentProcess so we can SIGSTOP it without
  // depending on a real PTY. skipSpawn=true would leave session.agent null;
  // we need an actual fake to drive pause/resume.
  const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: workspaceRoot });
  const worker = orchestrator.addWorker({
    name: 'p5-worker',
    role: 'worker',
    prompt: 'noop',
    cwd: workspaceRoot,
    agentProcessOverride: fake,
  });

  // ---- (1) POST /sessions/<unknown>/stop → 404 -----------------------
  {
    const r = await fetch(`${baseUrl}/sessions/00000000-0000-0000-0000-000000000000/stop`, {
      method: 'POST',
      headers: authHeaders,
    });
    record('POST /sessions/<unknown>/stop → 404', r.status === 404, `status=${r.status}`);
  }

  // ---- (2) POST /sessions/<lead>/stop → 409 LEAD_NOT_STOPPABLE -------
  {
    const r = await fetch(`${baseUrl}/sessions/${lead.id}/stop`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { error?: string };
    record(
      'POST /sessions/<lead>/stop → 409 LEAD_NOT_STOPPABLE',
      r.status === 409 && body.error === 'LEAD_NOT_STOPPABLE',
      `status=${r.status} body=${dump(body)}`,
    );
  }

  // ---- (3) POST /sessions/<lead>/restart → 409 LEAD_NOT_RESTARTABLE --
  {
    const r = await fetch(`${baseUrl}/sessions/${lead.id}/restart`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { error?: string };
    record(
      'POST /sessions/<lead>/restart → 409 LEAD_NOT_RESTARTABLE',
      r.status === 409 && body.error === 'LEAD_NOT_RESTARTABLE',
      `status=${r.status} body=${dump(body)}`,
    );
  }

  // ---- (4) POST /sessions/<worker>/pause → 200 status=paused ---------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/pause`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { paused?: boolean; status?: string };
    record(
      'POST /sessions/<worker>/pause → 200, status=paused, SIGSTOP delivered',
      r.status === 200 &&
        body.paused === true &&
        body.status === 'paused' &&
        fake.signals.includes('SIGSTOP'),
      `status=${r.status} body=${dump(body)} signals=${dump(fake.signals)}`,
    );
  }

  // ---- (4b) double-pause → 409 (idempotent rejection) ---------------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/pause`, {
      method: 'POST',
      headers: authHeaders,
    });
    record(
      'POST /sessions/<worker>/pause when already paused → 409',
      r.status === 409,
      `status=${r.status}`,
    );
  }

  // ---- (5) POST /sessions/<worker>/resume → 200 status=running -------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/resume`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { resumed?: boolean; status?: string };
    record(
      'POST /sessions/<worker>/resume → 200, status=running, SIGCONT delivered',
      r.status === 200 &&
        body.resumed === true &&
        body.status === 'running' &&
        fake.signals.includes('SIGCONT'),
      `status=${r.status} body=${dump(body)} signals=${dump(fake.signals)}`,
    );
  }

  // ---- (5b) resume when not paused → 409 NOT_PAUSED ------------------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/resume`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { error?: string };
    record(
      'POST /sessions/<worker>/resume when running → 409 NOT_PAUSED',
      r.status === 409 && body.error === 'NOT_PAUSED',
      `status=${r.status} body=${dump(body)}`,
    );
  }

  // ---- (6) POST /sessions/<worker>/restart → 201 newId ≠ oldId -------
  // Add a SECOND worker with its own fake — we'll restart it; the existing
  // worker stays around. Use a dedicated fake so we can assert on signals
  // independently.
  const fake2 = new FakeAgentProcess({ command: 'fake', args: [], cwd: workspaceRoot });
  const target = orchestrator.addWorker({
    name: 'restart-target',
    role: 'restartable',
    prompt: 'original-prompt',
    cwd: workspaceRoot,
    model: 'test-model-2',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    agentProcessOverride: fake2,
  });
  {
    const r = await fetch(`${baseUrl}/sessions/${target.id}/restart`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as {
      oldSession?: { id?: string; status?: string; model?: string };
      newSession?: { id?: string; status?: string; model?: string; cwd?: string; effort?: string };
      note?: string;
    };
    const ok =
      r.status === 201 &&
      !!body.oldSession?.id &&
      !!body.newSession?.id &&
      body.oldSession.id !== body.newSession.id &&
      body.newSession.model === 'test-model-2' &&
      body.newSession.effort === 'high' &&
      body.newSession.cwd === workspaceRoot &&
      typeof body.note === 'string';
    record(
      'POST /sessions/<worker>/restart → 201, new UUID, config preserved',
      ok,
      `status=${r.status} bodyShape=${dump(body)}`,
    );
    if (ok && body.oldSession?.id) {
      // Old session should be marked killed with stopReason=restart-requested
      // once the SIGTERM round-trip completes. The fake emits exit
      // synchronously via setImmediate after kill('SIGTERM').
      await new Promise((r) => setImmediate(r));
      const oldS = orchestrator.getSession(body.oldSession.id);
      record(
        'old session marked killed + stopReason=restart-requested',
        oldS?.status === 'killed' && oldS?.stopReason === 'restart-requested',
        `status=${oldS?.status} reason=${oldS?.stopReason}`,
      );
    }
  }

  // ---- (7) Stop the first worker (still running), expect 200 ---------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/stop`, {
      method: 'POST',
      headers: authHeaders,
    });
    record(
      'POST /sessions/<worker>/stop (running) → 200',
      r.status === 200,
      `status=${r.status}`,
    );
    await new Promise((r) => setImmediate(r));
    record(
      'worker eventually transitions to killed via SIGTERM',
      worker.status === 'killed',
      `status=${worker.status}`,
    );
  }

  // ---- (8) Re-stop of an already-terminated session → 409 ------------
  {
    const r = await fetch(`${baseUrl}/sessions/${worker.id}/stop`, {
      method: 'POST',
      headers: authHeaders,
    });
    const body = (await r.json()) as { error?: string };
    record(
      'POST /sessions/<worker>/stop on killed → 409 ALREADY_TERMINATED',
      r.status === 409 && body.error === 'ALREADY_TERMINATED',
      `status=${r.status} body=${dump(body)}`,
    );
  }

  // ---- (9) Lead pause + resume allowed (no LEAD_NOT_PAUSABLE) --------
  // The lead has skipSpawn=true so it has no underlying agent → pause()
  // will return false (no agent). To exercise the route shape we attach a
  // fake to a fresh orch's lead. For simplicity here, we assert that the
  // route rejects with INVALID_TRANSITION (409) — same handler path, just
  // tells us the lead-type guard wasn't tripped. The dedicated
  // "pause-lead-with-agent" path is covered by the unit tests.
  {
    const r = await fetch(`${baseUrl}/sessions/${lead.id}/pause`, {
      method: 'POST',
      headers: authHeaders,
    });
    record(
      'POST /sessions/<lead>/pause is NOT rejected as LEAD_NOT_PAUSABLE',
      // 409 INVALID_TRANSITION is acceptable (skipSpawn lead has no agent);
      // what we forbid is a 4xx with LEAD_NOT_* error code.
      r.status === 409 || r.status === 200,
      `status=${r.status}`,
    );
    if (r.status === 409) {
      const body = (await r.json()) as { error?: string };
      record(
        'lead-pause 409 carries INVALID_TRANSITION (or similar), not a LEAD_NOT_* code',
        !!body.error && !body.error.startsWith('LEAD_NOT_'),
        `error=${body.error}`,
      );
    }
  }

  // ---- (10) /health surfaces sessions_paused -------------------------
  {
    // Pause the freshly-restarted worker so the counter is non-zero.
    const newSession = orchestrator
      .listSessions()
      .find((s) => s.name === 'restart-target' && s.status === 'running');
    if (newSession) {
      // Need an agent → newSession is the freshly addWorker'd one without
      // an agentProcessOverride. It won't have a real PTY so pause() may
      // return false. We assert the /health surface regardless.
      orchestrator.pauseSession(newSession.id);
    }
    const r = await fetch(`${baseUrl}/health`);
    const body = (await r.json()) as { sessions_paused?: number };
    record(
      'GET /health includes sessions_paused counter',
      r.status === 200 && typeof body.sessions_paused === 'number',
      `status=${r.status} body=${dump(body)}`,
    );
  }

  // ---- Cleanup -------------------------------------------------------
  spawner.shutdownAll('verify-cleanup');
  await new Promise((r) => setTimeout(r, 100));
  await mcp.stop();
  await httpHandle.close();
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
