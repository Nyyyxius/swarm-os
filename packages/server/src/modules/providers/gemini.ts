/**
 * Google Gemini CLI adapter (multi-provider plan, Lot 5).
 *
 * Every structural claim below was PROVEN by spike S2
 * (`scripts/verify-gemini.report.md`, `@google/gemini-cli 0.35.2`) or read
 * straight out of the installed CLI's `config/settingsSchema.js`. Where the
 * plan and the spike disagreed, the spike won — the divergences are called out
 * inline so nobody "fixes" them back.
 *
 *   - isolation:  `GEMINI_CLI_HOME=<per-session dir>` re-routes the WHOLE config
 *                 tree — gemini treats it as a `$HOME`, so the real config lives
 *                 in `<dir>/.gemini/` (`paths.js` reads the env var inside
 *                 `homedir()`, `storage.js` appends `.gemini`). Never override
 *                 `HOME`: that would also move `~/.gitconfig`, `~/.ssh`,
 *                 `~/.npmrc` for every shell command the agent runs.
 *   - argv:       `-m <model> --yolo <positional prompt>`. `-p/--prompt` is
 *                 HEADLESS (no TUI, nothing to drive) and is never passed.
 *   - MCP:        `mcpServers["team-comms"] = { httpUrl, trust: true, timeout }`
 *                 — `httpUrl`, NOT claude's `{ type: 'http', url }`. Arbitrary
 *                 path segments survive, so our `/mcp/<orch>/<secret>` session
 *                 URL works verbatim.
 *   - preamble:   `<sd>/.gemini/GEMINI.md` — loaded as global memory, folded
 *                 into the system instruction and re-derived by `resetChat()`,
 *                 so it survives `/clear` AND `/compact`. `GEMINI_SYSTEM_MD`
 *                 REPLACES the base prompt (tool instructions included) and is
 *                 banned.
 *   - trust:      `<sd>/.gemini/trustedFolders.json` = `{ "<cwd>": "TRUST_FOLDER" }`.
 *                 Not cosmetic twice over: without it the TUI wedges on "Do you
 *                 trust the files in this folder?", AND
 *                 `hookRegistry.processHooksFromConfig()` disables EVERY hook
 *                 for an untrusted folder — so the notification hook depends on
 *                 this file.
 *   - notify:     `hooks.AfterAgent`, NOT `hooks.Notification`. gemini's
 *                 `NotificationType` enum only has `ToolPermission` and its only
 *                 caller is `fireToolNotificationEvent()`: under `--yolo`
 *                 permission is never asked, so a `Notification` hook would fire
 *                 literally never and the `waiting` status would be lost
 *                 forever. `AfterAgent` is what gemini's own `hooks migrate`
 *                 maps claude's `Stop` onto, and it fires even on a turn that
 *                 failed. The shell command itself is claude's, unchanged — the
 *                 stdin payload is Claude-Code-compatible.
 *   - autoupdate: `general.enableAutoUpdate` and `enableAutoUpdateNotification`
 *                 both default to TRUE and make gemini shell out to
 *                 `npm install -g` at boot, printing into the PTY. Both must be
 *                 false or idle detection reads the banner as activity.
 *
 * Risk 4 in the plan: if a future gemini drops `GEMINI_CLI_HOME`, every session
 * would collapse onto ONE config dir — one MCP url — and each agent would
 * authenticate as whichever session wrote last. That is why the re-routing
 * check is the RUNTIME probe (below) and not merely a spike assertion.
 *
 * ⚠️ NOT VALIDATED END-TO-END. No model turn has ever completed against this
 * adapter. First the host's OAuth was refused by the CLI itself
 * (`IneligibleTierError: This client is no longer supported for Gemini Code
 * Assist for individuals`); the operator then moved that host to an API key
 * (2026-07-26: `~/.gemini/settings.json` says `gemini-api-key`, and no
 * `oauth_creds.json` is left), after which a TUI does come up and authenticate
 * but the turn still ends in `✕ [API Error: An unknown error occurred.]`.
 * Everything here is structural: file layout, settings shape, argv, env, probe.
 * See the report's "reste à valider".
 *
 * One decision was REVERSED after Lot 5 (consolidation, Lot 9a): the shared
 * credentials are SYMLINKED, not copied — under SSH a copy has no readable
 * source, so the adapter shipped with no credentials at all in the only transport
 * this deployment uses. See `GEMINI_SHARED_ENTRIES`.
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import { hostExec as nodeHostExec } from '../orchestrator/ssh-exec.js';
import {
  buildNotificationHookCommand,
  linkSharedState,
  writeSessionFile,
  writeSessionJson,
} from './session-config.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';
import { PROBE_DEFAULT_TIMEOUT_MS } from './probe.js';
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

/**
 * Same binding as `claude.ts`: phase-A / phase-B failures are session events,
 * and operators grep `module: session` for them.
 */
const log = withModule('session');

/**
 * Entries of the host's `~/.gemini` a per-session config dir needs: the
 * credentials and the install identity. `settings.json`, `GEMINI.md`,
 * `trustedFolders.json` and `projects.json` are per-session by construction
 * (they carry this session's MCP url, preamble and cwd) and stay REGULAR FILES.
 *
 * These are **SYMLINKED**, exactly like `claude.ts` does for
 * `.credentials.json` — reversing an earlier decision in this adapter to COPY
 * them. The copy was chosen because gemini rewrites `oauth_creds.json` on token
 * refresh and FOLLOWS symlinks, so a link makes the agent write into the shared
 * `~/.gemini` (observed during spike S2). Two facts make the copy the worse
 * option:
 *
 *  1. **Under SSH a copy is impossible.** `this.hostDir` is a HOST path and the
 *     host's `~/.gemini` is NOT mounted into the container, so there is nothing
 *     to read — the copy silently placed NOTHING and the session fell back to
 *     whatever `GEMINI_API_KEY` the host login shell happened to export. SSH is
 *     the transport this deployment runs. A symlink needs no readable source:
 *     the agent resolves it in its own namespace, which is the whole reason the
 *     claude path works.
 *  2. **N copies of ONE refresh token invalidate each other.** Google may rotate
 *     the refresh token on use; each session refreshing its own copy leaves the
 *     others (and the host) holding a revoked one. Through a symlink the refresh
 *     lands in the shared file and every session — plus the operator — moves
 *     forward together. Writing to the shared credentials file IS the intended
 *     product behaviour: it is what claude has done in production all along.
 *
 * What is NOT shared: `settings.json` above all. It carries this session's MCP
 * url and notification hook, and the host's own copy carries the operator's
 * personal MCP servers — linking it would cross-wire both.
 */
export const GEMINI_SHARED_ENTRIES: readonly string[] = [
  'oauth_creds.json',
  'google_accounts.json',
  'installation_id',
];

/** The shared entry whose presence decides which auth method a session pins. */
const OAUTH_CREDS_FILE = 'oauth_creds.json';

/**
 * `security.auth.selectedType` values gemini understands (`AuthType` in the
 * installed bundle). Only used to reject a typo in `SWARM_OS_GEMINI_AUTH_TYPE`
 * before it reaches a session — a bogus value there is a modal on every agent.
 */
const GEMINI_AUTH_TYPES: readonly string[] = [
  'oauth-personal',
  'gemini-api-key',
  'vertex-ai',
  'compute-default-credentials',
];

