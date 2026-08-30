// Tests for `../index.js` + `../lib/tools.js` — the surface an agent touches.
//
// These drive the REAL activation path (a faked SwarmPluginApi, a faked Gemini
// over `fetch`) and assert three families of property:
//
//  1. WIRING ORDER. A missing OPTIONAL capability (`http-routes`, `schedule`)
//     must not take the tools down. `api.http.registerRouter` THROWS when the
//     grant is absent (api.ts:152-156), so registering the tools first and
//     wrapping the diagnostics in try/catch is the difference between a plugin
//     that works without its /status route and a plugin that does not activate.
//  2. THE OUTPUT SCHEMA CONTRACT. The MCP SDK validates `structuredContent`
//     against `outputSchema` and throws an opaque McpError on any mismatch, so a
//     field absent on the error path MUST be optional. `checkShape` below is a
//     stand-in for that validation: every assertion runs the handler's real
//     return value through the tool's own declared schema. A fake zod is used
//     rather than the server's instance because `examples/` ships as a verbatim
//     directory copy with no node_modules of its own.
//  3. A HANDLER NEVER THROWS. Every failure — a dead client, a blocked prompt, a
//     path outside the workspace — is asserted as a VALUE with a code, because a
//     throw would count toward plugin quarantine.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE PLUGIN UNDER TEST IS A DIRECTORY COPY, not the repo tree — for the same
 * reason it is a directory copy in production, plus one that is specific to
 * these tests: the plugin REWRITES ITS OWN `plugin.json` to keep the config
 * form's model dropdowns current (lib/model-lists.js), and `manifestPath` is
 * derived from `import.meta.url`. Importing `../index.js` directly would let a
 * test rewrite the repository's manifest — a passing suite with a dirty tree.
 *
 * Copying also makes the manifest an ASSERTABLE artefact: the dropdown test
 * below reads the file back after the plugin has updated it.
 */
const PLUGIN_SRC = fileURLToPath(new URL('../', import.meta.url));
/** @type {import('@swarm-os/plugin-sdk').SwarmPlugin} */
let plugin;
/** @type {(api: any) => any} */
let parseConfig;
/** @type {string} */
let pluginDir;

beforeAll(async () => {
  pluginDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-plugin-')), 'gemini-api');
  await fs.cp(PLUGIN_SRC, pluginDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}test`) && !src.includes('node_modules'),
  });
  const mod = await import(path.join(pluginDir, 'index.js'));
  plugin = mod.default;
  parseConfig = mod.parseConfig;
});

// ---------------------------------------------------------------------------
// A zod stand-in that records the SHAPE, plus the validator that reads it back.
// ---------------------------------------------------------------------------

function make(type, extra = {}) {
  const node = { __type: type, __optional: Boolean(extra.__optional), ...extra };
  node.optional = () => make(type, { ...extra, __optional: true });
  node.describe = () => node;
  node.min = () => node;
  node.max = () => node;
  return node;
}

const fakeZod = {
  string: () => make('string'),
  number: () => make('number'),
  boolean: () => make('boolean'),
  array: (inner) => make('array', { inner }),
  object: (shape) => make('object', { shape }),
  enum: (values) => make('enum', { values }),
};

/** Throws exactly where the MCP SDK's safeParseAsync would reject. */
function checkNode(node, value, where) {
  switch (node.__type) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`${where}: attendu string, recu ${typeof value}`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where}: attendu number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${where}: attendu boolean`);
      break;
    case 'enum':
      if (!node.values.includes(value)) throw new Error(`${where}: hors enum`);
      break;
    case 'array':
      if (!Array.isArray(value)) throw new Error(`${where}: attendu array`);
      value.forEach((v, i) => checkNode(node.inner, v, `${where}[${i}]`));
      break;
    case 'object':
      checkShape(node.shape, value, where);
      break;
    default:
      break;
  }
}

