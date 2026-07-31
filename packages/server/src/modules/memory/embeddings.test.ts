import { describe, it, expect } from 'vitest';
import {
  HashingEmbeddingProvider,
  NoneEmbeddingProvider,
  ApiEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
  encodeVector,
  decodeVector,
} from './embeddings.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical, ~0 for orthogonal, 0 for degenerate', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    const c = Float32Array.from([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, new Float32Array(0))).toBe(0);
    expect(cosineSimilarity(a, Float32Array.from([0, 0, 0]))).toBe(0);
  });
});

describe('encodeVector / decodeVector', () => {
  it('round-trips a Float32 vector through a BLOB', () => {
    const v = Float32Array.from([0.5, -0.25, 1, 0]);
    const back = decodeVector(encodeVector(v));
    expect(back.length).toBe(4);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i]!, 6);
  });
});

describe('HashingEmbeddingProvider', () => {
  it('is deterministic, unit-normalized, and fixed-dimension', async () => {
    const p = new HashingEmbeddingProvider(128);
    expect(p.dim).toBe(128);
    const v1 = await p.embedOne('parser refactor for the alpha release');
    const v2 = await p.embedOne('parser refactor for the alpha release');
    expect(v1).not.toBeNull();
    expect(v1!.length).toBe(128);
    // identical input → identical vector
    for (let i = 0; i < v1!.length; i++) expect(v2![i]).toBe(v1![i]);
    // L2-normalized
    let n = 0;
    for (const x of v1!) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 5);
  });

  it('ranks related text above unrelated (a real cosine ranking)', async () => {
    const p = new HashingEmbeddingProvider(512);
    const q = (await p.embedOne('database migration and schema upgrade'))!;
    const related = (await p.embedOne('we migrated the database schema'))!;
    const unrelated = (await p.embedOne('the cat sat quietly on a warm mat'))!;
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated));
  });

  it('shares signal via char n-grams for morphological variants', async () => {
    const p = new HashingEmbeddingProvider(512);
    const q = (await p.embedOne('parsing'))!;
    const variant = (await p.embedOne('parser'))!;
    const other = (await p.embedOne('zebra'))!;
    expect(cosineSimilarity(q, variant)).toBeGreaterThan(cosineSimilarity(q, other));
  });
});

describe('NoneEmbeddingProvider', () => {
  it('embeds nothing and reports semantic unavailable', async () => {
    const p = new NoneEmbeddingProvider();
    expect(await p.embedOne('anything')).toBeNull();
    expect(await p.embed(['a', 'b'])).toEqual([null, null]);
    expect(p.capabilities()).toEqual({
      semantic: false,
      degraded: false,
      provider: 'none',
      model: 'none',
      dim: 0,
    });
  });
});

describe('ApiEmbeddingProvider', () => {
  it('parses an OpenAI-style response, honouring per-item index', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const p = new ApiEmbeddingProvider({
      endpoint: 'https://example.test/embeddings',
      model: 'fake-embed',
      fetchImpl,
    });
    const out = await p.embed(['first', 'second']);
    expect(out[0]).not.toBeNull();
    expect(Array.from(out[0]!)).toEqual([1, 0, 0]); // index 0 → first
    expect(Array.from(out[1]!)).toEqual([0, 1, 0]);
    expect(p.dim).toBe(3); // learned from the response
    expect(p.capabilities().degraded).toBe(false);
  });

  it('never throws on a non-200 — returns nulls', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const p = new ApiEmbeddingProvider({
      endpoint: 'https://example.test/embeddings',
      model: 'fake-embed',
      fetchImpl,
    });
    expect(await p.embed(['x'])).toEqual([null]);
  });

  it('never throws on a network error — returns nulls', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const p = new ApiEmbeddingProvider({
      endpoint: 'https://example.test/embeddings',
      model: 'fake-embed',
      fetchImpl,
    });
    expect(await p.embedOne('x')).toBeNull();
  });
});

describe('createEmbeddingProvider', () => {
  it('defaults to the local hash provider when nothing is configured', () => {
    const p = createEmbeddingProvider({});
    expect(p.kind).toBe('hash');
    expect(p.capabilities().semantic).toBe(true);
    expect(p.capabilities().degraded).toBe(true);
  });

  it('honours provider=none', () => {
    const p = createEmbeddingProvider({ SWARM_OS_MEMORY_EMBED_PROVIDER: 'none' });
    expect(p.kind).toBe('none');
  });

  it('builds an api provider when endpoint+model are present', () => {
    const p = createEmbeddingProvider({
      SWARM_OS_MEMORY_EMBED_PROVIDER: 'openai',
      SWARM_OS_MEMORY_EMBED_ENDPOINT: 'https://api.openai.com/v1/embeddings',
      SWARM_OS_MEMORY_EMBED_MODEL: 'text-embedding-3-small',
      SWARM_OS_MEMORY_EMBED_API_KEY: 'sk-test',
    });
    expect(p.kind).toBe('api');
    expect(p.model).toBe('text-embedding-3-small');
  });

  it('falls back to hash when api is selected but misconfigured', () => {
    const p = createEmbeddingProvider({ SWARM_OS_MEMORY_EMBED_PROVIDER: 'api' });
    expect(p.kind).toBe('hash');
  });

  it('falls back to hash on an unknown provider value', () => {
    const p = createEmbeddingProvider({ SWARM_OS_MEMORY_EMBED_PROVIDER: 'wat' });
    expect(p.kind).toBe('hash');
  });
});
