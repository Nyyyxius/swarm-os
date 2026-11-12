/**
 * UpdateRunner — the apply/schedule state machine (plan §D.1, §D.4, Lot E).
 *
 *   scheduled → warning_teams → preflight → applying → verifying → success
 *        │            │             │                      ├→ rolled_back
 *    cancelled    cancelled      refused                   ├→ failed
 *                             (nothing touched)            └→ abandoned
 *
 * Three properties are worth stating up front, because they are what make this
 * class shaped the way it is:
 *
 * 1. **This process expects to be killed halfway through.** The whole point of
 *    the run is `docker compose up -d` on the container we are running inside.
 *    So no step may depend on a later step of the same process: everything is
 *    persisted (`update_runs`) or written to the run directory before it could
 *    matter, and `resumeOnBoot()` — not the watcher — is the normal way a run
 *    reaches its verdict.
 *
 * 2. **Liveness is filesystem-based, never `hostJobStatus`.** See
 *    `run-files.ts` for the verified defect that rules the SSH probe out.
 *
 * 3. **`runId` is minted BEFORE the spawn and is the only correlation key.**
 *    `spawnHostJob` mints its own `jobId` internally and returns it only after
 *    the pid file lands (`ssh-exec.ts:493`, `:518`), so persisting the jobId
 *    "before the spawn" is impossible. It is written to `<runDir>/job.json`
 *    afterwards, best-effort, and nothing is allowed to depend on it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { withModule } from '../../logger.js';
import { hostExec, spawnHostJob, HOST_JOBS_SUBDIR, translateCwdForHost } from '../orchestrator/ssh-exec.js';
import {
  buildHostUpdateArgv,
  buildRestoreEnvArgv,
  isValidImageRef,
  runDirFor,
  runsDir,
} from './compose.js';
import {
  assertInstalledScriptMatches,
  installHostUpdateScript,
  type InstalledHostScript,
} from './host-script.js';
import {
  decodeB64,
  eventsPath,
  heartbeatPath,
  isRunAlive,
  jobRefPath,
  phaseToState,
  readEvents,
  readEventsTail,
  readResult,
  resultPath,
  resultToState,
  summarizeProgress,
  type HostUpdateResult,
} from './run-files.js';
import { TERMINAL_UPDATE_STATES, type UpdateRunKind, type UpdateRunRow, type UpdateRunState, type UpdateStore } from './store.js';
import { tagToVersion } from './semver.js';

const log = withModule('updates.runner');

/**
 * Plugin-namespace for the host job. Collision-proof: `PLUGIN_NAME_RE`
 * (`modules/plugins/manifest.ts`) requires a leading lowercase letter, so no
 * plugin can ever be called `_system`.
 */
export const SYSTEM_JOB_NAMESPACE = '_system';

/** The grace window floor. Below this an operator is not warning, they are announcing. */
export const MIN_GRACE_SECONDS = 120;
export const DEFAULT_GRACE_SECONDS = 300;
/** Run directories kept by the janitor, per bucket. */
export const DEFAULT_KEEP_RUNS = 20;
/** Wall-clock cap on a `restore-env` exec started from the request path. */
export const RESTORE_TIMEOUT_MS = 60_000;
/**
 * …and the cap on the same exec when it runs at BOOT. `index.ts` awaits the
 * whole of `start()` before `runAutoResume()`, so every second spent here is a
 * second the teams stay down. The restore is a one-line `sed` on the host: if
 * it has not answered in ten seconds it is not going to, and the run row says
 * so loudly either way.
 */
export const BOOT_RESTORE_TIMEOUT_MS = 10_000;
/**
 * `setTimeout` truncates its delay to a signed 32-bit int and fires
 * IMMEDIATELY past this — i.e. a schedule set for next month would apply the
 * update right now. So a long wait is re-armed in chunks.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// The lead-warning port (plan §D.5).
// ---------------------------------------------------------------------------

/** One team alive at the moment the update was requested. */
export interface ActiveTeam {
  orchestratorId: string;
  name: string;
  /** Session id of the lead, when there is one. */
  leadSessionId: string | null;
}

/**
 * How a lead actually received the warning. NOT a counter: pushing into a
 * mailbox proves nothing, and `broadcastToLeadsFromExternal` only ever reports
 * that much. `read` is observed by pre-minting the message id and checking that
 * it has left the queue.
 *
 * Four of the five are OBSERVATIONS — something was looked at and this is what
 * it said. `pending` is the fifth and it is their opposite: **nothing has been
 * observed about this lead yet**. It is what the placeholder row written when
 * the window opens carries, and it exists because the alternative was to pick
 * one of the verdicts and hope: `never_idle` was that pick, and it asserted
 * "this lead never reached an idle boundary" — on the wire, on the operator's
 * screen, as "(busy for 4m31)" — about leads whose PTY notice had already
 * fired. `warnLead` settles early on a read and on nothing else, so that claim
 * rode the whole window.
 *
 * ⚠️ In a `pending` record `signalled` and `read` are FLOORS, not observations:
 * both are false because nothing has been seen, not because nothing happened.
 * `state` is the field that says which of the two a consumer is looking at.
 */
export type LeadNoticeState = 'read' | 'queued_unread' | 'never_idle' | 'no_lead' | 'pending';

export interface LeadNoticeOutcome {
  /** The notice was injected into the lead's session (not merely queued). */
  signalled: boolean;
  /** The lead consumed it before the deadline. */
  read: boolean;
  /**
   * An outcome is an observation, so it is never `pending`: a port that has
   * looked at a lead always has something to say about it, and the placeholder
   * is the runner's own, minted before anyone looked.
   */
  state: Exclude<LeadNoticeState, 'pending'>;
}

/**
 * The interface this package needs from the orchestrator, and deliberately the
 * whole of it. The primitives behind it — `Session.armNotice(text, {idleMs,
 * deadlineMs})` and the pre-minted mailbox id that makes `read` observable —
 * belong to the orchestrator work package (`modules/orchestrator/session.ts`).
 *
 * `warnLead` MUST resolve by `deadlineMs` and MUST NOT throw: an update
 * proceeds at its deadline no matter what. Giving a live agent the ability to
 * block an operator action would be a veto, not a warning.
 */
export interface TeamsPort {
  /** Teams alive right now. Snapshotted BEFORE the update — by the time the
   *  new container boots, the DB rows have all been flipped to `interrupted`. */
  listActiveTeams(): ActiveTeam[];
  warnLead(team: ActiveTeam, text: string, opts: { deadlineMs: number }): Promise<LeadNoticeOutcome>;
  /**
   * "The window is over, now" — the runner calls it the instant the grace
   * window settles, and the reason says why.
   *
   * It exists because `deadlineMs` is a PROMISE the runner may break early:
   * `applyNow()` truncates the window and `cancel()` abolishes it, while a port
   * that only knows the original deadline would still be sitting on its own
   * timer. On the apply-now path that timer never fires — the container is
   * being recreated first — so without this signal `teams_warned_json` is
   * written for a run nobody will ever read it from. Every outstanding
   * `warnLead` must therefore settle here, with what was OBSERVED by now.
   *
   * `cancelled` additionally means "stop trying to type at the leads": the
   * restart is off, so an armed notice has nothing left to announce.
   *
   * Optional: a port without it still works — the runner falls back to waiting
   * a beat on the outcomes — so this stays a courtesy, never a requirement.
   * Implementations MUST be idempotent and MUST NOT throw.
   */
  endWindow?(reason: GraceEndReason): void;
}

