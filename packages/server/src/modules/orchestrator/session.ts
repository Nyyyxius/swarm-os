import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type AgentProcess,
  type AgentExitInfo,
  type Disposable,
  PtyAgentProcess,
  SshAgentProcess,
} from './agent-process.js';
import { writeSessionMcpConfig, removeSessionMcpConfig } from './mcp-config.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { EffortLevel, PermissionMode } from '../../config.js';
import { refreshClaudeSharedFiles } from '../../runtime/claude-init.js';
import { toHostPath as toHostPathHelper } from './path-translate.js';

/**
 * SSH transport bundle passed to a Session. When set, the session opens
 * `ssh -tt <sshTarget>` and runs the host's claude binary instead of the
 * container's. See `SshAgentProcess` for the runtime semantics.
 *
 * `hostDataDir` is needed for two things: (1) translating
 * `<claudeRuntimeDir>/sessions/<id>/` (a container path) into a host path for
 * `CLAUDE_CONFIG_DIR`; (2) same for the per-session `--mcp-config=<path>`.
 * `hostClaudeDir` is where the per-session symlinks point (the host's real
 * `~/.claude/.credentials.json`, etc.).
 */
export interface SessionSshTransport {
  sshTarget: string;
  sshKey: string;
  sshPort: number;
  /** Container's `dataDir` (e.g. `/data`) — used for the path-translate. */
  dataDir: string;
  /** Host-side path matching `dataDir`. */
  hostDataDir: string;
  /** Host-side `~/.claude` path the symlinks point at. */
  hostClaudeDir: string;
  /** Container's `workspaceRoot` (e.g. `/workspace`). */
  workspaceRoot: string;
  /** Host-side path matching `workspaceRoot`. */
  hostWorkspaceRoot: string;
}

const log = withModule('session');

const LOG_CAP_BYTES = 50 * 1024 * 1024; // 50 MB per plan §15
const RING_BUFFER_LINES = 200;

export type SessionType = 'lead' | 'worker';
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'exited'
  | 'killed'
  | 'interrupted'
  | 'failed';

export interface SessionInit {
  /**
   * Pre-minted session id. Optional — if absent, the constructor mints a
   * fresh UUID v4. The Orchestrator pre-mints to be able to bake the id
   * into the preamble before constructing the Session.
   */
  id?: string;
  /**
   * Phase 8 — auto-resume only. When provided, reuse this ISO timestamp
   * for `startedAt` so the historical session age survives the restart.
   * Without it, a respawn would write `now()` and overwrite the original
   * value in the next UPSERT.
   */
  startedAt?: string;
  orchestratorId: string;
  name: string;
  role: string;
  type: SessionType;
  cwd: string;
  initialPrompt: string | null;
  preamble: string | null;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  logsDir: string; // <dataDir>/logs
  /** Per-session mcp.json runtime root (e.g. `/tmp/swarm-os`). */
  mcpRuntimeDir: string;
  /** MCP HTTP host (must be loopback — enforced by McpServer.listen). */
  mcpHost: string;
  mcpPort: number;
  claudeBin?: string;
  /** Skip the actual claude CLI spawn — useful for smoke testing without claude. */
  skipSpawn?: boolean;
  /** Inject a preconstructed AgentProcess (tests). */
  agentProcessOverride?: AgentProcess;
  /**
   * Phase 4: callback fired on every status / activity / exit transition.
   * The `force` flag tells the persistence layer to bypass throttling for
   * status / exit transitions. The Orchestrator wires this into its
   * `Persistence.writeSession`.
   */
  onStateChange?: (session: Session, force: boolean) => void;
  /**
   * Phase 4: hook token + main HTTP port. When both are set, `Session`
   * writes a per-session `settings.json` under
   * `<claudeRuntimeDir>/sessions/<id>/` and exports `CLAUDE_CONFIG_DIR` to
   * the PTY env.
   */
  hookToken?: string;
  mainHttpPort?: number;
  /**
   * Phase 5: writable runtime root for per-container Claude state. The
   * per-session `CLAUDE_CONFIG_DIR` is `<claudeRuntimeDir>/sessions/<id>`,
   * with the standard Claude state subtree (`projects`, `history.jsonl`,
   * `.credentials.json`, etc.) symlinked from `<claudeRuntimeDir>` so all
   * sessions share the same auth + history without duplicating large
   * directories on every spawn. Tradeoff: per-session writes to those
   * shared paths land back in the runtime root (intended — that's how
   * Claude updates its history). Phase 4 named this field
   * `claudeConfigRoot` and pointed it at the dataDir; Phase 5 keeps the
   * name for back-compat but the value MUST be the resolved
   * `claudeRuntimeDir`.
   */
  claudeConfigRoot?: string;
  /**
   * RO source mount path (host `~/.claude` exposed in the container — e.g.
   * `/claude-source`). When present alongside `claudeConfigRoot`, the
   * Session refreshes `.credentials.json` + `.claude.json` from source into
   * the runtime root right before symlinking them per-session, so a host
   * OAuth refresh that happened after container boot still propagates.
   * Omit (or pass an unmounted path) to skip the refresh.
   */
  claudeSourceDir?: string;
  /** Optional explicit override for the `.claude.json` source path. */
  claudeJsonSource?: string | null;
  /**
   * SSH transport bundle. When provided, the session spawns `claude` on the
   * remote host via `ssh -tt` instead of locally via `node-pty`. Required
   * paths inside the session (CLAUDE_CONFIG_DIR, --mcp-config, symlink
   * targets) are translated to host paths via this bundle. When omitted,
   * the session uses the local `PtyAgentProcess` (default).
   */
  sshTransport?: SessionSshTransport | null;
}

