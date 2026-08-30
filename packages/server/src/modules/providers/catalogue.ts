/**
 * Live model catalogue — a lazy, TTL'd, serve-stale-and-refresh cache over
 * `https://models.dev/api.json` (plus the codex CLI's own on-host cache).
 *
 * WHY IT EXISTS. Until this module, the four adapters each carried a literal
 * array of model ids. Model ids ship weekly; we ship monthly; and this
 * deployment runs 24/7 without being recreated. `claude.ts` was still offering
 * `claude-sonnet-4-6` months after `claude-sonnet-5` existed — not because
 * anyone could not type the new id (`ProviderFields.tsx` has always had a
 * free-text escape hatch) but because nothing in the product ever SAID the new
 * id existed. This is a discoverability cache, and it should be judged as one.
 *
 * NO TIMER — the request refreshes it. Same doctrine, and for the same reason,
 * as `availability.ts:9-14` and `updates/index.ts`: `useProviders.ts` calls
 * `GET /providers` at mount and on every dialog open, so the heartbeat already
 * exists. A scheduler would add a lifecycle, a shutdown path and a class of
 * "why is it calling models.dev at 4 am" questions to produce the same freshness
 * at the only moments it matters.
 *
 * THREE GUARD-RAILS, each of which is a MECHANISM here rather than a property
 * we assert:
 *
 *  1. `AbortSignal.timeout()` on the fetch. `raceDeadline` bounds the WAIT, it
 *     does not cancel anything. A black-holed socket (SYN with no reply — the
 *     real air-gap behaviour, not a refused connection) would otherwise pin
 *     `#inflight` forever, and single-flight would coalesce EVERY later attempt
 *     onto that dead promise, permanently.
 *  2. The clock advances on failure too (`finally` in `#run`). Without it, a
 *     host with no DNS fails in ~1 ms, the TTL never short-circuits, and every
 *     single `GET /providers` fires a fresh fetch.
 *  3. `#refresh()` can never reject. `models()` calls `void maybeRefresh()`, and
 *     a rejected promise handed to `void` takes the process down with an
 *     `unhandledRejection`. `#run()`'s body is entirely inside try/catch.
 *
 * EVERY OUTCOME IS A VALUE, never a throw — the `updates/github.ts:59-73` style.
 * A payload entry we cannot read is DROPPED on its own; it never fails the
 * fetch, because one malformed model must not cost the operator the other 340.
 *
 * WHAT IS RETAINED. The parsed 3.2 MB payload is released as soon as the
 * per-provider views are derived: we keep `ProviderModel[]` (two short strings
 * each) and one family winner per provider, and nothing else.
 *
 * KILL SWITCH — `SWARM_OS_MODEL_CATALOGUE_URL=off` freezes every adapter on its
 * pinned list with no redeploy and no outbound call of any kind. A third-party
 * catalogue that feeds a `--model` argv has to be switchable off while the thing
 * is running.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { AgentTransport, Config } from '../../config.js';
import { hostExec as nodeHostExec } from '../orchestrator/ssh-exec.js';
import { raceDeadline } from './availability.js';
import { BUILTIN_PROVIDER_DEFAULT_FAMILIES, type BuiltinProviderId } from './ids.js';
import type { ProviderModel } from './types.js';

const log = withModule('providers.catalogue');

/** The source. Public, unauthenticated, and the one opencode itself consumes. */
export const MODEL_CATALOGUE_URL = 'https://models.dev/api.json';

/**
 * 6 h. Model launches are a human-cadence event; anything tighter is traffic
 * for its own sake. Matches `updates/index.ts`'s release check for the same
 * reason.
 */
export const MODEL_CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long the FIRST caller waits on a completely cold catalogue before being
 * served the pins instead. Shared with `AVAILABILITY_COLD_WAIT_MS` on purpose:
 * `GET /providers` starts both refreshes in the same tick and awaits them
 * together, so the route's floor is a max of the two, not a sum.
 */
export const MODEL_CATALOGUE_COLD_WAIT_MS = 3_000;

/**
 * Hard cap on the HTTP call itself. See guard-rail 1 above — this is the one
 * that makes a black-holed host recoverable rather than terminal.
 */
export const MODEL_CATALOGUE_FETCH_TIMEOUT_MS = 10_000;

/** Budget for reading the codex cache over SSH. A `cat` of 200 KB, no more. */
export const CODEX_CACHE_READ_TIMEOUT_MS = 10_000;

/** File the codex CLI writes its own model list into, inside `CODEX_HOME`. */
export const CODEX_MODELS_CACHE_FILE = 'models_cache.json';

/**
 * Vendors offered under opencode, explicitly. OpenRouter proxies 340 models
 * from ~60 vendors; an operator picking a coding agent does not need a
 * roleplay-tuned 7B in the same list as `anthropic/claude-opus-5`, and an
 * unbounded list is also an unbounded surface for "this id took the whole
 * budget in one turn".
 */
export const OPENCODE_VENDOR_ALLOWLIST: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'x-ai',
  'qwen',
  'moonshotai',
  'mistralai',
  'meta-llama',
  'z-ai',
  'minimax',
];

/**
 * Gemini ids carrying any of these are not text agents: TTS voices, the Live
 * bidirectional API, image generators, the computer-use preview, the robotics
 * line. Matched ANYWHERE in the id, not as a suffix — `google` puts the marker
 * in the middle as happily as at the end
 * (`gemini-2.5-computer-use-preview-10-2025`, `gemini-robotics-er-1.6-preview`),
 * and a suffix test silently admitted both.
 */