/** Why a grace window stopped. `deadline` is the ordinary one. */
export type GraceEndReason = 'deadline' | 'now' | 'cancelled';

/** One row of `teams_warned_json`. */
export interface WarnedTeamRecord {
  orch_id: string;
  orch_name: string;
  lead_id: string | null;
  signalled: boolean;
  read: boolean;
  state: LeadNoticeState;
}

/**
 * Why a team of the pre-update snapshot is (or is not) back after the restart.
 * Mirrors `Spawner.TeamReconcileReason`; redeclared rather than imported so
 * this package keeps depending on no orchestrator type at all.
 */
export type TeamReconcileReason = 'ok' | 'absent' | 'not_running' | 'no_lead' | 'lead_dead';

/**
 * One row of `teams_reconciled_json` (§D.6) — the post-update screen's raw
 * material. Snake_case like `WarnedTeamRecord`, because it is persisted JSON
 * served verbatim, not a view model.
 */
export interface ReconciledTeamRecord {
  orch_id: string;
  orch_name: string;
  /** Lead session id BEFORE the update. */
  lead_id: string | null;
  /** Live, non-terminal, with a live lead. */
  back: boolean;
  /** Lead id now — differs from `lead_id` after a fresh restart-in-place. */
  lead_id_now: string | null;
  /** Orchestrator status now; `null` when it is not in the live map at all. */
  status: string | null;
  reason: TeamReconcileReason;
}

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP status in `routes/updates.ts`.
// ---------------------------------------------------------------------------

export class UpdateBusyError extends Error {
  constructor(public readonly runId: string) {
    super(`an update run is already in flight (${runId})`);
    this.name = 'UpdateBusyError';
  }
}

export class UpdateInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateInvalidInputError';
  }
}

// ---------------------------------------------------------------------------

export interface ApplyInput {
  kind?: UpdateRunKind;
  /** Version to install, e.g. `0.6.0` (a leading `v` is tolerated). */
  targetVersion?: string | null;
  /** Explicit image reference; overrides `targetVersion`. Mostly for tests. */
  targetImage?: string | null;
  /** Seconds of warning. Floored at 120 unless no team is active (then 0). */
  graceSeconds?: number;
}

export interface ScheduleInput extends ApplyInput {
  /** ISO 8601 datetime. */
  at: string;
}

export type SpawnJobFn = (argv: string[]) => Promise<{ jobId: string }>;
export type HostRunFn = (argv: string[], timeoutMs: number) => Promise<{ code: number | null }>;

export interface UpdateRunnerOptions {
  config: Config;
  store: UpdateStore;
  /** Absent ⇒ no team is ever warned and the grace window is 0. */
  teams?: TeamsPort;
  /** Test seam. Defaults to `spawnHostJob(config, '_system', …)`. */
  spawnJob?: SpawnJobFn;
  /** Test seam for the short `restore-env` recovery exec. */
  hostRun?: HostRunFn;
  /** Test seam. Defaults to `installHostUpdateScript`. */
  installScript?: (dataDir: string) => InstalledHostScript;
  /** Test seam. Defaults to `assertInstalledScriptMatches`. */
  verifyScript?: (scriptPath: string) => void;
  now?: () => number;
  pollIntervalMs?: number;
  keepRuns?: number;
}

export interface UpdateRunView {
  id: string;
  kind: string;
  state: UpdateRunState;
  targetVersion: string | null;
  scheduledFor: string | null;
  warnedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Live phase from `events.ndjson`; `null` for a run with no events yet. */
  phase: string | null;
  envFile: string | null;
  teamsSnapshot: ActiveTeam[];
  teamsWarned: WarnedTeamRecord[];
  /**
   * §D.6 — which of `teamsSnapshot` came back, as reconciled by the boot that
   * followed the update. Empty until that boot has happened (and for a run
   * that never restarted anything).
   */
  teamsReconciled: ReconciledTeamRecord[];
  /** Seconds left in the grace window; `null` outside `warning_teams`. */
  graceRemainingSeconds: number | null;
  terminal: boolean;
}

export interface UpdateRunDetail extends UpdateRunView {
  runDir: string;
  envLineBefore: string | null;
  logTail: string;
  result: HostUpdateResult | null;
}

interface PendingGrace {
  runId: string;
  /** Wall-clock ms at which the update proceeds regardless. */
  deadlineMs: number;
  timer: NodeJS.Timeout;
  resolve: (reason: GraceEndReason) => void;
  settled: boolean;
}

export class UpdateRunner {
  private readonly config: Config;
  private readonly store: UpdateStore;
  private readonly teams: TeamsPort | null;
  private readonly spawnJob: SpawnJobFn;
  private readonly hostRun: HostRunFn;
  private readonly installScript: (dataDir: string) => InstalledHostScript;
  private readonly verifyScript: (scriptPath: string) => void;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly keepRuns: number;

  private scriptInfo: InstalledHostScript | null = null;
  /** The run this process is driving, if any. */
  private activeRunId: string | null = null;
  private grace: PendingGrace | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchRunId: string | null = null;
  private spawnedAtMs: number | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private scheduledRunId: string | null = null;
  private stopped = false;

