/**
 * OpenAI Codex adapter (multi-provider plan, Lot 4).
 *
 * Every rule below is backed by `scripts/verify-codex.report.md` — the spike S1
 * report against `codex-cli 0.130.0` on this deployment host (8/8 checks
 * CONFIRMED, including the two blocking ones: MCP over streamable HTTP, and PTY
 * silence at idle). Read it before changing anything here, because almost every
 * mistake in this file is SILENT: it does not throw, it wedges the PTY on a
 * modal nobody can see, or it produces an agent with tools and no team.
 *
 *   - isolation:  `CODEX_HOME=<per-session dir>` (C1). Anchored under the
 *                 container's `/data` bind mount, NEVER under `/tmp`: below a
 *                 temp dir the CLI refuses to create its helper binaries
 *                 (`Refusing to create helper binaries under temporary dir`).
 *                 Being under `/data` is also what gives it a host-side
 *                 equivalent reachable through `paths.data()` under SSH.
 *   - argv:       `--no-alt-screen -C <cwd> -m <model>
 *                  -c model_reasoning_effort=<mapped>
 *                  --dangerously-bypass-approvals-and-sandbox [prompt]` (C1/C2).
 *                 `--dangerously-bypass-approvals-and-sandbox` is MANDATORY,
 *                 not a preference: without it the identical MCP mount answers
 *                 `user cancelled MCP tool call` (C2).
 *   - MCP:        `[mcp_servers.team-comms] url = …` merged into
 *                 `<sd>/config.toml` (C2). The per-session secret rides in the
 *                 URL path and arrives untouched; no bearer token is needed
 *                 because that path *is* the credential (`mcp/server.ts`
 *                 resolves `(orch_id, session_secret)` and 404s otherwise).
 *   - preamble:   `<sd>/AGENTS.md` (C3a/C3b) — injected as a dedicated user
 *                 message and re-injected after `/compact`, `/new` AND
 *                 `/clear`. `model_instructions_file` REPLACES the base Codex
 *                 instructions (the agent loses its tool protocol, its prompt
 *                 shrinks by ~2.6k tokens) and is BANNED; its ancestor
 *                 `experimental_instructions_file` is deprecated and ignored.
 *   - trust:      `[projects."<workspace-mapped cwd>"] trust_level = "trusted"`
 *                 (C4). Without it the TUI blocks on "Do you trust the contents
 *                 of this directory?" and emits nothing further.
 *   - waiting:    `notify = ["<sd>/notify.sh"]` (C5). Codex has NO `Notification`
 *                 hook event, and config-declared `[hooks]` never run
 *                 unattended — they wait for an interactive review and make the
 *                 TUI print "⚠ N hooks need review". `notify` is the only usable
 *                 signal, and its JSON payload arrives as **argv[1] with an
 *                 EMPTY stdin** — the exact opposite of Claude Code hooks.
 *   - PTY:        `inkSubmitDance: true` (C6). The ratatui composer absorbs a
 *                 `\r` that arrives in the same chunk exactly like Ink does, so
 *                 `Session`'s two-step cadence (text, then a lone CR at +150 ms)
 *                 is reused verbatim, delay included.
 *   - idle:       0.0 B/s at idle with and without `--no-alt-screen` (C7). We
 *                 keep `--no-alt-screen` anyway so the session log stays linear
 *                 and greppable instead of a stream of full-frame repaints.
 *
 * One thing NOT to worry about: every context reset re-initialises all MCP
 * servers (three `initialize` cycles observed in C2). Nothing to do here — the
 * swarm-os MCP server is stateless per request by construction
 * (`mcp/server.ts`), so it simply answers the new handshake.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import {
  buildNotificationHookCommand,
  linkSharedState,
  writeSessionFile,
  SESSION_EXEC_MODE,
} from './session-config.js';
import type { ModelCatalogue } from './catalogue.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';
import { probeCliBinary } from './probe.js';
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

// Structured events keep the `session` module binding and the `session.*`
// prefix on purpose: an operator debugging an agent greps one module, not one
// per provider.
const log = withModule('session');

/**
 * Entries of the host's `~/.codex` that a per-session `CODEX_HOME` shares by
 * symlink — `auth.json` above all, without which the agent boots straight into
 * a login prompt.
 *
 * The SQLite files (`logs_2.sqlite`, `state_5.sqlite`, plus their `-wal` /
 * `-shm` sidecars) are DELIBERATELY absent: N concurrent sessions writing one
 * database through N symlinks, with WAL sidecar placement depending on path
 * canonicalisation, is a corruption recipe. They are born and die with the
 * session instead (`cleanupPaths`).
 */
