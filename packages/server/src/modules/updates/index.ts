/**
 * UpdateService — "is there a newer swarm-os, and may this deployment install
 * it itself?", cached.
 *
 * THE DESIGN DECISION, and it is the whole module: there is **no timer here**.
 * No `setInterval`, no scheduler, no check engine. The SPA already polls
 * `/info` every 60 s without auth, so serving `/info` IS the heartbeat: it
 * returns the cached verdict and, only if that cache is older than the TTL,
 * kicks off a background refresh it does not wait for. An open tab keeps the
 * verdict warm; with no tab open, nobody is looking at a badge, so nothing
 * needs to be fresh. A periodic checker would add a lifecycle, a shutdown
 * path, and a class of "why is it calling GitHub at 4am" questions, to
 * produce exactly the same freshness at exactly the moments it matters.
 *
 * Two consequences worth stating:
 *  - `getVerdict()` NEVER blocks and NEVER throws. A dead network, a spent
 *    rate limit, an expired token, a private repo — each is a value carried
 *    in the verdict, and the previous verdict stays visible in the meantime.
 *  - The clock is only advanced on a COMPLETED refresh (success or failure
 *    alike), so a permanently failing check backs off to one attempt per TTL
 *    instead of one per `/info` poll.
 *
 * `/info` is unauthenticated, so it gets `{ available, latest }` and nothing
 * else — release notes, plugin origins and eligibility reasons stay behind the
 * auth gate in `GET /updates`.
 */
import { withModule } from '../../logger.js';
import type { AgentTransport } from '../../config.js';
import type { SettingsStore } from '../settings/index.js';
import { GithubReleasesClient, githubTokenFromEnv, type GithubRelease } from './github.js';
import { PluginUpdateChecker, type PluginOrigin, type PluginUpdateCheck } from './plugins-check.js';
import { isNewer, tagToVersion } from './semver.js';
import { UpdateStore } from './store.js';
import type { UpdateRunner, UpdateRunView } from './runner.js';

const log = withModule('updates');

/** 6 h. Releases are a human-cadence event; anything tighter is just traffic. */
export const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Env override. Read here rather than in `config.ts` because this knob is
 * internal to the detector (an operator never needs it; a test and a demo do).
 * If it ever becomes operator-facing, move it to `config.ts` with the rest.
 */
function ttlFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SWARM_OS_UPDATE_CHECK_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHECK_TTL_MS;
}

/** Outcome of the last completed system check — each maps to its own sentence. */
export type SystemCheckStatus =
  | 'never_checked'
  | 'ok'
  | 'no_releases'
  /** GitHub's API rate limit is spent (`error` says until when). */
  | 'rate_limited'
  | 'unauthorized'
  | 'not_found'
  | 'error';

export interface SystemUpdateState {
  /** What this instance is running (`config.version`). */
  current: string;
  /** `latest > current` AND not dismissed. Recomputed on every read. */
  available: boolean;
  /** Comparable version of the newest published release (`0.6.0`). */
  latest: string | null;
  /** Its tag as published (`v0.6.0`). */
  tag: string | null;
  notesUrl: string | null;
  notesBody: string | null;
  publishedAt: string | null;
  /** Version the operator dismissed, if any. */
  dismissedVersion: string | null;
  checkStatus: SystemCheckStatus;
  /** ISO of the last COMPLETED check, success or failure. */
  checkedAt: string | null;
  /**
   * Message for `checkStatus === 'error'`, and the operator sentence (with the
   * reset time when known) for `checkStatus === 'rate_limited'`.
   */
  error: string | null;
}

/** Exactly what the public, unauthenticated `/info` may carry. */
export interface InfoUpdateProjection {
  available: boolean;
  latest: string | null;
}

/**
 * Why this deployment can (or cannot) update itself. A boolean would tell an
 * operator "no" without telling them the one thing to change.
 */
export type SelfUpdateStatus =
  | 'ok'
  | 'transport_not_ssh'
  | 'image_not_registry'
  | 'image_not_interpolated'
  | 'env_file_not_found'
  | 'env_file_not_writable'
  | 'registry_auth_missing'
  /** Checks that need the host and don't exist yet — see `evaluateSelfUpdate`. */
  | 'unknown';

export interface SelfUpdateEligibility {
  status: SelfUpdateStatus;
  /** One operator-facing sentence: the single thing to change. */
  detail: string;
}

export interface UpdatesFullState {
  system: SystemUpdateState;
  plugins: PluginUpdateCheck[];
  /** ISO of the last completed plugin sweep; null until the first one. */
  pluginsCheckedAt: string | null;
  canSelfUpdate: SelfUpdateEligibility;
  /** The run in flight or scheduled; `null` when idle. Needs a runner attached. */
  run: UpdateRunView | null;
  /** Newest-first history, for the drawer's "last update" line. */
  recentRuns: UpdateRunView[];
  /** Version + sha of the updater script this build would run; `null` if none. */
  updater: { version: string; sha256: string } | null;
}

