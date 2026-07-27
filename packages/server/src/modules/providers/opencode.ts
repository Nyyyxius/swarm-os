/**
 * OpenCode (`sst/opencode`) adapter, models addressed through OpenRouter
 * (multi-provider plan, Lot 6a).
 *
 * Every claim below was PROVEN by executing the real binary in
 * `scripts/verify-opencode.ts` — read `scripts/verify-opencode.report.md`
 * (opencode 1.18.5, 11 CONFIRMED / 0 REFUTED, verdict "viable") before changing
 * anything here. The check ids in the comments (`C1`, `C4`, …) point at the
 * section of that report which paid for the line.
 *
 * The shape in one paragraph: per-session isolation comes from an INLINE config
 * (`OPENCODE_CONFIG_CONTENT`) plus a private set of `XDG_*` roots; the role
 * preamble is a file referenced from `instructions[]`, which opencode re-resolves
 * on every request and therefore survives `/clear`; team-comms is an
 * `mcp.<key> = { type: "remote", url }` block with the session secret in the URL
 * path; unattended operation needs BOTH `--auto` and `"permission": "allow"`;
 * the initial turn is seeded with `--prompt` and the TUI stays alive afterwards.
 *
 * Four things that are NOT obvious and will bite whoever edits this file:
 *
 *  1. **The positional of `opencode [project]` is the PROJECT PATH, not the
 *     message** (C0). Passing the prompt positionally would silently start the
 *     TUI in a directory named after the task text. The prompt goes through
 *     `--prompt` and nowhere else.
 *
 *  2. **A missing `OPENCODE_CONFIG` file is ignored, not fatal** (C1). That is
 *     why this adapter uses `OPENCODE_CONFIG_CONTENT` (inline JSON): there is no
 *     path to typo, and the per-session MCP secret never touches the disk. The
 *     failure mode we are avoiding is a session that boots looking perfectly
 *     healthy with no MCP and no role.
 *
 *  3. **PTY silence is AMBIGUOUS on opencode** (C4 + C7). A TUI frozen on an
 *     `Allow once / Reject` dialog emits 0 B/s — byte for byte identical to an
 *     idle one. `Session._idleSince` therefore cannot distinguish "finished"
 *     from "blocked waiting for a human". Two mitigations, both implemented
 *     here: the permission dialog is made unreachable (`--auto` +
 *     `permission:"allow"`), and the TUI is started with `--port` so it serves
 *     its HTTP control plane — whose `GET /event` SSE stream emits
 *     `permission.asked` and `session.idle` — while remaining an ordinary PTY.
 *     ⚠️ The SSE CONSUMER DOES NOT EXIST YET (Lot 6c, see `controlPlane()`).
 *
 *  4. **opencode rewrites MCP tool names** to `<mcpConfigKey>_<tool>` with dots
 *     replaced by underscores (C2b): under the `team` key used here,
 *     `team.whoami` reaches the model as `team_team_whoami`. A preamble that
 *     names the raw dotted tools instructs the agent to call tools that do not
 *     exist. `opencodeMcpToolName()` below is the single source of truth for
 *     that mangling; `modules/preambles/` must go through it (Lot 6d).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';
import { probeCliBinary } from './probe.js';
import { writeSessionFile } from './session-config.js';
import type {
  AgentProvider,
  ContextResetCommand,
  McpCleanupRequest,
  McpWriteRequest,
  McpWriteResult,
  PreparedSpawn,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderModel,
  ProviderProbeContext,
  RuntimeInitOptions,
  RuntimeInitOutcome,
  SessionConfigRequest,
  SessionConfigResult,
  SpawnRequest,
} from './types.js';

// Historical module binding: every session-scoped event in this codebase is
// emitted under `module: session` and operators grep on that. Event NAMES are
// namespaced instead (`session.opencode_*`).
const log = withModule('session');

/**
 * Nothing is shared from the host's `~/.opencode` — and that is a RESULT, not an
 * omission (C1 + C5). opencode keeps no state there: config lives under
 * `$XDG_CONFIG_HOME/opencode`, runtime state (the `opencode.db` SQLite file with
 * its WAL sidecars, `auth.json`, `log/`, `repos/`) under `$XDG_DATA_HOME`, the
 * model catalogue under `$XDG_CACHE_HOME`, advisory locks under
 * `$XDG_STATE_HOME`. And there is no credential to share: the OpenRouter key is
 * env-only (no `opencode auth login`, no file — C5), so a session needs no
 * host-side authentication state at all.
 *
 * Deliberately empty rather than "populated later": symlinking a WAL-mode SQLite
 * database into N concurrent sessions is the corruption recipe we already
 * documented for codex. Each session gets its own `XDG_DATA_HOME` instead
 * (C1b: concurrent sessions over ONE db also worked, but per-session roots keep
 * the blast radius and the cleanup to a single directory).
 */
export const OPENCODE_SHARED_ENTRIES: readonly string[] = [];

/**
 * Config key of the team-comms MCP server, and therefore the PREFIX of every
 * team tool as the model sees it (C2b). `team` is chosen over claude's
 * `team-comms` because opencode's mangling yields the tidier `team_team_whoami`
 * instead of `team-comms_team_whoami`.
 *
 * Changing this string silently renames every tool the agent is told to call.
 */
export const OPENCODE_MCP_SERVER_KEY = 'team';

