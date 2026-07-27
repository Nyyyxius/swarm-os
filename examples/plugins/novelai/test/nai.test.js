// Tests for `../lib/nai.js` — the NovelAI HTTP client.
//
// `fetch` is stubbed globally (`vi.stubGlobal`) and `backoffMs` is pinned to 0
// so the retry paths run at full speed. Four families of guarantee:
//
//  1. RETRY POLICY. 429 / 5xx / non-abort network errors get exactly ONE
//     retry; a 401 gets none; an AbortError gets NONE EITHER — retrying a
//     timeout is how a 45 s budget silently becomes 92 s. The deadline is
//     absolute and SHARED by both attempts, so a slow first attempt cancels
//     the second rather than restarting a full timer.
//  2. NOTHING THROWS. Every failure — including a full queue — is an
//     `{ok:false, code}` value. A throw reaches the host's guard() and counts
//     toward plugin quarantine (5 crashes / 60 s), so five agents calling in
//     parallel must not be able to quarantine the plugin.
//  3. A 200 IS NOT A SUCCESS. JSON without `output`, HTML from a CDN, or
//     base64-encoded tokens all have to become explicit codes: an `undefined`
//     reaching `structuredContent` makes the MCP SDK reject the whole
//     response with an opaque error instead of a readable `{ok:false}`.
//  4. THE SERIAL QUEUE. One request in flight, FIFO, a failed task does not
//     poison the chain, and `inflight`/`waiting` are counted separately.
//
// `chunkForTts` has its own file (chunk.test.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  API_HOST,
  contextCharsFor,
  createNaiClient,
  decodeJwtExp,
  LEGACY_TEXT_PATH,
  OA_MODELS_PATH,
  OA_TEXT_PATH,
  surfaceFor,
  TEXT_HOST,
} from '../lib/nai.js';

/** @type {ReturnType<typeof vi.fn>} */
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/** A fresh Response every call — a body can only be consumed once. */
const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const audioRes = (bytes = [0x4f, 0x67, 0x67, 0x53], contentType = 'audio/ogg; codecs=opus') =>
  new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': contentType } });

/** Prose: spaces and punctuation, so the tokenised-output heuristic stays off. */
const PROSE = 'The wizard raised his staff and the sky split open.';

const client = (over) =>
  createNaiClient({
    apiToken: 'test-token',
    timeoutMs: 2000,
    maxWaitMs: 2000,
    backoffMs: 0,
    ...over,
  });

describe('createNaiClient — retry policy', () => {
  it('retries a 429 once and succeeds on the second attempt', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response('{"message":"slow down"}', { status: 429 }))
      .mockImplementationOnce(async () => jsonRes({ output: PROSE }));

    const res = await client().generateText({ input: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: true, text: PROSE });
  });

  it('does NOT retry a 401 and reports `unauthorized`', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"statusCode":401,"message":"Invalid token"}', { status: 401 }),
    );

    const res = await client().generateText({ input: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('unauthorized');
    expect(res.error).toContain('Invalid token'); // NAI message surfaced verbatim
    expect(res.hint).toMatch(/30 jours/);
  });

  it('retries a 5xx once, then reports `upstream`', async () => {
    fetchMock.mockImplementation(async () => new Response('boom', { status: 503 }));

    const res = await client().generateText({ input: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('upstream');
    expect(res.error).toContain('503');
  });

  it('does NOT retry an AbortError and reports `timeout` after a single call', async () => {
    fetchMock.mockImplementation(async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const res = await client().generateText({ input: 'x' });

    // The correction that matters: one attempt, not two. A retried timeout
    // doubles a budget the caller already gave up on.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('timeout');
  });

  it('retries a non-abort network error once, then reports `upstream`', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    const res = await client().generateText({ input: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: false, code: 'upstream' });
  });

  it('shares one absolute deadline: a slow first attempt cancels the retry', async () => {
    // timeoutMs is 20 ms but the (unabortable) stub answers 429 after 60 ms:
    // by the time the retry decision is taken the budget is already spent, so
    // the original failure is reported instead of starting a fresh timer.
    fetchMock.mockImplementation(async () => {
      await delay(60);
      return new Response('{"message":"slow down"}', { status: 429 });
    });

    const res = await client({ timeoutMs: 20 }).generateText({ input: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, code: 'rate_limited' });
  });
});

