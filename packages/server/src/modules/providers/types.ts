/**
 * Agent provider abstraction (multi-provider plan, Lot 1).
 *
 * Until now every agent was a `claude` process: the binary was hard-coded in
 * `Session._spawn`, the argv was `buildClaudeArgs`, and the per-session config
 * dir was `CLAUDE_CONFIG_DIR`. This module names the contract a CLI agent has
 * to satisfy to be driven by a `Session`, so `claude` becomes one adapter
 * among several (codex / gemini / opencode land in later lots).
 *
 * Two design points are load-bearing and must survive any future edit:
 *
 *  1. **Three phases, not one.** `Session` prepares the config dir in its
 *     constructor (`prepareSessionConfig`), *then* opens the log, *then*
 *     spawns — and the spawn writes the MCP config (`writeMcpConfig`) BEFORE
 *     the `skipSpawn` early return, logging `[swarm-os] mcp.json written at …`
 *     into the already-open stream. Merging phase A with phase B.1 would move
 *     that log line and reorder the failure modes.
 *
 *  2. **`AgentPathMapper` instead of an SSH bundle.** Adapters *write* to
 *     container paths and *reference* them through the mapper (identity in
 *     local transport, `toHostPath` under SSH). That is the only thing that
 *     used to differ between `_linkSharedClaudeState` and its SSH twin, and
 *     it keeps every adapter blind to the transport.
 */

import type { AgentTransport, Config, EffortLevel, PermissionMode } from '../../config.js';

/**
 * Identifier of a provider — `'claude'` today, `'codex' | 'gemini' |
 * 'opencode'` in later lots. Deliberately a plain string so a plugin can
 * register one without a core release.
 */
export type ProviderId = string;

/**
 * Context-reset commands the server can inject into a live PTY at a task
 * boundary. `/clear` wipes the conversation (the role survives via the durable
 * preamble); `/compact` summarizes and continues.
 *
 * Lives here rather than in `session.ts` because `contextResetLine` is part of
 * the provider contract. `session.ts` re-exports it for its existing callers.
 */
export type ContextResetCommand = '/clear' | '/compact';

/**
 * What a provider's notification callback MEANS — not merely whether it exists.
 *
 * This is a semantic, not a boolean, because the four CLIs do NOT signal the
 * same event and treating them alike makes an agent unusable:
 *
 *  - `'needs-human'`   the callback fires when the agent is BLOCKED on a human
 *                      (claude's `Notification` hook). This is the only value
 *                      that may flip a session's badge to `waiting`, notify
 *                      Discord, or arm the `compactOnWaiting` safety net as a
 *                      "the agent is stuck" signal.
 *  - `'turn-complete'` the callback fires at EVERY turn boundary, whether or not
 *                      anyone is needed — codex's `notify`
 *                      (`{"type":"agent-turn-complete"}`, spike S1 C5) and
 *                      gemini's `AfterAgent` hook, which fires even on a turn
 *                      that failed (spike S2 C5). An agent that runs twenty
 *                      turns produces twenty callbacks: routing those to Discord
 *                      and to the badge would mean twenty "waiting" alerts and
 *                      twenty armed compactions for an agent nobody is waiting
 *                      on. It is an INACTIVITY boundary, and that is all.
 *  - `false`           the server receives nothing. The session never reaches
 *                      `waiting`, "agent is waiting" notifications and
 *                      `compactOnWaiting` are mute for it (plan Risk 8). That is
 *                      a documented degradation — it must be DECLARED so the UI
 *                      can show it, not discovered by an operator wondering why
 *                      a team looks silent.
 *
 * The value describes what THE SERVER RECEIVES, not what the CLI is capable of
 * in principle: a provider whose channel exists but has no consumer wired
 * (opencode's SSE `/event` stream, Lot 6c) declares `false` until the consumer
 * ships, because that is what an operator observes.
 *
 * Consumed by `http/routes/hooks.ts`, which filters the three branches.
 */
export type NotificationHookSemantics = false | 'needs-human' | 'turn-complete';

/** One entry of a provider's indicative model catalogue (drives the UI selects). */
export interface ProviderModel {
  /** Exact id passed to the CLI. */
  value: string;
  /** Human label shown in the UI. */
  label: string;
}

