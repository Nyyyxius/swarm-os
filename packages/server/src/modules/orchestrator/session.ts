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
  shellQuote,
} from './agent-process.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { EffortLevel, PermissionMode } from '../../config.js';
import { toHostPath as toHostPathHelper } from './path-translate.js';
import { sessionDirFor } from './mcp-config.js';
import {
  ContextUsageTracker,
  addTokenUsage,
  isZeroTokenUsage,
  normalizeTokenUsage,
  type ContextUsageHistory,
  type ContextUsageSource,
  type ContextUsageWiring,
  type TokenUsageCounters,
} from './context-usage.js';
import { estimateTokenCostUsd, type TokenCostRates } from '../providers/catalogue.js';
// Type-only: the DECISION lives in `auto-compact.ts`, which imports
// `ContextUsageView` back from here. Both directions are `import type`, so
// there is no runtime cycle — nothing of that module is loaded by this one.
import type { AutoCompactSkipReason } from './auto-compact.js';
import { CodexRolloutSource, createLocalRolloutLister } from './context-usage-codex.js';
import { OpencodeControlPlaneSource } from './context-usage-opencode.js';
import { CLAUDE_PROVIDER } from '../providers/claude.js';
import {
  IDENTITY_PATH_MAPPER,
  type AgentPathMapper,
  type AgentProvider,
  type ContextResetCommand,
  type ProviderCapabilities,
  type ProviderId,
} from '../providers/types.js';

/**
 * `buildClaudeArgs` now lives with the claude adapter
 * (`modules/providers/claude.ts`). Re-exported here because it is part of this
 * module's historical public surface.
 */
export { buildClaudeArgs } from '../providers/claude.js';

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

/**
 * Name of the per-session 0600 file that carries `PreparedSpawn.secretEnv` to
 * the remote shell (`set -a && . <file> && set +a && exec …`) instead of putting
 * it on the remote command line, where `ps` exposes it to every user on the
 * host. Leading dot so it is out of the way of the adapter's own files.
 */
const SECRET_ENV_FILENAME = '.swarm-agent-env';

/**
 * update_system D.5 — backoff used when one PTY injector finds the other one
 * holding the line.
 *
 * Both injectors (`_fireNotice` and `_fireContextReset`) write in TWO steps:
 * the payload first, then a solo `\r` 150 / 250 ms later (see `notifySignal`'s
 * JSDoc for why the CR cannot ride the same chunk). Between those two writes
 * the Ink TUI has a half-typed prompt buffer; a second injector writing into
 * that gap produces one garbled line that submits as neither command. So the
 * loser of the race sleeps this long — deliberately longer than the 250 ms CR
 * delay of the slower injector — and re-checks. It is a backoff, never a
 * poll: exactly one timer is armed at a time per injector.
 */
const PTY_INJECT_CONTENTION_RETRY_MS = 300;

/**
 * How long `_fireNotice` considers the line "held" after handing the text to
 * `notifySignal` (which submits its CR at +150 ms). Slightly over that so
 * timer jitter can't let a context reset slip in between the two writes.
 */
const NOTICE_WRITE_WINDOW_MS = 200;

/**
 * Delay between `notifySignal`'s two writes — the text, then the standalone CR
 * that makes Ink parse it as a real Enter keypress (see `notifySignal`'s JSDoc).
 *
 * It doubles as the window during which `_signalFiring` holds the line, because
 * it IS that window: two mailbox signals 50 ms apart used to interleave as
 * `text1 text2 CR CR` and submit one garbled line that was neither message's
 * wake-up. Refusing the second costs nothing — the idle boundary re-signals it
 * the moment its `ts` is newer than `lastInboxSignalAt`
 * (docs/auto-compact.md §3.2).
 */
const SIGNAL_WRITE_WINDOW_MS = 150;

/**
 * Text of the mailbox wake-up signal (Phase 3).
 *
 * Lives HERE, with the only method that types it, since
 * docs/auto-compact.md §3.2 made `signalInbox()` the single gate every injector
 * goes through. `messaging.ts` re-exports it for its historical importers
 * (`preamble.ts` bakes it into every agent's instructions, so the string is
 * part of the agent-facing contract and must stay byte-identical).
 */
export const SIGNAL_TEXT = '[swarm-os] new message in inbox — call team.read_inbox to fetch';

/**
 * docs/auto-compact.md §8.1 (D9, v0.10.1) — the line typed into an agent's PTY
 * once a `/compact` the SERVER fired is over.
 *
 * Why it exists: a `/compact` does not start a turn. Every CLI summarises the
 * conversation and hands back an EMPTY prompt, so an agent compacted with work
 * in progress — by the threshold auto-compact (D2), by its own
 * `team.context_compact`, by its lead's `team.clear_worker { compact: true }`
 * or by the operator's COMPACT button — sat at that prompt until a human typed
 * "continue". Seen in production on v0.10.0.
 *
 * French because the fleet works in French. ONE LINE, no `\r` / `\n`: it is
 * typed into a live prompt buffer, and an embedded CR would submit it half-way
 * (`notifySignal`'s JSDoc). The last sentence is load-bearing: the nudge
 * follows EVERY server-fired compaction, including one that caught an agent
 * with nothing in progress (a lead waiting on its workers, a `/compact` the CLI
 * refused), and such an agent must stay idle rather than invent work.
 *
 * A server constant, never user or agent input.
 */
export const POST_COMPACT_NUDGE_TEXT =
  "[swarm-os] Contexte compacté. Reprends le travail que tu avais en cours là où tu t'étais arrêté " +
  "(relis tes fichiers d'état si besoin). Si tu n'avais rien en cours, reste simplement en attente.";

/**
 * The post-compact nudge when the inbox signal is ALSO owed at that boundary
 * (docs/auto-compact.md §8.1): ONE line, one submission.
 *
 * Two injections on the same boundary are not an option — the second would
 * land inside the first one's `_signalFiring` window and either be refused or,
 * without that guard, interleave as `text1 text2 CR CR` and submit one garbled
 * line. `SIGNAL_TEXT` is appended BYTE FOR BYTE: the preambles tell every agent
 * "when you see `[swarm-os] new message in inbox`, read the inbox before
 * continuing", so the combined line keeps that contract instead of inventing a
 * second wording of it.
 */
export const POST_COMPACT_NUDGE_WITH_INBOX_TEXT = `${POST_COMPACT_NUDGE_TEXT} ${SIGNAL_TEXT}`;

/**
 * How old a `dialogPending` flag must get before we say so (D5).
 *
 * A dialog closed WITHOUT a keystroke — an MCP elicitation the client cancelled
 * on a timeout, a permission prompt the agent withdrew — leaves the flag up,
 * and a flag that stays up freezes this session's mail signal, its context
 * resets and its operator notices until a human types something. That is the
 * documented trade (never auto-lower a guard against typing into a dialog), but
 * it must never be SILENT: past this age we warn, once, with the age and the
 * notification type that raised it.
 */
const DIALOG_PENDING_STALE_MS = 10 * 60 * 1000;

/**
 * Answers a terminal emulator sends back on its OWN initiative, which arrive on
 * the console WebSocket looking exactly like keystrokes.
 *
 * xterm.js replies to queries the CLI makes at startup and on every resize:
 * Device Attributes (`ESC [ ? … c`), Cursor Position Report (`ESC [ row;col R`),
 * DECRPM mode reports (`ESC [ ? … $ y`), OSC 10-19 colour reports
 * (`ESC ] 1x ; … BEL` / `… ST`) and focus in/out (`ESC [ I` / `ESC [ O`). None
 * of them is a human answering a dialog — and taking them for one is not
 * cosmetic: `clearDialogPending` lowers the D5 guard, so a browser tab that
 * merely gained focus while a permission prompt was on screen would re-open the
 * window in which the server types into that prompt.
 *
 * Deliberately conservative: it answers true ONLY when the whole frame is made
 * of these sequences and nothing else. A frame mixing an auto-response with a
 * real keystroke counts as human input — a false negative costs one redundant
 * guard release on a frame that did contain typing, a false positive costs the
 * guard itself.
 */
const TERMINAL_AUTO_RESPONSE_RE = new RegExp(
  '^(?:' +
    [
      '\u001b\\[[?>]?[0-9;]*c', // Device Attributes (DA1 / DA2)
      '\u001b\\[\\??[0-9]+(?:;[0-9]+)*R', // Cursor Position Report
      '\u001b\\[\\??[0-9;]*\\$y', // DECRPM mode report
      '\u001b\\]1[0-9];[^\u0007\u001b]*(?:\u0007|\u001b\\\\)', // OSC 10-19 colour report
      '\u001b\\[[IO]', // focus in / focus out
    ].join('|') +
    ')+$',
);

/**
 * True when `data` carries nothing but terminal auto-responses. Exported for
 * its own unit test — the regex is the kind of thing that is only ever right by
 * being checked against real captures.
 */
export function isTerminalAutoResponse(data: string): boolean {
  if (data.length === 0) return false;
  return TERMINAL_AUTO_RESPONSE_RE.test(data);
}

export type SessionType = 'lead' | 'worker';

/**
 * Context-reset commands the server can inject into a live PTY at a task
 * boundary. `/clear` wipes the conversation (the role survives via the
 * provider's durable preamble); `/compact` summarizes and continues.
 *
 * Defined with the provider contract (`providers/types.ts`) since
 * `AgentProvider.contextResetLine` is what turns it into a typed line;
 * re-exported here for the existing importers.
 */
export type { ContextResetCommand };

/**
 * update_system D.5 — terminal outcome of an armed operator notice. A notice
 * resolves exactly once; the caller learns which way it went through the
 * `onOutcome` callback and/or the `noticeState` getter.
 *
 *  - `fired`       — the text was written into the PTY on a real idle
 *                    boundary. This is the ONLY outcome that means the agent
 *                    was actually interrupted with the warning.
 *  - `never_idle`  — the deadline expired before the PTY ever went quiet for
 *                    `idleMs` (or while a context reset held the line). The
 *                    mailbox row is still there, but nothing woke the agent.
 *  - `aborted`     — the session died / was stopped / the notice was
 *                    superseded before it could fire. Not a delivery.
 */
export type NoticeOutcome = 'fired' | 'never_idle' | 'aborted';

/**
 * Snapshot of the most recent `armNotice` request. `outcome: null` means the
 * notice is still armed and re-arming; `id` echoes the caller-supplied
 * correlation token (the pre-minted mailbox message id, in practice) so a
 * caller can prove the outcome it reads belongs to ITS notice and not to a
 * previous one.
 */