/** MCP connect budget, in ms — `mcp.<key>.timeout` (report §"Config to generate"). */
export const OPENCODE_MCP_TIMEOUT_MS = 8_000;

/** Published JSON-schema url opencode stamps on its own config files. */
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';

/**
 * How opencode renames an MCP tool once it is exposed to the model: the server's
 * CONFIG KEY, an underscore, then the tool name with every `.` turned into `_`
 * (OpenAI-style function names forbid dots). Verified end to end in C2b —
 * `team.whoami` on a server keyed `swarm-team` arrived as
 * `swarm-team_team_whoami`; dashes in the key survive, dots do not.
 *
 * Exported because `modules/preambles/` MUST generate the role text from this
 * function rather than from the dotted names (Lot 6d — out of scope here).
 */
export function opencodeMcpToolName(
  tool: string,
  serverKey: string = OPENCODE_MCP_SERVER_KEY,
): string {
  return `${serverKey}_${tool.replace(/\./g, '_')}`;
}

/**
 * Prefix that selects opencode's `openrouter` provider. Model ids are
 * `openrouter/<vendor>/<model>` — the first segment is opencode's provider id,
 * the rest is OpenRouter's own slug verbatim (C5, 342 ids listed).
 */
export const OPENCODE_MODEL_PREFIX = 'openrouter/';

/** Env var name of the sole OpenRouter credential mechanism (C5). */
export const OPENCODE_API_KEY_ENV = 'OPENROUTER_API_KEY';

/**
 * FALLBACK source of the OpenRouter key, behind the `instance_settings` row —
 * see `OpencodeProvider.resolveApiKey`. Kept after Lot 6b because dev boxes and
 * CI have no UI to type into and no reason to seed a database.
 *
 * Deliberately NOT named `OPENROUTER_API_KEY`: the server's own environment
 * must not be able to leak into an agent by accident. The agent receives the
 * key only through `secretEnv`, explicitly.
 */
export const SWARM_OPENROUTER_KEY_ENV = 'SWARM_OS_OPENROUTER_API_KEY';

/**
 * Where the stored OpenRouter key comes from. `SettingsStore` satisfies this
 * structurally (`modules/settings/index.ts`), which is what keeps this file
 * free of any import from the DB or settings layer — the adapter stays a pure
 * consumer and its unit tests need no SQLite.
 *
 * Synchronous by contract: `buildSpawn` is pure and synchronous, so an async
 * source could not be honoured without changing the provider interface.
 */
export interface OpenRouterKeySource {
  /** Plaintext key, or `null` when none is configured. Must not throw. */
  getOpenRouterApiKey(): string | null;
}

/** Sub-directory of `runtimeRoot` holding one directory per opencode session. */
export const OPENCODE_SESSION_SUBDIR = 'opencode';

/** File name of the durable role preamble, referenced from `instructions[]` (C3). */
export const OPENCODE_ROLE_FILE = 'SWARM_ROLE.md';

/**
 * Per-session HTTP control plane (C8). The TUI serves the full opencode API on
 * `--port` while staying an ordinary PTY, so it is BOTH the notification channel
 * (`GET /event` → `permission.asked` / `session.idle`) and an acknowledged
 * injection path (`POST /tui/append-prompt` + `/tui/submit-prompt`).
 *
 * Loopback only, and password-protected: the API can drive the agent and read
 * its whole transcript, and it is UNAUTHENTICATED unless
 * `OPENCODE_SERVER_PASSWORD` is set (C8). That is a security requirement, not an
 * option — on this deployment the agents run on a shared host.
 */
export const OPENCODE_CONTROL_HOSTNAME = '127.0.0.1';
/** Basic-auth user for the control plane (`OPENCODE_SERVER_USERNAME`). */
export const OPENCODE_CONTROL_USERNAME = 'swarm';
/**
 * Control-plane port window. Deliberately outside the ephemeral range the kernel
 * hands out for outbound sockets (`net.ipv4.ip_local_port_range`, 32768–60999 on
 * Linux) so an agent's own outbound connections cannot squat the port we are
 * about to ask opencode to bind.
 */
export const OPENCODE_CONTROL_PORT_BASE = 47_100;
export const OPENCODE_CONTROL_PORT_COUNT = 900;

export interface OpencodeControlPlane {
  /** Port the TUI's HTTP API + SSE stream listen on. */
  port: number;
  /** Always loopback — of the machine the AGENT runs on (the host, under SSH). */
  hostname: string;
  username: string;
  password: string;
  /** Convenience base url for the future `/event` consumer. */
  baseUrl: string;
}

/** The four `XDG_*` roots that isolate one session's opencode state (C1). */
export interface OpencodeXdgDirs {
  config: string;
  data: string;
  cache: string;
  state: string;
}

/**
 * What the adapter remembers between its three phases. Keyed by the per-session
 * config dir, the only identifier present in BOTH `writeMcpConfig` (phase B.1)
 * and `buildSpawn` (phase B.2) — `SpawnRequest` carries no session id.
 *
 * Dropped in `removeMcpConfig` AND swept by `_sweepDeadSessions()` — the sweep
 * is not belt and braces, it is the load-bearing one. See its comment.
 */
interface OpencodeSessionState {
  sessionId: string;
  configDir: string;
  xdg: OpencodeXdgDirs;
  /** Container path of the preamble file, or null when there is no preamble. */
  rolePath: string | null;
  control: OpencodeControlPlane;
  /** team-comms url, recorded in phase B.1 for the inline config in B.2. */
  mcpUrl: string | null;
}

