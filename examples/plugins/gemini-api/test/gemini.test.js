// Tests for `../lib/gemini.js` — the HTTP client.
//
// Four properties are pinned here, because each one is a promise the rest of the
// plugin relies on and none of them is visible from a passing happy path:
//
//  1. NO METHOD EVER THROWS. A throw would reach the host's guard() and count
//     toward plugin quarantine (5 crashes / 60 s), so an expired key or a full
//     queue must be a VALUE. Every failure case below asserts a shape, never a
//     rejection.
//  2. THE MAPPING IS THE DIAGNOSIS. Google answers an invalid API key with
//     **400**, not 401 — left unmapped, the single most common setup mistake
//     reads as "bad request" and sends the operator auditing their prompt.
//  3. BOUNDED TIME AND CONCURRENCY. One shared deadline across both attempts, a
//     timeout that is NEVER retried, and at most `maxConcurrent` calls in flight.
//  4. THREE RESPONSE SHAPES, ONE READER. The Interactions API moved from
//     `outputs[]` to `steps[]` mid-2026 and `:generateContent` still exists;
//     all three are read, or this plugin breaks on the next rename.

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  blockedReason,
  createGeminiClient,
  extractMedia,
  extractText,
  extractUsage,
  fail,
  mapStatus,
  parseError,
} from '../lib/gemini.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Build a JSON Response like the platform's fetch would. */
function jsonRes(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Google's error envelope. */
function googleError(message, extra = {}) {
  return { error: { code: 400, status: 'INVALID_ARGUMENT', message, ...extra } };
}

describe('parseError', () => {
  it('lifts the message out of the envelope', () => {
    expect(parseError(JSON.stringify(googleError('boom'))).message).toBe('boom');
  });

  it('reads the exact wait Google asks for in a quota error', () => {
    const body = JSON.stringify({ error: { message: 'quota', details: [{ retryDelay: '17s' }] } });
    expect(parseError(body).retryDelayMs).toBe(17000);
  });

  it('caps an absurd retryDelay rather than sleeping for an hour', () => {
    const body = JSON.stringify({ error: { message: 'q', details: [{ retryDelay: '3600s' }] } });
    expect(parseError(body).retryDelayMs).toBe(60000);
  });

  it('falls back to the raw text when the body is not JSON', () => {
    expect(parseError('<html>502</html>').message).toContain('502');
    expect(parseError('').message).toBe('');
  });
});

describe('mapStatus', () => {
  it('reads an invalid API key out of a 400 — Google does not send 401 for this', () => {
    const out = mapStatus(400, JSON.stringify(googleError('API key not valid. Please pass a valid API key.')));
    expect(out.code).toBe('unauthorized');
    expect(out.hint).toContain('apiKey');
  });

  it('keeps an ordinary 400 as a bad request', () => {
    expect(mapStatus(400, JSON.stringify(googleError('Invalid value for aspect_ratio'))).code).toBe('bad_request');
  });

  it('maps a renamed model to a code that names the fix', () => {
    const out = mapStatus(404, JSON.stringify(googleError('models/gemini-x is not found')));
    expect(out.code).toBe('model_not_found');
    expect(out.hint).toContain('/status');
  });

  it('separates a quota (429) from a permission problem (403)', () => {
    expect(mapStatus(429, '{}').code).toBe('rate_limited');
    expect(mapStatus(403, '{}').code).toBe('forbidden');
    expect(mapStatus(401, '{}').code).toBe('unauthorized');
  });

  it('puts an unlisted status in the honest bucket, with the number visible', () => {
    const out = mapStatus(503, '{}');
    expect(out.code).toBe('upstream');
    expect(out.error).toContain('503');
  });

  it('never throws on a garbage body', () => {
    expect(() => mapStatus(500, /** @type {never} */ (undefined))).not.toThrow();
  });
});

describe('response readers — three shapes, one plugin', () => {
  const steps = {
    steps: [
      {
        type: 'model_output',
        content: [
          { type: 'text', text: 'bon' },
          { type: 'text', text: 'jour' },
          { type: 'image', data: Buffer.from('PNG').toString('base64'), mime_type: 'image/png' },
        ],
      },
    ],
  };

  it('prefers the convenience field when the API supplies it', () => {
    expect(extractText({ output_text: 'direct', steps: [] })).toBe('direct');
  });

  it('concatenates text blocks of the current steps[] schema', () => {
    expect(extractText(steps)).toBe('bonjour');
  });

  it('still reads the legacy outputs[] revision', () => {
    expect(extractText({ outputs: [{ type: 'text', text: 'legacy' }] })).toBe('legacy');
  });

  it('still reads a classic :generateContent payload', () => {
    const classic = { candidates: [{ content: { parts: [{ text: 'classique' }] } }] };
    expect(extractText(classic)).toBe('classique');
  });

  it('decodes media out of any of the three shapes', () => {
    expect(extractMedia(steps, 'image')[0].data.toString()).toBe('PNG');
    expect(extractMedia({ output_audio: { data: 'QUJD', mime_type: 'audio/wav' } }, 'audio')[0].data.toString()).toBe(
      'ABC',
    );
    const classic = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }] };
    expect(extractMedia(classic, 'image')).toHaveLength(1);
  });

  it('collapses the same payload reported twice (convenience field AND its step)', () => {
    const both = {
      output_image: { data: 'QUJD', mime_type: 'image/png' },
      steps: [{ type: 'model_output', content: [{ type: 'image', data: 'QUJD', mime_type: 'image/png' }] }],
    };
    expect(extractMedia(both, 'image')).toHaveLength(1);
  });

  it('keeps a uri-only block — that is how Veo delivers a video', () => {
    const out = extractMedia({ output_video: { uri: 'https://x/v.mp4', mime_type: 'video/mp4' } }, 'video');
    expect(out).toHaveLength(1);
    expect(out[0].data).toBeNull();
    expect(out[0].uri).toBe('https://x/v.mp4');
  });

  it('ignores a block that is neither data nor uri', () => {
    expect(extractMedia({ steps: [{ content: [{ type: 'image' }] }] }, 'image')).toHaveLength(0);
  });

  it('reports a safety block only when the body actually says so', () => {
    expect(blockedReason({ prompt_feedback: { block_reason: 'SAFETY' } })).toBe('SAFETY');
    expect(blockedReason({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] })).toBe('PROHIBITED_CONTENT');
    expect(blockedReason({ candidates: [{ finishReason: 'STOP' }] })).toBeNull();
    expect(blockedReason({ output_text: '' })).toBeNull();
    expect(blockedReason(null)).toBeNull();
  });

  it('normalises usage across both spellings', () => {
    expect(extractUsage({ usage: { total_input_tokens: 3, total_tokens: 9 } })).toMatchObject({ input: 3, total: 9 });
    expect(extractUsage({ usageMetadata: { promptTokenCount: 4 } })).toMatchObject({ input: 4 });
    expect(extractUsage({})).toBeNull();
  });
});

