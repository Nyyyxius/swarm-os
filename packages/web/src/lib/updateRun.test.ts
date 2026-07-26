// packages/web/src/lib/updateRun.test.ts
//
// The sentences an operator reads at the two moments that matter — the
// countdown before the container is recreated, and the screen afterwards —
// plus the team reconciliation behind the second one. These strings are the
// feature, so they are asserted word for word.

import { describe, it, expect } from 'vitest';
import type {
  OrchestratorView,
  ReconciledTeamRecord,
  SessionView,
  UpdateRunView,
  UpdateTeamSnapshot,
  WarnedTeamRecord,
} from '../api/client';
import {
  adoptReconciled,
  casualtyNotice,
  elapsedSince,
  formatBusy,
  formatCountdown,
  hasServerReconciliation,
  isTeamLive,
  noticeStateLabel,
  reconcileTeams,
  resolveTeamReturns,
  terminalVerdict,
  warningRows,
  warningSummary,
  type WarningRow,
} from './updateRun';

function warned(over: Partial<WarnedTeamRecord> & { orch_name: string }): WarnedTeamRecord {
  return {
    orch_id: over.orch_id ?? over.orch_name,
    lead_id: 'lead-1',
    signalled: true,
    read: true,
    state: 'read',
    ...over,
  };
}

function mkRun(over: Partial<UpdateRunView> = {}): UpdateRunView {
  return {
    id: 'run-1',
    kind: 'system',
    state: 'success',
    targetVersion: '0.6.0',
    scheduledFor: null,
    warnedAt: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    phase: null,
    envFile: null,
    teamsSnapshot: [],
    teamsWarned: [],
    graceRemainingSeconds: null,
    terminal: true,
    ...over,
  };
}

function mkSession(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'lead-1',
    orchestratorId: 'o1',
    name: 'lead',
    role: 'lead',
    type: 'lead',
    cwd: '/w',
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
    status: 'running',
    pid: 1,
    startedAt: '2026-07-20T10:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/l',
    lastActivityAt: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

function mkOrch(over: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'stiix-infra',
    role: 'infra',
    roleId: null,
    status: 'running',
    leadSessionId: 'lead-1',
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-07-20T10:00:00.000Z',
    endedAt: null,
    lastError: null,
    sessions: [mkSession()],
    msgCount: 0,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
    ...over,
  };
}

function mkReconciled(over: Partial<ReconciledTeamRecord> & { orch_id: string }): ReconciledTeamRecord {
  return {
    orch_name: over.orch_id,
    lead_id: 'lead-1',
    back: true,
    lead_id_now: 'lead-1',
    status: 'running',
    reason: 'ok',
    ...over,
  };
}

describe('formatting', () => {
  it('renders a countdown as MM:SS, rounding UP', () => {
    expect(formatCountdown(72)).toBe('01:12');
    // 71.98 s left is still 01:12 — flooring would start the display a second late.
    expect(formatCountdown(71.98)).toBe('01:12');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatCountdown(3672)).toBe('1:01:12');
  });

  it('renders a busy duration the way the plan writes it', () => {
    expect(formatBusy(271_000)).toBe('4m31');
    expect(formatBusy(31_000)).toBe('31s');
    expect(formatBusy(3_840_000)).toBe('1h04');
  });

  it('never invents an elapsed time from a missing or broken timestamp', () => {
    expect(elapsedSince(null, 1_000)).toBeNull();
    expect(elapsedSince('not-a-date', 1_000)).toBeNull();
    expect(elapsedSince('2026-07-20T10:00:00.000Z', Date.parse('2026-07-20T10:00:10.000Z'))).toBe(10_000);
  });
});

function snap(...names: string[]): UpdateTeamSnapshot[] {
  return names.map((name) => ({ orchestratorId: name, name, leadSessionId: `${name}-lead` }));
}

function row(name: string, state: WarningRow['state']): WarningRow {
  return { orchestratorId: name, name, state };
}

/**
 * The roster is `teams_snapshot_json`, taken BEFORE the notices go out.
 * `teams_warned_json` can lag it arbitrarily: an older server writes the column
 * only when the window settles, so for the whole window it is `[]` while N
 * teams are about to be cut off. The roster decides who is on screen; the
 * records only refine what is said about each one.
 */
