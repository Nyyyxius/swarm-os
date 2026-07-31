/**
 * Built-in provider ids — a leaf module with NO imports.
 *
 * It exists so `config.ts` can validate `SWARM_OS_DEFAULT_PROVIDER` without
 * importing the registry: `providers/index.ts` pulls in `claude.ts` →
 * `runtime/claude-init.ts` → the logger, and `availability.ts` → `ssh-exec.ts`
 * → `agent-process.ts` (node-pty). Dragging that graph into config loading
 * would create an import cycle (config is what those modules type against) and
 * make `loadConfig()` depend on a native module.
 *
 * Consequence, deliberate: `SWARM_OS_DEFAULT_PROVIDER` accepts BUILT-IN ids
 * only. A provider registered later by a plugin cannot be the instance-wide
 * default — config is loaded long before the plugin host starts. It can still
 * be selected per team / per agent through the API.
 */

export const BUILTIN_PROVIDER_IDS = ['claude', 'codex', 'gemini', 'opencode'] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

/** The historical (and still current) default: every agent used to be `claude`. */
export const DEFAULT_PROVIDER_ID: BuiltinProviderId = 'claude';

/**
 * Each built-in adapter's default model id.
 *
 * It lives HERE, in the leaf, for the same reason the id list does: `config.ts`
 * has to answer "what model does `SWARM_OS_DEFAULT_PROVIDER=codex` imply?"
 * without importing the registry. `SWARM_OS_DEFAULT_MODEL` used to fall back to
 * a hard-coded CLAUDE id no matter which provider was configured, so the
 * documented-as-valid pair (`SWARM_OS_DEFAULT_PROVIDER=codex`, no
 * `SWARM_OS_DEFAULT_MODEL`) made every team and every worker on the instance run
 * `codex -m claude-opus-4-8` — and the provider-scoping guard could not catch it,
 * because from its point of view the config layer WAS the codex layer.
 *
 * The four adapters read their `defaults().model` from this table rather than
 * carrying their own literal, so the two can never disagree. Adapters are still
 * free to have a richer `defaults()` (effort, permission mode); only the model
 * is shared, because only the model is needed before the registry exists.
 */
export const BUILTIN_PROVIDER_DEFAULT_MODELS: Record<BuiltinProviderId, string> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.5',
  gemini: 'gemini-3.1-pro-preview',
  opencode: 'anthropic/claude-opus-5',
};

/**
 * The FAMILY each provider's default belongs to — "give me the newest member of
 * this line", evaluated against the live catalogue (`providers/catalogue.ts`).
 *
 * It sits beside `BUILTIN_PROVIDER_DEFAULT_MODELS` rather than replacing it:
 * that table is the FLOOR, the answer `config.ts:560` needs before any network
 * exists and the answer every adapter falls back to when no catalogue is bound
 * (which is the case in every unit test, on purpose). This table only ever
 * upgrades that floor to a newer member of the same line.
 *
 * EVERY PATTERN IS ANCHORED AT BOTH ENDS, and that is the load-bearing detail:
 *
 *  - `/^claude-opus-/` unanchored also matches `claude-opus-4-1`, which lists at
 *    $15/$75 — three times the price of `claude-opus-5` ($5/$25) — and would win
 *    on any day the newest opus happened to be absent from the payload.
 *  - the tail `$` is what excludes the variant suffixes vendors keep bolting on:
 *    `-fast` (openrouter), `-luna` / `-sol` / `-terra` (openai), `-customtools`
 *    (google), `-pro` (openai). Those are different products at different prices
 *    and sometimes different shapes; being newer is not a reason to run one.
 *
 * Claude ids use `-` between version digits (`claude-opus-4-8`) while OpenRouter
 * uses `.` for the same model (`anthropic/claude-opus-4.8`) — hence the two
 * different character classes. That is the vendors' inconsistency, not ours.
 *
 * A family that matches nothing in the live list is not an error: the adapter
 * keeps its pin from the table above. So a payload that goes missing, changes
 * naming convention, or arrives empty degrades to exactly today's behaviour.
 */
export const BUILTIN_PROVIDER_DEFAULT_FAMILIES: Record<BuiltinProviderId, RegExp> = {
  claude: /^claude-opus-[\d-]+$/,
  codex: /^gpt-5(\.\d+)?$/,
  gemini: /^gemini-[\d.]+-pro(-preview)?$/,
  opencode: /^anthropic\/claude-opus-[\d.]+$/,
};

/**
 * Default model for a provider id, or `null` when it is not a built-in (a
 * plugin adapter — the caller then asks the adapter itself).
 */
export function builtinDefaultModel(providerId: string): string | null {
  return (BUILTIN_PROVIDER_DEFAULT_MODELS as Record<string, string>)[providerId] ?? null;
}