/**
 * What a session pins when we could not establish anything about the host.
 *
 * Both wrong guesses break the session; they do not break it equally, and this
 * is the measured difference (gemini 0.52.0, PTY capture, 2026-07-26):
 *
 *   - `oauth-personal` with no credentials → gemini drops OUT of the TUI and
 *     prints `Please visit the following URL to authorize…` / `Enter the
 *     authorization code:`, then goes SILENT (754 B in 27 s). The PTY is quiet,
 *     so idle detection calls the agent idle, team messages are typed into an
 *     authorization-code prompt, and the team looks alive while doing nothing.
 *   - `gemini-api-key` with no usable key → the TUI renders and every turn ends
 *     in a visible `✕ [API Error: …]` (15 954 B in 24 s). Broken, but broken ON
 *     SCREEN, in the transcript the operator and the lead read.
 *
 * So the default is the loud one. (Note it is NOT the "clean death" one: on
 * 0.52.0 an api-key session does not exit, and with no key at all the CLI can
 * fall through to its API-key input box — measured on a host whose keychain
 * happened to hold a key, so the TUI came up and errored per turn instead.)
 *
 * The right fix for a host that uses OAuth is `SWARM_OS_GEMINI_AUTH_TYPE`, which
 * every unverified session names in its log line.
 */
const GEMINI_SSH_DEFAULT_AUTH_TYPE = 'gemini-api-key';

/**
 * gemini treats `GEMINI_CLI_HOME` as a `$HOME`: the config tree it actually
 * reads is `<GEMINI_CLI_HOME>/.gemini/`. Getting this level wrong writes a
 * `settings.json` gemini never reads — no MCP, no hook, no trust, and no error.
 */
const GEMINI_CONFIG_SUBDIR = '.gemini';

/**
 * Per-provider namespace for the session homes, under the shared runtime root.
 *
 * DIVERGENCE from the spike report's `<runtimeDir>/sessions/<session_id>`
 * suggestion (which was about OUR layout, not about gemini's behaviour): claude
 * owns `<runtimeRoot>/sessions/` and NEVER deletes what it puts there, while
 * gemini's homes are `rm -rf`'d on exit (`cleanupPaths`) because they hold this
 * session's MCP url and its own state. Putting a destructive lifecycle inside
 * another adapter's namespace is the kind of thing that goes wrong exactly once.
 */
const GEMINI_SESSIONS_SUBDIR = 'gemini-sessions';

/** Logical MCP server name — same as claude's, so the preamble reads the same. */
const GEMINI_MCP_SERVER_NAME = 'team-comms';

/** Connect/handshake budget for the team-comms server, in ms (spike C2). */
const GEMINI_MCP_TIMEOUT_MS = 30_000;

/**
 * The hook event that actually fires. See the module header: `Notification` is
 * a ToolPermission-only event and never fires under `--yolo`.
 */
const GEMINI_HOOK_EVENT = 'AfterAgent';

/**
 * The only value that means "trusted" — `TrustLevel` in
 * `config/trustedFolders.js` is `TRUST_FOLDER | TRUST_PARENT | DO_NOT_TRUST`.
 */
const GEMINI_TRUST_LEVEL = 'TRUST_FOLDER';

/** Filenames written into `<sd>/.gemini/`. */
const SETTINGS_FILE = 'settings.json';
const PREAMBLE_FILE = 'GEMINI.md';
const TRUSTED_FOLDERS_FILE = 'trustedFolders.json';
const PROJECT_REGISTRY_FILE = 'projects.json';

/**
 * Seed for gemini's own project registry, written into every FRESH config dir.
 *
 * Not cosmetic: `ProjectRegistry.getShortId()` creates the registry when it is
 * missing (`if (!existsSync) await this.save({projects:{}})`) and `save()` uses a
 * FIXED `projects.json.tmp` name, so two concurrent cold callers race and the
 * loser's `rename` fails. gemini catches it but prints a full ENOENT stack —
 * verified on 0.35.2: a cold `GEMINI_CLI_HOME` reproduces it every time, and
 * seeding this file makes the output clean (`0.35.2` and nothing else). Every
 * one of our config dirs is cold by construction, so without the seed each agent
 * would open its PTY with an ENOENT stack trace on screen.
 */
const EMPTY_PROJECT_REGISTRY = { projects: {} };

/**
 * How gemini renames a team-comms tool for the model:
 * `mcp_<server>_<tool>`, then every character outside `[A-Za-z0-9_\-.:]`
 * replaced by `_`. **Dots and dashes survive** — `team.whoami` on `team-comms`
 * reaches the model as `mcp_team-comms_team.whoami`.
 *
 * This is a faithful re-implementation of gemini's own `generateValidName()`,
 * read out of the installed bundle (`@google/gemini-cli` 0.52.0,
 * `bundle/chunk-7LQRUKPT.js`, the chunk `bundle/gemini.js` imports):
 *
 *     let n = name.startsWith("mcp_") ? name : `mcp_${name}`;
 *     n = n.replace(/[^a-zA-Z0-9_\-.:]/g, "_");
 *     if (/^[^a-zA-Z_]/.test(n)) n = `_${n}`;
 *     … truncate above 63 chars …
 *
 * and applied to `` `${serverName}_${serverToolName}` `` by
 * `DiscoveredMCPTool`'s constructor, whose `nameOverride` is `undefined` at the
 * only call site (`discoverTools`) — so the fully-qualified name IS the
 * registered name, and `ToolRegistry.registerTool` stores it as-is.
 *
 * MEASURED on top of that reading, because spike S2 could only observe a
 * DOTLESS probe tool (`mcp_swarm-probe_swarm_probe_ping`) and the dotted form
 * was the open question: gemini was pointed at a real MCP server exposing
 * `team.whoami` / `team.send_message` and at a fake model endpoint
 * (`GOOGLE_GEMINI_BASE_URL`) that records the request. Its
 * `:streamGenerateContent` body declared, verbatim,
 * `mcp_team-comms_team.whoami` and `mcp_team-comms_team.send_message`.
 *
 * Two branches of the original are deliberately NOT reproduced:
 *   - the leading `_` for a name that starts with a non-letter: ours always
 *     starts with `mcp_`;
 *   - the >63-char truncation (`slice(0,30) + "..." + slice(-30)`), which would
 *     put an ellipsis inside a tool name. Our longest rendered name is 36 chars
 *     (`mcp_team-comms_team.kill_all_workers`) and `preamble.test.ts` pins that
 *     every provider's rendering stays under the limit, so the branch is
 *     unreachable rather than merely unlikely.
 */
export function geminiMcpToolName(
  logicalName: string,
  serverName: string = GEMINI_MCP_SERVER_NAME,
): string {
  return `mcp_${serverName}_${logicalName}`.replace(/[^a-zA-Z0-9_\-.:]/g, '_');
}