export interface NoticeState {
  id: string | null;
  outcome: NoticeOutcome | null;
}

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
  /**
   * Auto-resume only — seed for the cumulative "messages processed" counter,
   * read from the persisted row. Same rationale as `startedAt`: the counter
   * is the operator's running total, and a respawn must not reset it to 0.
   */
  messagesProcessed?: number;
  /**
   * Auto-resume only — seed for the cumulative token counters, read from the
   * persisted row (docs/monitoring-agents.md, Lot 11). Same rationale as
   * `messagesProcessed`, with one addition: a restart relaunches the CLI on a
   * BRAND-NEW transcript, so without the seed every redeploy would reset every
   * agent's bill to zero. Partial and nullable per bucket — a row written
   * before the columns existed carries NULLs.
   */
  tokenUsage?: Partial<Record<keyof TokenUsageCounters, number | null>> | null;
  /**
   * Auto-resume only — seed for the cumulative PROVIDER-REPORTED cost, read
   * from `reported_cost_usd` (docs/monitoring-agents.md, Lot 13).
   *
   * Same argument as `tokenUsage`, one degree sharper: this figure cannot be
   * recomputed from anything we keep. The tokens can always be re-priced from
   * the catalogue, but the dollars opencode quoted exist nowhere else once the
   * process that quoted them is gone. `null` / absent ⇒ never measured.
   */
  reportedCostUsd?: number | null;
  orchestratorId: string;
  name: string;
  role: string;
  type: SessionType;
  cwd: string;
  initialPrompt: string | null;
  preamble: string | null;
  /**
   * One-shot context prepended to the positional prompt on spawn (e.g. the
   * Phase 8 "## Server restart notice"). Rides the positional argv — NOT the
   * system prompt — so a later `/clear` discards it instead of re-surfacing a
   * stale restart notice on every reset. Empty/null = no notice.
   */
  resumeNotice?: string | null;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  logsDir: string; // <dataDir>/logs
  /** Per-session mcp.json runtime root (e.g. `/tmp/swarm-os`). */
  mcpRuntimeDir: string;
  /** MCP HTTP host (must be loopback — enforced by McpServer.listen). */
  mcpHost: string;
  mcpPort: number;
  /**
   * Adapter driving this agent. Optional with a fallback on the built-in
   * claude adapter so every pre-multi-provider callsite keeps working
   * untouched; the Orchestrator resolves the id → object mapping from Lot 2.
   */
  provider?: AgentProvider;
  /** Skip the actual CLI spawn — useful for smoke testing without the agent. */
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
   * Fired right after a context-reset command (`/clear` / `/compact`) has been
   * submitted to the PTY. The Orchestrator wires this to re-deliver an inbox
   * wake-up signal when a `/clear` left undelivered mail behind (the mailbox
   * is server-side, so it survives the reset — only the agent's awareness of
   * it is wiped).
   */
  onContextReset?: (session: Session, cmd: ContextResetCommand) => void;
  /**
   * docs/auto-compact.md D1 — fired ONCE per period of PTY silence, the moment
   * this session has been quiet for `idleThresholdMs` and is genuinely free:
   * `running`/`waiting`, no dialog on screen, no context reset armed or being
   * typed, no operator notice armed. Everything else the Orchestrator wants to
   * do at a task boundary (re-signal the inbox, decide an auto-compact, refresh
   * the gauge) hangs off this one callback.
   *
   * The four exclusions are checked inside the Session (`_fireIdleBoundary`)
   * because they are all Session state, and because a boundary the Session
   * declines is NOT consumed: it comes back through the reset's own echo,
   * through the next keystroke, or through `_resolveNotice`. The Orchestrator
   * only ever sees boundaries on which it is safe to type.
   *
   * Synchronous by contract — it runs inside a timer callback and everything it
   * does (a queue size, a cached snapshot, a `requestContextReset`) is
   * synchronous. A throwing handler is caught and logged; it may not take the
   * session down.
   */
  onIdle?: (session: Session) => void;
  /**
   * Idle window (ms) a self-armed context reset waits for before firing. Used
   * by the byte-based auto-compact backstop below. Defaults to 2000ms.
   */
  idleThresholdMs?: number;
  /**
   * Context-management safety net: when >0, the session auto-arms a `/compact`
   * once it has emitted this many bytes of PTY output since its last reset.
   * `0` (default) disables the backstop — the agent-driven path is primary.
   */
  autoCompactBytes?: number;
  /**
   * docs/auto-compact.md §8.1 (D9) — owe the agent a `POST_COMPACT_NUDGE_TEXT`
   * at the first free idle boundary after each `/compact` this Session submits.
   * The Orchestrator passes `config.continueAfterCompact`
   * (`SWARM_OS_CONTINUE_AFTER_COMPACT`, ON by default). Absent = `false`, so a
   * Session built without it behaves exactly as it did in v0.10.0.
   *
   * The Session only ARMS and GATES the nudge (`postCompactNudgeOwed`,
   * `signalPostCompact`); choosing to type it is the idle-boundary handler's
   * job (`Orchestrator._onSessionIdle`), because the combined line with the
   * inbox signal needs the mailbox, which the Session does not see.
   */
  continueAfterCompact?: boolean;
  /**
   * Phase 4: hook token + main HTTP port. When both are set, the provider
   * writes a per-session config dir under `<runtimeRoot>/sessions/<id>/`
   * carrying the Notification hook, and exports its isolation env var
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, …) to the PTY.
   */
  hookToken?: string;
  mainHttpPort?: number;
  /** Hook POST base URL override (`config.hookUrl`) — see `SessionConfigRequest`. */
  hookUrl?: string;
  /**
   * Phase 5: writable runtime root for the per-container agent state. The
   * per-session config dir is `<runtimeRoot>/sessions/<id>`, with the CLI's
   * shared state subtree (`projects`, `history.jsonl`, `.credentials.json`, …)
   * symlinked from `<runtimeRoot>` so all sessions share the same auth +
   * history without duplicating large directories on every spawn. Tradeoff:
   * per-session writes to those shared paths land back in the runtime root
   * (intended — that's how the CLI updates its history).
   *
   * Value MUST be the resolved `config.claudeRuntimeDir` for claude. Named
   * `claudeConfigRoot` until Lot 2; the field is provider-agnostic and the
   * name now says so.
   */
  runtimeRoot?: string;
  /**
   * RO source mount path (host `~/.claude` exposed in the container — e.g.
   * `/claude-source`). When present alongside `runtimeRoot`, the provider
   * refreshes the host-volatile files from source into the runtime root right
   * before symlinking them per-session, so a host OAuth refresh that happened
   * after container boot still propagates. Omit (or pass an unmounted path) to
   * skip the refresh.
   */
  sourceDir?: string;
  /**
   * Explicit override for the config file that lives BESIDE the source dir
   * (claude's `~/.claude.json`). Falls back to `<sourceDir>.json`.
   */
  siblingSource?: string | null;
  /**
   * SSH transport bundle. When provided, the session spawns `claude` on the
   * remote host via `ssh -tt` instead of locally via `node-pty`. Required
   * paths inside the session (CLAUDE_CONFIG_DIR, --mcp-config, symlink
   * targets) are translated to host paths via this bundle. When omitted,
   * the session uses the local `PtyAgentProcess` (default).
   */
  sshTransport?: SessionSshTransport | null;
  /**
   * Monitoring (docs/monitoring-agents.md, Lot 2) — TTL, model limit resolver
   * and bounded tail reader for the context-usage tracker. Built by
   * `Orchestrator`, the only layer holding both the `Config` and the model
   * catalogue. Omitted (unit tests, embedders) ⇒ this session never tracks and
   * `contextUsage` stays absent from its view.
   */
  contextUsage?: ContextUsageWiring | null;
}

/**
 * Context-window occupancy of one agent (docs/monitoring-agents.md).
 *
 * Declared here from Lot 1 so the web mirror and the persistence layer agree on
 * the shape; filled from Lot 2 by `ContextUsageTracker` (`context-usage.ts`),
 * which reads the claude transcript the `SessionStart` hook points it at. Stays
 * absent from the view for a provider with no tracker, and for a session that
 * has not produced a turn yet.
 */
export interface ContextUsageView {
  usedTokens: number;
  /** Model context limit; `null` when the catalogue has no figure for it. */
  limitTokens: number | null;
  /** `min(1, used/limit)` — computed server-side; `null` without a limit. */
  pct: number | null;
  basis: 'transcript' | 'control-plane' | 'estimated';
  /** ISO 8601 — when the snapshot was taken. */
  updatedAt: string;
  /** True after a `/clear` until a new turn has been read back. */
  stale: boolean;
}

/**
 * The provider ACCOUNT's quota, as the CLI last reported it (Lot 13).
 *
 * codex only, today: it puts `rate_limits` on the `token_count` events the gauge
 * already reads — including the ones whose `info` is `null`, which Lot 6 skips
 * and which exist for no other purpose than to refresh this. Free to collect,
 * and the one number that says whether the whole fleet is about to be throttled.
 *
 * NOT the agent's usage, and the UI labels it as such: it is shared by every
 * session running under the same credentials. Never persisted either — a quota
 * that resets on a rolling window is only true at the moment it was read, and a
 * figure restored from SQLite after a redeploy would be a stale guess wearing a
 * fresh timestamp.
 */
export interface ProviderQuotaView {
  /** `primary.used_percent`, 0-100. `null` when the event carried none. */
  usedPercent: number | null;
  /** ISO 8601 rollover of the primary window, or `null`. */
  resetsAt: string | null;
  /** `plan_type` (`'plus'`, …), or `null`. */
  plan: string | null;
}

/**
 * What one agent has BILLED since it was first spawned (Lot 11).
 *
 * Cumulative and restart-proof: the four counters are mirrored onto the session
 * as they are measured, persisted through the same throttled write as every
 * other field, and seeded back on resume — so the figure an operator reads is
 * the agent's whole life, not its current CLI process.
 *
 * `costUsd` is an ESTIMATE and says so twice: in its own `costBasis`, and by
 * being `null` rather than `0` whenever the catalogue cannot price the model.
 * It is computed at view time from the live rate card, never stored, so a
 * price correction upstream fixes yesterday's agents too.
 */
export interface TokenUsageView {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  /** `null` when neither an input nor an output price is known for this model. */
  costUsd: number | null;
  /**
   * Where `costUsd` comes from (Lot 13). `'estimated'` — tokens multiplied by
   * the catalogue's rate card, which is a guess about the model's price list.
   * `'reported'` — the CLI itself did the arithmetic and told us the dollars
   * (opencode publishes a `cost` per session and per message, priced from the
   * provider's own catalogue). A reported figure always wins: it accounts for
   * the provider's real billing rules, discounts and cache pricing included.
   */
  costBasis: 'estimated' | 'reported';
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
  /**
   * Adapter id driving this agent (`'claude'` unless the team / the spawn
   * request asked for another). First-class since Lot 2: persisted, surfaced
   * in the API, and what auto-resume brings the agent back on.
   */
  provider: ProviderId;
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

  // --- Monitoring (docs/monitoring-agents.md) ----------------------------
  // All four are OPTIONAL and purely additive: a consumer that predates them
  // is unaffected, and a view built from a legacy DB row simply omits them.

  /**
   * Cumulative inbox messages this agent has drained. Mirrored from the
   * mailbox at drain time so it rides `toView()` — the only shape both the
   * persistence layer and `GET /sessions/:id` ever see.
   */
  messagesProcessed?: number;
  /** A `/compact` or `/clear` is armed and waiting for the next idle boundary. */
  contextResetPending?: boolean;
  /**
   * Messages currently queued for this session. Decorated by
   * `Orchestrator.toView()`: the Session has no handle on the mailbox.
   */
  inboxCount?: number;
  /** Context-window occupancy. Filled from Lot 2; absent when unknown. */
  contextUsage?: ContextUsageView | null;
  /**
   * Lot 9 — the ~20 most recent occupancy samples as integer percentages
   * (0-100), oldest first, for the sparkline in the monitoring table.
   *
   * It rides the poll the UI already makes rather than a second endpoint: ~20
   * small integers per live session is the entire cost of the column. Same
   * gates as `contextUsage` (live session, known limit), and absent — never
   * `null`, never `[]` — when there is nothing to draw. NOT persisted: the
   * history is memory-only and a DB row never carries it.
   */
  contextSpark?: number[];
  /**
   * Lot 11 — cumulative tokens + estimated cost. Absent, never zeroed, until
   * something has actually been measured or seeded: `—` means "not measured
   * here" (gemini has no source at all, and neither does a session that predates
   * the columns), which is a different statement from `0`.
   *
   * NOT gated on the session being live, unlike `contextUsage`: an occupancy
   * describes a context that dies with the agent, a bill does not.
   */
  tokenUsage?: TokenUsageView;
  /**
   * Lot 13 — the provider ACCOUNT's quota, for the sessions whose CLI reports
   * one (codex). Live sessions only, and never persisted: see
   * `ProviderQuotaView`.
   */
  providerQuota?: ProviderQuotaView;
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
  /**
   * Monitoring — cumulative inbox messages this agent drained, mirrored from
   * the mailbox at the single drain point (`readInbox`) and seeded from the
   * DB row on resume. It lives here, and not only on the mailbox, because
   * everything durable is built from `toView()`.
   */
  private _messagesProcessed: number;
  /**
   * Monitoring (Lot 11) — cumulative tokens this agent has billed, mirrored
   * from the context tracker as each delta is measured and seeded from the DB
   * row on resume. Same reason it lives here rather than only in the tracker as
   * `_messagesProcessed` lives here rather than only in the mailbox:
   * everything durable is built from `toView()`, and the tracker dies with the
   * process while the counter must not.
   */
  private _tokenUsage: TokenUsageCounters;
  /**
   * True when the resume seed carried a value — including an explicit zero.
   *
   * It is what separates "measured, and it is zero" from "never measured",
   * which is the same distinction the nullable `messages_processed` column
   * makes. Without it a resumed agent that has not spoken yet would drop its
   * `tokenUsage` from the view and the UI would fall back to `—` for a figure
   * we hold.
   */
  private _tokenUsageSeeded: boolean;
  /**
   * Monitoring (Lot 13) — cumulative dollars the PROVIDER itself billed,
   * mirrored and seeded exactly like `_tokenUsage`.
   *
   * `0` means "nobody ever reported one", which is why it doubles as its own
   * seeded flag: a provider that quotes prices quotes a positive one the moment
   * it has served a token, and an agent whose reported bill is genuinely zero
   * has by definition nothing to show that the estimate would not show better.
   */
  private _reportedCostUsd: number;