/** The slice of `Config` this service reads — nothing more, so it stays mockable. */
export interface UpdateServiceConfig {
  version: string;
  image: string | null;
  agentTransport: AgentTransport;
}

export interface UpdateServiceOptions {
  config: UpdateServiceConfig;
  settings: SettingsStore;
  /** Optional: enables `assertReady()` to check the run table too. */
  store?: UpdateStore;
  /** Defaults to a client built from `SWARM_OS_GITHUB_TOKEN`. */
  github?: GithubReleasesClient;
  /** Defaults to a real checker (network + `git ls-remote`). */
  pluginChecker?: PluginUpdateChecker;
  /**
   * Installed plugins, projected into the detector's own narrow type. Injected
   * by the wiring step so this module never imports the plugin registry.
   * Absent ⇒ no plugin detection (an empty list, not an error).
   */
  listPluginOrigins?: () => PluginOrigin[];
  /**
   * The apply/schedule state machine. Optional and late-bindable
   * (`setRunner`) because it needs collaborators — the teams port above all —
   * that are constructed after this service at boot.
   */
  runner?: UpdateRunner;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Is this image reference pullable from a registry?
 *
 * A registry reference always has a path component: `ghcr.io/o/r:t` (explicit
 * host) or `owner/name` (implicit Docker Hub). A single segment —
 * `swarm-os:latest`, which is what `docker-compose.test.yml` and
 * `docker-compose.stiix.yml` actually use — is a LOCALLY BUILT image with
 * nothing behind it to pull. That is precisely `image_not_registry`.
 */
export function isRegistryRef(image: string): boolean {
  return image.includes('/');
}

/**
 * Eligibility, from what this process can observe WITHOUT touching the host.
 *
 * Implemented here: `transport_not_ssh` (no SSH ⇒ no way to run anything on
 * the host at all) and the two image cases. `config.image` is `SWARM_OS_IMAGE`
 * — the same variable the distributed compose interpolates into `image:` — so
 * its absence IS the observable form of "the compose hardcodes its tag", i.e.
 * `image_not_interpolated`.
 *
 * NOT decided here, on purpose: `env_file_not_found`, `env_file_not_writable`
 * and `registry_auth_missing` are host facts. They are answered by the updater
 * script's own preflight (`scripts/host-update.sh`, plan §D.3.4-6), which
 * refuses with exactly those reasons and touches NOTHING — so an ineligible
 * deployment costs one `refused` run, not an outage. Probing them from here
 * would mean an SSH round trip on every `GET /updates`, to produce an answer
 * that could still be stale by the time apply runs.
 *
 * So this stays `unknown` rather than a hopeful `ok`: claiming eligibility we
 * have not verified is how a one-click button becomes a one-click outage.
 */
export function evaluateSelfUpdate(config: UpdateServiceConfig): SelfUpdateEligibility {
  if (config.agentTransport !== 'ssh') {
    return {
      status: 'transport_not_ssh',
      detail:
        'This instance runs agents in-container (SWARM_OS_AGENT_TRANSPORT=local), so it has no way to run docker on the host. Switch the transport to ssh and provide a key to enable one-click updates; otherwise update from the host shell.',
    };
  }
  if (config.image === null) {
    return {
      status: 'image_not_interpolated',
      detail:
        'SWARM_OS_IMAGE is not set, which means the compose file hardcodes its image tag. Self-update rewrites that one variable in the deployment .env — change the compose to `image: ${SWARM_OS_IMAGE}` and define the variable there.',
    };
  }
  if (!isRegistryRef(config.image)) {
    return {
      status: 'image_not_registry',
      detail: `SWARM_OS_IMAGE is "${config.image}", a locally-built image with nothing to pull from. Point the deployment at a registry image (e.g. ghcr.io/nyyyxius/swarm-os:<tag>) to enable one-click updates.`,
    };
  }
  return {
    status: 'unknown',
    detail:
      'Transport and image qualify. The remaining checks — locating a writable deployment .env, confirming the compose really interpolates SWARM_OS_IMAGE, and pulling from the registry — run on the host as the updater’s preflight. If any of them says no, the run ends as "refused" with the exact reason and nothing is touched.',
  };
}

export class UpdateService {
  private readonly config: UpdateServiceConfig;
  private readonly settings: SettingsStore;
  private readonly store: UpdateStore | null;
  private readonly github: GithubReleasesClient;
  private readonly pluginChecker: PluginUpdateChecker;
  private readonly listPluginOrigins: () => PluginOrigin[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private runnerRef: UpdateRunner | null;

  /** Last successful release lookup; survives a later failed refresh. */
  private release: GithubRelease | null = null;
  private checkStatus: SystemCheckStatus = 'never_checked';
  private checkError: string | null = null;
  private checkedAtMs: number | null = null;
  private plugins: PluginUpdateCheck[] = [];
  private pluginsCheckedAt: string | null = null;
  /** Single-flight: `/info` can be polled by many tabs at once, and
   *  `refreshNow()` must join an in-flight sweep rather than start a second. */
  private inflight: Promise<void> | null = null;

  constructor(opts: UpdateServiceOptions) {
    this.config = opts.config;
    this.settings = opts.settings;
    this.store = opts.store ?? null;
    this.github = opts.github ?? new GithubReleasesClient({ token: githubTokenFromEnv() });
    this.pluginChecker = opts.pluginChecker ?? new PluginUpdateChecker();
    this.listPluginOrigins = opts.listPluginOrigins ?? (() => []);
    this.ttlMs = opts.ttlMs ?? ttlFromEnv();
    this.now = opts.now ?? (() => Date.now());
    this.runnerRef = opts.runner ?? null;
  }

  /** Boot assertion — fails loudly if persistence isn't actually there. */
  assertReady(): void {
    this.store?.assertReady();
  }

  /**
   * Attach the apply/schedule machine. Separate from the constructor because
   * the runner's teams port comes from the orchestrator, which is built later.
   * Without a runner every write route answers 503 rather than pretending.
   */
  setRunner(runner: UpdateRunner | null): void {
    this.runnerRef = runner;
  }

  get runner(): UpdateRunner | null {
    return this.runnerRef;
  }

  /**
   * The cached verdict. Serving it schedules a refresh IF the cache is stale —
   * fire-and-forget, so this returns in microseconds even on a dead network.
   */
  getVerdict(): SystemUpdateState {
    this.maybeRefresh();
    return this.buildSystemState();
  }

  /** The only fields `/info` (public, unauthenticated) is allowed to carry. */
  getInfoUpdate(): InfoUpdateProjection {
    const v = this.getVerdict();
    return { available: v.available, latest: v.latest };
  }

  /** Everything behind the auth gate: system + plugins + eligibility. */
  getFullState(): UpdatesFullState {
    this.maybeRefresh();
    return {
      system: this.buildSystemState(),
      plugins: this.plugins,
      pluginsCheckedAt: this.pluginsCheckedAt,
      canSelfUpdate: evaluateSelfUpdate(this.config),
      run: this.runnerRef?.currentRun() ?? null,
      recentRuns: this.runnerRef?.listRuns(10) ?? [],
      updater: this.runnerRef?.scriptDescriptor() ?? null,
    };
  }

  /**
   * The plugin sweep on its own — the whole of what `routes/plugins.ts` needs.
   *
   * It exists so that route stops calling `getFullState()`: that also builds
   * `currentRun()` and `listRuns(10)`, each of which reads `update_runs` and
   * then hits the filesystem (`readEvents`) for every non-terminal run, on
   * EVERY plugins list. Same cached value, same TTL-gated background refresh,
   * none of the run bookkeeping.
   */
  getPluginChecks(): PluginUpdateCheck[] {
    this.maybeRefresh();
    return this.plugins;
  }

  /**
   * Stop nagging about `version` (pass `null` to un-dismiss). Stored
   * normalized, so dismissing `v0.6.0` also silences `0.6.0`.
   */
  dismiss(version: string | null): SystemUpdateState {
    const normalized = version === null ? null : tagToVersion(version);
    this.settings.update({ dismissedUpdateVersion: normalized });
    log.info({ event: 'updates.dismissed', version: normalized });
    return this.buildSystemState();
  }

  /**
   * Force a check and wait for it. Used by boot/tests and by anything that
   * wants a fresh answer; the request path uses `getVerdict()` instead.
   * Resolves even when everything failed — the outcome is in the verdict.
   */
  async refreshNow(): Promise<SystemUpdateState> {
    await this.refresh();
    return this.buildSystemState();
  }

  // ---- internals ----------------------------------------------------------

  private maybeRefresh(): void {
    if (this.inflight !== null) return;
    if (this.checkedAtMs !== null && this.now() - this.checkedAtMs < this.ttlMs) return;
    void this.refresh();
  }

  /** Never throws, never rejects. Advances the clock whatever happens. */
  private refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runRefresh(): Promise<void> {
    try {
      await Promise.all([this.refreshSystem(), this.refreshPlugins()]);
    } catch (err) {
      // Defensive: both halves already swallow their own failures.
      log.warn({ event: 'updates.refresh_failed', error: String(err) });
    } finally {
      // Set LAST and unconditionally: a failing check must back off to one
      // attempt per TTL, not one per `/info` poll from every open tab.
      this.checkedAtMs = this.now();
    }
  }

  private async refreshSystem(): Promise<void> {
    const r = await this.github.latestRelease();
    switch (r.status) {
      case 'ok':
        this.release = r.release;
        this.checkStatus = 'ok';
        this.checkError = null;
        break;
      case 'error':
        // Keep the previous release: a flaky network must not make a known
        // update disappear from the UI.
        this.checkStatus = 'error';
        this.checkError = r.message;
        break;
      case 'rate_limited':
        // Same reasoning: a spent rate limit says nothing about the releases.
        this.checkStatus = 'rate_limited';
        this.checkError = r.message;
        break;
      default:
        this.checkStatus = r.status;
        this.checkError = null;
        break;
    }
  }

  private async refreshPlugins(): Promise<void> {
    let origins: PluginOrigin[];
    try {
      origins = this.listPluginOrigins();
    } catch (err) {
      log.warn({ event: 'updates.plugin_origins_failed', error: String(err) });
      return;
    }
    if (origins.length === 0) {
      this.plugins = [];
      this.pluginsCheckedAt = new Date(this.now()).toISOString();
      return;
    }
    try {
      this.plugins = await this.pluginChecker.checkAll(origins);
      this.pluginsCheckedAt = new Date(this.now()).toISOString();
    } catch (err) {
      // `checkAll` is already per-plugin fault-tolerant; keep the last sweep.
      log.warn({ event: 'updates.plugin_sweep_failed', error: String(err) });
    }
  }

  private buildSystemState(): SystemUpdateState {
    const dismissedRaw = this.settings.get().dismissedUpdateVersion;
    const dismissed = dismissedRaw === null ? null : tagToVersion(dismissedRaw);
    const latest = this.release?.version ?? null;
    return {
      current: this.config.version,
      // Recomputed on EVERY read, not cached with the release: dismissing must
      // take effect on the next poll, without waiting out a 6 h TTL.
      available: latest !== null && isNewer(latest, this.config.version) && latest !== dismissed,
      latest,
      tag: this.release?.tag ?? null,
      notesUrl: this.release?.notesUrl ?? null,
      notesBody: this.release?.notesBody ?? null,
      publishedAt: this.release?.publishedAt ?? null,
      dismissedVersion: dismissed,
      checkStatus: this.checkStatus,
      checkedAt: this.checkedAtMs === null ? null : new Date(this.checkedAtMs).toISOString(),
      error: this.checkError,
    };
  }
}

export { GithubReleasesClient, githubTokenFromEnv } from './github.js';
export { PluginUpdateChecker } from './plugins-check.js';
export type { PluginOrigin, PluginUpdateCheck, PluginUpdateStatus } from './plugins-check.js';
export { UpdateStore, UpdateStoreSchemaError, TERMINAL_UPDATE_STATES } from './store.js';
export type { UpdateRunRow, UpdateRunState, UpdateRunKind } from './store.js';
export { compareVersions, isNewer as isVersionNewer, parseVersion, tagToVersion } from './semver.js';
export {
  UpdateRunner,
  UpdateBusyError,
  UpdateInvalidInputError,
  SYSTEM_JOB_NAMESPACE,
  MIN_GRACE_SECONDS,
  DEFAULT_GRACE_SECONDS,
  resolveGraceSeconds,
  retagImage,
  warningText,
} from './runner.js';
export type {
  ActiveTeam,
  TeamsPort,
  GraceEndReason,
  LeadNoticeOutcome,
  LeadNoticeState,
  WarnedTeamRecord,
  ReconciledTeamRecord,
  TeamReconcileReason,
  ApplyInput,
  ScheduleInput,
  UpdateRunView,
  UpdateRunDetail,
  UpdateRunnerOptions,
} from './runner.js';
export {
  installHostUpdateScript,
  assertInstalledScriptMatches,
  hostUpdateScriptSha256,
  hostUpdateScriptVersion,
  hostUpdateScriptSource,
  HOST_UPDATE_SCRIPT_NAME,
  HOST_UPDATE_EXIT,
  HostScriptError,
} from './host-script.js';
export {
  buildComposeBaseArgs,
  buildHostUpdateArgv,
  buildRestoreEnvArgv,
  parseComposeConfigFiles,
  rewriteEnvStream,
  isLabelMissing,
  isValidImageRef,
  isValidEnvValue,
  runDirFor,
  runsDir,
  updaterDir,
} from './compose.js';
