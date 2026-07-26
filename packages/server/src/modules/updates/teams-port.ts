/**
 * The orchestrator-facing seam of the update engine (plan §D.5, §D.6).
 *
 * `UpdateRunner` declares the narrow `TeamsPort` it needs; `Spawner` owns the
 * primitives (`warnLeads`, `leadNoticeStatus`, `snapshotLiveTeams`,
 * `reconcileTeams`). This file is the whole of the glue, and it exists because
 * the two sides are shaped differently on purpose:
 *
 *  - the runner asks to warn **one** team and await **that** team's outcome;
 *  - `warnLeads` warns **every** live lead in one synchronous round and returns
 *    handles, and `leadNoticeStatus` is a later, non-blocking poll over them.
 *
 * Bridging that honestly means: warn once for the whole window (the first
 * `warnLead` call of a window mints the round; the rest join it), then resolve
 * each team by polling its handle until the notice leaves the mailbox or the
 * deadline passes. Warning per team would re-arm every OTHER lead's notice on
 * every call — `armNotice` supersedes, and `warnLeads` clears the spawner's
 * eviction re-push map — so the second call would silently reset the first
 * lead's window. Hence one round, kept on one `Spawner` instance, for the whole
 * window: that map is in-memory and there is no second copy of it.
 *
 * Three contracts are preserved verbatim, because they are the point:
 *  1. `warnLead` resolves BY the deadline. A live agent must never hold an
 *     operator action hostage, so the deadline is a timer of its own and not a
 *     consequence of the poll cadence.
 *  2. `warnLead` never rejects. Anything unexpected is reported as
 *     `never_idle` — "nobody was reached" — which is exactly what a failure to
 *     warn means.
 *  3. `read` comes ONLY from the pre-minted id having left the mailbox
 *     (`leadNoticeStatus`), never from `delivered_at`, which `clearAll()`
 *     stamps at shutdown too.
 *
 * ⚠️ UNIT MISMATCH, handled here and nowhere else: the runner's
 * `opts.deadlineMs` is an ABSOLUTE epoch timestamp (`now() + grace*1000`),
 * while `warnLeads`/`Session.armNotice` take a DURATION (`deadlineAt =
 * Date.now() + deadlineMs`). Passing one for the other would arm notices that
 * expire ~57000 years from now, i.e. never report `never_idle`. The conversion
 * is one line below and it is load-bearing.
 *
 * ⚠️ THE WINDOW CAN END EARLY, and the port has to be told: `deadlineMs` is a
 * promise the runner may break. `applyNow()` truncates the window and
 * `cancel()` abolishes it, but the round's own deadline timer would still be
 * aimed at the original instant — which, on the apply-now path, never arrives:
 * the container is recreated first. `endWindow(reason)` is that signal. It
 * settles every outstanding `warnLead` with the state observed RIGHT NOW (a
 * final `leadNoticeStatus` pass, so a lead that read the notice in the last
 * second still counts as having read it) and, on `cancelled`, calls
 * `Spawner.cancelLeadNotices()` — the restart is off, so nothing should still
 * be waiting to type at a lead. The mailbox rows are kept on purpose (a lead
 * really was told something was coming; a message it may already have read must
 * not be retracted).
 */
import { withModule } from '../../logger.js';
import type {
  LeadWarning,
  LeadWarningStatus,
  TeamReconciliation,
  TeamSnapshotEntry,
} from '../spawner/index.js';
import type {
  ActiveTeam,
  GraceEndReason,
  LeadNoticeOutcome,
  ReconciledTeamRecord,
  TeamsPort,
  UpdateRunner,
} from './runner.js';
import type { UpdateRunRow, UpdateStore } from './store.js';

const log = withModule('updates.teams');

/** How often the read receipt is re-observed inside a warning window. */
export const DEFAULT_NOTICE_POLL_MS = 1_000;

