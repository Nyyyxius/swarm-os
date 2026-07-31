/**
 * Embedding providers for the shared-memory semantic search (Phase 5,
 * docs/memoire-partagee.md §10). PLUGGABLE with GRACEFUL DEGRADATION — the
 * single load-bearing design point here.
 *
 * The 24/7 server must NEVER crash or block because embeddings are not
 * configured. So there are three provider kinds, chosen by env at boot:
 *
 *   - `hash`  (DEFAULT, no config) — a deterministic, offline, testable
 *     feature-hashing embedding (word + char n-grams → fixed-dim L2-normalized
 *     vector). It is NOT model "meaning", but it yields a REAL cosine ranking
 *     that beats exact FTS on partial / fuzzy overlap, and it needs no network.
 *     Semantic search is therefore ALWAYS available (flagged `degraded`).
 *   - `api`   (opt-in) — calls an OpenAI-compatible `/embeddings` endpoint when
 *     `SWARM_OS_MEMORY_EMBED_*` is set. Timeout-guarded; failures are logged
 *     and surface as `null` vectors, NEVER thrown.
 *   - `none`  (opt-out) — `SWARM_OS_MEMORY_EMBED_PROVIDER=none`. Semantic search
 *     reports unavailable and callers fall back to FTS. Nothing is embedded.
 *
 * Env vars (all optional):
 *   SWARM_OS_MEMORY_EMBED_PROVIDER   hash (default) | openai | api | none
 *   SWARM_OS_MEMORY_EMBED_ENDPOINT   e.g. https://api.openai.com/v1/embeddings
 *   SWARM_OS_MEMORY_EMBED_MODEL      e.g. text-embedding-3-small
 *   SWARM_OS_MEMORY_EMBED_API_KEY    bearer secret for the endpoint
 *   SWARM_OS_MEMORY_EMBED_DIM        vector dimension (hash: 256; api: model default)
 *   SWARM_OS_MEMORY_EMBED_TIMEOUT_MS network timeout (default 10000)
 *
 * A misconfigured `api` (endpoint/key missing) degrades to `hash` with a
 * warning rather than failing the boot.
 */

import { withModule } from '../../logger.js';

const log = withModule('memory.embeddings');

/** How a provider produces vectors — drives the capability flags below. */
export type EmbeddingKind = 'hash' | 'api' | 'none';

export interface EmbeddingCapabilities {
  /** Is semantic search usable at all (provider !== 'none')? */
  semantic: boolean;
  /**
   * True when backed by the local hash fallback — a real ranking, but lexical,
   * not model "meaning". The UI uses this to label the semantic option honestly
   * while still keeping it enabled.
   */
  degraded: boolean;
  /** Active provider kind. */
  provider: EmbeddingKind;
  /** Model identifier stored alongside each vector (so stale vectors re-derive). */
  model: string;
  /** Vector dimension. 0 when `provider === 'none'`. */
  dim: number;
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingKind;
  /** Model id, persisted with each vector to detect provider/model changes. */
  readonly model: string;
  /** Vector dimension (0 for `none`). */
  readonly dim: number;
  /**
   * Embed a batch. Returns one vector per input, in order; a `null` entry means
   * that item could not be embedded (the caller keeps the previous/absent
   * vector). NEVER throws — network/timeout failures are logged and mapped to
   * `null`s.
   */
  embed(texts: string[]): Promise<Array<Float32Array | null>>;
  /** Convenience for a single text. */
  embedOne(text: string): Promise<Float32Array | null>;
  /** Snapshot of what this provider offers, for `/api/memory/capabilities`. */
  capabilities(): EmbeddingCapabilities;
}

// --- vector math + (de)serialization ---------------------------------------

/** Cosine similarity, robust to non-normalized inputs. Returns 0 on degenerate. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2-normalize in place; a zero vector is left as-is. */
function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (n > 0) {
    const inv = 1 / Math.sqrt(n);
    for (let i = 0; i < v.length; i++) v[i]! *= inv;
  }
  return v;
}