const GEMINI_EXCLUDED_MARKERS: readonly string[] = [
  '-tts',
  '-live',
  '-image',
  '-computer-use',
  '-robotics',
];

/**
 * Two OPPOSITE alias rules, and the opposition is deliberate — a future reader
 * will otherwise "fix" one of them:
 *
 *  - Google's `*-latest` ids are ROLLING pointers: `gemini-flash-latest` means a
 *    different model this quarter than last, so a team that stored it silently
 *    changes model under the operator. Excluded, per `gemini.ts:311-315`.
 *  - Anthropic's UNDATED ids (`claude-haiku-4-5`) are version-stable — the dated
 *    form (`claude-haiku-4-5-20251001`) is the same weights with a snapshot
 *    stamp — and the undated one is the form the vendor documents. Preferred,
 *    which INVERTS what `claude.ts:200-203` pinned.
 *
 * Verified against the live CLI on 2026-07-28: `claude --model claude-haiku-4-5
 * -p 'hi'` answers normally, so the undated form is accepted, not merely
 * published.
 */
const ANTHROPIC_DATED_SUFFIX = /^(.*)-\d{8}$/;

// ---------------------------------------------------------------------------
// The payload, as data we do not trust
// ---------------------------------------------------------------------------

/**
 * What we consume out of one models.dev entry. Every field is `unknown`
 * because models.dev carries neither a version nor a `$schema`: it is a
 * community catalogue that can change shape between two of our releases, and
 * the only safe assumption is that nothing is the type we expect.
 * (`updates/github.ts:66-73`, same reasoning, same shape.)
 */
interface RawModel {
  id?: unknown;
  name?: unknown;
  release_date?: unknown;
  tool_call?: unknown;
  modalities?: unknown;
  cost?: unknown;
  /** `{ context, output }` — the context window is what monitoring needs. */
  limit?: unknown;
}

/** One entry that survived validation. Internal — never leaves this module. */
interface LiveModel {
  id: string;
  name: string;
  /** ISO date, or `''` when the payload had none — sorts last, never crashes. */
  releaseDate: string;
  /** `true` only when `modalities.output` is exactly `['text']`. */
  textOnlyOutput: boolean;
  costInput: number | null;
  costOutput: number | null;
  /**
   * `cost.cache_read` / `cost.cache_write` (docs/monitoring-agents.md, Lot 11).
   * Absent from most non-Anthropic entries, hence nullable per bucket rather
   * than per model: a vendor that publishes an input price and no cache price
   * still gets its input tokens costed.
   */
  costCacheRead: number | null;
  costCacheWrite: number | null;
  /** `limit.context` when the payload carries a usable one (docs/monitoring-agents.md). */
  contextLimit: number | null;
}

/**
 * Per-MILLION-token prices of one model, one nullable field per token bucket
 * (docs/monitoring-agents.md, Lot 11 — "un bucket sans tarif connu contribue 0,
 * jamais de tarif inventé").
 *
 * `null` is load-bearing and is NOT the same as `0`: a free model publishes
 * `0` and is costed at zero, while a model whose payload omits `cache_read`
 * publishes nothing and its cached tokens simply do not contribute. Inventing a
 * house rate — "cache read is usually a tenth of input" — would put a number in
 * front of the operator that no vendor ever quoted.
 */