export const CODEX_SHARED_ENTRIES: readonly string[] = [
  'auth.json',
  'installation_id',
  'models_cache.json',
  'memories',
  'rules',
  'skills',
  'plugins',
];

/**
 * Our `EffortLevel` → codex's `model_reasoning_effort`. The binary accepts
 * `none|minimal|low|medium|high|xhigh` (verified: an invalid value makes it exit
 * with `unknown variant ..., expected one of ...`); our extra `max` folds onto
 * `xhigh`.
 */
export const CODEX_EFFORT_MAP: Record<EffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

const CODEX_CAPABILITIES: ProviderCapabilities = {
  // No CLI flag for it: `-c model_reasoning_effort=<mapped>` (see buildSpawn).
  effort: true,
  // Codex has no permission-mode vocabulary: it is sandbox flags. We run it
  // with `--dangerously-bypass-approvals-and-sandbox`, which is the closest
  // thing to claude's `bypassPermissions`; every other mode is coerced to it.
  // `-a/--ask-for-approval` does not even exist on `codex exec`.
  permissionModes: ['bypassPermissions'],
  fallbackPermissionMode: 'bypassPermissions',
  // `notify = ["<sd>/notify.sh"]` in config.toml — fires once per completed
  // turn with `{"type":"agent-turn-complete",…}` (C5). The binary is explicit
  // that this is the ONLY payload type ("legacy notify payload is only
  // supported for after_agent"), so the signal is a TURN BOUNDARY, not "a human
  // is needed": a codex lead that runs twenty turns fires twenty times.
  //
  // `'turn-complete'` is what keeps that from becoming twenty Discord alerts
  // and twenty armed compactions — `http/routes/hooks.ts` treats it as an
  // inactivity boundary only (no `waiting` badge, no notification).
  notificationHook: 'turn-complete',
  // C6: `"text\r"` in a single write does NOT submit — the CR is absorbed as a
  // newline inside the ratatui composer, exactly like Claude Code's Ink TUI.
  inkSubmitDance: true,
  // `<CODEX_HOME>/AGENTS.md` survives `/compact`, `/new` and `/clear` (C3b).
  durablePreamble: true,
  // `[mcp_servers.team-comms] url=` over streamable HTTP (C2 — the BLOCKING
  // check: no MCP means no team-comms means not a swarm member).
  httpMcp: true,
};

/**
 * Pinned floor, read off the host's `~/.codex/models_cache.json` (client
 * 0.130.0). The UI keeps a free-text escape hatch, and the server deliberately
 * never validates a model string — ids ship faster than we do.
 *
 * At RUNTIME the same file is re-read through `providers/catalogue.ts`, so a
 * `codex` that learns a new model on a 24/7 host surfaces it at the next poll.
 * This array is the answer when that read fails — and, unlike the other three
 * adapters, there is no models.dev fallback behind it: models.dev is an API
 * catalogue and `codex exec` on a ChatGPT account accepts strictly less (probed
 * 2026-07-28: `-m gpt-5.6` → HTTP 400 "not supported when using Codex with a
 * ChatGPT account"). See `deriveCodexCatalogue` for the full measurement.
 */
