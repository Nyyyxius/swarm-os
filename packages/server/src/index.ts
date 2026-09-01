import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Spawner, type TeamSnapshotEntry } from './modules/spawner/index.js';
import { startServer, type BootGate } from './http/main.js';
import { McpServer } from './modules/mcp/server.js';
import { initRootLogger, withModule } from './logger.js';
import { SwarmDb } from './modules/db/index.js';
import { DbPersistence } from './modules/orchestrator/persistence.js';
import { DiscordWebhookNotifier, NoOpNotifier, type Notifier } from './modules/notify/index.js';
import { DiscordBotPool } from './modules/discord/pool.js';
import {
  bindModelCatalogue,
  createBuiltinProviderRegistry,
  ModelCatalogue,
  OpencodeProvider,
} from './modules/providers/index.js';
import { RoleStore } from './modules/roles/index.js';
import { SettingsStore } from './modules/settings/index.js';
import { MessagesAggregator } from './modules/metrics/aggregator.js';
import { BusMetricsCollector } from './modules/metrics/busMetrics.js';
import { BackupScheduler } from './modules/backup/index.js';
import { CronStore } from './modules/crons/store.js';
import { CronScheduler } from './modules/crons/scheduler.js';
import { CronScriptRunner } from './modules/crons/runner.js';
import { IdeSupervisor } from './modules/ide/index.js';
import { PluginStore } from './modules/plugins/store.js';
import { MemoryStore } from './modules/memory/store.js';
import { GraphStore } from './modules/codegraph/store.js';
import { probeGraphify } from './modules/codegraph/graphify.js';
import {
  startCodegraphJanitor,
  type CodegraphJanitorHandle,
} from './modules/codegraph/lifecycle.js';
import { TaskboardStore } from './modules/taskboard/store.js';
import { makeSessionCostLookup } from './modules/taskboard/cost.js';
import { SkillStore } from './modules/skills/store.js';
import { SkillInstaller } from './modules/skills/installer.js';
import { SkillsSubsystem } from './modules/skills/index.js';
import { ApprovalStore } from './modules/approvals/store.js';
import {
  startApprovalJanitor,
  type ApprovalJanitorHandle,
} from './modules/approvals/lifecycle.js';
import {
  markOrphanedCardsAtBoot,
  startTaskboardJanitor,
  type TaskboardJanitorHandle,
} from './modules/taskboard/lifecycle.js';
import {
  startSessionReaper,
  type SessionReaperHandle,
} from './modules/orchestrator/reaper.js';
import {
  startBudgetWatch,
  type BudgetWatchHandle,
} from './modules/orchestrator/budget-watch.js';
import {
  startCostRollup,
  costRollupJanitor,
  type CostRollupHandle,
} from './modules/orchestrator/cost-rollup.js';
import { createEmbeddingProvider } from './modules/memory/embeddings.js';
import { PluginHost } from './modules/plugins/host.js';
import { PluginToolRegistry } from './modules/plugins/mcp-registry.js';
import { PluginHttpRegistry } from './modules/plugins/http-registry.js';
import { PluginInstaller } from './modules/plugins/installer.js';
import { UpdateService, UpdateStore, UpdateRunner, githubTokenFromEnv } from './modules/updates/index.js';
import {
  SpawnerTeamsPort,
  reconcileUpdateTeams,
  startUpdateRunnerAtBoot,
} from './modules/updates/teams-port.js';
import {
  ConnectorRegistry,
  DiscordConnectorProvider,
  DISCORD_CONNECTOR_SCHEMA,
} from './modules/plugins/connector-registry.js';
import { eventBus } from './events.js';
import {
  rehydrateMailbox,
  mailboxJanitor,
} from './modules/orchestrator/mailbox-persistence.js';
import { broadcastToLeadsFromExternal } from './modules/orchestrator/messaging.js';

const config = loadConfig();
const rootLog = initRootLogger(config);
const log = withModule('boot');

log.info({
  event: 'boot',
  project: config.projectName,
  version: config.version,
  host: config.host,
  port: config.port,
  mcpPort: config.mcpPort,
  workspaceRoot: config.workspaceRoot,
  dataDir: config.dataDir,
  mcpRuntimeDir: config.mcpRuntimeDir,
  claudeSourceDir: config.claudeSourceDir,
  claudeRuntimeDir: config.claudeRuntimeDir,
  discord: config.discordWebhookUrl ? 'configured' : 'no-op',
  publicUrl: config.publicUrl ?? '<unset>',
  // token, hookToken, sessionSecret etc. intentionally redacted by pino
});

// Phase 6 — first-boot token UX. The values are NEVER logged; only the
// path + length so the operator knows where to retrieve them and can
// recognise the difference between `SWARM_OS_TOKEN` (user-facing) and
// `HOOK_TOKEN` (internal hook). When either token was supplied via env,
// the file may not exist — log accordingly so this isn't misleading.
log.info({
  event: 'boot.tokens',
  swarmTokenSource: process.env.SWARM_OS_TOKEN ? 'env' : 'file',
  swarmTokenPath: process.env.SWARM_OS_TOKEN ? null : path.join(config.dataDir, 'token'),
  swarmTokenLen: config.token.length,
  hookTokenSource: process.env.HOOK_TOKEN ? 'env' : 'file',
  hookTokenPath: process.env.HOOK_TOKEN ? null : path.join(config.dataDir, 'hook-token'),
  hookTokenLen: config.hookToken.length,
  hint: process.env.SWARM_OS_TOKEN
    ? 'SWARM_OS_TOKEN supplied via env — paste it into the web UI Token panel'
    : `first-boot token written to ${path.join(config.dataDir, 'token')}; copy it into the web UI Token panel (or run: docker exec <container> cat /data/token)`,
});