/** Encode a vector to a compact little-endian Float32 BLOB for SQLite. */
export function encodeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Decode a Float32 BLOB back to a vector (alignment-safe). */
export function decodeVector(buf: Buffer): Float32Array {
  const n = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// --- hashing (local, deterministic) provider -------------------------------

/** FNV-1a 32-bit hash of a string with a salt — deterministic, fast, no deps. */
function fnv1a(str: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const DEFAULT_HASH_DIM = 256;

/**
 * Deterministic feature-hashing embedding. Features = lowercased word tokens
 * plus character 3-grams of each token (so `parser` and `parse` share n-grams
 * and land near each other). Each feature is hashed into a bucket with a signed
 * hash; the accumulated vector is L2-normalized. Same input → same vector,
 * always — which is exactly what makes it unit-testable with no network.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'hash' as const;
  readonly model: string;
  readonly dim: number;

  constructor(dim: number = DEFAULT_HASH_DIM) {
    this.dim = dim > 0 ? Math.floor(dim) : DEFAULT_HASH_DIM;
    this.model = `hash-v1-${this.dim}`;
  }

  private features(text: string): string[] {
    const tokens = (text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const feats: string[] = [];
    for (const tok of tokens) {
      feats.push(`w:${tok}`);
      // char 3-grams with word boundaries for sub-word similarity
      const padded = `#${tok}#`;
      for (let i = 0; i + 3 <= padded.length; i++) {
        feats.push(`g:${padded.slice(i, i + 3)}`);
      }
    }
    return feats;
  }

  embedSync(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const f of this.features(text)) {
      const h = fnv1a(f, 0);
      const idx = h % this.dim;
      // independent sign hash so collisions don't all add constructively
      const sign = (fnv1a(f, 0x9e3779b9) & 1) === 0 ? 1 : -1;
      v[idx]! += sign;
    }
    return l2Normalize(v);
  }

  async embed(texts: string[]): Promise<Array<Float32Array | null>> {
    return texts.map((t) => this.embedSync(t));
  }

  async embedOne(text: string): Promise<Float32Array | null> {
    return this.embedSync(text);
  }

  capabilities(): EmbeddingCapabilities {
    return { semantic: true, degraded: true, provider: 'hash', model: this.model, dim: this.dim };
  }
}

// --- disabled provider ------------------------------------------------------

/** Semantic search off. Everything returns "unavailable"; nothing is embedded. */
export class NoneEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'none' as const;
  readonly model = 'none';
  readonly dim = 0;
  async embed(texts: string[]): Promise<Array<Float32Array | null>> {
    return texts.map(() => null);
  }
  async embedOne(): Promise<Float32Array | null> {
    return null;
  }
  capabilities(): EmbeddingCapabilities {
    return { semantic: false, degraded: false, provider: 'none', model: 'none', dim: 0 };
  }
}

// --- API (OpenAI-compatible) provider ---------------------------------------

export interface ApiEmbeddingOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Declared dimension; if 0/unknown it is learned from the first response. */
  dim?: number;
  timeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Calls an OpenAI-compatible embeddings endpoint. Timeout-guarded via
 * AbortController; ANY failure (network, non-200, malformed body, timeout) is
 * logged and returned as `null` vectors — it never throws, so a note write or a
 * search is never taken down by the embedding backend being unreachable.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'api' as const;
  readonly model: string;
  private declaredDim: number;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiEmbeddingOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.declaredDim = opts.dim && opts.dim > 0 ? Math.floor(opts.dim) : 0;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get dim(): number {
    return this.declaredDim;
  }

  async embed(texts: string[]): Promise<Array<Float32Array | null>> {
    if (texts.length === 0) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log.warn({ event: 'memory.embed_http_error', status: res.status });
        return texts.map(() => null);
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const data = json?.data;
      if (!Array.isArray(data)) {
        log.warn({ event: 'memory.embed_bad_body' });
        return texts.map(() => null);
      }
      const out: Array<Float32Array | null> = texts.map(() => null);
      for (let i = 0; i < data.length; i++) {
        const entry = data[i]!;
        const idx = typeof entry.index === 'number' ? entry.index : i;
        const emb = entry.embedding;
        if (Array.isArray(emb) && emb.length > 0 && idx >= 0 && idx < out.length) {
          const v = Float32Array.from(emb);
          if (this.declaredDim === 0) this.declaredDim = v.length;
          out[idx] = v;
        }
      }
      return out;
    } catch (err) {
      log.warn({ event: 'memory.embed_failed', error: String(err) });
      return texts.map(() => null);
    } finally {
      clearTimeout(timer);
    }
  }

  async embedOne(text: string): Promise<Float32Array | null> {
    const [v] = await this.embed([text]);
    return v ?? null;
  }

  capabilities(): EmbeddingCapabilities {
    return {
      semantic: true,
      degraded: false,
      provider: 'api',
      model: this.model,
      dim: this.declaredDim,
    };
  }
}

// --- factory ----------------------------------------------------------------

/** Read a positive integer env var, or a fallback. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build the embedding provider from the environment. Total function: on any
 * misconfiguration it logs and falls back to the safe local `hash` provider —
 * boot never fails because of embeddings.
 */
export function createEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const raw = (env.SWARM_OS_MEMORY_EMBED_PROVIDER ?? 'hash').trim().toLowerCase();

  if (raw === 'none' || raw === 'off' || raw === 'disabled') {
    log.info({ event: 'memory.embed_provider', provider: 'none' });
    return new NoneEmbeddingProvider();
  }

  if (raw === 'api' || raw === 'openai' || raw === 'http') {
    const endpoint = (env.SWARM_OS_MEMORY_EMBED_ENDPOINT ?? '').trim();
    const model = (env.SWARM_OS_MEMORY_EMBED_MODEL ?? '').trim();
    const apiKey = (env.SWARM_OS_MEMORY_EMBED_API_KEY ?? '').trim() || undefined;
    if (!endpoint || !model) {
      log.warn({
        event: 'memory.embed_provider_misconfigured',
        note: 'SWARM_OS_MEMORY_EMBED_PROVIDER=api but ENDPOINT/MODEL missing — falling back to local hash provider',
      });
      return new HashingEmbeddingProvider(envInt('SWARM_OS_MEMORY_EMBED_DIM', DEFAULT_HASH_DIM));
    }
    log.info({ event: 'memory.embed_provider', provider: 'api', model });
    return new ApiEmbeddingProvider({
      endpoint,
      model,
      apiKey,
      dim: envInt('SWARM_OS_MEMORY_EMBED_DIM', 0),
      timeoutMs: envInt('SWARM_OS_MEMORY_EMBED_TIMEOUT_MS', 10_000),
    });
  }

  // default + any unknown value → safe local hash provider
  if (raw && raw !== 'hash') {
    log.warn({ event: 'memory.embed_provider_unknown', value: raw, note: 'using local hash provider' });
  } else {
    log.info({ event: 'memory.embed_provider', provider: 'hash' });
  }
  return new HashingEmbeddingProvider(envInt('SWARM_OS_MEMORY_EMBED_DIM', DEFAULT_HASH_DIM));
}
