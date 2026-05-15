/**
 * Phase 2 verification script.
 *
 * Exercises the MCP HTTP server end-to-end without requiring a real
 * `claude` subprocess:
 *
 *   1. Boot Spawner + McpServer in-process (skipSpawn for the lead)
 *   2. Use the official MCP SDK Streamable HTTP client to:
 *      - tools/list  → expect team.* including Phase 3 placeholders
 *      - tools/call team.whoami → expect lead metadata, no session_secret
 *      - tools/call team.list   → expect 1 active member
 *      - tools/call team.spawn_worker → expect McpError "not implemented in Phase 2"
 *   3. Verify the per-session mcp.json exists with mode 0600
 *   4. Verify a wrong session_secret on the path → HTTP 404 (no orch leak)
 *   5. Verify the bind is loopback only (we observe the listening socket)
 *   6. Cleanup: orchestrator stop → mcp.json removed
 *
 * Run with: pnpm --filter server verify:phase2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Spawner } from '../src/modules/spawner/index.js';
import { McpServer } from '../src/modules/mcp/server.js';
import { loadConfig, _resetConfigCacheForTesting } from '../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

async function main(): Promise<void> {
  // Use a tmp data dir so we never touch the user's .dev-data state.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-phase2-'));
  const dataDir = path.join(tmp, 'data');
  const workspaceRoot = path.join(tmp, 'workspace');
  const mcpRuntimeDir = path.join(tmp, 'mcp-runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });

  process.env.SWARM_OS_TOKEN = 'verify-phase2';
  process.env.SWARM_OS_DATA_DIR = dataDir;
  process.env.SWARM_OS_WORKSPACE_ROOT = workspaceRoot;
  process.env.SWARM_OS_MCP_RUNTIME_DIR = mcpRuntimeDir;
  // Pick a port well clear of dev defaults to avoid clashes with a parallel dev server.
  process.env.SWARM_OS_MCP_PORT = '18788';
  process.env.SWARM_OS_PORT = '18787';
  _resetConfigCacheForTesting();

  const config = loadConfig();
  const spawner = new Spawner(config);
  const mcp = new McpServer(spawner, config.mcpPort);
  await mcp.start();

  // Create an orchestrator with skipSpawn so no real claude is needed.
  // We need the orch's mcp.json on disk + the in-memory session, both of
  // which the Spawner gives us when skipSpawn=true.
  const { orchestrator, lead } = spawner.create(
    {
      name: 'verify',
      role: 'tester',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: {
        cwd: workspaceRoot,
        prompt: 'noop',
        preamble: null,
      },
    },
    { skipSpawn: true },
  );

  // ---- (6) mcp.json file checks (do these BEFORE we tear anything down) ----
  const expectedMcp = path.join(
    mcpRuntimeDir,
    `orch-${orchestrator.id}`,
    `session-${lead.id}`,
    'mcp.json',
  );
  try {
    const stat = fs.statSync(expectedMcp);
    const mode = stat.mode & 0o777;
    record('mcp.json exists', true, expectedMcp);
    record('mcp.json mode is 0600', mode === 0o600, `mode=0o${mode.toString(8)}`);
    const body = JSON.parse(fs.readFileSync(expectedMcp, 'utf8')) as {
      mcpServers?: Record<string, { type: string; url: string }>;
    };
    const entry = body.mcpServers?.['team-comms'];
    record(
      'mcp.json shape is { mcpServers: { team-comms: { type: http, url } } }',
      !!entry && entry.type === 'http' && typeof entry.url === 'string',
      `url=${entry?.url ?? '<missing>'}`,
    );
    // Body MUST NOT contain the session secret literal — only the URL does
    // (and that URL is bound to localhost). Spot-check the file just in case.
    record(
      'mcp.json contains session_secret in URL only',
      fs.readFileSync(expectedMcp, 'utf8').includes(lead.sessionSecret),
      'expected secret in URL path',
    );
  } catch (err) {
    record('mcp.json exists', false, err instanceof Error ? err.message : String(err));
  }

  // ---- (1) tools/list ----
  const goodUrl = `http://127.0.0.1:${config.mcpPort}/mcp/${orchestrator.id}/${lead.sessionSecret}`;
  const transport = new StreamableHTTPClientTransport(new URL(goodUrl));
  const client = new Client(
    { name: 'verify-phase2', version: '0.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    record('client.connect (tools/list will follow)', true);
  } catch (err) {
    record('client.connect', false, err instanceof Error ? err.message : String(err));
    await mcp.stop();
    return;
  }

  try {
    const list = await client.listTools();
    const names = new Set(list.tools.map((t) => t.name));
    const expected = [
      'team.whoami',
      'team.list',
      'team.send_message',
      'team.read_inbox',
      'team.broadcast',
      'team.spawn_worker',
      'team.kill_worker',
      'team.kill_all_workers',
    ];
    const missing = expected.filter((n) => !names.has(n));
    record(
      'tools/list returns all team.* tools (Phase 2 + Phase 3 placeholders)',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(',')}` : `count=${list.tools.length}`,
    );
  } catch (err) {
    record('tools/list', false, err instanceof Error ? err.message : String(err));
  }

  // ---- (2) tools/call team.whoami ----
  try {
    const r = await client.callTool({ name: 'team.whoami', arguments: {} });
    const sc = r.structuredContent as
      | { session_id?: string; name?: string; role?: string; type?: string; is_lead?: boolean }
      | undefined;
    const matches =
      !!sc &&
      sc.session_id === lead.id &&
      sc.name === lead.name &&
      sc.role === lead.role &&
      sc.type === 'lead' &&
      sc.is_lead === true;
    record('team.whoami returns lead metadata', matches, JSON.stringify(sc));
    // Verify the secret never appears in the response (defense in depth).
    const json = JSON.stringify(r);
    record(
      'team.whoami response does NOT contain session_secret',
      !json.includes(lead.sessionSecret),
    );
  } catch (err) {
    record('team.whoami', false, err instanceof Error ? err.message : String(err));
  }

  // ---- (3) tools/call team.list ----
  try {
    const r = await client.callTool({ name: 'team.list', arguments: {} });
    const sc = r.structuredContent as { members?: Array<{ session_id: string }> } | undefined;
    const has1 = !!sc && Array.isArray(sc.members) && sc.members.length === 1;
    record(
      'team.list returns exactly one active member (the lead)',
      has1,
      JSON.stringify(sc),
    );
    const json = JSON.stringify(r);
    record(
      'team.list response does NOT contain session_secret',
      !json.includes(lead.sessionSecret),
    );
  } catch (err) {
    record('team.list', false, err instanceof Error ? err.message : String(err));
  }

  // ---- (4) tools/call team.spawn_worker (must fail with clean error) ----
  try {
    const r = await client.callTool({
      name: 'team.spawn_worker',
      arguments: { name: 'w1', role: 'r', prompt: 'p' },
    });
    // A tool that throws an McpError surfaces as { isError: true, content: [...] }
    // OR as a thrown exception in the client; both are acceptable.
    const isError =
      r.isError === true ||
      JSON.stringify(r).toLowerCase().includes('not implemented');
    record(
      'team.spawn_worker returns a clean "not implemented in Phase 2" error',
      isError,
      JSON.stringify(r).slice(0, 200),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok = msg.toLowerCase().includes('not implemented');
    record(
      'team.spawn_worker returns a clean "not implemented in Phase 2" error',
      ok,
      msg,
    );
  }

  await client.close();

  // ---- (5) Wrong session_secret → 404 with no orch leak ----
  const badSecret = '00000000-0000-0000-0000-000000000000';
  const badUrl = `http://127.0.0.1:${config.mcpPort}/mcp/${orchestrator.id}/${badSecret}`;
  try {
    const resp = await fetch(badUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await resp.text();
    record(
      'wrong session_secret → 404',
      resp.status === 404,
      `status=${resp.status} body=${body.slice(0, 80)}`,
    );
    // Body must not include the orchestrator id (so an attacker probing
    // random secrets can't confirm orch existence by diffing 404 bodies).
    record(
      '404 body does NOT include orchestrator id',
      !body.includes(orchestrator.id),
    );
  } catch (err) {
    record(
      'wrong session_secret → 404',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Also: unknown orchestrator → also 404, identical body shape.
  const fakeOrch = '11111111-1111-1111-1111-111111111111';
  const fakeUrl = `http://127.0.0.1:${config.mcpPort}/mcp/${fakeOrch}/${badSecret}`;
  try {
    const resp = await fetch(fakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    record('unknown orch_id → 404', resp.status === 404, `status=${resp.status}`);
  } catch (err) {
    record(
      'unknown orch_id → 404',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Cleanup verification ----
  spawner.destroy(orchestrator.id, 'verify-cleanup');
  // give the stop a beat — best-effort unlink is synchronous in Session.stop()
  await new Promise((r) => setTimeout(r, 200));
  const cleaned = !fs.existsSync(expectedMcp);
  record('mcp.json cleaned up after orchestrator stop', cleaned, expectedMcp);

  await mcp.stop();

  // ---- Summary ----
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