const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  // No reasoning-effort knob on the interactive TUI: `--variant` exists on
  // `opencode run` only (C0 flag inventory), and OpenRouter models express
  // effort per-vendor anyway. Declared false so the UI greys the control out
  // instead of sending a flag that silently does nothing.
  effort: false,
  // opencode has no permission-mode vocabulary — it has a permission MATRIX
  // (`bash`/`edit`/`external_directory`/… each `ask|allow|deny`). We run it
  // fully unattended, which is the closest thing to claude's
  // `bypassPermissions`; every other mode is coerced onto it.
  permissionModes: ['bypassPermissions'],
  fallbackPermissionMode: 'bypassPermissions',
  // `false` — and it is a statement about THE SERVER, not about the CLI.
  //
  // C8 proved a notification channel EXISTS: the `--port` control plane's
  // `GET /event` SSE stream emits `permission.asked` (blocked on a human) and
  // `session.idle` (turn finished), both captured live. It is not a shell hook
  // like claude's, it is better — it also disambiguates the 0 B/s silence C4
  // proved is otherwise unreadable.
  //
  // But NOTHING CONSUMES IT YET (Lot 6c, see `controlPlane()`), so no opencode
  // session ever reaches `waiting`, and "agent is waiting" notifications plus
  // `compactOnWaiting` are mute for this provider. `false` is what makes the UI
  // say that out loud instead of an operator discovering it while wondering why
  // a team looks silent (plan Risk 8).
  //
  // WHEN LOT 6c SHIPS: `permission.asked` is `'needs-human'` and `session.idle`
  // is `'turn-complete'` — two different edges from one stream. Whichever the
  // consumer forwards to `/hooks/notification` is what this value must become;
  // forwarding both means forwarding `session.idle` as a distinct `kind` the
  // route maps to the turn-complete branch, never as `session.waiting`.
  notificationHook: false,
  // C6 — both cadences submit: the two-step dance (text, then a solo CR at
  // +150 ms) AND a single `write("text\r")`. Unlike claude's Ink TUI, opencode
  // does not treat a chunk with a trailing CR as a paste. `false` lets
  // `Session.submitInput` / `notifySignal` do one write instead of two.
  inkSubmitDance: false,
  // C3 — the strongest result of the spike: `instructions: ["<abs path>"]` is
  // injected into the SYSTEM message and re-resolved on EVERY request, so the
  // role is not conversation state a `/clear` could drop. Verified in a live
  // PTY: after `/clear` the marker was still in the system prompt, the previous
  // turn was gone, and the MCP tools were still offered.
  durablePreamble: true,
  // C2 — proven from both ends: `opencode mcp list` reported `✓ connected` and
  // the fake swarm-os MCP server logged `initialize` → `tools/list`, over the
  // streamable-HTTP transport, with the per-session secret in the URL PATH and
  // no custom headers.
  httpMcp: true,
};

/**
 * Indicative catalogue. Values are OpenRouter slugs (`<vendor>/<model>`); the
 * `openrouter/` provider prefix is added by `normalizeOpencodeModel`, so the
 * value is what an operator would type on openrouter.ai.
 *
 * The anthropic entries are the ids the spike actually drove opencode with
 * (C1b captured `anthropic/claude-opus-5` on the outbound request; C5b used
 * `anthropic/claude-sonnet-4.5`). The others are plausible but unattested — and
 * that is fine: the server deliberately never validates a model string, the UI
 * keeps a free-text escape hatch, and `opencode models openrouter` lists 342
 * ids (or `https://openrouter.ai/api/v1/models`, which answers HTTP 200 with no
 * credentials, so the UI can populate itself without any installed CLI).
 */
const OPENCODE_MODELS: readonly ProviderModel[] = [
  { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5 (OpenRouter)' },
  { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (OpenRouter)' },
  { value: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (OpenRouter)' },
  { value: 'openai/gpt-5.5', label: 'GPT-5.5 (OpenRouter)' },
  { value: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro (OpenRouter)' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (OpenRouter)' },
];

const OPENCODE_DEFAULT_MODEL = BUILTIN_PROVIDER_DEFAULT_MODELS.opencode;

/**
 * `<vendor>/<model>` → `openrouter/<vendor>/<model>`, idempotently: an operator
 * who free-texts the fully-qualified id in the UI must not end up with
 * `openrouter/openrouter/…`. An empty string falls back to the default model
 * rather than producing the bare prefix `openrouter/`, which opencode would
 * reject as a malformed id.
 */
export function normalizeOpencodeModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0) return `${OPENCODE_MODEL_PREFIX}${OPENCODE_DEFAULT_MODEL}`;
  return trimmed.startsWith(OPENCODE_MODEL_PREFIX)
    ? trimmed
    : `${OPENCODE_MODEL_PREFIX}${trimmed}`;
}

export interface OpencodeConfigInput {
  /** Fully-qualified model id, already through `normalizeOpencodeModel`. */
  model: string;
  /** AGENT-VISIBLE absolute path of the preamble file, or null when there is none. */
  instructionsPath: string | null;
  /** team-comms url (secret in the path), or null when MCP is not wired. */
  mcpUrl: string | null;
  mcpServerKey?: string;
  mcpTimeoutMs?: number;
}

/**
 * The exact JSON handed to opencode through `OPENCODE_CONFIG_CONTENT`
 * (report §"Config to generate"). Pure — unit-tested on its own.
 *
 * Two shapes that look like typos and are not:
 *   - the MCP discriminator is **`"remote"`**, NOT `"http"` (C2). `"local"` is
 *     the stdio flavour.
 *   - `"permission": "allow"` duplicates the `--auto` flag ON PURPOSE (C4).
 *     Each one alone was verified sufficient; belt and braces, because the
 *     failure mode of getting it wrong is a TUI frozen on an invisible
 *     `Allow once / Reject` dialog at 0 B/s, indistinguishable from idle.
 */
export function buildOpencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    model: input.model,
  };
  if (input.instructionsPath) {
    // Absolute path, and deliberately NOT `AGENTS.md` in the project: the role
    // must not depend on which repo the agent happens to work in, and the agent
    // must not be able to edit its own role out of a repo it can write to (C3).
    config.instructions = [input.instructionsPath];
  }
  config.permission = 'allow';
  if (input.mcpUrl) {
    config.mcp = {
      [input.mcpServerKey ?? OPENCODE_MCP_SERVER_KEY]: {
        type: 'remote',
        url: input.mcpUrl,
        enabled: true,
        timeout: input.mcpTimeoutMs ?? OPENCODE_MCP_TIMEOUT_MS,
      },
    };
  }
  return config;
}