function checkShape(shape, value, where = 'root') {
  if (!value || typeof value !== 'object') throw new Error(`${where}: attendu object`);
  for (const [key, node] of Object.entries(shape)) {
    const v = value[key];
    if (v === undefined || v === null) {
      if (!node.__optional) throw new Error(`${where}.${key}: champ requis absent`);
      continue;
    }
    checkNode(node, v, `${where}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(64, 3)]);
const PCM = Buffer.alloc(480, 7); // raw PCM: no container, the TTS trap
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 9)]);
const MP4 = Buffer.alloc(2048, 5);

const realFetch = globalThis.fetch;
/** @type {string} */
let ws;
/** @type {NodeJS.ProcessEnv} */
let savedEnv;

beforeEach(async () => {
  savedEnv = { ...process.env };
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-tools-'));
  process.env.SWARM_OS_WORKSPACE_ROOT = ws;
  delete process.env.SWARM_OS_AGENT_TRANSPORT;
  delete process.env.SWARM_OS_HOST_WORKSPACE_ROOT;
});

afterEach(async () => {
  await plugin.deactivate();
  globalThis.fetch = realFetch;
  for (const k of ['SWARM_OS_WORKSPACE_ROOT', 'SWARM_OS_HOST_WORKSPACE_ROOT', 'SWARM_OS_AGENT_TRANSPORT']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
});

/**
 * @param {object} [opts]
 * @returns {{api: any, tools: Map<string, any>, routes: Map<string, Function>, logs: any[], notifications: any[], store: Map<string, string>}}
 */
function makeApi(opts = {}) {
  const store = new Map();
  const tools = new Map();
  const routes = new Map();
  const logs = [];
  const notifications = [];
  const api = {
    pluginName: 'gemini-api',
    log: {
      info: (o, m) => logs.push({ level: 'info', o, m }),
      warn: (o, m) => logs.push({ level: 'warn', o, m }),
      error: (o, m) => logs.push({ level: 'error', o, m }),
      debug: () => {},
    },
    zod: fakeZod,
    config: { get: () => opts.config ?? { apiKey: 'AIzaSECRET0000' }, onChange: () => ({ dispose() {} }) },
    storage: {
      kv: opts.noKv
        ? {
            get() {
              throw new Error('capability db-kv not granted');
            },
            set() {
              throw new Error('capability db-kv not granted');
            },
            delete() {
              throw new Error('capability db-kv not granted');
            },
            list() {
              throw new Error('capability db-kv not granted');
            },
          }
        : {
            get: (k) => store.get(k) ?? null,
            set: (k, v) => store.set(k, v),
            delete: (k) => store.delete(k),
            list: (p = '') => [...store].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
          },
    },
    mcp: {
      registerTool: (def) => {
        tools.set(def.name, def);
        return { dispose() {} };
      },
    },
    http: {
      createRouter: () => {
        const r = {
          get: (p, h) => {
            routes.set(p, h);
            return r;
          },
        };
        return r;
      },
      registerRouter: () => {
        if (opts.noHttp) throw new Error('capability http-routes not granted');
        return { dispose() {} };
      },
    },
    schedule: {
      cron: () => {
        if (opts.noSchedule) throw new Error('capability schedule not granted');
        return { dispose() {} };
      },
    },
    notify: {
      custom: async (input) => {
        notifications.push(input);
      },
    },
    agentAssets: {
      get basePath() {
        if (opts.noAssets) throw new Error('capability agent-assets not granted');
        return '/workspace/.swarm/plugins/gemini-api';
      },
    },
  };
  return { api, tools, routes, logs, notifications, store };
}

/** Fake Gemini. `overrides` replaces the response for a matching URL fragment. */
function fakeGemini(overrides = {}) {
  const calls = [];
  let videoPolls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    calls.push({ url: u, method: init.method || 'GET', body, headers: init.headers || {} });

    for (const [fragment, responder] of Object.entries(overrides)) {
      if (u.includes(fragment)) return responder(body, init);
    }

    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

    if (u.endsWith('/v1beta/interactions')) {
      const rf = body?.response_format;
      if (rf?.type === 'audio') {
        const music = String(body.model).includes('lyria');
        return json({
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'audio',
                  data: (music ? MP3 : PCM).toString('base64'),
                  mime_type: music ? 'audio/mpeg' : 'audio/L16;codec=pcm;rate=24000',
                },
              ],
            },
          ],
        });
      }
      if (rf?.type === 'image') {
        return json({ output_image: { data: PNG.toString('base64'), mime_type: 'image/png' }, output_text: 'voila' });
      }
      return json({ output_text: 'REPONSE', usage: { total_input_tokens: 5, total_output_tokens: 9, total_tokens: 14 } });
    }
    if (u.includes(':predictLongRunning')) return json({ name: 'models/veo/operations/op1' });
    if (u.includes('/operations/op1')) {
      videoPolls += 1;
      if (videoPolls === 1) return json({ done: false });
      return json({
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.test/v.mp4', mimeType: 'video/mp4' } }] } },
      });
    }
    if (u.startsWith('https://files.test/')) {
      return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    if (u.includes('/v1beta/models')) {
      return json({
        models: [
          { name: 'models/gemini-3.7-flash' },
          { name: 'models/gemini-3.1-flash-image' },
          { name: 'models/gemini-3.1-flash-tts-preview' },
          { name: 'models/lyria-3-clip-preview' },
          { name: 'models/veo-3.1-generate-preview' },
        ],
      });
    }
    return json({ error: { code: 404, message: `unexpected ${u}` } }, 404);
  };
  return { calls, lastBody: () => calls.at(-1)?.body };
}

/** Call a tool and validate its answer against its OWN declared outputSchema. */
async function call(tools, name, args = {}, ctx = { sessionName: 'worker-1', isLead: false }) {
  const def = tools.get(name);
  if (!def) throw new Error(`outil absent: ${name}`);
  const out = await def.handler(args, ctx);
  if (def.outputSchema) checkShape(def.outputSchema, out, name);
  return out;
}

// ---------------------------------------------------------------------------

describe('activation', () => {
  it('registers the whole tool set', async () => {
    const { api, tools } = makeApi();
    await plugin.activate(api);
    expect([...tools.keys()].sort()).toEqual(
      [
        'analyze_media',
        'generate_image',
        'generate_music',
        'generate_text',
        'generate_video',
        'guide',
        'list_models',
        'text_to_speech',
        'video_status',
      ].sort(),
    );
  });

  it('still registers the tools when http-routes and schedule are NOT granted', async () => {
    // The whole point of the wiring order: a missing diagnostic capability must
    // not cost the plugin its reason to exist.
    const { api, tools, logs } = makeApi({ noHttp: true, noSchedule: true });
    await expect(plugin.activate(api)).resolves.toBeUndefined();
    expect(tools.size).toBe(9);
    expect(logs.filter((l) => l.level === 'warn').length).toBeGreaterThanOrEqual(2);
  });

  it('activates without a key and answers not_configured rather than crashing', async () => {
    const { api, tools } = makeApi({ config: {} });
    await plugin.activate(api);
    for (const name of ['generate_text', 'text_to_speech', 'generate_image', 'generate_music', 'generate_video']) {
      const out = await call(tools, name, { prompt: 'x', text: 'x' });
      expect(out).toMatchObject({ ok: false, code: 'not_configured' });
    }
  });

  it('serves the guide from disk, with the path in the AGENT namespace', async () => {
    const { api, tools } = makeApi();
    await plugin.activate(api);
    const out = await call(tools, 'guide');
    expect(out.guide.length).toBeGreaterThan(1000);
    expect(out.guide_path).toBe('/workspace/.swarm/plugins/gemini-api/GUIDE.md');
  });

  it('still answers the guide when agent-assets is not granted', async () => {
    const { api, tools } = makeApi({ noAssets: true });
    await plugin.activate(api);
    const out = await call(tools, 'guide');
    expect(out.ok).toBe(true);
    expect(out.guide_path).toBeUndefined();
  });
});

describe('parseConfig', () => {
  const withRaw = (raw) => parseConfig({ config: { get: () => raw } });

  it('applies the manifest defaults', () => {
    const cfg = withRaw({});
    expect(cfg).toMatchObject({
      apiKey: '',
      textModel: 'gemini-3.7-flash',
      imageModel: 'gemini-3.1-flash-image',
      defaultVoice: 'Kore',
      outputDir: 'gemini',
      retentionDays: 7,
      requestTimeoutSec: 120,
      maxConcurrent: 2,
    });
  });

  it('accepts an UNKNOWN model verbatim instead of rewriting it to the default', () => {
    // The novelai lesson: an allowlist silently produced the old model for a
    // valid new id, with no error anywhere.
    expect(withRaw({ textModel: 'gemini-9-experimental' }).textModel).toBe('gemini-9-experimental');
  });

  it('clamps values a hand-edited config row could otherwise weaponise', () => {
    expect(withRaw({ requestTimeoutSec: 0 }).requestTimeoutSec).toBe(10);
    expect(withRaw({ requestTimeoutSec: 9999 }).requestTimeoutSec).toBe(600);
    expect(withRaw({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(withRaw({ maxConcurrent: 99 }).maxConcurrent).toBe(8);
    expect(withRaw({ retentionDays: -5 }).retentionDays).toBe(0);
  });

  it('treats an empty string and a wrong type as absent', () => {
    expect(withRaw({ textModel: '   ', retentionDays: 'abc' })).toMatchObject({
      textModel: 'gemini-3.7-flash',
      retentionDays: 7,
    });
  });

  it('survives a config accessor that throws', () => {
    expect(
      parseConfig({
        config: {
          get() {
            throw new Error('nope');
          },
        },
      }).textModel,
    ).toBe('gemini-3.7-flash');
  });
});

describe('generate_text', () => {
  it('returns the text, the usage, and sends the knobs it was given', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'generate_text', {
      prompt: 'salut',
      system_instruction: 'sois bref',
      google_search: true,
      temperature: 0.5,
      json_schema: '{"type":"object"}',
    });
    expect(out).toMatchObject({ ok: true, text: 'REPONSE', model: 'gemini-3.7-flash' });
    expect(out.usage).toMatchObject({ input: 5, output: 9, total: 14 });
    const body = gemini.lastBody();
    expect(body.system_instruction).toBe('sois bref');
    expect(body.tools).toEqual([{ type: 'google_search' }]);
    expect(body.response_format).toEqual({ type: 'text', mime_type: 'application/json', schema: { type: 'object' } });
    expect(body.generation_config.temperature).toBe(0.5);
  });

  it('names the offending character when json_schema is not JSON', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'generate_text', { prompt: 'x', json_schema: '{oops' });
    expect(out).toMatchObject({ ok: false, code: 'bad_request' });
    expect(out.error).toContain('json_schema');
  });

  it('relays the upstream code and hint verbatim', async () => {
    const { api, tools, store } = makeApi();
    fakeGemini({
      '/v1beta/interactions': () =>
        new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await plugin.activate(api);
    const out = await call(tools, 'generate_text', { prompt: 'x' });
    expect(out).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(out.hint).toContain('apiKey');
    // …and it is remembered for the operator's /status page.
    expect(JSON.parse(store.get('last_error')).tool).toBe('generate_text');
  });

  it('reports a safety block as `blocked`, and a plain empty answer as `no_output`', async () => {
    const { api, tools } = makeApi();
    let blocked = true;
    fakeGemini({
      '/v1beta/interactions': () =>
        new Response(
          JSON.stringify(blocked ? { prompt_feedback: { block_reason: 'SAFETY' }, output_text: '' } : { output_text: '' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    await plugin.activate(api);
    expect((await call(tools, 'generate_text', { prompt: 'x' })).code).toBe('blocked');
    blocked = false;
    expect((await call(tools, 'generate_text', { prompt: 'x' })).code).toBe('no_output');
  });
});

describe('analyze_media (vision)', () => {
  it('sends the question first, then the file, and reports what was uploaded', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    await fs.mkdir(path.join(ws, 'shots'), { recursive: true });
    await fs.writeFile(path.join(ws, 'shots/a.png'), PNG);

    const out = await call(tools, 'analyze_media', { question: 'que vois-tu ?', files: ['shots/a.png'] });
    expect(out).toMatchObject({ ok: true, text: 'REPONSE', files_sent: 1, uploaded: 0 });
    const input = gemini.lastBody().input;
    expect(input[0]).toEqual({ type: 'text', text: 'que vois-tu ?' });
    expect(input[1]).toMatchObject({ type: 'image', mime_type: 'image/png' });
    expect(Buffer.from(input[1].data, 'base64').equals(PNG)).toBe(true);
  });

  it('REFUSES a file outside the workspace', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'analyze_media', { question: 'x', files: ['/etc/passwd'] });
    expect(out).toMatchObject({ ok: false, code: 'bad_request' });
    expect(out.error).toMatch(/hors du workspace/);
  });

  it('points at the right tool when no file is passed', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'analyze_media', { question: 'x', files: [] });
    expect(out.hint).toContain('generate_text');
  });
});

describe('text_to_speech', () => {
  it('WRAPS the raw PCM in a WAV header and writes a file an agent can read', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'text_to_speech', { text: 'Bonjour tout le monde', voice: 'Puck' });
    expect(out).toMatchObject({ ok: true, wrapped_pcm: true, voice: 'Puck' });

    const file = out.files[0];
    expect(file.path).toBe(file.container_path); // local transport: identity
    expect(file.workspace_relative.startsWith('gemini/')).toBe(true);
    const bytes = await fs.readFile(file.container_path);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.readUInt32LE(24)).toBe(24000);
    expect(bytes.length).toBe(PCM.length + 44);
    // The workspace is a Git repo: generated media must never be staged.
    expect(await fs.readFile(path.join(ws, 'gemini', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('builds the multi-speaker speech_config and reports the voice as multi', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'text_to_speech', {
      text: 'Joe: salut\nJane: ca va',
      speakers: [
        { name: 'Joe', voice: 'Kore' },
        { name: 'Jane', voice: 'Puck' },
      ],
    });
    expect(out.voice).toBe('multi');
    expect(gemini.lastBody().generation_config.speech_config).toEqual([
      { speaker: 'Joe', voice: 'Kore' },
      { speaker: 'Jane', voice: 'Puck' },
    ]);
  });

  it('falls back to the configured voice when none is given', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    await call(tools, 'text_to_speech', { text: 'x' });
    expect(gemini.lastBody().generation_config.speech_config).toEqual([{ voice: 'Kore' }]);
  });
});

describe('generate_image', () => {
  it('writes the image and forwards the format knobs', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'generate_image', { prompt: 'un chat roux', aspect_ratio: '16:9', image_size: '2K' });
    expect(out).toMatchObject({ ok: true, text: 'voila' });
    expect(gemini.lastBody().response_format).toEqual({
      type: 'image',
      mime_type: 'image/png',
      aspect_ratio: '16:9',
      image_size: '2K',
    });
    expect((await fs.readFile(out.files[0].container_path)).equals(PNG)).toBe(true);
    expect(out.files[0].workspace_relative).toMatch(/un-chat-roux-[0-9a-f]{4}-0\.png$/);
  });

  it('inlines the reference images when editing', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    await fs.writeFile(path.join(ws, 'src.png'), PNG);
    await call(tools, 'generate_image', { prompt: 'la meme piece de jour', input_images: ['src.png'] });
    expect(gemini.lastBody().input.map((b) => b.type)).toEqual(['text', 'image']);
  });
});

describe('generate_music', () => {
  it('writes the MP3 through untouched (a container is never re-wrapped)', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'generate_music', { prompt: 'jazz 90 bpm piano' });
    expect(out.files[0].mime).toBe('audio/mpeg');
    expect(out.files[0].workspace_relative.endsWith('.mp3')).toBe(true);
    expect((await fs.readFile(out.files[0].container_path)).equals(MP3)).toBe(true);
  });
});

describe('generate_video + video_status', () => {
  it('hands back a job id immediately and collects the file on a later poll', async () => {
    const { api, tools } = makeApi();
    const gemini = fakeGemini();
    await plugin.activate(api);
    await fs.writeFile(path.join(ws, 'first.png'), PNG);

    const started = await call(tools, 'generate_video', {
      prompt: 'un drone au-dessus de la mer',
      first_frame: 'first.png',
      aspect_ratio: '16:9',
      duration_seconds: 8,
    });
    expect(started).toMatchObject({ ok: true, status: 'running' });
    expect(started.job_id).toMatch(/^[0-9a-f]{16}$/);
    expect(started.next_step).toContain(started.job_id);

    const body = gemini.lastBody();
    expect(body.instances[0].image.inlineData.mimeType).toBe('image/png');
    // durationSeconds is a STRING: that is the form Google's reference uses.
    expect(body.parameters).toEqual({ aspectRatio: '16:9', durationSeconds: '8' });

    const first = await call(tools, 'video_status', { job_id: started.job_id });
    expect(first).toMatchObject({ ok: true, status: 'running' });

    const done = await call(tools, 'video_status', { job_id: started.job_id });
    expect(done).toMatchObject({ ok: true, status: 'done' });
    expect((await fs.readFile(done.files[0].container_path)).length).toBe(MP4.length);
    expect(done.files[0].mime).toBe('video/mp4');

    // Idempotent: a second collect must not download (or bill) the video twice.
    const callsBefore = gemini.calls.length;
    const again = await call(tools, 'video_status', { job_id: started.job_id });
    expect(again.files[0].container_path).toBe(done.files[0].container_path);
    expect(gemini.calls.length).toBe(callsBefore);
  });

  it('blocks for wait_seconds and returns the finished video without a second tool call', async () => {
    // The wait loop is driven with fake timers: the poll interval is 10 s of
    // real time, and what is under test is the TERMINAL condition, not the wall
    // clock. A transient poll failure must NOT end the wait — only `done` or
    // `failed` may — which is why the first poll answers 503 here.
    const { api, tools } = makeApi();
    let polls = 0;
    fakeGemini({
      '/operations/op1': () => {
        polls += 1;
        if (polls === 1) return new Response('busy', { status: 503 });
        return new Response(
          JSON.stringify({
            done: true,
            response: {
              generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.test/v.mp4', mimeType: 'video/mp4' } }] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await plugin.activate(api);

    vi.useFakeTimers();
    try {
      const pending = call(tools, 'generate_video', { prompt: 'un drone', wait_seconds: 120 });
      // 3 polls' worth of interval: enough for the 503, its retry, and the win.
      await vi.advanceTimersByTimeAsync(60_000);
      const out = await pending;
      expect(out).toMatchObject({ ok: true, status: 'done' });
      expect(out.files[0].mime).toBe('video/mp4');
      expect(polls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the known jobs when called with no argument', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    await call(tools, 'generate_video', { prompt: 'x' });
    const out = await call(tools, 'video_status', {});
    expect(out.status).toBe('listing');
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({ status: 'running', model: 'veo-3.1-generate-preview' });
  });

  it('reports an unknown job id instead of pretending it is running', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    expect(await call(tools, 'video_status', { job_id: 'deadbeef' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('marks the job failed when the OPERATION failed', async () => {
    const { api, tools } = makeApi();
    fakeGemini({
      '/operations/op1': () =>
        new Response(JSON.stringify({ done: true, error: { message: 'safety filter' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await plugin.activate(api);
    const started = await call(tools, 'generate_video', { prompt: 'x' });
    const out = await call(tools, 'video_status', { job_id: started.job_id });
    expect(out).toMatchObject({ ok: false, status: 'failed', code: 'generation_failed' });
    // A failed job stays failed: the second call must not re-poll Google.
    expect(await call(tools, 'video_status', { job_id: started.job_id })).toMatchObject({ status: 'failed' });
  });

  it('keeps the job RUNNING when only the download failed — the video was paid for', async () => {
    const { api, tools } = makeApi();
    fakeGemini({
      'https://files.test/': () => new Response('nope', { status: 500 }),
    });
    await plugin.activate(api);
    const started = await call(tools, 'generate_video', { prompt: 'x' });
    await call(tools, 'video_status', { job_id: started.job_id }); // first poll: not done
    const out = await call(tools, 'video_status', { job_id: started.job_id });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('running');
  });

  it('falls back to the operation name when db-kv is not granted', async () => {
    const { api, tools } = makeApi({ noKv: true });
    fakeGemini();
    await plugin.activate(api);
    const started = await call(tools, 'generate_video', { prompt: 'x' });
    expect(started.ok).toBe(true);
    expect(started.note).toContain('db-kv');
    expect(started.operation).toBe('models/veo/operations/op1');
    // The operation is the recovery handle: status works without any store.
    await call(tools, 'video_status', { operation: started.operation });
    const out = await call(tools, 'video_status', { operation: started.operation });
    expect(out).toMatchObject({ ok: true, status: 'done' });
  });
});

describe('list_models', () => {
  it('filters the live list and echoes what is configured', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const out = await call(tools, 'list_models', { filter: 'image' });
    expect(out.models).toEqual(['gemini-3.1-flash-image']);
    expect(out.configured.video).toBe('veo-3.1-generate-preview');
  });
});

describe('GET /status', () => {
  /** Run the route handler and capture its JSON. */
  async function fetchStatus(routes, query = {}) {
    let payload = null;
    const res = {
      json: (o) => {
        payload = o;
      },
      status() {
        return this;
      },
    };
    await routes.get('/status')({ query }, res);
    return payload;
  }

  it('never returns the key, only a boolean and a fingerprint', async () => {
    const { api, routes } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const payload = await fetchStatus(routes);
    expect(payload.key_set).toBe(true);
    expect(payload.key_fingerprint).toBe('AIza...0000');
    expect(JSON.stringify(payload)).not.toContain('AIzaSECRET0000');
  });

  it('flags a configured model that Google no longer serves', async () => {
    const { api, routes } = makeApi({ config: { apiKey: 'k', textModel: 'gemini-retired' } });
    fakeGemini();
    await plugin.activate(api);
    const payload = await fetchStatus(routes);
    expect(payload.hints.some((h) => h.includes('gemini-retired'))).toBe(true);
  });

  it('puts a model-list failure IN the payload instead of failing the route', async () => {
    const { api, routes } = makeApi();
    fakeGemini({ '/v1beta/models': () => new Response('boom', { status: 500 }) });
    await plugin.activate(api);
    const payload = await fetchStatus(routes);
    expect(payload.ok).toBe(true);
    expect(payload.models.error).toBeTruthy();
  });

  it('probes the key with a real call on ?probe=text', async () => {
    const { api, routes } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    const payload = await fetchStatus(routes, { probe: 'text' });
    expect(payload).toMatchObject({ ok: true, probe: 'text', model: 'gemini-3.7-flash' });
  });
});

describe('the plugin maintains its own config form', () => {
  /** The manifest as the host would read it on `GET /plugins/gemini-api`. */
  const readManifest = async () => JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));

  it('ships with FREE-TEXT model fields — a list frozen at install time would already be wrong', async () => {
    // Read the PUBLISHED manifest, not the working copy: by this point in the
    // file the plugin has already updated its own copy, which is the whole
    // point of the feature. What ships must still be free text.
    const m = JSON.parse(await fs.readFile(path.join(PLUGIN_SRC, 'plugin.json'), 'utf8'));
    for (const slot of ['textModel', 'imageModel', 'ttsModel', 'musicModel', 'videoModel']) {
      expect(m.configSchema.properties[slot].enum).toBeUndefined();
    }
  });

  it('turns them into dropdowns once a key can list models', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);

    // `list_models` refreshes the dropdowns as a side effect — the same code the
    // /status route and the daily cron call.
    await call(tools, 'list_models', {});
    // The refresh is deliberately not awaited by the tool, so let it land. The
    // condition is the EXPECTED content: waiting on "an enum exists" would be
    // satisfied by an enum an earlier test wrote, and this test would then read
    // stale content.
    await vi.waitFor(async () => {
      const m = await readManifest();
      expect(m.configSchema.properties.textModel.enum).toEqual(['gemini-3.7-flash']);
    });

    const m = await readManifest();
    // Exactly what the fake API serves, routed to the right field.
    expect(m.configSchema.properties.textModel.enum).toEqual(['gemini-3.7-flash']);
    expect(m.configSchema.properties.imageModel.enum).toEqual(['gemini-3.1-flash-image']);
    expect(m.configSchema.properties.ttsModel.enum).toEqual(['gemini-3.1-flash-tts-preview']);
    expect(m.configSchema.properties.musicModel.enum).toEqual(['lyria-3-clip-preview']);
    expect(m.configSchema.properties.videoModel.enum).toEqual(['veo-3.1-generate-preview']);
    // Everything else is untouched — including the version, so no rescan is
    // needed for the new form to be served.
    expect(m.configSchema.properties.apiKey.format).toBe('password');
    expect(m.configSchema.properties.outputDir.enum).toBeUndefined();
    expect(m.version).toBe('0.1.0');
  });

  it('produces a manifest the SERVER still accepts, and a form the operator can save', async () => {
    // The point of the whole feature: the rewritten file must survive the two
    // consumers that read it on every request — the manifest loader and the
    // config validator.
    const m = await readManifest();
    expect(m.name).toBe('gemini-api');
    expect(typeof m.main).toBe('string');
    expect(m.configSchema.required).toEqual(['apiKey']);
    // A configured value must be selectable, or `validateConfig` would reject
    // the whole form — including a fix to the API key.
    expect(m.configSchema.properties.textModel.enum).toContain('gemini-3.7-flash');
    for (const slot of ['textModel', 'imageModel', 'ttsModel', 'musicModel', 'videoModel']) {
      expect(m.configSchema.properties[slot].enum.length).toBeGreaterThan(0);
    }
  });

  it('reports the dropdown state on /status', async () => {
    const { api, routes } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    let payload = null;
    await routes.get('/status')({ query: {} }, { json: (o) => { payload = o; }, status() { return this; } });
    expect(payload.hints.some((h) => h.includes('?refresh=models'))).toBe(true);

    let forced = null;
    await routes.get('/status')(
      { query: { refresh: 'models' } },
      { json: (o) => { forced = o; }, status() { return this; } },
    );
    expect(forced).toMatchObject({ action: 'refresh_models', ok: true });
    expect(forced.slots.videoModel).toBe(1);
  });
});

describe('rule 1 — a handler never throws', () => {
  // Slow on purpose, and the wall-clock is the POINT: a network error is retried
  // once after a ~2 s backoff, so each of these calls really does spend that long
  // before giving up. They run concurrently to pay it once rather than six times.
  it('turns even a broken transport into a value', async () => {
    const { api, tools } = makeApi();
    globalThis.fetch = () => {
      throw new TypeError('fetch exploded');
    };
    await plugin.activate(api);
    const results = await Promise.all([
      call(tools, 'generate_text', { prompt: 'x' }),
      call(tools, 'text_to_speech', { text: 'x' }),
      call(tools, 'generate_image', { prompt: 'x' }),
      call(tools, 'generate_music', { prompt: 'x' }),
      call(tools, 'generate_video', { prompt: 'x' }),
      call(tools, 'list_models', {}),
    ]);
    for (const out of results) {
      expect(out.ok).toBe(false);
      expect(typeof out.code).toBe('string');
    }
  }, 45000);

  it('survives being called with no arguments at all', async () => {
    const { api, tools } = makeApi();
    fakeGemini();
    await plugin.activate(api);
    for (const name of ['generate_text', 'text_to_speech', 'generate_image', 'generate_music', 'generate_video']) {
      const out = await call(tools, name, {});
      expect(out).toMatchObject({ ok: false, code: 'bad_request' });
    }
  });
});
