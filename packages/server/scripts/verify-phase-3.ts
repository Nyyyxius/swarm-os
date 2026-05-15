/**
 * Phase 3 verification script.
 *
 * Exercises the full team-comms workflow end-to-end without requiring a
 * real `claude` subprocess. Workers are spawned through the real
 * `Orchestrator.addWorker` path with `skipSpawn: true`, which:
 *
 *  - generates the per-session mcp.json on disk (so the MCP HTTP path is
 *    real, with real auth)
 *  - leaves `Session.agent` null, so `Session.notifySignal` writes the
 *    signal to the session log instead of a real PTY (still observable via
 *    `Mailbox.peek` and the log file).
 *
 * The script then drives the workflow through TWO clients connected to
 * the running MCP server: one as the lead, one as the worker. Each call
 * is the same Streamable HTTP contract claude itself uses.
 *
 * Run with: pnpm --filter server verify:phase3
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Spawner } from '../src/modules/spawner/index.js';
import { McpServer } from '../src/modules/mcp/server.js';
import { loadConfig, _resetConfigCacheForTesting } from '../src/config.js';
import { Mailbox } from '../src/modules/orchestrator/mailbox.js';
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

function dump(obj: unknown): string {
  try {
    return JSON.stringify(obj).slice(0, 250);
  } catch {
    return String(obj);
  }
}

async function makeClient(url: string, label: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: `verify-phase3-${label}`, version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-phase3-'));
  const dataDir = path.join(tmp, 'data');
  const workspaceRoot = path.join(tmp, 'workspace');
  const mcpRuntimeDir = path.join(tmp, 'mcp-runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });

  process.env.SWARM_OS_TOKEN = 'verify-phase3';
  process.env.SWARM_OS_DATA_DIR = dataDir;
  process.env.SWARM_OS_WORKSPACE_ROOT = workspaceRoot;
  process.env.SWARM_OS_MCP_RUNTIME_DIR = mcpRuntimeDir;
  // Drop the idle threshold to ~50 ms so the test doesn't have to wait
  // 2 s for every signal — production keeps the plan-default 2000 ms.
  process.env.SWARM_OS_IDLE_THRESHOLD_MS = '50';
  process.env.SWARM_OS_MCP_PORT = '18790';
  process.env.SWARM_OS_PORT = '18791';
  _resetConfigCacheForTesting();

  const config = loadConfig();
  const spawner = new Spawner(config);
  const mcp = new McpServer(spawner, config.mcpPort, config);
  await mcp.start();

  // ---- Bootstrap: orchestrator + lead via spawner.create ----
  const { orchestrator, lead } = spawner.create(
    {
      name: 'verify3',
      role: 'tester-lead',
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

  // The MCP URL the lead would dial — same path the claude PTY uses.
  const leadUrl = `http://127.0.0.1:${config.mcpPort}/mcp/${orchestrator.id}/${lead.sessionSecret}`;
  const leadClient = await makeClient(leadUrl, 'lead');

  // ---- (1) lead calls team.spawn_worker ----
  let workerId: string | null = null;
  let workerSecret: string | null = null;
  try {
    const r = await leadClient.callTool({
      name: 'team.spawn_worker',
      arguments: {
        name: 'scout',
        role: 'reconnaissance',
        prompt: 'Scout the workspace and report back.',
      },
    });
    const sc = r.structuredContent as
      | { session?: { id?: string; name?: string; type?: string } }
      | undefined;
    const okShape =
      !!sc && !!sc.session && sc.session.type === 'worker' && typeof sc.session.id === 'string';
    record('lead.spawn_worker returns a worker session', okShape, dump(sc));
    if (okShape && sc.session?.id) {
      workerId = sc.session.id;
      const workerSession = orchestrator.getSession(workerId);
      workerSecret = workerSession?.sessionSecret ?? null;
    }
  } catch (err) {
    record(
      'lead.spawn_worker returns a worker session',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!workerId || !workerSecret) {
    console.log('FATAL: worker not spawned — skipping remaining team workflow checks');
    await leadClient.close();
    await mcp.stop();
    process.exit(1);
  }

  const workerUrl = `http://127.0.0.1:${config.mcpPort}/mcp/${orchestrator.id}/${workerSecret}`;
  const workerClient = await makeClient(workerUrl, 'worker');

  // ---- (2) lead → worker: send_message + worker reads inbox ----
  try {
    const send = await leadClient.callTool({
      name: 'team.send_message',
      arguments: { to: workerId, content: 'hello scout, please report.' },
    });
    const sc = send.structuredContent as
      | { delivered?: boolean; queue_size?: number; dropped?: boolean }
      | undefined;
    record(
      'lead.send_message returns delivered=true, queue_size>=1',
      sc?.delivered === true && (sc.queue_size ?? 0) >= 1 && sc.dropped === false,
      dump(sc),
    );
  } catch (err) {
    record(
      'lead.send_message',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Worker reads inbox — should get the message and clear the queue.
  try {
    const read = await workerClient.callTool({
      name: 'team.read_inbox',
      arguments: {},
    });
    const sc = read.structuredContent as
      | { messages?: Array<{ id?: string; from?: string; content?: string }> }
      | undefined;
    const msgs = sc?.messages ?? [];
    const matches =
      msgs.length === 1 &&
      msgs[0]?.from === lead.id &&
      msgs[0]?.content === 'hello scout, please report.';
    record('worker.read_inbox returns the lead message', matches, dump(sc));
  } catch (err) {
    record(
      'worker.read_inbox',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Second read should be empty (queue was drained).
  try {
    const read2 = await workerClient.callTool({
      name: 'team.read_inbox',
      arguments: {},
    });
    const sc = read2.structuredContent as { messages?: unknown[] } | undefined;
    record(
      'second worker.read_inbox returns empty (queue was drained)',
      Array.isArray(sc?.messages) && sc.messages.length === 0,
      dump(sc),
    );
  } catch (err) {
    record(
      'second worker.read_inbox returns empty',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- (3) worker → lead: send_message ----
  try {
    const send = await workerClient.callTool({
      name: 'team.send_message',
      arguments: { to: lead.id, content: 'reporting in: workspace empty.' },
    });
    const sc = send.structuredContent as { delivered?: boolean } | undefined;
    record('worker.send_message returns delivered=true', sc?.delivered === true, dump(sc));
  } catch (err) {
    record(
      'worker.send_message',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const read = await leadClient.callTool({
      name: 'team.read_inbox',
      arguments: {},
    });
    const sc = read.structuredContent as
      | { messages?: Array<{ from?: string; content?: string }> }
      | undefined;
    const msgs = sc?.messages ?? [];
    const matches =
      msgs.length === 1 &&
      msgs[0]?.from === workerId &&
      msgs[0]?.content === 'reporting in: workspace empty.';
    record('lead.read_inbox returns the worker reply', matches, dump(sc));
  } catch (err) {
    record(
      'lead.read_inbox',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- (4) lead.broadcast lands in worker inbox ----
  try {
    const bc = await leadClient.callTool({
      name: 'team.broadcast',
      arguments: { content: 'team-wide announcement' },
    });
    const sc = bc.structuredContent as { delivered_to?: string[] } | undefined;
    const matches =
      Array.isArray(sc?.delivered_to) &&
      sc.delivered_to.length === 1 &&
      sc.delivered_to[0] === workerId;
    record(
      'lead.broadcast returns delivered_to with the single worker',
      matches,
      dump(sc),
    );
  } catch (err) {
    record(
      'lead.broadcast',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Verify the broadcast actually landed (peek without consuming).
  {
    const peeked = orchestrator.mailbox.peek(workerId);
    const matches =
      peeked.length === 1 &&
      peeked[0]?.from === lead.id &&
      peeked[0]?.content === 'team-wide announcement';
    record('worker mailbox holds the broadcast (peek)', matches, dump(peeked));
  }

  // ---- (5) Permission denied: worker tries spawn_worker ----
  try {
    const r = await workerClient.callTool({
      name: 'team.spawn_worker',
      arguments: { name: 'rogue', role: 'r', prompt: 'p' },
    });
    // Either isError:true with PERMISSION_DENIED, or thrown McpError below.
    const json = JSON.stringify(r);
    const denied = r.isError === true && json.includes('PERMISSION_DENIED');
    record(
      'worker.spawn_worker returns PERMISSION_DENIED (lead-only)',
      denied,
      json.slice(0, 200),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(
      'worker.spawn_worker returns PERMISSION_DENIED (lead-only)',
      msg.includes('PERMISSION_DENIED'),
      msg,
    );
  }

  // ---- (6) lead.kill_worker → worker dies, mailbox cleaned ----
  // Push some pending mail to the worker first so we can verify the cleanup.
  orchestrator.mailbox.push(workerId, { from: 'system', content: 'pre-kill stash' });
  try {
    const r = await leadClient.callTool({
      name: 'team.kill_worker',
      arguments: { id: workerId },
    });
    const sc = r.structuredContent as { killed?: boolean } | undefined;
    record('lead.kill_worker returns killed=true', sc?.killed === true, dump(sc));
  } catch (err) {
    record(
      'lead.kill_worker',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Wait for the SIGTERM grace flow + setImmediate exit to settle.
  await new Promise((r) => setTimeout(r, 50));

  {
    const session = orchestrator.getSession(workerId);
    const status = session?.status;
    record(
      'worker session is now killed/exited',
      status === 'killed' || status === 'exited' || status === 'failed',
      `status=${status}`,
    );
    record(
      'worker mailbox cleaned after kill',
      orchestrator.mailbox.peek(workerId).length === 0,
    );
  }

  // ---- (7) lead.kill_worker on unknown id → killed:false (idempotent) ----
  try {
    const r = await leadClient.callTool({
      name: 'team.kill_worker',
      arguments: { id: '00000000-0000-0000-0000-000000000000' },
    });
    const sc = r.structuredContent as { killed?: boolean } | undefined;
    record(
      'lead.kill_worker on unknown id returns killed=false (idempotent)',
      sc?.killed === false,
      dump(sc),
    );
  } catch (err) {
    record(
      'lead.kill_worker idempotency',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- (8) Mailbox bounded test — 105 pushes drop oldest 5 ----
  const cappedSid = lead.id;
  // Read the lead inbox first to start clean.
  orchestrator.mailbox.read(cappedSid);
  const cap = config.maxInboxSize;
  let lastWarn = 0;
  // Phase 4: pino is configured to write through process.stdout (logger.ts
  // passes it explicitly), so a process.stdout.write spy catches the
  // structured warnings.
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('"event":"mail.dropped"')) lastWarn++;
    return originalWrite(chunk as string, ...(rest as []));
  }) as typeof process.stdout.write;
  try {
    for (let i = 0; i < cap + 5; i++) {
      orchestrator.mailbox.push(cappedSid, { from: 'system', content: `m${i}` });
    }
    await new Promise((r) => setTimeout(r, 50));
    const peeked = orchestrator.mailbox.peek(cappedSid);
    record(
      `mailbox bounded at ${cap}: pushing ${cap + 5} keeps exactly ${cap}`,
      peeked.length === cap,
      `length=${peeked.length}`,
    );
    // The 5 oldest should be dropped → first message should be `m5`.
    const oldestKept = peeked[0]?.content;
    record(
      'mailbox drops the OLDEST messages (first kept is m5)',
      oldestKept === 'm5',
      `first.content=${oldestKept}`,
    );
    record(
      'mailbox drop emits a warning per drop',
      lastWarn === 5,
      `warnings observed=${lastWarn}`,
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  // ---- (9) message size cap ----
  try {
    const big = 'x'.repeat(config.maxMessageSizeBytes + 1);
    const r = await leadClient.callTool({
      name: 'team.send_message',
      arguments: { to: lead.id, content: big },
    });
    const json = JSON.stringify(r);
    const denied = r.isError === true && json.includes('MESSAGE_TOO_LARGE');
    record(
      'lead.send_message rejects content over the size cap',
      denied,
      json.slice(0, 150),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(
      'lead.send_message rejects content over the size cap',
      msg.includes('MESSAGE_TOO_LARGE'),
      msg,
    );
  }

  // ---- (10) worker exit anomaly → synthetic message to the lead ----
  // Spawn a fresh worker (with no claude PTY) and simulate a crash by
  // calling Session.stop() with `_stopRequested=false` ... but stop()
  // sets _stopRequested=true. So instead we drive the path via a fake
  // AgentProcess attached to the worker's session — simpler.
  //
  // Simpler still: directly invoke `Orchestrator['_onWorkerExit']` on a
  // freshly spawned, manually-failed worker. We can do this via a helper
  // that just verifies the public observable: "a system message lands in
  // the lead's inbox after a worker exits abnormally".
  const FakeAgentMod = await import('../src/modules/orchestrator/agent-process.js');
  const fakeAgent = new FakeAgentMod.FakeAgentProcess({
    command: 'fake',
    args: [],
    cwd: workspaceRoot,
  });
  const crashWorker = orchestrator.addWorker({
    name: 'crasher',
    role: 'unstable',
    prompt: 'pretend to crash',
    cwd: workspaceRoot,
    agentProcessOverride: fakeAgent as never,
  });
  // Simulate some output, then a non-zero exit (NOT triggered by stop()).
  fakeAgent._emitData('about to crash');
  fakeAgent._simulateExit({ exitCode: 99, signal: undefined });
  // Allow the setImmediate scheduling chain to settle.
  await new Promise((r) => setTimeout(r, 50));
  {
    const leadInbox = orchestrator.mailbox.peek(lead.id);
    const synthetic = leadInbox.find(
      (m) => m.from === 'system' && m.content.includes(crashWorker.id),
    );
    record(
      'abnormal worker exit pushes a system message to the lead',
      !!synthetic,
      synthetic ? synthetic.content.slice(0, 120) : '<missing>',
    );
    record(
      'system message contains exit_code=99',
      !!synthetic && synthetic.content.includes('exit_code=99'),
    );
  }

  // ---- (11) Mailbox unit checks: removeSession + clear semantics ----
  {
    const m = new Mailbox({ maxSize: 3 });
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    const before = m.size('a');
    m.removeSession('a');
    const after = m.size('a');
    record(
      'Mailbox.removeSession wipes the queue',
      before === 2 && after === 0,
      `before=${before} after=${after}`,
    );
  }

  // ---- (12) REST broadcast endpoint: human → all sessions ----
  // Spin up a dedicated HTTP server quickly via createApp.
  const httpMod = await import('../src/http/main.js');
  const { app } = httpMod.createApp(config, spawner);
  // We hit the express app via a real listener on an ephemeral port.
  const httpModNode = await import('node:http');
  const httpSrv = httpModNode.createServer(app);
  await new Promise<void>((resolve) => httpSrv.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpSrv.address();
  const httpPort = addr && typeof addr === 'object' ? addr.port : 0;
  // Drain the lead's inbox first so we count cleanly.
  orchestrator.mailbox.read(lead.id);
  try {
    const resp = await fetch(`http://127.0.0.1:${httpPort}/orchestrators/${orchestrator.id}/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': config.token,
      },
      body: JSON.stringify({ content: 'hello team from the human' }),
    });
    const body = (await resp.json()) as { delivered_to?: string[] };
    // Lead is the only active session at this point (worker was killed,
    // crasher exited). Delivery should target [lead.id].
    record(
      'POST /orchestrators/:id/broadcast (human) returns delivered_to:[lead]',
      resp.status === 200 &&
        Array.isArray(body.delivered_to) &&
        body.delivered_to.length === 1 &&
        body.delivered_to[0] === lead.id,
      `status=${resp.status} body=${dump(body)}`,
    );
    const leadInbox = orchestrator.mailbox.peek(lead.id);
    const fromHuman = leadInbox.find(
      (m) => m.from === 'human' && m.content === 'hello team from the human',
    );
    record('lead inbox contains the human broadcast', !!fromHuman);
  } catch (err) {
    record(
      'POST /orchestrators/:id/broadcast',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  // GET inbox peek endpoint
  try {
    const resp = await fetch(
      `http://127.0.0.1:${httpPort}/orchestrators/${orchestrator.id}/sessions/${lead.id}/inbox`,
      { headers: { 'X-Auth-Token': config.token } },
    );
    const body = (await resp.json()) as { count?: number; messages?: unknown[] };
    record(
      'GET /orchestrators/:id/sessions/:sid/inbox returns count + messages',
      resp.status === 200 &&
        typeof body.count === 'number' &&
        Array.isArray(body.messages) &&
        body.count === body.messages.length,
      `status=${resp.status} body=${dump(body)}`,
    );
  } catch (err) {
    record(
      'GET inbox peek',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  await new Promise<void>((resolve) => httpSrv.close(() => resolve()));

  // ---- Cleanup ----
  await leadClient.close();
  await workerClient.close();
  spawner.shutdownAll('verify-cleanup');
  await new Promise((r) => setTimeout(r, 100));
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