/**
 * What a provider can and cannot express. The UI greys out what is missing
 * instead of pretending it works, and `Session` skips the PTY choreography a
 * provider does not need.
 */
export interface ProviderCapabilities {
  /** Can express our `EffortLevel` (claude `--effort`, codex `model_reasoning_effort`). */
  effort: boolean;
  /**
   * Permission modes the CLI actually understands; anything else is coerced to
   * `fallbackPermissionMode`.
   *
   * RULE (settled — both an empty array and a one-element array used to be
   * plausible for a CLI with no permission vocabulary, and the UI had to handle
   * both):
   *
   *   1. NEVER EMPTY. Every provider runs the agent *somehow*, and this array
   *      names that somehow. "No modes at all" would read as "cannot run".
   *   2. It MUST contain `fallbackPermissionMode` — the coercion target has to be
   *      a mode the CLI accepts, or coercion produces an argv the CLI rejects.
   *   3. `length === 1` IS the machine-checkable "permission is not a choice for
   *      this provider" signal (codex's sandbox flag, gemini's `--yolo`,
   *      opencode's permission matrix): exactly one mode, and it is the
   *      fallback. A consumer never needs to special-case an empty list to
   *      discover that.
   *
   * `ProviderRegistry.register` enforces 1 and 2 at the door so a plugin cannot
   * ship an adapter that violates them.
   */
  permissionModes: readonly PermissionMode[];
  /** Mode used when the requested one is not in `permissionModes`. Must be listed there. */
  fallbackPermissionMode: PermissionMode;
  /**
   * WHAT the provider's notification callback means — see
   * `NotificationHookSemantics`. `false` ⇒ a session never reaches `waiting`.
   *
   * Deliberately not a boolean: codex and gemini both fire at EVERY turn
   * boundary, and treating that like claude's "I need a human" hook produced one
   * Discord alert and one armed `/compact` per turn.
   */
  notificationHook: NotificationHookSemantics;
  /**
   * The CLI runs an Ink TUI that treats a multi-byte chunk as a *paste*: the
   * trailing `\r` lands in the prompt buffer as a newline instead of firing.
   * Such a CLI needs the two-step write (text, then a solo CR ~150 ms later).
   * `false` means one write with the CR attached is enough.
   */
  inkSubmitDance: boolean;
  /**
   * The role preamble survives a context reset (claude
   * `--append-system-prompt`, gemini `GEMINI.md`, codex `AGENTS.md`).
   * MANDATORY: an agent whose role is wiped by `/clear` keeps its tools and
   * loses its mailbox discipline — it looks alive and behaves at random.
   */
  durablePreamble: boolean;
  /** Can reach the team-comms MCP over streamable HTTP. MANDATORY. */
  httpMcp: boolean;
}

/**
 * Translates container-side absolute paths into the paths the *agent process*
 * will resolve. Identity in local transport; `toHostPath` under SSH.
 *
 * ⚠️ TWO ROOTS, NOT ONE — and they are NOT interchangeable. The container has
 * two independent bind mounts (`dataDir → hostDataDir` and
 * `workspaceRoot → hostWorkspaceRoot`); a path under one is meaningless to the
 * other, and `toHostPath` passes a non-matching prefix THROUGH UNCHANGED
 * rather than failing. So picking the wrong one is silent:
 *
 *  - `data(p)`      — everything the SERVER writes: the per-session config dir
 *                     (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME`),
 *                     the per-session `mcp.json`, any file an adapter drops in
 *                     its own config dir.
 *  - `workspace(p)` — the AGENT's cwd, and every key derived from it: the
 *                     `projects["<cwd>"]` trust entry in claude's
 *                     `.claude.json`, codex's `[projects."<cwd>"]
 *                     trust_level`, gemini's `trustedFolders.json`.
 *
 * Getting this wrong under SSH does not throw: the agent simply re-opens its
 * "do you trust the files in this folder?" dialog, the PTY wedges on a widget
 * nobody can see, and the session looks merely "busy". Use `workspace` for
 * anything the AGENT resolves relative to where it runs, `data` for anything
 * WE wrote.
 */
export interface AgentPathMapper {
  data(containerPath: string): string;
  workspace(containerPath: string): string;
}