// ---- Phase 5: claude runtime materialisation ------------------------------
// Must happen BEFORE the HTTP server accepts traffic so no orchestrator can
// race against the copy. No-op outside containers (when /claude-source is
// not mounted) — Claude then falls back to the dev's host ~/.claude.
//
// Phase 6 also lifts `~/.claude.json` (sibling of `~/.claude/`) so the
// theme picker / "configuration file not found" warning don't wedge the
// first PTY spawn.
//
// SSH transport: the host claude reads its own `~/.claude/` directly; no
// container-side copy is needed and copying would actively re-introduce the
// OAuth refresh race this mode is built to avoid. Skip.
//
// Goes through the PROVIDER REGISTRY rather than calling `initClaudeRuntime`
// directly: the registry is the list of adapters this build ships, and each
// one decides what (if anything) it needs materialised. Non-claude adapters
// run on the host over SSH and answer `not-applicable`, so this loop is a
// no-op for them — but a future adapter that DOES need a container-side copy
// gets it for free instead of needing another branch here.
const providerRegistry = createBuiltinProviderRegistry(config);
if (config.agentTransport === 'ssh') {
  log.info({
    event: 'boot.claude_init_skipped',
    reason: 'ssh-transport',
    note: 'host agents resolve their own ~/.X in the host namespace',
  });
} else {
  for (const provider of providerRegistry.list()) {
    const outcome = provider.initRuntime({
      sourceDir: config.claudeSourceDir,
      runtimeDir: config.claudeRuntimeDir,
      siblingSource: config.claudeJsonSource,
    });
    // Historical event name kept for claude: it is what operators grep when
    // an agent lands on the interactive `/login` prompt.
    log.info({
      event: provider.id === 'claude' ? 'boot.claude_init' : 'boot.provider_init',
      provider: provider.id,
      initialized: outcome.initialized,
      copied: outcome.copied,
      skipReason: outcome.skipReason ?? null,
      entriesCopied: outcome.entriesCopied ?? null,
      claudeJson: outcome.sibling ?? null,
      claudeJsonSource: outcome.siblingSource ?? null,
    });
  }
}

// ---- Phase 4: SQLite persistence ------------------------------------------
const db = new SwarmDb(config.dataDir);
const persistence = new DbPersistence(db);

// ---- Shared memory / knowledge graph (docs/memoire-partagee.md) ------------
// GLOBAL to the deployment: one instance = one memory shared by every team.
// The store OWNS its own tables on the raw Db handle (like PluginStore) and
// keeps the vault of markdown files at `<dataDir>/memory/<name>.md` as its
// source of truth. Wrapped so a memory-subsystem failure never stops the boot:
// the memory MCP tools then answer MEMORY_UNAVAILABLE and `/api/memory` 404s,
// while every other subsystem is unaffected.
let memoryStore: MemoryStore | null = null;
try {
  // Embedding provider for semantic search (Phase 5). Built from env; on any
  // misconfiguration it falls back to a safe local deterministic provider, so
  // the boot never fails and the 24/7 server never blocks on a missing backend.
  const embeddings = createEmbeddingProvider();
  memoryStore = new MemoryStore(db, { dataDir: config.dataDir, eventBus, embeddings });
  log.info({ event: 'boot.memory_store', embeddings: embeddings.capabilities() });
} catch (err) {
  log.error({
    event: 'boot.memory_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the shared memory could not be opened — memory.* tools and /api/memory are DISABLED for this boot; every other subsystem is unaffected.',
  });
}

// ---- Code knowledge graph / Graphify indexer (docs/graphify-integration.md) -
// GLOBAL to the deployment. The store OWNS its own table on the raw Db handle
// (like MemoryStore) and keeps every graphify artifact under
// `<dataDir>/codegraph/<scopeId>/` — NEVER inside a user's source dir. Wrapped
// so a codegraph-subsystem failure never stops the boot (exactly like
// MEMORY_UNAVAILABLE); the janitor is started later, next to the plugin store.
let graphStore: GraphStore | null = null;
try {
  if (config.codegraphEnabled) {
    graphStore = new GraphStore(db, { dataDir: config.dataDir, eventBus });
    log.info({ event: 'boot.codegraph_store' });
  } else {
    log.info({ event: 'codegraph.disabled', reason: 'SWARM_OS_CODEGRAPH_ENABLED=false' });
  }
} catch (err) {
  log.error({
    event: 'codegraph.unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the code graph store could not be opened — codegraph is DISABLED for this boot; every other subsystem is unaffected.',
  });
}

// ---- Durable task board / Kanban (docs/tableau-de-taches.md) ---------------
// PER TEAM (per orchestrator): the operational state of one mission. The store
// OWNS its own tables on the raw Db handle (like MemoryStore) — no schema.sql /
// INLINE_SCHEMA touch. Wrapped so a board-subsystem failure never stops the
// boot: the board.* MCP tools then answer TASKBOARD_UNAVAILABLE while every
// other subsystem is unaffected.
let taskboardStore: TaskboardStore | null = null;
try {
  taskboardStore = new TaskboardStore(db, { eventBus });
  log.info({ event: 'boot.taskboard_store' });
} catch (err) {
  log.error({
    event: 'boot.taskboard_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the task board could not be opened — board.* tools are DISABLED for this boot; every other subsystem is unaffected.',
  });
}

// ---- Human-in-the-loop approval queue (docs/garde-fous-approbation.md P1) ---
// PER TEAM: the persisted queue of pending permission/question approvals a
// non-bypass session raised when it blocked on a CLI prompt. Deliberately NOT
// derived from the ephemeral `waiting` pseudo-status (docs §2.1) so an approval
// survives a reconnect/crash/resume. The store OWNS its own tables on the raw Db
// handle (like MemoryStore/TaskboardStore) — no schema.sql / INLINE_SCHEMA
// touch. Wrapped so an approval-subsystem failure never stops the boot: the
// `/hooks/notification` route then simply records no approval (the legacy
// waiting/Discord path is unaffected), and every other subsystem is unaffected.
let approvalStore: ApprovalStore | null = null;
try {
  approvalStore = new ApprovalStore(db, { eventBus });
  log.info({ event: 'boot.approval_store' });
} catch (err) {
  log.error({
    event: 'boot.approval_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the approval queue could not be opened — human-in-the-loop approvals are DISABLED for this boot; the legacy waiting/Discord path and every other subsystem are unaffected.',
  });
}