describe('warningRows — the snapshot is the roster, not the records', () => {
  it('lists every team of the snapshot as pending while nothing has been observed', () => {
    expect(warningRows(snap('a', 'b'), [])).toEqual([
      { orchestratorId: 'a', name: 'a', state: 'pending' },
      { orchestratorId: 'b', name: 'b', state: 'pending' },
    ]);
  });

  it('adopts the record of each team that has one, and keeps the others pending', () => {
    const rows = warningRows(snap('a', 'b'), [
      warned({ orch_id: 'a', orch_name: 'a', state: 'never_idle', read: false }),
    ]);
    expect(rows).toEqual([
      { orchestratorId: 'a', name: 'a', state: 'never_idle' },
      { orchestratorId: 'b', name: 'b', state: 'pending' },
    ]);
  });

  it('reads a state this build does not know as pending, never as read', () => {
    // A newer server persisting placeholder rows the instant the window opens
    // must not be able to turn "not observed" into "fine".
    const rows = warningRows(snap('a'), [
      warned({ orch_id: 'a', orch_name: 'a', state: 'armed' as WarnedTeamRecord['state'] }),
    ]);
    expect(rows[0]!.state).toBe('pending');
  });

  /**
   * The server's own placeholder, taken at its word rather than through the
   * unknown-value fallback. Both land on `pending`, but only one of them is a
   * contract: an unknown value is a guess about a server we do not understand,
   * while `pending` is that server saying "I have observed nothing".
   */
  it('adopts the server’s own `pending` placeholder as an explicit state', () => {
    const rows = warningRows(snap('a'), [
      warned({ orch_id: 'a', orch_name: 'a', state: 'pending', signalled: false, read: false }),
    ]);
    expect(rows[0]!.state).toBe('pending');
    expect(noticeStateLabel(rows[0]!.state)).toBe('no answer yet');
  });

  it('keeps a record whose team is not in the snapshot rather than dropping it', () => {
    const rows = warningRows([], [warned({ orch_id: 'z', orch_name: 'zeta' })]);
    expect(rows).toEqual([{ orchestratorId: 'z', name: 'zeta', state: 'read' }]);
  });
});

describe('warningSummary — the countdown sentence', () => {
  it('says everyone read it, verbatim', () => {
    const rows = [row('a', 'read'), row('b', 'read'), row('c', 'read')];
    expect(warningSummary(rows, 72, null)).toBe(
      '3 teams warned — all leads have read it. Applying in 01:12.',
    );
  });

  it('names the lead that did not, and how long it has been busy, verbatim', () => {
    const rows = [row('a', 'read'), row('b', 'read'), row('stiix-infra', 'never_idle')];
    // "Applying anyway" is the load-bearing half: the deadline is not a
    // negotiation, and the sentence says so before it happens.
    expect(warningSummary(rows, 72, 271_000)).toBe(
      '3 teams warned — 1 lead (stiix-infra) has not read it yet (busy for 4m31). Applying anyway in 01:12.',
    );
  });

  it('pluralises the unread leads and drops the parenthetical', () => {
    const rows = [row('a', 'never_idle'), row('b', 'queued_unread')];
    expect(warningSummary(rows, 60, 10_000)).toBe(
      '2 teams warned — 2 leads (a, b) have not read it yet. Applying anyway in 01:00.',
    );
  });

  it('distinguishes a delivered-but-unread notice from a lead that was never available', () => {
    expect(warningSummary([row('a', 'queued_unread')], 60, 10_000)).toContain(
      'notice displayed in its terminal, not consumed yet',
    );
  });

  it('does not count a team without a lead as an unread lead', () => {
    const rows = [row('a', 'read'), row('b', 'no_lead')];
    expect(warningSummary(rows, 72, null)).toBe(
      '2 teams warned — all leads have read it (1 team with no lead). Applying in 01:12.',
    );
  });

  /**
   * THE regression. When the server wrote `teams_warned_json` only at the end
   * of the window, the wire carried `[]` throughout — and the screen answered
   * "nothing to interrupt" while three leads were minutes from being killed.
   * The current server fills the column immediately, but this must keep holding
   * for the empty wire: the roster decides, the records only refine it.
   */
  it('never says "nothing to interrupt" while the roster is not empty', () => {
    const pending = warningRows(snap('a', 'b', 'c'), []);
    const line = warningSummary(pending, 72, null);
    expect(line).toBe('3 teams warned — 3 leads have not answered yet. Applying in 01:12.');
    expect(line).not.toContain('nothing to interrupt');
    expect(line).not.toContain('all leads have read it');
  });

  it('says how many leads are still silent when only some records have landed', () => {
    const rows = warningRows(snap('a', 'b', 'c'), [warned({ orch_id: 'a', orch_name: 'a' })]);
    expect(warningSummary(rows, 72, null)).toBe(
      '3 teams warned — 2 leads have not answered yet. Applying in 01:12.',
    );
  });

  it('an unread lead outranks a silent one — "anyway" is the sentence that matters', () => {
    const rows = warningRows(snap('a', 'b'), [
      warned({ orch_id: 'a', orch_name: 'a', state: 'never_idle', read: false }),
    ]);
    expect(warningSummary(rows, 72, 271_000)).toBe(
      '2 teams warned — 1 lead (a) has not read it yet (busy for 4m31). Applying anyway in 01:12.',
    );
  });

  it('says there is nothing to interrupt only when no team was alive', () => {
    expect(warningSummary([], 0, null)).toBe(
      'No team is active — nothing to interrupt. Applying in 00:00.',
    );
    expect(warningSummary(warningRows([], []), 0, null)).toContain('No team is active');
  });
});