describe('createNaiClient — a 200 is not automatically a success', () => {
  it('reports `bad_response` for JSON without an `output` field', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ error: 'nope' }));

    const res = await client().generateText({ input: 'x' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_response');
  });

  it('reports `bad_response` for HTML served with a 200 (CDN interstitial)', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<html><body>503 Service Unavailable</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const res = await client().generateText({ input: 'x' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_response');
  });

  it('reports `tokenized_output` when `output` is base64 tokens', async () => {
    const base64ish = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkwYWJjZGVm';
    fetchMock.mockImplementation(async () => jsonRes({ output: base64ish }));

    const res = await client().generateText({ input: 'x' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('tokenized_output');
    expect(res.hint).toMatch(/use_string/);
  });

  it('leaves ordinary prose alone (the heuristic must not eat a good generation)', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ output: PROSE }));

    const res = await client().generateText({ input: 'x' });

    expect(res).toMatchObject({ ok: true, text: PROSE });
  });

  it('reports `oversized` when the body exceeds maxBytes', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ output: 'z'.repeat(4096) }));

    const res = await client({ maxBytes: 128 }).generateText({ input: 'x' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('oversized');
  });
});

describe('createNaiClient — serial queue', () => {
  it('never lets two requests overlap', async () => {
    let concurrent = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await delay(20);
      concurrent -= 1;
      return jsonRes({ output: PROSE });
    });

    const c = client();
    const results = await Promise.all([
      c.generateText({ input: 'a' }),
      c.generateText({ input: 'b' }),
      c.generateText({ input: 'c' }),
    ]);

    expect(peak).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('serves callers in FIFO order', async () => {
    const seen = [];
    fetchMock.mockImplementation(async (_url, init) => {
      seen.push(JSON.parse(init.body).input);
      await delay(5);
      return jsonRes({ output: PROSE });
    });

    const c = client();
    await Promise.all(['a', 'b', 'c', 'd'].map((input) => c.generateText({ input })));

    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not let a failing task poison the chain', async () => {
    // A response object whose headers blow up escapes the `send` try/catch and
    // rejects the queued task — the one path that can reject `ran`.
    fetchMock
      .mockImplementationOnce(async () => ({
        status: 200,
        headers: {
          get() {
            throw new Error('boom');
          },
        },
      }))
      .mockImplementation(async () => jsonRes({ output: PROSE }));

    const c = client();
    const first = await c.generateText({ input: 'a' });
    const second = await c.generateText({ input: 'b' });

    expect(first).toMatchObject({ ok: false, code: 'internal' });
    expect(second).toMatchObject({ ok: true, text: PROSE }); // chain still alive
  });

  it('RETURNS {ok:false, code:"busy"} past maxWaitMs instead of throwing', async () => {
    fetchMock.mockImplementation(async () => {
      await delay(200);
      return jsonRes({ output: PROSE });
    });

    const c = client({ maxWaitMs: 20 });
    const first = c.generateText({ input: 'a' });
    const second = await c.generateText({ input: 'b' });

    // A full queue is a normal swarm condition. Encoding it as a throw would
    // be indistinguishable from a bug and would quarantine the plugin.
    expect(second.ok).toBe(false);
    expect(second.code).toBe('busy');
    expect(typeof second.error).toBe('string');

    expect(await first).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the abandoned task never ran
  });

  it('counts `inflight` and `waiting` separately', async () => {
    fetchMock.mockImplementation(async () => {
      await delay(50);
      return jsonRes({ output: PROSE });
    });

    const c = client();
    expect(c.stats()).toEqual({ inflight: 0, waiting: 0 });

    const a = c.generateText({ input: 'a' });
    const b = c.generateText({ input: 'b' });
    await delay(10);

    // The in-flight request must NOT be counted as waiting too — that off-by-one
    // made /status lie and halved the real queue budget.
    expect(c.stats()).toEqual({ inflight: 1, waiting: 1 });

    await Promise.all([a, b]);
    expect(c.stats()).toEqual({ inflight: 0, waiting: 0 });
  });
});