// ---- Phase 8: auto-resume — classify what to bring back up ----------------
// loadResumableState is the atomic-guard variant of the old recoverFromCrash:
// it flips every resumable orch row to 'interrupted' synchronously BEFORE
// returning, so a crash mid-resume cannot lead to a double-spawn at the
// next boot. The orch rows are then re-flipped to 'running' by
// Orchestrator.resume() on success.
let resumableState: ReturnType<typeof persistence.loadResumableState> = {
  resumable: [],
  reaped: { orchestrators: 0, sessions: 0 },
};
if (config.autoResume) {
  resumableState = persistence.loadResumableState();
  log.warn({
    event: 'boot.recovery',
    mode: 'auto-resume',
    candidates: resumableState.resumable.length,
    reapedOrchestrators: resumableState.reaped.orchestrators,
    reapedSessions: resumableState.reaped.sessions,
  });
} else {
  const recovered = persistence.recoverFromCrash();
  log.warn({
    event: 'boot.recovery',
    mode: 'legacy',
    note: 'auto-resume disabled — marked stale rows as interrupted',
    orchestrators: recovered.orchestrators,
    sessions: recovered.sessions,
  });
}

// ---- Phase 4: Notifier ----------------------------------------------------
const notifier: Notifier = config.discordWebhookUrl
  ? new DiscordWebhookNotifier({
      webhookUrl: config.discordWebhookUrl,
      projectName: config.projectName,
      publicUrl: config.publicUrl,
    })
  : new NoOpNotifier();

// ---- Discord bot pool (bidirectional). One bot per distinct role token. ----
// The pool is created empty; bots come up lazily when an orch with a
// `botToken`-bearing role subscribes (create or resume path).
const discordBotPool = new DiscordBotPool();

// ---- J4: connector registry (channel bridges as plugins) ------------------
// The built-in `discord` provider wraps the same `discordBotPool` (outbound
// `discord.send_message` still routes via the pool directly). Plugin-provided
// connector types register here at enable, and the Spawner consults it to wire
// each role's connectors at create/resume.
const connectorRegistry = new ConnectorRegistry();
connectorRegistry.register('discord', new DiscordConnectorProvider(discordBotPool), {
  label: 'Discord',
  schema: DISCORD_CONNECTOR_SCHEMA,
  builtin: true,
});

const roleStore = new RoleStore(db);
const settingsStore = new SettingsStore(db);

// ---- Lot 6b: the opencode adapter's OpenRouter key ------------------------
// The key lives in `instance_settings` (masked field in the settings drawer),
// not in an env var: this deployment runs 24/7 and is never recreated for a
// config change, so a credential that can only be rotated by replacing the
// container is a credential that cannot be rotated.
//
// Bound HERE rather than in `createBuiltinProviderRegistry` because the
// registry is built during phase 5 above, before the SQLite file is open —
// there is no store to pass at construction. Nothing reads the key until a
// spawn or an availability probe, both well after this line.
const opencodeProvider = providerRegistry.get('opencode');
if (opencodeProvider instanceof OpencodeProvider) {
  opencodeProvider.useKeySource(settingsStore);
  log.info({ event: 'boot.openrouter_key_source', source: 'instance_settings' });
}

// ---- Live model catalogue -------------------------------------------------
// Same late-binding seam as the key source above, and the same 24/7 argument:
// model ids ship far faster than our releases, and an operator must see
// `claude-opus-5` appear without the container being recreated.
//
// Bound here, in production only. No test stack constructs one, so every unit
// and integration test keeps answering from the pinned arrays.
const modelCatalogue = new ModelCatalogue({ config });
const catalogueBound = bindModelCatalogue(providerRegistry, modelCatalogue);
log.info({
  event: 'boot.model_catalogue',
  enabled: modelCatalogue.enabled,
  providers: catalogueBound,
});
// Fire-and-forget warm-up. Without it, an API client that creates a team before
// anyone opens the UI gets the pinned default even on a perfectly online host:
// `POST /orchestrators` awaits `providerAvailability` and nothing else, so the
// catalogue would only ever be filled by the first `GET /providers`.
void modelCatalogue.resolve();

// J2 — MCP tool registry. Consulted per-request when the SdkMcpServer is
// rebuilt, and once per session spawn to list the plugin tools in the preamble.
// Declared here, BEFORE the spawner, because the spawner takes it as a dep; it
// has no constructor arguments, so the position is free.
const pluginToolRegistry = new PluginToolRegistry();

// ---- Skills library (docs/plan-skills-importables.md) ----------------------
// PER INSTANCE registry. The store OWNS its `skills` table on the raw Db handle
// (like MemoryStore/TaskboardStore/ApprovalStore) — no schema.sql / INLINE_SCHEMA
// touch. Wrapped so a skills-subsystem failure never stops the boot: the
// `skills.*` MCP tools then answer SKILLS_UNAVAILABLE and `/skills` 404s, while
// every other subsystem is unaffected.
let skillsSubsystem: SkillsSubsystem | null = null;
try {
  const skillStore = new SkillStore(db);
  const skillInstaller = new SkillInstaller({
    skillsDir: path.join(config.dataDir, 'skills'),
    store: skillStore,
  });
  skillsSubsystem = new SkillsSubsystem({
    store: skillStore,
    installer: skillInstaller,
    roleStore,
    config,
  });
  log.info({ event: 'boot.skills_store' });
} catch (err) {
  log.error({
    event: 'boot.skills_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the skills subsystem could not be opened — skills.* tools and /skills are DISABLED for this boot; every other subsystem is unaffected.',
  });
}

