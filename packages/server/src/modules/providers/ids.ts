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
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.5',
  gemini: 'gemini-3-pro-preview',
  opencode: 'anthropic/claude-opus-5',
};

/**
 * Default model for a provider id, or `null` when it is not a built-in (a
 * plugin adapter — the caller then asks the adapter itself).
 */
export function builtinDefaultModel(providerId: string): string | null {
  return (BUILTIN_PROVIDER_DEFAULT_MODELS as Record<string, string>)[providerId] ?? null;
}