export interface TokenCostRates {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** What a provider's slice of the catalogue reduces to. */
export interface ProviderCatalogueView {
  /** Filtered, labelled and sorted. Live entries only — pins merge in later. */
  models: readonly ProviderModel[];
  /** Newest member of the pinned family, or `null` when the family is empty. */
  familyDefault: string | null;
  /**
   * `model id → context window`, for the ids that published one. A separate map
   * rather than a field on `ProviderModel` because `ProviderModel` is a
   * `<select>` option shipped to the browser, and a context window is server-side
   * arithmetic (`docs/monitoring-agents.md` — "Limites par modèle").
   */
  contextLimits: Readonly<Record<string, number>>;
  /**
   * `model id → per-million prices`, for the ids that published at least one.
   * Same separation, and the same reason, as `contextLimits`: a price is
   * server-side arithmetic (Lot 11's `costUsd`), not a `<select>` option — the
   * label already carries the two figures an operator reads while choosing.
   */
  costs: Readonly<Record<string, TokenCostRates>>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A per-million price, or `null`. `0` is a legitimate value (a free model) and
 * survives; a negative one does not — it would subtract from an estimate the
 * operator reads as money, and no vendor has ever quoted one.
 */
function asPrice(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n !== null && n >= 0 ? n : null;
}

/**
 * One payload entry → a `LiveModel`, or `null` when it is unusable.
 *
 * "Unusable" is deliberately narrow: no id, or `tool_call` that is not exactly
 * `true`. Everything else degrades — a missing `name` falls back to the id, a
 * `cost` of the wrong type just means no price in the label. Being strict here
 * would throw away a model over a field nobody reads.
 *
 * A CLI agent that cannot call tools cannot be a swarm member (it could never
 * reach team-comms), so `tool_call` is a hard gate rather than a preference.
 */
function readModel(key: string, raw: RawModel): LiveModel | null {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : key;
  if (id.length === 0) return null;
  if (raw.tool_call !== true) return null;

  const modalities = asRecord(raw.modalities);
  const output = Array.isArray(modalities?.output) ? modalities.output : null;
  const textOnlyOutput =
    output !== null && output.length === 1 && output[0] === 'text';

  const cost = asRecord(raw.cost);
  // `limit.context`, and only when it is a usable figure: models.dev carries
  // `0`, `null` and (rarely) a string here. A zero would make every `pct` read
  // 100 %, which is worse than the `—` a null renders.
  const limit = asRecord(raw.limit);
  const context = limit ? asFiniteNumber(limit.context) : null;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    releaseDate: typeof raw.release_date === 'string' ? raw.release_date : '',
    textOnlyOutput,
    costInput: cost ? asPrice(cost.input) : null,
    costOutput: cost ? asPrice(cost.output) : null,
    // Lot 11. models.dev spells the two cache buckets `cache_read` /
    // `cache_write`; Anthropic entries carry both, most others carry neither.
    costCacheRead: cost ? asPrice(cost.cache_read) : null,
    costCacheWrite: cost ? asPrice(cost.cache_write) : null,
    contextLimit: context !== null && context > 0 ? Math.floor(context) : null,
  };
}

/** Every readable model under one models.dev provider key. */
function readProviderModels(payload: unknown, providerKey: string): LiveModel[] {
  const root = asRecord(payload);
  const provider = root ? asRecord(root[providerKey]) : null;
  const models = provider ? asRecord(provider.models) : null;
  if (!models) return [];
  const out: LiveModel[] = [];
  for (const [key, value] of Object.entries(models)) {
    const raw = asRecord(value);
    if (!raw) continue;
    const parsed = readModel(key, raw as RawModel);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * `5` → `$5`, `0.2002` → `$0.2`. Two decimals is where per-million pricing
 * stops being a number an operator reads and starts being noise.
 */
function usd(n: number): string {
  return `$${Number(n.toFixed(2))}`;
}

/**
 * `Claude Opus 5 (claude-opus-5) · $5/$25`.
 *
 * THE PRICE IS THE POINT, not decoration. `claude-fable-5` passes every filter
 * this module applies — `^claude-`, `tool_call: true`, text output, and it IS a
 * legitimate model — while costing $10/$50, double `claude-opus-5`, for a
 * writing line rather than a coding one. It cannot become a default (the
 * anchored family regex in `ids.ts` excludes it) and it stays offered, so the
 * one thing left to do is make its cost visible at the moment of choosing.
 *
 * The id is always in the label because that is the string that ends up on the
 * CLI's command line; `web/ProviderFields.tsx:133` appends it when a label omits
 * it, and doing it here keeps the two from disagreeing about the format.
 */
function labelFor(m: LiveModel): string {
  // models.dev marks the undated id of a dated/undated pair by suffixing its
  // NAME with "(latest)" — `claude-opus-4-5` is "Claude Opus 4.5 (latest)".
  // Kept verbatim it renders as "Claude Opus 4.5 (latest) (claude-opus-4-5)":
  // two parentheticals, the first of which says nothing, because the dedupe
  // above already dropped the dated twin. Only one of the pair is ever offered,
  // so the marker has no one left to distinguish it from.
  const name = m.name.replace(/\s*\(latest\)\s*$/, '');
  const base = name.includes(m.id) ? name : `${name} (${m.id})`;
  return m.costInput !== null && m.costOutput !== null
    ? `${base} · ${usd(m.costInput)}/${usd(m.costOutput)}`
    : base;
}

/**
 * Newest first, then id ascending.
 *
 * The id tiebreak is not cosmetic: `release_date` collides constantly (a vendor
 * ships a model and its mini/flash siblings on one day), and an unstable order
 * would make the rendered `<select>` reshuffle between two polls of the same
 * unchanged payload.
 */
function byReleaseDesc(a: LiveModel, b: LiveModel): number {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Drop the dated twin of any id that also exists undated — see
 * `ANTHROPIC_DATED_SUFFIX`. Only ever applied to anthropic: it is the only
 * vendor in the payload that publishes both forms of the same weights.
 */
function preferUndatedIds(models: LiveModel[]): LiveModel[] {
  const ids = new Set(models.map((m) => m.id));
  return models.filter((m) => {
    const undated = ANTHROPIC_DATED_SUFFIX.exec(m.id)?.[1];
    return undated === undefined || !ids.has(undated);
  });
}

/**
 * First id matching `family` in an ALREADY-SORTED list — so "first match" and
 * "newest match" are the same statement, and the family resolution has no
 * ordering opinion of its own to keep in sync with the list's.
 */
function familyWinner(models: readonly LiveModel[], family: RegExp): string | null {
  for (const m of models) if (family.test(m.id)) return m.id;
  return null;
}

function toView(models: LiveModel[], provider: BuiltinProviderId): ProviderCatalogueView {
  const sorted = [...models].sort(byReleaseDesc);
  const contextLimits: Record<string, number> = {};
  const costs: Record<string, TokenCostRates> = {};
  for (const m of sorted) {
    if (m.contextLimit !== null) contextLimits[m.id] = m.contextLimit;
    // At least ONE known bucket earns an entry: a model priced on input and
    // output only is exactly the common case, and dropping it would cost the
    // estimate its two biggest buckets over the two it never published.
    if (
      m.costInput !== null ||
      m.costOutput !== null ||
      m.costCacheRead !== null ||
      m.costCacheWrite !== null
    ) {
      costs[m.id] = {
        input: m.costInput,
        output: m.costOutput,
        cacheRead: m.costCacheRead,
        cacheWrite: m.costCacheWrite,
      };
    }
  }
  return {
    models: sorted.map((m) => ({ value: m.id, label: labelFor(m) })),
    familyDefault: familyWinner(sorted, BUILTIN_PROVIDER_DEFAULT_FAMILIES[provider]),
    contextLimits,
    costs,
  };
}

/**
 * models.dev payload → the three provider views it can answer for.
 *
 * PURE, and exported for `scripts/sync-models.ts`: the offline sync writes the
 * pinned arrays by calling THIS function rather than reimplementing the filters,
 * because two copies of a filter is two filters that disagree by the second
 * release. `codex` is absent by construction — see `deriveCodexCatalogue`.
 */
export function deriveCatalogue(
  payload: unknown,
): Partial<Record<BuiltinProviderId, ProviderCatalogueView>> {
  const claude = preferUndatedIds(
    readProviderModels(payload, 'anthropic').filter((m) => m.id.startsWith('claude-')),
  );

  const gemini = readProviderModels(payload, 'google').filter(
    (m) =>
      m.id.startsWith('gemini-') &&
      m.textOnlyOutput &&
      !m.id.endsWith('-latest') &&
      !GEMINI_EXCLUDED_MARKERS.some((marker) => m.id.includes(marker)),
  );

  const opencode = readProviderModels(payload, 'openrouter').filter((m) =>
    OPENCODE_VENDOR_ALLOWLIST.includes(m.id.split('/')[0] ?? ''),
  );

  const out: Partial<Record<BuiltinProviderId, ProviderCatalogueView>> = {};
  if (claude.length > 0) out.claude = toView(claude, 'claude');
  if (gemini.length > 0) out.gemini = toView(gemini, 'gemini');
  if (opencode.length > 0) out.opencode = toView(opencode, 'opencode');
  return out;
}

// ---------------------------------------------------------------------------
// codex — the host CLI's own cache, because models.dev is measurably wrong here
// ---------------------------------------------------------------------------

/**
 * `~/.codex/models_cache.json` → the codex view.
 *
 * WHY THIS FILE AND NOT models.dev, measured rather than argued. models.dev is
 * a catalogue of what the *API* offers; `codex exec` on a ChatGPT account
 * accepts a strictly smaller set. Probed against codex 0.130.0 on this host,
 * 2026-07-28:
 *
 *     codex exec -m gpt-5.5      → runs
 *     codex exec -m gpt-5.6      → HTTP 400 "The 'gpt-5.6' model is not
 *                                  supported when using Codex with a ChatGPT
 *                                  account."
 *     codex exec -m gpt-5.5-pro  → HTTP 400, same sentence
 *     codex exec -m gpt-5.6-luna → HTTP 400 "requires a newer version of Codex"
 *
 * models.dev lists 19 `gpt-5*` ids; this cache lists 5, and they are exactly the
 * 5 that work. There is no filter over the models.dev payload that separates the
 * two sets — `gpt-5.6` is a perfectly ordinary flagship id there — so codex does
 * not read models.dev AT ALL, and falls back to its pinned array when this file
 * cannot be read. Offering an id the CLI rejects means a lead that dies inside
 * its own PTY while the UI still says `running`, which is precisely the failure
 * `NewOrchestratorDialog.tsx:187-189` warns operators about.
 *
 * `visibility` is the CLI's own shown/hidden flag (`codex-auto-review` is
 * `"hide"`: an internal model, not something to run a team on). `priority` is
 * its ordering — this payload carries no dates, so the vendor's own ranking is
 * the sort key, and `gpt-5.5` at priority 0 is what `codex` itself offers first.
 */
export function deriveCodexCatalogue(raw: unknown): ProviderCatalogueView | null {
  const root = asRecord(raw);
  const models = root && Array.isArray(root.models) ? root.models : null;
  if (!models) return null;

  const entries: Array<{ slug: string; label: string; priority: number }> = [];
  for (const value of models) {
    const m = asRecord(value);
    if (!m) continue;
    if (m.visibility !== 'list') continue;
    const slug = typeof m.slug === 'string' && m.slug.length > 0 ? m.slug : null;
    if (slug === null) continue;
    const name =
      typeof m.display_name === 'string' && m.display_name.length > 0
        ? m.display_name
        : slug;
    entries.push({
      slug,
      label: name.includes(slug) ? name : `${name} (${slug})`,
      // No priority ⇒ last. Never `0`, which would promote a broken entry to
      // the top of the list and, with it, to the family default.
      priority: asFiniteNumber(m.priority) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.slug < b.slug ? -1 : 1,
  );
  const family = BUILTIN_PROVIDER_DEFAULT_FAMILIES.codex;
  return {
    models: entries.map((e) => ({ value: e.slug, label: e.label })),
    familyDefault: entries.find((e) => family.test(e.slug))?.slug ?? null,
    // The codex cache carries no window figure — `PINNED_CONTEXT_LIMITS` answers
    // for `gpt-*` instead.
    contextLimits: {},
    // Nor any price: the file is the CLI's own model list, not a rate card. A
    // codex agent therefore reports its tokens with `costUsd: null` — an honest
    // gap rather than a models.dev figure for an id codex may not even accept.
    costs: {},
  };
}

// ---------------------------------------------------------------------------
// Context windows — the live figure, and what answers when there is none
// ---------------------------------------------------------------------------

/**
 * Fallback context windows, PER MODEL rather than per provider.
 *
 * Per provider would be a lie the moment a vendor ships one long-context member
 * of a family, and the monitoring gauge is only worth drawing if the
 * denominator is the real one — hence `null` (rendered `—`,
 * `web/lib/loadPercent.ts` doctrine: never invent a figure) for everything not
 * listed here rather than a house average.
 *
 * Deliberately short, and every entry is sourced:
 *
 *  - `[1m]` / `-1m` suffix → 1 000 000. Claude Code's own marker for the
 *    long-context variants; the suffix IS the vendor's way of saying it.
 *  - any other `claude-*` → 200 000, the standard Anthropic window.
 *  - `gpt-*` / `codex-*` → 272 000 input tokens (400 000 total minus the
 *    128 000 output reservation) — the figure the codex CLI runs on.
 *
 * gemini and the openrouter ids get nothing: gemini is out of scope for context
 * usage (docs/monitoring-agents.md §Providers) and openrouter proxies ~60
 * vendors whose windows we cannot pin one by one. models.dev answers for both
 * when it is reachable, which is the normal case.
 */
const PINNED_CONTEXT_LIMITS: ReadonlyArray<{ match: RegExp; limit: number }> = [
  { match: /(\[1m\]|-1m)$/i, limit: 1_000_000 },
  { match: /^claude-/i, limit: 200_000 },
  { match: /^(gpt-|codex-|o[34]-)/i, limit: 272_000 },
];

/**
 * The pinned answer for `(provider, model)`, or `null` when we have none.
 *
 * PURE and exported: the tracker calls it through `modelContextLimit`, and a
 * test can assert the fallback without standing up a catalogue.
 */
export function pinnedContextLimit(providerId: string, modelId: string): number | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  // opencode ids are `vendor/model`; the vendor prefix is not part of the name
  // the pins match on.
  const id = modelId.includes('/') ? (modelId.split('/').pop() ?? modelId) : modelId;
  for (const entry of PINNED_CONTEXT_LIMITS) {
    if (entry.match.test(id)) return entry.limit;
  }
  // The claude CLI accepts bare aliases (`haiku`, `sonnet`, `opus`, …) and
  // resolves them itself — `POST /orchestrators` passes them straight through,
  // so a team spawned with `model: "haiku"` matches no `claude-*` pin and its
  // gauge silently loses its denominator. Whatever an alias resolves to is an
  // Anthropic model on the standard 200K window unless the vendor says
  // otherwise with the `[1m]` suffix (caught above). Scoped to the claude
  // provider: every other provider's ids are literal model ids.
  if (providerId === 'claude') return 200_000;
  return null;
}

/**
 * `catalogue → pins → null`, for callers that may not have a catalogue at all
 * (unit tests, embedders). The one entry point the monitoring tracker uses.
 */
export function modelContextLimit(
  catalogue: ModelCatalogue | null | undefined,
  providerId: string,
  modelId: string,
): number | null {
  return catalogue
    ? catalogue.contextLimit(providerId, modelId)
    : pinnedContextLimit(providerId, modelId);
}

// ---------------------------------------------------------------------------
// Prices — the live rate card, and the arithmetic on top of it (Lot 11)
// ---------------------------------------------------------------------------

/**
 * Fallback rate cards, PER MODEL FAMILY (docs/monitoring-agents.md, Lot 15).
 *
 * This table exists because of one failure mode seen in the field: models.dev
 * unreachable — a cold boot behind a proxy, a DNS blip, an air-gapped host —
 * and every `$` in the product disappears at once. Costs, burn rates, budgets
 * and the daily roll-up all read `null`, and an operator cannot tell "we could
 * not price this" from "nothing is running".
 *
 * It took until Lot 15 to add it, and the reason is the reason every entry is
 * shaped the way it is: an INVENTED price is worse than no price. So —
 *
 *  - **Every figure here is one models.dev itself publishes** for that family
 *    (mirrored in `catalogue.fixture.ts`, which is a verbatim slice of the live
 *    payload). Nothing is averaged, extrapolated, or read off a vendor page.
 *  - **Per family, not per provider.** `claude-opus-4-1` is three times the
 *    price of `claude-opus-5`, so it gets its own entry ABOVE the generic opus
 *    one — first match wins, most specific first.
 *  - **Buckets we have not seen stay `null`**, which `estimateTokenCostUsd`
 *    scores as 0. The gpt entry publishes input/output only, so a codex agent
 *    priced from this table is under-reported rather than embellished — the
 *    same lower-bound direction the whole cost feature errs in.
 *  - **The live catalogue always wins** (`ModelCatalogue.costRates` consults
 *    these only on a miss), so a repricing upstream still corrects everything
 *    the moment models.dev answers again.
 *
 * gemini and the openrouter long tail get nothing, exactly as in
 * `PINNED_CONTEXT_LIMITS`: ~60 vendors whose rate cards we cannot pin one by
 * one, and models.dev answers for them in the normal case.
 */
const OPUS_RATES: TokenCostRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_RATES: TokenCostRates = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const HAIKU_RATES: TokenCostRates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

const PINNED_COST_RATES: ReadonlyArray<{ match: RegExp; rates: TokenCostRates }> = [
  // Opus 4.1 is priced apart from the rest of the opus line — and it is still
  // spawnable, so the generic entry below would treat it as a third of its
  // price. Specific first.
  { match: /^claude-opus-4-1/i, rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  // opus-5 and opus-4-8 quote the same card in the payload.
  { match: /^claude-opus-/i, rates: OPUS_RATES },
  { match: /^claude-sonnet-/i, rates: SONNET_RATES },
  { match: /^claude-haiku-/i, rates: HAIKU_RATES },
  { match: /^claude-fable-/i, rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  // The one non-Anthropic family the payload lets us pin: `openai/gpt-5.5`, the
  // model the codex CLI offers first. No cache buckets are published for it, so
  // none are invented — see the lower-bound note above.
  { match: /^gpt-5\.5/i, rates: { input: 5, output: 20, cacheRead: null, cacheWrite: null } },
];

/**
 * The bare aliases the claude CLI resolves on its own. `POST /orchestrators`
 * passes `model: "haiku"` straight through, so a team spawned that way matches
 * no `claude-*` pin — the same hole `pinnedContextLimit` closes for windows,
 * closed here for prices. Claude-scoped: every other provider takes literal ids.
 */
const PINNED_CLAUDE_ALIAS_RATES: Readonly<Record<string, TokenCostRates>> = {
  opus: OPUS_RATES,
  sonnet: SONNET_RATES,
  haiku: HAIKU_RATES,
};

/**
 * The pinned rate card for `(provider, model)`, or `null` when we have none.
 *
 * PURE and exported, like `pinnedContextLimit`: the catalogue calls it on a
 * miss, and a test can assert the fallback without standing up a catalogue.
 */
export function pinnedCostRates(providerId: string, modelId: string): TokenCostRates | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  // opencode ids are `vendor/model`; the vendor prefix is not part of the name
  // the pins match on (same normalization as `pinnedContextLimit`).
  const id = modelId.includes('/') ? (modelId.split('/').pop() ?? modelId) : modelId;
  for (const entry of PINNED_COST_RATES) {
    if (entry.match.test(id)) return entry.rates;
  }
  if (providerId === 'claude') {
    const alias = PINNED_CLAUDE_ALIAS_RATES[id.toLowerCase()];
    if (alias) return alias;
  }
  return null;
}

/**
 * `catalogue → pins → null`, for callers that may not have a catalogue at all
 * (unit tests, embedders). The counterpart of `modelContextLimit`.
 *
 * This function used to return `null` outright without a catalogue, on the
 * grounds that a stale price is a wrong number wearing the confidence of a
 * right one. Lot 15 narrowed that: the pins are per family, every figure is one
 * models.dev publishes, unseen buckets stay `null`, and the live card still
 * takes precedence — so the residual risk is a bill quoted at last month's
 * rates, against the certainty of no bill at all whenever models.dev is
 * unreachable. See `PINNED_COST_RATES`.
 */
export function modelCostRates(
  catalogue: ModelCatalogue | null | undefined,
  providerId: string,
  modelId: string,
): TokenCostRates | null {
  return catalogue
    ? catalogue.costRates(providerId, modelId)
    : pinnedCostRates(providerId, modelId);
}

/** What `estimateTokenCostUsd` needs of a token tally. Structural on purpose. */
export interface TokenCostCounters {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * `Σ bucket × rate / 1e6`, over the buckets whose rate is KNOWN.
 *
 * Two rules, both from docs/monitoring-agents.md Lot 11:
 *
 *  - a bucket with no published rate contributes **0**, never an invented one.
 *    An Anthropic model prices all four; an OpenRouter passthrough often prices
 *    two. Under-reporting the cache half of a bill is a number an operator can
 *    reason about ("cache isn't counted"); a fabricated rate is not.
 *  - `null` — not `0` — when input AND output are both unknown. At that point
 *    nothing meaningful is priced, and `0` would read as "this agent was free".
 *
 * Rounded to the micro-dollar: the inputs are per-million rates against token
 * counts, so the float tail is noise, and `0.30000000000000004` in a JSON
 * response is an invitation to a bug report.
 */
export function estimateTokenCostUsd(
  counters: TokenCostCounters,
  rates: TokenCostRates | null | undefined,
): number | null {
  if (!rates) return null;
  if (rates.input === null && rates.output === null) return null;
  let usd = 0;
  const add = (tokens: number, rate: number | null): void => {
    if (rate === null || !Number.isFinite(rate)) return;
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    usd += (tokens * rate) / 1_000_000;
  };
  add(counters.in, rates.input);
  add(counters.out, rates.output);
  add(counters.cacheRead, rates.cacheRead);
  add(counters.cacheWrite, rates.cacheWrite);
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/** Narrow shape of `ssh-exec.hostExec` this module needs. Mirrors `ProbeHostExec`. */
export type CatalogueHostExec = (
  config: Config,
  input: { argv: string[]; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export interface ModelCatalogueOptions {
  /**
   * Instance config — read for `agentTransport` and `hostCodexDir` only.
   * Optional so a unit test can build a catalogue with no Config at all; a
   * catalogue without one simply never reads the codex cache.
   */
  config?: Config | null;
  /** Overrides `config.agentTransport` (tests). */
  transport?: AgentTransport;
  /** Overrides the env/`MODEL_CATALOGUE_URL`. `'off'` disables the catalogue. */
  url?: string;
  ttlMs?: number;
  fetchTimeoutMs?: number;
  /** Injectable clock — same seam as `ProviderAvailabilityCache`. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Local-transport read of the codex cache. */
  readFileImpl?: (filePath: string) => string;
  /** SSH-transport read of the codex cache. */
  hostExec?: CatalogueHostExec;
  env?: NodeJS.ProcessEnv;
}

/**
 * Env override for the TTL. Read here rather than in `config.ts` for the same
 * reason as `SWARM_OS_UPDATE_CHECK_TTL_MS` (`updates/index.ts:38-49`): an
 * operator never needs it, a test and a demo do.
 */
function ttlFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.SWARM_OS_MODEL_CATALOGUE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MODEL_CATALOGUE_TTL_MS;
}

function urlFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.SWARM_OS_MODEL_CATALOGUE_URL;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : MODEL_CATALOGUE_URL;
}

export class ModelCatalogue {
  /** Per-provider derived views. Empty until the first successful refresh. */
  readonly #views = new Map<BuiltinProviderId, ProviderCatalogueView>();
  /** Epoch ms of the last COMPLETED refresh — success or failure. */
  #checkedAtMs: number | null = null;
  /** Single-flight guard: at most one refresh in flight, ever. */
  #inflight: Promise<void> | null = null;

  readonly #config: Config | null;
  readonly #transport: AgentTransport | null;
  readonly #url: string;
  readonly #ttlMs: number;
  readonly #fetchTimeoutMs: number;
  readonly #now: () => number;
  readonly #fetchImpl: typeof fetch;
  readonly #readFile: (filePath: string) => string;
  readonly #hostExec: CatalogueHostExec;

  constructor(opts: ModelCatalogueOptions = {}) {
    const env = opts.env ?? process.env;
    this.#config = opts.config ?? null;
    this.#transport = opts.transport ?? opts.config?.agentTransport ?? null;
    this.#url = opts.url ?? urlFromEnv(env);
    this.#ttlMs = opts.ttlMs ?? ttlFromEnv(env);
    this.#fetchTimeoutMs = opts.fetchTimeoutMs ?? MODEL_CATALOGUE_FETCH_TIMEOUT_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#readFile = opts.readFileImpl ?? ((p) => fs.readFileSync(p, 'utf8'));
    this.#hostExec = opts.hostExec ?? nodeHostExec;
  }

  /**
   * `false` under `SWARM_OS_MODEL_CATALOGUE_URL=off`. A disabled catalogue is
   * inert, not absent: adapters keep calling it and keep getting their pins, so
   * flipping the switch needs no other code path anywhere.
   */
  get enabled(): boolean {
    return this.#url !== 'off';
  }

  /**
   * `live ∪ pinned`, live first, deduplicated by id — and never blocking.
   *
   * The union is a guard-rail rather than a fix: not one currently-pinned id is
   * missing from models.dev today (checked one by one, `deepseek/deepseek-chat`
   * included). It matters for the ids a future release pins by hand, and for the
   * day a vendor's section of the payload goes missing — the operator loses
   * discovery of the new ids, not the ability to pick the ones we shipped with.
   */
  models(
    provider: BuiltinProviderId,
    pinned: readonly ProviderModel[],
  ): readonly ProviderModel[] {
    void this.#maybeRefresh();
    const live = this.#views.get(provider)?.models;
    if (!live || live.length === 0) return pinned;
    const seen = new Set(live.map((m) => m.value));
    const extra = pinned.filter((m) => !seen.has(m.value));
    return extra.length === 0 ? live : [...live, ...extra];
  }

  /**
   * Newest member of this provider's pinned family, or `pinnedDefault`.
   *
   * Resolved over the LIVE list and never over the raw payload, so the answer is
   * by construction an id `models()` also offers. Returning something absent
   * from the list would make the UI render "not in catalogue"
   * (`ProviderFields.tsx:298`) next to the value it had just pre-filled for the
   * operator.
   */
  defaultModel(provider: BuiltinProviderId, pinnedDefault: string): string {
    void this.#maybeRefresh();
    return this.#views.get(provider)?.familyDefault ?? pinnedDefault;
  }

  /**
   * Context window of one model, `null` when nothing can answer for it
   * (docs/monitoring-agents.md — "Limites par modèle").
   *
   * Live figure first, `PINNED_CONTEXT_LIMITS` second. `providerId` is a plain
   * string, not a `BuiltinProviderId`: a plugin adapter has no slice here, and
   * asking about one must degrade to the pins rather than fail to typecheck at
   * the callsite.
   *
   * Refreshes on read like `models()` — this runs on the `/orchestrators` poll,
   * i.e. exactly the heartbeat the no-timer doctrine relies on. The call is a
   * TTL check plus a map lookup; the fetch it may start is single-flighted.
   */
  contextLimit(providerId: string, modelId: string): number | null {
    void this.#maybeRefresh();
    if (typeof modelId !== 'string' || modelId.length === 0) return null;
    const live = this.#views.get(providerId as BuiltinProviderId)?.contextLimits[modelId];
    if (typeof live === 'number' && Number.isFinite(live) && live > 0) return live;
    return pinnedContextLimit(providerId, modelId);
  }

  /**
   * Per-million prices of one model (docs/monitoring-agents.md, Lot 11), live
   * card first and `PINNED_COST_RATES` second (Lot 15).
   *
   * The precedence is the whole point: a model the payload prices is priced
   * from the payload, always — the pins only answer for an id the live
   * catalogue has never carried, which covers the cold-boot window, an
   * unreachable models.dev, and the providers whose own cache is a model list
   * with no rate card (codex).
   *
   * No partial answer, either way: a model the payload knows returns the
   * buckets it published and `null` for the rest, which reads as "these two
   * buckets are not in the total" — never as a reason to consult the pins for
   * the missing halves and mix two sources in one figure.
   *
   * Refreshes on read like the other getters: this runs on the `/orchestrators`
   * poll, which is the heartbeat the no-timer doctrine relies on.
   */
  costRates(providerId: string, modelId: string): TokenCostRates | null {
    void this.#maybeRefresh();
    if (typeof modelId !== 'string' || modelId.length === 0) return null;
    const live = this.#views.get(providerId as BuiltinProviderId)?.costs[modelId];
    if (live) return live;
    return pinnedCostRates(providerId, modelId);
  }

  /**
   * Like the getters, but waits up to `timeoutMs` when NOTHING has ever been
   * cached. A stale catalogue returns immediately and refreshes in the
   * background — serve-stale-and-refresh, same contract as
   * `ProviderAvailabilityCache.resolve`.
   */
  async resolve(timeoutMs: number = MODEL_CATALOGUE_COLD_WAIT_MS): Promise<void> {
    const pending = this.#maybeRefresh();
    if (pending && this.#checkedAtMs === null) await raceDeadline(pending, timeoutMs);
  }

  /** Drop everything (tests; also the honest way to force a re-fetch). */
  clear(): void {
    this.#views.clear();
    this.#checkedAtMs = null;
  }

  #maybeRefresh(): Promise<void> | null {
    if (!this.enabled) return null;
    if (this.#inflight !== null) return this.#inflight;
    if (this.#checkedAtMs !== null && this.#now() - this.#checkedAtMs < this.#ttlMs) {
      return null;
    }
    return this.#refresh();
  }

  /** Never throws, never rejects. Advances the clock whatever happens. */
  #refresh(): Promise<void> {
    if (this.#inflight !== null) return this.#inflight;
    this.#inflight = this.#run().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #run(): Promise<void> {
    try {
      // Both sources in parallel and independently: a models.dev outage must
      // not cost us the codex list, which is a local file read, and vice versa.
      const [payload, codexRaw] = await Promise.all([
        this.#fetchPayload(),
        this.#readCodexCache(),
      ]);
      if (payload !== null) {
        for (const [id, view] of Object.entries(deriveCatalogue(payload))) {
          this.#adopt(id as BuiltinProviderId, view);
        }
      }
      if (codexRaw !== null) {
        const view = deriveCodexCatalogue(codexRaw);
        if (view) this.#adopt('codex', view);
      }
    } catch (err) {
      // Belt to the braces below: `#fetchPayload` and `#readCodexCache` already
      // return values rather than throwing, so reaching here means a bug in the
      // derivation. It must still not reject — see guard-rail 3 in the header.
      log.warn({
        event: 'catalogue.refresh_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#checkedAtMs = this.#now();
    }
  }

  /**
   * Install a view and say so when it moved the needle.
   *
   * Only a CHANGED default is logged, not every refresh: at 6 h per refresh this
   * is the line an operator greps to answer "when did new teams start being
   * created on opus 5, and did the instance notice on its own?".
   */
  #adopt(provider: BuiltinProviderId, view: ProviderCatalogueView): void {
    const before = this.#views.get(provider);
    this.#views.set(provider, view);
    if (before?.familyDefault !== view.familyDefault) {
      log.info({
        event: 'catalogue.default_model',
        provider,
        model: view.familyDefault,
        previous: before?.familyDefault ?? null,
        models: view.models.length,
      });
    }
  }

  /** `null` on any failure — the previous views stay in place. */
  async #fetchPayload(): Promise<unknown | null> {
    let res: Response;
    try {
      res = await this.#fetchImpl(this.#url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'swarm-os' },
        // NOT `raceDeadline`: that bounds how long we WAIT, this bounds how long
        // the socket may live. Without it a black-holed host pins `#inflight`
        // forever and single-flight coalesces every later attempt onto it.
        signal: AbortSignal.timeout(this.#fetchTimeoutMs),
      });
    } catch (err) {
      // Refused, DNS gone, aborted on timeout — indistinguishable to us and
      // handled the same way: we simply do not know, so nothing changes.
      log.warn({
        event: 'catalogue.unreachable',
        url: this.#url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!res.ok) {
      log.warn({ event: 'catalogue.http_error', url: this.#url, status: res.status });
      return null;
    }
    try {
      return await res.json();
    } catch (err) {
      log.warn({
        event: 'catalogue.invalid_json',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * `null` when there is no config, no transport, or the file cannot be read —
   * all of which are ordinary states (a deployment with no codex installed), so
   * none of them logs above `debug`.
   *
   * `config.hostCodexDir` is the right root in BOTH transports, exactly as it is
   * for the per-session symlink farm (`codex.ts:370-378`): under SSH it is the
   * host's real `~/.codex`, and locally it resolves from the container's own
   * `os.homedir()` — the namespace the agent shares with us.
   */
  async #readCodexCache(): Promise<unknown | null> {
    const config = this.#config;
    if (!config?.hostCodexDir || this.#transport === null) return null;
    const file = path.join(config.hostCodexDir, CODEX_MODELS_CACHE_FILE);
    let text: string;
    try {
      if (this.#transport === 'ssh') {
        // The container cannot stat a host path, so the read has to happen over
        // there. `hostExec` THROWS when the transport is not ssh (`ssh-exec.ts:
        // 232-239`) — hence the branch rather than a uniform call.
        const res = await this.#hostExec(config, {
          argv: ['cat', file],
          timeoutMs: CODEX_CACHE_READ_TIMEOUT_MS,
        });
        if (res.code !== 0 || res.timedOut) {
          log.debug({
            event: 'catalogue.codex_cache_unreadable',
            file,
            code: res.code,
            timedOut: res.timedOut,
          });
          return null;
        }
        text = res.stdout;
      } else {
        text = this.#readFile(file);
      }
      return JSON.parse(text);
    } catch (err) {
      log.debug({
        event: 'catalogue.codex_cache_unreadable',
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