  private readonly mcpRuntimeDir: string;
  private mcpConfigPath: string | null = null;
  /**
   * Container path of the 0600 file holding this spawn's `secretEnv`, when the
   * adapter asked for one. Written just before the SSH spawn and removed with
   * the session — it holds credentials (`OPENROUTER_API_KEY`), a per-session MCP
   * url and a control-plane password.
   */
  private _remoteEnvFile: string | null = null;
  private readonly sshTransport: SessionSshTransport | null;
  /**
   * Adapter that knows how to configure, launch and talk to this agent's CLI.
   * Everything claude-specific used to be inlined here; it now lives behind
   * this object (`modules/providers/`).
   */
  private readonly provider: AgentProvider;
  /** Container → agent path translation, built once from `sshTransport`. */
  private readonly _paths: AgentPathMapper;
  /**
   * Monitoring — context-usage wiring and the ONE tracker it builds.
   *
   * One tracker per session, whatever the provider: the policy (TTL, one read in
   * flight, the module-wide cap, the generation guard, "stale rather than
   * confidently wrong") is identical for all three, and only the SOURCE differs.
   * Which is why the branching below is about building a `ContextUsageSource`
   * and nothing else.
   *
   * WHEN it is built differs, because what each provider needs differs:
   *
   *   claude    lazily, on the first `setTranscriptPath` — there is nothing to
   *             read until the `SessionStart` hook names a file.
   *   codex     eagerly — the `CODEX_HOME` is known the moment phase A is done,
   *             and the tracker's job is precisely to keep looking until the
   *             agent's first model request creates the rollout in it.
   *   opencode  eagerly, LOCAL TRANSPORT ONLY — the control plane is on the
   *             host's loopback under SSH and we have no forward for it.
   *   gemini    never. No source, no tracker, `—` in the UI, by design.
   *
   * A session with no wiring (unit tests, embedders) never gets a tracker at all.
   */
  private readonly _contextUsageWiring: ContextUsageWiring | null;
  private _contextUsage: ContextUsageTracker | null = null;

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
  /**
   * Armed context-reset request, fired once the session goes idle (so a
   * `/clear` or `/compact` never lands mid-turn). `null` when nothing is
   * pending. `idleMs` is captured so the re-arm loop knows how long the PTY
   * must stay quiet before the command is safe to inject.
   */
  private _pendingContextReset: { cmd: ContextResetCommand; instructions?: string; idleMs: number } | null = null;
  private _pendingContextTimer: NodeJS.Timeout | null = null;
  /**
   * update_system D.5 — armed operator notice, fired once the PTY goes idle.
   *
   * DELIBERATELY a separate slot from `_pendingContextReset`: that one is
   * single-occupancy (`requestContextReset` returns false when it is taken)
   * and is already contended by the byte-based auto-compact backstop
   * (`_maybeAutoCompact`) and by `compactOnWaiting` (`http/routes/hooks.ts`).
   * Arming a warning there would either be silently refused or would cancel a
   * pending `/compact` — both unacceptable for the one message the operator
   * absolutely must land before the container is recreated.
   *
   * `deadlineAt` is what `_pendingContextReset` has no equivalent of: past it
   * we stop re-arming and report `never_idle` instead of waiting forever for
   * an idle boundary a busy lead may never offer.
   */
  private _pendingNotice: {
    text: string;
    idleMs: number;
    deadlineAt: number;
    id: string | null;
    onOutcome: ((outcome: NoticeOutcome) => void) | null;
  } | null = null;
  private _pendingNoticeTimer: NodeJS.Timeout | null = null;
  /** Last resolved notice + its correlation id. See `noticeState`. */
  private _noticeState: NoticeState | null = null;
  /** True while the notice's two-step write (text, then CR) is in flight. */
  private _noticeFiring = false;
  /**
   * docs/auto-compact.md D1 — the idle-boundary timer. At most ONE per session,
   * armed on the first byte of a burst only when none exists (never a clear+set
   * per chunk, which on a chatty PTY would be thousands of timer churns a
   * minute), sized to the idle time that remains, and `unref()`'d so it can
   * never be the reason the process stays up.
   */
  private _idleTimer: NodeJS.Timeout | null = null;
  /**
   * True once `onIdle` has been called for the CURRENT period of silence.
   *
   * Reset to `false` on every PTY byte, and explicitly at every site that
   * re-arms the timer without one (`resume`, spawn, `writeInput`/`submitInput`,
   * the provider-has-no-reset branch, `_resolveNotice`) — without that reset,
   * those sites would arm a timer whose callback returns immediately and the
   * boundary would be lost for good.
   *
   * Deliberately NOT set when the boundary is DECLINED by one of the D2 step-0
   * guards: a declined boundary is not a consumed one.
   */
  private _idleNotified = false;
  /**
   * docs/auto-compact.md D5 — a dialog is on screen and is waiting for a human.
   *
   * Anything written into a prompt buffer showing a claude permission dialog
   * VALIDATES THE HIGHLIGHTED OPTION: a mailbox signal, a `/compact`, an
   * operator notice — all of them would answer a question nobody read. So every
   * server-side injector consults this flag, and only a real human keystroke
   * (`writeInput` / `submitInput`) or an explicit "the dialog is gone"
   * notification lowers it. Never lowered on PTY output: a resize redraws the
   * dialog, and lowering on the first byte would re-open the auto-validation
   * window at the exact moment an operator opens the console.
   *
   * Carries the notification type that raised it, so the refusal an operator
   * reads in `session.auto_compact_skipped` names the dialog.
   */
  private _dialogPending: { type: string; at: number } | null = null;
  /** One `session.dialog_pending_stale` warning per raised flag, not per read. */
  private _dialogPendingStaleWarned = false;
  /**
   * docs/auto-compact.md D5 — once per session, the `warn` for the untyped
   * fallback in `http/routes/hooks.ts`. It lives on the Session so it dies with
   * it: a process-wide set would grow one uuid per agent, forever, on a 24/7
   * fleet. Public and mutable for the same reason as the two auto-compact
   * fields below — it is the route's state, scoped to this session's life.
   */
  dialogPendingUntypedWarned = false;
  /**
   * True while a mailbox signal's two-step write is in flight (text now, CR at
   * +150 ms). The third member of the `_noticeFiring` / `_contextResetFiring`
   * family, and read by exactly the same backoffs.
   */
  private _signalFiring = false;
  /**
   * Epoch ms of the last inbox signal `signalInbox()` actually wrote, or `null`
   * when none has been written since the last context reset.
   *
   * `_fireContextReset` resets it to `null` at the moment the command reaches
   * the PTY, which is what makes ONE rule cover two situations: "mail arrived
   * after the last nudge" and "the agent's memory of its inbox was just wiped".
   * See `Orchestrator._onSessionIdle` step 1.
   */
  private _lastInboxSignalAt: number | null = null;
  /**
   * docs/auto-compact.md §8.1 (D9) — a `/compact` reached the PTY and the agent
   * has not been told to resume yet.
   *
   * Armed in `_fireContextReset` at the moment the command is SUBMITTED (its
   * `\r` landed), never when it is merely armed: an armed reset can wait
   * minutes for its boundary, and one the provider does not support never
   * writes anything. Cleared by a `/clear` fired in between (a wiped agent is
   * idle on purpose) and consumed by `signalPostCompact` — which is what makes
   * it "exactly once per compaction". A boundary DECLINED by the step-0 guards
   * of `_fireIdleBoundary` never reaches the handler, so it cannot consume it
   * either; neither can a refused injection.
   */
  private _postCompactNudgeOwed = false;
  /**
   * docs/auto-compact.md D8 — the last refusal reason
   * `Orchestrator._onSessionIdle` logged for this session, so it can log at
   * `info` on a CHANGE and at `debug` otherwise. Lives here because the state
   * is per-agent and must die with it; the Orchestrator owns the meaning.
   */
  lastAutoCompactSkipReason: AutoCompactSkipReason | null = null;
  /** Same ownership — the once-per-session `session.auto_compact_starved` warn. */
  autoCompactStarvedWarned = false;
  /**
   * True while a context reset's two-step write is in flight. `_pendingContextReset`
   * is nulled at the TOP of `_fireContextReset`, i.e. 250 ms before the command
   * is actually submitted, so `hasPendingContextReset` alone leaves a window in
   * which the notice would write into a half-typed `/compact`. This flag closes
   * exactly that window.
   */
  private _contextResetFiring = false;
  /** D5 — one `held — dialog pending` session-log line per armed reset. */
  private _contextResetHeldLogged = false;
  /** Bytes of PTY output emitted since the last context reset (auto-compact backstop). */
  private _bytesSinceReset = 0;
  private readonly _idleThresholdMs: number;
  private readonly _autoCompactBytes: number;
  /** docs/auto-compact.md §8.1 — `SessionInit.continueAfterCompact`, frozen at construction. */
  private readonly _continueAfterCompact: boolean;

  /** Phase 4 — set during construction, fired on every state mutation. */
  private readonly _onStateChange: ((session: Session, force: boolean) => void) | null;
  /** Fired right after a context-reset command is submitted to the PTY. */
  private readonly _onContextReset:
    | ((session: Session, cmd: ContextResetCommand) => void)
    | null;
  /** docs/auto-compact.md D1 — the idle-boundary handler, or `null`. */
  private readonly _onIdle: ((session: Session) => void) | null;
  /** Phase 4 — initial prompt is needed by persistence (not normally exposed). */
  readonly initialPromptRaw: string | null;
  /** One-shot resume notice prefixed to the positional prompt on spawn. */
  private readonly resumeNotice: string | null;

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
    this.resumeNotice = init.resumeNotice ?? null;
    this.model = init.model;
    this.effort = init.effort;
    this.permissionMode = init.permissionMode;
    // Phase 8: reuse the persisted ISO timestamp on auto-resume; mint a
    // fresh one on first spawn. Without this, the next UPSERT would
    // overwrite the original startedAt with the boot time.
    this.startedAt = init.startedAt ?? new Date().toISOString();
    this._lastActivityAt = this.startedAt;
    this._idleSince = Date.now();
    // Resume seed (0 on a first spawn). Negative / non-finite rows are
    // clamped: a corrupt value must not make the counter run backwards.
    const seed = init.messagesProcessed ?? 0;
    this._messagesProcessed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : 0;
    // Lot 11 — same clamp, same reason: a corrupt row must not make the bill
    // run backwards. `normalizeTokenUsage` floors every bucket at 0.
    this._tokenUsage = normalizeTokenUsage(init.tokenUsage);
    this._tokenUsageSeeded =
      init.tokenUsage != null &&
      (['in', 'out', 'cacheRead', 'cacheWrite'] as const).some(
        (k) => typeof init.tokenUsage?.[k] === 'number',
      );
    // Lot 13 — same clamp again. A REAL column can come back as anything a
    // hand-edited database holds; only a positive finite number is a bill.
    const costSeed = init.reportedCostUsd;
    this._reportedCostUsd =
      typeof costSeed === 'number' && Number.isFinite(costSeed) && costSeed > 0 ? costSeed : 0;
    this.mcpRuntimeDir = init.mcpRuntimeDir;
    this.sshTransport = init.sshTransport ?? null;
    // Pre-multi-provider callsites pass nothing and get the built-in claude
    // adapter — the exact code path that used to be hard-wired here.
    this.provider = init.provider ?? CLAUDE_PROVIDER;
    this._paths = this._buildPathMapper();
    this._contextUsageWiring = init.contextUsage ?? null;
    this._onStateChange = init.onStateChange ?? null;
    this._onContextReset = init.onContextReset ?? null;
    this._onIdle = init.onIdle ?? null;
    this._idleThresholdMs = init.idleThresholdMs ?? 2000;
    this._autoCompactBytes = init.autoCompactBytes ?? 0;
    this._continueAfterCompact = init.continueAfterCompact === true;

    const orchLogDir = path.join(init.logsDir, this.orchestratorId);
    fs.mkdirSync(orchLogDir, { recursive: true });
    this.logPath = path.join(orchLogDir, `${this.id}.log`);

    // PHASE A — prepare the per-session config dir (0700 mkdir, shared-state
    // symlinks, pre-accepted trust dialogs, notification hook, preamble).
    // Deliberately BEFORE `_openLog()` and `_spawn()`: phase A failures are
    // reported through the structured logger, not the session log, and the
    // config dir has to exist before the MCP write and the spawn read it.
    const prepared = this.provider.prepareSessionConfig({
      sessionId: this.id,
      orchestratorId: this.orchestratorId,
      cwd: this.cwd,
      transport: this.sshTransport ? 'ssh' : 'local',
      paths: this._paths,
      preamble: init.preamble,
      hookToken: init.hookToken,
      mainHttpPort: init.mainHttpPort,
      hookUrl: init.hookUrl,
      runtimeRoot: init.runtimeRoot,
      sourceDir: init.sourceDir,
      siblingSource: init.siblingSource,
      hostSharedDir: this.sshTransport?.hostClaudeDir ?? null,
    });
    this._sessionConfigDir = prepared.configDir;
    this._sessionCleanupPaths = prepared.cleanupPaths;
    // Monitoring — codex and opencode can start looking straight away; claude
    // waits for its hook. See `_buildContextUsageSource`.
    this._initContextUsage();