  constructor(opts: UpdateRunnerOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.teams = opts.teams ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.keepRuns = opts.keepRuns ?? DEFAULT_KEEP_RUNS;
    this.installScript = opts.installScript ?? installHostUpdateScript;
    this.verifyScript = opts.verifyScript ?? assertInstalledScriptMatches;
    this.hostRun =
      opts.hostRun ??
      (async (argv, timeoutMs) => {
        const r = await hostExec(this.config, { argv, timeoutMs });
        return { code: r.code };
      });
    this.spawnJob =
      opts.spawnJob ?? ((argv) => spawnHostJob(this.config, SYSTEM_JOB_NAMESPACE, { argv }));
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Boot: install the script, prune old runs, conclude or abandon anything left
   * in flight, and re-arm a pending schedule. Never throws — a failure here
   * must not stop the server from starting.
   */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.scriptInfo = this.installScript(this.config.dataDir);
      log.info({
        event: 'updates.script_installed',
        path: this.scriptInfo.path,
        version: this.scriptInfo.version,
        sha256: this.scriptInfo.sha256.slice(0, 12),
      });
    } catch (err) {
      log.error({ event: 'updates.script_install_failed', error: String(err) });
    }
    try {
      this.prune();
    } catch (err) {
      log.warn({ event: 'updates.prune_failed', error: String(err) });
    }
    try {
      await this.resumeUnfinished();
    } catch (err) {
      log.error({ event: 'updates.resume_failed', error: String(err) });
    }
  }

  /** Clear every timer. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchRunId = null;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    if (this.grace) {
      clearTimeout(this.grace.timer);
      this.grace = null;
    }
  }

  // -- queries --------------------------------------------------------------

  isBusy(): boolean {
    return this.store.listActive().length > 0;
  }

  /** The run in flight (or scheduled), if any. */
  currentRun(): UpdateRunView | null {
    const rows = this.store.listActive();
    const row = rows[rows.length - 1];
    return row ? this.toView(row) : null;
  }

  listRuns(limit = 20): UpdateRunView[] {
    return this.store.listRecent(limit).map((r) => this.toView(r));
  }

  getRun(id: string): UpdateRunDetail | null {
    const row = this.store.get(id);
    if (!row) return null;
    return {
      ...this.toView(row),
      runDir: row.run_dir,
      envLineBefore: row.env_line_before,
      logTail: readEventsTail(row.run_dir),
      result: readResult(row.run_dir),
    };
  }

  /** For `GET /updates` — the version + sha of the updater that would run. */
  scriptDescriptor(): { version: string; sha256: string } | null {
    return this.scriptInfo ? { version: this.scriptInfo.version, sha256: this.scriptInfo.sha256 } : null;
  }

  // -- commands -------------------------------------------------------------

  /** Start now (after the grace window). 409-shaped error when one is in flight. */
  async apply(input: ApplyInput = {}): Promise<{ runId: string }> {
    const busy = this.store.listActive()[0];
    if (busy) throw new UpdateBusyError(busy.id);
    const targetImage = this.resolveTargetImage(input);
    const runId = this.mintRunId();
    const runDir = this.createRunDir(runId);
    const nowIso = new Date(this.now()).toISOString();
    this.store.insert({
      id: runId,
      kind: input.kind ?? 'system',
      state: 'scheduled',
      target_version: normalizeVersion(input.targetVersion) ?? null,
      scheduled_for: nowIso,
      warned_at: null,
      started_at: null,
      finished_at: null,
      run_dir: runDir,
      env_file: null,
      env_line_before: null,
      teams_snapshot_json: null,
      teams_warned_json: null,
      teams_reconciled_json: null,
      error: null,
      log_tail: null,
    });
    this.activeRunId = runId;
    // Not awaited: the caller gets a 202 and watches the run. `drive` never
    // rejects — every failure inside it becomes a persisted terminal state.
    void this.drive(runId, targetImage, input.graceSeconds);
    return { runId };
  }

  /**
   * Lot E — a **one-shot** `setTimeout`, re-armed at boot from the store.
   * Deliberately not `CronScheduler`/croner: a cron models a recurring cadence
   * read from a table, and an update is a single decision at a single datetime.
   */
  schedule(input: ScheduleInput): { runId: string; at: string } {
    const busy = this.store.listActive()[0];
    if (busy) throw new UpdateBusyError(busy.id);
    const atMs = Date.parse(input.at);
    if (!Number.isFinite(atMs)) {
      throw new UpdateInvalidInputError(`"at" is not a valid ISO 8601 datetime: ${input.at}`);
    }
    // Validate the target NOW rather than at fire time — an operator finding out
    // at 3am that their scheduled update was never runnable is not a schedule.
    this.resolveTargetImage(input);
    const runId = this.mintRunId();
    const runDir = this.createRunDir(runId);
    const at = new Date(atMs).toISOString();
    this.store.insert({
      id: runId,
      kind: input.kind ?? 'system',
      state: 'scheduled',
      target_version: normalizeVersion(input.targetVersion) ?? null,
      scheduled_for: at,
      warned_at: null,
      started_at: null,
      finished_at: null,
      run_dir: runDir,
      env_file: null,
      env_line_before: null,
      teams_snapshot_json: JSON.stringify({ graceSeconds: input.graceSeconds ?? null }),
      teams_warned_json: null,
      teams_reconciled_json: null,
      error: null,
      log_tail: null,
    });
    this.armSchedule(runId, atMs, input);
    log.info({ event: 'updates.scheduled', runId, at });
    return { runId, at };
  }

  /** Cancel a pending schedule. Returns false when there was nothing to cancel. */
  cancelSchedule(): boolean {
    const row = this.store.listActive().find((r) => r.state === 'scheduled' && r.started_at === null);
    if (!row) return false;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.scheduledRunId = null;
    this.store.patch(row.id, {
      state: 'cancelled',
      finished_at: new Date(this.now()).toISOString(),
      error: 'Schedule cancelled by the operator.',
    });
    log.info({ event: 'updates.schedule_cancelled', runId: row.id });
    return true;
  }

  /**
   * Cancel during the grace window (or before it starts). Once the host job has
   * been spawned there is nothing to cancel: the script owns the outcome, and
   * "cancelling" it mid-`up` would be the worst of both states.
   *
   * Settling the grace window is also what tells the teams port to stand down
   * (`endWindow('cancelled')`, in `warnTeams` right after the await): a run
   * nobody is applying must stop typing into leads' terminals.
   */
  cancel(runId?: string): boolean {
    const rows = this.store.listActive();
    const row = runId ? rows.find((r) => r.id === runId) : rows[rows.length - 1];
    if (!row) return false;
    if (row.state !== 'scheduled' && row.state !== 'warning_teams') return false;
    // A run that has not started yet is a pending schedule: go through the
    // schedule path so its timer is actually disarmed, not just its row.
    if (row.state === 'scheduled' && row.started_at === null) return this.cancelSchedule();
    this.store.patch(row.id, {
      state: 'cancelled',
      finished_at: new Date(this.now()).toISOString(),
      error: 'Cancelled by the operator during the warning window.',
    });
    if (this.grace && this.grace.runId === row.id) this.settleGrace('cancelled');
    log.info({ event: 'updates.cancelled', runId: row.id });
    return true;
  }

  /**
   * Skip the rest of the grace window and proceed immediately.
   *
   * The truncation is signalled to the teams port (`endWindow('now')`, in
   * `warnTeams` right after the await) — otherwise the port would still be
   * waiting on the ORIGINAL deadline, which on this path never arrives: the
   * container is recreated first, and the warning record would die with it.
   */
  applyNow(runId?: string): boolean {
    if (!this.grace) return false;
    if (runId && this.grace.runId !== runId) return false;
    this.settleGrace('now');
    return true;
  }

  // -- the run ---------------------------------------------------------------

  private async drive(runId: string, targetImage: string, graceSeconds?: number): Promise<void> {
    try {
      const proceeded = await this.warnTeams(runId, targetImage, graceSeconds);
      if (!proceeded) return; // cancelled — already terminal
      await this.spawn(runId, targetImage);
    } catch (err) {
      log.error({ event: 'updates.drive_failed', runId, error: String(err) });
      this.conclude(runId, 'failed', `The update could not be started: ${String(err)}`);
    }
  }

  /**
   * §D.5 — warn every lead, then proceed AT THE DEADLINE, always. The window is
   * global because `up -d` is: every team is interrupted at the same instant.
   * Returns false when the run was cancelled during the window.
   */
  private async warnTeams(runId: string, targetImage: string, graceSeconds?: number): Promise<boolean> {
    const listed = this.safeListTeams();
    // `null` is "we could not ask", which is NOT "there is nobody to warn".
    // Every other decision in this feature fails toward "don't know"; failing
    // open here would mean a 0 s window, an immediate `up -d` and a
    // `teams_warned: []` record of teams that were never asked. So assume
    // somebody is there and take the ordinary window.
    const teamsUnknown = listed === null;
    const snapshot = listed ?? [];
    const graceS = resolveGraceSeconds(graceSeconds, teamsUnknown ? 1 : snapshot.length);
    const nowIso = new Date(this.now()).toISOString();
    this.store.patch(runId, {
      state: 'warning_teams',
      warned_at: nowIso,
      started_at: nowIso,
      teams_snapshot_json: JSON.stringify(snapshot),
      // Overwritten by the verdict later; for the length of the window it is
      // the only place an operator can see that the list is a guess.
      ...(teamsUnknown ? { error: TEAMS_UNKNOWN_NOTE } : {}),
    });

    // The record the operator's screen is built from, written NOW rather than
    // at the deadline. `teams_warned_json` stayed null for the whole window
    // before this, which reads as "no team is active — nothing to interrupt"
    // for exactly as long as anyone is looking at it, while three teams are
    // about to be killed.
    //
    // Every row is `pending`, which asserts nothing: the window has just opened
    // and no lead has been observed. It used to be `never_idle` — a verdict, on
    // the grounds that it is where a lead that never answers ends up anyway —
    // and that was a claim about the ONE thing we could not yet know. `warnLead`
    // settles early on a read and on nothing else, so a lead whose PTY notice
    // had already fired carried "never reached an idle boundary" for the whole
    // window, and the countdown rendered "(busy for 4m31)" about it. The verdict
    // is written below, when the observation lands.
    const pending = new Map<string, WarnedTeamRecord>(
      snapshot.map((team) => [team.orchestratorId, pendingRecord(team)]),
    );
    this.persistWarned(runId, [...pending.values()]);

    // NOTE the missing `snapshot.length === 0`: with the team list UNKNOWN the
    // snapshot is empty and there is nobody to warn, but the window is still
    // owed — it is the only protection left for teams we could not enumerate.
    if (graceS === 0 || this.teams === null) {
      return this.store.get(runId)?.state === 'warning_teams';
    }

    const deadlineMs = this.now() + graceS * 1000;
    const text = warningText(targetImage, graceS);
    const port = this.teams;
    // Fire every warning, then wait out the window. A lead that never goes idle
    // is a `never_idle` record, not a blocked update.
    const outcomes: Promise<WarnedTeamRecord[]> = Promise.all(
      snapshot.map(async (team): Promise<WarnedTeamRecord> => {
        const record = await this.observeLead(port, team, text, deadlineMs, runId);
        // Re-persisted AS IT LANDS: a lead that reads the notice 30 s into a
        // 300 s window must show as read 30 s in, not once the window is over.
        pending.set(team.orchestratorId, record);
        this.persistWarned(runId, [...pending.values()]);
        return record;
      }),
    );

    // Persist the records WHENEVER they land, even after we have moved on: the
    // post-update screen ("my-project — notice left but never read") is built
    // from this column, and a slow lead must not cost us the record.
    void outcomes.then(
      (records) => this.persistWarned(runId, records),
      (err) => log.warn({ event: 'updates.warn_batch_failed', runId, error: String(err) }),
    );

    const reason = await this.waitGrace(runId, deadlineMs);
    // THE WINDOW IS OVER — and on `applyNow`/`cancel` it ended EARLY, so the
    // port is still holding a timer aimed at a deadline that will never arrive
    // (this container is about to be recreated). Telling it settles every
    // outstanding `warnLead` with the state observed by now, and on a cancel
    // stands the armed notices down. One call site for all three reasons, so
    // any future way of settling the window is covered by construction.
    this.endTeamsWindow(port, reason);
    // Backstop for a port that does not implement `endWindow`: `warnLead` is
    // contractually resolved BY the deadline, so give it a beat rather than
    // spawn without a record.
    const settled = await Promise.race([
      outcomes.catch(() => null),
      delay(1_000).then(() => null),
    ]);
    // Persisting HERE — and not only in the `.then` above — is what makes
    // "records before the spawn" an ordering GUARANTEE instead of a microtask
    // coincidence. Writing twice is free: same content, last write wins.
    if (settled) this.persistWarned(runId, settled);
    return reason !== 'cancelled';
  }

  /**
   * One team's outcome, as a record. Never rejects — a `warnLead` that throws
   * is "nobody was reached", which is what `never_idle` says.
   */
  private async observeLead(
    port: TeamsPort,
    team: ActiveTeam,
    text: string,
    deadlineMs: number,
    runId: string,
  ): Promise<WarnedTeamRecord> {
    try {
      const r = await port.warnLead(team, text, { deadlineMs });
      return {
        orch_id: team.orchestratorId,
        orch_name: team.name,
        lead_id: team.leadSessionId,
        signalled: r.signalled,
        read: r.read,
        state: r.state,
      };
    } catch (err) {
      log.warn({ event: 'updates.warn_failed', runId, team: team.orchestratorId, error: String(err) });
      // NOT the placeholder: this IS an observation. We asked, the ask failed,
      // so nothing reached the agent — which is what `never_idle` says.
      return unreachedRecord(team);
    }
  }

  /**
   * Write `teams_warned_json`. Idempotent, and never throws: an update that
   * failed because its audit row would not save would be a worse outcome than
   * an update whose audit row is missing — and the failure is logged either
   * way.
   */
  private persistWarned(runId: string, records: WarnedTeamRecord[]): void {
    try {
      this.store.patch(runId, { teams_warned_json: JSON.stringify(records) });
    } catch (err) {
      log.warn({ event: 'updates.warned_persist_failed', runId, error: String(err) });
    }
  }

  /** Tell the port the window is over. Optional on the interface, never fatal. */
  private endTeamsWindow(port: TeamsPort, reason: GraceEndReason): void {
    if (!port.endWindow) return;
    try {
      port.endWindow(reason);
    } catch (err) {
      // The contract says it must not throw; if one ever does, the update still
      // proceeds — the alternative is a live agent vetoing an operator action.
      log.warn({ event: 'updates.end_window_failed', reason, error: String(err) });
    }
  }

  private waitGrace(runId: string, deadlineMs: number): Promise<GraceEndReason> {
    return new Promise((resolve) => {
      const delay = Math.max(0, deadlineMs - this.now());
      const timer = setTimeout(() => this.settleGrace('deadline'), delay);
      timer.unref?.();
      this.grace = { runId, deadlineMs, timer, resolve, settled: false };
    });
  }

  private settleGrace(reason: GraceEndReason): void {
    const g = this.grace;
    if (!g || g.settled) return;
    g.settled = true;
    clearTimeout(g.timer);
    this.grace = null;
    g.resolve(reason);
  }

  /** preflight → spawn the detached host job. */
  private async spawn(runId: string, targetImage: string): Promise<void> {
    const row = this.store.get(runId);
    if (!row) return;
    this.store.patch(runId, { state: 'preflight' });

    if (this.config.agentTransport !== 'ssh' || !this.config.hostDataDir) {
      this.conclude(
        runId,
        'refused',
        'This instance runs agents in-container (SWARM_OS_AGENT_TRANSPORT=local), so it has no way to run docker on the host. Nothing was touched.',
      );
      return;
    }

    let script: InstalledHostScript;
    try {
      script = this.scriptInfo ?? this.installScript(this.config.dataDir);
      this.scriptInfo = script;
      // The refusal from §D.3: never run an updater that is not the one this
      // build shipped.
      this.verifyScript(script.path);
    } catch (err) {
      this.conclude(runId, 'refused', `The host updater could not be prepared: ${String(err)}`);
      return;
    }

    const argv = buildHostUpdateArgv({
      scriptPath: translateCwdForHost(this.config, script.path),
      runDir: translateCwdForHost(this.config, row.run_dir),
      runId,
      hostDataDir: this.config.hostDataDir,
      dataMount: this.config.dataDir,
      containerHint: readContainerHint(),
      targetImage,
      envVar: 'SWARM_OS_IMAGE',
      healthPort: this.config.port,
    });

    this.spawnedAtMs = this.now();
    let jobId: string;
    try {
      const ref = await this.spawnJob(argv);
      jobId = ref.jobId;
    } catch (err) {
      // ⚠️ "The launcher rejected" is NOT "the script never ran". `spawnHostJob`
      // rejects on `res.timedOut` after 15 s, and by then `setsid bash -c … &`
      // has long since detached: a stalled ssh return and a job that never
      // launched are the same value. So ask the run directory, which only the
      // script writes — anything in it means something IS running on the host,
      // and calling that `refused` ("nothing was touched") would stop the watch
      // while the script rewrites `.env` and recreates this container.
      if (hostJobStarted(row.run_dir)) {
        log.warn({
          event: 'updates.launcher_uncertain',
          runId,
          error: String(err),
          note: 'the launcher did not return cleanly but the run directory says the host job started; watching it',
        });
        this.startWatch(runId);
        return;
      }
      // Nothing on the host was touched — that is a refusal, not a failure.
      this.conclude(runId, 'refused', `The host updater could not be launched: ${String(err)}`);
      return;
    }
    // Best-effort, and deliberately AFTER the spawn: `spawnHostJob` mints the
    // jobId internally. Nothing reads this except a human debugging a run.
    try {
      fs.writeFileSync(
        jobRefPath(row.run_dir),
        JSON.stringify({ jobId, spawnedAt: new Date(this.spawnedAtMs).toISOString(), scriptVersion: script.version }) + '\n',
        { mode: 0o600 },
      );
    } catch (err) {
      log.warn({ event: 'updates.job_ref_write_failed', runId, error: String(err) });
    }
    log.info({ event: 'updates.spawned', runId, jobId, target: targetImage, scriptVersion: script.version });
    this.startWatch(runId);
  }

  // -- watching -------------------------------------------------------------

  private startWatch(runId: string): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchRunId = runId;
    const timer = setInterval(() => {
      try {
        this.tick(runId);
      } catch (err) {
        log.warn({ event: 'updates.watch_tick_failed', runId, error: String(err) });
      }
    }, this.pollIntervalMs);
    timer.unref?.();
    this.watchTimer = timer;
    // One immediate pass so a run that finished during a restart concludes at
    // once rather than one poll interval later.
    this.tick(runId);
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchRunId = null;
  }

  private tick(runId: string): void {
    if (this.stopped) return;
    const row = this.store.get(runId);
    if (!row || TERMINAL_UPDATE_STATES.has(row.state as UpdateRunState)) {
      if (this.watchRunId === runId) this.stopWatch();
      return;
    }
    const result = readResult(row.run_dir);
    if (result) {
      this.applyResult(row, result);
      if (this.watchRunId === runId) this.stopWatch();
      return;
    }
    const events = readEvents(row.run_dir);
    const progress = summarizeProgress(events);
    const next = phaseToState(progress.lastPhase);
    if (next && next !== row.state) {
      this.store.patch(runId, { state: next });
    }
    if (progress.envFile && row.env_file === null) {
      this.store.patch(runId, {
        env_file: progress.envFile,
        env_line_before: progress.envLineBefore,
      });
    }
    if (!isRunAlive(row.run_dir, this.now(), this.spawnedAtMs)) {
      // A `store.patch` that throws (full disk, SQLITE_BUSY) used to be logged
      // and dropped with the watch already stopped: the row stayed
      // non-terminal, so `isBusy()` was true forever and every
      // `POST /updates/apply` answered 409 with no way out but a DB edit.
      // Re-arm instead — one poll interval later, so the retry cannot recurse.
      void this.markAbandoned(this.store.get(runId) ?? row).catch((err: unknown) => {
        log.error({ event: 'updates.mark_abandoned_failed', runId, error: String(err) });
        this.rearmWatch(runId);
      });
      if (this.watchRunId === runId) this.stopWatch();
    }
  }

  /**
   * Put the watch back after a failed terminal write, one poll interval later.
   * Deliberately NOT immediate: `startWatch` ticks straight away, and a tick
   * that fails the same way would recurse without ever yielding.
   */
  private rearmWatch(runId: string): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      if (this.stopped || this.watchTimer !== null) return;
      const row = this.store.get(runId);
      if (!row || TERMINAL_UPDATE_STATES.has(row.state as UpdateRunState)) return;
      this.startWatch(runId);
    }, this.pollIntervalMs);
    timer.unref?.();
  }

  // -- terminal transitions --------------------------------------------------

  private applyResult(row: UpdateRunRow, result: HostUpdateResult): void {
    const state = resultToState(result);
    const envLineBefore =
      row.env_line_before ??
      (result.env_line_before_b64 ? decodeB64(result.env_line_before_b64) : null);
    // The one non-obvious mapping: "healthy but never reported boot_complete"
    // is a SUCCESS carrying a review note. Rolling back there would kill the
    // teams a second time to fix a container that is answering requests.
    const review =
      state === 'success' && result.verify === 'healthy_no_boot_complete'
        ? `${result.message ?? ''} [manual review: the new container served /health but never reported boot_complete]`.trim()
        : null;
    this.store.patch(row.id, {
      state,
      finished_at: result.finished_at ?? new Date(this.now()).toISOString(),
      error: state === 'success' ? review : (result.message ?? result.reason ?? null),
      env_file: row.env_file ?? result.env_file ?? null,
      env_line_before: envLineBefore,
      log_tail: readEventsTail(row.run_dir, 8 * 1024),
    });
    if (this.activeRunId === row.id) this.activeRunId = null;
    log.info({
      event: 'updates.run_finished',
      runId: row.id,
      state,
      reason: result.reason,
      verify: result.verify,
      scriptVersion: result.script_version,
    });
    // §D.4 again, from the OTHER direction. `markAbandoned` repairs a
    // half-written `.env` only when there is no `result.json` at all; a SIGTERM
    // during `compose up` (host reboot, `killJob`, OOM) writes one — `failed`,
    // `env_written`, not `deployed` — and until now that mapped straight to
    // `failed` and stopped. The operator's file is then pointing at an image
    // that is not running, and the next reboot would come up on it unverified.
    // Same repair, same condition, fire-and-forget so a boot is never held on
    // an ssh round trip.
    const envFile = row.env_file ?? result.env_file ?? null;
    if (state === 'failed' && result.env_written === true && result.deployed !== true && envFile && envLineBefore) {
      void this.repairEnvLine(row.id, envFile, envLineBefore);
    }
    try {
      this.prune();
    } catch {
      /* janitor failures are never fatal */
    }
  }

  /**
   * Put the `.env` line back for a run whose verdict says it was written but
   * never deployed, and append what happened to the run's own message. Never
   * rejects: the run is already terminal, and losing the note is better than an
   * unhandled rejection on the boot path.
   */
  private async repairEnvLine(runId: string, envFile: string, envLineBefore: string): Promise<void> {
    const restored = await this.restoreEnvLine(envFile, envLineBefore, BOOT_RESTORE_TIMEOUT_MS);
    const note = restored
      ? `The SWARM_OS_IMAGE line in ${envFile} had been rewritten but never deployed; it has been restored.`
      : `⚠️ The SWARM_OS_IMAGE line in ${envFile} was rewritten but never deployed, and restoring it FAILED — the .bak beside it holds the original. Fix it before the next reboot, or the host will come up on an image that was never verified.`;
    log.warn({ event: 'updates.env_repaired', runId, envFile, restored });
    try {
      const current = this.store.get(runId);
      this.store.patch(runId, { error: `${current?.error ?? ''} ${note}`.trim() });
    } catch (err) {
      log.warn({ event: 'updates.env_repair_note_failed', runId, error: String(err) });
    }
  }

  /**
   * §D.4 — no result, stale heartbeat: the host went away mid-run. If the
   * events say the env line was written but never deployed, the operator's file
   * is pointing at an image that is not running; put it back.
   */
  private async markAbandoned(row: UpdateRunRow, restoreTimeoutMs = RESTORE_TIMEOUT_MS): Promise<void> {
    if (TERMINAL_UPDATE_STATES.has(row.state as UpdateRunState)) return;
    const progress = summarizeProgress(readEvents(row.run_dir));
    let note =
      'The updater stopped without recording a verdict (its heartbeat went stale and no result.json was written) — most likely the host restarted mid-run. Nothing further will happen on its own; retry when the host is back.';
    if (progress.envWritten && !progress.deployed && progress.envFile && progress.envLineBefore) {
      const restored = await this.restoreEnvLine(progress.envFile, progress.envLineBefore, restoreTimeoutMs);
      note += restored
        ? ` The ${'SWARM_OS_IMAGE'} line in ${progress.envFile} had been rewritten but never deployed; it has been restored.`
        : ` ⚠️ The ${'SWARM_OS_IMAGE'} line in ${progress.envFile} was rewritten but never deployed, and restoring it FAILED — the .bak beside it holds the original. Fix it before the next reboot, or the host will come up on an image that was never verified.`;
    }
    this.store.patch(row.id, {
      state: 'abandoned',
      finished_at: new Date(this.now()).toISOString(),
      error: note,
      env_file: row.env_file ?? progress.envFile,
      env_line_before: row.env_line_before ?? progress.envLineBefore,
      log_tail: readEventsTail(row.run_dir, 8 * 1024),
    });
    if (this.activeRunId === row.id) this.activeRunId = null;
    log.warn({ event: 'updates.run_abandoned', runId: row.id, envWritten: progress.envWritten });
  }

  /** Short foreground exec — the same script, in its `restore-env` mode. */
  private async restoreEnvLine(
    envFile: string,
    envLineBefore: string,
    timeoutMs = RESTORE_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.config.agentTransport !== 'ssh') return false;
    let script: InstalledHostScript;
    try {
      script = this.scriptInfo ?? this.installScript(this.config.dataDir);
      this.scriptInfo = script;
      this.verifyScript(script.path);
    } catch (err) {
      log.error({ event: 'updates.restore_script_unavailable', error: String(err) });
      return false;
    }
    const argv = buildRestoreEnvArgv({
      scriptPath: translateCwdForHost(this.config, script.path),
      envFile,
      envVar: 'SWARM_OS_IMAGE',
      envLineBefore,
    });
    try {
      const r = await this.hostRun(argv, timeoutMs);
      return r.code === 0;
    } catch (err) {
      log.error({ event: 'updates.restore_env_failed', error: String(err) });
      return false;
    }
  }

  private conclude(runId: string, state: UpdateRunState, message: string): void {
    const row = this.store.get(runId);
    this.store.patch(runId, {
      state,
      finished_at: new Date(this.now()).toISOString(),
      error: message,
      log_tail: row ? readEventsTail(row.run_dir, 8 * 1024) : null,
    });
    if (this.activeRunId === runId) this.activeRunId = null;
    log.warn({ event: 'updates.run_concluded', runId, state, message });
  }

  // -- boot resume ----------------------------------------------------------

  private async resumeUnfinished(): Promise<void> {
    // `index.ts` awaits this whole method before `runAutoResume()`, so it is on
    // the critical path of every team coming back. The abandon writes are
    // therefore collected and awaited TOGETHER, each with a 10 s cap on its
    // `.env` restore: N rows cost ~10 s, not N × 60 s of teams staying down.
    const pending: Promise<void>[] = [];
    for (const row of this.store.listActive()) {
      try {
        pending.push(...this.resumeRow(row));
      } catch (err) {
        // One unreadable run must not stop the others from being concluded.
        log.error({ event: 'updates.resume_row_failed', runId: row.id, error: String(err) });
      }
    }
    await Promise.all(pending);
  }

  /** One row of `resumeUnfinished`; returns the async work it started, if any. */
  private resumeRow(row: UpdateRunRow): Promise<void>[] {
    const result = readResult(row.run_dir);
    if (result) {
      this.applyResult(row, result);
      return [];
    }
    if (row.state === 'scheduled' && row.started_at === null) {
      this.rearmFromRow(row);
      return [];
    }
    if (row.state === 'warning_teams') {
      // The warning window is wall-clock and team-local; a restart in the
      // middle of it destroys both. Do not silently resume into an `up -d`
      // nobody is expecting any more.
      this.conclude(
        row.id,
        'abandoned',
        'swarm-os restarted during the warning window, before anything was applied. Nothing was touched; start the update again when you are ready.',
      );
      return [];
    }
    // preflight / applying / verifying with no result: was a script running?
    if (isRunAlive(row.run_dir, this.now(), null)) {
      log.info({ event: 'updates.resume_watching', runId: row.id, state: row.state });
      this.spawnedAtMs = null;
      this.activeRunId = row.id;
      this.startWatch(row.id);
      return [];
    }
    return [
      this.markAbandoned(row, BOOT_RESTORE_TIMEOUT_MS).catch((err: unknown) => {
        log.error({ event: 'updates.mark_abandoned_failed', runId: row.id, error: String(err) });
      }),
    ];
  }

  private rearmFromRow(row: UpdateRunRow): void {
    const atMs = row.scheduled_for ? Date.parse(row.scheduled_for) : Number.NaN;
    if (!Number.isFinite(atMs)) {
      this.conclude(row.id, 'cancelled', 'Scheduled run had no usable datetime; dropped at boot.');
      return;
    }
    // ⚠️ A PAST-DUE datetime is not a schedule, it is a stale one, and re-arming
    // it fires `armSchedule`'s `remaining <= 0` branch SYNCHRONOUSLY inside
    // `start()` — which `index.ts` awaits BEFORE `runAutoResume()`. The
    // orchestrator map is empty at that instant, so the window would resolve to
    // 0 s and the container would be recreated at once, unwarned, while
    // auto-resume is still respawning the teams it is about to kill. Operator
    // schedules 02:00, host reboots 01:50, swarm-os returns at 09:00: what they
    // asked for is not "update seven hours late, without telling anyone".
    //
    // The runtime `schedule()` path stays as it was — there the teams ARE live,
    // so an `at` in the past is an ordinary apply-now with a real window.
    if (atMs <= this.now()) {
      this.conclude(
        row.id,
        'cancelled',
        `This update was scheduled for ${row.scheduled_for} but the scheduled time passed while swarm-os was down, so it was NOT applied. Nothing was touched; schedule it again when you are ready.`,
      );
      log.warn({ event: 'updates.schedule_stale', runId: row.id, at: row.scheduled_for });
      return;
    }
    let graceSeconds: number | undefined;
    try {
      const meta = row.teams_snapshot_json ? (JSON.parse(row.teams_snapshot_json) as { graceSeconds?: number | null }) : null;
      if (meta && typeof meta.graceSeconds === 'number') graceSeconds = meta.graceSeconds;
    } catch {
      /* the column is also used for the team snapshot; a mismatch is fine */
    }
    this.armSchedule(row.id, atMs, {
      targetVersion: row.target_version,
      kind: row.kind as UpdateRunKind,
      graceSeconds,
    });
    log.info({ event: 'updates.schedule_rearmed', runId: row.id, at: row.scheduled_for });
  }

  /**
   * One-shot timer, chunked so a far-future datetime does not overflow
   * `setTimeout`'s 32-bit delay (which would fire immediately — i.e. update
   * now instead of next month).
   */
  private armSchedule(runId: string, atMs: number, input: ApplyInput): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduledRunId = runId;
    const arm = (): void => {
      const remaining = atMs - this.now();
      if (remaining <= 0) {
        this.scheduleTimer = null;
        this.scheduledRunId = null;
        void this.fireSchedule(runId, input);
        return;
      }
      const timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS));
      timer.unref?.();
      this.scheduleTimer = timer;
    };
    arm();
  }

  private async fireSchedule(runId: string, input: ApplyInput): Promise<void> {
    const row = this.store.get(runId);
    if (!row || row.state !== 'scheduled' || row.started_at !== null) return;
    let targetImage: string;
    try {
      targetImage = this.resolveTargetImage(input);
    } catch (err) {
      this.conclude(runId, 'refused', `Scheduled update could not resolve its target: ${String(err)}`);
      return;
    }
    this.activeRunId = runId;
    log.info({ event: 'updates.schedule_fired', runId, target: targetImage });
    await this.drive(runId, targetImage, input.graceSeconds);
  }

  // -- janitor ---------------------------------------------------------------

  /**
   * Keep the last N run directories and the last N `_system` host-job
   * directories. NOTE (reported, not fixed here): the general `host-jobs/`
   * directory has no janitor at all — pre-existing debt from v0.5.0, owned by
   * `ssh-exec.ts`, out of this package's scope.
   */
  prune(keep = this.keepRuns): void {
    const protectedDirs = new Set(this.store.listActive().map((r) => path.basename(r.run_dir)));
    pruneDirs(runsDir(this.config.dataDir), keep, protectedDirs);
    pruneDirs(path.join(this.config.dataDir, HOST_JOBS_SUBDIR, SYSTEM_JOB_NAMESPACE), keep, new Set());
  }

  // -- helpers ---------------------------------------------------------------

  /**
   * The live teams, or `null` for "the question could not be answered".
   *
   * The distinction is the whole point: a throw and "no team is active" used to
   * be the same value, and both collapsed to a 0 s grace window — i.e. the one
   * failure in this feature that failed toward the DESTRUCTIVE answer. `null`
   * is handled in `warnTeams`, which keeps the ordinary window.
   */
  private safeListTeams(): ActiveTeam[] | null {
    if (!this.teams) return [];
    try {
      return this.teams.listActiveTeams();
    } catch (err) {
      log.warn({ event: 'updates.list_teams_failed', error: String(err) });
      return null;
    }
  }

  /**
   * The image to install. `config.image` is `SWARM_OS_IMAGE` — the same
   * variable the compose interpolates — so retagging IT is exactly the edit the
   * script performs on the env file.
   */
  private resolveTargetImage(input: ApplyInput): string {
    if (input.targetImage) {
      if (!isValidImageRef(input.targetImage)) {
        throw new UpdateInvalidInputError(`"${input.targetImage}" is not a valid image reference`);
      }
      return input.targetImage;
    }
    const version = normalizeVersion(input.targetVersion);
    if (!version) {
      throw new UpdateInvalidInputError('targetVersion is required (e.g. "0.6.0")');
    }
    if (!this.config.image) {
      throw new UpdateInvalidInputError(
        'SWARM_OS_IMAGE is not set, so this deployment hardcodes its image tag and has no variable to rewrite.',
      );
    }
    // Same rule as `isRegistryRef` in `index.ts`, inlined to keep this module
    // out of an import cycle with the service that re-exports it. A single
    // segment (`swarm-os:latest`) is a LOCALLY BUILT image with nothing behind
    // it to pull — refuse here with the reason rather than let the host script
    // discover it as a failed `docker pull`.
    if (!this.config.image.includes('/')) {
      throw new UpdateInvalidInputError(
        `SWARM_OS_IMAGE is "${this.config.image}", a locally-built image with nothing to pull from. Point the deployment at a registry image (e.g. ghcr.io/nyyyxius/swarm-os:<tag>) to enable one-click updates.`,
      );
    }
    const target = retagImage(this.config.image, version);
    if (!isValidImageRef(target)) {
      throw new UpdateInvalidInputError(`computed target "${target}" is not a valid image reference`);
    }
    return target;
  }

  private mintRunId(): string {
    const iso = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${iso}-${randomUUID().slice(0, 8)}`;
  }

  private createRunDir(runId: string): string {
    const dir = runDirFor(this.config.dataDir, runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  }

  private toView(row: UpdateRunRow): UpdateRunView {
    const state = row.state as UpdateRunState;
    const terminal = TERMINAL_UPDATE_STATES.has(state);
    let phase: string | null = null;
    if (!terminal) {
      phase = summarizeProgress(readEvents(row.run_dir)).lastPhase;
    }
    let graceRemaining: number | null = null;
    if (state === 'warning_teams' && this.grace && this.grace.runId === row.id) {
      graceRemaining = Math.max(0, Math.ceil((this.grace.deadlineMs - this.now()) / 1000));
    }
    return {
      id: row.id,
      kind: row.kind,
      state,
      targetVersion: row.target_version,
      scheduledFor: row.scheduled_for,
      warnedAt: row.warned_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
      phase,
      envFile: row.env_file,
      teamsSnapshot: parseJsonArray<ActiveTeam>(row.teams_snapshot_json),
      teamsWarned: parseJsonArray<WarnedTeamRecord>(row.teams_warned_json),
      teamsReconciled: parseJsonArray<ReconciledTeamRecord>(row.teams_reconciled_json),
      graceRemainingSeconds: graceRemaining,
      terminal,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested independently of the class.
// ---------------------------------------------------------------------------

/**
 * `max(120, requested)`, default 300, and **0 only when no team is active**.
 * The floor exists because a warning shorter than two minutes is an
 * announcement: a lead mid-turn has no realistic chance of reaching an idle
 * boundary, reading the notice and wrapping up inside it.
 */
export function resolveGraceSeconds(requested: number | undefined, activeTeams: number): number {
  if (activeTeams <= 0) return 0;
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_GRACE_SECONDS;
  return Math.max(MIN_GRACE_SECONDS, Math.floor(requested));
}

/** Replace the tag of an image reference, leaving registry host + path intact. */
export function retagImage(image: string, version: string): string {
  if (image.includes('@sha256:')) {
    throw new UpdateInvalidInputError(
      `${image} is pinned by digest; rewriting a tag would not change what runs.`,
    );
  }
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  // A colon before the last slash is a registry PORT (`host:5000/name`), not a tag.
  const base = lastColon > lastSlash ? image.slice(0, lastColon) : image;
  return `${base}:${version}`;
}

/** `v0.6.0` / ` 0.6.0 ` → `0.6.0`; anything unusable → null. */
export function normalizeVersion(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return tagToVersion(trimmed);
}

/**
 * What `teams_warned_json` says about a team before anything has been observed
 * about its lead. Written the moment the window opens so the operator's screen
 * names everyone who is about to be interrupted for the whole of it, not only
 * after the deadline — and saying `pending`, which is the only thing that is
 * true at that instant.
 *
 * It is deliberately NOT a verdict. `never_idle` was one, and it survived until
 * the lead's outcome landed, i.e. until the deadline for any lead that did not
 * read the notice — including one whose notice had fired the moment the round
 * was armed. `signalled: false` here is a floor, not an observation.
 */
function pendingRecord(team: ActiveTeam): WarnedTeamRecord {
  return {
    orch_id: team.orchestratorId,
    orch_name: team.name,
    lead_id: team.leadSessionId,
    signalled: false,
    read: false,
    state: 'pending',
  };
}

/**
 * "We asked and nothing reached the agent" — the record for a `warnLead` that
 * threw, which the port contract says cannot happen and which is therefore
 * exactly the case worth recording honestly. An observation, unlike
 * `pendingRecord`: the attempt was made and it failed.
 */
function unreachedRecord(team: ActiveTeam): WarnedTeamRecord {
  return {
    orch_id: team.orchestratorId,
    orch_name: team.name,
    lead_id: team.leadSessionId,
    signalled: false,
    read: false,
    state: 'never_idle',
  };
}

/** Said out loud on the run when the live team list could not be read at all. */
const TEAMS_UNKNOWN_NOTE =
  'The list of live teams could not be read, so who is about to be interrupted is NOT known — the snapshot below is empty because nothing could be enumerated, not because nothing is running. The ordinary grace window is being observed anyway.';

/**
 * Did the host job get far enough to touch its run directory? Only the updater
 * script writes in there, so any of these existing means something IS running
 * on the host — whatever the ssh launcher said on its way out.
 */
function hostJobStarted(runDir: string): boolean {
  for (const file of [heartbeatPath(runDir), eventsPath(runDir), resultPath(runDir)]) {
    try {
      if (fs.existsSync(file)) return true;
    } catch {
      /* an unreadable run dir tells us nothing either way */
    }
  }
  return false;
}

/** The operator-facing warning text injected into each lead. */
export function warningText(targetImage: string, graceSeconds: number): string {
  const mins = Math.floor(graceSeconds / 60);
  const secs = graceSeconds % 60;
  const window = mins > 0 ? `${mins}m${secs > 0 ? ` ${secs}s` : ''}` : `${secs}s`;
  return (
    `[swarm-os] A system update to ${targetImage} will restart this container in ${window}. ` +
    'Your session will be interrupted wherever it happens to be. Finish or checkpoint what you are doing now — ' +
    'commit, write notes to your team log, and stop starting anything new. ' +
    'The update proceeds at the deadline whether or not this message has been read.'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Keep the newest `keep` entries of `dir` by name (run ids sort by time). */
function pruneDirs(dir: string, keep: number, protectedNames: ReadonlySet<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of doomed) {
    if (protectedNames.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      /* a directory we cannot remove is not worth failing a boot over */
    }
  }
}

/**
 * The container id, from `/etc/hostname`. A HINT only: the script validates it
 * against `Mounts[/data].Source` and falls back to scanning `docker ps` on the
 * same criterion, because several swarm-os deployments share a host.
 */
function readContainerHint(): string | null {
  try {
    const raw = fs.readFileSync('/etc/hostname', 'utf8').trim();
    return /^[0-9a-f]{12,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