const NO_CONFIG_DIR =
  'opencode cannot be spawned without its per-session config dir: no runtime root was configured, ' +
  'so there would be no per-session XDG state, no team-comms MCP and no role preamble — an agent ' +
  'that boots looking healthy and is not a member of the swarm';

const NO_API_KEY =
  'opencode cannot be spawned without an OpenRouter API key: without OPENROUTER_API_KEY the ' +
  '`openrouter` provider does not exist at all in opencode, so every model id fails to resolve. ' +
  'Paste one in Settings → OPENROUTER (it applies to the next spawn, no restart) ' +
  `or set ${SWARM_OPENROUTER_KEY_ENV} on the server.`;

export class OpencodeProvider implements AgentProvider {
  readonly id = 'opencode';
  readonly label = 'OpenCode (OpenRouter)';
  readonly binary = 'opencode';
  readonly capabilities = OPENCODE_CAPABILITIES;

  /**
   * Host-side `~/.opencode` (`config.hostOpencodeDir`). Captured for symmetry
   * with the other adapters and currently UNUSED on purpose: opencode keeps no
   * state there and needs no shared host credential (see
   * `OPENCODE_SHARED_ENTRIES`). Kept so a future finding has somewhere to land
   * without touching `index.ts` again.
   */
  protected readonly hostDir: string | null;

  /** Per-session state, keyed by container config dir. See `OpencodeSessionState`. */
  private readonly _sessions = new Map<string, OpencodeSessionState>();

  /** Rotating cursor over the control-plane port window. */
  private _portCursor = 0;

  /**
   * Stored-key source, or `null` for the env-var fallback alone. See
   * `useKeySource` for why this is late-bound rather than a constructor arg.
   */
  private _keySource: OpenRouterKeySource | null = null;

  constructor(config?: Config, keySource?: OpenRouterKeySource) {
    this.hostDir = config?.hostOpencodeDir ?? null;
    this._keySource = keySource ?? null;
  }

  /**
   * Bind the `instance_settings`-backed key source AFTER construction.
   *
   * Necessary because the provider registry is built during the runtime
   * materialisation phase of boot (`src/index.ts`), which runs BEFORE the SQLite
   * file is opened — there is no store to pass at construction time. The
   * alternative was to reorder the documented boot phases so the DB opens
   * earlier, which buys nothing and moves a lot of load-bearing ordering.
   *
   * Binding late is safe because nothing reads the key until a spawn or a probe,
   * both of which happen after boot: an unbound source simply behaves like the
   * env-only fallback, which is also exactly what unit tests want.
   */
  useKeySource(source: OpenRouterKeySource | null): void {
    this._keySource = source;
  }

  models(): readonly ProviderModel[] {
    return OPENCODE_MODELS;
  }

  defaults(): { model: string; effort: EffortLevel; permissionMode: PermissionMode } {
    return {
      model: OPENCODE_DEFAULT_MODEL,
      // Carried for interface completeness only — `capabilities.effort` is
      // false, so nothing ever reads this value into a flag.
      effort: 'high',
      permissionMode: 'bypassPermissions',
    };
  }

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------