    this._openLog();
    this._spawn(init);
  }

  private _sessionConfigDir: string | null = null;
  /**
   * Paths the provider asked us to delete once the session is over. EMPTY for
   * claude — its per-session dir holds symlinks and a trust seed, nothing that
   * grows, and it is deliberately left in place.
   *
   * Providers that keep a per-session SQLite state file (codex) return their
   * config dir here: sharing those across sessions is a corruption recipe, so
   * they are born and die with the session, and something has to do the dying.
   */
  private _sessionCleanupPaths: readonly string[] = [];
  /**
   * Phase 4: public read-only accessor — used by tests / dev tooling. Kept
   * under its historical name; it is the provider's per-session config dir
   * (`CLAUDE_CONFIG_DIR` for claude, `CODEX_HOME` / `GEMINI_CLI_HOME` later).
   */
  get claudeConfigDir(): string | null {
    return this._sessionConfigDir;
  }

  /**
   * What this session's adapter can express. Public because the decision does
   * not always belong to `Session`: `http/routes/hooks.ts` has to know whether a
   * notification callback means "a human is needed" (claude) or merely "the turn
   * ended" (codex `notify`, gemini `AfterAgent`) before it flips a badge or
   * pings Discord.
   *
   * Read off the session's OWN adapter instance rather than looked up in the
   * registry: a plugin-provided provider can be unregistered while its sessions
   * are still alive, and a session must keep behaving like what it is running.
   */
  get providerCapabilities(): ProviderCapabilities {
    return this.provider.capabilities;
  }

  /**
   * Container path → agent-visible path. Identity in local transport; under
   * SSH the agent runs in the host's namespace, so anything we hand it must
   * already be translated. Two roots because `dataDir` and `workspaceRoot`
   * are independent bind mounts.
   */
  private _buildPathMapper(): AgentPathMapper {
    const t = this.sshTransport;
    if (!t) return IDENTITY_PATH_MAPPER;
    return {
      data: (containerPath) =>
        toHostPathHelper({ containerPath, dataDir: t.dataDir, hostDataDir: t.hostDataDir }),
      workspace: (containerPath) =>
        toHostPathHelper({
          containerPath,
          dataDir: t.workspaceRoot,
          hostDataDir: t.hostWorkspaceRoot,
        }),
    };
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

  /** Cumulative inbox messages this agent has drained. */
  get messagesProcessed(): number {
    return this._messagesProcessed;
  }

  /**
   * Monitoring — credit `n` freshly drained inbox messages to this session.
   *
   * Called from exactly one place, `readInbox`, right after `Mailbox.read`
   * returned: that is the only moment an agent actually takes messages, and
   * keeping the mirror on that same line is what stops the two counters from
   * drifting. A no-op for `n <= 0` (an empty drain consumed nothing).
   *
   * The state notification is deliberately unforced — it rides the existing
   * 1 write/s throttle rather than adding a DB write per read.
   */
  recordMessagesProcessed(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this._messagesProcessed += Math.floor(n);
    this._notifyState(false);
  }

  /** Cumulative tokens this agent has billed. A copy — callers may not mutate. */
  get tokenUsage(): TokenUsageCounters {
    return { ...this._tokenUsage };
  }

  /**
   * Monitoring (Lot 11) — credit one measured DELTA to this session.
   *
   * Called from exactly one place, the context tracker's `onTokenUsage`, which
   * fires once per accepted source reading. Deltas, not totals, for the same
   * reason `recordMessagesProcessed` takes a count: the source knows what it
   * has just read, the session knows what has been read so far, and neither has
   * to trust the other's arithmetic.
   *
   * The state notification is deliberately unforced — it rides the existing
   * 1 write/s throttle rather than adding a DB write per poll.
   */
  recordTokenUsage(delta: TokenUsageCounters): void {
    const clean = normalizeTokenUsage(delta);
    if (isZeroTokenUsage(clean)) return;
    this._tokenUsage = addTokenUsage(this._tokenUsage, clean);
    this._notifyState(false);
  }

  /** Cumulative dollars the provider itself billed for this agent (Lot 13). */
  get reportedCostUsd(): number {
    return this._reportedCostUsd;
  }

  /**
   * Monitoring (Lot 13) — credit one provider-reported cost DELTA, in dollars.
   *
   * The money twin of `recordTokenUsage`, wired to the same tracker and
   * unforced for the same reason. Separate from it because the two are
   * separate measurements: opencode reports both, codex reports only tokens,
   * and a session that somehow saw one without the other must still bank it.
   */
  recordReportedCost(deltaUsd: number): void {
    if (typeof deltaUsd !== 'number' || !Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
    this._reportedCostUsd += deltaUsd;
    this._notifyState(false);
  }

  /**
   * Monitoring (Lot 13) — the provider ACCOUNT's quota, or `null`.
   *
   * codex only in practice, and by construction rather than by a test on the
   * provider id: it is the only source that ever puts a quota on a reading.
   */
  get providerQuota(): ProviderQuotaView | null {
    return this._contextUsage?.providerQuota ?? null;
  }

  /** Returns the last N lines from the in-memory ring buffer (Phase 3 crash dump helper). */
  getRecentLines(n = 20): string[] {
    return this.ringBuffer.slice(-Math.max(0, n));
  }

  // --- Monitoring: context usage (docs/monitoring-agents.md, Lots 2/6/7) ---

  /**
   * Build this provider's context source, once, at construction time.
   *
   * Only codex and opencode land here: claude's source needs a path that does
   * not exist until its hook fires, and gemini has no source at all.
   */
  private _buildContextUsageSource(wiring: ContextUsageWiring): ContextUsageSource | null {
    switch (this.provider.id) {
      case 'codex': {
        const configDir = this._sessionConfigDir;
        // No `CODEX_HOME` means phase A failed, and `buildSpawn` is about to
        // refuse the session anyway.
        if (configDir === null) return null;
        return new CodexRolloutSource({
          // The agent's own view of the directory: under SSH the rollout is read
          // in the HOST's namespace, where these paths are mounted elsewhere.
          sessionsDir: path.join(this._paths.data(configDir), 'sessions'),
          // Lot 11 — a resumed session keeps its id, therefore its `CODEX_HOME`,
          // therefore the rollout of the life that has ALREADY been billed. The
          // source has to adopt it as a base instead of billing it again.
          resumed: this._tokenUsageSeeded,
          ...(wiring.readTail ? { readTail: wiring.readTail } : {}),
          listRollouts: wiring.listRollouts ?? createLocalRolloutLister(),
        });
      }
      case 'opencode': {
        // Under SSH the control plane listens on the HOST's loopback, and
        // `SshAgentProcess` only sets up a REVERSE forward (`-R`, for MCP).
        // Reaching it needs `ssh -L` — the same gap as the `/event` consumer
        // (opencode.ts:868-871). No source, no tracker, `—`. Never an error.
        if (this.sshTransport !== null) return null;
        const provider = this.provider;
        if (typeof provider.controlPlane !== 'function') return null;
        const configDir = this._sessionConfigDir;
        return new OpencodeControlPlaneSource({
          // Re-resolved on every read: the plane dies with the process, and the
          // adapter is the only thing that knows its port and password.
          controlPlane: () => provider.controlPlane?.(configDir) ?? null,
          // Same restart hazard as codex: an abandoned session stays listed
          // with its final counters, and those have already been billed.
          resumed: this._tokenUsageSeeded,
        });
      }
      default:
        return null;
    }
  }

  /** Wire the tracker for a provider whose source is known at spawn time. */
  private _initContextUsage(): void {
    const wiring = this._contextUsageWiring;
    if (wiring === null) return;
    const source = this._buildContextUsageSource(wiring);
    if (source === null) return;
    this._contextUsage = new ContextUsageTracker({
      sessionId: this.id,
      source,
      ...wiring,
      onTokenUsage: (delta) => this.recordTokenUsage(delta),
      onReportedCost: (usd) => this.recordReportedCost(usd),
    });
  }

  /**
   * Adopt the transcript path the agent's `SessionStart` hook just reported
   * (`http/routes/hooks.ts`, kind `session.transcript`).
   *
   * claude ONLY — and the gate is here rather than at the callsite because the
   * same endpoint serves gemini, whose hook payload is Claude-Code-compatible
   * and would happily hand us a path whose `.jsonl` has no `message.usage` at
   * all. codex and opencode resolve their own source (`_initContextUsage`).
   *
   * Idempotent and cheap: a hook re-firing with the same path changes nothing.
   * Every later path WINS — `/clear` rotates the file (spike S4).
   */
  setTranscriptPath(filePath: string): void {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return;
    if (this.provider.id !== 'claude') return;
    const wiring = this._contextUsageWiring;
    if (wiring === null) return;
    if (this._contextUsage === null) {
      this._contextUsage = new ContextUsageTracker({
        sessionId: this.id,
        ...wiring,
        onTokenUsage: (delta) => this.recordTokenUsage(delta),
        onReportedCost: (usd) => this.recordReportedCost(usd),
      });
    }
    this._contextUsage.setTranscriptPath(filePath);
  }

  /**
   * Adopt the codex `thread-id` its `notify` payload just reported
   * (`http/routes/hooks.ts`, kind `session.waiting`).
   *
   * codex ONLY, and it is the whole reason the codex tracker is trustworthy.
   * A thread is one rollout file; `/new` (which is what swarm-os types for a
   * `/clear`) starts a new thread and a new file — but that file is created
   * LAZILY, at the new thread's first model request, while its NAME already
   * carries the timestamp of the reset. Until it materialises, "the most recent
   * rollout" still resolves to the previous one: complete, plausible, and
   * describing a conversation codex has already abandoned. The thread-id flips
   * the instant the first turn of the new thread completes, with no ordering
   * heuristic at all (spike R5/R6).
   *
   * A no-op for every other provider, including one whose payload happens to
   * carry a similar-looking field.
   */
  setAgentThreadId(threadId: string): void {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) return;
    if (this.provider.id !== 'codex') return;
    this._contextUsage?.retarget(threadId.trim());
  }

  /**
   * Fire-and-forget, TTL-gated refresh of this session's context usage. Called
   * from `Orchestrator.toView()` — the `/orchestrators` poll IS the heartbeat,
   * so there is no timer anywhere in this feature. Never throws, never awaits.
   *
   * LIVE sessions only. `listSessions()` keeps terminated ones for the map, and
   * their transcripts stop changing the moment the CLI exits: refreshing them
   * would be one file read per dead agent per TTL, forever, for a number the
   * view no longer serializes.
   */
  maybeRefreshContextUsage(): void {
    if (this._status !== 'running' && this._status !== 'waiting') return;
    this._contextUsage?.maybeRefresh();
  }

  /** Cached occupancy, or `null` when nothing has been read yet. Synchronous. */
  get contextUsage(): ContextUsageView | null {
    return this._contextUsage?.snapshot() ?? null;
  }

  /**
   * Lot 9 — the rolling in-memory history behind
   * `GET /sessions/:id/context-history`. `null` for a provider with no tracker
   * (gemini), which the route answers with empty arrays rather than a 404: the
   * session exists, it simply has no measurable context.
   *
   * Unlike `contextUsage` this is NOT gated on the session being live: a past
   * measurement stays true after the agent exits, and nothing here is ever
   * serialized into a row.
   */
  get contextHistory(): ContextUsageHistory | null {
    return this._contextUsage?.history() ?? null;
  }

  /**
   * Lot 12 — USD/hour this agent is burning right now, or `null` when the
   * question has no honest answer (no tracker, no rate card, a ring too short
   * or too old). Priced HERE rather than in the tracker for the same reason as
   * `tokenUsage`: the tracker counts tokens, money is a read-time
   * multiplication by a live rate card.
   *
   * Not part of `toView()`: the team burn is a `/metrics/costs` question, and
   * putting a per-session dollar rate on the 3 s `/orchestrators` poll would
   * price every agent in the fleet four times a minute for nobody.
   */
  get burnPerHourUsd(): number | null {
    const tracker = this._contextUsage;
    if (!tracker) return null;
    let rates: TokenCostRates | null = null;
    try {
      rates = this._contextUsageWiring?.costRates?.() ?? null;
    } catch {
      // A thunk that throws costs the estimate, never the caller.
      return null;
    }
    return tracker.burnPerHourUsd(rates);
  }

  /**
   * Lot 11 — the token block, priced at emission.
   *
   * `undefined` — so the field stays ABSENT rather than zeroed — until
   * something has been measured or seeded. The multiplication happens here and
   * not in the tracker because the rate card is live: an agent spawned while
   * the catalogue was cold gets its cost the moment the catalogue warms up,
   * with no state to invalidate.
   */
  private _tokenUsageView(): TokenUsageView | undefined {
    const usage = this._tokenUsage;
    const reported = this._reportedCostUsd;
    if (!this._tokenUsageSeeded && isZeroTokenUsage(usage) && reported <= 0) return undefined;
    // Lot 13 — a price the PROVIDER quoted beats one we derived. It is the same
    // arithmetic done against the real billing rules rather than a rate card we
    // scraped, so it needs no catalogue and it is right even for a model ours
    // has never heard of. No rate lookup at all on this path.
    if (reported > 0) {
      return { ...usage, costUsd: reported, costBasis: 'reported' };
    }
    let rates = null;
    try {
      rates = this._contextUsageWiring?.costRates?.() ?? null;
    } catch {
      // A thunk that throws costs the estimate, never the view.
      rates = null;
    }
    return {
      ...usage,
      costUsd: estimateTokenCostUsd(usage, rates),
      costBasis: 'estimated',
    };
  }

  toView(): SessionView {
    // A terminated session's last known occupancy describes a context that no
    // longer exists — and `DbPersistence.writeSession` builds its row from this
    // view, so serializing it would persist that fiction. Live sessions only.
    const live = this._status === 'running' || this._status === 'waiting';
    const contextUsage = live ? this.contextUsage : null;
    // Same gate, same reason. `spark()` answers `null` without a limit, so an
    // unscaled shape is never drawn.
    const contextSpark = live ? this._contextUsage?.spark() ?? null : null;
    const tokenUsage = this._tokenUsageView();
    // Lot 13 — the account quota, on the same `live` gate as the occupancy and
    // for a sharper version of the same reason: a rolling-window percentage
    // read hours ago, on a session that has since exited, is not a quota — it
    // is a fossil. Nothing persists it either, so a terminated agent has none.
    const providerQuota = live ? this.providerQuota : null;
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
      provider: this.provider.id,
      status: this._status,
      pid: this._pid,
      startedAt: this.startedAt,
      endedAt: this._endedAt,
      exitCode: this._exitCode,
      lastError: this._lastError,
      stopReason: this._stopReason,
      logPath: this.logPath,
      lastActivityAt: this._lastActivityAt,
      // Monitoring. `inboxCount` is NOT here: it belongs to the mailbox, and
      // `Orchestrator.toView()` decorates it on the way out.
      messagesProcessed: this._messagesProcessed,
      contextResetPending: this.hasPendingContextReset,
      // Additive to the letter: absent, not `null`, when there is nothing to say.
      ...(contextUsage ? { contextUsage } : {}),
      ...(contextSpark && contextSpark.length > 0 ? { contextSpark } : {}),
      // Lot 11. NOT gated on `live`: unlike an occupancy, a bill stays true
      // after the agent exits — and this view is what the final DB write is
      // built from, so gating it would erase the totals on the way out.
      ...(tokenUsage ? { tokenUsage } : {}),
      // Lot 13. Absent for every provider but codex, because no other source
      // produces one — the gate is the measurement, not a switch on the id.
      ...(providerQuota ? { providerQuota } : {}),
    };
  }

  /**
   * Push human input to the underlying PTY.
   *
   * Every human-typed byte in the system arrives here or through
   * `submitInput`: the web console (`http/ws/terminal.ts`), the REST composer
   * (`http/routes/sessions.ts`) and a Discord approval reply
   * (`approvals/resolve.ts`) are the only callers of `agent.write` outside this
   * file. That is exactly why the D5 dialog guard is lowered here — a keystroke
   * is the ONLY proof that whatever dialog was on screen has been dealt with.
   */
  writeInput(data: string): void {
    if (!this.agent) return;
    this.agent.write(data);
    // …but only a HUMAN keystroke lowers the D5 guard. A console frame that is
    // pure terminal auto-response (a focus event, a resize's cursor report)
    // answered a query the CLI made, not the dialog on screen.
    if (isTerminalAutoResponse(data)) return;
    this.clearDialogPending('input');
  }

  /**
   * Type a line of human input and submit it, the way a person at the
   * keyboard would: write the text, then send a standalone CR (`\r`) in its
   * own write on the next tick.
   *
   * The two-step write is the crux. Claude Code's Ink TUI groups a single
   * multi-byte chunk (`text` + trailing CR) as a *paste* and treats the
   * embedded CR as a literal newline inside the prompt buffer rather than an
   * Enter keypress — so the line is typed but never fires, which is exactly
   * why composer SEND left text sitting in the prompt until the human hit
   * Enter manually. Sending the CR alone, after the PTY has drained the
   * text, makes Ink parse it as a real submit. Note also that Enter in a PTY
   * is CR (`\r`, 0x0D), never LF (`\n`); appending `\n` never submitted.
   *
   * Same submit dance as `notifySignal`, minus the leading CR / wake-up
   * semantics: this is direct human composer input.
   */
  submitInput(text: string): void {
    if (!this.agent) return;
    // We own the submit, so strip any trailing newlines a caller appended.
    const trimmed = text.replace(/[\r\n]+$/, '');
    // Providers whose TUI is not Ink parse a single chunk with a trailing CR
    // as a submit, so the dance is pure latency for them: one write.
    const dance = this.provider.capabilities.inkSubmitDance;
    const body = dance ? trimmed : `${trimmed}\r`;
    try {
      this.agent.write(body);
      this._appendLog(body);
    } catch (err) {
      log.error({
        event: 'submitInput.write_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // D5 — a human just answered whatever was on screen. Same argument as
    // `writeInput`, and it has to be after the write succeeded: a refused write
    // answered nothing.
    this.clearDialogPending('input');
    if (!dance) return;
    setTimeout(() => {
      if (!this.agent) return;
      try {
        this.agent.write('\r');
        this._appendLog('\r');
      } catch (err) {
        log.error({
          event: 'submitInput.submit_failed',
          sessionId: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 150);
  }

  /**
   * Inject a short, single-line signal into the PTY (Phase 3 mailbox).
   *
   * Two-step write: the text first, then a `\r` ~150 ms later. Claude
   * Code's Ink TUI groups a single multi-byte chunk as a paste and treats
   * embedded `\r` as a newline inside the buffer rather than a submit —
   * so a one-shot `text\r` lands in the prompt without firing. By sending
   * the trailing CR in its own write after the PTY has drained, Ink parses
   * it as a standalone Enter keypress and submits.
   *
   * No LEADING CR for Ink providers: since Claude Code 2.1.277 a CR not
   * followed by LF inside the prompt counts as an "invisible character" —
   * the TUI strips it and CANCELS the submit ("review and press Enter to
   * send"), leaving the signal typed but never sent
   * (docs/correctif-signal-cr-invisible.md).
   *
   * Best-effort: if the agent has exited or the write throws, we swallow
   * and log; the mailbox push is the source of truth, the signal is just
   * a wake-up hint.
   *
   * Also written to the session log so a human attaching after the fact
   * can see why the agent suddenly checked its inbox.
   */
  notifySignal(text: string): void {
    // Providers without an Ink TUI submit fine from a single chunk, so they
    // get `\r<text>\r` in one write instead of the two-step cadence.
    // Ink providers get no leading CR (see the JSDoc above).
    const dance = this.provider.capabilities.inkSubmitDance;
    const intro = dance ? text : `\r${text}\r`;
    if (!this.agent) {
      // skipSpawn / no-process sessions still get the signal in their log
      // for testability.
      this._appendLog(dance ? `${intro}\r` : intro);
      return;
    }
    try {
      this.agent.write(intro);
    } catch (err) {
      log.error({
        event: 'notifySignal.write_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this._appendLog(intro);
    if (!dance) return;
    // docs/auto-compact.md §3.2 — from here until the CR below lands, the
    // prompt buffer holds a half-typed line. `_scheduleContextReset` and
    // `_scheduleNotice` back off on this flag exactly as they do on
    // `_noticeFiring`, and `signalInbox` refuses outright: two signals 50 ms
    // apart used to interleave into `text1 text2 CR CR` and submit one garbled
    // line. Never raised for a provider without the Ink dance — there is a
    // single write and no window to protect.
    this._signalFiring = true;
    // Submit on the next tick so the TUI sees a standalone CR keypress
    // instead of a pasted chunk. We do NOT bump lastActivityAt here: the
    // signal is server-injected, not agent-produced output, so it must
    // not extend the busy window.
    setTimeout(() => {
      this._signalFiring = false;
      if (!this.agent) return;
      try {
        this.agent.write('\r');
        this._appendLog('\r');
      } catch (err) {
        log.error({
          event: 'notifySignal.submit_failed',
          sessionId: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, SIGNAL_WRITE_WINDOW_MS);
  }

  /**
   * Type the mailbox wake-up signal — THE single gate every server-side inbox
   * nudge goes through (docs/auto-compact.md §3.2).
   *
   * Six call sites used to type `SIGNAL_TEXT` straight into the PTY
   * (`messaging.injectSignal`, two in `Orchestrator`, `Spawner.notifyLead`,
   * `skills/activation`, `mailbox-persistence`), one of them with a LITERAL
   * copy of the string, and not one of them checked whether the line was
   * already taken. Returns `false` WITHOUT writing when it is:
   *
   *  - `dialogPending` — the text would answer a permission dialog (D5);
   *  - `_contextResetFiring` — a `/compact` is half-typed in the buffer;
   *  - `_noticeFiring` — an operator notice is half-typed in the buffer;
   *  - `_signalFiring` — another signal is half-typed in the buffer.
   *
   * A `false` is not an error and callers treat it as one of two things: the
   * mailbox row is the source of truth, and the idle boundary re-signals it as
   * soon as the line is free, because the message's `ts` is newer than the
   * stamp this method sets.
   */
  signalInbox(): boolean {
    if (this._injectionRefused()) return false;
    this.notifySignal(SIGNAL_TEXT);
    this._lastInboxSignalAt = Date.now();
    return true;
  }

  /**
   * The line is not free for a server-side injection right now — the four
   * refusals documented on `signalInbox`, shared with `signalPostCompact` so
   * the two gates can never drift apart.
   */
  private _injectionRefused(): boolean {
    if (this.dialogPending) return true;
    return this._contextResetFiring || this._noticeFiring || this._signalFiring;
  }

  /**
   * docs/auto-compact.md §8.1 (D9) — is a "resume" line owed to this agent?
   *
   * True from the moment a server-fired `/compact` reached the PTY until
   * `signalPostCompact` types the line (or a `/clear` fires in between). Always
   * `false` when the Session was built without `continueAfterCompact`.
   */
  get postCompactNudgeOwed(): boolean {
    return this._postCompactNudgeOwed;
  }

  /**
   * docs/auto-compact.md §8.1 (D9) — type the post-compact nudge, once.
   *
   * Called by the idle-boundary handler at the first free boundary after the
   * `/compact` was submitted, i.e. when the compaction is over: the TUI redraws
   * its spinner for the whole model call, and the PTY only stays quiet for
   * `idleThresholdMs` once it has finished.
   *
   * `inbox: true` types `POST_COMPACT_NUDGE_WITH_INBOX_TEXT` instead — the
   * nudge and the unchanged inbox signal in ONE line — and stamps
   * `lastInboxSignalAt` exactly as `signalInbox` would, so the same messages
   * are not signalled a second time at the next boundary (at most one nudge
   * per message, D2 step 1).
   *
   * Same gate and same path as `signalInbox`, deliberately: `notifySignal` is
   * what makes an injection provider-agnostic (Ink two-step write with NO
   * leading `\r` for claude/codex/gemini — Claude Code ≥ 2.1.277 cancels a
   * submit whose buffer holds a bare CR, docs/correctif-signal-cr-invisible.md
   * — and a single `\r…\r` write for opencode), and its `_signalFiring`
   * window keeps a reset or a notice from typing into the half-written line.
   *
   * Returns `false` WITHOUT writing and WITHOUT consuming the owed nudge when
   * nothing is owed or the line is taken (a dialog on screen, another
   * injection half-typed): the boundary handler falls through to its usual
   * steps and the nudge goes out at a later boundary.
   */
  signalPostCompact(opts: { inbox: boolean }): boolean {
    if (!this._postCompactNudgeOwed) return false;
    if (this._injectionRefused()) return false;
    this._postCompactNudgeOwed = false;
    // Console line FIRST: `notifySignal` logs the typed text without a newline
    // (its CR follows 150 ms later), so a server line appended after it would
    // be glued onto the injected text in the operator's console.
    this._appendLog(
      `[swarm-os] compaction over — nudging the agent to resume${opts.inbox ? ' (+ inbox signal)' : ''}\n`,
    );
    this.notifySignal(opts.inbox ? POST_COMPACT_NUDGE_WITH_INBOX_TEXT : POST_COMPACT_NUDGE_TEXT);
    if (opts.inbox) this._lastInboxSignalAt = Date.now();
    return true;
  }

  /**
   * Epoch ms of the last signal `signalInbox` actually wrote, or `null` when
   * none has been written since the last context reset. See `_lastInboxSignalAt`.
   */
  get lastInboxSignalAt(): number | null {
    return this._lastInboxSignalAt;
  }

  /**
   * docs/auto-compact.md D5 — is a dialog waiting for a human right now?
   *
   * Reading it is where the staleness check lives, deliberately: a flag that
   * nobody consults is a flag that is hurting nobody, and a lazy check costs no
   * timer on a fleet of hundreds of sessions.
   */
  get dialogPending(): boolean {
    const pending = this._dialogPending;
    if (pending === null) return false;
    const ageMs = Date.now() - pending.at;
    if (ageMs >= DIALOG_PENDING_STALE_MS && !this._dialogPendingStaleWarned) {
      this._dialogPendingStaleWarned = true;
      // Never auto-lowered — see `DIALOG_PENDING_STALE_MS`. This line is the
      // only thing that tells an operator why an agent has stopped receiving
      // mail signals, resets and notices.
      log.warn({
        event: 'session.dialog_pending_stale',
        sessionId: this.id,
        notificationType: pending.type,
        ageMs,
      });
    }
    return true;
  }

  /**
   * The notification type that raised the dialog flag, or `null`. Carried into
   * `session.auto_compact_skipped { reason: 'blocked' }` so the refusal names
   * the dialog instead of leaving an operator guessing.
   */
  get dialogPendingType(): string | null {
    return this._dialogPending?.type ?? null;
  }

  /**
   * Raise the dialog guard (D5). Called from `http/routes/hooks.ts` for every
   * `Notification` whose `notification_type` means "a dialog is waiting", and
   * for an unknown type on a session whose permission mode can show one.
   *
   * Re-raising with a new type re-stamps the age, which is right: a second
   * dialog is a second wait, and the staleness warning should describe the one
   * that is actually on screen.
   */
  markDialogPending(notificationType: string): void {
    this._dialogPending = { type: notificationType, at: Date.now() };
    this._dialogPendingStaleWarned = false;
    log.info({ event: 'session.dialog_pending', sessionId: this.id, notificationType });
  }

  /**
   * Lower the dialog guard — the ONE clearing path (D5).
   *
   * `'input'`      a human typed (`writeInput` / `submitInput`). The only proof
   *                we ever get for a permission prompt, which the CLI does not
   *                report the end of.
   * `'elicitation'` the CLI itself said the dialog is over
   *                (`elicitation_complete` / `elicitation_response`). This is
   *                what rescues an MCP elicitation that was cancelled on a
   *                timeout: nobody typed, so without this notification the flag
   *                would sit there for the rest of the session's life.
   *
   * Whatever the source, clearing RE-ARMS the three things the flag was holding
   * back. They are all "one timer at a time, sized to the remaining idle gap"
   * and each is a no-op when it has nothing pending, so calling all three
   * unconditionally is cheaper than asking which of them was held.
   */
  clearDialogPending(source: 'input' | 'elicitation'): void {
    // RE-BASE THE SILENCE CLOCK. `_idleSince` only moves on PTY bytes, so a
    // dialog that sat on screen for ten minutes leaves it ten minutes old — and
    // the three timers armed at the bottom of this method would then wake after
    // 1 ms, pass their idle check, and write BEFORE the CLI has rendered
    // anything at all.
    //
    // The failure that costs real work: an operator answering a free-text
    // prompt (AskUserQuestion "Other", an elicitation form) types the first
    // character, `writeInput` lands here, and a millisecond later the idle
    // boundary types `[swarm-os] new message…` INTO that half-typed answer,
    // then submits the mix with its trailing CR. (The signal no longer carries
    // a leading `\r` — docs/correctif-signal-cr-invisible.md — so it does not
    // submit the answer first any more, but it still lands inside it.) A held
    // `/compact` fires the same way.
    // Re-basing makes all three wait a full `idleThresholdMs` of REAL silence
    // after the keystroke, which is the same rule every other injection obeys.
    //
    // Only here and in `resume()`: the other arm sites (spawn,
    // `_resolveNotice`, the provider-without-reset branch) act on an agent that
    // genuinely IS idle, and re-basing there would just delay a free boundary.
    this._idleSince = Date.now();
    const had = this._dialogPending;
    this._dialogPending = null;
    this._dialogPendingStaleWarned = false;
    if (had !== null) {
      log.info({
        event: 'session.dialog_cleared',
        sessionId: this.id,
        notificationType: had.type,
        source,
        heldMs: Date.now() - had.at,
      });
    }
    // D1 — an arm site with no PTY byte behind it: without this reset the timer
    // below would fire into a callback that returns immediately.
    this._idleNotified = false;
    this._scheduleIdleCheck();
    this._scheduleContextReset();
    this._scheduleNotice();
  }

  /**
   * docs/auto-compact.md D4 — declare the cached occupancy no longer descriptive
   * of the live context.
   *
   * Called by `http/routes/hooks.ts` when a `SessionStart` arrives with
   * `source` ∈ `{compact, clear}`, i.e. for the compactions the server did NOT
   * arm: Claude Code's own internal auto-compact (which fires mid-turn, behind
   * our back) and a `/compact` an operator typed in the console. Without it,
   * the premise the auto-compact decision rests on — "the context only grows
   * between two resets" — is false, and a snapshot inherited from before such a
   * compaction would arm a redundant `/compact` on a context that is already
   * fresh. For a reset the server DID arm this is a harmless second bump.
   */
  markContextStale(): void {
    this._contextUsage?.markStale();
  }

  /**
   * docs/auto-compact.md D3 — the smallest occupancy measured since this
   * session's last context reset, in tokens, or `null`. Read by the auto-compact
   * decision as the base of its 10-point hysteresis.
   */
  get contextFloorTokens(): number | null {
    return this._contextUsage?.floorTokens ?? null;
  }

  /**
   * Append one server-authored line to the session log (and therefore to the
   * console an operator can attach to).
   *
   * The same channel `requestContextReset` and `armNotice` write their own
   * `[swarm-os] …` lines on, exposed because a decision taken OUTSIDE this class
   * — the auto-compact arming, which lives in the Orchestrator — has to be
   * visible in the same place. Nothing is written to the PTY: this is a log
   * line, not an injection.
   */
  appendServerLogLine(text: string): void {
    this._appendLog(text.endsWith('\n') ? text : `${text}\n`);
  }

  /**
   * Does this session's provider actually have `cmd`?
   *
   * `_fireContextReset` already handles a provider without one — it resolves
   * the armed reset by writing nothing (better than a half-working reset). But
   * that answer only comes at the next idle boundary and only reaches a log
   * line, which is invisible to an operator who just pressed COMPACT. Ask
   * BEFORE arming to refuse loudly instead (`PROVIDER_NO_RESET`, 409).
   *
   * Deliberately asked WITHOUT `instructions`: they only steer a `/compact`
   * summary, so support must not hinge on text the caller may not have typed.
   */
  supportsContextReset(cmd: ContextResetCommand): boolean {
    return this.provider.contextResetLine(cmd) !== null;
  }

  /**
   * Arm a context-reset (`/clear` or `/compact`) to fire at the next task
   * boundary. We never inject mid-turn: the command is held until the PTY has
   * been quiet for `idleMs` (the same idle window the mailbox uses), so it
   * lands on an idle prompt instead of garbling the agent's current output.
   *
   * `/clear` wipes the conversation but the role/preamble survives because it
   * lives in the system prompt (`--append-system-prompt`). `/compact`
   * summarizes and continues — pass `instructions` to steer the summary.
   *
   * Idempotent: if a reset is already armed, this is a no-op and returns
   * `false` (the first request wins). Returns `false` too when there is no
   * live PTY or the session is terminating.
   */
  requestContextReset(
    cmd: ContextResetCommand,
    opts: { idleMs: number; instructions?: string },
  ): boolean {
    // Both halves of the occupancy: the armed slot AND the 250 ms two-step
    // write window after `_fireContextReset` nulls it (cf. `_contextResetFiring`).
    if (this._pendingContextReset || this._contextResetFiring) return false;
    if (!this.agent) return false;
    if (this._status !== 'running' && this._status !== 'waiting') return false;
    // "…or the session is terminating", as the JSDoc above promises. `stop()`
    // leaves the status at `running` for the whole SIGTERM grace window, so the
    // status check alone would arm a reset onto a PTY that is being torn down —
    // and the idle boundary the command waits for is precisely the silence of a
    // process on its way out.
    if (this._stopRequested) return false;
    this._pendingContextReset = {
      cmd,
      instructions: opts.instructions,
      idleMs: Math.max(0, opts.idleMs),
    };
    // One "held — dialog pending" line per ARMED reset, not per re-check.
    this._contextResetHeldLogged = false;
    this._appendLog(
      `[swarm-os] context ${cmd} armed — will fire once idle for ${opts.idleMs}ms\n`,
    );
    log.info({ event: 'session.context_reset_armed', sessionId: this.id, cmd });
    this._scheduleContextReset();
    return true;
  }

  /**
   * (Re)arm the deferred fire. The PTY data handler resets `_idleSince` on
   * every byte, so we sleep for whatever idle time remains and re-check on
   * wake — if the agent spoke in the meantime we sleep again. No tight poll:
   * one timer at a time, sized to the remaining idle gap.
   *
   * `minWaitMs` (update_system D.5) is a floor used solely by the contention
   * backoff below; it defaults to 0, so the timing of every pre-existing
   * caller is byte-for-byte what it was.
   */
  private _scheduleContextReset(minWaitMs = 0): void {
    const pending = this._pendingContextReset;
    if (!pending) return;
    if (this._pendingContextTimer) clearTimeout(this._pendingContextTimer);
    const elapsed = Date.now() - this._idleSince;
    const wait = Math.max(1, minWaitMs, pending.idleMs - elapsed);
    this._pendingContextTimer = setTimeout(() => {
      this._pendingContextTimer = null;
      if (!this._pendingContextReset) return;
      // Still busy (the agent produced output within the idle window)? Wait again.
      if (Date.now() - this._idleSince < this._pendingContextReset.idleMs) {
        this._scheduleContextReset();
        return;
      }
      // docs/auto-compact.md D5 — two states in which a reset must be HELD,
      // not fired and not re-armed:
      //
      //  `dialogPending` a permission / elicitation dialog is on screen. The
      //                  `\r` that submits `/compact` would validate the
      //                  highlighted option of that dialog instead. Covers every
      //                  source of a reset at once — `team.context_compact`,
      //                  `team.clear_worker`, the operator's COMPACT button and
      //                  both env backstops all land here.
      //  `paused`        the process is SIGSTOP'd and cannot read its tty. This
      //                  is a pre-existing defect repaired in passing: a reset
      //                  armed before `pause()` used to be written into the
      //                  frozen PTY, arrive as one glued chunk at SIGCONT and
      //                  never submit — while `markStale`/`recordReset` had
      //                  already run, so the gauge reported a compaction that
      //                  never happened.
      //
      // No re-arm on purpose: `clearDialogPending` (a human keystroke, or the
      // CLI reporting the dialog closed) and `resume()` both re-arm, so the
      // reset resumes the instant the obstacle is gone instead of spinning a
      // timer against it.
      if (this.dialogPending || this._status === 'paused') {
        if (this.dialogPending && !this._contextResetHeldLogged) {
          this._contextResetHeldLogged = true;
          // Without this line "held" and "crashed" are indistinguishable from
          // the COMPACT button, which answered `scheduled` and keeps its badge.
          this._appendLog(
            `[swarm-os] context ${this._pendingContextReset.cmd} held — dialog pending\n`,
          );
        }
        return;
      }
      // D.5 ordering guard, reset side. An operator notice fires on the SAME
      // idle boundary and writes to the SAME prompt buffer; if its two-step
      // write is in flight, back off rather than garble both. This branch is
      // unreachable unless someone called `armNotice` — sessions that never
      // use the new API keep the exact previous behaviour.
      if (this._noticeFiring || this._contextResetFiring || this._signalFiring) {
        // `_contextResetFiring`: another reset's two-step write is mid-flight
        // (only reachable through the race the occupancy guards now close, or
        // a future caller) — firing NOW would interleave two half-typed slash
        // commands in the same prompt buffer and garble both.
        // `_signalFiring`: same window, third injector (docs/auto-compact.md
        // §3.2) — a mailbox signal's text is in the buffer and its CR has not
        // landed yet.
        this._scheduleContextReset(PTY_INJECT_CONTENTION_RETRY_MS);
        return;
      }
      this._fireContextReset();
    }, wait);
  }

  /** Inject the armed command into the PTY using the notifySignal cadence. */
  private _fireContextReset(): void {
    const pending = this._pendingContextReset;
    this._pendingContextReset = null;
    if (!pending || !this.agent) return;
    // `null` ⇒ this provider has no working context reset. Resolve without
    // writing: a half-working reset that wipes the role while leaving the
    // tools in place is worse than never resetting at all.
    const line = this.provider.contextResetLine(pending.cmd, pending.instructions);
    if (line === null) {
      log.info({
        event: 'session.context_reset_unsupported',
        sessionId: this.id,
        cmd: pending.cmd,
        provider: this.provider.id,
      });
      this._appendLog(
        `[swarm-os] context ${pending.cmd} skipped — provider ${this.provider.id} has no context reset\n`,
      );
      // D1 — nothing was written, so no PTY byte will ever re-arm the idle
      // boundary. This branch took the boundary and gave nothing back; without
      // this, an agent that stays silent would never have another one.
      this._idleNotified = false;
      this._scheduleIdleCheck();
      return;
    }
    // The reset shrinks the context, so restart the auto-compact accounting.
    this._bytesSinceReset = 0;
    // Same rule as notifySignal: a leading CR would make Claude Code ≥ 2.1.277
    // cancel the submit, leaving the slash command typed but never run.
    const intro = this.provider.capabilities.inkSubmitDance ? line : `\r${line}`;
    try {
      this.agent.write(intro);
      this._appendLog(intro);
    } catch (err) {
      log.error({
        event: 'session.context_reset_write_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // D.5: from here until the CR below lands, the prompt buffer holds a
    // half-typed slash command. `_pendingContextReset` is already null, so
    // this flag is what keeps the notice injector off the line.
    this._contextResetFiring = true;
    // Submit the command on its own tick so the slash-command menu in the Ink
    // TUI runs the highlighted entry (same trick as notifySignal). A slightly
    // longer delay than the mailbox signal gives the autocomplete menu time to
    // populate before the Enter keypress lands.
    setTimeout(() => {
      this._contextResetFiring = false;
      if (!this.agent) return;
      try {
        this.agent.write('\r');
        this._appendLog('\r');
      } catch (err) {
        log.error({
          event: 'session.context_reset_submit_failed',
          sessionId: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      log.info({ event: 'session.context_reset_fired', sessionId: this.id, cmd: pending.cmd });
      // Monitoring — the number we are serving describes the context that was
      // just thrown away. Mark it stale HERE, on the command actually reaching
      // the PTY, and never on a hook callback: a `/compact` the CLI refuses
      // ("Not enough messages to compact") fires no `SessionStart` at all
      // (spike S1d), so anything waiting on one would wait forever. The flag
      // clears by itself at the first turn read back from the transcript.
      this._contextUsage?.markStale();
      // Lot 9 — and for the same reason, the graph's COMPACT/CLEAR marker is
      // stamped HERE, on the submitted command, not when the operator asked:
      // an armed reset can wait minutes for an idle boundary, and a reset the
      // provider does not support returns above without ever writing anything.
      this._contextUsage?.recordReset(pending.cmd);
      // docs/auto-compact.md D2 step 1 — the agent's awareness of its inbox was
      // just wiped (`/clear`) or summarised (`/compact`). Dropping the stamp
      // makes the ONE idle-boundary rule ("signal when something is newer than
      // the last signal") also mean "signal again after a reset", which is
      // guarantee G. It replaces the `setTimeout(2000)` the Orchestrator used to
      // arm here: the re-signal now happens when the compaction is genuinely
      // over (the PTY goes quiet again), not when a fixed timer says so.
      this._lastInboxSignalAt = null;
      // docs/auto-compact.md §8.1 (D9) — and owe the agent a "resume" line at
      // the boundary that ends this compaction: a `/compact` hands back an
      // empty prompt, and without the nudge the work in progress never
      // resumes. ASSIGNED, not just raised: a `/clear` landing here must drop a
      // nudge still owed from an earlier `/compact` (a wiped agent is idle on
      // purpose), and two compactions in a row owe one nudge, not two.
      this._postCompactNudgeOwed = pending.cmd === '/compact' && this._continueAfterCompact;
      // Hand off to the orchestrator so it can re-wake the agent if a `/clear`
      // left undelivered mail behind (the mailbox is server-side and survives).
      try {
        this._onContextReset?.(this, pending.cmd);
      } catch (err) {
        log.warn({
          event: 'session.context_reset_callback_failed',
          sessionId: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 250);
  }

  /** True when a `/clear` or `/compact` is armed but not yet fired. */
  get hasPendingContextReset(): boolean {
    // `_pendingContextReset` is nulled at the TOP of `_fireContextReset`,
    // 250 ms before the command is actually submitted — without the firing
    // flag, that window reads as "nothing pending" and a second operator
    // request arms a duplicate reset (seen live: two `/compact` 14 ms apart
    // both answered `scheduled`).
    return this._pendingContextReset !== null || this._contextResetFiring;
  }

  // --- update_system D.5 — operator notice -------------------------------
  //
  // The requirement: before the container is recreated, every live team's
  // lead must be TOLD, in its PTY, and given time to react. The pre-existing
  // path (`broadcastToLeadsFromExternal`) is a no-op exactly when it matters:
  // it injects the wake-up signal only if the lead happens to be idle at that
  // very instant, and never retries. A lead mid-turn gets a mailbox row and
  // nothing else, forever — which is the common case, since a team worth
  // warning is a team that is working.
  //
  // `armNotice` is the retrying version: it holds the text and injects it at
  // the first real idle boundary, re-arming as long as the agent keeps
  // talking, and gives up loudly (`never_idle`) at a caller-supplied deadline
  // instead of silently waiting forever. The deadline exists because the
  // operator's action must never be vetoed by a busy agent: we proceed at the
  // deadline, we just have to be able to SAY that the lead was never reached.

  /**
   * Arm a one-shot operator notice, fired into the PTY at the next idle
   * boundary. Returns true if the notice was armed (or `false` if this
   * session cannot receive one at all).
   *
   * Injection goes through `notifySignal`, unchanged: its `text`-then-`\r`
   * cadence is structural for the Ink TUI, and it deliberately does not bump
   * `_idleSince` (a server-injected write is not agent output and must not
   * extend anyone's busy window).
   *
   * Refused (returns false) when there is no live PTY, when the session is
   * not `running`/`waiting`, or when it is `paused`: a SIGSTOP'd process
   * cannot read its tty, so the write would sit in a kernel buffer and land
   * garbled on resume — the caller should treat a refusal exactly like
   * `never_idle` (nobody was warned).
   *
   * NOT single-occupancy, unlike `requestContextReset`: a second arm
   * SUPERSEDES the first (which resolves `aborted`). This is deliberate —
   * an operator escalating from "applying in 5 minutes" to "applying now"
   * must not have the newer, more urgent text refused because the stale one
   * is still waiting for an idle boundary.
   *
   * @param text  Single line, ideally — it is typed into a prompt buffer.
   * @param opts.idleMs      PTY quiet time required before injecting.
   * @param opts.deadlineMs  Give up (report `never_idle`) after this long.
   * @param opts.id          Opaque correlation token echoed by `noticeState`.
   * @param opts.onOutcome   Fired exactly once, on resolution.
   */
  armNotice(
    text: string,
    opts: {
      idleMs: number;
      deadlineMs: number;
      id?: string;
      onOutcome?: (outcome: NoticeOutcome) => void;
    },
  ): boolean {
    if (!this.agent) return false;
    if (this._status !== 'running' && this._status !== 'waiting') return false;
    // Supersede any notice still waiting for its idle boundary.
    if (this._pendingNotice) this._resolveNotice('aborted', 'superseded');
    const idleMs = Math.max(0, opts.idleMs);
    this._pendingNotice = {
      text,
      idleMs,
      deadlineAt: Date.now() + Math.max(0, opts.deadlineMs),
      id: opts.id ?? null,
      onOutcome: opts.onOutcome ?? null,
    };
    this._noticeState = { id: opts.id ?? null, outcome: null };
    this._appendLog(
      `[swarm-os] operator notice armed — fires once idle for ${idleMs}ms, deadline ${Math.max(0, opts.deadlineMs)}ms\n`,
    );
    log.info({
      event: 'session.notice_armed',
      sessionId: this.id,
      idleMs,
      deadlineMs: Math.max(0, opts.deadlineMs),
      noticeId: opts.id ?? null,
    });
    this._scheduleNotice();
    return true;
  }

  /**
   * (Re)arm the deferred injection — same shape as `_scheduleContextReset`
   * (one timer at a time, sized to the remaining idle gap, re-checked on
   * wake), plus the deadline.
   *
   * The sleep is capped at the remaining time to the deadline so we report
   * `never_idle` ON the deadline instead of one idle-window late: an operator
   * screen counting down to zero must not be contradicted by a status that
   * only settles afterwards.
   */
  private _scheduleNotice(minWaitMs = 0): void {
    const pending = this._pendingNotice;
    if (!pending) return;
    if (this._pendingNoticeTimer) clearTimeout(this._pendingNoticeTimer);
    const now = Date.now();
    const idleGap = pending.idleMs - (now - this._idleSince);
    const untilDeadline = pending.deadlineAt - now;
    const wait = Math.max(1, Math.min(Math.max(minWaitMs, idleGap), untilDeadline));
    const timer = setTimeout(() => {
      this._pendingNoticeTimer = null;
      const p = this._pendingNotice;
      if (!p) return;
      const t = Date.now();
      // `paused` is never idle for our purposes — same rule as `isIdle` in
      // messaging.ts: the SIGSTOP'd process can't drain its tty.
      const idle = this._status !== 'paused' && t - this._idleSince >= p.idleMs;
      // Ordering guard, notice side: a `/clear` / `/compact` targets the same
      // idle boundary and the same prompt buffer. Armed-but-unfired counts as
      // busy (it will take this very boundary), and so does its in-flight
      // two-step write — and, since docs/auto-compact.md §3.2, a mailbox
      // signal's two-step write too.
      //
      // `dialogPending` (D5) is folded in here rather than given its own branch
      // because the semantics are identical: the line is not ours to type on, so
      // back off and try again until the deadline. What it must NOT do is fire
      // anyway — the notice text would answer a permission dialog — nor resolve
      // early, because the operator's deadline is the operator's to spend.
      const dialogHeld = this.dialogPending;
      const lineHeld =
        dialogHeld ||
        this._pendingContextReset !== null ||
        this._contextResetFiring ||
        this._signalFiring;
      if (idle && !lineHeld) {
        this._fireNotice();
        return;
      }
      if (t >= p.deadlineAt) {
        // Distinct reason per cause: "the agent never stopped talking", "a
        // reset owned the line" and "a human never answered a dialog" are three
        // different things for whoever reads the outcome, and only the last one
        // is fixed by someone walking over to the console.
        this._resolveNotice(
          'never_idle',
          dialogHeld
            ? 'deadline-dialog-pending'
            : lineHeld
              ? 'deadline-while-context-reset-held-the-line'
              : 'deadline-busy',
        );
        return;
      }
      this._scheduleNotice(lineHeld ? PTY_INJECT_CONTENTION_RETRY_MS : 0);
    }, wait);
    // Never hold the process open just to warn someone: shutdown paths
    // resolve the notice explicitly (stop / _handleExit).
    timer.unref?.();
    this._pendingNoticeTimer = timer;
  }

  /** Inject the armed notice via the (unmodified) `notifySignal` cadence. */
  private _fireNotice(): void {
    const pending = this._pendingNotice;
    if (!pending) return;
    if (!this.agent) {
      this._resolveNotice('aborted', 'no-agent');
      return;
    }
    // Hold the line for the whole two-step write (text now, CR at +150 ms).
    this._noticeFiring = true;
    const release = setTimeout(() => {
      this._noticeFiring = false;
    }, NOTICE_WRITE_WINDOW_MS);
    release.unref?.();
    this.notifySignal(pending.text);
    log.info({
      event: 'session.notice_fired',
      sessionId: this.id,
      noticeId: pending.id,
      idleForMs: Date.now() - this._idleSince,
    });
    this._resolveNotice('fired');
  }

  /**
   * Resolve the armed notice exactly once: clear the slot + timer, record the
   * outcome for `noticeState`, and hand it to the caller's callback. A
   * throwing callback must never take the session down with it.
   */
  private _resolveNotice(outcome: NoticeOutcome, reason?: string): void {
    const pending = this._pendingNotice;
    this._pendingNotice = null;
    if (this._pendingNoticeTimer) {
      clearTimeout(this._pendingNoticeTimer);
      this._pendingNoticeTimer = null;
    }
    // No pending notice ⇒ nothing to resolve. Crucially this also means a
    // later `stop()` cannot overwrite an already-recorded `fired`.
    if (!pending) return;
    this._noticeState = { id: pending.id, outcome };
    if (outcome !== 'fired') {
      // D1 — the notice had claimed this idle boundary (D2 step 0 declines a
      // boundary while one is armed) and is now giving it back without having
      // written anything. Nothing else would produce another: an agent that
      // emits no further PTY byte would never be evaluated again, and mail
      // queued behind a cancelled notice would never be signalled.
      this._idleNotified = false;
      this._scheduleIdleCheck();
      this._appendLog(
        `[swarm-os] operator notice NOT delivered (${outcome}${reason ? `: ${reason}` : ''})\n`,
      );
      log.warn({
        event: 'session.notice_undelivered',
        sessionId: this.id,
        noticeId: pending.id,
        outcome,
        reason: reason ?? null,
        busyForMs: Date.now() - this._idleSince,
      });
    }
    try {
      pending.onOutcome?.(outcome);
    } catch (err) {
      log.warn({
        event: 'session.notice_callback_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Drop an armed notice (operator cancelled the update). Returns true if
   * something was actually armed. Resolves it as `aborted`.
   */
  cancelNotice(): boolean {
    if (!this._pendingNotice) return false;
    this._resolveNotice('aborted', 'cancelled');
    return true;
  }

  /** True when an operator notice is armed but has not fired yet. */
  get hasPendingNotice(): boolean {
    return this._pendingNotice !== null;
  }

  /**
   * Most recent notice + its outcome (`null` outcome while still armed),
   * or `null` if this session never had one. Compare `id` against your own
   * correlation token before trusting `outcome` — a later notice replaces
   * this state wholesale.
   */
  get noticeState(): NoticeState | null {
    return this._noticeState;
  }

  // --- docs/auto-compact.md D1 — the idle boundary -----------------------
  //
  // The ONE new event this feature introduces: "this agent has just stopped
  // working". Everything else (re-signalling an inbox, deciding an
  // auto-compact, refreshing the gauge) hangs off it.
  //
  // Why PTY silence and not a provider callback. claude's `Notification` hook
  // means "blocked on a human" or "idle for 60 s" — the OPPOSITE of "free to be
  // compacted". codex and gemini have turn-complete callbacks, but gemini has no
  // context tracker at all and opencode calls nothing back. A claude `Stop` hook
  // would be claude-only and would touch the production-critical hook shell
  // chain. PTY silence is the only signal all four providers share, and it is
  // already the definition of "idle" for the mailbox, for context resets and for
  // operator notices — every TUI redraws a spinner while a turn runs, so 2 s of
  // silence is a prompt on screen.

  /**
   * (Re)arm the idle check. Same shape as `_scheduleContextReset`: ONE timer at
   * a time, sized to the idle time that remains, re-checked on wake.
   *
   * The `_idleTimer` early return is the load-bearing part. This is called from
   * the PTY data handler, i.e. potentially thousands of times a minute; a
   * clear+set per chunk would churn a timer per byte burst for no benefit,
   * because the callback already re-arms itself when it wakes up too early.
   */
  private _scheduleIdleCheck(): void {
    if (this._onIdle === null) return;
    // A terminal session has no boundary worth arming, and two arm sites fire
    // AFTER the end: `_handleExit` clears this timer and then calls
    // `_resolveNotice('aborted')`, which re-arms it; and a hook
    // (`elicitation_response`) can land on a session that died a second ago.
    if (this._isTerminal()) return;
    // Already consumed for this period of silence — the next PTY byte (or an
    // explicit arm site) lowers the flag.
    if (this._idleNotified) return;
    if (this._idleTimer !== null) return;
    const wait = Math.max(1, this._idleThresholdMs - (Date.now() - this._idleSince));
    const timer = setTimeout(() => {
      this._idleTimer = null;
      this._fireIdleBoundary();
    }, wait);
    // Never hold the process open for a boundary: shutdown paths clear it, and
    // an agent that is about to die has no boundary worth waiting for.
    timer.unref?.();
    this._idleTimer = timer;
  }

  /**
   * D2 step 0 — decide whether THIS moment of silence is a boundary the
   * Orchestrator may act on, then hand it over exactly once.
   *
   * The four exclusions live here, in the Session, for two reasons: they are
   * all Session state, and a boundary they decline must NOT be marked consumed.
   * A declined boundary comes back on its own — through the echo of the reset
   * that took it, through the keystroke that closes the dialog, or through
   * `_resolveNotice`. If we set `_idleNotified` here, the agent would have to
   * speak again to ever get another one, which for an idle agent means never.
   */
  private _fireIdleBoundary(): void {
    const onIdle = this._onIdle;
    if (onIdle === null) return;
    if (this._idleNotified) return;
    // The agent spoke while we slept: sleep out the remaining gap instead of
    // polling. Same re-arm loop as the reset and notice timers.
    if (Date.now() - this._idleSince < this._idleThresholdMs) {
      this._scheduleIdleCheck();
      return;
    }
    // `paused` is never idle (`messaging.isIdle`): a SIGSTOP'd process cannot
    // drain its tty. `starting` has no prompt yet, and the terminal states have
    // no PTY at all. `resume()` re-arms for the paused case.
    if (this._status !== 'running' && this._status !== 'waiting') return;
    // A stop is in flight. The status stays `running` for the whole SIGTERM
    // grace window, so without this the quiet of a dying process reads as a
    // task boundary and the handler signals an inbox nobody will ever drain,
    // or arms a `/compact` on a PTY that is closing.
    if (this._stopRequested) return;
    // D5 — a dialog is on screen. Not a free boundary: everything the handler
    // would do ends in a write.
    if (this.dialogPending) return;
    // A reset owns this boundary (armed, or mid two-step write). The two timers
    // expire at the same instant by construction — both are `_idleSince +
    // idleMs` — so this is the common case, not a corner one, and the reset
    // wins: it was armed first and it is the thing that changes the context the
    // handler is about to reason about.
    if (this.hasPendingContextReset) return;
    // Same for an armed operator notice: it is about to take this boundary.
    if (this.hasPendingNotice) return;
    this._idleNotified = true;
    try {
      onIdle(this);
    } catch (err) {
      // The handler is the Orchestrator's; a bug in it may not take an agent
      // down, and must not leave the boundary un-consumed either (that would
      // re-enter the same bug on the next byte).
      log.warn({
        event: 'session.idle_callback_failed',
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Byte-based auto-compact backstop. Fires at most once per accumulation
   * window: we leave `_bytesSinceReset` untouched here (it is zeroed when the
   * reset actually fires) but the `_pendingContextReset` guard inside
   * `requestContextReset` prevents re-arming while one is queued. Logged at
   * WARN so an operator can see the backstop engaging (no silent caps).
   */
  private _maybeAutoCompact(): void {
    if (this._autoCompactBytes <= 0) return;
    if (this._bytesSinceReset < this._autoCompactBytes) return;
    if (this._pendingContextReset) return;
    log.warn({
      event: 'session.auto_compact_triggered',
      sessionId: this.id,
      bytesSinceReset: this._bytesSinceReset,
      threshold: this._autoCompactBytes,
    });
    this.requestContextReset('/compact', { idleMs: this._idleThresholdMs });
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
    // D.5 — the PTY this notice was waiting for is about to die. Resolve it
    // now (as a non-delivery) so the caller's callback fires while the
    // process is still around to report it, and so the timer is cleared even
    // if the exit event never arrives.
    this._resolveNotice('aborted', `session-stopped:${reason}`);
    this._stopReason ??= reason;
    // Mark the intent so _handleExit knows this was a user-requested stop,
    // not a crash/natural exit.
    this._stopRequested = true;
    if (!this.agent) {
      this._setStatus('killed');
      this._endedAt ??= new Date().toISOString();
      // `_handleExit` will never run on this path — there is no process to
      // exit — so the idle timer has to be released here or it outlives the
      // session (it is `unref`'d, so it would not hold the process up, but it
      // would still call back into a dead session).
      this._clearIdleTimer();
      // Terminal state with no process: `_handleExit` will never run, so this is
      // the ONLY place this session's on-disk artifacts can be reclaimed. Same
      // three steps as `_handleExit`, same order (MCP block first — for a
      // provider that merged it into a file inside the config dir, removing the
      // directory first would make the MCP cleanup log a spurious failure).
      this._cleanupMcpConfig();
      this._cleanupRemoteEnvFile();
      this._cleanupSessionConfig();
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
    // Re-base the silence clock, same argument as `clearDialogPending`: a
    // process SIGSTOP'd mid-turn has an `_idleSince` as old as the pause, so
    // the timers below would fire at +1 ms — before the woken CLI has emitted
    // the first byte of the turn it was frozen in the middle of.
    this._idleSince = Date.now();
    // D1 — a resumed agent whose PTY stays silent would otherwise never be
    // evaluated again: no byte, no boundary. It is evaluated at THIS boundary,
    // then at the end of its next turn.
    this._idleNotified = false;
    this._scheduleIdleCheck();
    // D5 — a reset parked by `_scheduleContextReset` while the process was
    // SIGSTOP'd is not re-armed by anything else. Same for one that was simply
    // waiting: its timer was consumed by the hold.
    this._scheduleContextReset();
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
    // PHASE B.1 — write the per-session MCP config BEFORE spawning so the
    // agent sees a valid file at startup. We do it in skipSpawn mode too:
    // Phase 2's MCP-direct test path needs the file on disk to read the URL
    // even when the CLI itself isn't launched. This runs into the ALREADY
    // OPEN session log — moving it after the `skipSpawn` early return would
    // silently drop the `mcp.json written at …` line.
    try {
      const result = this.provider.writeMcpConfig({
        runtimeDir: this.mcpRuntimeDir,
        orchestratorId: this.orchestratorId,
        sessionId: this.id,
        sessionSecret: this.sessionSecret,
        mcpHost: init.mcpHost,
        mcpPort: init.mcpPort,
        configDir: this._sessionConfigDir,
        paths: this._paths,
      });
      this.mcpConfigPath = result?.path ?? null;
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
        `[swarm-os] skipSpawn=true — no ${this.provider.id} subprocess started (cwd=${this.cwd})\n`,
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
      } else {
        // PHASE B.2 — pure argv + env from the adapter. Every container path
        // it references (config dir, mcp config) went through `this._paths`,
        // so what comes back is already agent-resolvable. What remains here
        // is a purely TRANSPORT-level branch.
        const spawn = this.provider.buildSpawn({
          model: this.model,
          effort: this.effort,
          permissionMode: this.permissionMode,
          initialPrompt: this.initialPrompt,
          preamble: init.preamble,
          resumeNotice: this.resumeNotice,
          cwd: this.cwd,
          configDir: this._sessionConfigDir,
          mcpConfigPath: this.mcpConfigPath,
          paths: this._paths,
        });
        // cwd is validated against workspaceRoot at API ingress (so always
        // starts with `<workspaceRoot>/` or equals it).
        const agentCwd = this._paths.workspace(this.cwd);
        if (this.sshTransport) {
          const t = this.sshTransport;
          // `secretEnv` must NOT reach the remote command line: `ps` on the host
          // is world-readable. Write it to a 0600 file the remote shell sources
          // instead. Providers that declare no secret get `null` here and the
          // emitted command is byte for byte the historical one.
          const envFile = this._writeSecretEnvFile(spawn.secretEnv);
          agent = new SshAgentProcess({
            sshTarget: t.sshTarget,
            sshKey: t.sshKey,
            sshPort: t.sshPort,
            remoteCwd: agentCwd,
            remoteEnv: spawn.env,
            ...(envFile ? { remoteEnvFile: this._paths.data(envFile) } : {}),
            remoteCommand: spawn.command,
            args: spawn.args,
            // The remote agent reads an MCP url pointing at
            // `http://127.0.0.1:<mcpPort>`. The container's MCP listens on
            // loopback only (plan §14), so set up an SSH reverse tunnel so
            // the host's 127.0.0.1:mcpPort routes back into the container's
            // namespace. Skipped when mcp isn't wired (mcpPort=0 / tests).
            reverseTunnelPort: init.mcpPort > 0 ? init.mcpPort : 0,
          });
        } else {
          agent = new PtyAgentProcess({
            command: spawn.command,
            args: spawn.args,
            cwd: agentCwd,
            // Local transport has no command line to leak through: the child's
            // environment is only readable by the same uid (and root), which is
            // exactly where we already are. So the two env buckets merge, and no
            // file is written at all.
            env: { ...spawn.env, ...(spawn.secretEnv ?? {}) },
          });
        }
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._setStatus('failed');
      this._endedAt = new Date().toISOString();
      this._appendLog(
        `[swarm-os] failed to spawn ${this.provider.id}: ${this._lastError}\n`,
      );
      this._cleanupMcpConfig();
      // A failed spawn is still a session that reached a terminal state, so its
      // on-disk artifacts must go the same way they do on a normal exit.
      // Previously only the MCP config was removed here, which left a partial
      // per-session config dir behind FOREVER (`_handleExit` never runs — there
      // is no process to exit). For codex/gemini that directory holds credential
      // symlinks and the session's MCP url; for opencode, four XDG roots.
      this._cleanupRemoteEnvFile();
      this._cleanupSessionConfig();
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

    // D1 — the spawn is an arm site without a PTY byte behind it: the agent may
    // print nothing at all (a CLI that boots straight to a prompt on a resumed
    // session), and without this it would have no first boundary.
    this._idleNotified = false;
    this._scheduleIdleCheck();

    this._agentDataDisp = agent.onData((d) => {
      this._lastActivityAt = new Date().toISOString();
      this._idleSince = Date.now();
      // D1 — the agent is talking: this period of silence is over, and a new
      // boundary is owed at the end of the burst. `_scheduleIdleCheck` is a
      // no-op while a timer is already armed, so this costs one comparison per
      // chunk and never a timer churn.
      this._idleNotified = false;
      this._scheduleIdleCheck();
      this._appendLog(d);
      // Context-management backstop: track output volume since the last reset
      // and auto-arm a /compact once it crosses the configured threshold.
      if (this._autoCompactBytes > 0) {
        this._bytesSinceReset += Buffer.byteLength(d, 'utf8');
        this._maybeAutoCompact();
      }
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
    this._cleanupRemoteEnvFile();
    this._cleanupSessionConfig();
    // Clear the SIGKILL grace timer if it's still armed.
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    // Drop any armed context-reset — the PTY it targeted is gone.
    if (this._pendingContextTimer) {
      clearTimeout(this._pendingContextTimer);
      this._pendingContextTimer = null;
    }
    this._pendingContextReset = null;
    this._contextResetFiring = false;
    // D1 — the PTY whose silence it was measuring is gone.
    this._clearIdleTimer();
    // Same for an armed operator notice (D.5). No-op when it already fired —
    // `_resolveNotice` returns early on an empty slot, so a `fired` outcome
    // recorded moments ago survives the exit and stays reportable.
    this._resolveNotice('aborted', 'session-exited');
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

  /** True once this session has reached a state it can never leave. */
  private _isTerminal(): boolean {
    return (
      this._status === 'exited' ||
      this._status === 'killed' ||
      this._status === 'failed' ||
      this._status === 'interrupted'
    );
  }

  /** D1 — release the idle timer (exit, or a stop with no process). */
  private _clearIdleTimer(): void {
    if (this._idleTimer === null) return;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
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

  /**
   * Materialise `PreparedSpawn.secretEnv` as a 0600 file of `K='v'` lines for
   * the remote shell to source. Returns the CONTAINER path (the caller maps it
   * for the host), or `null` when there is nothing to write.
   *
   * Why a file and not `env K=V` on the remote command line: that line is
   * visible to every user on the host through `ps`. The same exposure exists
   * today for the PROMPT text (`agent-process.ts` puts the whole positional argv
   * there) — that is plan Risk 7, tracked separately; this fixes the credentials.
   *
   * Where: the provider's own per-session config dir when it has one, so the
   * file dies with the directory the adapter already asked us to delete
   * (`cleanupPaths`). Otherwise the per-session MCP dir, which is under `dataDir`
   * in SSH mode for exactly the same reason (it must have a host-side path).
   *
   * Never throws: a failure here degrades to "no secret env" — the agent then
   * fails on its own missing credential with a message in its log, which is
   * strictly better than a session that never starts.
   */
  private _writeSecretEnvFile(secretEnv: Record<string, string> | undefined): string | null {
    if (!secretEnv) return null;
    const entries = Object.entries(secretEnv);
    if (entries.length === 0) return null;
    const lines: string[] = [];
    for (const [k, v] of entries) {
      // The file is SOURCED by the remote shell: a key it cannot parse as an
      // identifier would abort the whole `. <file>` and take the spawn with it.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        log.warn({
          event: 'session.secret_env_key_rejected',
          sessionId: this.id,
          provider: this.provider.id,
          key: k,
        });
        continue;
      }
      lines.push(`${k}=${shellQuote(v)}`);
    }
    if (lines.length === 0) return null;
    const dir =
      this._sessionConfigDir ??
      sessionDirFor(this.mcpRuntimeDir, this.orchestratorId, this.id);
    const file = path.join(dir, SECRET_ENV_FILENAME);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Replace rather than write through: a stale symlink at this path would
      // send the secrets wherever it points.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* nothing to remove */
      }
      const fd = fs.openSync(file, 'w', 0o600);
      try {
        fs.writeSync(fd, `${lines.join('\n')}\n`);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best-effort */
      }
      this._remoteEnvFile = file;
      log.info({
        event: 'session.secret_env_written',
        sessionId: this.id,
        provider: this.provider.id,
        // Names only. NEVER the values — that is the whole point of the file.
        keys: lines.length,
      });
      return file;
    } catch (err) {
      log.error({
        event: 'session.secret_env_write_failed',
        sessionId: this.id,
        provider: this.provider.id,
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Delete the sourced env file. Called on every exit path — including a failed
   * spawn, where the file exists but no process ever read it. Best-effort and
   * idempotent; the provider's `cleanupPaths` usually removes the whole directory
   * moments later, but a credential file must not depend on that.
   */
  private _cleanupRemoteEnvFile(): void {
    const file = this._remoteEnvFile;
    if (!file) return;
    this._remoteEnvFile = null;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      log.warn({
        event: 'session.secret_env_cleanup_failed',
        sessionId: this.id,
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Hand the MCP teardown back to the provider.
   *
   * ⚠️ The call is NOT gated on `mcpConfigPath`, and that is a fix, not an
   * oversight. `writeMcpConfig` returns `null` for every INLINE-config provider
   * (opencode is the first: its whole config, MCP url included, travels in
   * `OPENCODE_CONFIG_CONTENT` and never touches disk), so `mcpConfigPath` is
   * permanently null for them — an early return here meant such a provider never
   * received `removeMcpConfig` at all and had to sweep its own per-session state
   * on a later spawn. `removeMcpConfig` is specified to be idempotent and to
   * never throw, so calling it unconditionally is safe; every built-in adapter
   * already early-returns when it has nothing to undo.
   *
   * Idempotent on our side too: `_handleExit` and the failed-spawn path both call
   * it, and a second call is a no-op for the adapters.
   */
  private _cleanupMcpConfig(): void {
    this.provider.removeMcpConfig({
      runtimeDir: this.mcpRuntimeDir,
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
      configDir: this._sessionConfigDir,
    });
    this.mcpConfigPath = null;
  }

  /**
   * Remove the per-session artifacts the provider declared disposable.
   *
   * Best-effort and idempotent: a session can reach `_handleExit` once, but the
   * directory may already be gone (operator cleanup, a container restart mid
   * flight). A failure here must never keep a session from reaching a terminal
   * state, so it is logged and swallowed.
   *
   * Runs AFTER `_cleanupMcpConfig()`: for a provider that merged its MCP block
   * into a file inside that same directory, removing the directory first would
   * make the MCP cleanup log a spurious failure.
   */
  private _cleanupSessionConfig(): void {
    if (this._sessionCleanupPaths.length === 0) return;
    for (const target of this._sessionCleanupPaths) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        log.warn({
          event: 'session.config_cleanup_failed',
          sessionId: this.id,
          provider: this.provider.id,
          path: target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this._sessionCleanupPaths = [];
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
