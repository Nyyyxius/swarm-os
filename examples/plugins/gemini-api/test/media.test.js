// Tests for `../lib/media.js` — turning what an AGENT typed into what the
// Interactions API accepts.
//
// The security-critical case is first and is not a formality: this plugin runs
// in-process with the server's rights, so an attachment path that escapes the
// workspace does not merely read the wrong file — it UPLOADS it to Google. The
// containment check lives in lib/paths.js; what is pinned here is that
// `buildInput` actually honours it, on every path, before any byte is read.
//
// The rest is about the 20 MB request cap: a per-file threshold alone is not
// enough, because ten 5 MB images are a 50 MB request that every per-file check
// waves through. Hence a cumulative budget, tested as such.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildInput,
  fileBlock,
  normaliseRef,
  remoteBlock,
  sniffMime,
  INLINE_MAX_BYTES,
  MAX_ATTACHMENTS,
} from '../lib/media.js';

/** @type {string} */
let ws;
/** @type {NodeJS.ProcessEnv} */
let savedEnv;

beforeEach(async () => {
  savedEnv = { ...process.env };
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-ws-'));
  process.env.SWARM_OS_WORKSPACE_ROOT = ws;
  delete process.env.SWARM_OS_AGENT_TRANSPORT;
  delete process.env.SWARM_OS_HOST_WORKSPACE_ROOT;
});