/** Mapper for the local transport — the agent shares our filesystem namespace. */
export const IDENTITY_PATH_MAPPER: AgentPathMapper = {
  data: (p) => p,
  workspace: (p) => p,
};

/**
 * PHASE A — everything that must exist on disk before the process is launched:
 * the 0700 per-session config dir, the shared-state symlinks, the pre-accepted
 * trust dialogs, the notification hook and the durable preamble.
 *
 * Runs in the `Session` constructor, before the log stream is opened.
 */
export interface SessionConfigRequest {
  sessionId: string;
  orchestratorId: string;
  /** Container-side cwd of the agent. */
  cwd: string;
  transport: AgentTransport;
  paths: AgentPathMapper;
  /** Durable role instructions. Providers that have no argv slot write a file. */
  preamble: string | null;
  /** Bearer token the notification hook authenticates with. */
  hookToken?: string | undefined;
  /** Main HTTP port the notification hook POSTs back to. */
  mainHttpPort?: number | undefined;
  /**
   * Base URL the hook curl targets instead of `http://127.0.0.1:<mainHttpPort>`
   * (`config.hookUrl` — required under the ssh transport, where the hook runs
   * on the host and the container-internal loopback port is not this server).
   */
  hookUrl?: string | undefined;
  /**
   * Writable per-container runtime root holding the shared agent state
   * (`<dataDir>/.claude-runtime`). Absent ⇒ no per-session config dir.
   */
  runtimeRoot?: string | undefined;
  /** RO source mount of the host's state dir (e.g. `/claude-source`). */
  sourceDir?: string | undefined;
  /**
   * Explicit override for the config file that lives *beside* the source dir
   * (claude's `~/.claude.json`). Falls back to `<sourceDir>.json`.
   */
  siblingSource?: string | null | undefined;
  /**
   * Host-side shared state dir the per-session symlinks point at under SSH.
   * Carries `config.hostClaudeDir` — it is the CLAUDE root and nothing else.
   *
   * Other adapters must NOT read it: codex/gemini/opencode take their own root
   * from `config.hostCodexDir` / `hostGeminiDir` / `hostOpencodeDir`, captured
   * at construction (`createBuiltinProviderRegistry(config)`). Symlinking a
   * codex session's `auth.json` into `~/.claude` would produce an agent that
   * starts, shows no error, and is not authenticated.
   */
  hostSharedDir?: string | null | undefined;
}

export interface SessionConfigResult {
  /** Container path of the per-session config dir, or null when not configured. */
  configDir: string | null;
  /**
   * Paths to remove when the session exits. Empty for claude (its per-session
   * dir is deliberately left in place). Consumed from Lot 4 onwards.
   */
  cleanupPaths: readonly string[];
}

/**
 * PHASE B.1 — the team-comms MCP wiring. Claude writes a standalone
 * `mcp.json`; codex/gemini merge a block into their per-session config file.
 * Runs at spawn time, into the already-open session log.
 */
export interface McpWriteRequest {
  /** Root for per-session MCP artifacts, e.g. `/tmp/swarm-os`. */
  runtimeDir: string;
  orchestratorId: string;
  sessionId: string;
  sessionSecret: string;
  /** MCP bind host. Always loopback. */
  mcpHost: string;
  mcpPort: number;
  /** The config dir returned by `prepareSessionConfig` (may be null). */
  configDir: string | null;
  paths: AgentPathMapper;
}

export interface McpWriteResult {
  /** Container path of the file the agent will read. */
  path: string;
  /** URL embedded in the config (handy for logging / tests). */
  url: string;
}

export interface McpCleanupRequest {
  runtimeDir: string;
  orchestratorId: string;
  sessionId: string;
  configDir: string | null;
}

/** PHASE B.2 — pure: argv + env. No I/O. */
export interface SpawnRequest {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  initialPrompt: string | null;
  preamble: string | null;
  /** One-shot prefix for the positional prompt (the resume notice). */
  resumeNotice: string | null;
  /**
   * docs/outils-par-role.md — the BUILT-IN tools to expose (claude `--tools`).
   * `null` / absent = the provider's default set. Providers without such a
   * switch ignore it.
   */
  builtinTools?: readonly string[] | null;
  /** Container-side cwd. Translate through `paths.workspace` when referencing it. */
  cwd: string;
  /** Container path of the per-session config dir (null when unconfigured). */
  configDir: string | null;
  /** Container path of the MCP config written in phase B.1 (null on failure). */
  mcpConfigPath: string | null;
  paths: AgentPathMapper;
}