const spawner = new Spawner(config, {
  notifier,
  persistence,
  roleStore,
  discordBotPool,
  connectorRegistry,
  // Every preamble — lead, worker, resumed, and whatever custom role text the
  // operator wrote — gets the currently-registered plugin tools appended.
  pluginTools: () => pluginToolRegistry.list(),
  // Carried so `GET /providers` can await the catalogue's cold resolve on the
  // same deadline as the availability probes. The adapters already hold it.
  modelCatalogue,
  // Same registry the boot-time runtime init used, so `GET /providers` and the
  // orchestrators answer from one table.
  providerRegistry,
  // Shared knowledge-graph store — threaded into every ToolContext so the
  // memory.* MCP tools reach it. `undefined` when the store failed to open.
  ...(memoryStore ? { memory: memoryStore } : {}),
  // Durable task-board store — threaded into every ToolContext so the board.*
  // MCP tools reach it. `undefined` when the store failed to open.
  ...(taskboardStore ? { taskboard: taskboardStore } : {}),
  // Code-knowledge-graph store — threaded into every ToolContext so the
  // codegraph.* MCP tools reach it. `undefined` when codegraph is off/absent.
  ...(graphStore ? { graph: graphStore } : {}),
  // Human-in-the-loop approval queue — threaded so the Discord connector wiring
  // can attach the P4 reply-router to each orch subscription. `undefined` when
  // the store failed to open (approvals then work via web/REST only).
  ...(approvalStore ? { approvals: approvalStore } : {}),
  // Skills subsystem — threaded so the skills.* MCP tools reach it and the
  // per-spawn preamble resolver injects a role's active skills.
  ...(skillsSubsystem ? { skills: skillsSubsystem } : {}),
});

// Give the skills subsystem a live-orchestrator lookup so the REST + MCP scope
// activation paths can fire the HOT channel (docs/plan-skills-importables.md §2.2).
skillsSubsystem?.setOrchestratorLookup((id) => spawner.get(id) ?? null);

// Lot 16 — give the board a way to price a card's assignee. Late-wired for the
// same reason as the lookup above: the store is opened at boot, ~160 lines
// BEFORE the spawner exists. Until this line runs (and on any boot where the
// board failed to open) cards simply stay unpriced.
taskboardStore?.setCostLookup(makeSessionCostLookup(spawner));

// ---- S9: in-memory `/metrics/messages` aggregator -------------------------
// Owns a 60-pt global ring + 8-pt per-orch rings, ticked every 60 s. Lost on
// restart by design (see docs/update_system/09_metrics_messages.md §7.3).
const aggregator = new MessagesAggregator(spawner);
aggregator.start();

// ---- S8: in-memory `/metrics/bus` collector -------------------------------
// 60-slot ring (1 s/slot) backing latency / throughput / err_rate, with an
// instantaneous queue_depth. Instrumented from McpServer (constructor arg)
// so each tool call updates the current slot synchronously. Lost on restart
// by design — same policy as the messages aggregator above.
const busMetrics = new BusMetricsCollector(spawner);
busMetrics.start();

// ---- Hot SQLite backup scheduler ------------------------------------------
// In-process online snapshots of swarm-os.db into <dataDir>/backups (bind-
// mounted to the host). No OS cron / sidecar — see modules/backup for the
// rationale. Disabled when interval or keep is 0.
const backup = new BackupScheduler({
  db: db.db,
  dataDir: config.dataDir,
  intervalMs: config.backupIntervalMs,
  keep: config.backupKeep,
});
backup.start();

// ---- Task board TTL janitor ------------------------------------------------
// Periodically purges (soft-deletes) orphaned cards past their TTL. In-process,
// unref'd interval, every tick guarded — a sweep can never crash the boot or
// the 24/7 loop. No-op when the board store failed to open.
let taskboardJanitor: TaskboardJanitorHandle | null = null;
if (taskboardStore) {
  taskboardJanitor = startTaskboardJanitor(taskboardStore, {
    ttlMs: config.taskboardOrphanTtlMs,
    intervalMs: config.taskboardJanitorIntervalMs,
  });
}

