/**
 * Pure helpers for the system-update run surface (plan §D.1, §D.5, §D.6).
 *
 * Everything here is a function of data the server already sends, so it can be
 * tested without a DOM and without a server: the operator-facing sentences of
 * the warning window, the post-update casualty lines, the team reconciliation,
 * and the verdict copy for each terminal state.
 *
 * The strings are the load-bearing part of this feature: the countdown and the
 * post-update screen are the two moments where an operator decides whether to
 * trust the thing, so the wording is specified rather than improvised — and it
 * is blunt on purpose. A lead that never read the notice was cut off wherever
 * it happened to be, and the screen says exactly that.
 */
import type {
  LeadNoticeState,
  OrchestratorView,
  ReconciledTeamRecord,
  UpdateRunState,
  UpdateRunView,
  UpdateTeamSnapshot,
  WarnedTeamRecord,
} from '../api/client';

/**
 * The grace floor, mirrored from `MIN_GRACE_SECONDS` in the runner. Below two
 * minutes an operator is not warning, they are announcing: a lead mid-turn has
 * no realistic chance of reaching an idle boundary, reading the notice and
 * wrapping up. The server clamps to this, so the UI must never offer less.
 */
export const MIN_GRACE_SECONDS = 120;
export const DEFAULT_GRACE_SECONDS = 300;

/**
 * `72` → `01:12`; an hour or more grows a leading `H:`. Never negative.
 *
 * Rounds UP, like the server's own `graceRemainingSeconds`: 71.98 s left is
 * still "01:12" on a countdown, and flooring would make the display start one
 * second late — the first thing an operator would notice, and distrust.
 */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const tail = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return hh > 0 ? `${hh}:${tail}` : tail;
}

