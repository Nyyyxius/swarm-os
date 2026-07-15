/**
 * J2 — dynamic plugin MCP tools end-to-end.
 *
 * Enables the example `echo` plugin, then over a real MCP client asserts:
 *  - `tools/list` contains `echo.ping` once enabled, and is gone after disable;
 *  - `echo.ping` runs and returns the plugin's payload;
 *  - a plugin tool that THROWS yields a clean MCP error result — the loopback
 *    MCP server never crashes (a subsequent built-in call still works).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ECHO_SRC = path.resolve(HERE, '../../../../examples/plugins/echo');

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
  // Drop the real example echo plugin under <dataDir>/plugins.
  const dest = path.join(stack.pluginsDir, 'echo');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ECHO_SRC, 'plugin.json'), path.join(dest, 'plugin.json'));
  fs.copyFileSync(path.join(ECHO_SRC, 'index.js'), path.join(dest, 'index.js'));
});

afterEach(async () => {
  await stack.teardown();
});

function base(): string {
  return `http://127.0.0.1:${stack.mainPort}`;
}

async function scanEnable(name: string): Promise<void> {
  await fetch(`${base()}/plugins/scan`, { method: 'POST', headers: authHeaders(stack.config.token) });
  const res = await fetch(`${base()}/plugins/${name}/enable`, {
    method: 'POST',
    headers: authHeaders(stack.config.token),
    body: JSON.stringify({}),
  });
  if (res.status !== 200) {
    throw new Error(`enable ${name} failed: ${res.status} ${await res.text()}`);
  }
}

function createOrch(name: string) {
  const { orchestrator, lead } = stack.spawner.create(
    {
      name,
      role: 'coordinator',
      defaultModel: stack.config.defaultModel,
      defaultEffort: stack.config.defaultEffort,
      defaultPermissionMode: stack.config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: true },
  );
  return { orchestratorId: orchestrator.id, leadSecret: lead.sessionSecret, leadName: lead.name };
}

async function makeClient(orchId: string, secret: string): Promise<Client> {
  const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`;
  const t = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await c.connect(t);
  return c;
}

/** Write an inline fixture plugin whose single tool always throws. */
function writeBoomer(): void {
  const dir = path.join(stack.pluginsDir, 'boomer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'boomer',
      version: '0.1.0',
      main: 'index.js',
      apiVersion: 1,
      capabilities: ['mcp-tools'],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    [
      'export default {',
      '  activate(api) {',
      '    api.mcp.registerTool({',
      "      name: 'boom',",
      "      title: 'Boom',",
      "      description: 'Always throws.',",
      '      leadOnly: false,',
      '      inputSchema: {},',
      "      handler: () => { throw new Error('kaboom'); },",
      '    });',
      '  },',
      '};',
    ].join('\n'),
  );
}

describe('J2 plugin MCP tools', () => {
  it('echo.ping appears in tools/list, runs, then disappears after disable', async () => {
    await scanEnable('echo');
    const a = createOrch('alpha');
    const lead = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const list = await lead.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('echo.ping');
      expect(names).toContain('team.whoami'); // built-ins still present

      const res = await lead.callTool({ name: 'echo.ping', arguments: { message: 'hi' } });
      const out = res.structuredContent as { reply: string; caller: string; is_lead: boolean };
      expect(out.reply).toBe('pong: hi');
      expect(out.caller).toBe(a.leadName);
      expect(out.is_lead).toBe(true);
    } finally {
      await lead.close();
    }

    // Disable → the tool is gone on the next MCP request.
    const dis = await fetch(`${base()}/plugins/echo/disable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(dis.status).toBe(200);

    const lead2 = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const list2 = await lead2.listTools();
      expect(list2.tools.map((t) => t.name)).not.toContain('echo.ping');
    } finally {
      await lead2.close();
    }
  });

  it('a throwing plugin tool yields a clean MCP error, server stays up', async () => {
    writeBoomer();
    await scanEnable('boomer');
    const a = createOrch('bravo');
    const lead = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await lead.callTool({ name: 'boomer.boom', arguments: {} });
      // Clean error result — not a thrown transport failure.
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain('PLUGIN_ERROR');

      // The loopback MCP server is still alive: a built-in call still works.
      const who = await lead.callTool({ name: 'team.whoami', arguments: {} });
      const payload = who.structuredContent as { is_lead: boolean };
      expect(payload.is_lead).toBe(true);
    } finally {
      await lead.close();
    }
  });
});