describe('createGeminiClient — transport guarantees', () => {
  it('refuses every call with a readable code when no key is configured', async () => {
    const c = createGeminiClient({ apiKey: '' });
    for (const res of [
      await c.interact({ model: 'm', input: 'x' }),
      await c.listModels(),
      await c.startVideo({ model: 'm', instances: [{}] }),
      await c.operationStatus('op'),
      await c.uploadFile({ bytes: Buffer.from('x'), mimeType: 'text/plain' }),
    ]) {
      expect(res.ok).toBe(false);
      expect(res.code).toBe('not_configured');
    }
  });

  it('sends the key as a header and never in the URL', async () => {
    /** @type {any[]} */
    const seen = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      return jsonRes({ output_text: 'ok' });
    });
    const c = createGeminiClient({ apiKey: 'SECRET' });
    await c.interact({ model: 'm', input: 'x' });
    expect(seen[0].url).not.toContain('SECRET');
    expect(seen[0].headers['x-goog-api-key']).toBe('SECRET');
  });

  it('retries ONCE on a 503 and returns the successful body', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonRes({ error: { message: 'down' } }, 503) : jsonRes({ output_text: 'ok' });
    });
    const c = createGeminiClient({ apiKey: 'k', backoffMs: 0 });
    const res = await c.interact({ model: 'm', input: 'x' });
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('gives up after the single retry rather than hammering', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return jsonRes({ error: { message: 'down' } }, 503);
    });
    const c = createGeminiClient({ apiKey: 'k', backoffMs: 0 });
    expect((await c.interact({ model: 'm', input: 'x' })).code).toBe('upstream');
    expect(n).toBe(2);
  });

  it('does NOT retry a 400 — a bad request stays bad', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return jsonRes(googleError('nope'), 400);
    });
    const c = createGeminiClient({ apiKey: 'k', backoffMs: 0 });
    await c.interact({ model: 'm', input: 'x' });
    expect(n).toBe(1);
  });

  it('NEVER retries a timeout — that is how a 120 s budget becomes 240 s', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          n += 1;
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const c = createGeminiClient({ apiKey: 'k', timeoutMs: 60, maxWaitMs: 1000 });
    const res = await c.interact({ model: 'm', input: 'x' });
    expect(res.code).toBe('timeout');
    expect(n).toBe(1);
  });

  it('turns a network error into a value, not a rejection', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = createGeminiClient({ apiKey: 'k', backoffMs: 0 });
    const res = await c.interact({ model: 'm', input: 'x' });
    expect(res).toMatchObject({ ok: false, code: 'upstream' });
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('reports a 200 that is not JSON as bad_response instead of throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>hi</html>', { status: 200 }));
    const c = createGeminiClient({ apiKey: 'k' });
    expect((await c.interact({ model: 'm', input: 'x' })).code).toBe('bad_response');
  });

  it('caps an oversized response by its declared length, before reading it', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonRes({ big: 'x' }, 200, { 'content-length': String(99 * 1024 * 1024) }),
    );
    const c = createGeminiClient({ apiKey: 'k', maxBytes: 1024 });
    expect((await c.interact({ model: 'm', input: 'x' })).code).toBe('oversized');
  });

  it('holds concurrency at maxConcurrent and reports busy past the wait budget', async () => {
    let peak = 0;
    let cur = 0;
    globalThis.fetch = vi.fn(async () => {
      cur += 1;
      peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 40));
      cur -= 1;
      return jsonRes({ output_text: 'ok' });
    });
    const c = createGeminiClient({ apiKey: 'k', maxConcurrent: 2, maxWaitMs: 5000 });
    const all = await Promise.all(Array.from({ length: 6 }, () => c.interact({ model: 'm', input: 'x' })));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
    expect(c.stats()).toEqual({ inflight: 0, waiting: 0, maxConcurrent: 2 });

    const tight = createGeminiClient({ apiKey: 'k', maxConcurrent: 1, maxWaitMs: 5 });
    const [first, second] = await Promise.all([
      tight.interact({ model: 'm', input: 'a' }),
      tight.interact({ model: 'm', input: 'b' }),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'busy' });
  });

  it('grants a free slot synchronously — an idle plugin never waits', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ output_text: 'ok' }));
    // maxWaitMs of 0 would report `busy` immediately if the slot were granted
    // on a later tick instead of on push.
    const c = createGeminiClient({ apiKey: 'k', maxConcurrent: 1, maxWaitMs: 0 });
    expect((await c.interact({ model: 'm', input: 'x' })).ok).toBe(true);
  });

  it('strips the models/ prefix so the ids match what the config takes', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ models: [{ name: 'models/gemini-3.7-flash' }, { name: 'x' }] }));
    const c = createGeminiClient({ apiKey: 'k' });
    const res = await c.listModels();
    expect(res.models.map((m) => m.name)).toEqual(['gemini-3.7-flash', 'x']);
  });

  it('startVideo returns the operation name and refuses a body without one', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ name: 'models/veo/operations/1' }));
    const c = createGeminiClient({ apiKey: 'k' });
    expect(await c.startVideo({ model: 'veo', instances: [{ prompt: 'x' }] })).toMatchObject({
      ok: true,
      operation: 'models/veo/operations/1',
    });
    globalThis.fetch = vi.fn(async () => jsonRes({ nothing: true }));
    expect((await c.startVideo({ model: 'veo', instances: [{ prompt: 'x' }] })).code).toBe('bad_response');
  });

  it('separates a failed OPERATION from a failed POLL', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ done: true, error: { message: 'safety' } }));
    const c = createGeminiClient({ apiKey: 'k' });
    const res = await c.operationStatus('models/veo/operations/1');
    // The poll SUCCEEDED; the job failed. Conflating them would make the caller
    // retry a job Google has already given up on.
    expect(res.ok).toBe(true);
    expect(res.done).toBe(true);
    expect(res.failure).toMatchObject({ code: 'generation_failed' });
  });

  it('downloads to disk and removes the partial file when the cap is exceeded', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemini-dl-'));
    const target = path.join(dir, 'v.mp4');

    globalThis.fetch = vi.fn(async () => new Response(Buffer.alloc(2048, 1), { status: 200 }));
    const c = createGeminiClient({ apiKey: 'k' });
    expect(await c.downloadToFile({ uri: 'https://x/v.mp4', absPath: target, maxBytes: 4096 })).toMatchObject({
      ok: true,
      bytes: 2048,
    });
    expect((await fsp.stat(target)).size).toBe(2048);

    const res = await c.downloadToFile({ uri: 'https://x/v.mp4', absPath: target, maxBytes: 10 });
    expect(res.code).toBe('oversized');
    // A half-written file that looks like a video is worse than no file at all.
    await expect(fsp.access(target)).rejects.toThrow();
  });

  it('uploads in two steps and carries the session URL from the first to the second', async () => {
    /** @type {string[]} */
    const urls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      urls.push(String(url));
      if (String(url).includes('/upload/v1beta/files')) {
        expect(init.headers['X-Goog-Upload-Header-Content-Length']).toBe('3');
        return new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
      }
      return jsonRes({ file: { name: 'files/a', uri: 'https://f/a', mimeType: 'image/png', state: 'ACTIVE' } });
    });
    const c = createGeminiClient({ apiKey: 'k' });
    const res = await c.uploadFile({ bytes: Buffer.from('abc'), mimeType: 'image/png' });
    expect(res).toMatchObject({ ok: true, uri: 'https://f/a', state: 'ACTIVE' });
    expect(urls[1]).toBe('https://upload.test/session');
  });

  it('reports a missing upload session header instead of uploading into the void', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 }));
    const c = createGeminiClient({ apiKey: 'k' });
    expect((await c.uploadFile({ bytes: Buffer.from('abc'), mimeType: 'image/png' })).code).toBe('bad_response');
  });
});

describe('fail', () => {
  it('omits the hint key entirely rather than setting it to undefined', () => {
    expect(fail('x', 'y')).toEqual({ ok: false, code: 'x', error: 'y' });
    expect(fail('x', 'y', 'z')).toEqual({ ok: false, code: 'x', error: 'y', hint: 'z' });
  });
});