export interface PreparedSpawn {
  /** Binary to exec (locally or on the remote host). */
  command: string;
  args: string[];
  /**
   * Non-secret env.
   *
   * ⚠️ Under SSH this lands on the REMOTE COMMAND LINE (`agent-process.ts` emits
   * `env K=V … exec …`), which is world-readable through `ps` on the host. Put
   * nothing here that you would not print in a log.
   */
  env: Record<string, string>;
  /**
   * Env that must NOT ride the remote command line.
   *
   * `Session` writes these to a 0600 file inside the per-session config dir and
   * has the remote shell source it (`set -a && . <file> && set +a && exec …`)
   * instead of prefixing `env K=V`. In local transport they are merged into the
   * child's environment directly — there is no command line to leak through.
   *
   * An adapter may route its ENTIRE env through here: `env` and `secretEnv` are
   * applied to the same process, and the only difference is exposure. opencode
   * does exactly that, because all of its values are sensitive
   * (`OPENCODE_CONFIG_CONTENT` embeds the per-session MCP secret, and
   * `OPENCODE_SERVER_PASSWORD` guards an API that can drive the agent and read
   * its transcript). Providers with nothing secret leave this undefined and keep
   * the historical `env K=V` prefix byte for byte.
   *
   * Keys must be valid POSIX shell identifiers (`[A-Za-z_][A-Za-z0-9_]*`) — the
   * file is *sourced* by the remote shell, so a key it cannot parse would break
   * the whole spawn. `Session` drops (and logs) anything else rather than
   * emitting a file that fails to source.
   */
  secretEnv?: Record<string, string>;
}

/** Options for the boot-time / lazy runtime materialisation of shared state. */
export interface RuntimeInitOptions {
  sourceDir: string;
  runtimeDir: string;
  siblingSource?: string | null;
}

/**
 * What `initRuntime` reports back. Returned (rather than logged inside the
 * adapter) so the BOOT log line stays owned by `index.ts` — it is the line an
 * operator greps when an agent lands on `/login`.
 *
 * Providers with no container-side state (every non-claude adapter, and claude
 * itself under SSH) return `{ initialized: false, copied: false, skipReason:
 * 'not-applicable' }`.
 */
export interface RuntimeInitOutcome {
  initialized: boolean;
  copied: boolean;
  /** Why nothing was copied — `'source-missing'`, `'cache-hit'`, … */
  skipReason?: string | null;
  /** Top-level entries copied on this boot, when a copy ran. */
  entriesCopied?: number | null;
  /** Lift result of the sibling config file (claude: `~/.claude.json`). */
  sibling?: string | null;
  /** Source path used for that sibling lift, if any. */
  siblingSource?: string | null;
}

/** Result of a `probe()` — surfaced by `GET /providers` (Lot 2). */
export interface ProviderAvailability {
  available: boolean;
  /** Why it is unavailable — shown to the operator so they can fix it. */
  reason?: string;
  version?: string;
}

/**
 * Everything a `probe()` needs. `config` is carried because the SSH probe runs
 * through `modules/orchestrator/ssh-exec.ts`, which reads the key / port /
 * target off it.
 */
export interface ProviderProbeContext {
  transport: AgentTransport;
  config: Config;
  /** Wall-clock budget for the probe. The cache passes its own. */
  timeoutMs?: number;
}