/** Nothing reached the agent — also the honest verdict for any local failure. */
const NEVER_IDLE: LeadNoticeOutcome = Object.freeze({
  signalled: false,
  read: false,
  state: 'never_idle',
});
/** There was no live lead to warn at all (distinct from "never went idle"). */
const NO_LEAD: LeadNoticeOutcome = Object.freeze({ signalled: false, read: false, state: 'no_lead' });

/** The slice of `Spawner` the warning path uses — so a test can fake it. */
export interface WarnableSpawner {
  snapshotLiveTeams(): TeamSnapshotEntry[];
  warnLeads(
    text: string,
    opts: { deadlineMs: number; idleMs?: number; from?: string },
  ): LeadWarning[];
  leadNoticeStatus(warnings: LeadWarning[]): LeadWarningStatus[];
  /** Stand the armed PTY notices down; the mailbox rows are left alone. */
  cancelLeadNotices(warnings: LeadWarning[]): number;
}

/** The slice of `Spawner` the post-restart reconciliation uses. */
export interface ReconcilableSpawner {
  reconcileTeams(snapshot: TeamSnapshotEntry[]): TeamReconciliation;
}

export interface SpawnerTeamsPortOptions {
  /** Read-receipt poll cadence. The deadline has its own timer regardless. */
  pollIntervalMs?: number;
  now?: () => number;
}

/**
 * One `warnLeads()` round: the handles, the latest observed status per team,
 * and the waiters the runner is holding. Owns two timers — a poll (to notice a
 * read as it happens) and the deadline (to guarantee resolution).
 */