/**
 * The wire the server ACTUALLY emits during a window, rather than rows composed
 * by hand here. Both payloads below are copied verbatim from what
 * `runner.currentRun()` — the `run` field of `GET /updates` — carries at those
 * two instants, asserted in
 * `packages/server/src/modules/updates/teams-port.test.ts`
 * ("carries a MIXED set mid-window: two leads read, one not yet observed"),
 * which drives the real `UpdateRunner` over the real `SpawnerTeamsPort`.
 *
 * It exists because the verdict sentence was, for a while, unreachable on a
 * live server: `teams_warned_json` was written once, when every lead had
 * settled, and a lead only settles as unread at the deadline. Rendering it from
 * hand-written rows proved the function, never the feature. If either side of
 * the wire drifts, one of the two tests fails.
 *
 * The two instants say deliberately different things, and the difference is the
 * point: mid-window the third lead has not been OBSERVED, so the wire says
 * `pending` and the sentence claims nothing about it; at the deadline the
 * observation exists and the verdict sentence renders, word for word.
 */
describe('the warning window, from the payload the server really sends', () => {
  const WARNED_AT = '2026-07-20T10:00:00.000Z';
  const SNAPSHOT: UpdateTeamSnapshot[] = [
    { orchestratorId: 'orch-1', name: 'alpha', leadSessionId: 'lead-1' },
    { orchestratorId: 'orch-2', name: 'beta', leadSessionId: 'lead-2' },
    { orchestratorId: 'orch-3', name: 'stiix-infra', leadSessionId: 'lead-3' },
  ];
  /** 271 s in, 72 s left: two reads landed, the third lead unobserved. */
  const WARNED_MID_WINDOW: WarnedTeamRecord[] = [
    { orch_id: 'orch-1', orch_name: 'alpha', lead_id: 'lead-1', signalled: true, read: true, state: 'read' },
    { orch_id: 'orch-2', orch_name: 'beta', lead_id: 'lead-2', signalled: true, read: true, state: 'read' },
    { orch_id: 'orch-3', orch_name: 'stiix-infra', lead_id: 'lead-3', signalled: false, read: false, state: 'pending' },
  ];
  /** The same run at its deadline — still `warning_teams`, verdict written. */
  const WARNED_AT_DEADLINE: WarnedTeamRecord[] = [
    { orch_id: 'orch-1', orch_name: 'alpha', lead_id: 'lead-1', signalled: true, read: true, state: 'read' },
    { orch_id: 'orch-2', orch_name: 'beta', lead_id: 'lead-2', signalled: true, read: true, state: 'read' },
    { orch_id: 'orch-3', orch_name: 'stiix-infra', lead_id: 'lead-3', signalled: false, read: false, state: 'never_idle' },
  ];
  const GRACE_REMAINING_SECONDS = 72;

  /**
   * THE REGRESSION this state exists for. The placeholder used to say
   * `never_idle`, so this exact payload rendered "1 lead (stiix-infra) has not
   * read it yet (busy for 4m31). Applying anyway in 01:12." — a verdict about a
   * lead nothing had been observed about, minted the instant the window opened.
   */
  it('claims nothing about a lead the server has not observed yet', () => {
    const rows = warningRows(SNAPSHOT, WARNED_MID_WINDOW);
    // Mixed: the server can and does say different things about different
    // leads while the window is still open.
    expect(rows.map((r) => r.state)).toEqual(['read', 'read', 'pending']);
    const line = warningSummary(
      rows,
      GRACE_REMAINING_SECONDS,
      elapsedSince(WARNED_AT, Date.parse('2026-07-20T10:04:31.000Z')),
    );
    expect(line).toBe('3 teams warned — 1 lead has not answered yet. Applying in 01:12.');
    // The countdown is still explicit that it will apply — it just does not
    // pretend to know why this lead is silent.
    expect(line).not.toContain('busy for');
    expect(line).not.toContain('has not read it yet');
    expect(line).not.toContain('nothing to interrupt');
    expect(line).not.toContain('all leads have read it');
    // And the team is on screen as unanswered, not as a casualty.
    expect(noticeStateLabel(rows[2]!.state)).toBe('no answer yet');
  });

  it('renders the verdict sentence the plan specifies, word for word, once it is one', () => {
    const rows = warningRows(SNAPSHOT, WARNED_AT_DEADLINE);
    expect(rows.map((r) => r.state)).toEqual(['read', 'read', 'never_idle']);
    // 271 s after the notices were armed — the parenthetical is a lower bound
    // on how long that lead has been busy, and `never_idle` is now observed.
    const busyMs = elapsedSince(WARNED_AT, Date.parse('2026-07-20T10:04:31.000Z'));
    expect(busyMs).toBe(271_000);
    expect(warningSummary(rows, GRACE_REMAINING_SECONDS, busyMs)).toBe(
      '3 teams warned — 1 lead (stiix-infra) has not read it yet (busy for 4m31). Applying anyway in 01:12.',
    );
  });

  it('says the same thing about the same run through the run view', () => {
    const run = mkRun({
      state: 'warning_teams',
      terminal: false,
      warnedAt: WARNED_AT,
      teamsSnapshot: SNAPSHOT,
      teamsWarned: WARNED_AT_DEADLINE,
      graceRemainingSeconds: GRACE_REMAINING_SECONDS,
    });
    const line = warningSummary(
      warningRows(run.teamsSnapshot, run.teamsWarned),
      run.graceRemainingSeconds ?? 0,
      elapsedSince(run.warnedAt, Date.parse('2026-07-20T10:04:31.000Z')),
    );
    expect(line).toContain('Applying anyway');
    expect(line).not.toContain('nothing to interrupt');
    expect(line).not.toContain('all leads have read it');
    expect(line).not.toContain('have not answered yet');
  });
});