// ---- Approval-gate TTL janitor --------------------------------------------
// Periodically flags still-`pending` approvals past their TTL as `expired` — a
// cleanup flag only, NEVER an auto-deny (timeout policy = "leave pending").
// In-process, unref'd interval, every tick guarded. No-op when the approval
// store failed to open at boot.
let approvalJanitor: ApprovalJanitorHandle | null = null;
if (approvalStore) {
  try {
    approvalJanitor = startApprovalJanitor(approvalStore, {
      ttlMs: config.approvalOrphanTtlMs,
      intervalMs: config.approvalJanitorIntervalMs,
    });
  } catch (err) {
    log.warn({
      event: 'approvals.janitor_start_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- Dead-worker session reaper -------------------------------------------
// In-process; per role, soft-deletes (hideSession) terminal workers
// (killed/exited/failed) once they have been terminal longer than the role's
// configured delay. OFF for every role by default (opt-in toggle). Unref'd
// interval, every tick guarded — a bad sweep can never crash the 24/7 loop.
// `sessionReaperIntervalMs = 0` disables it. NEVER touches leads or
// non-terminal sessions.
const sessionReaper: SessionReaperHandle = startSessionReaper(spawner, roleStore, {
  intervalMs: config.sessionReaperIntervalMs,
});

// ---- Cost-budget watch (Lot 14) -------------------------------------------
// In-process; per role, compares each live team's CUMULATIVE spend (the Lot 12
// DB aggregate — reaped/killed workers included, and a lower bound: an
// unpriceable model contributes 0) against the role's `costBudgetUsd`. On the
// FIRST crossing only: `session.budget_exceeded` on the bus, a Discord post
// through the team's own notifier, and — when the role says `pause` — SIGSTOP on
// every running session of the team, LEAD INCLUDED. Nothing is ever killed.
// One-shot state is in memory and re-arms if the budget is raised.
// `budgetCheckIntervalMs = 0` disables it; a role with no budget is never
// touched, which is every role by default.
const budgetWatch: BudgetWatchHandle = startBudgetWatch(spawner, roleStore, db, {
  intervalMs: config.budgetCheckIntervalMs,
});

// ---- Daily cost roll-up (Lot 15) ------------------------------------------
// In-process; every hour, files each live agent's token DELTA since the last
// tick into `session_token_daily` — the history the long-trend charts and
// `GET /metrics/costs/export` read, since a cumulative counter cannot describe
// the shape of a week. The watermark lives in SQLite, so a missed tick or a
// restart delays a delta but never loses it. `costRollupIntervalMs = 0`
// disables it. The boot GC keeps 90 days, which is also the export's cap.
try {
  costRollupJanitor(db);
} catch (err) {
  log.warn({
    event: 'boot.cost_rollup_gc_failed',
    error: err instanceof Error ? err.message : String(err),
  });
}
const costRollup: CostRollupHandle = startCostRollup(spawner, db, {
  intervalMs: config.costRollupIntervalMs,
});

// ---- Agent crons (docs/crons-agents.md) ------------------------------------
// The ONE cadence engine: N crons per role, each with its own pause switch and
// its own bounded run history, replacing the single `roles.schedule` column.
// The store OWNS its tables on the raw Db handle (like MemoryStore /
// ApprovalStore) and runs the legacy migration in its constructor. Wrapped so a
// crons-subsystem failure never stops the boot: `/crons` is then simply not
// mounted, `GET /roles` reports `cronCount: 0`, and every other subsystem is
// unaffected. Host-independent (no OS cron / sidecar) — see modules/crons for
// the rationale.
let cronStore: CronStore | null = null;
try {
  cronStore = new CronStore(db);
  log.info({ event: 'boot.cron_store' });
} catch (err) {
  log.error({
    event: 'boot.cron_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the crons table could not be opened — agent crons are DISABLED for this boot (no tick, no /crons route); every other subsystem is unaffected.',
  });
}
// The script executor (§2.5). Stateless apart from its registry of in-flight
// children, so it is built unconditionally and shared by the scheduler (runs +
// shutdown kills) and the route (path refusal at creation time).
const cronRunner = new CronScriptRunner({
  workspaceRoot: config.workspaceRoot,
  dataDir: config.dataDir,
  timezone: config.scheduleTimezone,
  transport: config.agentTransport === 'ssh' ? 'ssh' : 'local',
});
const cronScheduler =
  cronStore === null
    ? null
    : new CronScheduler({
        store: cronStore,
        spawner,
        defaults: {
          maxMessageSizeBytes: config.maxMessageSizeBytes,
          idleThresholdMs: config.idleThresholdMs,
        },
        timezone: config.scheduleTimezone,
        enabled: config.scheduleEnabled,
        runner: cronRunner,
      });
// NOT started here. `start()` is called once the bootGate flips (see
// runAutoResume below): every fire now writes a `cron_runs` row, so ticks
// landing while auto-resume is still rebuilding teams would persist a trail of
// `noop`s for teams that were merely on their way back up.
const crons =
  cronStore && cronScheduler
    ? { store: cronStore, scheduler: cronScheduler, runner: cronRunner }
    : undefined;

// ---- VS Code web (`code serve-web`) supervisor -----------------------------
// In-container child process serving the official Microsoft VS Code web at the
// root of its own port (config.idePort), guarded by a connection-token. Edits
// the same /workspace tree the agents work in. Independent of the orchestrator
// stack, so started here (no auto-resume dependency). Disabled when
// SWARM_OS_IDE_ENABLED=false.
const ide = new IdeSupervisor(config);
ide.start();
if (config.ideEnabled) {
  log.info({ event: 'boot.ide', port: config.idePort, cli: config.ideCliPath });
}

// ---- Plugin system (J1 — socle) -------------------------------------------
// PluginStore owns its own tables on the raw Db handle. PluginHost loads,
// enable/disable/reload at runtime, guards every plugin callback against a
// server-killing throw, and quarantines crash loops. Activated AFTER mcp.start
// (so future bridges are up before auto-resume) but its activateEnabled()
// never rejects — see the boot chain below.
//
// Nothing in this block may stop the boot either, and that is a fix, not a
// preference: `PluginStore`'s constructor runs DDL and then PREPARES against
// it, so a schema it cannot work with (SQLITE_READONLY, a hand-modified
// `plugins` table, an ALTER that failed for any reason other than "duplicate
// column") throws at module top level — before the HTTP listener exists, on
// every boot, i.e. a crash loop with no /health and no way in. `UpdateStore`
// below already gets exactly this treatment. Same discipline as
// `pluginHost.activateEnabled()`: plugins go away for this boot, loudly, and
// the orchestrator stack — the reason the process exists — still comes up.
let pluginStore: PluginStore | null = null;
try {
  pluginStore = new PluginStore(db);
  log.info({ event: 'boot.plugin_store' });
} catch (err) {
  log.error({
    event: 'boot.plugin_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'the plugin registry could not be opened — plugins are DISABLED for this boot and /plugins answers 404; every other subsystem is unaffected. Fix the plugins/plugin_kv schema and restart.',
  });
}

// Give the skills subsystem a plugin-state lookup so `requires.plugins` resolves
// to installed+enabled + warnings (docs/plan-skills-importables.md §9). Late-
// bound because PluginStore is built after the skills subsystem. Best-effort:
// when the plugin registry is absent, every required plugin reads as missing.
skillsSubsystem?.setPluginLookup((name) => {
  const row = pluginStore?.get(name) ?? null;
  return { installed: row != null, enabled: row?.enabled === 1 };
});
// J2 — registry consulted per-request (HTTP zones). Never torn down;
// enable/disable is a Map mutation. Its MCP-tool sibling is declared ABOVE the
// spawner, which reads it when building preambles.
const pluginHttpRegistry = new PluginHttpRegistry();

// ---- Codegraph janitor -----------------------------------------------------
// Started here (not with the other janitors) because scope discovery needs the
// plugin registry. Probes graphify first: if the binary is absent the feature
// auto-disables cleanly (log + skip) and the boot is unaffected. In-process,
// unref'd interval, every sweep guarded; runs graphify ONLY when a scope's code
// actually changed. No-op when the store failed to open or the feature is off.
let codegraphJanitor: CodegraphJanitorHandle | null = null;
if (graphStore) {
  const probe = probeGraphify(config.codegraphBin);
  if (!probe.available) {
    log.warn({
      event: 'codegraph.unavailable',
      reason: probe.reason,
      note: 'graphify binary not usable — codegraph janitor NOT started; store stays empty. Every other subsystem is unaffected.',
    });
  } else {
    try {
      log.info({ event: 'codegraph.graphify_probed', version: probe.version });
      codegraphJanitor = startCodegraphJanitor(
        {
          store: graphStore,
          workspaceRoot: config.workspaceRoot,
          dataDir: config.dataDir,
          pluginStore,
          graphifyBin: config.codegraphBin,
          engine: config.codegraphEngine,
          runTimeoutMs: config.codegraphTimeoutMs,
          // Option-A memory integration: auto note per scope + hub note.
          // Optional — when memory is unavailable, note maintenance is skipped.
          memory: memoryStore,
        },
        { intervalMs: config.codegraphJanitorIntervalMs },
      );
    } catch (err) {
      log.warn({
        event: 'codegraph.janitor_start_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const pluginMessagingDefaults = {
  maxMessageSizeBytes: config.maxMessageSizeBytes,
  idleThresholdMs: config.idleThresholdMs,
};
const pluginHost = pluginStore === null ? null : new PluginHost({
  store: pluginStore,
  eventBus,
  pluginsDir: path.join(config.dataDir, 'plugins'),
  zod: z,
  // J2 façades.
  spawner,
  roleStore,
  settingsStore,
  config,
  toolRegistry: pluginToolRegistry,
  httpRegistry: pluginHttpRegistry,
  connectorRegistry,
  // `api.crons` — the same store/scheduler/runner trio the /crons routes drive.
  // `undefined` on a degraded boot (no crons store): the façade then throws a
  // named error, mirroring the route simply not being mounted.
  crons,
  // Signal leads of a plugin tool-set change via the external-origin broadcast
  // path (mailbox.push + emit + idle wake). Best-effort — never throws into
  // the enable/disable path.
  broadcastToLeads: (from, content) => {
    try {
      broadcastToLeadsFromExternal(spawner, from, content, pluginMessagingDefaults);
    } catch (err) {
      log.warn({
        event: 'plugins.broadcast_to_leads_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
// J3 — install/upgrade from npm/git/upload/dir. Shares the host's per-name lock
// (via host.commitInstall) so a swap is never concurrent with an enable (I-8).
const pluginInstaller =
  pluginStore === null || pluginHost === null
    ? null
    : new PluginInstaller({
        pluginsDir: path.join(config.dataDir, 'plugins'),
        store: pluginStore,
        host: pluginHost,
      });
// Purge stale `.staging/*` (interrupted installs, `.bak-*` leftovers) at boot.
// Best-effort: a staging directory we cannot clean is not worth a crash loop.
try {
  pluginInstaller?.purgeStaging();
} catch (err) {
  log.warn({
    event: 'boot.plugin_staging_purge_failed',
    error: err instanceof Error ? err.message : String(err),
  });
}

// ---- Update detection (system releases + plugin origins) -------------------
// NO TIMER, and that is the design: the SPA already polls `/info` every 60 s
// without auth, so SERVING that route is what refreshes the verdict (TTL-gated,
// fire-and-forget). Hence nothing to start here and nothing to stop in
// shutdown() — see the header of modules/updates/index.ts.
//
// Nothing in this block may stop the boot. An expired PAT, a dead network, a
// GitHub 404 on a private repo are ordinary states of a perfectly healthy
// deployment, and "there is a newer version" is a nicety: a swarm-os that
// refuses to start because it can't reach GitHub would be strictly worse than
// one that never mentions updates. Same no-reject discipline as
// pluginHost.activateEnabled() below.
let updateStore: UpdateStore | undefined;
try {
  // The DDL runs in this constructor, NOT in db/schema.sql: that file is not
  // shipped in the image (tsc doesn't copy `.sql`), SwarmDb silently falls back
  // to its inlined copy, and its writers swallow failures into a warn — so a
  // table declared only there would never exist in production and every write
  // to it would vanish without a trace. PluginStore already sidesteps it this
  // way. `assertReady` is the boot assertion that the sidestep actually worked:
  // loud (log.error), never fatal.
  const store = new UpdateStore(db);
  store.assertReady();
  updateStore = store;
  log.info({ event: 'boot.update_store' });
} catch (err) {
  log.error({
    event: 'boot.update_store_unavailable',
    error: err instanceof Error ? err.message : String(err),
    note: 'update_runs is missing — update RUNS cannot be recorded; detection is unaffected',
  });
}
const updates = new UpdateService({
  // The narrow slice the service reads; `image` is SWARM_OS_IMAGE, whose very
  // absence is the observable form of "this compose hardcodes its tag".
  config: { version: config.version, image: config.image, agentTransport: config.agentTransport },
  settings: settingsStore,
  store: updateStore,
  // The projection lives in PluginHost: modules/updates defines its own narrow
  // `PluginOrigin` so detection never imports the plugin registry, and this is
  // the wiring step that closes the loop. Called lazily, per refresh, so it
  // always reads the CURRENT rows (an upgrade changes the recorded commit).
  listPluginOrigins: () => pluginHost?.listOrigins() ?? [],
});
log.info({
  event: 'boot.updates',
  // Value never logged — only whether a PAT exists, which is the one thing an
  // operator debugging "why is there no update badge" needs to know. Asked via
  // the module's own reader so the env var is named in exactly one place.
  githubToken: githubTokenFromEnv() ? 'configured' : 'unset',
  runsPersisted: updateStore !== undefined,
});

// ---- Update application (Lot D/E) ------------------------------------------
// Detection above answers "is there a newer version"; this is what installs it.
// Unlike the service, the runner DOES own a lifecycle (a watch interval, a
// one-shot schedule timer, a grace-window timer), so it is started below and
// stopped in shutdown().
//
// Late-bound into the service (`setRunner`) because its teams port needs the
// spawner, and because an instance without a store must still detect: no store
// ⇒ no runner ⇒ every write route answers 503 and says why, rather than
// answering 202 and doing nothing. Nothing here may stop the boot.
let updateRunner: UpdateRunner | null = null;
if (updateStore) {
  try {
    updateRunner = new UpdateRunner({
      config,
      store: updateStore,
      // The whole of what the apply machine knows about live teams (§D.5/§D.6).
      teams: new SpawnerTeamsPort(spawner),
    });
    updates.setRunner(updateRunner);
    // The script descriptor is only known after `start()` installs it, so it
    // is logged there (`updates.script_installed`), not here.
    log.info({ event: 'boot.update_runner', transport: config.agentTransport });
  } catch (err) {
    updateRunner = null;
    log.error({
      event: 'boot.update_runner_unavailable',
      error: err instanceof Error ? err.message : String(err),
      note: 'detection still works; POST /updates/* answers 503',
    });
  }
}

/** §D.5 — banner for the resumed LEADS; null ⇒ resume notices unchanged. */
let updateResumeBanner: string | null = null;
/** §D.6 — teams that were up before the update; the DB rows no longer know. */
let updateTeams: readonly TeamSnapshotEntry[] = [];
let updateRunId: string | null = null;

// Kicked off HERE, not in the boot chain below, so the run directory is read
// and a half-written `.env` line is restored while mcp/plugins come up — and
// AWAITED before auto-resume, because the banner it produces is what tells the
// resumed leads why they were interrupted. It touches only files and the
// update store, never the spawner, so it is safe to overlap with them.
const updatesReady: Promise<void> = startUpdateRunnerAtBoot(updateRunner, updateStore ?? null)
  .then((state) => {
    updateRunId = state.runId;
    updateResumeBanner = state.banner;
    updateTeams = state.teams;
  })
  .catch((err: unknown) => {
    // Defensive: `startUpdateRunnerAtBoot` swallows its own failures.
    log.error({
      event: 'boot.update_runner_start_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  });

// Phase 8 — bootGate: HTTP listens immediately so /health stays green for
// Docker, but business routes return 503 until auto-resume finishes.
const bootGate: BootGate = { value: false };
const handle = startServer(
  config,
  spawner,
  roleStore,
  settingsStore,
  aggregator,
  backup,
  busMetrics,
  bootGate,
  crons,
  pluginHost ?? undefined,
  pluginHttpRegistry,
  pluginInstaller ?? undefined,
  connectorRegistry,
  updates,
  memoryStore ?? undefined,
  taskboardStore ?? undefined,
  approvalStore ?? undefined,
  graphStore ?? undefined,
);

// Start MCP HTTP listener on its own port (loopback only, plan §14).
// Phase 8 — MCP must be listening BEFORE we respawn PTYs, otherwise the
// first `team.read_inbox` call from a resumed agent ECONNREFUSEs and the
// agent wastes its first turn on a transport error. If MCP fails to bind
// we shut down the main listener too — the system is non-functional
// without MCP.
const mcp = new McpServer(spawner, config.mcpPort, config, busMetrics, pluginToolRegistry);

/**
 * Arm the crons — deliberately AFTER the bootGate flips, on both exits of
 * `runAutoResume`. Ticks fired while auto-resume is still rebuilding teams
 * would find no live instance and persist a `noop` in `cron_runs` for every
 * cadence due in that window: a run history full of failures that never
 * happened. No-op when the store failed to open or cadence is disabled.
 */
function startCronsAfterBoot(): void {
  try {
    cronScheduler?.start();
  } catch (err) {
    log.error({
      event: 'boot.crons_start_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runAutoResume(): Promise<void> {
  if (!config.autoResume || resumableState.resumable.length === 0) {
    // Still reconcile: with auto-resume off (or nothing to resume), every team
    // the update interrupted is a casualty, and that is worth saying out loud.
    // The store is passed explicitly — see the call in the `finally` below.
    reconcileUpdateTeams(spawner, updateTeams, updateRunId, updateStore ?? null);
    bootGate.value = true;
    startCronsAfterBoot();
    log.info({ event: 'boot.complete', resumed: 0, mailboxRehydrated: 0 });
    return;
  }
  try {
    const { resumed, failed } = await spawner.resumeFromDb(
      resumableState.resumable,
      {
        staggerMs: config.resumeStaggerMs,
        // §D.5 — LEADS only (the spawner threads it to `Orchestrator.resume`,
        // never to the workers). `null` when no update was in flight, which
        // leaves the resume notice byte-identical to any other restart.
        resumeBanner: updateResumeBanner,
      },
    );
    const mailbox = rehydrateMailbox(spawner, db);
    const janitor = mailboxJanitor(db);
    // Mute Discord for a window so the inevitable session.waiting cascade
    // from N freshly-respawned agents doesn't hit the webhook rate limit.
    if (config.notifyQuietAfterBootMs > 0) {
      notifier.muteUntil = Date.now() + config.notifyQuietAfterBootMs;
    }
    log.info({
      event: 'boot.auto_resume',
      resumed,
      failed: failed.length,
      mailboxRehydrated: mailbox.rehydrated,
      mailboxDroppedSenderTerminal: mailbox.droppedSenderTerminal,
      mailboxDroppedOrphan: mailbox.droppedOrphan,
      janitorDeleted: janitor.deleted,
      muteUntilMs: notifier.muteUntil ?? null,
    });
    if (failed.length > 0) {
      log.warn({ event: 'boot.auto_resume_failures', failed });
    }
  } catch (err) {
    log.error({
      event: 'boot.auto_resume_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // §D.6 — which of the pre-update teams actually came back. Read from the
    // live map against the persisted snapshot, never from the DB rows: they
    // were all flipped to `interrupted` before the resume even started.
    //
    // The store is handed over HERE, as an argument. It used to be smuggled
    // through module state in `teams-port.ts` because this file was out of its
    // author's reach; the verdict is written by whoever holds both halves, and
    // this call site holds them. `updateRunId` is non-null only when a run was
    // in flight, so an ordinary boot still writes nowhere.
    reconcileUpdateTeams(spawner, updateTeams, updateRunId, updateStore ?? null);
    bootGate.value = true;
    startCronsAfterBoot();
    // Lot 15 — one roll-up pass now that the fleet is back. The janitor's own
    // start-up tick ran before any of these sessions existed, and on a container
    // redeployed more often than the hourly interval it would be the only one to
    // ever run. Nothing is LOST without this (the watermark makes the next tick
    // pick the delta up whole), but a delta straddling the restart would be
    // filed under the day the tick lands rather than the day it was billed.
    costRollup.tick();
    log.info({ event: 'boot.complete', listening: true });
  }
}

mcp
  .start()
  // Plugins come up BEFORE auto-resume so any future bridge is live when the
  // teams return. activateEnabled() catches per-plugin internally and NEVER
  // rejects, so it can't trip the fatal .catch below.
  .then(() => pluginHost?.activateEnabled())
  // The update runner must have concluded (or abandoned + restored the `.env`
  // of) an interrupted run BEFORE any team comes back: its banner is what the
  // resumed leads are told, and its `.env` restore is what keeps the next
  // reboot off an image nobody verified. It never rejects.
  .then(() => updatesReady)
  .then(() => runAutoResume())
  // Phase 3 crash-resume pass — AFTER auto-resume rebuilt the live teams, flag
  // as orphaned every open card whose assignee session didn't come back. Fully
  // defensive (never throws), so it can't trip the fatal .catch below.
  .then(() => {
    if (taskboardStore) markOrphanedCardsAtBoot(spawner, taskboardStore);
  })
  .catch(async (err) => {
    log.error({ event: 'mcp.start_failed', error: err instanceof Error ? err.message : String(err) });
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    // Use the unified shutdown so DB/spawner/etc. flush together.
    await shutdown('mcp.start_failed').catch(() => undefined);
    process.exit(1);
  });

let shuttingDown = false;
/**
 * Tear down the active server stack. Returns once everything is flushed —
 * **does not call `process.exit`**; the caller is responsible for picking
 * the exit code (signals → 0, uncaughtException → 1). Idempotent.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ event: 'shutdown.start', signal });
  try {
    // S9 + S8 — stop the metrics ticks BEFORE the spawner so the last tick
    // can't observe a half-torn-down mailbox.
    aggregator.stop();
    busMetrics.stop();
    // Stop the backup timer before db.close() so no snapshot races teardown.
    backup.stop();
    // Disarm the task-board TTL janitor (unref'd, but stop it explicitly so no
    // sweep fires into a half-closed DB during shutdown).
    taskboardJanitor?.stop();
    // Disarm the approval-gate TTL janitor for the same reason.
    approvalJanitor?.stop();
    // Disarm the dead-worker session reaper (unref'd, but stop it explicitly so
    // no sweep fires hideSession into a half-torn-down spawner during shutdown).
    sessionReaper.stop();
    // Disarm the cost-budget watch for the same reason — a sweep firing during
    // shutdown would SIGSTOP sessions the spawner is already tearing down.
    budgetWatch.stop();
    // Disarm the daily cost roll-up. Nothing is lost by stopping mid-hour: the
    // watermark is in SQLite, so the next process files the pending delta whole.
    costRollup.stop();
    // Disarm the codegraph janitor (interval + fs watchers) so no sweep/watch
    // event fires a graphify run into a half-closed DB during shutdown.
    codegraphJanitor?.stop();
    // Disarm the agent crons so no tick fires into a half-torn-down spawner.
    // `stop()` also SIGKILLs the process group of every in-flight script cron
    // and journals those runs as `error` — synchronously, and this far above
    // `db.close()` on purpose (docs/crons-agents.md §2.5): a SIGTERM must not
    // leave an orphaned script running against a dead server with no trace of
    // it in the run history.
    cronScheduler?.stop();
    // The update RUNNER does own timers, and this is early on purpose: a
    // shutdown during a warning window must not let the grace timer fire into
    // a `docker compose up` on the way out. `stop()` clears the timers without
    // settling the window, so `drive()` simply never reaches its spawn — and a
    // run whose host job is already detached is unaffected, since the next
    // process concludes it from the run directory (§D.4).
    updateRunner?.stop();
    // No `updates.stop()` on purpose: the update SERVICE (detection) owns no
    // timer, no socket and no child process — its only long-lived state is an
    // in-flight fetch that resolves into a field nobody reads after this
    // point. The absence of a lifecycle there IS the design
    // (modules/updates/index.ts).
    // Tear down active plugins (disposables + deactivate) before the spawner
    // goes away, so a plugin's teardown can still observe live teams.
    await pluginHost?.deactivateAll();
    // Stop the VS Code web child (suppresses its restart loop, SIGTERM→SIGKILL).
    await ide.stop();
    spawner.shutdownAll(`signal:${signal}`);
    // Stop MCP first (per-request transport instances will tear down with
    // their sockets) then the main HTTP listener.
    await mcp.stop();
    await discordBotPool.stopAll();
    await handle.close();
    db.close();
  } catch (err) {
    log.error({
      event: 'shutdown.error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info({ event: 'shutdown.done' });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

// Phase 6 carry-over: treat uncaughtException as fatal. The classic case is
// EADDRINUSE during `http.listen` (port collision) — Node fires the error
// asynchronously off the listen callback, so without this handler it just
// gets logged and the process keeps running with a half-open server. We
// attempt a graceful shutdown first (so orchestrators get SIGTERM and
// flushable state lands on disk), then hard-exit with code 1 after a short
// guard timeout so we never hang.
process.on('uncaughtException', (err) => {
  rootLog.fatal({
    event: 'uncaughtException',
    fatal: true,
    error: err.message,
    code: (err as NodeJS.ErrnoException).code ?? null,
    stack: err.stack,
  });
  // Bound the graceful path: if shutdown stalls (e.g. SQLite holding a lock,
  // hub teardown wedged), we MUST still exit so the container restarts.
  const guard = setTimeout(() => {
    rootLog.fatal({ event: 'uncaughtException.guard_exit' });
    process.exit(1);
  }, 5000);
  guard.unref();
  void shutdown('uncaughtException').finally(() => {
    process.exit(1);
  });
});
process.on('unhandledRejection', (err) => {
  // unhandledRejection stays a warn (vs fatal) — most are non-fatal Promise
  // chains we forgot to catch. Add to the fatal handler if a specific kind
  // ever surfaces as actually-fatal in production.
  rootLog.error({
    event: 'unhandledRejection',
    error: err instanceof Error ? err.message : String(err),
  });
});
