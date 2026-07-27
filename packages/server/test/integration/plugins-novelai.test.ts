/**
 * `novelai` example plugin — end-to-end over the real plugin host, the real MCP
 * transport and the real HTTP stack.
 *
 * The plugin is dropped verbatim under `<dataDir>/plugins/novelai` (same shape
 * as a `cp -r` into the `/data/plugins` bind mount, which is the documented
 * install path), then scanned / configured / enabled through the REST surface.
 * NovelAI itself is the only thing faked.
 *
 * What each case is here to prove:
 *  1. install + enable — the manifest, the configSchema and `activate()` agree;
 *  2. `novelai.generate_text` / `novelai.generate_voice` reach an agent's
 *     `tools/list`, and leave it on disable;
 *  3. text generation returns prose inline;
 *  4. voice generation writes a REAL file where the returned path says it does,
 *     with the `.gitignore` that keeps generated audio out of the bind-mounted
 *     Git repo;
 *  5. a 401 from NovelAI surfaces as `code:'unauthorized'` and does NOT
 *     quarantine the plugin — the end-to-end proof of "an MCP handler never
 *     throws" (`packages/server/src/modules/plugins/host.ts:61-62`);
 *  6. a PARTIAL capability grant (`mcp-tools` only) still exposes both tools —
 *     `api.http.registerRouter` / `api.schedule.cron` call `requireCap`, which
 *     THROWS (`.../plugins/api.ts:152-156` and `:561`), so a missing DIAGNOSTIC
 *     capability must never take down the plugin's reason to exist;
 *  7. `GET /plugin-api/novelai/status` answers without ever echoing the token;
 *  8. `GET /plugins/novelai` masks `apiToken` behind the password sentinel.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP, documented so nobody rediscovers it the hard way:
 *
 * A plugin runs IN-PROCESS (loader.ts imports it into this very worker), so
 * `vi.stubGlobal('fetch', …)` does reach `lib/nai.js` — but it equally reaches
 * every HTTP call this test file makes to its own server, and the MCP client
 * transport, which are all built on the same global `fetch`. A stub that
 * answers everything makes the whole stack unreachable and the failure looks
 * like a broken server, not a broken stub.
 *
 * Hence: capture the real `fetch` BEFORE stubbing, and DELEGATE everything that
 * is not a `novelai.net` URL back to it. The stub is a router, not a wall.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { PASSWORD_SENTINEL } from '../../src/modules/plugins/config-schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOVELAI_SRC = path.resolve(HERE, '../../../../examples/plugins/novelai');

/**
 * The NovelAI token the operator "types" in the config form. Note that the test
 * stack's own auth token happens to carry the same literal (helpers.ts sets
 * `SWARM_OS_TOKEN=test-token`), which only makes the leak assertions STRICTER:
 * a payload containing this string is a leak either way.
 */
const API_TOKEN = 'test-token';

/** 64 bytes of plausible OGG/Opus — enough to assert on `bytes` and the ext. */
const AUDIO = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 0x42)]);

/** A plausible `GET /user/subscription` body. Deliberately token-free. */
const SUBSCRIPTION_BODY = JSON.stringify({
  tier: 3,
  active: true,
  expiresAt: 4102444800,
  perks: { maxPriorityActions: 1000, unlimitedMaxPriority: true },
  trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 },
});

/**
 * Per-test upstream scenario. Mutated by a test BEFORE it calls a tool; reset
 * to the nominal values in `beforeEach` so no case can inherit another's 401.
 */
interface Scenario {
  textStatus: number;
  textBody: string;
  /** The OpenAI-compatible surface — xialong-v1 / glm-4-6 live only there. */
  oaStatus: number;
  oaBody: string;
  voiceStatus: number;
  voiceBody: Buffer;
  voiceContentType: string;
  subscriptionStatus: number;
  subscriptionBody: string;
}

function nominalScenario(): Scenario {
  return {
    textStatus: 200,
    textBody: JSON.stringify({ output: 'once upon a time' }),
    oaStatus: 200,
    oaBody: JSON.stringify({ choices: [{ text: 'once upon an OA time' }] }),
    voiceStatus: 200,
    voiceBody: AUDIO,
    voiceContentType: 'audio/ogg',
    subscriptionStatus: 200,
    subscriptionBody: SUBSCRIPTION_BODY,
  };
}

let scenario: Scenario = nominalScenario();
/** Every upstream URL the plugin asked for — proves the two-host split. */
let naiCalls: string[] = [];
/**
 * Every upstream request BODY, in the same order. The prompt the plugin builds
 * out of `story`/`memory`/`authors_note` is not observable any other way: the
 * tool result carries the generated prose, not the context that produced it,
 * and the placement of the author's note IS the feature.
 */