describe('reconcileTeams — who came back', () => {
  const snapshot = [{ orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 'lead-1' }];

  it('counts a live team with a live lead as back', () => {
    expect(reconcileTeams(snapshot, [mkOrch()])[0]).toMatchObject({ back: true, reason: 'ok' });
  });

  it('flags a team that is not in the live list at all', () => {
    expect(reconcileTeams(snapshot, [])[0]).toMatchObject({ back: false, reason: 'absent', status: null });
  });

  it('flags a team that came back stopped', () => {
    expect(reconcileTeams(snapshot, [mkOrch({ status: 'failed' })])[0]).toMatchObject({
      back: false,
      reason: 'not_running',
    });
  });

  it('flags a team whose lead died on spawn — the resumed-lead-dies case', () => {
    const orch = mkOrch({ sessions: [mkSession({ status: 'failed' })] });
    expect(reconcileTeams(snapshot, [orch])[0]).toMatchObject({ back: false, reason: 'lead_dead' });
  });

  it('flags a team that came back without a lead', () => {
    const orch = mkOrch({ leadSessionId: null, sessions: [] });
    expect(reconcileTeams(snapshot, [orch])[0]).toMatchObject({ back: false, reason: 'no_lead' });
  });

  it('accepts a lead that was reborn with a new id (fresh restart in place)', () => {
    const orch = mkOrch({ leadSessionId: 'lead-2', sessions: [mkSession({ id: 'lead-2' })] });
    expect(reconcileTeams(snapshot, [orch])[0]?.back).toBe(true);
  });
});