/** `271000` → `4m31`; under a minute → `31s`; an hour or more → `1h04`. */
export function formatBusy(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}`;
  return `${Math.floor(total / 3600)}h${String(Math.floor(total / 60) % 60).padStart(2, '0')}`;
}

/** ms since an ISO timestamp, or null when it is absent/unparsable. */
export function elapsedSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

/**
 * `pending` is "this team is in the window and nothing has been observed about
 * its lead yet" — and it is now a state the SERVER sends as well as one this
 * file synthesises.
 *
 * It has three sources, all the same claim:
 *  - the server's own placeholder row, written for every snapshot team the
 *    instant the window opens (it used to say `never_idle`, i.e. "this lead
 *    never reached an idle boundary", about leads whose notice had fired);
 *  - no record at all — `teamsWarned` can legitimately be `[]`, or short of the
 *    roster, while teams are minutes from being cut off, and a server older
 *    than the placeholder writes the column only when the window SETTLES;
 *  - a record whose `state` this build does not recognise, which must degrade
 *    to "we do not know" and never to a verdict.
 *
 * Hence the alias rather than a union: the row state and the wire state are the
 * same vocabulary, and the fallback lands on a value the server can also speak.
 */
export type NoticeRowState = LeadNoticeState;

/** One line of the warning list: a team of the snapshot, and what we know. */
export interface WarningRow {
  orchestratorId: string;
  name: string;
  state: NoticeRowState;
}

/** States this build understands; anything else is `pending` — see above. */
const KNOWN_NOTICE_STATES = new Set<string>([
  'read',
  'queued_unread',
  'never_idle',
  'no_lead',
  'pending',
]);

/**
 * The roster of the warning window: **`teamsSnapshot` is the authority on who
 * is being interrupted**, and `teamsWarned` only adds what has been observed.
 *
 * Reading the count off `teamsWarned` is what made the screen say "No team is
 * active — nothing to interrupt" while three leads were about to be killed:
 * the snapshot is taken before the notices go out, the records land at the end.
 * A team with no record yet is `pending`, never absent.
 *
 * A record whose `state` this build does not know is also `pending` rather than
 * silently counted as read — a newer server that persists placeholder rows the
 * instant the window opens must not be able to turn "unknown" into "fine". The
 * placeholder itself now arrives AS `pending`, so the two agree by construction
 * instead of by an unknown value happening to fall through the same branch.
 *
 * Records for teams that are not in the snapshot are kept at the end: a run
 * that predates the snapshot column would otherwise render as an empty list.
 */
export function warningRows(
  snapshot: readonly UpdateTeamSnapshot[],
  records: readonly WarnedTeamRecord[],
): WarningRow[] {
  const byId = new Map(records.map((r) => [r.orch_id, r]));
  const rows: WarningRow[] = snapshot.map((team) => {
    const record = byId.get(team.orchestratorId);
    return {
      orchestratorId: team.orchestratorId,
      name: team.name,
      state: record && KNOWN_NOTICE_STATES.has(record.state) ? record.state : 'pending',
    };
  });
  const seen = new Set(snapshot.map((t) => t.orchestratorId));
  for (const r of records) {
    if (seen.has(r.orch_id)) continue;
    rows.push({
      orchestratorId: r.orch_id,
      name: r.orch_name,
      state: KNOWN_NOTICE_STATES.has(r.state) ? r.state : 'pending',
    });
  }
  return rows;
}

/**
 * The countdown sentence. Four shapes:
 *
 *   3 teams warned — all leads have read it. Applying in 01:12.
 *   3 teams warned — 2 leads have not answered yet. Applying in 01:12.
 *   3 teams warned — 1 lead (stiix-infra) has not read it yet (busy for
 *   4m31). Applying anyway in 01:12.
 *   No team is active — nothing to interrupt. Applying in 01:12.
 *
 * "Applying anyway" is the point of the third one: the deadline is not a
 * negotiation, and an operator who reads "anyway" knows what they are about to
 * do to that lead.
 *
 * The last one is reserved for an EMPTY SNAPSHOT — nobody is being interrupted.
 * It must never appear because the read states have not landed yet; that is the
 * one sentence this feature exists to get right.
 *
 * `busyMs` is the time since the notices were armed (`warnedAt`): for a
 * `never_idle` lead that IS how long it has been busy, because `never_idle`
 * means it has not offered a single idle boundary since. It is a lower bound,
 * never an invention — and it is only ever attached to a state the server
 * OBSERVED, which is why the placeholder is `pending` and falls in the second
 * branch below rather than borrowing this sentence.
 */
export function warningSummary(
  rows: readonly WarningRow[],
  remainingSeconds: number,
  busyMs: number | null,
): string {
  const countdown = formatCountdown(remainingSeconds);
  const total = rows.length;
  if (total === 0) {
    return `No team is active — nothing to interrupt. Applying in ${countdown}.`;
  }
  const plural = total > 1 ? 's' : '';
  const head = `${total} team${plural} warned`;
  const unread = rows.filter((r) => r.state === 'queued_unread' || r.state === 'never_idle');
  const pending = rows.filter((r) => r.state === 'pending');
  const noLead = rows.filter((r) => r.state === 'no_lead');
  const noLeadAside =
    noLead.length > 0
      ? ` (${noLead.length} team${noLead.length > 1 ? 's' : ''} with no lead)`
      : '';

  if (unread.length === 0 && pending.length > 0) {
    // Honest about the gap: the notices are out, the read states are not in.
    // Not "all leads have read it", which would be an invention, and not
    // "nothing to interrupt", which would be a lie.
    const noun = pending.length > 1 ? 'leads' : 'lead';
    const verb = pending.length > 1 ? 'have' : 'has';
    return `${head} — ${pending.length} ${noun} ${verb} not answered yet${noLeadAside}. Applying in ${countdown}.`;
  }

  if (unread.length === 0) {
    return `${head} — all leads have read it${noLeadAside}. Applying in ${countdown}.`;
  }

  const names = unread.map((r) => r.name).join(', ');
  const verb = unread.length > 1 ? 'have not read it yet' : 'has not read it yet';
  const noun = unread.length > 1 ? 'leads' : 'lead';
  // The parenthetical only when there is exactly one — with several, the
  // per-team rows underneath say it better than a comma-separated blob.
  let aside = '';
  if (unread.length === 1) {
    const one = unread[0]!;
    if (one.state === 'never_idle' && busyMs !== null) aside = ` (busy for ${formatBusy(busyMs)})`;
    else if (one.state === 'never_idle') aside = ' (busy since the window opened)';
    else aside = ' (notice displayed in its terminal, not consumed yet)';
  }
  return `${head} — ${unread.length} ${noun} (${names}) ${verb}${aside}. Applying anyway in ${countdown}.`;
}

/** Short per-team label for the warning list. */
export function noticeStateLabel(state: NoticeRowState): string {
  switch (state) {
    case 'read':
      return 'read';
    case 'queued_unread':
      return 'displayed, unread';
    case 'never_idle':
      return 'never available';
    case 'no_lead':
      return 'no lead';
    case 'pending':
      return 'no answer yet';
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// §D.6 — who came back
// ---------------------------------------------------------------------------

export type TeamReturnReason = 'ok' | 'absent' | 'not_running' | 'no_lead' | 'lead_dead';

export interface TeamReturn {
  orchestratorId: string;
  name: string;
  /** Live, non-terminal, with a live lead. */
  back: boolean;
  reason: TeamReturnReason;
  /** Orchestrator status now; null when it is not in the live list at all. */
  status: string | null;
}

/** Where a `TeamReturn[]` came from — the two are never mixed. */
export type TeamReturnSource = 'server' | 'client';

export interface TeamReturnSet {
  source: TeamReturnSource;
  teams: TeamReturn[];
}

/** Lead session statuses that count as "the lead is there". */
const LEAD_ALIVE = new Set(['running', 'waiting', 'starting', 'paused']);

/**
 * Why this orchestrator is (or is not) a live team with a live lead, right now.
 * `undefined`/`null` — not in the live list at all — is `absent`.
 */
export function teamReturnReason(orch: OrchestratorView | undefined | null): TeamReturnReason {
  if (!orch) return 'absent';
  if (orch.status === 'stopped' || orch.status === 'failed' || orch.status === 'stopping') {
    return 'not_running';
  }
  const lead =
    orch.sessions.find((s) => s.id === orch.leadSessionId) ??
    orch.sessions.find((s) => s.type === 'lead');
  if (!lead) return 'no_lead';
  if (!LEAD_ALIVE.has(lead.status)) return 'lead_dead';
  return 'ok';
}

/**
 * "This team is up with a live lead." The test a DESTRUCTIVE action asks
 * before it fires: `restartOrchestrator` is a fresh start in place, so a team
 * that is running again — restarted by hand, or a moment ago — must not be
 * killed on the strength of a record written hours earlier.
 */
export function isTeamLive(orch: OrchestratorView | undefined | null): boolean {
  return teamReturnReason(orch) === 'ok';
}

/**
 * Diff the run's pre-update snapshot against what is live now. Mirrors
 * `Spawner.reconcileTeams` field for field, because the operator needs the same
 * distinction the server makes: "the team never came back at all" is not the
 * same failure as "it came back but its lead died on spawn" — the latter is the
 * resumed-lead-dies-over-SSH case, and it is the common one.
 *
 * This is the FALLBACK path (see `resolveTeamReturns`): it answers "who is here
 * now", which only equals "who came back from the update" while the update is
 * still the last thing that happened. Runs that predate `teams_reconciled_json`
 * have nothing else, so it stays.
 */
export function reconcileTeams(
  snapshot: readonly UpdateTeamSnapshot[],
  live: readonly OrchestratorView[],
): TeamReturn[] {
  return snapshot.map((team): TeamReturn => {
    const orch = live.find((o) => o.id === team.orchestratorId);
    const reason = teamReturnReason(orch);
    return {
      orchestratorId: team.orchestratorId,
      name: team.name,
      back: reason === 'ok',
      reason,
      status: orch?.status ?? null,
    };
  });
}

/** The server's own record (`teams_reconciled_json`), as the screen renders it. */
export function adoptReconciled(records: readonly ReconciledTeamRecord[]): TeamReturn[] {
  return records.map((r) => ({
    orchestratorId: r.orch_id,
    name: r.orch_name,
    back: r.back === true,
    reason: r.reason,
    status: r.status,
  }));
}

/**
 * Who came back — **the server's record wins whenever it exists**.
 *
 * `teams_reconciled_json` is written once, by the boot that followed the
 * update, from the state of the world at that instant. It is the only source
 * that is still true when this screen is opened later: `GET /orchestrators`
 * describes the present, and the present drifts (a team restarted by hand
 * since, a team stopped since) until it stops saying anything about the
 * update at all.
 *
 * The client-side diff remains for runs that predate the column — they carry no
 * record, and `null`/`[]` is exactly how that looks on the wire. The two are
 * never merged: one or the other, and the caller is told which.
 */
export function resolveTeamReturns(
  run: Pick<UpdateRunView, 'teamsSnapshot'> & {
    teamsReconciled?: readonly ReconciledTeamRecord[] | null;
  },
  live: readonly OrchestratorView[] | null,
): TeamReturnSet | null {
  const recorded = run.teamsReconciled;
  if (Array.isArray(recorded) && recorded.length > 0) {
    return { source: 'server', teams: adoptReconciled(recorded) };
  }
  if (!live) return null;
  return { source: 'client', teams: reconcileTeams(run.teamsSnapshot, live) };
}

/**
 * Did the server record who came back? Absent (a server older than the column),
 * `null` (a run created before the boot that reconciles) and `[]` (nothing was
 * ever written) all mean the same thing here: no record, use the fallback.
 */
export function hasServerReconciliation(run: {
  teamsReconciled?: readonly ReconciledTeamRecord[] | null;
}): boolean {
  return Array.isArray(run.teamsReconciled) && run.teamsReconciled.length > 0;
}

export function returnReasonLabel(reason: TeamReturnReason): string {
  switch (reason) {
    case 'absent':
      return 'the team was never brought back at all';
    case 'not_running':
      return 'the team came back stopped';
    case 'no_lead':
      return 'the team is there, but with no lead';
    case 'lead_dead':
      return 'the lead died on restart';
    default:
      return 'back';
  }
}

/**
 * What was done to this team's work, from the warning record. The `never_idle`
 * line is the one that matters: a lead that never read the notice was
 * interrupted wherever it happened to be, and saying anything softer — "may
 * have been interrupted" — would be a lie the operator finds out about later.
 *
 * A MISSING record and a `no_lead` record are not the same claim, and used to
 * share this sentence. `no_lead` is an observation: the server looked and there
 * was no live lead to warn. An absent record is the absence of an observation —
 * reachable whenever a run ends between the snapshot and the outcomes landing
 * (cancelled during the window, or a run older than the column) — and it must
 * say so rather than assert the reassuring half of the pair.
 *
 * A `pending` record is the third member of that family and needs its own
 * sentence for the same reason: the row exists, so the team WAS in the window,
 * but its outcome never landed — the server died mid-window, or the run was
 * concluded before the observation was written. Falling through to the default
 * would have told the operator the lead "had read the notice and had the window
 * to wrap up cleanly", which is the exact shape of claim this state exists to
 * refuse.
 */
export function casualtyNotice(name: string, record: WarnedTeamRecord | undefined): string {
  if (!record) {
    return `${name} — no record of what this team's lead was told: the run ended before the warning outcomes were written. Whether it was warned is not known.`;
  }
  if (record.state === 'no_lead') {
    return `${name} — no lead to warn at the time of the update.`;
  }
  if (record.state === 'pending') {
    return `${name} — the notice went out, but nothing was ever observed about this lead: the run ended before its outcome landed. Whether it read the notice is not known.`;
  }
  switch (record.state) {
    case 'never_idle':
      return `${name} — notice delivered but never read, the lead was busy for the whole window. Its work was interrupted at an arbitrary point.`;
    case 'queued_unread':
      return `${name} — notice delivered and displayed in the terminal, but never read. Its work was interrupted at an arbitrary point.`;
    default:
      return `${name} — the lead had read the notice and had the window to wrap up cleanly.`;
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type VerdictTone = 'ok' | 'warn' | 'bad' | 'mute';

export interface TerminalVerdict {
  tone: VerdictTone;
  title: string;
  body: string;
  /** Offer "retry": only where retrying is the correct next move. */
  retry: boolean;
}

/** Non-terminal states, for the in-flight header. */
export function phaseLabel(state: UpdateRunState): string {
  switch (state) {
    case 'scheduled':
      return 'scheduled';
    case 'warning_teams':
      return 'warning the teams';
    case 'preflight':
      return 'preflight on the host';
    case 'applying':
      return 'applying — the container is being recreated';
    case 'verifying':
      return 'verifying the new version';
    default:
      return state;
  }
}

/**
 * One distinct, honest sentence per terminal state. The two that matter most:
 *
 *  - `refused` is the REASSURING one — the host preflight said no before
 *    touching anything, so the deployment is exactly as it was. It must not
 *    look like a failure, or operators will stop trying.
 *  - `rolled_back` means the service is back on the previous version and is
 *    running. Something to look at, nothing to repair right now.
 */
export function terminalVerdict(run: UpdateRunView): TerminalVerdict {
  const version = run.targetVersion ? `v${run.targetVersion}` : 'the new version';
  const detail = (run.error ?? '').trim();
  switch (run.state) {
    case 'success':
      // A `success` carrying a message is the "healthy but never reported
      // boot_complete" case: the server persists the review note in `error`
      // precisely because rolling back a container that answers requests would
      // kill the teams a second time to fix nothing.
      return detail.length > 0
        ? {
            tone: 'warn',
            title: `APPLIED — NEEDS A CHECK (${version})`,
            body: `${detail} The new container answered /health but never announced boot_complete: no rollback was triggered, a service that answers is not something you restore. Check that the teams did come back.`,
            retry: false,
          }
        : {
            tone: 'ok',
            title: `APPLIED (${version})`,
            body: `swarm-os is now running ${version}, verified through /health up to boot_complete.`,
            retry: false,
          };
    case 'rolled_back':
      return {
        tone: 'warn',
        title: 'ROLLED BACK — PREVIOUS VERSION',
        body: `${version} did not pass verification, the original SWARM_OS_IMAGE line was put back and the container redeployed. The service is running on the previous version again: there is nothing to repair right now.${detail ? ` :: ${detail}` : ''}`,
        retry: false,
      };
    case 'failed':
      return {
        tone: 'bad',
        title: 'FAILED',
        body:
          detail.length > 0
            ? detail
            : 'The update failed without a message: the host updater wrote no verdict text. Nothing further will happen on its own.',
        retry: true,
      };
    case 'refused':
      return {
        tone: 'mute',
        title: 'REFUSED — NOTHING WAS TOUCHED',
        body: `The preflight said no before the slightest write: no .env modified, no container recreated, no team interrupted. The deployment is exactly in the state it was in before.${detail ? ` :: ${detail}` : ''}`,
        retry: false,
      };
    case 'abandoned':
      return {
        tone: 'warn',
        title: 'INTERRUPTED — VERDICT UNKNOWN',
        body:
          detail.length > 0
            ? detail
            : 'The updater stopped without a verdict (stale heartbeat, no result.json). Nothing more will happen on its own.',
        retry: true,
      };
    case 'cancelled':
      return {
        tone: 'mute',
        title: 'CANCELLED',
        body: `${detail.length > 0 ? `${detail} ` : ''}Nothing was touched.`,
        retry: false,
      };
    default:
      return { tone: 'mute', title: run.state.toUpperCase(), body: detail, retry: false };
  }
}