class WarningRound {
  private readonly waiters = new Map<string, Array<(o: LeadNoticeOutcome) => void>>();
  private readonly latest = new Map<string, LeadWarningStatus>();
  private pollTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private readonly spawner: WarnableSpawner,
    /** The handles. Kept for the whole window — the re-push map is keyed on them. */
    readonly warnings: LeadWarning[],
    /** Absolute epoch ms, as the runner counts it. */
    private readonly deadlineMs: number,
    private readonly pollIntervalMs: number,
    private readonly now: () => number,
  ) {}

  handleFor(orchestratorId: string): LeadWarning | null {
    return this.warnings.find((w) => w.orch_id === orchestratorId) ?? null;
  }

  /** Resolves when this team's notice is read, or at the deadline. Never rejects. */
  wait(orchestratorId: string): Promise<LeadNoticeOutcome> {
    if (this.done) return Promise.resolve(this.outcomeFor(orchestratorId));
    return new Promise<LeadNoticeOutcome>((resolve) => {
      const list = this.waiters.get(orchestratorId) ?? [];
      list.push(resolve);
      this.waiters.set(orchestratorId, list);
      this.arm();
    });
  }

  /** Settle everyone with the last thing we saw. Idempotent. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    // One last observation: a lead that read the notice between the previous
    // poll and the deadline deserves to be recorded as having read it.
    this.observe();
    const pending = [...this.waiters.entries()];
    this.waiters.clear();
    for (const [orchestratorId, resolvers] of pending) {
      const outcome = this.outcomeFor(orchestratorId);
      for (const resolve of resolvers) resolve(outcome);
    }
  }

  private arm(): void {
    if (this.done) return;
    if (this.deadlineTimer === null) {
      // The deadline is its own timer, NOT a poll-cadence side effect: the
      // update proceeds at the deadline, so the record of who was warned must
      // exist by then and not one poll interval later.
      const t = setTimeout(() => this.finish(), Math.max(0, this.deadlineMs - this.now()));
      t.unref?.();
      this.deadlineTimer = t;
    }
    if (this.pollTimer === null) {
      const t = setInterval(() => this.tick(), this.pollIntervalMs);
      t.unref?.();
      this.pollTimer = t;
      this.tick();
    }
  }

  private tick(): void {
    if (this.done) return;
    if (!this.observe()) {
      // The spawner is not answering; settle rather than spin on it.
      this.finish();
      return;
    }
    for (const [orchestratorId, resolvers] of [...this.waiters.entries()]) {
      const status = this.latest.get(orchestratorId);
      if (!status?.read) continue;
      this.waiters.delete(orchestratorId);
      const outcome = toOutcome(status);
      for (const resolve of resolvers) resolve(outcome);
    }
    const everyoneRead =
      this.warnings.length > 0 && this.warnings.every((w) => this.latest.get(w.orch_id)?.read);
    if (everyoneRead || this.now() >= this.deadlineMs) this.finish();
  }

  /** Refresh `latest` from the spawner. Returns false if it threw. */
  private observe(): boolean {
    try {
      for (const status of this.spawner.leadNoticeStatus(this.warnings)) {
        this.latest.set(status.orch_id, status);
      }
      return true;
    } catch (err) {
      log.warn({
        event: 'updates.lead_notice_status_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private outcomeFor(orchestratorId: string): LeadNoticeOutcome {
    const status = this.latest.get(orchestratorId);
    return status ? toOutcome(status) : NEVER_IDLE;
  }
}

function toOutcome(status: LeadWarningStatus): LeadNoticeOutcome {
  return { signalled: status.signalled, read: status.read, state: status.state };
}

/**
 * `TeamsPort` over a live `Spawner`. One instance per process — the round it
 * holds and the spawner's eviction re-push map are the same window.
 */
export class SpawnerTeamsPort implements TeamsPort {
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private round: WarningRound | null = null;
  /**
   * Identity of the round already attempted for this window, INCLUDING a
   * failed attempt (`round === null`). Without it, a `warnLeads` that throws
   * would be retried once per team.
   */
  private roundKey: string | null = null;

  constructor(
    private readonly spawner: WarnableSpawner,
    opts: SpawnerTeamsPortOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_NOTICE_POLL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  listActiveTeams(): ActiveTeam[] {
    return this.spawner.snapshotLiveTeams().map((t) => ({
      orchestratorId: t.orch_id,
      name: t.orch_name,
      leadSessionId: t.lead_id,
    }));
  }

  async warnLead(
    team: ActiveTeam,
    text: string,
    opts: { deadlineMs: number },
  ): Promise<LeadNoticeOutcome> {
    try {
      const round = this.roundFor(text, opts.deadlineMs);
      // The round is minted synchronously above, before any await, so N
      // concurrent calls share it and no lead is ever warned twice.
      if (!round) return NEVER_IDLE;
      if (!round.handleFor(team.orchestratorId)) {
        // `warnLeads` skips an orchestrator with no lead, or whose lead is
        // already terminal. Nobody was there to warn — which is not the same
        // claim as "warned, never went idle".
        return NO_LEAD;
      }
      return await round.wait(team.orchestratorId);
    } catch (err) {
      log.warn({
        event: 'updates.warn_lead_failed',
        orchestratorId: team.orchestratorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return NEVER_IDLE;
    }
  }

  /**
   * §D.5 — the window is over NOW, whatever its deadline said.
   *
   * `deadline` is the ordinary end and costs one last observation. `now` is
   * `applyNow()`: the update is happening early, so every waiter settles with
   * what has been observed so far and the runner can persist the records before
   * it spawns the job that recreates this container. `cancelled` also stands
   * the armed notices down — nothing is coming, so no lead should be typed at
   * about it — while leaving the mailbox rows alone.
   *
   * Idempotent and total: calling it twice, or with no round in flight, does
   * nothing. Never throws.
   */
  endWindow(reason: GraceEndReason = 'deadline'): void {
    const round = this.round;
    if (!round) return;
    if (reason === 'cancelled') {
      try {
        const dropped = this.spawner.cancelLeadNotices(round.warnings);
        log.info({
          event: 'updates.lead_notices_cancelled',
          dropped,
          armed: round.warnings.length,
        });
      } catch (err) {
        log.warn({
          event: 'updates.cancel_lead_notices_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Re-observes first, then resolves every waiter with what it saw: the
    // record has to be what actually happened, not what was hoped for.
    round.finish();
  }

  /** The current round's handles — for tests and for debugging a live window. */
  currentWarnings(): LeadWarning[] {
    return this.round?.warnings ?? [];
  }

  private roundFor(text: string, deadlineMs: number): WarningRound | null {
    const key = `${deadlineMs} ${text}`;
    if (this.roundKey === key) return this.round;
    // A new window supersedes the old one on the spawner side anyway
    // (`warnLeads` clears the re-push map, `armNotice` supersedes); settle any
    // straggler waiting on the previous round rather than leave it hanging.
    this.round?.finish();
    this.roundKey = key;
    this.round = null;
    // ⚠️ absolute epoch (runner) → remaining duration (armNotice). See header.
    const remainingMs = Math.max(0, deadlineMs - this.now());
    let warnings: LeadWarning[];
    try {
      warnings = this.spawner.warnLeads(text, { deadlineMs: remainingMs });
    } catch (err) {
      log.error({
        event: 'updates.warn_leads_failed',
        error: err instanceof Error ? err.message : String(err),
        note: 'no lead could be warned; the update proceeds at its deadline regardless',
      });
      return null;
    }
    this.round = new WarningRound(
      this.spawner,
      warnings,
      deadlineMs,
      this.pollIntervalMs,
      this.now,
    );
    return this.round;
  }
}

// ---------------------------------------------------------------------------
// Boot side (plan §D.5 post-restart banner, §D.6 team survival).
// ---------------------------------------------------------------------------

/** The runner surface the boot step uses. */
type BootRunner = Pick<UpdateRunner, 'start'>;
/** The store surface the boot step uses. */
type BootStore = Pick<UpdateStore, 'listActive' | 'get' | 'patch'>;

/**
 * States that mean the host updater was already launched — i.e. this boot may
 * BE the update. `scheduled` is a run that has not started, and
 * `warning_teams` is concluded as `abandoned` by `resumeUnfinished()` because
 * nothing had been touched yet; neither deserves a banner.
 */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set(['preflight', 'applying', 'verifying']);

export interface UpdateBootState {
  /** The run that was in flight when this process started, if any. */
  runId: string | null;
  /** Banner for the resumed LEADS; `null` ⇒ resume notices unchanged. */
  banner: string | null;
  /** Teams alive before that run — the DB rows can no longer say (§D.6). */
  teams: TeamSnapshotEntry[];
}

const NO_UPDATE_IN_FLIGHT: UpdateBootState = { runId: null, banner: null, teams: [] };

/**
 * Boot step: note what was in flight, then start the runner.
 *
 * ORDER IS THE POINT. The in-flight row is read BEFORE `start()`, because
 * `start()` → `resumeUnfinished()` concludes any run whose `result.json` has
 * landed, and a concluded run is no longer in `listActive()`. The row is then
 * re-read AFTER, because that verdict is exactly what the banner should say
 * (a `rolled_back` run means the leads came back on the OLD version).
 *
 * The returned `runId` is also the row the §D.6 reconciliation is written to,
 * later in the same boot: the caller pairs it with the store it already owns
 * and passes both to `reconcileUpdateTeams()`. Nothing is remembered here.
 *
 * Never rejects, never throws: same discipline as
 * `PluginHost.activateEnabled()`. A boot that fails because of the update
 * bookkeeping would be strictly worse than one that resumes with the ordinary
 * restart notice.
 */
export async function startUpdateRunnerAtBoot(
  runner: BootRunner | null,
  store: BootStore | null,
): Promise<UpdateBootState> {
  if (!runner || !store) return NO_UPDATE_IN_FLIGHT;
  let before: UpdateRunRow | null = null;
  try {
    before = findInFlightRun(store.listActive());
  } catch (err) {
    log.warn({
      event: 'updates.boot_scan_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const teams = parseTeamsSnapshot(before);
  try {
    // Installs the script, prunes, concludes or abandons what was in flight —
    // and restores a half-written `.env` line. It reads files and the store,
    // nothing else, which is why it can run before the teams come back.
    await runner.start();
  } catch (err) {
    // `start()` documents that it never throws; if that ever changes, a broken
    // updater must still not stop the server from booting.
    log.error({
      event: 'updates.boot_start_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!before) return NO_UPDATE_IN_FLIGHT;
  let after: UpdateRunRow | null = before;
  try {
    after = store.get(before.id) ?? before;
  } catch (err) {
    log.warn({
      event: 'updates.boot_reread_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const banner = buildUpdateResumeBanner(after);
  log.info({
    event: 'updates.boot_run_in_flight',
    runId: before.id,
    stateBefore: before.state,
    stateAfter: after.state,
    targetVersion: after.target_version,
    teamsSnapshot: teams.length,
    banner: banner !== null,
  });
  return { runId: before.id, banner, teams };
}

/** The newest non-terminal run that had already reached the host, if any. */
export function findInFlightRun(rows: readonly UpdateRunRow[]): UpdateRunRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && IN_FLIGHT_STATES.has(row.state)) return row;
  }
  return null;
}

/**
 * §D.5 — the post-restart banner, prepended to each resumed LEAD's resume
 * notice. It is the only channel that survives the container being recreated:
 * the pre-update mailbox row is wiped by `shutdownForRestart` → `clearAll()`,
 * while this string rides the positional argv of the very first turn.
 *
 * It names the version and when, and it never claims more than the run row
 * proves — a `rolled_back` boot is running the OLD version and says so.
 * Returns `null` when there is nothing to say, and the resume notice is then
 * byte-identical to one from any other restart.
 */
export function buildUpdateResumeBanner(row: UpdateRunRow | null | undefined): string | null {
  if (!row) return null;
  const version = row.target_version ? `v${row.target_version}` : 'a new version';
  const when = row.finished_at ?? row.started_at ?? row.warned_at ?? row.scheduled_for;
  const at = when ? ` at ${when}` : '';
  switch (row.state) {
    case 'success':
      return (
        `## swarm-os was updated\n\n` +
        `swarm-os was updated to ${version}${at} and this container was recreated to run it. ` +
        `That restart — not a crash — is what interrupted your previous session.`
      );
    case 'rolled_back':
      return (
        `## swarm-os update rolled back\n\n` +
        `An update to ${version} was applied${at}, failed verification and was rolled back, so ` +
        `this container is running the version it had BEFORE. That restart — not a crash — is ` +
        `what interrupted your previous session.`
      );
    case 'failed':
    case 'abandoned':
      return (
        `## swarm-os update did not complete\n\n` +
        `An update to ${version} was in flight${at} and ended as "${row.state}". That restart — ` +
        `not a crash — is what interrupted your previous session. Which version is now running ` +
        `is not established: check the Updates drawer before drawing conclusions from it.`
      );
    case 'preflight':
    case 'applying':
    case 'verifying':
      return (
        `## swarm-os is being updated\n\n` +
        `An update to ${version} was in flight${at} when this container was recreated, and the ` +
        `updater is still verifying it. That restart — not a crash — is what interrupted your ` +
        `previous session; it may be interrupted once more if the update is rolled back.`
      );
    default:
      // `cancelled` / `refused` never touched anything, so there is nothing a
      // resumed lead needs told.
      return null;
  }
}

/**
 * The `teams_snapshot_json` column, back as a snapshot. Tolerant on purpose:
 * the same column carries `{graceSeconds}` for a run that is still only
 * scheduled, and a malformed value must degrade to "we don't know which teams
 * were up", never to a boot failure.
 */
export function parseTeamsSnapshot(row: UpdateRunRow | null | undefined): TeamSnapshotEntry[] {
  if (!row?.teams_snapshot_json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.teams_snapshot_json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TeamSnapshotEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    // The runner persists the port's own `ActiveTeam` shape; accept the
    // spawner's `TeamSnapshotEntry` too so a row written by either side reads.
    const e = entry as Partial<ActiveTeam> & Partial<TeamSnapshotEntry>;
    const id = typeof e.orchestratorId === 'string' ? e.orchestratorId : e.orch_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const name = typeof e.name === 'string' ? e.name : (e.orch_name ?? id);
    const lead = typeof e.leadSessionId === 'string' ? e.leadSessionId : (e.lead_id ?? null);
    out.push({ orch_id: id, orch_name: name, lead_id: lead ?? null });
  }
  return out;
}

/**
 * §D.6 — after auto-resume, diff the pre-update snapshot against what actually
 * came back, say so, and PERSIST it.
 *
 * This cannot be answered from the database: `loadResumableState()` flips every
 * candidate to `interrupted` BEFORE returning it and a failed resume leaves it
 * there, so by now the rows no longer know which teams were up. The snapshot
 * does — hence it is persisted in the run row before anything is triggered.
 *
 * And the ANSWER cannot live in a log line either: the post-update screen is
 * rendered from the run row, minutes or days later, by a process that has no
 * access to this boot's stdout. It goes to `teams_reconciled_json` — its own
 * column, because `teams_snapshot_json` still holds the `ActiveTeam[]` the
 * view and the web package read, and `error`/`log_tail` are rewritten by
 * `applyResult` whenever the run concludes after this boot.
 *
 * `runId` and `store` are what make the write possible, and the caller passes
 * BOTH: `index.ts` gets them from `startUpdateRunnerAtBoot()` and hands them
 * straight back here after auto-resume. They used to travel through module
 * state — one boot arming a target the other half of the same sequence picked
 * up — which read as a handoff and behaved like one until two runners shared a
 * process, at which point "the store of the last boot" is a guess. Omit either
 * and nothing is persisted; the reconciliation is still returned and logged.
 *
 * Returns `null` when there is nothing to reconcile. Never throws.
 */
export function reconcileUpdateTeams(
  spawner: ReconcilableSpawner,
  teams: readonly TeamSnapshotEntry[],
  runId: string | null = null,
  store: BootStore | null = null,
): TeamReconciliation | null {
  if (teams.length === 0) return null;
  let result: TeamReconciliation;
  try {
    result = spawner.reconcileTeams([...teams]);
  } catch (err) {
    log.warn({
      event: 'updates.teams_reconcile_failed',
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const casualties = result.teams
    .filter((t) => !t.back)
    .map((t) => ({ id: t.orch_id, name: t.orch_name, reason: t.reason }));
  const payload = {
    event: 'updates.teams_reconciled',
    runId,
    snapshot: teams.length,
    back: result.back,
    missing: result.missing,
    casualties,
    persisted: persistReconciliation(runId, result, store),
  };
  if (result.missing > 0) log.warn(payload);
  else log.info(payload);
  return result;
}

/**
 * Write the reconciliation into the run row. Returns whether it landed — which
 * is logged, because "the post-update screen will be empty" is exactly the kind
 * of thing nobody discovers until they need the screen.
 *
 * Never throws: the reconciliation is a record of a restart that already
 * happened, and failing a boot over it would help nobody.
 */
function persistReconciliation(
  runId: string | null,
  result: TeamReconciliation,
  store: BootStore | null,
): boolean {
  if (!store || runId === null) return false;
  try {
    store.patch(runId, { teams_reconciled_json: JSON.stringify(toReconciledRecords(result)) });
    return true;
  } catch (err) {
    log.warn({
      event: 'updates.teams_reconciled_persist_failed',
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * `TeamReconciliation` → the persisted row shape. Projected field by field
 * rather than stringified whole: the column is a wire format the UI reads, and
 * it should not silently acquire whatever the spawner's type grows next.
 */
export function toReconciledRecords(result: TeamReconciliation): ReconciledTeamRecord[] {
  return result.teams.map((t) => ({
    orch_id: t.orch_id,
    orch_name: t.orch_name,
    lead_id: t.lead_id,
    back: t.back,
    lead_id_now: t.lead_id_now,
    status: t.status,
    reason: t.reason,
  }));
}