/**
 * The guard a destructive action asks before it fires: RESTART TEAMS is a
 * fresh start in place, and a team that is running again must not be killed on
 * the strength of a record written hours ago.
 */
describe('isTeamLive — the present, not the record', () => {
  it('is true only for a live team with a live lead', () => {
    expect(isTeamLive(mkOrch())).toBe(true);
    expect(isTeamLive(mkOrch({ status: 'stopped' }))).toBe(false);
    expect(isTeamLive(mkOrch({ sessions: [mkSession({ status: 'failed' })] }))).toBe(false);
    expect(isTeamLive(mkOrch({ leadSessionId: null, sessions: [] }))).toBe(false);
  });

  it('treats a team that is not in the live list at all as not live', () => {
    expect(isTeamLive(undefined)).toBe(false);
    expect(isTeamLive(null)).toBe(false);
  });

  it('accepts a lead that is still starting — it is coming up, not gone', () => {
    expect(isTeamLive(mkOrch({ sessions: [mkSession({ status: 'starting' })] }))).toBe(true);
  });
});

describe('resolveTeamReturns — the server record wins', () => {
  const snapshot = [{ orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 'lead-1' }];

  it('maps the server record onto the shape the screen renders', () => {
    expect(
      adoptReconciled([
        mkReconciled({ orch_id: 'o1', orch_name: 'stiix-infra', back: false, reason: 'lead_dead', status: 'running', lead_id_now: 'lead-2' }),
      ]),
    ).toEqual([
      { orchestratorId: 'o1', name: 'stiix-infra', back: false, reason: 'lead_dead', status: 'running' },
    ]);
  });

  it('prefers the record even when the live list now disagrees', () => {
    // The team is alive and healthy NOW — restarted by hand since the update.
    // What the update did to it is still what the server wrote down then.
    const run = {
      teamsSnapshot: snapshot,
      teamsReconciled: [mkReconciled({ orch_id: 'o1', orch_name: 'stiix-infra', back: false, reason: 'absent', status: null })],
    };
    const resolved = resolveTeamReturns(run, [mkOrch()]);
    expect(resolved).toEqual({
      source: 'server',
      teams: [{ orchestratorId: 'o1', name: 'stiix-infra', back: false, reason: 'absent', status: null }],
    });
  });

  it('falls back to the client-side diff for a run that predates the column', () => {
    for (const teamsReconciled of [undefined, null, []] as const) {
      const resolved = resolveTeamReturns({ teamsSnapshot: snapshot, teamsReconciled }, []);
      expect(resolved).toEqual({
        source: 'client',
        teams: [{ orchestratorId: 'o1', name: 'stiix-infra', back: false, reason: 'absent', status: null }],
      });
      expect(hasServerReconciliation({ teamsReconciled })).toBe(false);
    }
  });

  it('says nothing at all rather than guessing when neither source is available', () => {
    expect(resolveTeamReturns({ teamsSnapshot: snapshot, teamsReconciled: [] }, null)).toBeNull();
  });

  it('recognises a record that exists', () => {
    expect(hasServerReconciliation({ teamsReconciled: [mkReconciled({ orch_id: 'o1' })] })).toBe(true);
  });
});