  /**
   * The ONE place the OpenRouter key comes from (Lot 6b).
   *
   * Order: the `instance_settings` row first (masked in the UI, rotatable at
   * runtime), then `SWARM_OS_OPENROUTER_API_KEY` as a fallback.
   *
   * WHY THE ROW WINS: this deployment runs 24/7 and is never recreated for a
   * config change. A key set from the UI must therefore beat whatever the
   * container happened to be started with — the opposite order would make the
   * masked field silently ineffective on any host that ever exported the env
   * var, which is the worst kind of bug: a form that accepts a value and
   * changes nothing.
   *
   * WHY THE ENV VAR STAYS: dev boxes and CI have no UI to type into and no
   * reason to seed a database. It is also the escape hatch if the row is ever
   * unreadable.
   *
   * READ ON EVERY CALL, never cached in a field — that is what makes a rotation
   * effective on the next spawn and what makes `probe()` change its mind
   * (availability has its own 60 s TTL upstream; a cache here would stack a
   * second, unbounded one on top and freeze the boot-time verdict forever).
   * The read is one indexed row through better-sqlite3, i.e. synchronous and
   * free, which is what lets `buildSpawn` stay pure.
   *
   * Contract, relied on by both callers: synchronous, `null` (never `''`) when
   * unset. It MAY throw (SQLite can fail) — every call site goes through
   * `_resolveApiKeySafely()`, which is what turns that into a readable reason
   * instead of a rejected promise inside the availability cache.
   */
  protected resolveApiKey(): string | null {
    const stored = this._keySource?.getOpenRouterApiKey() ?? null;
    if (typeof stored === 'string') {
      const trimmed = stored.trim();
      if (trimmed.length > 0) return trimmed;
    }
    const raw = process.env[SWARM_OPENROUTER_KEY_ENV];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * `resolveApiKey()` behind a guard. It hits SQLite (Lot 6b) and `probe()` must
   * never throw — a DB error has to become a readable reason, not a rejected
   * promise inside the availability cache.
   */
  private _resolveApiKeySafely(): { key: string | null; error: string | null } {
    try {
      return { key: this.resolveApiKey(), error: null };
    } catch (err) {
      return { key: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // PHASE A — per-session config dir
  // ---------------------------------------------------------------------------

  /**
   * Creates `<runtimeRoot>/opencode/<sessionId>/` (0700) holding:
   *   - `config/`, `data/`, `cache/`, `state/` — this session's `XDG_*` roots.
   *     `data/` is where opencode puts `opencode.db` (SQLite + WAL), `auth.json`
   *     and its logs; giving each session its own keeps the blast radius and the
   *     cleanup to one directory (C1, C1b).
   *   - `SWARM_ROLE.md` — the durable preamble, referenced from `instructions[]`.
   *
   * Also allocates the control-plane port + password (C8) — done here rather
   * than in `buildSpawn` because `buildSpawn` must stay pure and repeatable, and
   * a freshly minted password on every call would not match the running process.
   *
   * Unlike claude, this needs NO hook token and NO main HTTP port: opencode has
   * no shell-hook mechanism, its notification channel is the `--port` SSE stream.
   * A session with a `runtimeRoot` therefore always gets a config dir.
   *
   * `cleanupPaths` is the session dir itself: one `rmSync` takes the four XDG
   * roots, the SQLite db and the preamble with it. NOT optional — unlike
   * claude's dir (symlinks + a trust seed, nothing that grows), this one holds a
   * database and a log directory that grow for as long as the agent lives.
   */
  prepareSessionConfig(req: SessionConfigRequest): SessionConfigResult {
    if (!req.runtimeRoot) {
      log.warn({
        event: 'session.opencode_no_runtime_root',
        sessionId: req.sessionId,
        detail: 'no runtimeRoot configured — opencode cannot be isolated per session',
      });
      return { configDir: null, cleanupPaths: [] };
    }
    this._sweepDeadSessions();
    const sessionDir = path.join(req.runtimeRoot, OPENCODE_SESSION_SUBDIR, req.sessionId);
    try {
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(sessionDir, 0o700);
      } catch {
        /* best-effort — an existing dir with a different mode is not fatal */
      }
      const xdg: OpencodeXdgDirs = {
        config: path.join(sessionDir, 'config'),
        data: path.join(sessionDir, 'data'),
        cache: path.join(sessionDir, 'cache'),
        state: path.join(sessionDir, 'state'),
      };
      for (const dir of [xdg.config, xdg.data, xdg.cache, xdg.state]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          /* best-effort */
        }
      }
      let rolePath: string | null = null;
      if (req.preamble && req.preamble.length > 0) {
        rolePath = path.join(sessionDir, OPENCODE_ROLE_FILE);
        // `writeSessionFile`: a link left at this path by an earlier run would
        // otherwise be followed and this session's preamble written through it.
        writeSessionFile(rolePath, req.preamble);
      }
      const control = this._allocateControlPlane();
      this._sessions.set(sessionDir, {
        sessionId: req.sessionId,
        configDir: sessionDir,
        xdg,
        rolePath,
        control,
        mcpUrl: null,
      });
      log.info({
        event: 'session.opencode_config_prepared',
        sessionId: req.sessionId,
        configDir: sessionDir,
        controlPort: control.port,
        preamble: rolePath !== null,
      });
      return { configDir: sessionDir, cleanupPaths: [sessionDir] };
    } catch (err) {
      log.warn({
        event: 'session.opencode_config_failed',
        sessionId: req.sessionId,
        configDir: sessionDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return { configDir: null, cleanupPaths: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // PHASE B.1 — team-comms MCP
  // ---------------------------------------------------------------------------

  /**
   * Records the team-comms url for the inline config and writes NO FILE, hence
   * the `null` return — the type's own definition of it ("null when this
   * provider needs no separate MCP artifact").
   *
   * That is the whole point of `OPENCODE_CONFIG_CONTENT`: the per-session secret
   * lives only in the process environment, and there is no path that could be
   * mistyped into the silent no-MCP-no-role session C1 warned about.
   *
   * Cost of returning null: `Session` writes no `[swarm-os] mcp.json written at
   * …` line into the session log, so the structured event below is the only
   * trace. It carries the port and the server key but NOT the url — the url
   * embeds the session secret.
   */
  writeMcpConfig(req: McpWriteRequest): McpWriteResult | null {
    if (!req.configDir) return null;
    const state = this._sessions.get(req.configDir);
    if (!state) return null;
    state.mcpUrl = `http://${req.mcpHost}:${req.mcpPort}/mcp/${req.orchestratorId}/${req.sessionSecret}`;
    log.info({
      event: 'session.opencode_mcp_inline',
      sessionId: req.sessionId,
      mcpServerKey: OPENCODE_MCP_SERVER_KEY,
      mcpPort: req.mcpPort,
    });
    return null;
  }

  /**
   * Nothing to unlink (the config never touched the disk) — this is where the
   * per-session state entry is dropped.
   *
   * It IS reliably called as of Lot 9a: `Session._cleanupMcpConfig` used to
   * early-return on `if (!this.mcpConfigPath) return;`, and `mcpConfigPath` is
   * ALWAYS null for a provider whose `writeMcpConfig` returns null — i.e. for
   * every inline-config provider, of which this is the first. The guard was
   * hoisted, so this now runs on every exit path (normal exit, failed spawn, and
   * `stop()` on a session with no process). `_sweepDeadSessions()` stays as the
   * belt to this braces: it is what bounds the map if a process is reaped in a
   * way that never reaches `_handleExit` at all.
   */
  removeMcpConfig(req: McpCleanupRequest): void {
    if (!req.configDir) return;
    this._sessions.delete(req.configDir);
  }

  /**
   * Drop state for every session whose config dir no longer exists on disk.
   *
   * `Session._cleanupSessionConfig` DOES always run on exit (it is not behind
   * the `mcpConfigPath` guard) and `rmSync`s our `cleanupPaths`, so a vanished
   * directory is hard evidence that the session is over. Run once per new
   * session — a `statSync` per live entry, which is nothing next to the four
   * `mkdirSync`s that follow — so the map's size tracks live sessions instead of
   * growing for the lifetime of a 24/7 process.
   */
  private _sweepDeadSessions(): void {
    for (const [dir, state] of this._sessions) {
      if (!fs.existsSync(dir)) {
        this._sessions.delete(dir);
        log.info({
          event: 'session.opencode_state_swept',
          sessionId: state.sessionId,
          configDir: dir,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PHASE B.2 — argv + env
  // ---------------------------------------------------------------------------

  /**
   * Pure: argv + env, no I/O. Everything it needs on disk was created in phase A
   * and every path it emits goes through `req.paths.data(…)`.
   *
   * argv (report §"Contrat pour l'adaptateur"):
   *   `--auto --port <p> --hostname 127.0.0.1 --model openrouter/<v>/<m>
   *    --prompt <text>`
   *
   * The working directory is set through the PTY, never argv: the positional of
   * `opencode [project]` is the PROJECT PATH (C0), so a prompt passed
   * positionally would become a directory name. `Session` maps the cwd with
   * `paths.workspace` on its side; NOTHING in this adapter belongs under the
   * workspace root, so `paths.workspace` is correctly never called here.
   *
   * Throws rather than degrading, in two cases — `Session._spawn` catches it,
   * marks the session `failed` and writes the message into the session log:
   *   - no config dir  ⇒ no XDG isolation, no MCP, no role. An opencode started
   *     like that would inherit the operator's own `~/.config/opencode`, share
   *     one `opencode.db` with every other session, and look perfectly healthy.
   *   - no API key     ⇒ opencode has no `openrouter` provider at all (C5), so
   *     the TUI boots and every turn fails on an unresolvable model id.
   */
  buildSpawn(req: SpawnRequest): PreparedSpawn {
    if (!req.configDir) throw new Error(NO_CONFIG_DIR);
    const state = this._sessions.get(req.configDir);
    if (!state) {
      throw new Error(
        `opencode has no prepared session state for ${req.configDir} — ` +
          'prepareSessionConfig must run before buildSpawn',
      );
    }
    const resolved = this._resolveApiKeySafely();
    if (!resolved.key) {
      throw new Error(resolved.error ? `${NO_API_KEY} (${resolved.error})` : NO_API_KEY);
    }

    const model = normalizeOpencodeModel(req.model);
    const config = buildOpencodeConfig({
      model,
      // The AGENT resolves this path, but it is a file WE wrote inside our own
      // data root — hence `paths.data`, not `paths.workspace`.
      instructionsPath: state.rolePath ? req.paths.data(state.rolePath) : null,
      mcpUrl: state.mcpUrl,
    });

    const args: string[] = [
      // C4 — without this (or `permission:"allow"`, and we set both) the loop
      // stops on an `Allow once / Allow always / Reject` dialog that emits no
      // bytes: an agent frozen forever, looking idle.
      '--auto',
      // C8 — per-session HTTP control plane + `GET /event` SSE stream. Binding
      // it is what makes `notificationHook: true` reachable at all.
      '--port',
      String(state.control.port),
      '--hostname',
      state.control.hostname,
      '--model',
      model,
    ];
    // `--prompt <text>` auto-submits the first turn AND leaves the interactive
    // session alive (C6c) — the exact equivalent of claude's positional prompt.
    // The resume notice rides it (one-shot context that a later `/clear` should
    // discard), while the durable role went to `instructions[]`.
    const prompt =
      req.resumeNotice && req.initialPrompt
        ? `${req.resumeNotice}\n\n${req.initialPrompt}`
        : (req.resumeNotice ?? req.initialPrompt ?? null);
    if (prompt) {
      args.push('--prompt', prompt);
    }

    // ⚠️ EVERYTHING GOES THROUGH `secretEnv`, and `env` is left EMPTY on purpose.
    //
    // `PreparedSpawn.env` lands on the REMOTE COMMAND LINE under SSH
    // (`agent-process.ts` emits `env K=V … exec …`), which every user on the host
    // can read through `ps`. Three of the values below are secrets:
    //
    //   - `OPENROUTER_API_KEY`       a billable credential;
    //   - `OPENCODE_CONFIG_CONTENT`  embeds the per-session team-comms MCP url,
    //                                whose PATH *is* the session's credential
    //                                (`mcp/server.ts` authenticates on
    //                                `(orch_id, session_secret)` alone — leaking
    //                                it hands over the agent's mailbox);
    //   - `OPENCODE_SERVER_PASSWORD` guards an API that can drive the agent and
    //                                read its whole transcript (C8).
    //
    // The remaining four (`XDG_*`, `OPENCODE_DISABLE_AUTOUPDATE`, `TERM`) are not
    // sensitive, but splitting the env two ways to save four `ps`-visible tokens
    // would buy nothing and leave a seam where a future value lands on the wrong
    // side. `Session` applies both buckets to the same process — the only
    // difference is exposure — so routing the whole env is free.
    //
    // Under SSH `Session` writes these to a 0600 file in the per-session config
    // dir and has the remote shell source it; in local transport they are merged
    // straight into the child's environment (no command line to leak through).
    const secretEnv: Record<string, string> = {
      // C1 — inline config beats `OPENCODE_CONFIG=<file>`: no path to typo (a
      // missing one is IGNORED, not fatal) and the MCP secret never hits disk
      // as a config file. It now transits a 0600 env file under SSH, which is
      // strictly better than the command line it used to ride.
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      XDG_CONFIG_HOME: req.paths.data(state.xdg.config),
      XDG_DATA_HOME: req.paths.data(state.xdg.data),
      XDG_CACHE_HOME: req.paths.data(state.xdg.cache),
      XDG_STATE_HOME: req.paths.data(state.xdg.state),
      // Never let an agent rewrite its own binary mid-session.
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // C8 — the control plane is UNAUTHENTICATED without these, and it can
      // drive the agent and read its transcript. Not optional on a shared host.
      OPENCODE_SERVER_USERNAME: state.control.username,
      OPENCODE_SERVER_PASSWORD: state.control.password,
      // C5 — without it opencode has no `openrouter` provider at all and every
      // model id fails to resolve. Read fresh on every spawn from
      // `instance_settings` (Lot 6b), so a rotation from the UI reaches the next
      // agent without touching the container.
      [OPENCODE_API_KEY_ENV]: resolved.key,
      // node-pty already names the pty `xterm-256color`; set it explicitly so a
      // remote login shell that scrubs the environment cannot leave the TUI
      // rendering into a dumb terminal.
      TERM: 'xterm-256color',
    };
    return { command: this.binary, args, env: {}, secretEnv };
  }

  // ---------------------------------------------------------------------------
  // Control plane (consumed by Lot 6c)
  // ---------------------------------------------------------------------------

  /**
   * Port / credentials of a live session's TUI control plane, or `null` once the
   * session is gone. Keyed by the config dir `prepareSessionConfig` returned
   * (`Session.claudeConfigDir`).
   *
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ LOT 6c — THE `/event` CONSUMER IS MISSING, and it is what makes         │
   * │ `notificationHook: true` true in practice. It must:                    │
   * │  • `GET <baseUrl>/event` with basic auth (username/password below) and  │
   * │    keep the SSE stream open for the session's lifetime;                │
   * │  • on `permission.asked`  → the agent is BLOCKED on a human. Alarm.    │
   * │  • on `session.idle`      → the turn is finished. THIS, not the byte    │
   * │    rate, is the idle signal: C4 proved a frozen TUI is silent too.     │
   * │  • treat a dead/unreachable plane as "no notification channel for this │
   * │    session" and fall back to `_idleSince`, never as a spawn failure.   │
   * │                                                                         │
   * │ ⚠️ UNDER SSH THE PLANE IS ON THE HOST'S LOOPBACK. `SshAgentProcess`     │
   * │ only sets up a REVERSE forward (`-R`, for MCP). Reaching this port from │
   * │ the container needs a FORWARD one (`ssh -L <port>:127.0.0.1:<port>`) —  │
   * │ an additive change to `agent-process.ts`, out of scope for Lot 6a.     │
   * │                                                                         │
   * │ Bonus available on the same plane: `POST /tui/append-prompt` +          │
   * │ `/tui/submit-prompt` (both answered 200 and really drove the session in │
   * │ C8) replace blind keystroke writes with an acknowledged injection path, │
   * │ and `GET /mcp` / `opencode mcp list` is a model-free health check for   │
   * │ the team-comms wiring.                                                  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  controlPlane(configDir: string | null): OpencodeControlPlane | null {
    if (!configDir) return null;
    return this._sessions.get(configDir)?.control ?? null;
  }

  /**
   * Allocate a control-plane port + basic-auth password.
   *
   * Ports are handed out by a rotating cursor over a 900-port window rather than
   * by hashing the session id: with a few dozen live sessions a hash collides
   * often enough to matter (birthday paradox), a cursor cannot collide among
   * concurrently live sessions at all.
   *
   * Known limits, both accepted for Lot 6a and both loud rather than silent:
   *   - `--port 0` (let opencode pick) is NOT usable: we would never learn which
   *     port it chose, and the whole value of the flag is that WE can connect.
   *   - two swarm-os servers driving the same host over SSH share the host's
   *     port space and could clash. If a port is taken, opencode fails to bind
   *     at boot — a visible failed session, not a silent degradation.
   * `protected` so a subclass (tests, a future lot) can pin the allocation.
   */
  protected allocateControlPort(): number {
    const slot = this._portCursor % OPENCODE_CONTROL_PORT_COUNT;
    this._portCursor = (this._portCursor + 1) % OPENCODE_CONTROL_PORT_COUNT;
    return OPENCODE_CONTROL_PORT_BASE + slot;
  }

  /** 32 hex chars from the CSPRNG. `protected` so tests can pin it. */
  protected generateServerPassword(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private _allocateControlPlane(): OpencodeControlPlane {
    const port = this.allocateControlPort();
    return {
      port,
      hostname: OPENCODE_CONTROL_HOSTNAME,
      username: OPENCODE_CONTROL_USERNAME,
      password: this.generateServerPassword(),
      baseUrl: `http://${OPENCODE_CONTROL_HOSTNAME}:${port}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Context reset
  // ---------------------------------------------------------------------------

  /**
   * `/clear` (new context, role preserved — proven in a live PTY in C3) and
   * `/compact` (summarise) are opencode's own slash commands, so the mapping is
   * the identity.
   *
   * The `instructions` argument is DROPPED on purpose. C3 injected the bare
   * `/clear`; whether opencode's slash commands accept a free-text argument is
   * UNVERIFIED, and its command palette matches on the typed token — a
   * `/compact <text>` that fails to match would leave the palette open with a
   * half-typed line and the compaction would never run, which is exactly the
   * silent failure the report warns about. A generic compaction is a lesser
   * loss than no compaction, so we log the drop and send the bare command.
   */
  contextResetLine(cmd: ContextResetCommand, instructions?: string): string | null {
    if (instructions && instructions.length > 0) {
      log.info({
        event: 'session.opencode_reset_instructions_dropped',
        cmd,
        detail:
          'opencode slash commands are not verified to accept a free-text argument; ' +
          'sending the bare command',
      });
    }
    return cmd;
  }

  /**
   * `team_team_whoami` — delegated to `opencodeMcpToolName`, which stays the
   * single source of truth for the mangling (module header, point 4). The
   * default server key it closes over is the one `buildOpencodeConfig` writes,
   * so a change to `OPENCODE_MCP_SERVER_KEY` moves the config and the preamble
   * together instead of silently desynchronising them.
   */
  mcpToolName(logicalName: string): string {
    return opencodeMcpToolName(logicalName);
  }

  // ---------------------------------------------------------------------------
  // Runtime materialisation — nothing to do
  // ---------------------------------------------------------------------------

  /** No container-side shared state: there is no host credential to lift (C5). */
  initRuntime(_opts: RuntimeInitOptions): RuntimeInitOutcome {
    return { initialized: false, copied: false, skipReason: 'not-applicable' };
  }

  refreshSharedFiles(_opts: RuntimeInitOptions): void {
    /* nothing shared container-side */
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  /**
   * Two independent prerequisites, and the operator is told WHICH one is
   * missing — an installed opencode without a key is installed-but-useless, and
   * "provider unavailable" with no distinction would send them looking in the
   * wrong place.
   *
   * Binary first, deliberately: it is the bigger prerequisite (`opencode` is the
   * only one of the four CLIs not installed on this host), and reporting the key
   * first would have an operator configure a key for a CLI that still is not
   * there. `available:false` with a version attached is the "installed, no
   * credentials" state.
   *
   * Never throws: `probeCliBinary` already converts every failure into a reason,
   * and the key lookup goes through `_resolveApiKeySafely` because Lot 6b's
   * implementation will read SQLite.
   */
  async probe(ctx: ProviderProbeContext): Promise<ProviderAvailability> {
    const cli = await probeCliBinary({ ...ctx, binary: this.binary });
    if (!cli.available) {
      return {
        available: false,
        reason:
          cli.reason ??
          `\`${this.binary}\` is not usable — install it on the agent host (\`npm i -g opencode-ai\`)`,
      };
    }
    const resolved = this._resolveApiKeySafely();
    if (resolved.error) {
      return {
        available: false,
        reason: `opencode is installed but the OpenRouter API key could not be read: ${resolved.error}`,
        ...(cli.version ? { version: cli.version } : {}),
      };
    }
    if (!resolved.key) {
      return {
        available: false,
        reason:
          'opencode is installed but no OpenRouter API key is configured — without it opencode has ' +
          'no `openrouter` provider at all and every model fails to resolve. Paste a key in ' +
          'Settings → OPENROUTER: this verdict re-evaluates on the next availability poll (60 s), ' +
          `no restart needed. A server-side ${SWARM_OPENROUTER_KEY_ENV} also works.`,
        ...(cli.version ? { version: cli.version } : {}),
      };
    }
    return cli;
  }
}
