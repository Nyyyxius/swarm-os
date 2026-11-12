/**
 * SYSTEM UPDATE — the operator-facing half of the update surface.
 *
 * Mounted in `SettingsDrawer` right after ABOUT (which already renders the
 * running version), modelled on `MaintenanceSection`: busy / error /
 * lastResult + one-click actions, same `drawer-section` vocabulary.
 *
 * Constraints, all deliberate:
 *
 *  - **No poll while idle.** `GET /updates` is fetched once, when this section
 *    mounts — i.e. when the drawer opens. The badge in the TopBar does not
 *    depend on it: it rides the `update` field of the existing 60 s `/info`
 *    poll, so it paints in the same render as the version string beside it.
 *    A poll starts ONLY while a run is in flight and stops the moment that run
 *    reaches a terminal state. No hook, no WS event kind, no global interval.
 *  - **No markdown renderer.** Release notes are shown verbatim in a `<pre>`
 *    plus a link to the release page. Nothing in this codebase renders
 *    markdown, and rendering remote GitHub markdown would be a new injection
 *    surface for a screen read once a month.
 *  - **Every refusal gets its own copy.** `canSelfUpdate` reasons, the 503 of a
 *    build with no apply engine, and each terminal run state say the one thing
 *    that is true about that case — a generic "failed" would be a lie four
 *    times out of six.
 *  - **Never offer a control the server will refuse.** `APPLY NOW` inside the
 *    warning window posts to `POST /updates/apply-now`, which enforces a hard
 *    {@link MIN_GRACE_SECONDS} floor and answers 409 — naming the seconds left
 *    — below it. The button is therefore live only once that floor has elapsed
 *    here too, and the 409 (reachable only on clock skew) is surfaced verbatim.
 *  - **The server's reconciliation wins.** The post-update screen renders
 *    `teamsReconciled` when the run carries one: it was written by the boot
 *    that followed the update and is still true when the page is opened later,
 *    which a fresh `GET /orchestrators` is not. The client-side diff survives
 *    only as the fallback for runs that predate that column, and the two are
 *    never merged — the screen says which one it is showing.
 *  - **The restart is part of the flow, not an accident.** During `applying` /
 *    `verifying` the container we are talking to is recreated: the WS drops and
 *    every authenticated call fails. That window gets a full-screen state
 *    driven by `/health` (public, mounted before the auth gate) gated on
 *    `boot_complete` — a 200 alone only proves the process is listening.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  HttpError,
  type OrchestratorView,
  type SelfUpdateStatus,
  type SystemCheckStatus,
  type UpdateRunDetail,
  type UpdateRunView,
  type UpdatesView,
} from '../../api/client';
import {
  DEFAULT_GRACE_SECONDS,
  MIN_GRACE_SECONDS,
  casualtyNotice,
  elapsedSince,
  formatCountdown,
  hasServerReconciliation,
  isTeamLive,
  noticeStateLabel,
  phaseLabel,
  resolveTeamReturns,
  returnReasonLabel,
  terminalVerdict,
  warningRows,
  warningSummary,
  type NoticeRowState,
  type TeamReturn,
  type TeamReturnSource,
  type VerdictTone,
} from '../../lib/updateRun';

/** What an operator runs on the host today — the manual path, documented in
 *  `docs/deploy/install.en.md` §7. */
const INSTALL_CMD = './install.sh';

/** Poll cadence per in-flight state. Nothing here runs while idle. */
const POLL_MS: Record<string, number> = {
  scheduled: 5_000,
  warning_teams: 2_000,
  preflight: 2_000,
  applying: 2_000,
  verifying: 2_000,
};
/** Cadence of the `/health` probe while the container is being recreated. */
const RESTART_POLL_MS = 2_000;
/** Past this, a finished run stops being "the update that just happened". */
const POST_UPDATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * A restart takes a minute. Past this, the full-screen overlay offers a way
 * out: a container that has not come back in five minutes is a situation to
 * look at, not a screen to be trapped behind.
 */
const RESTART_ESCAPE_MS = 5 * 60 * 1000;
/**
 * And past THIS, the probe stops re-arming altogether. The loop below waits on
 * `boot_complete`, which a container that came up `healthy_no_boot_complete`
 * never reports — an uncapped re-arm makes that overlay permanent while the
 * server already holds the verdict.
 */
const RESTART_GIVE_UP_MS = 15 * 60 * 1000;
/** What the server itself says when no apply engine is attached (503 body). */
const NO_ENGINE_COPY =
  'This instance has update detection but no apply machine attached, so it cannot install anything itself. Update from the host shell.';

const TONE_COLOR: Record<VerdictTone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  mute: 'var(--text-mute)',
};

/**
 * One line per eligibility reason. The server also sends a `detail` sentence
 * computed from THIS deployment (it quotes the actual image reference, for
 * instance) and that is what we render as the explanation; these entries give
 * the short headline and a fallback for the — always possible — case of a
 * server that predates a reason and sends nothing useful.
 */
const SELF_UPDATE_COPY: Record<SelfUpdateStatus, { label: string; fallback: string }> = {
  ok: {
    label: 'ELIGIBLE',
    fallback:
      'Transport and image qualify for one-click updates.',
  },
  unknown: {
    label: 'HOST CHECKS PENDING',
    fallback:
      'Transport and image qualify. The remaining checks run on the host as the updater’s preflight — if any says no, the run ends as "refused" and nothing is touched.',
  },
  transport_not_ssh: {
    label: 'TRANSPORT IS NOT SSH',
    fallback:
      'Agents run in-container (SWARM_OS_AGENT_TRANSPORT=local), so swarm-os cannot run docker on the host. Switch the transport to ssh and provide a key to enable one-click updates.',
  },
  image_not_interpolated: {
    label: 'IMAGE TAG IS HARDCODED',
    fallback:
      'The compose file hardcodes its image tag. Change it to `image: ${SWARM_OS_IMAGE}` and define that variable in the deployment .env — that one line is what an update rewrites.',
  },
  image_not_registry: {
    label: 'IMAGE IS LOCALLY BUILT',
    fallback:
      'SWARM_OS_IMAGE points at a locally-built image, with nothing behind it to pull. Point the deployment at a registry image (ghcr.io/nyyyxius/swarm-os:<tag>).',
  },
  env_file_not_found: {
    label: 'NO .env FOUND',
    fallback:
      'No .env was located next to the compose file. An update rewrites the SWARM_OS_IMAGE line of that file, so it has to exist — create it and define the variable there.',
  },
  env_file_not_writable: {
    label: '.env IS NOT WRITABLE',
    fallback:
      'The deployment .env cannot be written by the container user (uid 1000). Adjust its ownership/permissions so the SWARM_OS_IMAGE line can be rewritten.',
  },
  registry_auth_missing: {
    label: 'REGISTRY LOGIN MISSING',
    fallback:
      'The host cannot pull the image. Check the image reference; the published image is public and needs no login, so only a private mirror requires `docker login` on the host.',
  },
};

