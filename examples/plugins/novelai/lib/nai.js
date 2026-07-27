// nai.js — NovelAI HTTP client: text generation (Erato) + TTS, over native fetch.
//
// Node 22 globals only (fetch / AbortController / Buffer) — no SDK, no deps.
// Four properties this module exists to guarantee:
//
//  1. TWO HOSTS. NovelAI serves text from text.novelai.net and everything else
//     from api.novelai.net, so the base URL is chosen PER ENDPOINT — there is
//     deliberately no single BASE_URL constant to get wrong.
//  2. NO METHOD EVER THROWS. Every failure is an {ok:false, code, error, hint?}
//     value. A throw would reach the host's guard() and count toward plugin
//     quarantine (5 crashes / 60 s -> backoff up to 1 h; host.ts:61-62 and
//     :1066-1070). A full queue or an expired token is not a crash.
//  3. BOUNDED TIME. One absolute deadline per public call (timeoutMs, default
//     45 s) SHARED by both attempts; at most ONE retry, only on 429 / 5xx /
//     non-abort network errors. An AbortError is NEVER retried — retrying a
//     timeout is how a 45 s budget silently becomes 92 s.
//  4. SERIAL QUEUE. NovelAI rate-limits per ACCOUNT, so five workers calling in
//     parallel produce cascading 429s that retries make worse. One request in
//     flight at a time; the queue bounds the WAIT in milliseconds (maxWaitMs),
//     not its depth — waiting time is the quantity the caller cares about.
//     Over budget returns code:'busy', a normal condition, never an exception.
//
// NO MUTABLE MODULE STATE. The loader's ESM cache-buster only applies to the
// entry point (loader.ts:29-30); `new URL('./lib/nai.js', '...index.js?v=abc')`
// DROPS the query, so this module stays in Node's ESM cache across plugin
// reloads. All state lives in the closure created by createNaiClient().
//
// KNOWN UNKNOWN — the TTS v2 voice parameter. Public sources disagree: v1 took
// a numeric `voice`, v2 is reported to carry the VOICE NAME in `seed` with
// `voice=-1`. We send BOTH, plus `seed_mix` when a numeric mix is requested.
// The failure mode to fear is not a 400 (it would surface verbatim) but a
// silently ignored parameter: valid audio, wrong voice, HTTP 200, no signal.
// Only the differential probe on the /status route can observe that.

/** Text generation lives on its own host. */
export const TEXT_HOST = 'https://text.novelai.net';
/** Everything else (TTS, account) lives here. */
export const API_HOST = 'https://api.novelai.net';

// --- TWO TEXT SURFACES, DISJOINT MODEL SETS --------------------------------
//
// NovelAI serves text through two mutually exclusive APIs on the SAME host, and
// says so itself when you get it wrong (both messages observed verbatim):
//   POST /ai/generate        + xialong-v1        -> 403 "model 'xialong-v1' is
//                                                   only available via
//                                                   OpenAI-compatible API"
//   POST /oa/v1/completions  + llama-3-erato-v1  -> 400 "Model '…' not available
//                                                   via OpenAI-compatible API.
//                                                   Use main NovelAI API."
//
// Hence a routing TABLE rather than a single path. Two deliberate choices:
//
//  - UNKNOWN MODELS GO TO /oa/v1. The legacy set is closed and historical; every
//    model NovelAI has added since (glm-4-6, xialong-v1) appears on the OpenAI
//    surface and is discoverable via `GET /oa/v1/models`. Guessing OA is the bet
//    that ages well.
//  - A WRONG GUESS SELF-CORRECTS. `mapStatus` turns those two messages into
//    code:'wrong_surface' and `generateText` retries once on the other surface
//    inside the SAME queue slot and the SAME deadline. A model list that goes
//    stale therefore costs one extra round trip, not a broken tool.
//
// AVOID `/oa/v1/chat/completions`: without `stream:true` it answers HTTP 200
// with `text:""` and a raw `token_ids[]` array and NO `message.content` — seven
// candidate knobs (use_string, skip_special_tokens, return_token_ids, …) were
// tried and none detokenises it. `/oa/v1/completions` returns plain prose.