describe('generateText — request shape', () => {
  it('targets text.novelai.net and forces use_string even when the caller passes false', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ output: PROSE }));

    await client({ apiToken: 'secret-token' }).generateText({
      input: 'The wizard raised his staff and',
      model: 'kayra-v1',
      parameters: { max_length: 40, use_string: false },
    });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.protocol}//${parsed.host}`).toBe(TEXT_HOST);
    expect(parsed.pathname).toBe('/ai/generate');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('kayra-v1');
    expect(body.parameters.max_length).toBe(40);
    // Without a tokenizer the plugin cannot decode a tokenised answer, so the
    // caller does not get to turn this off.
    expect(body.parameters.use_string).toBe(true);
  });

  it('reports `not_configured` without touching the network when no token is set', async () => {
    const res = await createNaiClient({ apiToken: '  ' }).generateText({ input: 'x' });

    expect(res).toMatchObject({ ok: false, code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports `bad_request` for an empty input, without touching the network', async () => {
    const res = await client().generateText({ input: '' });

    expect(res).toMatchObject({ ok: false, code: 'bad_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('generateVoice — request shape', () => {
  it('targets api.novelai.net and carries voice / seed / version=v2 in the query', async () => {
    fetchMock.mockImplementation(async () => audioRes());

    const res = await client().generateVoice({ text: 'Bonjour, ceci est un test.', voice: 'Aulon', seedMix: 0.4 });

    expect(res.ok).toBe(true);
    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(res.contentType).toBe('audio/ogg; codecs=opus');

    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${parsed.protocol}//${parsed.host}`).toBe(API_HOST);
    expect(parsed.pathname).toBe('/ai/generate-voice');
    expect(parsed.searchParams.get('text')).toBe('Bonjour, ceci est un test.');
    // Both candidate voice parameters go out: v1 took a numeric `voice`, v2 is
    // reported to carry the voice NAME in `seed`.
    expect(parsed.searchParams.get('voice')).toBe('-1');
    expect(parsed.searchParams.get('seed')).toBe('Aulon');
    expect(parsed.searchParams.get('seed_mix')).toBe('0.4');
    expect(parsed.searchParams.get('version')).toBe('v2');
    expect(parsed.searchParams.get('opus')).toBe('true');
  });

  it('falls back to the default voice and omits seed_mix when unset', async () => {
    fetchMock.mockImplementation(async () => audioRes());

    await client().generateVoice({ text: 'Bonjour' });

    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get('seed')).toBe('Aini');
    expect(parsed.searchParams.has('seed_mix')).toBe(false);
  });

  it('reports `bad_response` when a 200 carries JSON instead of audio', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ statusCode: 200, message: 'nope' }));

    const res = await client().generateVoice({ text: 'Bonjour' });

    expect(res).toMatchObject({ ok: false, code: 'bad_response' });
  });
});