const GEMINI_CAPABILITIES: ProviderCapabilities = {
  // No reasoning-effort knob on the CLI — the UI greys the control out rather
  // than sending a flag that does nothing. (`settings.modelConfigs.*.
  // generateContentConfig.thinkingConfig.thinkingBudget` exists, but it is a
  // settings-file value per model, not our per-agent EffortLevel.)
  effort: false,
  // `--yolo` auto-approves everything; there is no finer vocabulary we can map
  // our modes onto, so every mode is coerced to bypassPermissions.
  permissionModes: ['bypassPermissions'],
  fallbackPermissionMode: 'bypassPermissions',
  // `settings.json` `hooks.AfterAgent`, Claude-Code-compatible stdin payload —
  // but it fires at the END OF EVERY TURN, including a turn that failed (spike
  // C5). It is an inactivity boundary, NOT "a human is needed": gemini's only
  // human-attention event is `Notification`, which fires exclusively on a tool
  // permission request and therefore never under `--yolo`.
  notificationHook: 'turn-complete',
  // Gemini CLI renders with Ink, exactly like Claude Code: spike C7 proved a
  // single `"text\r"` write NEVER submits, while text + a solo CR 150 ms later
  // always does.
  inkSubmitDance: true,
  // `<sd>/.gemini/GEMINI.md` survives `/clear` and `/compact` (spike C3).
  durablePreamble: true,
  // `httpUrl` + `trust: true` (spike C2).
  httpMcp: true,
};

/**
 * Indicative catalogue, read off `@google/gemini-cli-core`'s
 * `config/models.js` (0.35.2). Aliases (`pro`, `flash`, `auto`) are valid input
 * too but are deliberately not listed — a stored alias would silently change
 * meaning under the operator when Google re-points it.
 */
const GEMINI_MODELS: readonly ProviderModel[] = [
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
];

// ---------------------------------------------------------------------------
// Availability probe — constants
// ---------------------------------------------------------------------------

/**
 * Floor on the TOTAL probe budget (both invocations), defence in depth.
 *
 * A gemini boot costs 2 755 ms for `--version` and ~2 400 ms for `mcp list` on
 * this host (re-measured against 0.52.0 on 2026-07-26; spike C1 saw 2 628 /
 * 2 875 ms on 0.35.2). The availability cache used to hand adapters 2 500 ms,
 * which timed out on every single poll and pinned gemini to `available:false`
 * forever. That was fixed WHERE IT BELONGED — `AVAILABILITY_PROBE_TIMEOUT_MS`
 * is 12 000 ms (see its comment for why overrunning the cold wait costs
 * nothing); the probe now spends it across two boots, so the floor is raised to
 * match rather than left at the single-boot value.
 *
 * This floor makes the adapter correct for ANY caller: a test, a plugin, or a
 * future regression that lowers the central budget again cannot silently turn
 * gemini into a permanently-unavailable provider whose only explanation is a
 * timeout. It stays far below the cache's 60 s TTL, which is what bounds
 * overlap.
 */
export const GEMINI_PROBE_MIN_TIMEOUT_MS = 16_000;

/** Floor on each individual invocation once the shared budget is split. */
const GEMINI_PROBE_MIN_STEP_MS = 2_000;

/**
 * The MCP server name the probe seeds into the throwaway `settings.json` and
 * then looks for in `gemini mcp list`. Deliberately unique and unmistakable:
 * finding this string in the output is the PROOF that gemini read the file we
 * placed in the home we pointed it at.
 */
export const GEMINI_PROBE_MCP_NAME = 'swarm-os-reroute-probe';

/**
 * Its endpoint. A closed loopback port with a 1 s handshake budget: `mcp list`
 * reports it `Disconnected` in ~0 ms and the LISTING is what we read, never the
 * connection. Never contains a single quote — the JSON rides inside a
 * single-quoted argument of the SSH probe script.
 */
const GEMINI_PROBE_MCP_URL = `http://127.0.0.1:59999/mcp/${GEMINI_PROBE_MCP_NAME}`;
const GEMINI_PROBE_MCP_TIMEOUT_MS = 1_000;

/**
 * `settings.json` for the throwaway home.
 *
 * Two things beyond the marker server, both load-bearing for a PROBE that runs
 * once a minute against the host: the auto-update flags default to TRUE and
 * make gemini shell out to `npm install -g` at startup (the same trap the
 * session settings guard — a probe must never upgrade the operator's CLI under
 * them), and the home-directory warning is one less thing on the output we
 * parse.
 */
const GEMINI_PROBE_SETTINGS = {
  mcpServers: {
    [GEMINI_PROBE_MCP_NAME]: {
      httpUrl: GEMINI_PROBE_MCP_URL,
      trust: true,
      timeout: GEMINI_PROBE_MCP_TIMEOUT_MS,
    },
  },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  ui: { showHomeDirectoryWarning: false },
};

/**
 * Markers the SSH script prints around the `mcp list` output, so the container
 * can tell the version output from the read proof in ONE merged stream — and so
 * a script that died halfway is distinguishable from one that proved something
 * (no `READ_END` ⇒ nothing proven ⇒ never "available").
 */
export const GEMINI_PROBE_READ_BEGIN = 'swarm-os-gemini-probe read-begin';
export const GEMINI_PROBE_READ_END = 'swarm-os-gemini-probe read-end';

/** Phrase gemini prints when it found NO server list at all. */
const NO_MCP_RE = /No MCP servers configured/i;
/**
 * Phrase gemini prints when it DID read a server list but the cwd is untrusted.
 * Weaker than the name match (it does not prove the list is OURS) and kept only
 * as a fallback for the case where the trust seed does not take — on 0.52.0 the
 * server names are listed even then, measured 2026-07-26.
 */
const MCP_UNTRUSTED_RE = /MCP servers are configured but disabled/i;

/** Exit code the SSH probe script reserves for its own staging failures. */
const PROBE_EXIT_STAGING = 90;

// ---------------------------------------------------------------------------
// Injection seams (tests never run the real binary)
// ---------------------------------------------------------------------------

/** Narrow shape of `child_process.spawnSync` the local probe needs. */
export type ProbeSpawnSync = (
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    /**
     * The probe's own throwaway working directory. It is what
     * `trustedFolders.json` is keyed on, so gemini must actually run there —
     * inheriting the server's cwd would make the trust seed miss.
     */
    cwd: string;
    encoding: 'utf8';
    timeout: number;
    windowsHide: boolean;
  },
) => {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error | undefined;
};

/** Narrow shape of `ssh-exec.hostExec` the SSH probe needs. */
export type ProbeHostExec = (
  config: Config,
  input: { argv: string[]; timeoutMs?: number },
) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

export interface GeminiProviderDeps {
  spawnSync?: ProbeSpawnSync;
  hostExec?: ProbeHostExec;
}

/** Shape of the bits of `settings.json` this adapter owns. */
interface GeminiSettings {
  security?: { auth?: { selectedType?: string } };
  general?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export class GeminiProvider implements AgentProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini CLI';
  readonly binary = 'gemini';
  readonly capabilities = GEMINI_CAPABILITIES;

  /**
   * Host-side `~/.gemini` (`config.hostGeminiDir`) — the source the per-session
   * credentials are COPIED from. Do NOT read
   * `SessionConfigRequest.hostSharedDir`: that field carries claude's
   * `~/.claude`, and seeding a gemini session from it produces an agent that
   * starts, shows no error and is not authenticated.
   */
  protected readonly hostDir: string | null;

  /**
   * `config.geminiAuthType` — the operator's explicit
   * `security.auth.selectedType`, or `null`. It outranks everything the adapter
   * can infer, because under SSH the adapter can infer nothing (see
   * `_selectAuthType`).
   */
  protected readonly authTypeOverride: string | null;

  private readonly _spawnSync: ProbeSpawnSync;
  private readonly _hostExec: ProbeHostExec;