/**
 * One CLI agent, adapted to what `Session` needs. Implementations live next to
 * this file (`claude.ts`, later `codex.ts` / `gemini.ts` / `opencode.ts`) and
 * are registered in the `ProviderRegistry`.
 */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Binary name resolved on PATH (locally or through the remote login shell). */
  readonly binary: string;
  readonly capabilities: ProviderCapabilities;

  /** Indicative catalogue — the UI keeps a free-text escape hatch. */
  models(): readonly ProviderModel[];
  defaults(): { model: string; effort: EffortLevel; permissionMode: PermissionMode };
  /**
   * Turn a stored model value into the id to EXEC, at spawn time only
   * (docs/model-aliases.md). A family alias (`opus`, `sonnet[1m]`, …) becomes
   * the newest concrete member; anything else comes back unchanged. Optional:
   * an adapter without aliases is the identity. Must not throw.
   */
  resolveModel?(model: string): string;

  /** PHASE A — see `SessionConfigRequest`. Must not throw. */
  prepareSessionConfig(req: SessionConfigRequest): SessionConfigResult;
  /** PHASE B.1 — `null` when this provider needs no separate MCP artifact. */
  writeMcpConfig(req: McpWriteRequest): McpWriteResult | null;
  removeMcpConfig(req: McpCleanupRequest): void;
  /** PHASE B.2 — pure. */
  buildSpawn(req: SpawnRequest): PreparedSpawn;

  /**
   * The literal line typed into the PTY for a context reset, or `null` when
   * this provider has no working reset — in which case `Session` logs the
   * refusal and resolves without writing. A broken reset is worse than none:
   * it can wipe the role while leaving the tools in place.
   */
  contextResetLine(cmd: ContextResetCommand, instructions?: string): string | null;

  /**
   * What the MODEL must type to call the team-comms tool whose LOGICAL name is
   * `logicalName` (`team.whoami`, `swarm.list_teams`, `discord.send_message`).
   *
   * MANDATORY, and the reason it exists: **three of the four CLIs rename MCP
   * tools before showing them to the model**, and a preamble that names tools
   * which do not exist produces an agent that improvises or drops team comms
   * altogether — an agent with tools and no mailbox is not a swarm member,
   * which is the same failure `capabilities.durablePreamble` guards against.
   * Measured, not assumed (see each adapter for the transcript):
   *
   *   claude    `team.whoami`                  (identity — see `claude.ts`)
   *   codex     `team_whoami`                  (dots → `_`, inside the
   *                                             `mcp__team_comms__` namespace)
   *   gemini    `mcp_team-comms_team.whoami`   (`mcp_<server>_` prefix)
   *   opencode  `team_team_whoami`             (`<configKey>_`, dots → `_`)
   *
   * SCOPE: this is a RENDERING concern and nothing else. The logical dotted name
   * stays the identifier everywhere in this codebase — the MCP server registers
   * `team.whoami`, `logCall` logs `team.whoami`, `SIGNAL_TEXT` says
   * `team.read_inbox`. `modules/orchestrator/preamble.ts` is the only consumer:
   * it translates the text handed to the agent, and only that.
   *
   * Must be PURE and total: same input ⇒ same output, no I/O, never throws, and
   * it must return a non-empty string for any input (an adapter that cannot name
   * a tool returns the logical name unchanged rather than nothing).
   */
  mcpToolName(logicalName: string): string;

  /**
   * OPTIONAL — the per-session HTTP control plane this adapter started, keyed by
   * the config dir `prepareSessionConfig` returned. opencode is the only adapter
   * that has one (`--port` + basic auth); everybody else omits the method
   * entirely, which is how `Session` decides whether a control-plane context
   * source is even possible (docs/monitoring-agents.md, Lot 7).
   *
   * `null` once the session is gone, or before its plane was allocated. The
   * returned credentials are the ones the running process is actually using —
   * minting fresh ones here would produce a plane nobody can talk to.
   */
  controlPlane?(
    configDir: string | null,
  ): { baseUrl: string; username: string; password: string } | null;

  /**
   * Only exercised by claude in local transport (no-op elsewhere): materialise
   * the host's state dir into the container's writable runtime root. Called
   * once at boot, through the registry, BEFORE the HTTP server accepts traffic.
   */
  initRuntime(opts: RuntimeInitOptions): RuntimeInitOutcome;
  /** Lazy per-spawn refresh of the host-volatile files (OAuth rotation). */
  refreshSharedFiles(opts: RuntimeInitOptions): void;

  /**
   * Is this CLI usable right now, from where the agents actually run?
   *
   * MANDATORY, and deliberately re-run at runtime rather than once at boot:
   * this deployment runs 24/7 and is not restarted to pick up a host change.
   * Installing a CLI on the host must make it appear at the next poll — see
   * `providers/availability.ts` for the TTL cache that owns the cadence.
   *
   * Must never throw: a failed probe is `{ available: false, reason }`.
   */
  probe(ctx: ProviderProbeContext): Promise<ProviderAvailability>;
}