describe('casualtyNotice', () => {
  it('says plainly that a lead busy the whole window was cut off mid-thought', () => {
    expect(
      casualtyNotice('stiix-infra', warned({ orch_name: 'stiix-infra', state: 'never_idle', read: false, signalled: false })),
    ).toBe(
      'stiix-infra — notice delivered but never read, the lead was busy for the whole window. Its work was interrupted at an arbitrary point.',
    );
  });

  it('still says "interrupted at an arbitrary point" for a delivered-but-unread notice', () => {
    const line = casualtyNotice('a', warned({ orch_name: 'a', state: 'queued_unread', read: false }));
    expect(line).toContain('never read');
    expect(line).toContain('interrupted at an arbitrary point');
    // Never hedged into "may have been interrupted" — it was.
    expect(line).not.toMatch(/may have been/i);
  });

  it('does not accuse a lead that had read the notice', () => {
    const line = casualtyNotice('a', warned({ orch_name: 'a' }));
    expect(line).toContain('had read the notice');
    expect(line).not.toContain('arbitrary point');
  });

  it('says plainly when there was no lead to warn', () => {
    expect(casualtyNotice('a', warned({ orch_name: 'a', state: 'no_lead', read: false, signalled: false }))).toContain(
      'no lead to warn',
    );
  });

  /**
   * A missing record is an ABSENCE OF DATA, and it used to render as the
   * `no_lead` observation — "no lead to warn at the time of the update" — which
   * is a fact nobody established. Reachable on a run cancelled after the
   * snapshot but before the outcomes land.
   */
  it('does not turn a missing record into "there was no lead"', () => {
    const line = casualtyNotice('a', undefined);
    expect(line).toContain('not known');
    expect(line).not.toContain('no lead to warn');
    expect(line).not.toContain('had read the notice');
  });

  /**
   * A `pending` record persisted to a terminal run — the process died inside
   * the window, or the run was concluded before the outcome landed — is the
   * same absence of data as a missing record, and must not fall through to the
   * reassuring default ("had read the notice and had the window to wrap up
   * cleanly"), which is what an unrecognised state would have done here.
   */
  it('does not turn an unobserved placeholder into "the lead had read the notice"', () => {
    const line = casualtyNotice(
      'a',
      warned({ orch_name: 'a', state: 'pending', read: false, signalled: false }),
    );
    expect(line).toContain('nothing was ever observed about this lead');
    expect(line).toContain('not known');
    expect(line).not.toContain('had read the notice');
    expect(line).not.toContain('no lead to warn');
    expect(line).not.toContain('busy for the whole window');
  });
});

describe('terminalVerdict — one honest sentence per outcome', () => {
  it('success is calm and final', () => {
    const v = terminalVerdict(mkRun({ state: 'success' }));
    expect(v.tone).toBe('ok');
    expect(v.title).toContain('APPLIED');
    expect(v.retry).toBe(false);
  });

  it('success carrying a review note is flagged, not celebrated', () => {
    const v = terminalVerdict(
      mkRun({ state: 'success', error: 'Updated. [manual review: served /health but never reported boot_complete]' }),
    );
    expect(v.tone).toBe('warn');
    expect(v.title).toContain('NEEDS A CHECK');
    expect(v.body).toContain('boot_complete');
    expect(v.body).toContain('no rollback was triggered');
  });

  it('rolled_back says the service is back on the previous version', () => {
    const v = terminalVerdict(mkRun({ state: 'rolled_back' }));
    expect(v.body).toContain('previous version');
    expect(v.body).toContain('nothing to repair');
    expect(v.retry).toBe(false);
  });

  it('refused makes "nothing was touched" the headline', () => {
    const v = terminalVerdict(mkRun({ state: 'refused', error: 'no .env found' }));
    expect(v.title).toContain('NOTHING WAS TOUCHED');
    expect(v.tone).not.toBe('bad');
    expect(v.body).toContain('no team interrupted');
    expect(v.body).toContain('no .env found');
  });

  it('failed is the only alarming one', () => {
    expect(terminalVerdict(mkRun({ state: 'failed', error: 'boom' })).tone).toBe('bad');
  });

  it('abandoned offers a retry', () => {
    const v = terminalVerdict(mkRun({ state: 'abandoned' }));
    expect(v.retry).toBe(true);
    expect(v.title).toContain('INTERRUPTED');
  });

  it('cancelled reassures too', () => {
    expect(terminalVerdict(mkRun({ state: 'cancelled' })).body).toContain('Nothing was touched');
  });

  it('gives every terminal state a distinct title', () => {
    const states = ['success', 'rolled_back', 'failed', 'refused', 'abandoned', 'cancelled'] as const;
    const titles = states.map((state) => terminalVerdict(mkRun({ state })).title);
    expect(new Set(titles).size).toBe(states.length);
  });
});