/**
 * Why the last check produced no verdict. `ok`, `error` and `rate_limited`
 * are absent on purpose: `ok` has nothing to explain, the other two carry the
 * server's own sentence in `system.error` (for `rate_limited`, when the limit
 * resets and whether a token would raise it).
 */
const CHECK_COPY: Partial<Record<SystemCheckStatus, string>> = {
  never_checked: 'no check has completed yet — the first one runs in the background.',
  no_releases: 'the repository has no published release to compare against.',
  unauthorized:
    'GitHub rejected SWARM_OS_GITHUB_TOKEN — it is expired, revoked or lacks access. Remove it to check without a token, or replace it.',
  not_found:
    'the releases endpoint answered 404 — the repository was renamed, or is private and not visible to this instance.',
};

/** Server error bodies are `{ error }`; prefer that sentence over the status. */
function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
    return `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * A payload we can actually render. The route may be absent (a server older
 * than the detector answers 404) or intercepted by a proxy; reading
 * `state.plugins.filter` off whatever came back would take the whole drawer
 * down with it.
 */
function isUpdatesView(v: unknown): v is UpdatesView {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<UpdatesView>;
  return (
    typeof o.system === 'object' && o.system !== null &&
    typeof o.system.current === 'string' &&
    Array.isArray(o.plugins) &&
    typeof o.canSelfUpdate === 'object' && o.canSelfUpdate !== null
  );
}

/**
 * Is this run the full detail (`GET /updates/:id`) rather than a list view?
 * A structural check, not a cast: `recentRuns` entries never carry `logTail`,
 * and TypeScript collapses the union away because the detail is a subtype.
 */
function isRunDetail(run: UpdateRunView | UpdateRunDetail): run is UpdateRunDetail {
  return typeof (run as Partial<UpdateRunDetail>).logTail === 'string';
}

/** `2026-07-14T09:12:00Z` → `2026-07-14`. Never throws on a bad value. */
function isoDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** ISO → local `2026-07-30 03:00`, or the raw value when unparsable. */
function localStamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Is the server back? `/health` and `/info` are public and mounted BEFORE the
 * auth gate, which is what makes them usable here — every authenticated route
 * is unreachable while the container is being recreated.
 *
 * A 200 alone only means the process is listening: the boot gate is mounted
 * after `/health`, so auto-resume can still be replaying teams. `boot_complete`
 * is the bit that means "back". Absent (older server) ⇒ nothing to wait for.
 */
type BootPhase = 'idle' | 'down' | 'booting' | 'up';

async function probeBoot(): Promise<BootPhase> {
  try {
    const h = await api.health();
    if (h && typeof h === 'object' && h.boot_complete === false) return 'booting';
    return 'up';
  } catch {
    return 'down';
  }
}

const BOOT_COPY: Record<BootPhase, string> = {
  idle: 'the container is about to be recreated.',
  down: 'the server has stopped answering — that is expected: the container is being recreated.',
  booting:
    'the server answers, but the boot is not finished (boot_complete=false) — the teams are being brought back.',
  up: 'boot finished — reading the run verdict.',
};

export interface UpdateSectionProps {
  /** True when the drawer was opened FROM the TopBar update badge: scroll
   *  this section into view instead of leaving it below the fold. */
  focus?: boolean;
}

export function UpdateSection({ focus = false }: UpdateSectionProps) {
  const [state, setState] = useState<UpdatesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  /** `GET /updates` answered 503: the server is up but still replaying teams. */
  const [bootGated, setBootGated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // -- run tracking --------------------------------------------------------
  const [run, setRun] = useState<UpdateRunView | UpdateRunDetail | null>(null);
  /** Wall-clock deadline of the warning window, re-anchored on every poll. */
  const [graceDeadline, setGraceDeadline] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [bootPhase, setBootPhase] = useState<BootPhase>('idle');
  /** A write route answered 503: this build has detection but no apply engine. */
  const [noRunner, setNoRunner] = useState<string | null>(null);
  const [graceInput, setGraceInput] = useState(String(DEFAULT_GRACE_SECONDS));
  const [atInput, setAtInput] = useState('');
  const [mountedAt] = useState(() => Date.now());

  // -- the restart window ---------------------------------------------------
  /** When the current `applying`/`verifying` window opened; null outside one. */
  const [restartOpenedAt, setRestartOpenedAt] = useState<number | null>(null);
  /** Same value, readable from inside the poll without re-arming it. */
  const restartOpenedAtRef = useRef<number | null>(null);
  /** The operator closed the overlay; the run carries on without the screen. */
  const [restartDismissed, setRestartDismissed] = useState(false);
  /** The probe gave up waiting. Non-null = it will not re-arm on its own. */
  const [restartStalled, setRestartStalled] = useState<string | null>(null);

  // -- post-update reconciliation ------------------------------------------
  const [liveTeams, setLiveTeams] = useState<OrchestratorView[] | null>(null);
  const [restarting, setRestarting] = useState(false);
  /**
   * Teams this screen has already restarted. A restart is a fresh start in
   * place — it kills a live lead — so the second click must be a no-op, not a
   * second kill.
   */
  const [restartedIds, setRestartedIds] = useState<ReadonlySet<string>>(() => new Set());

  /** Store a run AND re-anchor the local countdown from its remaining seconds. */
  const commitRun = useCallback((r: UpdateRunView | UpdateRunDetail | null): void => {
    setRun(r);
    if (r && r.state === 'warning_teams' && r.graceRemainingSeconds !== null) {
      setGraceDeadline(Date.now() + r.graceRemainingSeconds * 1000);
    } else if (!r || r.state !== 'warning_teams') {
      setGraceDeadline(null);
    }
    // A settled run leaves no restart in progress: don't let a later one open
    // on the previous run's last-known boot phase.
    if (!r || r.terminal) setBootPhase('idle');
  }, []);

  /** False once this section is gone — nothing below writes state after that. */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  /** The one read of `GET /updates`: used on mount, and by the boot-gate retry. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setBootGated(false);
    try {
      const s: unknown = await api.getUpdates();
      if (!aliveRef.current) return;
      if (isUpdatesView(s)) {
        setState(s);
        commitRun(s.run ?? null);
      } else setUnsupported(true);
    } catch (err) {
      if (!aliveRef.current) return;
      // 401 is not a failure to report as one: the drawer auto-opens
      // precisely when the token is missing, and the section sits below the
      // input that fixes it.
      if (err instanceof HttpError && err.status === 401) setUnauthorized(true);
      // 404 = this server predates the route. That is a fact about the
      // deployment, not an error the operator should debug.
      else if (err instanceof HttpError && err.status === 404) setUnsupported(true);
      // 503 = the boot gate. Every business route answers this while
      // auto-resume replays the teams — which is EXACTLY when this drawer is
      // opened right after an update. Not an error: a phase, with a way out.
      else if (err instanceof HttpError && err.status === 503) setBootGated(true);
      else setError(messageOf(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [commitRun]);

  // Fetched once, on open. No interval: an update is a human-cadence event and
  // the drawer is a screen you close.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // `scrollIntoView` is not implemented in jsdom — optional-call it.
    if (focus) rootRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focus]);

  /**
   * THE POLL. Armed only by a non-terminal run, disarmed by its terminal state.
   * Each tick commits a fresh run object, which re-runs this effect and arms
   * the next tick — one timer at a time, by construction.
   *
   * While `applying`/`verifying`, the authenticated route is unreachable: the
   * container is being replaced. So the tick first probes public `/health` and
   * only asks for the verdict once the new process reports `boot_complete`.
   *
   * That wait is CAPPED. `boot_complete` is a promise the new container can
   * fail to keep — a `healthy_no_boot_complete` deployment answers /health and
   * never flips the bit — and an uncapped re-arm turns the full-screen overlay
   * into a permanent one while the server already holds the verdict.
   */
  useEffect(() => {
    if (!run || run.terminal) return;
    const id = run.id;
    const gated = run.state === 'applying' || run.state === 'verifying';
    let alive = true;
    let handle: ReturnType<typeof setTimeout> | undefined;

    /** Past the cap: stop, say so, and let the overlay be closed. */
    const giveUp = (): boolean => {
      const opened = restartOpenedAtRef.current;
      if (!gated || opened === null || Date.now() - opened <= RESTART_GIVE_UP_MS) return false;
      setRestartStalled(
        `no verdict after ${Math.round(RESTART_GIVE_UP_MS / 60_000)} minutes — this screen stopped waiting. The run continues on the host; reopen this drawer to read its verdict.`,
      );
      return true;
    };

    const step = async (): Promise<void> => {
      if (!alive) return;
      if (giveUp()) return;
      if (gated) {
        const phase = await probeBoot();
        if (!alive) return;
        setBootPhase(phase);
        if (phase !== 'up') {
          handle = setTimeout(() => void step(), RESTART_POLL_MS);
          return;
        }
      }
      try {
        const { run: fresh } = await api.getUpdateRun(id);
        if (!alive) return;
        commitRun(fresh);
      } catch (err) {
        if (!alive) return;
        if (err instanceof HttpError && err.status === 404) {
          setError(
            'the run is gone from the server (purged, or the database started over) — its verdict cannot be known.',
          );
          commitRun(null);
          return;
        }
        // Anything else here is the expected shape of a container being
        // recreated (connection refused, a proxy's 502, a 401 from a server
        // that has not finished loading its token). Keep waiting.
        handle = setTimeout(() => void step(), RESTART_POLL_MS);
      }
    };

    handle = setTimeout(() => void step(), POLL_MS[run.state] ?? 2_000);
    return () => {
      alive = false;
      if (handle) clearTimeout(handle);
    };
  }, [run, commitRun]);

  /**
   * The restart window, anchored ONCE per run. Not derived from the poll: each
   * successful tick that comes back still `verifying` would otherwise restart
   * the clock and the cap above would never be reached.
   */
  const inRestartWindow =
    run !== null && !run.terminal && (run.state === 'applying' || run.state === 'verifying');
  useEffect(() => {
    if (!inRestartWindow) {
      restartOpenedAtRef.current = null;
      setRestartOpenedAt(null);
      setRestartDismissed(false);
      setRestartStalled(null);
      return;
    }
    if (restartOpenedAtRef.current !== null) return;
    const openedAt = Date.now();
    restartOpenedAtRef.current = openedAt;
    setRestartOpenedAt(openedAt);
  }, [inRestartWindow]);

  // Local 1 s clock, alive while a countdown or the restart overlay is up —
  // and not one tick longer: a dismissed overlay has nothing left to count.
  const counting = run !== null && run.state === 'warning_teams';
  const ticking = counting || (inRestartWindow && !restartDismissed);
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [ticking]);

  const activeRun = run && !run.terminal ? run : null;
  // Deliberately the two-member union: the polled run IS a detail (log tail and
  // run directory), a `recentRuns` entry never is, and the screen must be able
  // to tell them apart rather than promise a log it does not have.
  const finishedRun: UpdateRunView | UpdateRunDetail | null = useMemo(() => {
    if (run?.terminal) return run;
    return state?.recentRuns?.find((r) => r.terminal) ?? null;
  }, [run, state]);

  /** The finished run whose casualties are still worth showing. */
  const postUpdateRun = useMemo(() => {
    if (!finishedRun || finishedRun.teamsSnapshot.length === 0) return null;
    const done = finishedRun.finishedAt ? Date.parse(finishedRun.finishedAt) : Number.NaN;
    if (!Number.isFinite(done) || mountedAt - done > POST_UPDATE_WINDOW_MS) return null;
    return finishedRun;
  }, [finishedRun, mountedAt]);

  /**
   * The server's own reconciliation wins whenever the run carries one: it was
   * written by the boot that followed the update, from the world as it was at
   * that instant. `GET /orchestrators` only describes the present, and the
   * present drifts away from that instant — a team restarted by hand since, a
   * team stopped since — until it says nothing about the update at all.
   *
   * So: no fetch when the record exists. Not an optimisation — it is what
   * keeps one source of truth on screen instead of two that can disagree.
   */
  const needsClientReconcile = postUpdateRun !== null && !hasServerReconciliation(postUpdateRun);

  useEffect(() => {
    if (!postUpdateRun || !needsClientReconcile) return;
    let alive = true;
    void (async () => {
      try {
        const { orchestrators } = await api.listOrchestrators();
        if (alive) setLiveTeams(orchestrators);
      } catch {
        // Non-fatal: without the live list we simply cannot say who came back.
        if (alive) setLiveTeams(null);
      }
    })();
    return () => { alive = false; };
  }, [postUpdateRun, needsClientReconcile]);

  const teamReturns = useMemo(
    () => (postUpdateRun ? resolveTeamReturns(postUpdateRun, liveTeams) : null),
    [postUpdateRun, liveTeams],
  );

  const casualties: TeamReturn[] = useMemo(
    () => (teamReturns ? teamReturns.teams.filter((t) => !t.back) : []),
    [teamReturns],
  );

  // -- actions --------------------------------------------------------------

  function handleWriteError(err: unknown): void {
    if (err instanceof HttpError && err.status === 503) {
      // Not a failure: a fact about this build. Say it, and stop offering the
      // controls that would 503 again.
      setNoRunner(messageOf(err));
      return;
    }
    if (err instanceof HttpError && err.status === 409) {
      setError(messageOf(err));
      void refresh();
      return;
    }
    setError(messageOf(err));
  }

  async function refresh(): Promise<void> {
    try {
      const s: unknown = await api.getUpdates();
      if (isUpdatesView(s)) {
        setState(s);
        commitRun(s.run ?? null);
      }
    } catch {
      /* the section already shows whatever it had */
    }
  }

  async function dismiss(version: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const { system } = await api.dismissUpdate(version);
      setState((prev) => (prev === null ? prev : { ...prev, system }));
      setLastResult(
        version === null
          ? '✓ update notices re-enabled'
          : `✓ v${version} hidden — the badge stays off until a newer release`,
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  /** Requested window, floored at 120 s — the server would floor it anyway. */
  function effectiveGrace(): number {
    const n = Number(graceInput);
    if (!Number.isFinite(n)) return DEFAULT_GRACE_SECONDS;
    return Math.max(MIN_GRACE_SECONDS, Math.floor(n));
  }

  async function startApply(targetVersion: string): Promise<void> {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const r = await api.applyUpdate({ targetVersion, graceSeconds: effectiveGrace() });
      commitRun(r.run ?? null);
      if (!r.run) await refresh();
      setLastResult(`✓ run ${r.runId} started`);
    } catch (err) {
      handleWriteError(err);
    } finally {
      setBusy(false);
    }
  }

  async function startSchedule(targetVersion: string): Promise<void> {
    // `datetime-local` yields wall-clock text with no zone; `new Date()` reads
    // it in the operator's zone, which is the zone they typed it in.
    const at = new Date(atInput);
    if (Number.isNaN(at.getTime())) {
      setError('invalid date — pick a date and a time.');
      return;
    }
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const r = await api.scheduleUpdate({
        at: at.toISOString(),
        targetVersion,
        graceSeconds: effectiveGrace(),
      });
      commitRun(r.run ?? null);
      if (!r.run) await refresh();
      setLastResult(`✓ scheduled for ${at.toLocaleString()}`);
    } catch (err) {
      handleWriteError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * End the warning window early. The server owns the decision: it recomputes
   * the {@link MIN_GRACE_SECONDS} floor from its own clock and answers 409 —
   * naming the seconds left — when we ask too early. The button is only offered
   * past the floor, so that 409 should be unreachable; it is surfaced verbatim
   * anyway, because "should" here means "unless the two clocks disagree".
   */
  async function applyNowRun(target: UpdateRunView): Promise<void> {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const r = await api.applyUpdateNow(target.id);
      commitRun(r.run ?? null);
      if (!r.run) await refresh();
      setLastResult('✓ window ended — applying now');
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Either the run is gone, or this server predates the route. Both are
        // facts, not failures: the update still applies at its deadline.
        setError(
          `${messageOf(err)} — the window cannot be shortened; the update applies at its deadline.`,
        );
        await refresh();
        return;
      }
      handleWriteError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(target: UpdateRunView): Promise<void> {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      if (target.state === 'scheduled') await api.cancelUpdateSchedule();
      else await api.cancelUpdateRun(target.id);
      setLastResult('✓ cancelled — nothing was touched');
      await refresh();
    } catch (err) {
      handleWriteError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fresh start in place, one team at a time — never a burst of respawns, and
   * **never against a record**.
   *
   * The list on screen is history: the server's reconciliation says what was
   * true on the boot that followed the update, and it is right to render. It is
   * the wrong thing to act on. `restartOrchestrator` kills the lead and spawns
   * a new one with no context, so a team that has come back since — restarted
   * by hand, or by this very button a minute ago — must not be touched.
   *
   * Hence: read `GET /orchestrators` HERE, in both modes, and check every
   * casualty against the present before killing anything. If that read fails,
   * nothing is restarted at all: an unverifiable destructive action is not
   * performed.
   */
  async function restartTeams(teams: readonly TeamReturn[]): Promise<void> {
    setRestarting(true);
    setError(null);
    setLastResult(null);
    let live: OrchestratorView[];
    try {
      ({ orchestrators: live } = await api.listOrchestrators());
    } catch (err) {
      setError(
        `${messageOf(err)} — the live teams could not be read, so nothing was restarted. A restart kills the lead where it stands; it is not done against a record alone.`,
      );
      setRestarting(false);
      return;
    }
    const done = new Set(restartedIds);
    let ok = 0;
    let running = 0;
    let already = 0;
    const failed: string[] = [];
    for (const t of teams) {
      if (done.has(t.orchestratorId)) {
        already += 1;
        continue;
      }
      if (isTeamLive(live.find((o) => o.id === t.orchestratorId))) {
        running += 1;
        continue;
      }
      try {
        await api.restartOrchestrator(t.orchestratorId);
        done.add(t.orchestratorId);
        ok += 1;
      } catch (err) {
        failed.push(`${t.name} (${messageOf(err)})`);
      }
    }
    setRestartedIds(done);
    const parts = [`${ok} team${ok === 1 ? '' : 's'} restarted`];
    if (running > 0) parts.push(`${running} already running — skipped`);
    if (already > 0) parts.push(`${already} already restarted from this screen — skipped`);
    setLastResult(
      `✓ ${parts.join(', ')}` + (failed.length > 0 ? ` · failed: ${failed.join(', ')}` : ''),
    );
    // Only the fallback path renders off this list; when the server recorded
    // the reconciliation, that record is history and does not get rewritten by
    // what an operator does afterwards. Re-read AFTER the restarts — the list
    // fetched above is the "before" picture, by construction.
    if (needsClientReconcile) {
      try {
        const { orchestrators } = await api.listOrchestrators();
        setLiveTeams(orchestrators);
      } catch {
        /* the list refresh is a courtesy, not the action */
      }
    }
    setRestarting(false);
  }

  // -- derived --------------------------------------------------------------

  const system = state?.system ?? null;
  const eligibility = state?.canSelfUpdate ?? null;
  const copy = eligibility ? SELF_UPDATE_COPY[eligibility.status] : null;
  const pluginsAvailable =
    state?.plugins.filter((p) => p.status === 'available').length ?? 0;
  const checkNote = system ? CHECK_COPY[system.checkStatus] : undefined;

  /**
   * Does this build have an apply engine? `updater` is the engine's own
   * descriptor (version + sha256 of the script it would run) and the server
   * sends `null` for it — explicitly — when no runner is attached, which is the
   * same condition that makes every write route answer 503.
   *
   * NOT `run !== undefined || recentRuns !== undefined`: `getFullState()`
   * always emits those two keys (`null` and `[]` when there is no runner), so
   * that test was true for every server that can answer `GET /updates` at all.
   * A server old enough to omit `updater` entirely reads as `undefined` here —
   * unknown, so we keep offering and let its 503 be the answer.
   */
  const engineMissing = state !== null && state.updater === null;
  const applySupported = state !== null && !engineMissing;
  const eligibleToApply =
    eligibility !== null && (eligibility.status === 'ok' || eligibility.status === 'unknown');
  const target = system?.latest ?? null;
  const canOfferApply =
    applySupported && eligibleToApply && noRunner === null && activeRun === null &&
    system !== null && system.available && target !== null;
  /** The no-engine panel: shown on the server's own 503, or on `updater: null`
   *  — never make an operator click a button to learn it does not exist. */
  const noEngineNote = noRunner ?? (engineMissing ? NO_ENGINE_COPY : null);

  const graceRemaining =
    graceDeadline !== null
      ? Math.max(0, (graceDeadline - nowMs) / 1000)
      : (activeRun?.graceRemainingSeconds ?? 0);
  const busyMs = activeRun ? elapsedSince(activeRun.warnedAt, nowMs) : null;
  /**
   * Seconds left of the hard {@link MIN_GRACE_SECONDS} floor, computed exactly
   * as `POST /updates/apply-now` computes it (from `warnedAt`). `null` means
   * the run carries no window start — the server refuses on that too, so the
   * shortcut stays off rather than posting into a guaranteed 409.
   */
  const floorRemaining =
    busyMs === null ? null : Math.max(0, Math.ceil((MIN_GRACE_SECONDS * 1000 - busyMs) / 1000));
  const verdict = finishedRun ? terminalVerdict(finishedRun) : null;
  /**
   * The run log only exists on a run READ BACK from `GET /updates/:id` — the
   * poll's own object. `recentRuns` carries the view, never the tail, so this
   * block appears exactly when there is something in it and never promises a
   * log that is not on screen.
   */
  const finishedDetail = finishedRun !== null && isRunDetail(finishedRun) ? finishedRun : null;
  const finishedTail =
    finishedDetail !== null && finishedDetail.logTail.trim().length > 0 ? finishedDetail : null;
  const showOverlay =
    !restartDismissed &&
    activeRun !== null &&
    (activeRun.state === 'applying' || activeRun.state === 'verifying');
  /** How long the container has been away, for the overlay's escape hatch. */
  const restartElapsedMs = restartOpenedAt === null ? 0 : Math.max(0, nowMs - restartOpenedAt);

  return (
    <div className="drawer-section" ref={rootRef}>
      <div className="h">SYSTEM UPDATE</div>

      {loading && <div className="field-help">checking…</div>}

      {unauthorized && (
        <div className="field-help">
          set a valid token above to check for updates — the version check is
          behind the auth gate.
        </div>
      )}

      {unsupported && (
        <div className="field-help">
          this server does not expose <code>GET /updates</code> — version
          detection ships with a newer swarm-os. Update from the host shell
          with <span className="mono">{INSTALL_CMD}</span>.
        </div>
      )}

      {bootGated && (
        <div className="field">
          <div className="field-help">
            the server is up but still finishing its boot — auto-resume is
            bringing the teams back, and every authenticated route answers 503
            until it is done. Nothing is wrong; this is what the minute after an
            update looks like.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? 'CHECKING…' : 'CHECK AGAIN'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="field-warn">⚠ {error}</div>}

      {system && (
        <>
          <div className="field">
            <div
              className="field-help"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {/*
                Green means "checked, and up to date". `available === false` is
                also what a check that never ran, was refused a token or 404'd
                looks like — painting those green would be the UI inventing an
                all-clear out of a missing answer.
              */}
              <span
                className={`dot ${
                  system.available ? 'warn' : system.checkStatus === 'ok' ? 'ok' : 'stopped'
                }`}
              />
              {system.available ? (
                <span style={{ color: 'var(--text)' }}>
                  v{system.latest} available
                  <span style={{ color: 'var(--text-mute)' }}>
                    {' '}· running v{system.current}
                  </span>
                </span>
              ) : (
                <span>
                  running v{system.current}
                  {system.checkStatus === 'ok' &&
                  system.latest &&
                  system.latest === system.current
                    ? ' · up to date'
                    : ''}
                </span>
              )}
            </div>
            {checkNote && <div className="field-help">{checkNote}</div>}
            {system.checkStatus === 'error' && system.error && (
              <div className="field-help" style={{ color: 'var(--warn)' }}>
                last check failed :: {system.error}
              </div>
            )}
            {system.checkStatus === 'rate_limited' && (
              <div className="field-help" style={{ color: 'var(--warn)' }}>
                {system.error ??
                  'GitHub API rate limit reached — the next check retries on its own.'}
              </div>
            )}
            {(system.checkStatus === 'ok' || system.checkStatus === 'no_releases') &&
              system.error && (
                // The verdict is valid; the note says the configured token was
                // rejected and the check ran without it.
                <div className="field-help" style={{ color: 'var(--warn)' }}>
                  {system.error}
                </div>
              )}
            {system.dismissedVersion && (
              <div className="field-help">
                v{system.dismissedVersion} is hidden.{' '}
                <button
                  type="button"
                  className="btn ghost"
                  style={{ padding: '2px 8px', fontSize: 10 }}
                  onClick={() => void dismiss(null)}
                  disabled={busy}
                >
                  SHOW AGAIN
                </button>
              </div>
            )}
          </div>

          {/* ── A run is in flight ─────────────────────────────────────── */}
          {activeRun && (
            <RunInFlight
              run={activeRun}
              busy={busy}
              remainingSeconds={graceRemaining}
              busyMs={busyMs}
              floorRemaining={floorRemaining}
              onCancel={() => void cancelRun(activeRun)}
              onApplyNow={() => void applyNowRun(activeRun)}
            />
          )}

          {/* ── Apply / schedule ───────────────────────────────────────── */}
          {canOfferApply && target && (
            <div className="field">
              <label>APPLY v{target}</label>
              <div className="field-help">
                rewrites <code>SWARM_OS_IMAGE</code> in the deployment .env,
                recreates the container and checks <code>/health</code> up to{' '}
                <code>boot_complete</code> · automatic rollback otherwise ·
                /data (DB, tokens, teams) persists
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  aria-label="warning window (seconds)"
                  min={MIN_GRACE_SECONDS}
                  step={30}
                  value={graceInput}
                  onChange={(e) => setGraceInput(e.target.value)}
                  style={{ width: 90 }}
                  disabled={busy}
                />
                <span className="field-help" style={{ margin: 0 }}>
                  s of warning to the leads
                </span>
              </div>
              <div className="field-help">
                {MIN_GRACE_SECONDS} s floor: below that it is no longer a
                warning but an announcement — a lead mid-turn has no chance of
                reaching an idle boundary.{' '}
                {Number(graceInput) < MIN_GRACE_SECONDS
                  ? `${effectiveGrace()} s will be sent.`
                  : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void startApply(target)}
                  disabled={busy}
                >
                  {busy ? 'STARTING…' : 'APPLY NOW'}
                </button>
              </div>
              <label style={{ marginTop: 8 }}>SCHEDULE (one shot)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="datetime-local"
                  aria-label="update date and time"
                  value={atInput}
                  onChange={(e) => setAtInput(e.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void startSchedule(target)}
                  disabled={busy || atInput === ''}
                >
                  SCHEDULE
                </button>
              </div>
              <div className="field-help">
                a one-shot at a date, re-armed at boot — not a recurrence. The
                teams are warned when it comes due.
              </div>
            </div>
          )}

          {noEngineNote && (
            <div className="field">
              <label>APPLY :: NO ENGINE IN THIS BUILD</label>
              <div className="field-help">{noEngineNote}</div>
              <div className="field-help">
                this is not a fault: this instance knows how to detect versions
                but has nothing wired to install them. Update from the host
                shell with{' '}
                <span className="mono">{INSTALL_CMD}</span>.
              </div>
            </div>
          )}

          {system.available && (
            <div className="field">
              <label>
                RELEASE {system.tag ?? `v${system.latest}`}
                {isoDay(system.publishedAt) ? ` · ${isoDay(system.publishedAt)}` : ''}
              </label>
              {system.notesBody ? (
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    maxHeight: 180,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--text-dim)',
                    background: 'var(--panel-elev)',
                    border: '1px solid var(--border)',
                    padding: 8,
                  }}
                >
                  {system.notesBody}
                </pre>
              ) : (
                <div className="field-help">no release notes published.</div>
              )}
              {system.notesUrl && (
                <div className="field-help">
                  <a
                    href={system.notesUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ color: 'var(--amber)' }}
                  >
                    open the release page ↗
                  </a>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void dismiss(system.latest)}
                  disabled={busy || system.latest === null}
                >
                  {busy ? 'HIDING…' : 'HIDE THIS VERSION'}
                </button>
              </div>
            </div>
          )}

          {/* Eligibility — the reason, then the command that works today. */}
          {eligibility && copy && (
            <div className="field">
              <label>ONE-CLICK UPDATE :: {copy.label}</label>
              <div className="field-help">
                {eligibility.detail.trim().length > 0
                  ? eligibility.detail
                  : copy.fallback}
              </div>
              <div className="field-help">
                To update now, run this on the host, in the deployment
                directory:
              </div>
              <div
                className="mono"
                style={{
                  border: '1px solid var(--border)',
                  padding: '6px 8px',
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  userSelect: 'all',
                }}
              >
                {INSTALL_CMD}
              </div>
              <div className="field-help">
                pulls the image and recreates the container · /data (DB, tokens,
                teams) persists
              </div>
            </div>
          )}

          {/* ── Verdict of the last run ────────────────────────────────── */}
          {finishedRun && verdict && (
            <div className="field">
              <label style={{ color: TONE_COLOR[verdict.tone] }}>
                LAST UPDATE :: {verdict.title}
              </label>
              <div className="field-help">{verdict.body}</div>
              <div className="field-help" style={{ color: 'var(--text-mute)' }}>
                {localStamp(finishedRun.finishedAt ?? finishedRun.startedAt)} ·{' '}
                <span className="mono">{finishedRun.id}</span>
              </div>
              {finishedTail && (
                <>
                  <div className="field-help">
                    tail of the host updater log ·{' '}
                    <span className="mono">{finishedTail.runDir}</span> on the host
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      maxHeight: 160,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: 'var(--text-dim)',
                      background: 'var(--panel-elev)',
                      border: '1px solid var(--border)',
                      padding: 8,
                    }}
                  >
                    {finishedTail.logTail}
                  </pre>
                </>
              )}
              {verdict.retry && target && applySupported && eligibleToApply && noRunner === null && (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void startApply(target)}
                    disabled={busy}
                  >
                    RETRY v{target}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Post-update: who did not come back ─────────────────────── */}
          {postUpdateRun && teamReturns && (
            <PostUpdateTeams
              run={postUpdateRun}
              teams={teamReturns.teams}
              source={teamReturns.source}
              casualties={casualties}
              restarting={restarting}
              exhausted={
                casualties.length > 0 &&
                casualties.every((t) => restartedIds.has(t.orchestratorId))
              }
              onRestart={() => void restartTeams(casualties)}
            />
          )}

          {pluginsAvailable > 0 && (
            <div className="field-help">
              {pluginsAvailable} plugin update{pluginsAvailable > 1 ? 's' : ''}{' '}
              available — upgrade from the PLUGINS page.
            </div>
          )}
        </>
      )}

      {lastResult && (
        <div className="field-help" style={{ color: 'var(--ok)' }}>
          {lastResult}
        </div>
      )}

      {showOverlay && activeRun && (
        <RestartOverlay
          run={activeRun}
          phase={bootPhase}
          elapsedMs={restartElapsedMs}
          stalled={restartStalled}
          onDismiss={() => {
            setRestartDismissed(true);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The warning window — the operator-facing moment (§D.5)
// ---------------------------------------------------------------------------

/**
 * Dot class per notice state. `pending` pulses: it is a state that moves, and
 * it is the one the server now writes the instant the window opens — nothing
 * observed yet, not a verdict. `never_idle` keeps the `bad` dot because by the
 * time it appears it IS one.
 */
function noticeDot(state: NoticeRowState): string {
  switch (state) {
    case 'read':
      return 'ok';
    case 'no_lead':
      return 'stopped';
    case 'queued_unread':
      return 'warn';
    case 'pending':
      return 'waiting';
    case 'never_idle':
      return 'bad';
    default:
      return 'bad';
  }
}

function RunInFlight({
  run,
  busy,
  remainingSeconds,
  busyMs,
  floorRemaining,
  onCancel,
  onApplyNow,
}: {
  run: UpdateRunView;
  busy: boolean;
  remainingSeconds: number;
  busyMs: number | null;
  /** Seconds left of the 120 s floor; 0 = elapsed, null = no recorded start. */
  floorRemaining: number | null;
  onCancel: () => void;
  onApplyNow: () => void;
}) {
  const version = run.targetVersion ? `v${run.targetVersion}` : 'the new version';

  if (run.state === 'scheduled') {
    return (
      <div className="field">
        <label style={{ color: 'var(--amber)' }}>SCHEDULED UPDATE :: {version}</label>
        <div className="field-help">
          due at {localStamp(run.scheduledFor)} · the leads are warned then, and
          the container is recreated after that.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            CANCEL SCHEDULE
          </button>
        </div>
      </div>
    );
  }

  if (run.state === 'warning_teams') {
    const floorElapsed = floorRemaining !== null && floorRemaining <= 0;
    /**
     * The roster comes from `teamsSnapshot` — taken before the notices go out —
     * not from `teamsWarned`, which the server writes when the window SETTLES.
     * Counting the records is what put "No team is active — nothing to
     * interrupt" on screen for the entire five minutes during which three teams
     * were being cut off.
     */
    const rows = warningRows(run.teamsSnapshot, run.teamsWarned);
    return (
      <div className="field">
        <label style={{ color: 'var(--warn)' }}>
          WARNING THE TEAMS :: {version}
        </label>
        <div style={{ color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
          {warningSummary(rows, remainingSeconds, busyMs)}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 22,
            letterSpacing: '0.08em',
            color: 'var(--amber)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatCountdown(remainingSeconds)}
        </div>
        {rows.length > 0 && (
          <div style={{ display: 'grid', gap: 3 }}>
            {rows.map((t) => (
              <div
                key={t.orchestratorId}
                className="field-help"
                style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}
              >
                <span className={`dot ${noticeDot(t.state)}`} />
                <span style={{ color: 'var(--text-dim)' }}>{t.name}</span>
                <span>:: {noticeStateLabel(t.state)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          {/*
            `POST /updates/apply-now` truncates the window — but only past the
            hard MIN_GRACE_SECONDS floor, which the server re-checks and
            refuses (409, naming the seconds left) inside. So the control is
            live only once the floor has elapsed here too: never offer a button
            the server will refuse. `null` (no recorded window start) is also a
            refusal server-side, and keeps it off.
          */}
          <button
            type="button"
            className="btn ghost"
            onClick={onApplyNow}
            disabled={busy || !floorElapsed}
            title={
              floorElapsed
                ? 'end the warning window now — leads that have not read the notice are interrupted where they stand'
                : floorRemaining === null
                  ? 'this run has no recorded window start; the server cannot show the floor has elapsed'
                  : `the ${MIN_GRACE_SECONDS} s floor has ${formatCountdown(floorRemaining)} left`
            }
          >
            APPLY NOW
          </button>
        </div>
        <div className="field-help">
          {floorElapsed
            ? `the ${MIN_GRACE_SECONDS} s floor has elapsed — “apply now” ends the window immediately, read or not. A lead that has not read the notice is interrupted where it stands.`
            : floorRemaining === null
              ? `“apply now” needs a recorded start for the window, and this run has none — the update applies at its deadline, read or not.`
              : `“apply now” unlocks once the ${MIN_GRACE_SECONDS} s floor has elapsed — ${formatCountdown(floorRemaining)} left. Below it the server refuses: a lead mid-turn would have no chance to reach an idle boundary and read the notice. The update applies at the deadline either way, read or not.`}
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label style={{ color: 'var(--amber)' }}>UPDATE IN PROGRESS :: {version}</label>
      <div className="field-help">
        {phaseLabel(run.state)}
        {run.phase ? ` · ${run.phase}` : ''}
        {run.state === 'preflight'
          ? ' — nothing has been written yet; a preflight that says no ends as “refused” without touching anything.'
          : ' — nothing left to cancel: past the preflight the host script runs to its own verdict.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The restart window — full screen, driven by /health
// ---------------------------------------------------------------------------

function RestartOverlay({
  run,
  phase,
  elapsedMs,
  stalled,
  onDismiss,
}: {
  run: UpdateRunView;
  phase: BootPhase;
  /** Time since this window opened — the escape hatch is gated on it. */
  elapsedMs: number;
  /** Non-null once the probe stopped waiting; its sentence, verbatim. */
  stalled: string | null;
  onDismiss: () => void;
}) {
  const version = run.targetVersion ? `v${run.targetVersion}` : 'the new version';
  // A full-screen portal with no way out is a trap: the container may never
  // report `boot_complete` (healthy_no_boot_complete), and then this screen
  // would be the last thing the operator ever sees of the app.
  const canEscape = stalled !== null || elapsedMs > RESTART_ESCAPE_MS;
  return createPortal(
    <div
      role="alertdialog"
      aria-label="update in progress"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        background: 'rgba(8, 6, 4, 0.92)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 560,
          display: 'grid',
          gap: 12,
          border: '1px solid var(--border-strong)',
          background: 'var(--panel-solid)',
          padding: '24px 26px',
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 13, letterSpacing: '0.2em', color: 'var(--amber)' }}
        >
          UPDATE IN PROGRESS · {version}
        </div>
        <div style={{ color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
          {phaseLabel(run.state)}.
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6 }}>
          {BOOT_COPY[phase]}
        </div>
        <div className="field-help" style={{ margin: 0 }}>
          this page polls <code>/health</code> — public, mounted before the
          token check — until <code>boot_complete</code>, then reads the run
          verdict. A 200 on its own is not enough: it only proves the process is
          listening.
        </div>
        <div className="field-help" style={{ margin: 0 }}>
          the teams are interrupted while the container is recreated, and
          brought back by auto-resume · <span className="mono">{run.id}</span> ·
          waiting for {formatCountdown(elapsedMs / 1000)}
        </div>
        {stalled ? (
          <div className="field-help" style={{ margin: 0, color: 'var(--bad)' }}>
            {stalled} A container that answers <code>/health</code> but never
            reports <code>boot_complete</code> ends up here: the update may well
            have succeeded on the host. Check the teams.
          </div>
        ) : (
          <div className="field-help" style={{ margin: 0, color: 'var(--warn)' }}>
            do not close this tab — the run carries on without it, but you would
            lose the verification screen.
          </div>
        )}
        {canEscape && (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onDismiss}>
              CLOSE THIS SCREEN
            </button>
            <span className="field-help" style={{ margin: 0, alignSelf: 'center' }}>
              closing changes nothing on the host — the run keeps going and the
              drawer reads its verdict.
            </span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Post-update — who did not come back (§D.6)
// ---------------------------------------------------------------------------

function PostUpdateTeams({
  run,
  teams,
  source,
  casualties,
  restarting,
  exhausted,
  onRestart,
}: {
  run: UpdateRunView;
  /** Every team of the pre-update snapshot, back or not. */
  teams: readonly TeamReturn[];
  /** Which of the two sources produced `teams` — they are never mixed. */
  source: TeamReturnSource;
  casualties: readonly TeamReturn[];
  restarting: boolean;
  /** Every casualty has already been restarted from this screen. */
  exhausted: boolean;
  onRestart: () => void;
}) {
  const total = teams.length;
  const back = total - casualties.length;
  const provenance =
    source === 'server'
      ? 'recorded by the server on the boot that followed the update — this is what was true then, not a reading of the teams as they are now.'
      : 'this run predates the server-side record, so the list is computed now by diffing the pre-update snapshot against the live teams.';

  if (casualties.length === 0) {
    return (
      <div className="field">
        <label style={{ color: 'var(--ok)' }}>TEAMS :: ALL BACK</label>
        <div className="field-help">
          {back} of {total} team{total > 1 ? 's' : ''} {total > 1 ? 'were' : 'was'}{' '}
          alive before the update, and {back > 1 ? 'are' : 'is'} back with a lead.
        </div>
        <div className="field-help">{provenance}</div>
      </div>
    );
  }

  return (
    <div className="field">
      <label style={{ color: 'var(--bad)' }}>
        TEAMS :: {casualties.length} DID NOT COME BACK
      </label>
      <div className="field-help">
        {back} of {total} {back > 1 ? 'are' : 'is'} back with a live lead. The
        others were interrupted by the container being recreated and never
        restarted — a failed resume is final, the row in the database has
        already been flipped to <code>interrupted</code>.
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {casualties.map((t) => {
          const warned = run.teamsWarned.find((w) => w.orch_id === t.orchestratorId);
          return (
            <div key={t.orchestratorId} style={{ display: 'grid', gap: 2 }}>
              <div
                className="field-help"
                style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span className="dot bad" />
                <span style={{ color: 'var(--text-dim)' }}>{t.name}</span>
                <span>:: {returnReasonLabel(t.reason)}</span>
              </div>
              <div className="field-help" style={{ margin: 0 }}>
                {casualtyNotice(t.name, warned)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          className="btn primary"
          onClick={onRestart}
          disabled={restarting || exhausted}
          title={
            exhausted
              ? 'every team on this list has already been restarted from this screen — clicking again would kill the leads that just started'
              : 'checks each team against the live list first; anything already running is skipped'
          }
        >
          {restarting ? 'RESTARTING…' : exhausted ? 'RESTARTED' : 'RESTART TEAMS'}
        </button>
      </div>
      <div className="field-help">
        fresh start in place: the session starts from the beginning, not where
        the lead was. Anything not committed, or not written to the team log
        before the cut, is gone. Teams that are running again by the time you
        click are checked against the live list and skipped — this list is a
        record of the update, not of the present.
      </div>
      <div className="field-help">{provenance}</div>
    </div>
  );
}