/** `POST` here for Erato / Kayra / Clio. Body `{input, model, parameters}`. */
export const LEGACY_TEXT_PATH = '/ai/generate';
/** `POST` here for glm-4-6 / xialong-v1. OpenAI-ish `{prompt, max_tokens, …}`. */
export const OA_TEXT_PATH = '/oa/v1/completions';
/** `GET` here to discover the models the OpenAI-compatible surface serves. */
export const OA_MODELS_PATH = '/oa/v1/models';

/** The closed, historical set served by `/ai/generate`. Everything else: OA. */
const LEGACY_MODELS = new Set(['llama-3-erato-v1', 'kayra-v1', 'clio-v1']);

/**
 * Which surface serves `model`. Unknown -> 'oa' (see the note above).
 *
 * @param {string} model
 * @returns {'legacy'|'oa'}
 */
export function surfaceFor(model) {
  return LEGACY_MODELS.has(String(model)) ? 'legacy' : 'oa';
}

/**
 * Characters of story context worth sending for `model`. Erato's window is
 * ~8k TOKENS, so 3000 characters leaves ample room for memory and generation;
 * the OpenAI-surface models are far roomier.
 *
 * @param {string} model
 * @returns {number}
 */
export function contextCharsFor(model) {
  return surfaceFor(model) === 'legacy' ? 3000 : 8000;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_WAIT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TEXT_MODEL = 'llama-3-erato-v1';
const DEFAULT_VOICE = 'Aini';

/** NovelAI error bodies are `{statusCode, message}`; surface `message` capped. */
const MESSAGE_CAP = 300;
/** Hard ceiling on TTS pieces so an agent cannot queue a novel. */
const MAX_TTS_CHUNKS = 12;
/** Default TTS chunk size — NovelAI caps a single call around 1000 characters. */
const DEFAULT_TTS_LIMIT = 900;

// Operator/agent-facing strings follow the repo convention: French, no accents.
const HINT_UNAUTHORIZED =
  'les tokens persistants durent 30 jours ; regenere-le dans les reglages du compte NovelAI';
const HINT_TIMEOUT =
  'la generation a peut-etre abouti cote NovelAI ; regarde dans le dossier de sortie avant de relancer';
const HINT_TOKENIZED =
  "le compte/modele renvoie des tokens encodes ; use_string n'est pas honore — voir README";

// ---------------------------------------------------------------------------
// Pure helpers (exported surface + internals)
// ---------------------------------------------------------------------------

/**
 * Split `text` into TTS-sized pieces on sentence boundaries (`.` `!` `?` `…`),
 * falling back to newlines and then to a hard cut. Pure: no I/O, no state.
 *
 * Guarantees: no piece exceeds `limit`, no piece is blank, at most 12 pieces
 * (extra text is dropped — the caller is expected to report the truncation).
 *
 * @param {string} text
 * @param {number} [limit] max characters per piece (default 900)
 * @returns {string[]}
 */
export function chunkForTts(text, limit = DEFAULT_TTS_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TTS_LIMIT;
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  if (!src.trim()) return [];

  // 1. sentences -> 2. lines -> 3. hard cut, so every piece is <= max.
  /** @type {string[]} */
  const pieces = [];
  for (const sentence of splitSentences(src)) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    for (const line of splitLines(sentence)) {
      if (line.length <= max) {
        pieces.push(line);
        continue;
      }
      for (let i = 0; i < line.length; i += max) pieces.push(line.slice(i, i + max));
    }
  }

  // Greedily pack the pieces back up to `max`.
  /** @type {string[]} */
  const packed = [];
  let cur = '';
  for (const piece of pieces) {
    if (cur && cur.length + piece.length > max) {
      packed.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  }
  if (cur) packed.push(cur);

  // Trimming can only shrink a piece, so the <= max invariant survives it.
  return packed.map((c) => c.trim()).filter((c) => c.length > 0).slice(0, MAX_TTS_CHUNKS);
}

/** Cut on sentence terminators, keeping the terminator (and closing quotes). */
function splitSentences(s) {
  const TERMINATORS = '.!?…';
  const CLOSERS = '"\')”’]';
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (!TERMINATORS.includes(s[i])) continue;
    let end = i;
    while (end + 1 < s.length && TERMINATORS.includes(s[end + 1])) end += 1;
    while (end + 1 < s.length && CLOSERS.includes(s[end + 1])) end += 1;
    i = end;
    const next = s[end + 1];
    // Only a real boundary when whitespace or end-of-text follows ("3.5" stays).
    if (next !== undefined && !/\s/.test(next)) continue;
    out.push(s.slice(start, end + 1));
    start = end + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Cut on newlines, keeping the newline attached to the line before it. */
function splitLines(s) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\n') continue;
    out.push(s.slice(start, i + 1));
    start = i + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Read the `exp` claim (epoch seconds) out of a JWT payload. A NovelAI
 * persistent token is a JWT, so its own expiry is readable locally — no network
 * call, and it works while NovelAI itself is down.
 *
 * Degrades to `null` on anything unexpected (not 3 segments, bad base64url,
 * invalid JSON, non-numeric `exp`) and NEVER throws. The decoded payload is
 * never logged, returned or otherwise surfaced — only `exp` leaves this
 * function. Pure: no I/O, no state.
 *
 * @param {string} token
 * @returns {number|null} epoch seconds, or null
 */
export function decodeJwtExp(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    const exp = /** @type {any} */ (payload).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Same expiry, in epoch MILLISECONDS — the shape every caller actually wants.
 *
 * RFC 7519 defines `exp` in SECONDS, hence the scaling; the `< 1e12` guard keeps
 * a token that already carries milliseconds from being pushed 30 000 years out.
 * Lives here rather than in each caller so the rule has ONE home: `index.js`
 * (activation warning, daily probe) and `lib/tools.js` (`/status`) both need it,
 * and two copies of a date rule drift.
 *
 * @param {string} token
 * @returns {number|null} epoch milliseconds, or null
 */
export function jwtExpMs(token) {
  const exp = decodeJwtExp(token);
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
  return exp < 1e12 ? exp * 1000 : exp;
}

/** `{statusCode, message}` -> `message` verbatim, capped; else the raw body. */
function naiMessage(bodyText) {
  const raw = typeof bodyText === 'string' ? bodyText : '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === 'string') return parsed.message.slice(0, MESSAGE_CAP);
  } catch {
    // Not JSON (HTML from a CDN, empty body) — fall through to the raw text.
  }
  return raw.trim().slice(0, MESSAGE_CAP);
}

/**
 * NovelAI naming the OTHER API in an error body. Checked BEFORE the 401/403
 * branch on purpose: a model sent to the wrong surface answers **403**, which
 * would otherwise be reported as "token invalide ou expire" and send the
 * operator hunting for an authentication problem that does not exist.
 */
const WRONG_SURFACE_RE = /openai-compatible api|use main novelai api/i;

/** Map a non-2xx NovelAI response to a stable code. Never throws. */
function mapStatus(status, bodyText) {
  const msg = naiMessage(bodyText);
  const withMsg = (base) => (msg ? `${base}: ${msg}` : base);

  if (WRONG_SURFACE_RE.test(msg)) {
    return fail(
      'wrong_surface',
      msg,
      "ce modele est servi par l'autre API NovelAI ; le plugin reessaie automatiquement sur la bonne",
    );
  }
  if (status === 401 || status === 403) {
    return fail('unauthorized', withMsg('token NovelAI invalide ou expire'), HINT_UNAUTHORIZED);
  }
  if (status === 402) {
    return fail(
      'payment_required',
      withMsg('abonnement NovelAI requis'),
      'un abonnement NovelAI actif est necessaire pour cet endpoint',
    );
  }
  if (status === 429) {
    return fail(
      'rate_limited',
      withMsg('trop de requetes cote compte NovelAI'),
      'trop de requetes cote compte ; reessaie dans quelques secondes',
    );
  }
  if (status === 400 || status === 422) {
    return fail(
      'bad_request',
      msg || `requete refusee par NovelAI (${status})`,
      "l'API NovelAI n'est pas documentee publiquement ; verifie le modele et les parametres",
    );
  }
  // 5xx and every other unlisted status: upstream is the honest bucket — the
  // status is in the message, so the exact code stays diagnosable.
  return fail(
    'upstream',
    withMsg(`NovelAI indisponible (HTTP ${status})`),
    'deja reessaye une fois ; reessaie plus tard',
  );
}

/** @returns {{ok:false, code:string, error:string, hint?:string}} */
function fail(code, error, hint) {
  return hint ? { ok: false, code, error, hint } : { ok: false, code, error };
}

function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * `/ai/generate` body. `use_string` is forced ON: without it NovelAI answers
 * with base64-encoded tokens this plugin has no tokenizer to decode.
 *
 * @param {string} input @param {string} model @param {Record<string, unknown>} p
 */
function legacyTextBody(input, model, p) {
  return { input, model, parameters: { ...(p || {}), use_string: true } };
}

/**
 * `/oa/v1/completions` body — OpenAI parameter names for the same intent.
 * `min_length` is DROPPED rather than mistranslated: the OpenAI surface has no
 * equivalent, and silently mapping it onto something else would be worse than
 * ignoring it. Verified accepted upstream: max_tokens, temperature, top_p,
 * top_k, repetition_penalty, stop.
 *
 * @param {string} input @param {string} model @param {Record<string, unknown>} p
 */
function oaTextBody(input, model, p) {
  const src = p || {};
  /** @type {Record<string, unknown>} */
  const body = { model, prompt: input };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (n(src.max_length) !== undefined) body.max_tokens = src.max_length;
  if (n(src.temperature) !== undefined) body.temperature = src.temperature;
  if (n(src.top_p) !== undefined) body.top_p = src.top_p;
  if (n(src.top_k) !== undefined) body.top_k = src.top_k;
  if (n(src.repetition_penalty) !== undefined) body.repetition_penalty = src.repetition_penalty;
  if (Array.isArray(src.stop_sequences) && src.stop_sequences.length > 0) {
    body.stop = src.stop_sequences;
  }
  return body;
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function errText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms) {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

function positive(value, dflt) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : dflt;
}

/** `Retry-After` in seconds or as an HTTP date; null when absent/unparseable. */
function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 60_000);
  return null;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * @typedef {{ok:true, text:string, raw:object}|{ok:false, code:string, error:string, hint?:string}} TextResult
 * @typedef {{ok:true, data:Buffer, contentType:string|null}|{ok:false, code:string, error:string, hint?:string}} VoiceResult
 * @typedef {{ok:true, data:object}|{ok:false, code:string, error:string, hint?:string}} SubResult
 */

/**
 * Build a NovelAI client. All mutable state (the serial queue, its counters)
 * lives in this closure — nothing at module scope, because `lib/` modules
 * survive plugin reloads (see the header).
 *
 * @param {{
 *   apiToken: string,
 *   timeoutMs?: number,
 *   maxWaitMs?: number,
 *   maxBytes?: number,
 *   backoffMs?: number,
 *   log?: any,
 * }} opts
 */
export function createNaiClient(opts) {
  const o = opts || /** @type {any} */ ({});
  const apiToken = typeof o.apiToken === 'string' ? o.apiToken.trim() : '';
  const timeoutMs = positive(o.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxWaitMs =
    typeof o.maxWaitMs === 'number' && Number.isFinite(o.maxWaitMs) && o.maxWaitMs >= 0
      ? o.maxWaitMs
      : DEFAULT_MAX_WAIT_MS;
  const maxBytes = positive(o.maxBytes, DEFAULT_MAX_BYTES);
  // Explicit backoffMs wins over Retry-After — it is the test injection point.
  const fixedBackoffMs =
    typeof o.backoffMs === 'number' && Number.isFinite(o.backoffMs) && o.backoffMs >= 0
      ? o.backoffMs
      : null;
  const log = o.log || null;

  // --- serial queue state (closure-local) --------------------------------
  /** Resolves when the previous task has settled; a rejection never breaks it. */
  let chain = Promise.resolve();
  /** Requests actually in flight (0 or 1). */
  let inflight = 0;
  /** Callers queued but not yet started — deliberately NOT counting `inflight`. */
  let waiting = 0;

  function debug(event, fields) {
    if (log && typeof log.debug === 'function') {
      try {
        log.debug({ event, ...fields });
      } catch {
        // A broken logger must never fail a generation.
      }
    }
  }

  /**
   * Run `task` with at most one request in flight, waiting at most `maxWaitMs`
   * for a turn. Past that budget the task is NOT run and a `busy` result is
   * returned — a full queue is a normal swarm condition, not an exception.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T|{ok:false, code:string, error:string, hint?:string}>}
   */
  function runSerial(task) {
    let abandoned = false;
    /** @type {() => void} */
    let signalStart = () => {};
    const started = new Promise((res) => {
      signalStart = /** @type {() => void} */ (res);
    });

    waiting += 1;

    const ran = chain.then(async () => {
      signalStart();
      if (abandoned) return undefined; // caller already gave up; skip the work
      waiting -= 1;
      inflight += 1;
      try {
        return await task();
      } finally {
        inflight -= 1;
      }
    });
    // A failing task must not poison the chain for the next caller.
    chain = ran.then(
      () => {},
      () => {},
    );

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        abandoned = true;
        waiting -= 1;
        debug('novelai.busy', { maxWaitMs });
        resolve(
          fail(
            'busy',
            `file NovelAI saturee : aucun creneau libre en ${maxWaitMs} ms`,
            'une seule generation a la fois ; reessaie dans quelques secondes',
          ),
        );
      }, maxWaitMs);

      // Our turn came: the wait budget no longer applies to the run itself.
      void started.then(() => clearTimeout(timer));

      void ran.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(/** @type {any} */ (value));
        },
        (err) => {
          // Defensive only: `task` is written never to throw.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(fail('internal', `erreur interne du client NovelAI: ${errText(err)}`));
        },
      );
    });
  }

  /** One fetch bounded by the SHARED deadline. Throws on abort/network error. */
  async function fetchOnce(url, init, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error('budget de temps epuise');
      e.name = 'AbortError';
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a response body with a hard byte cap. Streaming (rather than a bare
   * `arrayBuffer()`) is what keeps a degenerate response from growing the
   * SERVER's heap — the plugin runs in-process.
   *
   * @returns {Promise<{buf:Buffer}|{oversized:true, bytes:number}>}
   */
  async function readCapped(res) {
    const declared = Number(
      res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN,
    );
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { oversized: true, bytes: declared };
    }
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      /** @type {Buffer[]} */
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Cancelling is best-effort; the cap is already enforced.
          }
          return { oversized: true, bytes: total };
        }
        parts.push(Buffer.from(value));
      }
      return { buf: Buffer.concat(parts, total) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { oversized: true, bytes: buf.length };
    return { buf };
  }

  function oversized(bytes) {
    return fail(
      'oversized',
      `reponse NovelAI trop volumineuse (${bytes} > ${maxBytes} octets)`,
      'reduis la taille du texte ou augmente maxBytes',
    );
  }

  /**
   * Perform one request with AT MOST one retry, sharing a single absolute
   * deadline across both attempts. Never throws.
   *
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} deadline absolute epoch ms
   * @param {(res: Response) => Promise<any>} onOk called for a 2xx response
   */
  async function send(url, init, deadline, onOk) {
    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt === 1;
      let res;
      const startedAt = Date.now();
      try {
        res = await fetchOnce(url, init, deadline);
      } catch (err) {
        if (isAbort(err)) {
          // NEVER retried: a retry would double an already-blown time budget.
          debug('novelai.timeout', { url, attempt, ms: Date.now() - startedAt });
          return fail('timeout', `delai depasse apres ${timeoutMs} ms`, HINT_TIMEOUT);
        }
        debug('novelai.network_error', { url, attempt, error: errText(err) });
        if (canRetry && (await waitBeforeRetry(null, deadline))) continue;
        return fail(
          'upstream',
          `NovelAI injoignable: ${errText(err)}`,
          'verifie la connectivite reseau du serveur ; deja reessaye une fois',
        );
      }

      const status = Number(res.status);
      debug('novelai.response', { url, attempt, status, ms: Date.now() - startedAt });

      if (status >= 200 && status < 300) {
        return await onOk(res);
      }

      const read = await readCapped(res).catch(() => ({ buf: Buffer.alloc(0) }));
      const bodyText = 'buf' in read ? read.buf.toString('utf8') : '';
      if (canRetry && isRetriableStatus(status) && (await waitBeforeRetry(res, deadline))) continue;
      return mapStatus(status, bodyText);
    }
  }

  /**
   * Sleep before the single retry. Returns false when the shared deadline
   * leaves no room, in which case the caller reports the original failure
   * rather than burning the remaining budget on a doomed attempt.
   */
  async function waitBeforeRetry(res, deadline) {
    const base =
      fixedBackoffMs !== null
        ? fixedBackoffMs
        : (res ? retryAfterMs(res) : null) ?? 2000 + Math.floor(Math.random() * 1000);
    if (Date.now() + base >= deadline) return false;
    await sleep(base);
    return Date.now() < deadline;
  }

  function notConfigured() {
    return fail(
      'not_configured',
      'token NovelAI absent',
      'renseigne apiToken dans la configuration du plugin novelai',
    );
  }

  function authHeaders(extra) {
    return { Authorization: `Bearer ${apiToken}`, ...extra };
  }

  /**
   * `output` looks like base64-encoded tokens rather than prose. Deliberately
   * conservative — when in doubt it is treated as text, because a false
   * positive hides a perfectly good generation.
   */
  function looksTokenized(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length <= 32) return false;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(t)) return false; // any prose punctuation disqualifies
    if (/ /.test(t)) return false; // a plain space means prose (base64 wraps with \n)
    return true;
  }

  // --- public surface ----------------------------------------------------

  /** A 200 whose body is not the shape we can use. */
  function badResponse(what, raw) {
    return fail(
      'bad_response',
      `reponse NovelAI ${what}: ${String(raw).trim().slice(0, MESSAGE_CAP)}`,
      'reessaie ; si cela persiste, NovelAI a peut-etre change son API',
    );
  }

  /** Read `/ai/generate`'s `{output}`. */
  function readLegacyText(json, raw) {
    if (!json || typeof json !== 'object' || typeof json.output !== 'string') {
      // Without this branch `undefined` reaches structuredContent and the MCP
      // SDK rejects the whole response with an opaque error.
      return badResponse("sans champ 'output'", raw);
    }
    if (looksTokenized(json.output)) {
      return fail('tokenized_output', 'NovelAI a renvoye du texte tokenise (base64) au lieu de prose', HINT_TOKENIZED);
    }
    return { ok: true, text: json.output, raw: json };
  }

  /**
   * Read `/oa/v1/completions`'s `{choices:[{text}]}`.
   *
   * The empty-text-plus-token_ids branch is not hypothetical: that is exactly
   * what `/oa/v1/chat/completions` returns without `stream:true`. Catching it
   * here means a future route change degrades to a readable code instead of an
   * agent receiving `text: ""` and concluding the model had nothing to say.
   */
  function readOaText(json, raw) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice || typeof choice.text !== 'string') {
      return badResponse('sans choices[0].text', raw);
    }
    if (choice.text === '' && Array.isArray(choice.token_ids) && choice.token_ids.length > 0) {
      return fail(
        'tokenized_output',
        'NovelAI a renvoye des token_ids sans texte detokenise',
        HINT_TOKENIZED,
      );
    }
    if (looksTokenized(choice.text)) {
      return fail('tokenized_output', 'NovelAI a renvoye du texte tokenise (base64) au lieu de prose', HINT_TOKENIZED);
    }
    return { ok: true, text: choice.text, raw: json };
  }

  /** One text request on ONE surface. Never throws; shares the deadline. */
  function sendText(surface, input, model, parameters, deadline) {
    const oa = surface === 'oa';
    const body = oa ? oaTextBody(input, model, parameters) : legacyTextBody(input, model, parameters);
    return send(
      `${TEXT_HOST}${oa ? OA_TEXT_PATH : LEGACY_TEXT_PATH}`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify(body),
      },
      deadline,
      async (res) => {
        const read = await readCapped(res);
        if ('oversized' in read) return oversized(read.bytes);
        const raw = read.buf.toString('utf8');
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          // 200 + HTML from a CDN, or a truncated body.
          return badResponse('illisible (JSON attendu)', raw);
        }
        return oa ? readOaText(json, raw) : readLegacyText(json, raw);
      },
    );
  }

  /**
   * Prose continuation, routed to whichever surface serves `model`.
   *
   * On `wrong_surface` it retries ONCE on the other surface, inside the SAME
   * queue slot and under the SAME deadline — a routing correction is not a
   * second user-visible request, and NovelAI's own error message is an exact
   * oracle, so this is not a guess-and-hope retry.
   *
   * @param {{input: string, model?: string, parameters?: object}} args
   * @returns {Promise<TextResult>}
   */
  async function generateText(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiToken) return notConfigured();
      if (typeof a.input !== 'string' || a.input.length === 0) {
        return fail('bad_request', 'input manquant ou vide');
      }
      const model = typeof a.model === 'string' && a.model ? a.model : DEFAULT_TEXT_MODEL;
      const parameters = a.parameters || {};
      const deadline = Date.now() + timeoutMs;

      return await runSerial(async () => {
        const first = surfaceFor(model);
        const out = await sendText(first, a.input, model, parameters, deadline);
        if (!out || out.ok === true || out.code !== 'wrong_surface') return out;
        const other = first === 'legacy' ? 'oa' : 'legacy';
        debug('novelai.surface_switch', { model, from: first, to: other });
        const second = await sendText(other, a.input, model, parameters, deadline);
        if (second && second.ok === true) return { ...second, surface: other };
        return second;
      });
    } catch (err) {
      // Last line of defence: a throw here would count toward quarantine.
      return fail('internal', `erreur interne du client NovelAI: ${errText(err)}`);
    }
  }

  /**
   * `GET {TEXT_HOST}/oa/v1/models` — the models the OpenAI-compatible surface
   * serves, straight from NovelAI. This is what makes the hardcoded list a
   * thing of the past: `/status` reports it and the operator picks from it.
   *
   * Only OA models are listed; the legacy trio has no discovery endpoint and is
   * merged in by the caller.
   *
   * @returns {Promise<{ok:true, models:string[]}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function listModels() {
    try {
      if (!apiToken) return notConfigured();
      const deadline = Date.now() + timeoutMs;
      return await runSerial(async () =>
        send(
          `${TEXT_HOST}${OA_MODELS_PATH}`,
          { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
          deadline,
          async (res) => {
            const read = await readCapped(res);
            if ('oversized' in read) return oversized(read.bytes);
            const raw = read.buf.toString('utf8');
            let json;
            try {
              json = JSON.parse(raw);
            } catch {
              return badResponse('illisible (JSON attendu)', raw);
            }
            const data = json && Array.isArray(json.data) ? json.data : null;
            if (!data) return badResponse('sans tableau data', raw);
            const models = data
              .map((m) => (m && typeof m.id === 'string' ? m.id : null))
              .filter((id) => typeof id === 'string' && id.length > 0);
            return { ok: true, models };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client NovelAI: ${errText(err)}`);
    }
  }

  /**
   * `GET {API_HOST}/ai/generate-voice` — TTS.
   *
   * Sends BOTH candidate voice parameters (`voice=-1` and `seed=<name>`)
   * because the v2 contract is not publicly settled — see the file header.
   * Returns the raw `content-type`; deducing a file extension is the caller's
   * job, so a format change never needs a code change here.
   *
   * @param {{text: string, voice?: string, seedMix?: number, opus?: boolean}} args
   * @returns {Promise<VoiceResult>}
   */
  async function generateVoice(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiToken) return notConfigured();
      if (typeof a.text !== 'string' || a.text.trim().length === 0) {
        return fail('bad_request', 'text manquant ou vide');
      }
      const deadline = Date.now() + timeoutMs;
      const voice = typeof a.voice === 'string' && a.voice ? a.voice : DEFAULT_VOICE;

      const qs = new URLSearchParams();
      qs.set('text', a.text);
      qs.set('voice', '-1'); // v1 numeric slot; -1 means "use the seed below"
      qs.set('seed', voice); // v2 carries the voice NAME here
      if (typeof a.seedMix === 'number' && Number.isFinite(a.seedMix)) {
        qs.set('seed_mix', String(a.seedMix));
      }
      qs.set('opus', a.opus === false ? 'false' : 'true');
      qs.set('version', 'v2');

      return await runSerial(async () =>
        send(
          `${API_HOST}/ai/generate-voice?${qs.toString()}`,
          { method: 'GET', headers: authHeaders({ Accept: 'audio/*' }) },
          deadline,
          async (res) => {
            const contentType =
              res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('content-type')
                : null;
            const read = await readCapped(res);
            if ('oversized' in read) return oversized(read.bytes);
            const data = read.buf;
            if (data.length === 0) {
              return fail('bad_response', 'NovelAI a renvoye un corps audio vide');
            }
            // A 200 carrying JSON/HTML is an error dressed as a success.
            if (typeof contentType === 'string' && /json|html|xml|text\/plain/i.test(contentType)) {
              return fail(
                'bad_response',
                `audio attendu, recu ${contentType}: ${data.toString('utf8').trim().slice(0, MESSAGE_CAP)}`,
              );
            }
            return { ok: true, data, contentType: contentType || null };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client NovelAI: ${errText(err)}`);
    }
  }

  /**
   * `GET {API_HOST}/user/subscription` — operator diagnostic only.
   *
   * NOTE: this reports the SUBSCRIPTION's expiry, which is a different clock
   * from the TOKEN's; use decodeJwtExp() for the latter.
   *
   * @returns {Promise<SubResult>}
   */
  async function subscription() {
    try {
      if (!apiToken) return notConfigured();
      const deadline = Date.now() + timeoutMs;
      return await runSerial(async () =>
        send(
          `${API_HOST}/user/subscription`,
          { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
          deadline,
          async (res) => {
            const read = await readCapped(res);
            if ('oversized' in read) return oversized(read.bytes);
            const text = read.buf.toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            if (!json || typeof json !== 'object') {
              return fail(
                'bad_response',
                `reponse NovelAI illisible: ${text.trim().slice(0, MESSAGE_CAP)}`,
              );
            }
            return { ok: true, data: json };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client NovelAI: ${errText(err)}`);
    }
  }

  /** Queue gauges for `/status`. `inflight` and `waiting` never overlap. */
  function stats() {
    return { inflight, waiting };
  }

  return { generateText, generateVoice, subscription, listModels, stats };
}