afterEach(() => {
  for (const k of ['SWARM_OS_WORKSPACE_ROOT', 'SWARM_OS_HOST_WORKSPACE_ROOT', 'SWARM_OS_AGENT_TRANSPORT']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);

/** A client that records what it was asked to upload. */
function fakeClient(overrides = {}) {
  const uploads = [];
  return {
    uploads,
    async uploadFile(args) {
      uploads.push(args);
      return { ok: true, uri: 'https://f/1', name: 'files/1', mimeType: args.mimeType, state: 'ACTIVE' };
    },
    async fileStatus() {
      return { ok: true, state: 'ACTIVE', uri: 'https://f/1' };
    },
    ...overrides,
  };
}

describe('sniffMime', () => {
  it('recognises the containers a workspace actually holds', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('OggS----'))).toBe('audio/ogg');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBe('audio/wav');
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]))).toBe('video/mp4');
  });

  it('returns null rather than guessing', () => {
    expect(sniffMime(Buffer.from('hello world'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('normaliseRef', () => {
  it('accepts a bare string and trims it', () => {
    expect(normaliseRef('  a.png ')).toEqual({ ref: 'a.png', mime: null });
  });

  it('accepts the {path|uri, mime_type} form', () => {
    expect(normaliseRef({ path: 'a', mime_type: 'image/png' })).toEqual({ ref: 'a', mime: 'image/png' });
    expect(normaliseRef({ uri: 'https://x/a' })).toEqual({ ref: 'https://x/a', mime: null });
  });

  it('rejects anything empty or nonsensical', () => {
    expect(normaliseRef('')).toBeNull();
    expect(normaliseRef('   ')).toBeNull();
    expect(normaliseRef(42)).toBeNull();
    expect(normaliseRef({})).toBeNull();
  });
});

describe('remoteBlock', () => {
  it('matches YouTube on the HOST, so the short youtu.be form works', () => {
    // A naive full-URL regex misses exactly the form people paste.
    for (const u of ['https://youtu.be/abc', 'https://www.youtube.com/watch?v=x', 'https://m.youtube.com/watch?v=x']) {
      expect(remoteBlock(u, null).block).toMatchObject({ type: 'video', mime_type: 'video/mp4' });
    }
  });

  it('does not treat a look-alike host as YouTube', () => {
    expect(remoteBlock('https://notyoutube.com/watch', null).ok).toBe(false);
  });

  it('infers the MIME from the URL path when it can', () => {
    expect(remoteBlock('https://x.test/a/b.png', null).block).toMatchObject({ type: 'image', mime_type: 'image/png' });
  });

  it('asks for an explicit mime_type instead of guessing', () => {
    const out = remoteBlock('https://x.test/download', null);
    expect(out.code).toBe('bad_request');
    expect(out.hint).toContain('mime_type');
  });

  it('returns a value (never throws) on a malformed URL', () => {
    expect(remoteBlock('http://[bad', null)).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('fileBlock', () => {
  it('inlines a small file as base64 with its MIME', async () => {
    await fs.writeFile(path.join(ws, 'a.png'), PNG);
    const out = await fileBlock({ client: fakeClient(), ref: 'a.png', declaredMime: null, inlineBudgetLeft: 1e9 });
    expect(out.inlined).toBe(true);
    expect(out.block).toMatchObject({ type: 'image', mime_type: 'image/png' });
    expect(Buffer.from(out.block.data, 'base64').equals(PNG)).toBe(true);
  });

  it('falls back to magic bytes when the name carries no extension', async () => {
    await fs.writeFile(path.join(ws, 'screenshot'), PNG);
    const out = await fileBlock({ client: fakeClient(), ref: 'screenshot', declaredMime: null, inlineBudgetLeft: 1e9 });
    expect(out.block.mime_type).toBe('image/png');
  });

  it('uploads instead of inlining once the file is over the threshold', async () => {
    const big = Buffer.alloc(INLINE_MAX_BYTES + 1, 2);
    await fs.writeFile(path.join(ws, 'big.png'), big);
    const client = fakeClient();
    const out = await fileBlock({ client, ref: 'big.png', declaredMime: null, inlineBudgetLeft: 1e9 });
    expect(out.inlined).toBe(false);
    expect(out.block).toMatchObject({ type: 'image', uri: 'https://f/1' });
    expect(client.uploads).toHaveLength(1);
  });

  it('waits for an upload to leave PROCESSING before referencing it', async () => {
    const big = Buffer.alloc(INLINE_MAX_BYTES + 1, 2);
    await fs.writeFile(path.join(ws, 'big.mp4'), big);
    let polls = 0;
    const client = fakeClient({
      async uploadFile() {
        return { ok: true, uri: 'https://f/2', name: 'files/2', mimeType: 'video/mp4', state: 'PROCESSING' };
      },
      async fileStatus() {
        polls += 1;
        return { ok: true, state: polls >= 2 ? 'ACTIVE' : 'PROCESSING', uri: 'https://f/2' };
      },
    });
    const out = await fileBlock({ client, ref: 'big.mp4', declaredMime: null, inlineBudgetLeft: 0 });
    expect(out.ok).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('reports a missing file with the path the agent typed', async () => {
    const out = await fileBlock({ client: fakeClient(), ref: 'nope.png', declaredMime: null, inlineBudgetLeft: 1e9 });
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
    expect(out.error).toContain('nope.png');
  });

  it('refuses an empty file and a directory', async () => {
    await fs.writeFile(path.join(ws, 'empty.png'), '');
    await fs.mkdir(path.join(ws, 'adir'));
    expect((await fileBlock({ client: fakeClient(), ref: 'empty.png', declaredMime: null, inlineBudgetLeft: 1e9 })).code).toBe(
      'bad_request',
    );
    expect((await fileBlock({ client: fakeClient(), ref: 'adir', declaredMime: null, inlineBudgetLeft: 1e9 })).code).toBe(
      'bad_request',
    );
  });

  it('refuses a MIME the API has no block type for', async () => {
    await fs.writeFile(path.join(ws, 'a.zip'), 'PK');
    const out = await fileBlock({ client: fakeClient(), ref: 'a.zip', declaredMime: 'application/zip', inlineBudgetLeft: 1e9 });
    expect(out).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('buildInput', () => {
  it('puts the question BEFORE the files, as Google recommends', async () => {
    await fs.writeFile(path.join(ws, 'a.png'), PNG);
    const out = await buildInput({ client: fakeClient(), text: 'que vois-tu ?', attachments: ['a.png'] });
    expect(out.input[0]).toEqual({ type: 'text', text: 'que vois-tu ?' });
    expect(out.input[1].type).toBe('image');
  });

  it('REFUSES an attachment outside the workspace, before reading a single byte', async () => {
    for (const evil of ['../../etc/passwd', '/etc/shadow', '/workspace/../etc/passwd']) {
      const out = await buildInput({ client: fakeClient(), text: 'x', attachments: [evil] });
      expect(out.ok).toBe(false);
      expect(out.code).toBe('bad_request');
      expect(out.error).toMatch(/hors du workspace/);
    }
  });

  it('enforces the CUMULATIVE inline budget, not just the per-file size', async () => {
    // Three files, each under the per-file threshold, together over the budget:
    // the per-file check alone would build a request Google rejects at 20 MB.
    const chunk = Buffer.alloc(5 * 1024 * 1024, 1);
    for (const n of ['a.png', 'b.png', 'c.png']) await fs.writeFile(path.join(ws, n), chunk);
    const client = fakeClient();
    const out = await buildInput({ client, text: 'x', attachments: ['a.png', 'b.png', 'c.png'] });
    expect(out.ok).toBe(true);
    expect(out.uploaded).toBeGreaterThanOrEqual(1);
    expect(out.inlineBytes).toBeLessThanOrEqual(12 * 1024 * 1024);
  });

  it('caps the number of attachments', async () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}.png`);
    const out = await buildInput({ client: fakeClient(), text: 'x', attachments: many });
    expect(out).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('refuses a call with neither text nor file', async () => {
    expect(await buildInput({ client: fakeClient(), text: '   ', attachments: [] })).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
  });

  it('mixes local files and remote URLs in one input', async () => {
    await fs.writeFile(path.join(ws, 'a.png'), PNG);
    const out = await buildInput({
      client: fakeClient(),
      text: 'compare',
      attachments: ['a.png', 'https://youtu.be/xyz'],
    });
    expect(out.input.map((b) => b.type)).toEqual(['text', 'image', 'video']);
  });
});