export interface SessionView {
  id: string;
  orchestratorId: string;
  name: string;
  role: string;
  type: SessionType;
  cwd: string;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  status: SessionStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  stopReason: string | null;
  logPath: string;
  lastActivityAt: string;
  // sessionSecret intentionally NOT included
}

/**
 * Build the argv for `claude` per Phase 0 bis report.
 *
 * Phase 2 wires `--mcp-config=<absolute path to mcp.json>` so each session
 * sees the team-comms MCP. Order: `[--model, --effort, --permission-mode,
 * --mcp-config=<path>, prompt]`. The mcp.json is generated by `Session._spawn`
 * before the PTY launch (see `mcp-config.ts`).
 *
 * IMPORTANT — `--mcp-config` is **variadic** in claude 2.1.142 (`<configs...>`):
 * `--mcp-config <path> <prompt>` would slurp the prompt as a SECOND config
 * file, manifesting as `Error: Invalid MCP configuration: ENAMETOOLONG`.
 * We therefore use the `--mcp-config=<path>` form (single token, can't be
 * variadic-extended) so the prompt argv that follows stays an unrelated
 * positional. See spike H4 for the flag contract; the variadic gotcha was
 * surfaced by the Phase 5 container smoke test.
 */
export function buildClaudeArgs(opts: {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  initialPrompt: string | null;
  preamble: string | null;
  /** Absolute path to the per-session mcp.json. Optional in test paths. */
  mcpConfigPath?: string | null;
}): string[] {
  const args: string[] = [
    '--model',
    opts.model,
    '--effort',
    opts.effort,
    '--permission-mode',
    opts.permissionMode,
  ];
  if (opts.mcpConfigPath) {
    // `=` form is mandatory: `--mcp-config <path>` would consume the
    // following prompt argv as a second config file (variadic flag).
    args.push(`--mcp-config=${opts.mcpConfigPath}`);
  }
  // Phase 1 carryover: prepend preamble to the initial prompt if provided.
  // Phase 2 still uses this for the lead's seed prompt; Phase 3 will switch
  // to per-session settings.json for the worker preamble proper.
  const prompt =
    opts.preamble && opts.initialPrompt
      ? `${opts.preamble}\n\n${opts.initialPrompt}`
      : (opts.initialPrompt ?? opts.preamble ?? null);
  if (prompt) {
    args.push(prompt);
  }
  return args;
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly sessionSecret: string;
  readonly orchestratorId: string;
  readonly name: string;
  readonly role: string;
  readonly type: SessionType;
  readonly cwd: string;
  readonly initialPrompt: string | null;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly permissionMode: PermissionMode;
  readonly logPath: string;
  readonly startedAt: string;

  private _status: SessionStatus = 'starting';
  private _pid: number | null = null;
  private _endedAt: string | null = null;
  private _exitCode: number | null = null;
  private _lastError: string | null = null;
  private _stopReason: string | null = null;
  private _lastActivityAt: string;
  private _idleSince: number; // epoch ms — used by mailbox idle detection (Phase 3)

  private readonly mcpRuntimeDir: string;
  private mcpConfigPath: string | null = null;
  private readonly sshTransport: SessionSshTransport | null;

  private agent: AgentProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private logBytes = 0;
  private readonly ringBuffer: string[] = [];
  private partialLine = '';
  private _stopRequested = false;
  /**
   * S5 — last non-paused status captured immediately before SIGSTOP so we can
   * restore it on resume (avoids a `paused → running → waiting` flicker when
   * the Notification hook re-fires after SIGCONT).
   */
  private _statusBeforePause: SessionStatus | null = null;
  /** S5 — guard against concurrent restart calls. Set by Orchestrator.restartSession. */
  private _restarting = false;
  private _hideAfterExit = false;
  private _killTimer: NodeJS.Timeout | null = null;
  private _agentDataDisp: Disposable | null = null;
  private _agentExitDisp: Disposable | null = null;

  /** Phase 4 — set during construction, fired on every state mutation. */
  private readonly _onStateChange: ((session: Session, force: boolean) => void) | null;
  /** Phase 4 — initial prompt is needed by persistence (not normally exposed). */
  readonly initialPromptRaw: string | null;

  constructor(init: SessionInit) {
    super();
    this.id = init.id ?? crypto.randomUUID();
    this.sessionSecret = crypto.randomUUID();
    this.orchestratorId = init.orchestratorId;
    this.name = init.name;
    this.role = init.role;
    this.type = init.type;
    this.cwd = init.cwd;
    this.initialPrompt = init.initialPrompt;
    this.initialPromptRaw = init.initialPrompt;
    this.model = init.model;
    this.effort = init.effort;
    this.permissionMode = init.permissionMode;
    // Phase 8: reuse the persisted ISO timestamp on auto-resume; mint a
    // fresh one on first spawn. Without this, the next UPSERT would
    // overwrite the original startedAt with the boot time.
    this.startedAt = init.startedAt ?? new Date().toISOString();
    this._lastActivityAt = this.startedAt;
    this._idleSince = Date.now();
    this.mcpRuntimeDir = init.mcpRuntimeDir;
    this.sshTransport = init.sshTransport ?? null;
    this._onStateChange = init.onStateChange ?? null;

    const orchLogDir = path.join(init.logsDir, this.orchestratorId);
    fs.mkdirSync(orchLogDir, { recursive: true });
    this.logPath = path.join(orchLogDir, `${this.id}.log`);

    // Phase 4: write per-session settings.json injecting the Notification hook.
    // The CLAUDE_CONFIG_DIR is exported when the PTY is spawned.
    this._claudeConfigDir = this._maybeWriteSessionSettings(init);

    this._openLog();
    this._spawn(init);
  }

  /**
   * Phase 4: per-session `CLAUDE_CONFIG_DIR` (`<dataDir>/.claude-runtime/sessions/<id>/`)
   * with a `settings.json` injecting the `Notification` hook (plan §13, spike H6).
   *
   * The hook payload arrives on stdin per Anthropic's Claude Code spec
   * (`{ session_id, transcript_path, cwd, hook_event_name, message }` — see
   * spike report §5). We read stdin via `cat` then re-encode it in JSON to
   * a single-line POST body that includes our orch_id / session_id (the ones
   * Claude doesn't know about — Anthropic's session_id is its own internal id).
   *
   * Returns the path of the config dir (or null if not configured).
   */
  private _maybeWriteSessionSettings(init: SessionInit): string | null {
    if (!init.hookToken || !init.mainHttpPort || !init.claudeConfigRoot) return null;
    try {
      // Phase 5: claudeConfigRoot is the resolved <claudeRuntimeDir>
      // (typically `<dataDir>/.claude-runtime`). The per-session config dir
      // is a sibling under `sessions/`. We mirror Phase 4's path layout
      // exactly (sessions live under the runtime root).
      const cfgDir = path.join(init.claudeConfigRoot, 'sessions', this.id);
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(cfgDir, 0o700);
      } catch {
        /* best-effort */
      }
      // Refresh the host-volatile files (`.credentials.json` + `.claude.json`)
      // from the RO source mount before symlinking. The boot-time copy is
      // gated by the dir-mtime marker, which doesn't notice in-place edits
      // of these files (host claude rotates OAuth tokens in-place). Without
      // this, every team created after a host token rotation would inherit
      // a stale runtime `.credentials.json` and the PTY would land on the
      // interactive `/login` prompt.
      //
      // SSH transport: the container never reads or copies host credentials —
      // the host claude resolves its own `~/.claude/.credentials.json`
      // directly via the per-session symlink. Skip the refresh entirely.
      if (init.claudeSourceDir && !this.sshTransport) {
        try {
          const refresh = refreshClaudeSharedFiles({
            sourceDir: init.claudeSourceDir,
            runtimeDir: init.claudeConfigRoot,
            claudeJsonSource: init.claudeJsonSource ?? null,
          });
          if (refresh.credentials === 'lifted' || refresh.claudeJson === 'lifted') {
            log.info({
              event: 'session.shared_refresh',
              sessionId: this.id,
              credentials: refresh.credentials,
              claudeJson: refresh.claudeJson,
            });
          }
        } catch (err) {
          log.warn({
            event: 'session.shared_refresh_failed',
            sessionId: this.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Phase 5: symlink shared Claude state into the per-session dir so the
      // per-session CLAUDE_CONFIG_DIR sees the credentials, history, etc.
      // from the runtime copy. We pick the union of subdirectories Claude
      // is known to look at (spike H7 inventory). Best-effort: if the
      // shared dir doesn't have a given subentry, we skip the symlink.
      this._linkSharedClaudeState(init.claudeConfigRoot, cfgDir);
      // Pre-accept the trust + project-onboarding dialogs for this cwd so
      // the PTY doesn't wedge on first spawn. Must run AFTER the symlink
      // pass (which is now scoped to skip `.claude.json`) and BEFORE any
      // settings.json write so the dialog state is in place before the
      // claude CLI reads it.
      //
      // SSH mode: the container-side `<runtimeDir>/.claude.json` is never
      // populated (claude-init is a no-op). Read the host's `.claude.json`
      // directly through the RO source mount (`init.claudeJsonSource`,
      // typically `/claude-source.json`, or `<sourceDir>.json` as fallback)
      // so onboarding / userID / theme survive.
      const sshJsonFallback =
        init.claudeSourceDir && init.claudeSourceDir.length > 0
          ? `${init.claudeSourceDir}.json`
          : null;
      const claudeJsonSrc = this.sshTransport
        ? init.claudeJsonSource ?? sshJsonFallback
        : path.join(init.claudeConfigRoot, '.claude.json');
      this._seedClaudeJsonTrust(cfgDir, claudeJsonSrc);
      // Build the hook command. Claude streams the JSON event on stdin per
      // the spike H6 confirmation. We pipe stdin into jq if present; if not,
      // we fall back to a minimal awk-based pass-through. Practically:
      // re-emit the raw stdin verbatim and wrap our context around it. To
      // keep the command simple we send only our orch_id/session_id +
      // `message` as a separate field — Claude's stdin event is opaque on
      // the wire (we don't try to parse it inside the shell).
      //
      // The shell runs `cat` to capture stdin (Claude's hook payload), then
      // POSTs a minimal JSON envelope. Curl is mandatory — claude-code
      // images include it (verified in the Phase 0 bis spike).
      const hookUrl = `http://127.0.0.1:${init.mainHttpPort}/hooks/notification`;
      // shell command — heredoc-style, single-quoted to avoid Node-side
      // escape soup. The actual claude payload travels in the message
      // field (we send the raw stdin string verbatim, JSON-escaped via
      // python3 if available, else sed).
      const shellCmd =
        `payload=$(cat); ` +
        `msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || ` +
        `msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')"); ` +
        `body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"session.waiting","message":%s}' '${this.orchestratorId}' '${this.id}' "$msg"); ` +
        `curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${init.hookToken}' -d "$body" '${hookUrl}' >/dev/null 2>&1 || true`;
      // Pre-accept the "bypass permissions mode" disclaimer at the
      // user-settings level. claude-code 2.1.143 migrates the legacy
      // `.claude.json#bypassPermissionsModeAccepted` flag into
      // `userSettings.skipDangerousModePermissionPrompt` on first launch
      // and then deletes the source field — the runtime check that opens
      // the interactive disclaimer widget reads ONLY the user/local/flag/
      // policy settings (`qu()` in the bundled CLI). Setting it directly
      // here makes the pre-acceptance survive the migration and keeps
      // the per-session `.claude.json` seed effective as a fallback for
      // older builds.
      const settings = {
        skipDangerousModePermissionPrompt: true,
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: shellCmd,
                },
              ],
            },
          ],
        },
      };
      const settingsPath = path.join(cfgDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(settingsPath, 0o600);
      } catch {
        /* best-effort */
      }
      return cfgDir;
    } catch (err) {
      log.warn({
        event: 'session.settings_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private _claudeConfigDir: string | null = null;
  /** Phase 4: public read-only accessor — used by tests / dev tooling. */
  get claudeConfigDir(): string | null {
    return this._claudeConfigDir;
  }

  /**
   * Phase 5: symlink the union of Claude-known state subentries from the
   * shared runtime root into the per-session config dir. This lets
   * `CLAUDE_CONFIG_DIR=<sessions/<id>>` see the credentials + history while
   * keeping `settings.json` per-session (so each session can carry its own
   * Notification hook context).
   *
   * The list comes from the spike report H7 inventory — we don't try to be
   * exhaustive (Claude may add new files at runtime); anything missing is
   * just not symlinked. Per-session writes that would land on a brand-new
   * shared file (e.g. a new top-level entry created by Claude post-link)
   * land directly in the session dir — no shared corruption.
   */
  private _linkSharedClaudeState(runtimeDir: string, cfgDir: string): void {
    // SSH transport: symlink targets must be HOST paths so the remote claude
    // resolves them in its own namespace. We cannot stat the target from the
    // container side (the host `~/.claude/` is not mounted RW in SSH mode);
    // create the links best-effort and let claude silently skip missing
    // entries on the host.
    if (this.sshTransport) {
      this._linkSharedClaudeStateSsh(cfgDir);
      return;
    }
    // Spike H7 inventory: ~/.claude has these RW children. We deliberately
    // include `settings.json` even though we override it below — if the
    // user's host settings are present, they'll be referenced via this
    // link until our writeFileSync replaces it with our own per-session
    // settings.json (the writeFileSync below removes the symlink first).
    const SHARED_ENTRIES = [
      '.credentials.json',
      // Phase 6 NOTE — `.claude.json` was previously symlinked here so the
      // session inherited `hasCompletedOnboarding` + theme + userID from the
      // lifted host copy. It is now owned per-session by
      // `_seedClaudeJsonTrust` (which reads the runtime copy, merges in
      // `projects[<cwd>].hasTrustDialogAccepted`, and writes a real file).
      // Leaving the symlink in place would let our writeFileSync follow it
      // and clobber the shared runtime copy.
      '.last-cleanup',
      'backups',
      'cache',
      'debug',
      'file-history',
      'history.jsonl',
      'mcp-needs-auth-cache.json',
      'paste-cache',
      'plans',
      'plugins',
      'projects',
      'session-env',
      'sessions',
      'shell-snapshots',
      'tasks',
      'telemetry',
      'todos',
    ];
    for (const name of SHARED_ENTRIES) {
      // Don't symlink `sessions/<id>` over our own session dir — that's where
      // we ARE. The runtime `sessions/` dir is Claude-specific (per-claude
      // session state); our per-orchestrator session dir lives in the same
      // namespace which is unfortunate but the `id` collision risk is nil
      // (UUID v4). If the shared `sessions/` exists at the runtime root, we
      // skip linking the whole thing and rely on Claude creating its own
      // entries directly in the per-session dir.
      if (name === 'sessions') continue;
      const srcPath = path.join(runtimeDir, name);
      const linkPath = path.join(cfgDir, name);
      try {
        // Skip if the source doesn't exist (typical of dev mode where
        // claude-init was a no-op).
        fs.lstatSync(srcPath);
      } catch {
        continue;
      }
      try {
        // Best-effort: if a stale link exists, remove it. fs.symlinkSync
        // doesn't have a `force` option.
        try {
          fs.unlinkSync(linkPath);
        } catch {
          /* didn't exist — fine */
        }
        fs.symlinkSync(srcPath, linkPath);
      } catch (err) {
        log.warn({
          event: 'session.shared_link_failed',
          sessionId: this.id,
          entry: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * SSH-mode variant of `_linkSharedClaudeState`. Symlink targets point at the
   * host's real `~/.claude/<entry>` paths. No existence check is possible from
   * the container side (host `~/.claude` isn't mounted RW in SSH mode), so we
   * write the symlinks unconditionally — the remote claude resolves them in
   * its own namespace and ignores missing entries.
   */
  private _linkSharedClaudeStateSsh(cfgDir: string): void {
    if (!this.sshTransport) return;
    const hostClaudeDir = this.sshTransport.hostClaudeDir;
    const SHARED_ENTRIES = [
      '.credentials.json',
      '.last-cleanup',
      'backups',
      'cache',
      'debug',
      'file-history',
      'history.jsonl',
      'mcp-needs-auth-cache.json',
      'paste-cache',
      'plans',
      'plugins',
      'projects',
      'session-env',
      'shell-snapshots',
      'tasks',
      'telemetry',
      'todos',
    ];
    for (const name of SHARED_ENTRIES) {
      const target = path.join(hostClaudeDir, name);
      const linkPath = path.join(cfgDir, name);
      try {
        try {
          fs.unlinkSync(linkPath);
        } catch {
          /* didn't exist — fine */
        }
        fs.symlinkSync(target, linkPath);
      } catch (err) {
        log.warn({
          event: 'session.shared_link_ssh_failed',
          sessionId: this.id,
          entry: name,
          target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Pre-accept the trust dialog and project-onboarding prompts for this
   * session's `cwd` by writing a per-session `.claude.json` under
   * `<cfgDir>/.claude.json`. Without this, the claude CLI opens the
   * interactive "Do you trust the files in this folder?" widget on first
   * spawn into a never-before-seen cwd and wedges the PTY.
   *
   * Strategy: read the lifted runtime `.claude.json` so we preserve
   * `hasCompletedOnboarding`, `userID`, theme, etc., merge in
   * `projects[<this.cwd>]` with the trust flags set, then write the result
   * as a REGULAR file (not a symlink) into the per-session config dir.
   * If the runtime file is missing or unreadable we fall back to a
   * minimal seed sufficient to silence the prompt.
   *
   * Why a per-session file (not a one-shot edit of the runtime copy):
   *   - We don't want claude's mid-session writes (lastSessionId, lastCost,
   *     etc.) leaking across sessions through the shared file.
   *   - Avoids racing with concurrent spawns also mutating the same path.
   */
  private _seedClaudeJsonTrust(cfgDir: string, claudeJsonSrc: string | null): void {
    const dest = path.join(cfgDir, '.claude.json');
    // Projects in `~/.claude.json` are keyed by absolute path. In SSH mode the
    // remote claude resolves the cwd as a host path; the trust entry must use
    // the same key or claude re-opens the trust dialog.
    const projectKey = this.sshTransport
      ? toHostPathHelper({
          containerPath: this.cwd,
          dataDir: this.sshTransport.workspaceRoot,
          hostDataDir: this.sshTransport.hostWorkspaceRoot,
        })
      : this.cwd;

    let base: Record<string, unknown>;
    try {
      if (!claudeJsonSrc) throw new Error('no .claude.json source path');
      const raw = fs.readFileSync(claudeJsonSrc, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      base =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { hasCompletedOnboarding: true };
    } catch {
      // Missing or unreadable lifted file (dev mode without claude-init,
      // or a partial container). The minimal seed below is enough — claude
      // will create the rest of its state on its own.
      base = { hasCompletedOnboarding: true };
    }

    // Pre-accept the global "bypass permissions mode disclaimer" so the
    // CLI doesn't open an interactive disclaimer widget on first spawn
    // under `--permission-mode bypassPermissions`. The field is a top-level
    // boolean in `.claude.json` checked by the CLI before launching in
    // bypass mode (verified against claude-code 2.1.143 — the binary
    // references `E$().bypassPermissionsModeAccepted` from its arg parser).
    // We set it unconditionally: the flag means "the user has seen the
    // disclaimer once"; it's a no-op for other modes.
    base.bypassPermissionsModeAccepted = true;

    const projectsRaw = base.projects;
    const projects: Record<string, Record<string, unknown>> =
      projectsRaw && typeof projectsRaw === 'object' && !Array.isArray(projectsRaw)
        ? (projectsRaw as Record<string, Record<string, unknown>>)
        : {};
    const existing = projects[projectKey];
    const cwdEntry: Record<string, unknown> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...existing }
        : {};
    cwdEntry.hasTrustDialogAccepted = true;
    cwdEntry.hasCompletedProjectOnboarding = true;
    cwdEntry.hasClaudeMdExternalIncludesApproved = true;
    if (existing == null) {
      // Brand-new project entry — populate the empty containers claude
      // expects so it doesn't re-run any per-project initialisation.
      cwdEntry.allowedTools = [];
      cwdEntry.mcpContextUris = [];
      cwdEntry.mcpServers = {};
      cwdEntry.enabledMcpjsonServers = [];
      cwdEntry.disabledMcpjsonServers = [];
    }
    projects[projectKey] = cwdEntry;
    base.projects = projects;

    // Remove any pre-existing entry at `dest` (typically nothing now that
    // `.claude.json` is excluded from SHARED_ENTRIES, but be defensive in
    // case a stale symlink from a previous server version is around — a
    // writeFileSync onto a symlink would follow it and corrupt the shared
    // runtime file).
    try {
      fs.unlinkSync(dest);
    } catch {
      /* nothing to remove */
    }
    try {
      fs.writeFileSync(dest, JSON.stringify(base, null, 2), { mode: 0o600 });
      fs.chmodSync(dest, 0o600);
    } catch (err) {
      log.warn({
        event: 'session.claude_json_seed_failed',
        sessionId: this.id,
        cwd: this.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Public API --------------------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }

  get pid(): number | null {
    return this._pid;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get stopReason(): string | null {
    return this._stopReason;
  }

  get endedAt(): string | null {
    return this._endedAt;
  }

  get lastActivityAt(): string {
    return this._lastActivityAt;
  }

  /** Epoch ms — Phase 3 mailbox idle detection. */
  get idleSince(): number {
    return this._idleSince;
  }

  /** Returns the last N lines from the in-memory ring buffer (Phase 3 crash dump helper). */
  getRecentLines(n = 20): string[] {
    return this.ringBuffer.slice(-Math.max(0, n));
  }

  toView(): SessionView {
    return {
      id: this.id,
      orchestratorId: this.orchestratorId,
      name: this.name,
      role: this.role,
      type: this.type,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      status: this._status,
      pid: this._pid,
      startedAt: this.startedAt,
      endedAt: this._endedAt,
      exitCode: this._exitCode,
      lastError: this._lastError,
      stopReason: this._stopReason,
      logPath: this.logPath,
      lastActivityAt: this._lastActivityAt,
    };
  }

  /** Push human input to the underlying PTY. */
  writeInput(data: string): void {
    if (!this.agent) return;
    this.agent.write(data);
  }

  /**
   * Inject a short, single-line signal into the PTY (Phase 3 mailbox).
   *
   * Wrapped in `\n…\n` so it always lands on its own line — claude can be
   * mid-write at any column. Best-effort: if the underlying agent has
   * exited or the write throws, we swallow and log; the mailbox push is
   * the source of truth, the signal is just a wake-up hint.
   *
   * Also written to the session log so a human attaching after the fact
   * can see why the agent suddenly checked its inbox.
   */
  notifySignal(text: string): void {
    if (!this.agent) {
      // skipSpawn / no-process sessions still get the signal in their log
      // for testability.
      this._appendLog(`\n${text}\n`);
      return;
    }
    const payload = `\n${text}\n`;
    try {
      this.agent.write(payload);
    } catch (err) {
      log.error({
        event: 'notifySignal.write_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Also append to the log so it shows up in replays / log dumps. We do
    // NOT bump lastActivityAt here: the signal is server-injected, not
    // agent-produced output, so it must not extend the busy window.
    this._appendLog(payload);
  }

  resize(cols: number, rows: number): void {
    this.agent?.resize(cols, rows);
  }

  /** Subscribe to PTY output. */
  onData(cb: (data: string) => void): Disposable {
    if (!this.agent) {
      return { dispose: () => undefined };
    }
    return this.agent.onData(cb);
  }

  /** Begin shutdown. SIGTERM, then SIGKILL after grace ms if still alive. */
  stop(reason: string, graceMs = 5000): void {
    // Phase 6 carry-over: also early-return on `interrupted`. That state is
    // set on boot recovery (DbPersistence.recoverFromCrash) — calling stop on
    // an already-interrupted session is a no-op (no PTY to signal anyway).
    if (
      this._status === 'exited' ||
      this._status === 'killed' ||
      this._status === 'failed' ||
      this._status === 'interrupted'
    ) {
      return;
    }
    this._stopReason ??= reason;
    // Mark the intent so _handleExit knows this was a user-requested stop,
    // not a crash/natural exit.
    this._stopRequested = true;
    if (!this.agent) {
      this._setStatus('killed');
      this._endedAt ??= new Date().toISOString();
      this._cleanupMcpConfig();
      return;
    }
    // S5 §7.5 — SIGTERM on a SIGSTOP'd process is queued as pending and only
    // delivered when the process is resumed. Without an explicit SIGCONT the
    // graceful shutdown is silently stuck for the full grace window and the
    // SIGKILL timer fires by default. Wake the process first so SIGTERM is
    // honored immediately.
    if (this._status === 'paused') {
      try {
        this.agent.kill('SIGCONT');
      } catch {
        /* ignore */
      }
      // Clear the captured pre-pause status so any downstream introspection
      // sees a coherent state (we're now en route to `killed`).
      this._statusBeforePause = null;
    }
    try {
      this.agent.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (this._killTimer) {
      // Already armed — caller asked twice. Keep the original timer.
      return;
    }
    const timer = setTimeout(() => {
      try {
        this.agent?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this._killTimer = null;
    }, graceMs);
    // Don't keep the event loop alive just for this timer.
    timer.unref();
    this._killTimer = timer;
  }

  /**
   * S5 — SIGSTOP the underlying PTY so the agent freezes mid-execution.
   *
   * Returns true if the SIGSTOP was actually requested + status flipped to
   * `paused`, false if the transition was illegal (already paused, terminal,
   * starting, a stop is in progress, or no agent attached).
   *
   * Important: we deliberately do NOT set `_stopRequested = true` here. The
   * pause is reversible; an exit after a future resume should still be
   * classified naturally (`exited` for code 0, `failed` otherwise) instead of
   * being demoted to `killed` by `_handleExit`.
   */
  pause(reason: string): boolean {
    if (this._status === 'paused') return false; // idempotent
    // Only running / waiting can be paused. `starting` would freeze the agent
    // mid-boot before identification — refuse. Terminal states are obviously
    // refused.
    if (this._status !== 'running' && this._status !== 'waiting') return false;
    if (!this.agent) return false; // skipSpawn / no real process
    if (this._stopRequested) return false; // a stop is in-flight — don't fight it
    this._statusBeforePause = this._status;
    try {
      this.agent.kill('SIGSTOP');
    } catch (err) {
      log.warn({
        event: 'session.pause_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this._statusBeforePause = null;
      return false;
    }
    this._setStatus('paused');
    this._appendLog(`[swarm-os] PAUSE (SIGSTOP) — ${reason}\n`);
    return true;
  }

  /**
   * S5 — SIGCONT the underlying PTY and restore the pre-pause status.
   *
   * Restoring `waiting` (when that's what we paused from) avoids a visible
   * `paused → running → waiting` flicker if the Notification hook is going
   * to re-fire shortly after the agent wakes up.
   */
  resume(reason: string): boolean {
    if (this._status !== 'paused') return false;
    if (!this.agent) return false;
    try {
      this.agent.kill('SIGCONT');
    } catch (err) {
      log.warn({
        event: 'session.resume_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    const restored = this._statusBeforePause ?? 'running';
    this._statusBeforePause = null;
    this._setStatus(restored);
    this._appendLog(`[swarm-os] RESUME (SIGCONT) — ${reason}\n`);
    return true;
  }

  /** S5 — read/set the per-session restart-in-progress guard. */
  get restarting(): boolean {
    return this._restarting;
  }
  setRestarting(v: boolean): void {
    this._restarting = v;
  }

  /**
   * Soft-delete-on-exit flag. Set by `Orchestrator.stopSession({ hideAfterExit })`
   * so the worker exit handler can drop the session from the map once it
   * reaches a terminal state, instead of leaving it visible (the default
   * REMOVE-after-stop two-click flow).
   */
  get hideAfterExit(): boolean {
    return this._hideAfterExit;
  }
  setHideAfterExit(v: boolean): void {
    this._hideAfterExit = v;
  }

  // --- Internals ---------------------------------------------------------

  private _spawn(init: SessionInit): void {
    // Generate the per-session mcp.json BEFORE spawning so claude sees a
    // valid file at startup. We do it in skipSpawn mode too — Phase 2's
    // MCP-direct test path needs the file on disk to read the URL even when
    // the CLI itself isn't launched.
    try {
      const result = writeSessionMcpConfig({
        runtimeDir: this.mcpRuntimeDir,
        orchestratorId: this.orchestratorId,
        sessionId: this.id,
        sessionSecret: this.sessionSecret,
        mcpHost: init.mcpHost,
        mcpPort: init.mcpPort,
      });
      this.mcpConfigPath = result.path;
    } catch (err) {
      // Non-fatal in Phase 2 if /tmp is read-only (very unlikely): we'd
      // rather still let the session run without MCP than crash the spawn.
      // Log and continue with mcpConfigPath=null.
      log.error({
        event: 'session.mcp_config_write_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.mcpConfigPath = null;
    }

    if (init.skipSpawn) {
      // Smoke / dev mode: write a marker, mark running, no real subprocess.
      this._appendLog(
        `[swarm-os] skipSpawn=true — no claude subprocess started (cwd=${this.cwd})\n`,
      );
      if (this.mcpConfigPath) {
        this._appendLog(`[swarm-os] mcp.json written at ${this.mcpConfigPath}\n`);
      }
      this._setStatus('running');
      return;
    }

    let agent: AgentProcess;
    try {
      if (init.agentProcessOverride) {
        agent = init.agentProcessOverride;
      } else if (this.sshTransport) {
        // SSH transport: spawn claude on the host VM. The container-side
        // CLAUDE_CONFIG_DIR + mcp.json + cwd all live under bind mounts; the
        // host sees them at different paths. Translate before handing off.
        const t = this.sshTransport;
        const hostCfgDir = this._claudeConfigDir
          ? toHostPathHelper({
              containerPath: this._claudeConfigDir,
              dataDir: t.dataDir,
              hostDataDir: t.hostDataDir,
            })
          : null;
        const hostMcp = this.mcpConfigPath
          ? toHostPathHelper({
              containerPath: this.mcpConfigPath,
              dataDir: t.dataDir,
              hostDataDir: t.hostDataDir,
            })
          : null;
        // cwd is validated against workspaceRoot at API ingress (so always
        // starts with `<workspaceRoot>/` or equals it). Translate to host.
        const hostCwd = toHostPathHelper({
          containerPath: this.cwd,
          dataDir: t.workspaceRoot,
          hostDataDir: t.hostWorkspaceRoot,
        });
        const args = buildClaudeArgs({
          model: this.model,
          effort: this.effort,
          permissionMode: this.permissionMode,
          initialPrompt: this.initialPrompt,
          preamble: init.preamble,
          mcpConfigPath: hostMcp,
        });
        const remoteEnv: Record<string, string> = {};
        if (hostCfgDir) remoteEnv.CLAUDE_CONFIG_DIR = hostCfgDir;
        agent = new SshAgentProcess({
          sshTarget: t.sshTarget,
          sshKey: t.sshKey,
          sshPort: t.sshPort,
          remoteCwd: hostCwd,
          remoteEnv,
          remoteCommand: init.claudeBin ?? 'claude',
          args,
          // The remote claude reads `--mcp-config=<url to http://127.0.0.1:mcpPort>`.
          // The container's MCP listens on loopback only (plan §14), so set
          // up an SSH reverse tunnel so the host's 127.0.0.1:mcpPort routes
          // back into the container's namespace. Skipped when mcp isn't
          // wired (mcpPort=0 / test paths).
          reverseTunnelPort: init.mcpPort > 0 ? init.mcpPort : 0,
        });
      } else {
        const args = buildClaudeArgs({
          model: this.model,
          effort: this.effort,
          permissionMode: this.permissionMode,
          initialPrompt: this.initialPrompt,
          preamble: init.preamble,
          mcpConfigPath: this.mcpConfigPath,
        });
        const env: NodeJS.ProcessEnv = {};
        if (this._claudeConfigDir) env.CLAUDE_CONFIG_DIR = this._claudeConfigDir;
        agent = new PtyAgentProcess({
          command: init.claudeBin ?? 'claude',
          args,
          cwd: this.cwd,
          env,
        });
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._setStatus('failed');
      this._endedAt = new Date().toISOString();
      this._appendLog(`[swarm-os] failed to spawn claude: ${this._lastError}\n`);
      this._cleanupMcpConfig();
      eventBus.emitEvent({
        kind: 'session.exited',
        orchestratorId: this.orchestratorId,
        sessionId: this.id,
        payload: { status: this._status, error: this._lastError },
      });
      return;
    }

    this.agent = agent;
    this._pid = agent.pid;
    this._setStatus('running');

    this._agentDataDisp = agent.onData((d) => {
      this._lastActivityAt = new Date().toISOString();
      this._idleSince = Date.now();
      this._appendLog(d);
      // Phase 4: throttled persistence write so the lastActivityAt freshens
      // ~1× per second without hammering SQLite on chatty PTY data.
      this._notifyState(false);
    });

    this._agentExitDisp = agent.onExit((info) => this._handleExit(info));
  }

  /** Phase 4: invoke the orchestrator's state-change callback (throttled). */
  private _notifyState(force: boolean): void {
    if (!this._onStateChange) return;
    try {
      this._onStateChange(this, force);
    } catch (err) {
      log.warn({
        event: 'session.state_callback_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _handleExit(info: AgentExitInfo): void {
    this._exitCode = info.exitCode;
    this._endedAt = new Date().toISOString();
    if (this._status === 'killed') {
      // already known
    } else if (this._stopRequested) {
      // Stop was user-initiated. Whatever exit code came back, classify as
      // 'killed' (clean shutdown by orchestrator request) so downstream
      // consumers don't confuse it with a crash.
      this._setStatus('killed');
    } else if (info.exitCode === 0) {
      this._setStatus('exited');
    } else {
      this._setStatus('failed');
      this._lastError ??= `exit code ${info.exitCode}${info.signal ? ` signal ${info.signal}` : ''}`;
    }
    this._appendLog(
      `[swarm-os] process exited code=${info.exitCode}${info.signal ? ` signal=${info.signal}` : ''}\n`,
    );
    this._closeLog();
    this._cleanupMcpConfig();
    // Clear the SIGKILL grace timer if it's still armed.
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    // Drop our PTY-side listener disposables (the underlying impl already
    // clears its callback sets on exit, but be explicit for the case where a
    // session is recycled or replaced in tests).
    this._agentDataDisp?.dispose();
    this._agentDataDisp = null;
    this._agentExitDisp?.dispose();
    this._agentExitDisp = null;
    eventBus.emitEvent({
      kind: 'session.exited',
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
      payload: { exitCode: info.exitCode, signal: info.signal, status: this._status },
    });
    // Phase 4: final, forced persistence write so endedAt/exitCode land.
    this._notifyState(true);
    this.emit('exit', info);
    // Drop EventEmitter listeners — TerminalRoom registers `.once('exit')` so
    // this is mainly defensive against subscribers that might forget to
    // unregister.
    this.removeAllListeners('exit');
  }

  private _setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    eventBus.emitEvent({
      kind: 'session.status_changed',
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
      payload: { status: s },
    });
    // Phase 4: status changes always force a write — no throttling.
    this._notifyState(true);
  }

  private _cleanupMcpConfig(): void {
    if (!this.mcpConfigPath) return;
    removeSessionMcpConfig({
      runtimeDir: this.mcpRuntimeDir,
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
    });
    this.mcpConfigPath = null;
  }

  private _openLog(): void {
    // Truncate if existing file is over cap (per plan §15).
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > LOG_CAP_BYTES) {
        fs.truncateSync(this.logPath, 0);
      } else {
        this.logBytes = stat.size;
      }
    } catch {
      // file doesn't exist — that's fine
    }
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a', mode: 0o600 });
  }

  private _appendLog(chunk: string): void {
    // Maintain ring buffer of last RING_BUFFER_LINES lines (in memory only, no secrets).
    this.partialLine += chunk;
    let nl = this.partialLine.indexOf('\n');
    while (nl !== -1) {
      const line = this.partialLine.slice(0, nl);
      this.ringBuffer.push(line);
      if (this.ringBuffer.length > RING_BUFFER_LINES) this.ringBuffer.shift();
      this.partialLine = this.partialLine.slice(nl + 1);
      nl = this.partialLine.indexOf('\n');
    }

    if (!this.logStream) return;
    if (this.logBytes >= LOG_CAP_BYTES) {
      // Drop further writes once cap is hit; truncation happens on next open.
      return;
    }
    try {
      const buf = Buffer.from(chunk, 'utf8');
      this.logStream.write(buf);
      this.logBytes += buf.length;
    } catch {
      /* ignore log write errors */
    }
  }

  private _closeLog(): void {
    try {
      this.logStream?.end();
    } catch {
      /* ignore */
    }
    this.logStream = null;
  }
}