let naiBodies: string[] = [];

let stack: TestStack;

// See the header: the REAL fetch has to be captured before the stub exists.
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      // Anything that is not NovelAI (this test's own REST calls, the MCP
      // transport, …) MUST go to the network for real.
      if (!url.includes('novelai.net')) {
        return realFetch(input as never, init as never);
      }
      naiCalls.push(url);
      const reqBody = (init as { body?: unknown } | undefined)?.body;
      naiBodies.push(typeof reqBody === 'string' ? reqBody : '');
      // Routed per endpoint on purpose: text and TTS live on DIFFERENT hosts
      // (text.novelai.net vs api.novelai.net) and a single-host stub would hide
      // a regression in that split. The /oa/v1 routes are a THIRD split, on the
      // text host: they serve a disjoint set of models.
      if (url.startsWith('https://text.novelai.net/oa/v1/models')) {
        return new Response(
          JSON.stringify({ object: 'list', data: [{ id: 'glm-4-6' }, { id: 'xialong-v1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://text.novelai.net/oa/v1/completions')) {
        return new Response(scenario.oaBody, {
          status: scenario.oaStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://text.novelai.net/ai/generate')) {
        return new Response(scenario.textBody, {
          status: scenario.textStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.novelai.net/ai/generate-voice')) {
        return new Response(scenario.voiceBody, {
          status: scenario.voiceStatus,
          headers: { 'content-type': scenario.voiceContentType },
        });
      }
      if (url.startsWith('https://api.novelai.net/user/subscription')) {
        return new Response(scenario.subscriptionBody, {
          status: scenario.subscriptionStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: `unexpected endpoint ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  scenario = nominalScenario();
  naiCalls = [];
  naiBodies = [];
  stack = await bootTestStack();
  // Whole-directory copy: a plugin is delivered verbatim, and the manifest,
  // index.js and lib/ have to travel together.
  fs.cpSync(NOVELAI_SRC, path.join(stack.pluginsDir, 'novelai'), { recursive: true });
});

afterEach(async () => {
  await stack.teardown();
});

function base(): string {
  return `http://127.0.0.1:${stack.mainPort}`;
}

function headers(): Record<string, string> {
  return authHeaders(stack.config.token);
}

async function scan(): Promise<void> {
  const res = await fetch(`${base()}/plugins/scan`, { method: 'POST', headers: headers() });
  expect(res.status).toBe(200);
}

async function putConfig(config: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base()}/plugins/novelai/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(config),
  });
  expect(res.status).toBe(200);
}

async function putPermissions(caps: string[]): Promise<void> {
  const res = await fetch(`${base()}/plugins/novelai/permissions`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ grantedCapabilities: caps }),
  });
  expect(res.status).toBe(200);
}

interface PluginView {
  status: string;
  enabled: boolean;
  failCount: number;
  lastError: string | null;
  quarantinedUntil: string | null;
  grantedCapabilities: string[] | null;
}

async function enable(): Promise<PluginView> {
  const res = await fetch(`${base()}/plugins/novelai/enable`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({}),
  });
  const body = (await res.json()) as { plugin?: PluginView; error?: string };
  if (res.status !== 200) {
    throw new Error(`enable novelai failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.plugin as PluginView;
}

/** scan → config → enable, the operator's happy path. */
async function install(): Promise<PluginView> {
  await scan();
  await putConfig({ apiToken: API_TOKEN });
  return enable();
}

async function getPlugin(): Promise<{ plugin: PluginView; config: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${base()}/plugins/novelai`, { headers: headers() });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const body = JSON.parse(raw) as { plugin: PluginView; config: Record<string, unknown> };
  return { plugin: body.plugin, config: body.config, raw };
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
  return { orchestratorId: orchestrator.id, leadSecret: lead.sessionSecret };
}

async function makeClient(orchId: string, secret: string): Promise<Client> {
  const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`;
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'novelai-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Open a client, run `fn`, always close. */
async function withLead<T>(name: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const orch = createOrch(name);
  const client = await makeClient(orch.orchestratorId, orch.leadSecret);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function toolNames(client: Client): Promise<string[]> {
  const list = await client.listTools();
  return list.tools.map((t) => t.name);
}

interface ToolResult {
  ok: boolean;
  code?: string;
  error?: string;
  text?: string;
  files?: Array<{
    path: string;
    workspace_relative: string;
    container_path: string;
    bytes: number;
    chars: number;
  }>;
  [k: string]: unknown;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  // An `McpError` (opaque to the agent) would show up as `isError` here — the
  // plugin's outputSchema discipline is what keeps this false.
  expect(res.isError ?? false).toBe(false);
  return res.structuredContent as ToolResult;
}

describe('novelai plugin — install & configuration', () => {
  it('1. scan → config → enable leaves the plugin enabled, clean and un-quarantined', async () => {
    await scan();
    const discovered = await getPlugin();
    expect(discovered.plugin.status).toBe('disabled');

    await putConfig({ apiToken: API_TOKEN });
    const view = await enable();

    expect(view.status).toBe('enabled');
    expect(view.enabled).toBe(true);
    expect(view.failCount).toBe(0);
    expect(view.lastError).toBeNull();
    expect(view.quarantinedUntil).toBeNull();
    // The manifest's five capabilities were granted wholesale (no explicit
    // `grantedCapabilities` in the enable body → the scan-time default).
    expect(view.grantedCapabilities).toEqual(
      expect.arrayContaining(['mcp-tools', 'db-kv', 'http-routes', 'notify', 'schedule']),
    );
  });

  it('8. GET /plugins/novelai masks apiToken behind the sentinel and never leaks it', async () => {
    await install();
    const { config, raw } = await getPlugin();

    expect(config.apiToken).toBe(PASSWORD_SENTINEL);
    // The whole serialised payload — manifest, view and config — must be clean.
    expect(raw).not.toContain(API_TOKEN);
  });
});

describe('novelai plugin — MCP tools', () => {
  it('2. both tools reach tools/list, and are gone after disable', async () => {
    await install();

    const names = await withLead('alpha', toolNames);
    expect(names).toContain('novelai.generate_text');
    expect(names).toContain('novelai.generate_voice');
    expect(names).toContain('team.whoami'); // built-ins are untouched

    const dis = await fetch(`${base()}/plugins/novelai/disable`, {
      method: 'POST',
      headers: headers(),
    });
    expect(dis.status).toBe(200);

    const after = await withLead('alpha-2', toolNames);
    expect(after).not.toContain('novelai.generate_text');
    expect(after).not.toContain('novelai.generate_voice');
  });

  it('3. generate_text returns the prose inline, from the TEXT host', async () => {
    await install();

    const out = await withLead('bravo', (c) =>
      callTool(c, 'novelai.generate_text', { prompt: 'The wizard raised his staff and' }),
    );

    expect(out.ok).toBe(true);
    expect(typeof out.text).toBe('string');
    expect((out.text ?? '').length).toBeGreaterThan(0);
    expect(out.text).toBe('once upon a time');
    expect(out.model).toBe('llama-3-erato-v1');
    // Text generation lives on text.novelai.net, NOT api.novelai.net.
    expect(naiCalls).toContain('https://text.novelai.net/ai/generate');
  });

  it('3b. the structured mode assembles the context, note included, near the end', async () => {
    await install();

    const out = await withLead('bravo-2', (c) =>
      callTool(c, 'novelai.generate_text', {
        memory: 'MEMOIRE_TEST: Elara est archiviste.',
        story: 'Elle referma le registre.\n\nLa cire etait tiede.\n\nNeuf jours, disait le pli.',
        authors_note: 'NOTE_TEST',
        attg: 'Genre: fantasy',
        opening: 'Elle leva les yeux et',
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.prompt_chars).toBeGreaterThan(0);

    // The context the plugin actually built — the whole point of the feature.
    const sent = JSON.parse(naiBodies[0]!) as { input: string };
    const iMemory = sent.input.indexOf('MEMOIRE_TEST');
    const iNote = sent.input.indexOf('NOTE_TEST');
    const iOpening = sent.input.indexOf('Elle leva les yeux et');
    expect(iMemory).toBeGreaterThanOrEqual(0);
    expect(iMemory).toBeLessThan(iNote); // memory on top, note far below it
    expect(iNote).toBeLessThan(iOpening); // note before the lead-in
    expect(sent.input.endsWith('Elle leva les yeux et')).toBe(true);
    // Well-formed input earns no lecture.
    expect(out.warnings).toBeUndefined();
  });

  it('3b-bis. the English rule reaches the agent, and a French context is flagged', async () => {
    await install();

    const { schema, fr, en } = await withLead('bravo-en', async (c) => ({
      schema: (await c.listTools()).tools.find((t) => t.name === 'novelai.generate_text'),
      // Same scene, twice, differing only in language.
      fr: await callTool(c, 'novelai.generate_text', {
        memory: "Elara est archiviste au palais d'Ostvale. Le roi est mourant.",
        story: 'Elle referma le registre.\n\nLa cire etait tiede.\n\nNeuf jours.',
        authors_note: 'Elara confronte le messager.',
        opening: 'Elle leva les yeux et',
      }),
      en: await callTool(c, 'novelai.generate_text', {
        memory: 'Elara is an archivist at the palace of Ostvale. The king is dying.',
        story: 'She closed the register.\n\nThe wax was still warm.\n\nNine days.',
        authors_note: 'Elara confronts the messenger about his accent.',
        opening: 'She looked up at the messenger and',
      }),
    }));

    // The rule has to be READABLE before the first call, not only after a bad one.
    expect(schema?.description).toMatch(/ANGLAIS/);
    const props = schema?.inputSchema.properties as Record<string, { description?: string }>;
    for (const field of ['story', 'memory', 'authors_note', 'opening']) {
      expect(props[field]?.description, field).toMatch(/ANGLAIS/i);
    }

    // Degrading, never failing: a French context still generates.
    expect(fr.ok).toBe(true);
    expect((fr.warnings ?? []).join(' ')).toMatch(/anglais/i);

    expect(en.ok).toBe(true);
    expect(en.warnings).toBeUndefined();
  });

  it('3c. mixing `prompt` with the structured fields is refused, not arbitrated', async () => {
    await install();

    const out = await withLead('bravo-3', (c) =>
      callTool(c, 'novelai.generate_text', { prompt: 'x', authors_note: 'y' }),
    );

    expect(out.ok).toBe(false);
    expect(out.code).toBe('bad_request');
    expect(naiCalls).toHaveLength(0); // refused before any upstream call
  });

  it('3d. a model of the OpenAI-compatible family is routed to /oa/v1/completions', async () => {
    await install();

    const out = await withLead('bravo-4', (c) =>
      callTool(c, 'novelai.generate_text', { prompt: 'x', model: 'xialong-v1' }),
    );

    expect(out.ok).toBe(true);
    expect(out.text).toBe('once upon an OA time');
    expect(naiCalls).toContain('https://text.novelai.net/oa/v1/completions');
    expect(naiCalls).not.toContain('https://text.novelai.net/ai/generate');
    // OpenAI parameter names on the wire, not NovelAI's.
    const sent = JSON.parse(naiBodies[0]!) as Record<string, unknown>;
    expect(sent.prompt).toBe('x');
    expect(sent.input).toBeUndefined();
  });

  it('3e. writing_guide ships the method to the agent without a network call', async () => {
    await install();

    const { names, guide } = await withLead('bravo-5', async (c) => ({
      names: await toolNames(c),
      guide: await callTool(c, 'novelai.writing_guide', {}),
    }));

    expect(names).toContain('novelai.writing_guide');
    expect(guide.ok).toBe(true);
    expect(typeof guide.guide).toBe('string');
    // The real GUIDE.md, not the inline fallback.
    expect(guide.guide).toContain('authors_note');
    expect(guide.guide).toContain('Les quatre erreurs');
    expect(naiCalls).toHaveLength(0);
  });

  it('4. generate_voice writes a real file where it says it does', async () => {
    await install();

    const out = await withLead('charlie', (c) =>
      callTool(c, 'novelai.generate_voice', { text: 'Bonjour, ceci est un test.' }),
    );

    expect(out.ok).toBe(true);
    expect(out.files).toHaveLength(1);
    const file = out.files![0];

    // Layout: <workspaceRoot>/novelai/<YYYY-MM-DD>/<HHMMSS>-<slug>-<rand4>-<i>.ogg
    const dayDir = path.dirname(file.container_path);
    expect(path.dirname(dayDir)).toBe(path.join(stack.workspaceRoot, 'novelai'));
    expect(path.basename(dayDir)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Extension deduced from the response's content-type, not from the format.
    expect(path.basename(file.container_path)).toMatch(/^\d{6}-.+-[0-9a-f]{4}-0\.ogg$/);

    // THE point of this case: the file is really there, with the announced size.
    expect(fs.existsSync(file.container_path)).toBe(true);
    expect(fs.readFileSync(file.container_path).length).toBe(AUDIO.length);
    expect(file.bytes).toBe(AUDIO.length);

    // Under the local transport `toAgentPath` is the identity, so the path the
    // agent is handed IS the container path. (Under ssh they legitimately
    // differ — that is why the plugin returns all three forms.)
    expect(file.path).toBe(file.container_path);
    expect(file.workspace_relative).toBe(
      path.relative(stack.workspaceRoot, file.container_path),
    );

    // The workspace is a bind-mounted Git repo where agents run `git add .`.
    expect(fs.existsSync(path.join(stack.workspaceRoot, 'novelai', '.gitignore'))).toBe(true);
    expect(fs.readFileSync(path.join(stack.workspaceRoot, 'novelai', '.gitignore'), 'utf8')).toContain('*');
    expect(fs.existsSync(path.join(dayDir, '.gitignore'))).toBe(true);

    // TTS lives on api.novelai.net — the other host of the pair.
    expect(naiCalls.some((u) => u.startsWith('https://api.novelai.net/ai/generate-voice'))).toBe(true);
  });

  it('5. a 401 upstream is a VALUE, not a crash: no quarantine, tools stay up', async () => {
    await install();
    scenario.textStatus = 401;
    scenario.textBody = JSON.stringify({ statusCode: 401, message: 'Invalid accessToken.' });

    await withLead('delta', async (client) => {
      // SIX consecutive failures — one more than CRASH_LIMIT (5 crashes / 60 s,
      // host.ts:61-62). Had the handler thrown, the host would have auto-
      // disabled the plugin and set a quarantine window by now.
      for (let i = 0; i < 6; i += 1) {
        const out = await callTool(client, 'novelai.generate_text', { prompt: 'x' });
        expect(out.ok).toBe(false);
        expect(out.code).toBe('unauthorized');
        expect(typeof out.error).toBe('string');
      }

      // Still registered, from the agent's own point of view.
      const names = await toolNames(client);
      expect(names).toContain('novelai.generate_text');
      expect(names).toContain('novelai.generate_voice');
    });

    const { plugin } = await getPlugin();
    expect(plugin.status).toBe('enabled');
    expect(plugin.enabled).toBe(true);
    expect(plugin.failCount).toBe(0);
    expect(plugin.lastError).toBeNull();
    expect(plugin.quarantinedUntil).toBeNull();
  });

  it('6. a PARTIAL grant (mcp-tools only) still exposes both tools', async () => {
    await scan();
    await putConfig({ apiToken: API_TOKEN });
    // No `http-routes`, no `schedule`, no `db-kv`, no `notify`: every optional
    // capability the plugin touches is withheld at once.
    await putPermissions(['mcp-tools']);

    const view = await enable();
    expect(view.status).toBe('enabled');
    expect(view.enabled).toBe(true);
    expect(view.grantedCapabilities).toEqual(['mcp-tools']);

    const names = await withLead('echo-team', toolNames);
    expect(names).toContain('novelai.generate_text');
    expect(names).toContain('novelai.generate_voice');

    // And the withheld capability really was withheld: no /status router was
    // mounted, so the dispatcher misses → 404 (not a 500, not a dead plugin).
    const status = await fetch(`${base()}/plugin-api/novelai/status`, { headers: headers() });
    expect(status.status).toBe(404);

    // The tools still work — a missing diagnostic capability costs diagnostics,
    // nothing else.
    const out = await withLead('echo-team-2', (c) =>
      callTool(c, 'novelai.generate_text', { prompt: 'The wizard raised his staff and' }),
    );
    expect(out.ok).toBe(true);
    expect(out.text).toBe('once upon a time');
  });
});

describe('novelai plugin — operator HTTP route', () => {
  it('7. GET /plugin-api/novelai/status answers 200 without echoing the token', async () => {
    await install();

    const res = await fetch(`${base()}/plugin-api/novelai/status`, { headers: headers() });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      ok: boolean;
      plugin: string;
      token_set: boolean;
      output_dir: { agent: string | null; container: string | null };
      queue: { inflight: number; waiting: number };
      subscription: unknown;
      hints: string[];
    };

    expect(body.ok).toBe(true);
    expect(body.plugin).toBe('novelai');
    expect(body.token_set).toBe(true);
    // Both path forms are reported; their gap is what makes an ssh translation
    // bug diagnosable. Locally they coincide.
    expect(body.output_dir.container).toBe(path.join(stack.workspaceRoot, 'novelai'));
    expect(body.output_dir.agent).toBe(body.output_dir.container);
    expect(body.queue).toEqual({ inflight: 0, waiting: 0 });
    expect(body.hints.length).toBeGreaterThan(0);
    // The route is a cold read: it really called /user/subscription.
    expect(naiCalls).toContain('https://api.novelai.net/user/subscription');

    // THE assertion of this case: a boolean and a date, never the secret.
    expect(raw).not.toContain(API_TOKEN);
    expect(JSON.stringify(body)).not.toContain(API_TOKEN);
  });
});