  constructor(config?: Config, deps: GeminiProviderDeps = {}) {
    this.hostDir = config?.hostGeminiDir ?? null;
    this.authTypeOverride = config?.geminiAuthType ?? null;
    this._spawnSync = deps.spawnSync ?? (nodeSpawnSync as unknown as ProbeSpawnSync);
    this._hostExec = deps.hostExec ?? nodeHostExec;
  }

  models(): readonly ProviderModel[] {
    return GEMINI_MODELS;
  }

  defaults(): { model: string; effort: EffortLevel; permissionMode: PermissionMode } {
    // `effort` is inert for this provider (capabilities.effort === false); the
    // value is carried so the shared session plumbing keeps one shape.
    return {
      model: BUILTIN_PROVIDER_DEFAULT_MODELS.gemini,
      effort: 'high',
      permissionMode: 'bypassPermissions',
    };
  }

  // -------------------------------------------------------------------------
  // PHASE A — the per-session GEMINI_CLI_HOME
  // -------------------------------------------------------------------------

  /**
   * Build `<runtimeRoot>/gemini-sessions/<sessionId>/` (the fake `$HOME`) with
   * `.gemini/` inside it, and fill that with everything gemini must find on
   * disk BEFORE it boots:
   *
   *   - the credential symlinks into the shared `~/.gemini` (see
   *     `GEMINI_SHARED_ENTRIES` for why links and not copies);
   *   - `trustedFolders.json`, without which the TUI wedges on the trust dialog
   *     and every hook is silently disabled;
   *   - `GEMINI.md`, the durable role preamble;
   *   - `settings.json` with the auto-update flags off, the auth mode pinned and
   *     the `AfterAgent` notification hook.
   *
   * Never throws (contract): a failure downgrades to `configDir: null`, which
   * makes `buildSpawn` refuse. That refusal is the point — a gemini launched
   * without an isolated `GEMINI_CLI_HOME` would fall back on the ONE shared
   * `~/.gemini`, i.e. one MCP url and one identity for every session.
   *
   * DIVERGENCE from `claude.ts`, deliberate: claude returns `null` when the hook
   * wiring is incomplete (no `hookToken` / `mainHttpPort`). Here isolation
   * outranks the hook, so we still build the config dir and simply omit the
   * `hooks` block — a session with no `waiting` signal is a degradation, a
   * session sharing `~/.gemini` is a cross-authentication bug.
   */
  prepareSessionConfig(req: SessionConfigRequest): SessionConfigResult {
    if (!req.runtimeRoot) {
      log.warn({
        event: 'session.gemini_config_skipped',
        sessionId: req.sessionId,
        reason: 'no runtimeRoot — cannot isolate GEMINI_CLI_HOME',
      });
      return { configDir: null, cleanupPaths: [] };
    }
    const home = path.join(req.runtimeRoot, GEMINI_SESSIONS_SUBDIR, req.sessionId);
    const cfgDir = path.join(home, GEMINI_CONFIG_SUBDIR);
    try {
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      // mkdirSync's `mode` does not touch dirs that already existed, and the
      // umask can strip bits; force both levels. The home holds links to the
      // OAuth credentials and this session's MCP url, so 0700 is not cosmetic.
      for (const dir of [home, cfgDir]) {
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          /* best-effort */
        }
      }
      this._linkSharedState(req, cfgDir);
      // Seed gemini's project registry so its cold-start rename race does not
      // print an ENOENT stack into the PTY on the agent's first screen.
      this._writeJson(path.join(cfgDir, PROJECT_REGISTRY_FILE), EMPTY_PROJECT_REGISTRY);
      this._writeTrustedFolders(req, cfgDir);
      this._writePreamble(req, cfgDir);
      this._writeSettings(req, cfgDir, this._selectAuthType(req, cfgDir));
      // `cleanupPaths` removes the WHOLE fake home on exit: it holds gemini's
      // per-session state (history, chats, tmp) and the credential symlinks,
      // none of which should outlive the session. `fs.rmSync` removes a symlink,
      // never its target, so the shared `~/.gemini` is untouched.
      return { configDir: home, cleanupPaths: [home] };
    } catch (err) {
      log.warn({
        event: 'session.settings_failed',
        sessionId: req.sessionId,
        provider: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Still ask for the cleanup: a half-written home may already hold this
      // session's MCP url and its credential links.
      return { configDir: null, cleanupPaths: [home] };
    }
  }

  /**
   * SYMLINK the shared credentials into `<sd>/.gemini/`, the same way
   * `claude.ts` shares `.credentials.json` — see `GEMINI_SHARED_ENTRIES` for why
   * this is a link and not a copy.
   *
   * `this.hostDir` is the right target in BOTH transports: under SSH it is the
   * host's real `~/.gemini`, a path only the AGENT can resolve (hence
   * `existsCheck: false` — we cannot stat it, and a dangling link is exactly what
   * a missing host file should look like), and in local transport it resolves in
   * the namespace we share with the agent, so there we skip what is absent.
   *
   * Deliberately returns NOTHING the auth decision could hang off. It used to
   * return "the entries present", decided by `lstat` on the LINK — which under
   * SSH is true for every entry the moment we create it, dangling or not, so
   * `selectedType` was pinned to `oauth-personal` in the only transport this
   * deployment uses, whatever the host actually had. `_selectAuthType` now asks
   * a question that can come back false.
   *
   * Best-effort and never throws: a session with no credentials still gets its
   * isolated config dir, which matters more (one shared `~/.gemini` would mean
   * one MCP url and one identity for every agent — plan Risk 4).
   */
  private _linkSharedState(req: SessionConfigRequest, cfgDir: string): void {
    const src = this.hostDir;
    if (!src) {
      log.warn({
        event: 'session.gemini_shared_dir_missing',
        sessionId: req.sessionId,
        reason: 'no config.hostGeminiDir (SWARM_OS_HOST_GEMINI_DIR) — session starts with no credentials',
      });
      return;
    }
    const isSsh = req.transport === 'ssh';
    linkSharedState({
      targetRoot: src,
      configDir: cfgDir,
      entries: GEMINI_SHARED_ENTRIES,
      existsCheck: !isSsh,
      onError: (info) => {
        log.warn({
          event: isSsh
            ? 'session.gemini_shared_link_ssh_failed'
            : 'session.gemini_shared_link_failed',
          sessionId: req.sessionId,
          entry: info.entry,
          target: info.target,
          error: info.error,
        });
      },
    });
  }

  /**
   * Which `security.auth.selectedType` this session pins — and WHY, in the log.
   *
   * gemini has no "use whatever works" mode: leaving `selectedType` unset opens
   * the auth-method picker, an Ink modal that repaints forever, so the agent is
   * never idle, is never handed its team messages and is never context-reset. A
   * value MUST be chosen. Three sources, in this order:
   *
   *  1. `SWARM_OS_GEMINI_AUTH_TYPE` — the operator states it. Always wins,
   *     because it is the only source that is right by construction.
   *  2. The credentials link, RESOLVED (`existsSync` follows it, so a dangling
   *     link is `false`). This is the honest test and it works wherever the
   *     target is in OUR namespace — i.e. the local transport.
   *  3. Under SSH, nothing: `hostGeminiDir` is a host path, not mounted in the
   *     container, and `prepareSessionConfig` is synchronous so there is no
   *     round trip to make. We pin `GEMINI_SSH_DEFAULT_AUTH_TYPE` and say so at
   *     WARN, naming the variable that fixes it.
   *
   * The bug this replaces: the choice used to be made from `lstat` on the link
   * we had just created, and `lstat` describes the LINK. Under SSH the link is
   * created unconditionally (`existsCheck: false`), so the test was
   * `true` — always — and `gemini-api-key` was unreachable in the only transport
   * this deployment uses. On a host with no `oauth_creds.json` that produced an
   * OAuth prompt in place of the TUI and an agent that looks idle for ever.
   */
  private _selectAuthType(req: SessionConfigRequest, cfgDir: string): string {
    const override = this.authTypeOverride;
    if (override) {
      if (GEMINI_AUTH_TYPES.includes(override)) {
        log.info({
          event: 'session.gemini_auth_selected',
          sessionId: req.sessionId,
          selectedType: override,
          evidence: 'SWARM_OS_GEMINI_AUTH_TYPE',
        });
        return override;
      }
      log.warn({
        event: 'session.gemini_auth_override_invalid',
        sessionId: req.sessionId,
        value: override,
        known: GEMINI_AUTH_TYPES.join(', '),
        reason: 'SWARM_OS_GEMINI_AUTH_TYPE is not a value gemini understands — ignoring it',
      });
    }
    if (req.transport !== 'ssh') {
      // Follows the symlink: true only when the target really exists.
      const hasCreds = fs.existsSync(path.join(cfgDir, OAUTH_CREDS_FILE));
      const selectedType = hasCreds ? 'oauth-personal' : GEMINI_SSH_DEFAULT_AUTH_TYPE;
      log.info({
        event: 'session.gemini_auth_selected',
        sessionId: req.sessionId,
        selectedType,
        evidence: hasCreds
          ? `${OAUTH_CREDS_FILE} resolves under ${this.hostDir ?? '(no host dir)'}`
          : `no readable ${OAUTH_CREDS_FILE} under ${this.hostDir ?? '(no host dir)'}`,
      });
      return selectedType;
    }
    log.warn({
      event: 'session.gemini_auth_unverified',
      sessionId: req.sessionId,
      selectedType: GEMINI_SSH_DEFAULT_AUTH_TYPE,
      hostDir: this.hostDir,
      reason:
        `ssh transport: the container cannot see ${this.hostDir ?? '~/.gemini'} on the host, so ` +
        `whether ${OAUTH_CREDS_FILE} exists there is unknowable. Pinning ` +
        `'${GEMINI_SSH_DEFAULT_AUTH_TYPE}' (a failure that shows up in the PTY) rather than ` +
        "'oauth-personal' (an authorization prompt on a silent PTY, i.e. an agent that looks " +
        'idle for ever). Set SWARM_OS_GEMINI_AUTH_TYPE to the method the host is logged in with.',
    });
    return GEMINI_SSH_DEFAULT_AUTH_TYPE;
  }

  /**
   * Pre-accept the folder-trust dialog for this session's cwd.
   *
   * ⚠️ `paths.workspace`, NOT `paths.data`: this key is resolved by the AGENT
   * against where it runs. Under SSH the agent lives in the host namespace, so
   * a container path here silently misses and gemini re-opens the modal — the
   * PTY then repaints at ~400 B/s forever and the session looks merely "busy"
   * (spike C4/C8). The file is a FLAT map keyed by the cwd's realpath; a
   * workspace reached through a symlink would still miss, which is why the
   * workspace root is expected to be a real path.
   */
  private _writeTrustedFolders(req: SessionConfigRequest, cfgDir: string): void {
    const key = req.paths.workspace(req.cwd);
    this._writeJson(path.join(cfgDir, TRUSTED_FOLDERS_FILE), {
      [key]: GEMINI_TRUST_LEVEL,
    });
  }

  /**
   * The durable role preamble. `GEMINI.md` at the root of the fake home is
   * loaded as "global memory", folded into the system instruction by
   * `getCoreSystemPrompt(config, userMemory)` and re-derived by `resetChat()` —
   * so it survives `/clear` and `/compact` (spike C3), which is what makes a
   * context reset safe for this provider.
   *
   * Written VERBATIM. It used to get a tool-naming note stapled to it here,
   * because the preamble named the dotted tools gemini does not expose; the
   * names are now rendered correctly upstream (`mcpToolName` →
   * `modules/orchestrator/preamble.ts`), so this adapter is back to being a
   * transport for a text it does not interpret.
   */
  private _writePreamble(req: SessionConfigRequest, cfgDir: string): void {
    if (!req.preamble) return;
    writeSessionFile(path.join(cfgDir, PREAMBLE_FILE), `${req.preamble.trimEnd()}\n`);
  }

  /**
   * `<sd>/.gemini/settings.json`. Phase B.1 merges `mcpServers` into this same
   * file, so anything written here has to survive a read-modify-write.
   *
   * `security.auth.selectedType` is pinned so gemini never opens the auth-method
   * picker: any modal keeps the Ink renderer repainting, which reads as
   * "permanently busy" and kills idle detection (spike C8). WHICH value is
   * pinned is `_selectAuthType`'s decision — it is the interesting one, and it
   * is not a property of this file.
   */
  private _writeSettings(
    req: SessionConfigRequest,
    cfgDir: string,
    selectedType: string,
  ): void {
    const settings: GeminiSettings = {
      security: { auth: { selectedType } },
      general: {
        // MANDATORY, both of them: they default to true and make gemini run
        // `npm install -g` at boot, printing into the PTY (spike C8).
        enableAutoUpdate: false,
        enableAutoUpdateNotification: false,
      },
      ui: {
        // One less startup warning that could hold the renderer.
        showHomeDirectoryWarning: false,
      },
    };
    if (req.hookToken && req.mainHttpPort) {
      const command = buildNotificationHookCommand({
        orchestratorId: req.orchestratorId,
        sessionId: req.sessionId,
        hookToken: req.hookToken,
        mainHttpPort: req.mainHttpPort,
      });
      // `AfterAgent`, not `Notification` — see the module header. Same
      // `{ matcher, hooks[] }` schema as Claude Code (verified against
      // gemini's `settingsSchema.js` `HookDefinitionArray`), and the same shell
      // command byte for byte: gemini's stdin payload carries `session_id`,
      // `transcript_path`, `cwd` and `hook_event_name` exactly like claude's.
      settings.hooks = {
        [GEMINI_HOOK_EVENT]: [
          {
            matcher: '',
            hooks: [{ type: 'command', command }],
          },
        ],
      };
    } else {
      log.warn({
        event: 'session.gemini_hook_skipped',
        sessionId: req.sessionId,
        reason: 'no hookToken / mainHttpPort — this session will never report `waiting`',
      });
    }
    this._writeJson(path.join(cfgDir, SETTINGS_FILE), settings);
  }

  // -------------------------------------------------------------------------
  // PHASE B.1 — team-comms MCP, merged into the per-session settings.json
  // -------------------------------------------------------------------------

  /**
   * gemini has no `--mcp-config` equivalent: the server list lives in
   * `settings.json`, which phase A already wrote. So this is a read-merge-write
   * — clobbering the file would drop the hook, the auth mode and the
   * auto-update flags.
   *
   * `httpUrl` (NOT claude's `{ type: 'http', url }`), `trust: true` so the
   * tools need no per-call approval, and an explicit `timeout`. The full
   * `/mcp/<orch>/<secret>` path reaches the server verbatim (spike C2), so the
   * session-identifying URL works unchanged.
   *
   * Throws on a write failure, like claude's: `Session` downgrades that to "run
   * without MCP" and logs `session.mcp_config_write_failed`.
   */
  writeMcpConfig(req: McpWriteRequest): McpWriteResult | null {
    if (!req.configDir) return null;
    const settingsPath = path.join(req.configDir, GEMINI_CONFIG_SUBDIR, SETTINGS_FILE);
    const url = `http://${req.mcpHost}:${req.mcpPort}/mcp/${req.orchestratorId}/${req.sessionSecret}`;
    const current = this._readSettings(settingsPath) ?? {};
    const merged: GeminiSettings = {
      ...current,
      // Re-asserted rather than assumed: if the phase-A file was unreadable we
      // fell back to `{}`, and losing these two flags means an `npm install -g`
      // in the PTY at boot.
      general: {
        ...(current.general ?? {}),
        enableAutoUpdate: false,
        enableAutoUpdateNotification: false,
      },
      mcpServers: {
        ...(current.mcpServers ?? {}),
        [GEMINI_MCP_SERVER_NAME]: {
          httpUrl: url,
          trust: true,
          timeout: GEMINI_MCP_TIMEOUT_MS,
        },
      },
    };
    this._writeJson(settingsPath, merged);
    return { path: settingsPath, url };
  }

  /**
   * Revoke the session's MCP url from `settings.json`.
   *
   * The whole fake home is `rm -rf`'d by `cleanupPaths` on exit, so on the happy
   * path this is redundant — but `Session._spawn` calls `_cleanupMcpConfig()`
   * WITHOUT `_cleanupSessionConfig()` when the spawn itself fails, and leaving a
   * live session-secret URL in a file on disk is not something to shrug at.
   *
   * Must never throw: `Session._cleanupMcpConfig` does not guard the call, and a
   * throw there would keep a session from reaching a terminal state.
   */
  removeMcpConfig(req: McpCleanupRequest): void {
    if (!req.configDir) return;
    const settingsPath = path.join(req.configDir, GEMINI_CONFIG_SUBDIR, SETTINGS_FILE);
    try {
      const current = this._readSettings(settingsPath);
      if (!current?.mcpServers || !(GEMINI_MCP_SERVER_NAME in current.mcpServers)) return;
      const rest = { ...current.mcpServers };
      delete rest[GEMINI_MCP_SERVER_NAME];
      this._writeJson(settingsPath, { ...current, mcpServers: rest });
    } catch (err) {
      log.warn({
        event: 'session.gemini_mcp_cleanup_failed',
        sessionId: req.sessionId,
        path: settingsPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // PHASE B.2 — pure: argv + env
  // -------------------------------------------------------------------------

  /**
   * `gemini -m <model> --yolo <positional prompt>`.
   *
   *   - the POSITIONAL argument is what starts an interactive TUI seeded with a
   *     first turn. `-p/--prompt` is headless — it prints an answer and exits,
   *     leaving nothing for `Session` to drive.
   *   - `--yolo` == `--approval-mode yolo`. Every `PermissionMode` we might be
   *     handed collapses onto it (`capabilities.permissionModes`), and `effort`
   *     has no CLI equivalent at all — both are ignored here on purpose.
   *   - the preamble is NOT in the argv: it went to `GEMINI.md` in phase A,
   *     which is what makes it survive `/clear`.
   *   - `mcpConfigPath` is unused: gemini's MCP lives in `settings.json`.
   *
   * Refuses (throws) without a per-session config dir. `Session` turns that into
   * a failed session with the reason in its log, which is strictly better than a
   * gemini falling back on the shared `~/.gemini`: one config dir means one MCP
   * url, and every agent would then authenticate to team-comms as whichever
   * session wrote the file last (plan Risk 4).
   */
  buildSpawn(req: SpawnRequest): PreparedSpawn {
    if (!req.configDir) {
      throw new Error(
        'gemini requires an isolated GEMINI_CLI_HOME (no per-session config dir was ' +
          'prepared): without it every session would share one ~/.gemini, hence one ' +
          'MCP url and one identity',
      );
    }
    const args = ['-m', req.model, '--yolo'];
    // Same composition as claude: the positional prompt is the disposable part
    // (a `/clear` discards it); durable instructions live in GEMINI.md.
    const positional =
      req.resumeNotice && req.initialPrompt
        ? `${req.resumeNotice}\n\n${req.initialPrompt}`
        : (req.resumeNotice ?? req.initialPrompt ?? null);
    // `--` FIRST — see the same guard in `claude.ts`. yargs splits a leading
    // `---` into flags and drops the text:
    //   $ gemini --yolo '---\n…'   →  Unknown arguments: -, ""     (exit 1)
    // and `buildResumeNotice` starts with exactly that, so every resumed
    // gemini session would have died at argv parsing. With `--` the same
    // invocation reaches the auth stage. Measured on 0.52.0, 2026-07-26.
    if (positional) args.push('--', positional);
    return {
      command: this.binary,
      args,
      // `paths.data`: the config dir is something WE wrote under the dataDir
      // bind mount. (`paths.workspace` would pass it through unchanged and
      // gemini would look for a container path that does not exist on the host.)
      env: { GEMINI_CLI_HOME: req.paths.data(req.configDir) },
    };
  }

  /**
   * `/clear` is native; `/compact` is a declared `altNames` of `/compress`
   * (`ui/commands/compressCommand.js`) and the completer resolves it (spike C6).
   * Both keep the `GEMINI.md` role loaded.
   */
  contextResetLine(cmd: ContextResetCommand, instructions?: string): string | null {
    return instructions ? `${cmd} ${instructions}` : cmd;
  }

  /** `mcp_team-comms_<tool>` — see `geminiMcpToolName` for the transcript. */
  mcpToolName(logicalName: string): string {
    return geminiMcpToolName(logicalName);
  }

  /** SSH transport: the host's own gemini install is used as-is. */
  initRuntime(_opts: RuntimeInitOptions): RuntimeInitOutcome {
    return { initialized: false, copied: false, skipReason: 'not-applicable' };
  }

  refreshSharedFiles(_opts: RuntimeInitOptions): void {
    /* nothing shared container-side */
  }

  // -------------------------------------------------------------------------
  // Availability probe
  // -------------------------------------------------------------------------

  /**
   * Does `GEMINI_CLI_HOME` still re-route the config tree, where the agents
   * actually run?
   *
   * This is deliberately MORE than "is the binary there", and it is the
   * mitigation for plan Risk 4: a gemini that stopped honouring the variable
   * would put every session on one config dir — one MCP url — and each agent
   * would authenticate as whichever session wrote last.
   *
   * TWO invocations in ONE throwaway home, and they answer two different
   * questions:
   *
   *   1. `gemini --version` — is the binary there, and what is it? Its exit code
   *      is trustworthy (it touches no auth) and its output is the version the
   *      UI shows next to the provider.
   *   2. `gemini mcp list` — does gemini READ the config tree we pointed it at?
   *      The throwaway `settings.json` declares one MCP server whose name
   *      (`GEMINI_PROBE_MCP_NAME`) exists nowhere else; finding that name in the
   *      listing proves gemini read OUR file, in OUR home. `trustedFolders.json`
   *      is seeded (keyed on the probe's own cwd) because an untrusted folder
   *      suppresses the servers; when the trust seed does not take, gemini still
   *      says "MCP servers are configured but disabled…", which is kept as a
   *      weaker fallback.
   *
   * WHY A READ AND NOT A WRITE. The previous version of this probe counted what
   * gemini WROTE into the throwaway home after `--version` (`history/`, `tmp/`).
   * That test silently died with gemini 0.52.0: `--version` no longer writes
   * anything, so the count was 0 on a perfectly healthy CLI and the adapter
   * reported "gemini no longer honours GEMINI_CLI_HOME" — a false statement that
   * pinned the provider to unavailable and sent the operator hunting a
   * regression that did not exist (measured on 0.52.0, 2026-07-26: reroute=0 on
   * three runs). The read is both the property we actually depend on (the
   * adapter needs gemini to READ the session's `settings.json`, not to write
   * anywhere) and the one that does not depend on a version's housekeeping
   * habits.
   *
   * THE EXIT CODE OF `mcp list` IS IGNORED, on purpose. Measured on this host:
   * it tracks the AUTH CONFIGURATION of the home it runs in (no
   * `security.auth.selectedType` → 41 on 0.35.2), not the CLI's presence. That
   * is what made the first spike abandon `mcp list`. Only its OUTPUT is read
   * here, so an unauthenticated host still yields a correct verdict —
   * `claude.ts` likewise refuses to conflate "no CLI" with "logged out".
   *
   * Traps handled here:
   *   1. `mcp list` prints on STDERR when stdout is not a TTY (measured), so
   *      both streams are merged before they are searched.
   *   2. gemini writes into its config dir on almost any invocation, so the
   *      probe MUST isolate `GEMINI_CLI_HOME` — it has polluted the operator's
   *      `~/.gemini` once already. The throwaway home also carries the
   *      auto-update flags OFF: they default to true and would let a probe that
   *      runs once a minute `npm install -g` the operator's CLI.
   *   3. gemini's cold-start `projects.json` rename race prints an ENOENT stack,
   *      which would become the `reason` an operator reads. Seeding the registry
   *      (as a session dir does) keeps the output clean.
   *   4. Under SSH we cannot read the host's throwaway dir at all, so the script
   *      brackets the `mcp list` output with markers and ships it back.
   *
   * Never throws.
   */
  async probe(ctx: ProviderProbeContext): Promise<ProviderAvailability> {
    const timeoutMs = Math.max(
      ctx.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS,
      GEMINI_PROBE_MIN_TIMEOUT_MS,
    );
    try {
      return ctx.transport === 'ssh'
        ? await this._probeSsh(ctx, timeoutMs)
        : this._probeLocal(timeoutMs);
    } catch (err) {
      return {
        available: false,
        reason: `gemini probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private _probeLocal(timeoutMs: number): ProviderAvailability {
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-os-gemini-probe-'));
      const { workDir } = this._seedProbeHome(dir);
      // ONE budget for the whole probe, split across the two boots: a caller
      // that grants 16 s gets a probe that costs 16 s, not 2×16 s.
      const deadline = Date.now() + timeoutMs;
      const step = (): number => Math.max(GEMINI_PROBE_MIN_STEP_MS, deadline - Date.now());
      // The disposable home is the whole point: without it this very probe
      // would write into the container's (or the operator's) real ~/.gemini.
      const env = { ...process.env, GEMINI_CLI_HOME: dir };

      const ver = this._spawnSync(this.binary, ['--version'], {
        env,
        cwd: workDir,
        encoding: 'utf8',
        timeout: step(),
        windowsHide: true,
      });
      if (ver.error) {
        const code = (ver.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            available: false,
            reason: `\`${this.binary}\` is not on PATH in this container`,
          };
        }
        return { available: false, reason: `${this.binary}: ${ver.error.message}` };
      }
      if (ver.signal) {
        return {
          available: false,
          reason: `\`${this.binary} --version\` timed out after ${timeoutMs} ms (killed by ${ver.signal})`,
        };
      }
      const versionOut = `${ver.stdout ?? ''}\n${ver.stderr ?? ''}`;
      if (ver.status !== 0) {
        return this._interpretProbe({ code: ver.status, versionOut, readOut: null });
      }

      const read = this._spawnSync(this.binary, ['mcp', 'list'], {
        env,
        cwd: workDir,
        encoding: 'utf8',
        timeout: step(),
        windowsHide: true,
      });
      // `mcp list` writes its listing to STDERR outside a TTY: merge, always.
      // Its EXIT CODE is never consulted — it reports auth, not presence.
      const readOut = read.signal ? null : `${read.stdout ?? ''}\n${read.stderr ?? ''}`;
      return this._interpretProbe({ code: ver.status, versionOut, readOut });
    } finally {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Fill a throwaway home so gemini has something OF OURS to read back, and
   * hand back the cwd to run it from.
   *
   * The layout mirrors a real session dir (`<home>/.gemini/…`) plus a `work/`
   * subdirectory used as the cwd: `trustedFolders.json` is keyed on the REALPATH
   * of that directory, and a probe that ran from the server's own cwd would seed
   * a trust entry for the wrong folder.
   */
  private _seedProbeHome(home: string): { cfgDir: string; workDir: string } {
    const cfgDir = path.join(home, GEMINI_CONFIG_SUBDIR);
    const workDir = path.join(home, 'work');
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const realWork = fs.realpathSync(workDir);
    // Same seed a session gets — see EMPTY_PROJECT_REGISTRY.
    fs.writeFileSync(
      path.join(cfgDir, PROJECT_REGISTRY_FILE),
      JSON.stringify(EMPTY_PROJECT_REGISTRY),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(cfgDir, SETTINGS_FILE), JSON.stringify(GEMINI_PROBE_SETTINGS), {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(cfgDir, TRUSTED_FOLDERS_FILE),
      JSON.stringify({ [realWork]: GEMINI_TRUST_LEVEL }),
      { mode: 0o600 },
    );
    return { cfgDir, workDir: realWork };
  }

  private async _probeSsh(
    ctx: ProviderProbeContext,
    timeoutMs: number,
  ): Promise<ProviderAvailability> {
    if (ctx.config.agentTransport !== 'ssh' || !ctx.config.sshTarget) {
      return {
        available: false,
        reason: 'ssh transport requested but SWARM_OS_SSH_TARGET is not configured',
      };
    }
    const res = await this._hostExec(ctx.config, {
      argv: ['bash', '-c', buildGeminiProbeScript(this.binary)],
      timeoutMs,
    });
    if (res.timedOut) {
      return {
        available: false,
        reason: `\`${this.binary}\` probe timed out after ${timeoutMs} ms on ${ctx.config.sshTarget}`,
      };
    }
    if (res.code === PROBE_EXIT_STAGING) {
      return {
        available: false,
        reason: `could not stage a throwaway GEMINI_CLI_HOME on ${ctx.config.sshTarget} (probe exit ${res.code})`,
      };
    }
    // One merged stream comes back; the markers say which invocation each part
    // belongs to. A missing END marker means the script stopped early, so the
    // read proof is UNPROVEN — never "fine".
    const begin = res.stdout.indexOf(GEMINI_PROBE_READ_BEGIN);
    const end = res.stdout.indexOf(GEMINI_PROBE_READ_END);
    const complete = begin >= 0 && end > begin;
    const versionOut = begin >= 0 ? res.stdout.slice(0, begin) : res.stdout;
    return this._interpretProbe({
      code: res.code,
      versionOut: `${versionOut}\n${res.stderr}`,
      readOut: complete ? res.stdout.slice(begin + GEMINI_PROBE_READ_BEGIN.length, end) : null,
      where: ctx.config.sshTarget,
    });
  }

  /**
   * The verdict. Shared by both transports so the two paths cannot drift into
   * different definitions of "available".
   *
   * `code` is the exit code of `--version` ONLY (see `probe`); `readOut` is the
   * merged output of `gemini mcp list`, or `null` when that invocation never
   * produced one.
   */
  private _interpretProbe(res: {
    code: number | null;
    versionOut: string;
    readOut: string | null;
    where?: string;
  }): ProviderAvailability {
    const at = res.where ? ` on ${res.where}` : '';
    if (res.code !== 0) {
      const detail = firstLine(res.versionOut) ?? `exit ${res.code}`;
      if (res.code === 127) {
        return {
          available: false,
          reason: `\`${this.binary}\` is not on PATH${at}: ${detail}`,
        };
      }
      return {
        available: false,
        reason: `\`${this.binary} --version\` failed${at} (exit ${res.code}): ${detail}`,
      };
    }
    const verdict = readProofVerdict(res.readOut);
    if (verdict !== 'rerouted') {
      // The binary is there and healthy, but we could not see OUR config come
      // back out of it. Refusing is the whole point — see the method doc and
      // plan Risk 4 — and the two cases get different words because they send
      // the operator to different places.
      const detail = res.readOut === null ? null : firstLine(res.readOut);
      const suffix =
        'Refusing to run sessions that would all share one ~/.gemini (one MCP url, one identity).';
      if (verdict === 'ignored') {
        return {
          available: false,
          reason:
            `\`${this.binary}\` did not read the settings.json in the throwaway ` +
            `GEMINI_CLI_HOME${at}: \`${this.binary} mcp list\` reported no configured server ` +
            `where the probe had declared '${GEMINI_PROBE_MCP_NAME}'. ${suffix}`,
        };
      }
      return {
        available: false,
        reason:
          `could not verify that \`${this.binary}\` honours GEMINI_CLI_HOME${at}: ` +
          `\`${this.binary} mcp list\` in a throwaway home never mentioned ` +
          `'${GEMINI_PROBE_MCP_NAME}' ${detail === null ? '(no output captured)' : `(got: ${detail})`}. ${suffix}`,
      };
    }
    const version = firstLine(res.versionOut);
    return version ? { available: true, version } : { available: true };
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  /** Parse a `settings.json`, or `null` when it is missing / unreadable / not an object. */
  private _readSettings(file: string): GeminiSettings | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as GeminiSettings;
    } catch {
      return null;
    }
  }

  /**
   * Write a JSON file 0600, replacing whatever was there — including a SYMLINK,
   * which `writeFileSync` would otherwise follow into the shared `~/.gemini`
   * (this dir holds credential links right next to the session files). The
   * enforcement lives in `session-config.writeSessionFile`; this is the JSON
   * shape of it.
   */
  private _writeJson(file: string, body: unknown): void {
    writeSessionJson(file, body);
  }
}

/**
 * Read `gemini mcp list` output and decide whether gemini read OUR config.
 *
 *   - `rerouted` — the probe's own server name came back (strong: that string
 *     exists nowhere but in the file we just wrote), or gemini said it found
 *     servers but suppressed them for an untrusted folder (weak fallback, kept
 *     for the case where the trust seed does not take — on 0.52.0 the names are
 *     listed even then).
 *   - `ignored`  — gemini positively reported NO configured server: it read a
 *     config tree that is not ours.
 *   - `unknown`  — nothing recognisable (or nothing at all).
 *
 * Note that the strong branch does not depend on any English phrase: a future
 * gemini may reword its headers freely, as long as `mcp list` still names the
 * servers it found. That is deliberate — the probe this replaced went
 * permanently false-negative on exactly such a behaviour change.
 */
export function readProofVerdict(out: string | null): 'rerouted' | 'ignored' | 'unknown' {
  if (out === null) return 'unknown';
  if (out.includes(GEMINI_PROBE_MCP_NAME)) return 'rerouted';
  if (MCP_UNTRUSTED_RE.test(out)) return 'rerouted';
  if (NO_MCP_RE.test(out)) return 'ignored';
  return 'unknown';
}

/**
 * The host-side probe script, run through `hostExec` (`bash -lc` → login PATH).
 *
 * Everything happens in a throwaway `mktemp -d` home that is removed whatever
 * happens, and gemini is run from a `work/` subdirectory of it — the same
 * directory `trustedFolders.json` is keyed on, so the trust seed applies to the
 * folder gemini actually opens.
 *
 * The script exits with the code of `--version` (the presence question) and
 * brackets the `mcp list` output with two markers (the read question). Both
 * commands merge stderr into stdout: `mcp list` prints its listing on STDERR
 * when stdout is not a TTY, and a "command not found" from the login shell also
 * lands on stderr. A run that dies before `read-end` leaves the read UNPROVEN,
 * which the container reads as "not available".
 *
 * The embedded JSON is single-quote-free by construction, so it survives the
 * single-quoted shell arguments. Exported for the test that freezes it — this
 * quoting is executed by the host shell, not by Node.
 */
export function buildGeminiProbeScript(binary: string): string {
  const cfg = `"$d/${GEMINI_CONFIG_SUBDIR}"`;
  const bail = `{ rm -rf "$d"; exit ${PROBE_EXIT_STAGING}; }`;
  return [
    `t=$(mktemp -d /tmp/swarm-os-gemini-probe.XXXXXX) || exit ${PROBE_EXIT_STAGING}`,
    // Resolve the temp path so the trust key matches the realpath gemini uses.
    `d=$(cd "$t" && pwd -P) || { rm -rf "$t"; exit ${PROBE_EXIT_STAGING}; }`,
    `mkdir -p ${cfg} "$d/work" || ${bail}`,
    `printf '%s' '${JSON.stringify(EMPTY_PROJECT_REGISTRY)}' > ${cfg}/${PROJECT_REGISTRY_FILE} || ${bail}`,
    `printf '%s' '${JSON.stringify(GEMINI_PROBE_SETTINGS)}' > ${cfg}/${SETTINGS_FILE} || ${bail}`,
    `printf '{"%s":"${GEMINI_TRUST_LEVEL}"}' "$d/work" > ${cfg}/${TRUSTED_FOLDERS_FILE} || ${bail}`,
    `cd "$d/work" || ${bail}`,
    `GEMINI_CLI_HOME="$d" ${binary} --version 2>&1`,
    'rc=$?',
    `echo "${GEMINI_PROBE_READ_BEGIN}"`,
    `GEMINI_CLI_HOME="$d" ${binary} mcp list 2>&1`,
    `echo "${GEMINI_PROBE_READ_END}"`,
    'cd /',
    'rm -rf "$d"',
    'exit $rc',
  ].join('\n');
}

/** First non-empty line, trimmed and clipped — same shape as `probe.ts`. */
function firstLine(out: string): string | undefined {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 200) : undefined;
}