describe('decodeJwtExp', () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const jwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;

  it('reads the `exp` claim out of a valid token', () => {
    expect(decodeJwtExp(jwt({ sub: 'user', exp: 1893456000 }))).toBe(1893456000);
  });

  it('returns null — never throws — on every degraded shape', () => {
    const cases = [
      ['not a string', 42],
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
      ['two segments', 'aaa.bbb'],
      ['four segments', 'a.b.c.d'],
      ['empty payload segment', 'aaa..ccc'],
      ['invalid base64url', 'aaa.!!!!!.ccc'],
      ['payload is not JSON', `aaa.${Buffer.from('not json at all').toString('base64url')}.ccc`],
      ['payload is a JSON scalar', `aaa.${Buffer.from('null').toString('base64url')}.ccc`],
      ['no exp claim', jwt({ sub: 'user' })],
      ['non-numeric exp', jwt({ exp: 'tomorrow' })],
      ['NaN exp', `aaa.${Buffer.from('{"exp":null}').toString('base64url')}.ccc`],
    ];

    for (const [label, token] of cases) {
      let out;
      expect(() => {
        out = decodeJwtExp(/** @type {any} */ (token));
      }, label).not.toThrow();
      expect(out, label).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Two text surfaces
// ---------------------------------------------------------------------------
//
// NovelAI serves text through two mutually exclusive APIs on the same host, and
// a model sent to the wrong one answers **403** — the same status as an expired
// token. Three things have to hold or the failure is misdiagnosed as an auth
// problem and the operator goes looking for a token that is perfectly fine:
//
//  1. ROUTING. The legacy trio goes to /ai/generate; everything else, including
//     models that did not exist when this was written, goes to /oa/v1.
//  2. `wrong_surface` BEATS `unauthorized`. The message is the oracle, not the
//     status code.
//  3. SELF-CORRECTION. A wrong guess retries once on the other surface, inside
//     ONE queue slot, so a stale routing table costs a round trip and not a
//     broken tool.

describe('surfaceFor / contextCharsFor — routing table', () => {
  it('routes the closed legacy set to /ai/generate', () => {
    for (const m of ['llama-3-erato-v1', 'kayra-v1', 'clio-v1']) {
      expect(surfaceFor(m), m).toBe('legacy');
    }
  });

  it('routes everything else — including unknown models — to the OpenAI surface', () => {
    for (const m of ['xialong-v1', 'glm-4-6', 'un-modele-de-2027', '']) {
      expect(surfaceFor(m), m).toBe('oa');
    }
  });

  it('gives the roomier models a bigger story window', () => {
    expect(contextCharsFor('llama-3-erato-v1')).toBeLessThan(contextCharsFor('xialong-v1'));
  });
});

describe('generateText — per-surface wire format', () => {
  it('sends the legacy body to /ai/generate for Erato', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ output: PROSE }));

    const res = await client().generateText({
      input: 'x',
      model: 'llama-3-erato-v1',
      parameters: { max_length: 42, temperature: 0.8, stop_sequences: ['FIN'] },
    });

    expect(res).toMatchObject({ ok: true, text: PROSE });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEXT_HOST}${LEGACY_TEXT_PATH}`);
    const body = JSON.parse(init.body);
    expect(body.input).toBe('x');
    expect(body.parameters.max_length).toBe(42);
    expect(body.parameters.stop_sequences).toEqual(['FIN']);
    // Without use_string NovelAI answers with base64 tokens.
    expect(body.parameters.use_string).toBe(true);
  });

  it('translates the body to OpenAI names for xialong and reads choices[0].text', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ choices: [{ text: PROSE, token_ids: [1, 2] }] }));

    const res = await client().generateText({
      input: 'x',
      model: 'xialong-v1',
      parameters: { max_length: 42, temperature: 0.8, repetition_penalty: 1.1, stop_sequences: ['FIN'], min_length: 5 },
    });

    expect(res).toMatchObject({ ok: true, text: PROSE });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEXT_HOST}${OA_TEXT_PATH}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'xialong-v1',
      prompt: 'x',
      max_tokens: 42,
      temperature: 0.8,
      repetition_penalty: 1.1,
      stop: ['FIN'],
    });
    // Dropped rather than mistranslated: the OpenAI surface has no equivalent.
    expect(body.min_length).toBeUndefined();
    expect(body.input).toBeUndefined();
  });

  it('reports `tokenized_output` when the surface returns ids and an empty text', async () => {
    // Exactly what /oa/v1/chat/completions answers without stream:true.
    fetchMock.mockImplementation(async () => jsonRes({ choices: [{ text: '', token_ids: [198, 4438] }] }));

    const res = await client().generateText({ input: 'x', model: 'xialong-v1' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('tokenized_output');
  });

  it('reports `bad_response` when the OpenAI surface returns no choices', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ object: 'list' }));

    const res = await client().generateText({ input: 'x', model: 'xialong-v1' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_response');
  });
});

describe('generateText — surface self-correction', () => {
  /** NovelAI's own 403 for a model sent to the legacy API. Observed verbatim. */
  const WRONG_SURFACE_403 = new Response(
    '{"statusCode":403,"message":"model \'xialong-v1\' is only available via OpenAI-compatible API"}',
    { status: 403 },
  );

  it('does NOT report a wrong-surface 403 as an authentication failure', async () => {
    // A single attempt, so the mapping is observed without the retry masking it.
    fetchMock.mockImplementation(async () => WRONG_SURFACE_403.clone());

    const res = await client().generateText({ input: 'x', model: 'llama-3-erato-v1' });

    expect(res.ok).toBe(false);
    expect(res.code).not.toBe('unauthorized');
    expect(res.code).toBe('wrong_surface');
  });

  it('retries on the other surface and succeeds', async () => {
    fetchMock
      .mockImplementationOnce(async () => WRONG_SURFACE_403.clone())
      .mockImplementationOnce(async () => jsonRes({ choices: [{ text: PROSE }] }));

    // Erato routes to legacy first; NovelAI says otherwise; the client corrects.
    const res = await client().generateText({ input: 'x', model: 'llama-3-erato-v1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${TEXT_HOST}${LEGACY_TEXT_PATH}`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${TEXT_HOST}${OA_TEXT_PATH}`);
    expect(res).toMatchObject({ ok: true, text: PROSE, surface: 'oa' });
  });

  it('switches once and stops — it never ping-pongs between the two', async () => {
    fetchMock.mockImplementation(async () => WRONG_SURFACE_403.clone());

    const res = await client().generateText({ input: 'x', model: 'xialong-v1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wrong_surface');
  });

  it('holds a single queue slot across the switch', async () => {
    let inflightPeak = 0;
    let inflight = 0;
    fetchMock.mockImplementation(async () => {
      inflight += 1;
      inflightPeak = Math.max(inflightPeak, inflight);
      await delay(5);
      inflight -= 1;
      return WRONG_SURFACE_403.clone();
    });

    const c = client();
    await Promise.all([
      c.generateText({ input: 'a', model: 'xialong-v1' }),
      c.generateText({ input: 'b', model: 'xialong-v1' }),
    ]);

    expect(inflightPeak).toBe(1);
  });
});

describe('listModels — no more hardcoded allowlist', () => {
  it('extracts the ids the OpenAI surface advertises', async () => {
    fetchMock.mockImplementation(async () =>
      jsonRes({ object: 'list', data: [{ id: 'glm-4-6' }, { id: 'xialong-v1' }] }),
    );

    const res = await client().listModels();

    expect(fetchMock.mock.calls[0][0]).toBe(`${TEXT_HOST}${OA_MODELS_PATH}`);
    expect(res).toEqual({ ok: true, models: ['glm-4-6', 'xialong-v1'] });
  });

  it('skips malformed entries instead of returning holes', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ data: [{ id: 'ok' }, {}, { id: 42 }, null] }));

    const res = await client().listModels();

    expect(res).toEqual({ ok: true, models: ['ok'] });
  });

  it('reports `bad_response` when `data` is missing', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ object: 'list' }));

    const res = await client().listModels();

    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_response');
  });
});