const CODEX_MODELS: readonly ProviderModel[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5 (gpt-5.5)' },
  { value: 'gpt-5.4', label: 'GPT-5.4 (gpt-5.4)' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini (gpt-5.4-mini)' },
];

/** Name of the per-session config root. Sibling of claude's, never inside it. */
const CODEX_RUNTIME_DIRNAME = '.codex-runtime';

/** File codex reads its whole configuration from, inside `CODEX_HOME`. */
const CONFIG_TOML = 'config.toml';

/** Durable role instructions. The one preamble channel that survives a reset. */
const AGENTS_MD = 'AGENTS.md';

/** `notify` program: receives the JSON payload as argv[1]. */
const NOTIFY_SH = 'notify.sh';

/**
 * Everything from this line to the end of `config.toml` is owned by phase B.1
 * (`writeMcpConfig`) and is dropped again by `removeMcpConfig`. Keeping the MCP
 * block behind a marker makes the merge idempotent — a second spawn cannot
 * stack a second `[mcp_servers.team-comms]` table (which TOML rejects outright)
 * — and lets the session secret be scrubbed from disk at exit even if the
 * `rm -rf` of the whole directory fails.
 */
const MCP_SECTION_MARKER =
  '# ---- swarm-os: team-comms MCP (written at spawn, removed at exit) ----';

/** Startup budget for the MCP handshake, per the spike's config contract. */
const MCP_STARTUP_TIMEOUT_SEC = 30;

/** TOML table name of the team-comms server — `[mcp_servers.<this>]` (C2). */
export const CODEX_MCP_SERVER_NAME = 'team-comms';

/**
 * The namespace codex declares our tools under, as the MODEL sees it.
 *
 * Not used to build a tool name (see `codexMcpToolName`) — the model supplies
 * the namespace itself, we never ask it to type this. It is recorded because it
 * is the string an operator will find in a transcript and because it documents
 * WHY the tool names lose their dots: codex ships MCP tools as an OpenAI
 * `{"type":"namespace"}` tool group, and every leaf of that group has to be a
 * plain function name.
 *
 * Derivation, observed byte for byte (see `codexMcpToolName`): `mcp__`, the
 * server name with every character outside `[A-Za-z0-9_]` turned into `_`
 * (`team-comms` → `team_comms`), then a trailing `__`.
 */
export const CODEX_MCP_TOOL_NAMESPACE = `mcp__${CODEX_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_',
)}__`;

/**
 * How codex renames a team-comms tool for the model: **the dots become
 * underscores, and nothing else changes** — `team.whoami` → `team_whoami`.
 *
 * MEASURED on codex-cli 0.130.0 (not inferred from the S1 spike, whose probe
 * tool was `swarm_probe_ping` and therefore had no dot to mangle). Method: a
 * real streamable-HTTP MCP server exposing `team.whoami`, and a fake
 * OpenAI-compatible endpoint (`model_providers.<p>.base_url`) recording what
 * codex sends. The request contained, verbatim:
 *
 *   { "type": "namespace", "name": "mcp__team_comms__",
 *     "tools": [ { "type": "function", "name": "team_whoami", … } ] }
 *
 * and a hand-written reply of `{"type":"function_call","name":"team_whoami",
 * "namespace":"mcp__team_comms__"}` made codex issue `tools/call team.whoami`
 * against the MCP server — i.e. `team_whoami` IS the callable name, and the
 * namespace travels in its own field. The fully-qualified spellings
 * (`mcp__team_comms__team_whoami`, `mcp__team-comms__team_whoami`, and the
 * dotted variants) were each rejected by codex with `unsupported call: …`, so
 * they are the wrong thing to put in a preamble.
 *
 * Consequence, and the reason this function is not `x => x`: telling a codex
 * agent to call `team.whoami` names a tool that does not exist in its schema.
 */
export function codexMcpToolName(logicalName: string): string {
  return logicalName.replace(/\./g, '_');
}

/**
 * Quote a value as a TOML basic string.
 *
 * Used for the two places a path becomes part of the *syntax* rather than
 * carrying data: the `[projects."<cwd>"]` table key and the `notify` program
 * path. A stray `"` or `\` in a path would otherwise produce a config.toml that
 * fails to parse — and codex exits 1 with `failed to load configuration`, which
 * looks nothing like "your workspace has an odd name".
 */
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * The `notify` program written into every per-session `CODEX_HOME`.
 *
 * Codex hands the notification JSON to this script as a **single argv** and
 * leaves **stdin empty** — the mirror image of Claude Code / gemini hooks,
 * which stream it on stdin (C5). Rather than duplicate the POST pipeline (whose
 * quoting is production-critical and was paid for in incidents), we reuse
 * `buildNotificationHookCommand()` VERBATIM and simply feed it the argv on
 * stdin. One source of truth, one codex-specific line.
 */
export function buildCodexNotifyScript(opts: {
  orchestratorId: string;
  sessionId: string;
  hookToken: string;
  mainHttpPort: number;
  hookUrl?: string | undefined;
}): string {
  const post = buildNotificationHookCommand(opts);
  return [
    '#!/bin/sh',
    '# swarm-os per-session codex `notify` program — generated, do not edit.',
    '#',
    '# codex invokes:  notify.sh \'{"type":"agent-turn-complete",…}\'',
    '# i.e. the payload is argv[1] and stdin is EMPTY (spike S1 check 5). The',
    '# shared POST pipeline below reads the payload from stdin (that is how',
    '# Claude Code and gemini deliver it), so we pipe argv[1] into it unchanged.',
    '#',
    '# The only payload type codex emits is `agent-turn-complete` — "the turn',
    '# ended, the agent is now waiting" — which is exactly the edge',
    '# /hooks/notification records as `kind: session.waiting`.',
    'printf \'%s\' "${1-}" | {',
    post,
    '}',
    '',
  ].join('\n');
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly label = 'OpenAI Codex';
  readonly binary = 'codex';
  readonly capabilities = CODEX_CAPABILITIES;

  /**
   * Host-side `~/.codex` (`config.hostCodexDir`), the `targetRoot` of the
   * per-session symlink farm. NOT `SessionConfigRequest.hostSharedDir` — that
   * one carries claude's root, and pointing codex at it would produce an agent
   * that starts, logs nothing, and is not authenticated.
   *
   * `null` when the registry was built without a Config (unit tests).
   */
  protected readonly hostDir: string | null;

  /** Live catalogue, or `null` for "pins only". See `useCatalogue`. */
  private _catalogue: ModelCatalogue | null = null;

  constructor(config?: Config) {
    this.hostDir = config?.hostCodexDir ?? null;
  }

  /** Late-bound live catalogue — see `ClaudeProvider.useCatalogue`. */
  useCatalogue(catalogue: ModelCatalogue | null): void {
    this._catalogue = catalogue;
  }

  models(): readonly ProviderModel[] {
    return this._catalogue?.models('codex', CODEX_MODELS) ?? CODEX_MODELS;
  }

  defaults(): { model: string; effort: EffortLevel; permissionMode: PermissionMode } {
    return {
      model:
        this._catalogue?.defaultModel('codex', BUILTIN_PROVIDER_DEFAULT_MODELS.codex) ??
        BUILTIN_PROVIDER_DEFAULT_MODELS.codex,
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
    };
  }

  /**
   * PHASE A — build the per-session `CODEX_HOME`:
   *
   *   `<dataDir>/.codex-runtime/sessions/<sessionId>/`
   *     ├── auth.json → <host ~/.codex>/auth.json   (+ the rest of the list)
   *     ├── AGENTS.md                               the durable role preamble
   *     ├── notify.sh                               0700, argv[1] → hook POST
   *     └── config.toml                             notify + trust (+ MCP later)
   *
   * A sibling of claude's runtime root rather than a child: the whole directory
   * is `rm -rf`'d when the session ends (codex keeps per-session SQLite in
   * there), and pointing that at anything inside claude's tree would be one
   * id-handling bug away from deleting a claude session's state.
   *
   * Never throws (the interface forbids it): on failure it returns a null
   * config dir, `buildSpawn` then refuses loudly, and `Session` turns that into
   * a failed session with the reason in its log — instead of a codex that boots
   * with the operator's real `~/.codex`, no trust entry and no team-comms.
   */
  prepareSessionConfig(req: SessionConfigRequest): SessionConfigResult {
    if (!req.runtimeRoot) {
      log.warn({
        event: 'session.codex_config_skipped',
        sessionId: req.sessionId,
        reason: 'no runtime root configured',
      });
      return { configDir: null, cleanupPaths: [] };
    }
    let cfgDir: string | null = null;
    try {
      cfgDir = path.join(
        path.dirname(req.runtimeRoot),
        CODEX_RUNTIME_DIRNAME,
        'sessions',
        req.sessionId,
      );
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(cfgDir, 0o700);
      } catch {
        /* best-effort: filesystem may not honour chmod */
      }
      this._linkSharedState(req, cfgDir);
      this._writePreamble(req, cfgDir);
      const notifyPath = this._writeNotifyScript(req, cfgDir);
      this._writeBaseConfig(req, cfgDir, notifyPath);
      return { configDir: cfgDir, cleanupPaths: [cfgDir] };
    } catch (err) {
      log.warn({
        event: 'session.codex_config_failed',
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Still hand back the directory for deletion if we got as far as creating
      // it — a half-written CODEX_HOME is useless and must not accumulate.
      return { configDir: null, cleanupPaths: cfgDir ? [cfgDir] : [] };
    }
  }

  /**
   * Symlink the shared `~/.codex` entries into the per-session `CODEX_HOME`.
   *
   * `this.hostDir` is the right target in BOTH transports: under SSH it is the
   * host's real `~/.codex` (a path only the agent can resolve, hence
   * `existsCheck: false`), and in local transport it resolves from the
   * container's own `os.homedir()`, i.e. the namespace the agent shares with us
   * — so there we can stat and skip what is missing.
   */
  private _linkSharedState(req: SessionConfigRequest, cfgDir: string): void {
    if (!this.hostDir) {
      log.warn({
        event: 'session.codex_shared_link_skipped',
        sessionId: req.sessionId,
        reason: 'no host codex dir configured (SWARM_OS_HOST_CODEX_DIR)',
      });
      return;
    }
    const isSsh = req.transport === 'ssh';
    linkSharedState({
      targetRoot: this.hostDir,
      configDir: cfgDir,
      entries: CODEX_SHARED_ENTRIES,
      existsCheck: !isSsh,
      onError: (info) => {
        log.warn({
          event: isSsh
            ? 'session.codex_shared_link_ssh_failed'
            : 'session.codex_shared_link_failed',
          sessionId: req.sessionId,
          entry: info.entry,
          target: info.target,
          error: info.error,
        });
      },
    });
  }

  /**
   * `<CODEX_HOME>/AGENTS.md` — the ONLY preamble channel that survives a
   * context reset (C3a/C3b). Codex injects it as a user message headed
   * `# AGENTS.md instructions for <cwd>` and re-injects it after `/compact`,
   * `/new` and `/clear`, which is what lets an agent reset its context without
   * forgetting its role.
   */
  private _writePreamble(req: SessionConfigRequest, cfgDir: string): void {
    if (!req.preamble) return;
    const dest = path.join(cfgDir, AGENTS_MD);
    const body = req.preamble.endsWith('\n') ? req.preamble : `${req.preamble}\n`;
    writeSessionFile(dest, body);
  }

  /**
   * `<CODEX_HOME>/notify.sh`, mode 0700 — codex execs it directly, so it needs
   * the exec bit and a shebang.
   *
   * Returns the CONTAINER path (the caller maps it for the config file), or
   * null when the hook is not wired: `hookToken` / `mainHttpPort` are optional
   * in `SessionInit`, and a session without them simply never reports
   * `waiting`. That is a visible degradation, not a reason to fail the spawn —
   * the trust seed and the MCP block still matter.
   */
  private _writeNotifyScript(req: SessionConfigRequest, cfgDir: string): string | null {
    if (!req.hookToken || !req.mainHttpPort) {
      log.warn({
        event: 'session.codex_notify_skipped',
        sessionId: req.sessionId,
        reason: 'no hook token / main http port — session will never report waiting',
      });
      return null;
    }
    const dest = path.join(cfgDir, NOTIFY_SH);
    // 0700, NOT the 0600 default: codex execs this file itself.
    writeSessionFile(
      dest,
      buildCodexNotifyScript({
        orchestratorId: req.orchestratorId,
        sessionId: req.sessionId,
        hookToken: req.hookToken,
        mainHttpPort: req.mainHttpPort,
        hookUrl: req.hookUrl,
      }),
      SESSION_EXEC_MODE,
    );
    return dest;
  }

  /**
   * `<CODEX_HOME>/config.toml`, phase A half: the `notify` program and the
   * pre-accepted trust entry. The MCP table is appended in phase B.1, behind
   * `MCP_SECTION_MARKER`.
   *
   * ⚠️ TWO PATH ROOTS, AND THEY ARE NOT INTERCHANGEABLE (see `AgentPathMapper`):
   *   - `paths.data()`      for the notify program — a file WE wrote, under the
   *                         dataDir bind mount.
   *   - `paths.workspace()` for the `[projects."…"]` key — the cwd the AGENT
   *                         resolves, under the workspace bind mount.
   * Swapping them throws nothing: `toHostPath` passes a non-matching prefix
   * through unchanged, so the trust key stops matching the cwd codex actually
   * opens, the modal from C4 comes back, and the session merely looks "busy".
   */
  private _writeBaseConfig(
    req: SessionConfigRequest,
    cfgDir: string,
    notifyPath: string | null,
  ): void {
    const projectKey = req.paths.workspace(req.cwd);
    const lines: string[] = [
      `# swarm-os — per-session codex config (CODEX_HOME=${cfgDir}).`,
      '#',
      '# Generated at session start and deleted with the session: codex keeps',
      '# per-session SQLite state in CODEX_HOME, and sharing it between sessions',
      '# would corrupt it. Only the entries in CODEX_SHARED_ENTRIES are',
      "# symlinked back to the operator's real ~/.codex.",
      '#',
      '# Deliberately absent:',
      '#   [hooks]                 — codex has no `Notification` event, and',
      '#                             config-declared hooks never run unattended',
      '#                             (they wait for an interactive review and',
      '#                             make the TUI print a warning banner).',
      '#   model / model_reasoning_effort',
      '#                           — they travel on the argv (`-m`, and',
      '#                             `-c model_reasoning_effort=…`): phase A is',
      '#                             not given either of them.',
      '#   model_instructions_file — it REPLACES the base Codex instructions, so',
      '#                             the agent loses its tool protocol. The role',
      '#                             preamble lives in AGENTS.md instead.',
      '',
    ];
    if (notifyPath) {
      lines.push(
        '# Fires once per completed turn with the JSON payload as argv[1].',
        `notify = [${tomlBasicString(req.paths.data(notifyPath))}]`,
        '',
      );
    }
    lines.push(
      "# Pre-accept the trust dialog for the agent's cwd. Without this entry the",
      '# TUI blocks on "Do you trust the contents of this directory?" and emits',
      '# nothing further — the PTY looks busy forever. The key must be the exact',
      '# absolute path passed to `-C`, as the AGENT resolves it.',
      `[projects.${tomlBasicString(projectKey)}]`,
      'trust_level = "trusted"',
      '',
      MCP_SECTION_MARKER,
      '',
    );
    const dest = path.join(cfgDir, CONFIG_TOML);
    writeSessionFile(dest, lines.join('\n'));
  }

  /**
   * PHASE B.1 — merge `[mcp_servers.team-comms]` into the per-session
   * `config.toml`. Codex has no `--mcp-config` equivalent: the config file IS
   * the MCP wiring, which is why this returns the `config.toml` path rather
   * than a standalone artifact.
   *
   * The URL carries the per-session secret in its path — proven to arrive
   * untouched (C2) — and that path is the credential, so no bearer token is
   * configured (`bearer_token_env_var` also works, but there is nothing to put
   * in it: `mcp/server.ts` authenticates on `(orch_id, session_secret)` alone).
   */
  writeMcpConfig(req: McpWriteRequest): McpWriteResult | null {
    if (!req.configDir) return null;
    const configPath = path.join(req.configDir, CONFIG_TOML);
    const url = `http://${req.mcpHost}:${req.mcpPort}/mcp/${req.orchestratorId}/${req.sessionSecret}`;
    const block = [
      `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
      `url = ${tomlBasicString(url)}`,
      `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
      '',
    ].join('\n');
    // Deliberately NOT caught: `Session._spawn` wraps this call, logs
    // `session.mcp_config_write_failed` and continues with no MCP — the same
    // downgrade claude gets on a read-only runtime dir.
    this._rewriteMcpSection(configPath, block);
    return { path: configPath, url };
  }

  /**
   * Drop the MCP table again, which scrubs the session secret from disk. Runs
   * before `Session` deletes the whole directory (`cleanupPaths`), so it is
   * defence in depth: if the `rm -rf` fails, no live URL is left behind.
   *
   * Must never throw — `Session._cleanupMcpConfig` calls it unguarded on the
   * exit path, and a throw there would keep the session from reaching a
   * terminal state.
   */
  removeMcpConfig(req: McpCleanupRequest): void {
    if (!req.configDir) return;
    try {
      this._rewriteMcpSection(path.join(req.configDir, CONFIG_TOML), null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      log.warn({
        event: 'session.codex_mcp_cleanup_failed',
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replace everything after `MCP_SECTION_MARKER` with `block` (or nothing).
   *
   * Truncate-then-append rather than plain append: TOML rejects a duplicate
   * `[mcp_servers.team-comms]` table outright (`failed to load configuration`),
   * so a second write must replace the first instead of stacking onto it.
   */
  private _rewriteMcpSection(configPath: string, block: string | null): void {
    const raw = fs.readFileSync(configPath, 'utf8');
    const idx = raw.indexOf(MCP_SECTION_MARKER);
    const head =
      idx >= 0 ? raw.slice(0, idx) : raw.length === 0 || raw.endsWith('\n') ? raw : `${raw}\n`;
    const tail = block ? `${MCP_SECTION_MARKER}\n${block}` : `${MCP_SECTION_MARKER}\n`;
    // Phase A already replaced any link at this path with a regular file, but
    // this write carries the session MCP url and runs on its own (`Session`
    // calls `removeMcpConfig` on a failed spawn), so it enforces the invariant
    // itself rather than inheriting it.
    writeSessionFile(configPath, head + tail);
  }

  /**
   * PHASE B.2 — pure: argv + env, no I/O.
   *
   * Flag order follows the spike's contract. Two entries deserve a note:
   *
   *  - `-c model_reasoning_effort=<mapped>` is how effort is expressed at all:
   *    codex has no `--effort` flag, and phase A cannot write the key into
   *    `config.toml` because `SessionConfigRequest` carries no effort. `-c`
   *    parses its value as TOML and falls back to the raw string, so the bare
   *    form is enough (verified: `-c model_reasoning_effort=bogus` exits with
   *    `unknown variant ..., expected one of none, minimal, low, medium, high,
   *    xhigh`).
   *  - the positional prompt. The spike report advises against it so swarm-os
   *    can watch the boot before the first turn starts — but `Session` has no
   *    other channel for the seed task (`initialPrompt` is read here and
   *    nowhere else), so dropping it would mean an agent that boots with no
   *    work at all. Same trade-off claude has made in production since day one.
   *
   * `TERM` is not set on purpose: both `PtyAgentProcess` and `SshAgentProcess`
   * already open their PTY as `xterm-256color`, so the value the spike's
   * environment section asks for is already what ratatui sees.
   */
  buildSpawn(req: SpawnRequest): PreparedSpawn {
    if (!req.configDir) {
      // Refusing beats launching: with no CODEX_HOME the agent falls back to
      // the operator's real `~/.codex` — no trust entry (PTY wedges on the
      // modal), no team-comms (not a swarm member), and its SQLite state would
      // be written into the shared home.
      throw new Error(
        'codex requires a per-session CODEX_HOME and none was prepared (check SWARM_OS_CLAUDE_RUNTIME_DIR / disk permissions)',
      );
    }
    const args: string[] = [
      // Inline TUI: the session log stays linear instead of full-frame repaints.
      '--no-alt-screen',
      // Working root. The SAME absolute path must be the `[projects."…"]` key.
      '-C',
      req.paths.workspace(req.cwd),
      '-m',
      req.model,
      '-c',
      `model_reasoning_effort=${CODEX_EFFORT_MAP[req.effort] ?? CODEX_EFFORT_MAP.xhigh}`,
      // MANDATORY: without it MCP tool calls come back `user cancelled MCP
      // tool call`. This is codex's equivalent of claude's
      // `--permission-mode bypassPermissions`, and it is why
      // `capabilities.permissionModes` has exactly one entry.
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    // The positional argv is the seed task, optionally prefixed by the one-shot
    // resume notice. The durable half of the instructions is NOT here — it is
    // in `AGENTS.md`, which is what survives a `/compact` or a `/new`.
    const positional =
      req.resumeNotice && req.initialPrompt
        ? `${req.resumeNotice}\n\n${req.initialPrompt}`
        : (req.resumeNotice ?? req.initialPrompt ?? null);
    // `--` FIRST — see the same guard in `claude.ts`. clap rejects a positional
    // that starts with a dash, and `buildResumeNotice` starts with `---`:
    //   error: unexpected argument '---…' found
    //   tip: to pass '---…' as a value, use '-- ---…'
    // (codex's own advice). Measured against codex-cli 0.130.0 on 2026-07-26.
    if (positional) args.push('--', positional);
    return {
      command: this.binary,
      args,
      // `paths.data`, not `paths.workspace`: this directory is one WE wrote,
      // under the dataDir bind mount.
      env: { CODEX_HOME: req.paths.data(req.configDir) },
    };
  }

  /**
   * Context-reset tokens, per the spike's mapping (C6/C3b):
   *   `/compact` → `/compact`  same thread, conversation summarized in place
   *   `/clear`   → `/new`      new thread, conversation dropped, scrollback kept
   *
   * `/new` rather than codex's own `/clear`, which additionally blanks the
   * terminal and would wipe the operator's view of the session log.
   *
   * `instructions` is dropped on purpose. The spike proved the BARE tokens
   * submit and take effect; `/compact <reason>` was never exercised, and codex
   * does validate slash commands ("Unrecognized command"). If it rejected the
   * decorated line the compaction would silently not happen and the context
   * would keep growing — a much worse outcome than losing a steering hint.
   * Verifying `/compact <text>` in a follow-up spike is what would let this
   * become `${cmd} ${instructions}`. The parameter stays in the signature so
   * the drop is visible at the call site instead of looking like an oversight.
   */
  contextResetLine(cmd: ContextResetCommand, _instructions?: string): string | null {
    return cmd === '/clear' ? '/new' : '/compact';
  }

  /** Dots become underscores — see `codexMcpToolName` for the transcript. */
  mcpToolName(logicalName: string): string {
    return codexMcpToolName(logicalName);
  }

  /**
   * No container-side runtime state: under SSH the host's own codex CLI is used
   * as-is, and in local transport it resolves its shared entries through the
   * per-session symlinks.
   */
  initRuntime(_opts: RuntimeInitOptions): RuntimeInitOutcome {
    return { initialized: false, copied: false, skipReason: 'not-applicable' };
  }

  refreshSharedFiles(_opts: RuntimeInitOptions): void {
    /* nothing shared container-side */
  }

  /**
   * `codex --version` where the agent would actually run: in-container under
   * the local transport, on the host through the login shell under SSH.
   *
   * Deliberately NOT an auth check, exactly like claude's: a codex that is
   * installed but logged out is still "available", and the fix for that is a
   * `codex login` on the host, not a different provider.
   */
  probe(ctx: ProviderProbeContext): Promise<ProviderAvailability> {
    return probeCliBinary({ ...ctx, binary: this.binary });
  }
}
