// packages/web/src/components/desktop/UpdateSection.test.tsx
//
// Contract of the SETTINGS ▸ SYSTEM UPDATE section:
//  - fetches `GET /updates` ONCE on mount (the drawer opening is the trigger;
//    there is no poll and no hook).
//  - up-to-date vs available render distinct verdicts.
//  - release notes are shown verbatim (no markdown rendering) next to a link
//    to the release page.
//  - HIDE THIS VERSION posts the dismissal and reflects the returned state.
//  - every `canSelfUpdate` reason gets its own headline, the server's
//    deployment-specific sentence, and the command that works today.
//  - 401 (the drawer auto-opens on a missing token) reads as "authenticate",
//    not as an error.
//  - apply / schedule drive the run engine, and a 503 reads as "this build has
//    no apply machine", never as a generic failure.
//  - the warning window shows per-team read state and a countdown, and never
//    offers a control the server would refuse: APPLY NOW is live only past the
//    hard 120 s floor, and a refusal comes back as a real message.
//  - the post-update screen prefers the server's own reconciliation record and
//    only diffs against the live team list for runs that predate it.
//  - `applying`/`verifying` take over the screen and are driven by public
//    `/health` + `boot_complete`, because every authed call fails there.
//  - the post-update screen names the teams that did not come back and is
//    honest about what happened to a lead that never read the notice.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UpdateSection } from './UpdateSection';
import {
  api,
  HttpError,
  type HealthView,
  type OrchestratorView,
  type ReconciledTeamRecord,
  type SessionView,
  type SystemUpdateState,
  type UpdateRunDetail,
  type UpdateRunView,
  type UpdatesView,
  type WarnedTeamRecord,
} from '../../api/client';

function mkSystem(over: Partial<SystemUpdateState> = {}): SystemUpdateState {
  return {
    current: '0.5.0',
    available: false,
    latest: '0.5.0',
    tag: 'v0.5.0',
    notesUrl: null,
    notesBody: null,
    publishedAt: null,
    dismissedVersion: null,
    checkStatus: 'ok',
    checkedAt: '2026-07-20T10:00:00.000Z',
    error: null,
    ...over,
  };
}

function mkState(over: Partial<UpdatesView> = {}): UpdatesView {
  return {
    system: mkSystem(),
    plugins: [],
    pluginsCheckedAt: null,
    canSelfUpdate: {
      status: 'transport_not_ssh',
      detail: 'This instance runs agents in-container (SWARM_OS_AGENT_TRANSPORT=local).',
    },
    ...over,
  };
}

const AVAILABLE = mkSystem({
  available: true,
  latest: '0.6.0',
  tag: 'v0.6.0',
  notesUrl: 'https://github.com/Nyyyxius/swarm-os/releases/tag/v0.6.0',
  notesBody: '## What changed\n* one-click updates',
  publishedAt: '2026-07-14T09:12:00.000Z',
});

function mkRun(over: Partial<UpdateRunView> = {}): UpdateRunView {
  return {
    id: 'run-1',
    kind: 'system',
    state: 'warning_teams',
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
    terminal: false,
    ...over,
  };
}

function mkDetail(over: Partial<UpdateRunDetail> = {}): UpdateRunDetail {
  return {
    ...mkRun(over),
    runDir: '/data/updater/runs/run-1',
    envLineBefore: null,
    logTail: '',
    result: null,
    ...over,
  };
}

function mkWarned(over: Partial<WarnedTeamRecord> & { orch_name: string }): WarnedTeamRecord {
  return {
    orch_id: over.orch_id ?? over.orch_name,
    lead_id: 'lead-1',
    signalled: true,
    read: true,
    state: 'read',
    ...over,
  };
}

function mkReconciled(
  over: Partial<ReconciledTeamRecord> & { orch_id: string },
): ReconciledTeamRecord {
  return {
    orch_name: over.orch_id,
    lead_id: `${over.orch_id}-lead`,
    back: true,
    lead_id_now: `${over.orch_id}-lead`,
    status: 'running',
    reason: 'ok',
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
  const id = over.id ?? 'o1';
  return {
    id,
    name: 'team',
    role: 'infra',
    roleId: null,
    status: 'running',
    leadSessionId: `${id}-lead`,
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-07-20T10:00:00.000Z',
    endedAt: null,
    lastError: null,
    sessions: [mkSession({ id: `${id}-lead`, orchestratorId: id })],
    msgCount: 0,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
    ...over,
  };
}

const HEALTH: HealthView = {
  status: 'ok',
  project_name: 'swarm-os',
  orchestrators_active: 0,
  sessions_active: 0,
  sessions_waiting: 0,
  uptime_seconds: 3,
  boot_complete: true,
};

/** A deployment where apply is actually offered: newer release + apply engine. */
function appliable(over: Partial<UpdatesView> = {}): UpdatesView {
  return mkState({
    system: AVAILABLE,
    canSelfUpdate: { status: 'unknown', detail: 'Transport and image qualify.' },
    run: null,
    recentRuns: [],
    updater: { version: '1', sha256: 'abcdef' },
    ...over,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('UpdateSection — verdict', () => {
  it('fetches GET /updates once on mount and reports "up to date"', async () => {
    const spy = vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState());

    render(<UpdateSection />);

    expect(await screen.findByText(/running v0\.5\.0 · up to date/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('announces the newer version alongside the running one', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState({ system: AVAILABLE }));

    render(<UpdateSection />);

    expect(await screen.findByText('v0.6.0 available')).toBeInTheDocument();
    expect(screen.getByText(/running v0\.5\.0/)).toBeInTheDocument();
  });

  it('renders the notes verbatim in a <pre> and links the release page', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState({ system: AVAILABLE }));
    const { container } = render(<UpdateSection />);

    const pre = await waitFor(() => {
      const el = container.querySelector('pre');
      expect(el).toBeTruthy();
      return el!;
    });
    // Verbatim: the `##` and `*` markers survive — nothing renders markdown.
    expect(pre.textContent).toBe('## What changed\n* one-click updates');

    const link = screen.getByRole('link', { name: /release page/i });
    expect(link).toHaveAttribute('href', AVAILABLE.notesUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('explains a check that produced no verdict (no_token)', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      mkState({ system: mkSystem({ checkStatus: 'no_token', latest: null }) }),
    );

    const { container } = render(<UpdateSection />);

    expect(await screen.findByText(/SWARM_OS_GITHUB_TOKEN/)).toBeInTheDocument();
    // `available === false` is also what "the check never produced an answer"
    // looks like. Green there would be the UI inventing an all-clear.
    expect(container.querySelector('.dot')?.className).not.toMatch(/\bok\b/);
  });

  it('keeps the green dot for a check that actually succeeded', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState());

    const { container } = render(<UpdateSection />);

    await screen.findByText(/up to date/);
    expect(container.querySelector('.dot')?.className).toMatch(/\bok\b/);
  });

  it('reads a 503 as the boot gate, and offers to ask again', async () => {
    // Every business route answers 503 while auto-resume replays the teams —
    // which is exactly when this drawer is opened after an update.
    const get = vi
      .spyOn(api, 'getUpdates')
      .mockRejectedValueOnce(new HttpError('HTTP 503 GET /updates', 503, null))
      .mockResolvedValue(mkState());

    render(<UpdateSection />);

    expect(await screen.findByText(/still finishing its boot/)).toBeInTheDocument();
    expect(screen.queryByText(/^⚠/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'CHECK AGAIN' }));

    expect(await screen.findByText(/running v0\.5\.0 · up to date/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('counts available plugin updates and points at the PLUGINS page', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      mkState({
        plugins: [
          { name: 'a', status: 'available', latestVersion: '2.0.0', latestCommit: null, reason: null, checkedAt: 'x' },
          { name: 'b', status: 'up_to_date', latestVersion: null, latestCommit: null, reason: null, checkedAt: 'x' },
          { name: 'c', status: 'available', latestVersion: null, latestCommit: 'abc', reason: null, checkedAt: 'x' },
        ],
      }),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/2 plugin updates available/)).toBeInTheDocument();
  });
});

describe('UpdateSection — dismissal', () => {
  it('HIDE THIS VERSION posts the version and reflects the new state', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState({ system: AVAILABLE }));
    const dismiss = vi.spyOn(api, 'dismissUpdate').mockResolvedValue({
      system: mkSystem({ available: false, latest: '0.6.0', dismissedVersion: '0.6.0' }),
    });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: /HIDE THIS VERSION/ }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('0.6.0'));
    expect(await screen.findByText(/v0\.6\.0 is hidden/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /HIDE THIS VERSION/ })).not.toBeInTheDocument();
  });

  it('SHOW AGAIN un-dismisses (null)', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      mkState({ system: mkSystem({ dismissedVersion: '0.6.0' }) }),
    );
    const dismiss = vi.spyOn(api, 'dismissUpdate').mockResolvedValue({ system: AVAILABLE });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'SHOW AGAIN' }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(null));
    expect(await screen.findByText('v0.6.0 available')).toBeInTheDocument();
  });
});

describe('UpdateSection — self-update eligibility', () => {
  it('names the reason, quotes the server detail, and gives the manual command', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(mkState());

    render(<UpdateSection />);

    expect(
      await screen.findByText(/ONE-CLICK UPDATE :: TRANSPORT IS NOT SSH/),
    ).toBeInTheDocument();
    expect(screen.getByText(/SWARM_OS_AGENT_TRANSPORT=local/)).toBeInTheDocument();
    expect(screen.getByText('./install.sh')).toBeInTheDocument();
  });

  it('falls back to its own copy when the server sends no detail', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      mkState({ canSelfUpdate: { status: 'image_not_interpolated', detail: '   ' } }),
    );

    render(<UpdateSection />);

    expect(
      await screen.findByText(/ONE-CLICK UPDATE :: IMAGE TAG IS HARDCODED/),
    ).toBeInTheDocument();
    expect(screen.getByText(/image: \$\{SWARM_OS_IMAGE\}/)).toBeInTheDocument();
  });

  it('has copy for every reason the server can return', async () => {
    const reasons = [
      'ok', 'unknown', 'transport_not_ssh', 'image_not_registry',
      'image_not_interpolated', 'env_file_not_found', 'env_file_not_writable',
      'registry_auth_missing',
    ] as const;
    for (const status of reasons) {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(
        mkState({ canSelfUpdate: { status, detail: '' } }),
      );
      const { unmount } = render(<UpdateSection />);
      // A missing entry would render `ONE-CLICK UPDATE :: undefined`.
      const label = await screen.findByText(/^ONE-CLICK UPDATE :: /);
      expect(label.textContent).not.toMatch(/undefined/);
      expect(label.textContent!.replace('ONE-CLICK UPDATE :: ', '').length)
        .toBeGreaterThan(0);
      unmount();
    }
  });
});

describe('UpdateSection — auth', () => {
  it('asks for a token instead of surfacing a 401 as an error', async () => {
    vi.spyOn(api, 'getUpdates').mockRejectedValue(
      new HttpError('HTTP 401 GET /updates', 401, null),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/set a valid token above/i)).toBeInTheDocument();
    expect(screen.queryByText(/^⚠/)).not.toBeInTheDocument();
  });

  it('says so plainly when the server predates GET /updates (404)', async () => {
    vi.spyOn(api, 'getUpdates').mockRejectedValue(
      new HttpError('HTTP 404 GET /updates', 404, null),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/does not expose/i)).toBeInTheDocument();
    expect(screen.queryByText(/^⚠/)).not.toBeInTheDocument();
  });

  it('never renders off a payload that is not an UpdatesView', async () => {
    // A proxy (or an SPA fallback) answering 200 with HTML must not take the
    // drawer down: `state.plugins.filter` on a string would throw in render.
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      '<!doctype html>' as unknown as UpdatesView,
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/does not expose/i)).toBeInTheDocument();
  });

  it('surfaces any other failure as a warn', async () => {
    vi.spyOn(api, 'getUpdates').mockRejectedValue(
      new HttpError('HTTP 500 GET /updates', 500, null),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/⚠ HTTP 500/)).toBeInTheDocument();
  });
});

describe('UpdateSection — apply & schedule', () => {
  it('APPLY NOW posts the target version and the grace window', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable());
    const apply = vi
      .spyOn(api, 'applyUpdate')
      .mockResolvedValue({ runId: 'run-1', run: mkDetail({ state: 'warning_teams' }) });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'APPLY NOW' }));

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ targetVersion: '0.6.0', graceSeconds: 300 }),
    );
    // The returned run is adopted straight away — no extra round trip.
    expect(await screen.findByText(/WARNING THE TEAMS/)).toBeInTheDocument();
  });

  it('floors the window at 120 s rather than sending a value the server clamps', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable());
    const apply = vi
      .spyOn(api, 'applyUpdate')
      .mockResolvedValue({ runId: 'run-1', run: mkDetail() });

    render(<UpdateSection />);
    fireEvent.change(await screen.findByLabelText(/warning window \(seconds\)/), {
      target: { value: '30' },
    });
    expect(screen.getByText(/120 s will be sent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'APPLY NOW' }));

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ targetVersion: '0.6.0', graceSeconds: 120 }),
    );
  });

  it('SCHEDULE posts a one-shot ISO datetime', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable());
    const schedule = vi.spyOn(api, 'scheduleUpdate').mockResolvedValue({
      runId: 'run-2',
      at: '2026-07-30T01:00:00.000Z',
      run: mkDetail({ id: 'run-2', state: 'scheduled' }),
    });

    render(<UpdateSection />);
    fireEvent.change(await screen.findByLabelText(/update date and time/), {
      target: { value: '2026-07-30T03:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'SCHEDULE' }));

    await waitFor(() =>
      expect(schedule).toHaveBeenCalledWith({
        at: new Date('2026-07-30T03:00').toISOString(),
        targetVersion: '0.6.0',
        graceSeconds: 300,
      }),
    );
    expect(await screen.findByText(/SCHEDULED UPDATE/)).toBeInTheDocument();
  });

  it('reads a 503 as "this build has no apply engine", not as a failure', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable());
    vi.spyOn(api, 'applyUpdate').mockRejectedValue(
      new HttpError('HTTP 503 POST /updates/apply', 503, {
        error:
          'This instance has update detection but no apply machine attached, so it cannot install anything itself. Update from the host shell.',
      }),
    );

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'APPLY NOW' }));

    expect(await screen.findByText(/NO ENGINE IN THIS BUILD/)).toBeInTheDocument();
    expect(screen.getByText(/no apply machine attached/)).toBeInTheDocument();
    // Not an error banner, and the control that would 503 again is withdrawn.
    expect(screen.queryByText(/^⚠/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'APPLY NOW' })).not.toBeInTheDocument();
  });

  it('does not offer apply on a deployment the host would refuse', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({ canSelfUpdate: { status: 'transport_not_ssh', detail: 'local transport' } }),
    );

    render(<UpdateSection />);

    await screen.findByText('v0.6.0 available');
    expect(screen.queryByRole('button', { name: 'APPLY NOW' })).not.toBeInTheDocument();
    expect(screen.getByText('./install.sh')).toBeInTheDocument();
  });

  /**
   * `updater` is the apply engine's own descriptor and the server sends `null`
   * for it — explicitly — when no runner is attached, which is the same state
   * that makes every write route answer 503. `run`/`recentRuns` are NOT that
   * signal: `getFullState()` always emits them (`null` and `[]` when there is
   * no runner), so a payload missing them is one the server cannot produce.
   */
  it('says so up front when the server has no apply engine (updater: null)', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ updater: null }));

    render(<UpdateSection />);

    await screen.findByText('v0.6.0 available');
    // No button to click to find out — the panel is there on arrival.
    expect(screen.getByText(/NO ENGINE IN THIS BUILD/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'APPLY NOW' })).not.toBeInTheDocument();
    // The command that does work today, in the no-engine panel and beside the
    // eligibility reason.
    expect(screen.getAllByText('./install.sh').length).toBeGreaterThan(0);
  });

  it('still offers apply to a server too old to send `updater` at all', async () => {
    // `undefined` is not `null`: it means "this server never said". We offer,
    // and its 503 — covered above — is the answer.
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      mkState({ system: AVAILABLE, canSelfUpdate: { status: 'unknown', detail: 'ok' } }),
    );

    render(<UpdateSection />);

    expect(await screen.findByRole('button', { name: 'APPLY NOW' })).toBeInTheDocument();
    expect(screen.queryByText(/NO ENGINE IN THIS BUILD/)).not.toBeInTheDocument();
  });
});

/**
 * What the server ACTUALLY puts on the wire during `warning_teams`:
 *
 *  - `teams_snapshot_json` is written when the run starts, before a single
 *    notice goes out. It is the roster of who is being interrupted.
 *  - `teams_warned_json` depends on the server: an older one writes it once,
 *    when the window SETTLES, so for most of the window it is `[]`. The current
 *    one writes a `pending` placeholder per snapshot team the instant the
 *    window opens and refines each row as its lead answers — so mid-window it
 *    carries a MIXED set (proved end to end in
 *    `packages/server/src/modules/updates/teams-port.test.ts`). Both shapes
 *    reach this component, and both are fixtured below.
 *
 *    The placeholder said `never_idle` until this was fixed — a verdict ("this
 *    lead never reached an idle boundary") minted before a single observation,
 *    which the screen rendered as "(busy for 4m31)" for the whole window.
 *
 * These fixtures are built from that, not from a shape that would be
 * convenient. Counting the records instead of the snapshot is what put "No team
 * is active — nothing to interrupt" on screen while three teams were minutes
 * from being killed.
 */
describe('UpdateSection — the warning window', () => {
  const THREE_TEAMS = [
    { orchestratorId: 'o1', name: 'a', leadSessionId: 'o1-lead' },
    { orchestratorId: 'o2', name: 'b', leadSessionId: 'o2-lead' },
    { orchestratorId: 'o3', name: 'stiix-infra', leadSessionId: 'o3-lead' },
  ];
  /** Every lead has read it — the one fully-populated set a live window can hold. */
  const ALL_READ = [
    mkWarned({ orch_id: 'o1', orch_name: 'a' }),
    mkWarned({ orch_id: 'o2', orch_name: 'b' }),
    mkWarned({ orch_id: 'o3', orch_name: 'stiix-infra' }),
  ];

  function warningRun(over: Partial<UpdateRunView> = {}): UpdateRunView {
    return mkRun({
      state: 'warning_teams',
      graceRemainingSeconds: 72,
      warnedAt: new Date(Date.now() - 271_000).toISOString(),
      teamsSnapshot: THREE_TEAMS,
      // The wire, mid-window: the roster is known, the read states are not.
      teamsWarned: [],
      ...over,
    });
  }

  it('counts the teams of the snapshot, not the records that have not landed', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: warningRun() }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(warningRun()) });

    render(<UpdateSection />);

    expect(
      await screen.findByText(
        '3 teams warned — 3 leads have not answered yet. Applying in 01:12.',
      ),
    ).toBeInTheDocument();
    // The sentence this feature exists to get right must NOT be the zero one.
    expect(screen.queryByText(/No team is active/)).not.toBeInTheDocument();
    // And every team of the roster is on screen, as pending — not absent.
    expect(screen.getAllByText(':: no answer yet')).toHaveLength(3);
    expect(screen.getByText('stiix-infra')).toBeInTheDocument();
    expect(screen.getByText('01:12')).toBeInTheDocument();
  });

  /**
   * The same screen, from the placeholder rows the CURRENT server writes the
   * instant the window opens. It has to read exactly like the empty-column case
   * above, because it carries exactly as much information — and it used to read
   * as "1 lead (stiix-infra) has not read it yet (busy for 4m31). Applying
   * anyway in 01:12.", a verdict about a lead nobody had looked at.
   */
  it('renders the server’s own placeholder rows as unanswered, never as a verdict', async () => {
    const placeholders = warningRun({
      teamsWarned: THREE_TEAMS.map((t) =>
        mkWarned({
          orch_id: t.orchestratorId,
          orch_name: t.name,
          lead_id: t.leadSessionId,
          signalled: false,
          read: false,
          state: 'pending',
        }),
      ),
    });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: placeholders }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(placeholders) });

    render(<UpdateSection />);

    expect(
      await screen.findByText(
        '3 teams warned — 3 leads have not answered yet. Applying in 01:12.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(':: no answer yet')).toHaveLength(3);
    expect(screen.queryByText(/busy for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Applying anyway/)).not.toBeInTheDocument();
    expect(screen.queryByText(/never available/)).not.toBeInTheDocument();
  });

  it('names the lead which has not read the notice as soon as the server says so', async () => {
    // A partially-observed window: two reads in, one notice sitting unread in a
    // lead's terminal. This is what a server that persists rows as it observes
    // them puts on the wire.
    const partial = warningRun({
      teamsWarned: [
        mkWarned({ orch_id: 'o1', orch_name: 'a' }),
        mkWarned({ orch_id: 'o2', orch_name: 'b' }),
        mkWarned({
          orch_id: 'o3',
          orch_name: 'stiix-infra',
          state: 'queued_unread',
          read: false,
        }),
      ],
    });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: partial }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(partial) });

    render(<UpdateSection />);

    expect(
      await screen.findByText(
        '3 teams warned — 1 lead (stiix-infra) has not read it yet (notice displayed in its terminal, not consumed yet). Applying anyway in 01:12.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(':: displayed, unread')).toBeInTheDocument();
    expect(screen.getAllByText(':: read')).toHaveLength(2);
  });

  it('says everyone read it when they did', async () => {
    const allRead = warningRun({ teamsWarned: ALL_READ });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: allRead }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(allRead) });

    render(<UpdateSection />);

    expect(
      await screen.findByText('3 teams warned — all leads have read it. Applying in 01:12.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText(':: read')).toHaveLength(3);
  });

  it('still says "nothing to interrupt" when the snapshot really is empty', async () => {
    const alone = warningRun({ teamsSnapshot: [], teamsWarned: [] });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: alone }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(alone) });

    render(<UpdateSection />);

    expect(
      await screen.findByText('No team is active — nothing to interrupt. Applying in 01:12.'),
    ).toBeInTheDocument();
  });

  it('APPLY NOW cuts the window short once the 120 s floor has elapsed', async () => {
    // The fixture opened its window 271 s ago: past the floor, so the server
    // would accept, so the control is live.
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: warningRun() }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(warningRun()) });
    const applyNow = vi.spyOn(api, 'applyUpdateNow').mockResolvedValue({
      applied: true,
      run: mkDetail({ state: 'preflight' }),
    });

    render(<UpdateSection />);
    const btn = await screen.findByRole('button', { name: 'APPLY NOW' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() => expect(applyNow).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText(/UPDATE IN PROGRESS :: v0\.6\.0/)).toBeInTheDocument();
  });

  it('does not offer APPLY NOW inside the floor — the server would refuse it', async () => {
    const young = warningRun({
      warnedAt: new Date(Date.now() - 30_000).toISOString(),
      graceRemainingSeconds: 270,
    });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: young }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(young) });
    const applyNow = vi.spyOn(api, 'applyUpdateNow');

    render(<UpdateSection />);

    const btn = await screen.findByRole('button', { name: 'APPLY NOW' });
    expect(btn).toBeDisabled();
    // And it says how long the floor still has to run, not just "no".
    expect(screen.getByText(/unlocks once the 120 s floor has elapsed — 01:30 left/)).toBeInTheDocument();
    expect(applyNow).not.toHaveBeenCalled();
  });

  it('keeps APPLY NOW off when the run has no recorded window start', async () => {
    const noStart = warningRun({ warnedAt: null });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: noStart }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(noStart) });

    render(<UpdateSection />);

    expect(await screen.findByRole('button', { name: 'APPLY NOW' })).toBeDisabled();
    expect(screen.getByText(/needs a recorded start for the window/)).toBeInTheDocument();
  });

  it('surfaces a 409 from the floor as the message the server wrote', async () => {
    // Reachable only when the two clocks disagree — and then the operator gets
    // the server's sentence, naming the wait, instead of a silent no-op.
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: warningRun() }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(warningRun()) });
    vi.spyOn(api, 'applyUpdateNow').mockRejectedValue(
      new HttpError('HTTP 409 POST /updates/apply-now', 409, {
        error:
          'The warning window has a hard floor of 120 s and 42 s of it are left. Ask again in 42 s.',
        remainingSeconds: 42,
      }),
    );

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'APPLY NOW' }));

    expect(await screen.findByText(/⚠ The warning window has a hard floor of 120 s and 42 s of it are left/))
      .toBeInTheDocument();
  });

  it('says the window cannot be shortened when the route is not there (404)', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: warningRun() }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(warningRun()) });
    vi.spyOn(api, 'applyUpdateNow').mockRejectedValue(
      new HttpError('HTTP 404 POST /updates/apply-now', 404, null),
    );

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'APPLY NOW' }));

    expect(await screen.findByText(/applies at its deadline/)).toBeInTheDocument();
  });

  it('CANCEL cancels the run in its window', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: warningRun() }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(warningRun()) });
    const cancel = vi
      .spyOn(api, 'cancelUpdateRun')
      .mockResolvedValue({ cancelled: true, run: null });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'CANCEL' }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith('run-1'));
  });

  it('a pending schedule is cancelled through the schedule route', async () => {
    const scheduled = mkRun({ state: 'scheduled', scheduledFor: '2026-07-30T01:00:00.000Z' });
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: scheduled }));
    vi.spyOn(api, 'getUpdateRun').mockResolvedValue({ run: mkDetail(scheduled) });
    const cancel = vi.spyOn(api, 'cancelUpdateSchedule').mockResolvedValue({ cancelled: true });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'CANCEL SCHEDULE' }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });
});

describe('UpdateSection — surviving the restart', () => {
  const APPLYING = mkRun({ state: 'applying', phase: 'writing_env' });

  it('takes over the screen while the container is recreated', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: APPLYING }));
    vi.spyOn(api, 'health').mockRejectedValue(new Error('ECONNREFUSED'));

    render(<UpdateSection />);

    const overlay = await screen.findByRole('alertdialog');
    expect(overlay).toHaveTextContent('UPDATE IN PROGRESS');
    expect(overlay).toHaveTextContent('boot_complete');
  });

  it('reports the server being gone as expected, and does not ask for the verdict', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: APPLYING }));
    const health = vi.spyOn(api, 'health').mockRejectedValue(new Error('ECONNREFUSED'));
    const getRun = vi.spyOn(api, 'getUpdateRun');

    render(<UpdateSection />);
    await screen.findByRole('alertdialog');

    await waitFor(() => expect(health).toHaveBeenCalled(), { timeout: 4_000 });
    expect(await screen.findByText(/the server has stopped answering/)).toBeInTheDocument();
    expect(getRun).not.toHaveBeenCalled();
  });

  it('a 200 without boot_complete is NOT "back"', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: APPLYING }));
    const health = vi.spyOn(api, 'health').mockResolvedValue({ ...HEALTH, boot_complete: false });
    const getRun = vi.spyOn(api, 'getUpdateRun');

    render(<UpdateSection />);
    await screen.findByRole('alertdialog');

    await waitFor(() => expect(health).toHaveBeenCalled(), { timeout: 4_000 });
    expect(await screen.findByText(/the boot is not finished/)).toBeInTheDocument();
    expect(getRun).not.toHaveBeenCalled();
  });

  /**
   * `boot_complete` is a promise the new container can fail to keep: a
   * `healthy_no_boot_complete` deployment answers /health forever and never
   * flips the bit. With no cap and no close control, this full-screen portal
   * was the last thing the operator ever saw of the app.
   */
  it('offers a way out of the overlay, then stops waiting altogether', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: APPLYING }));
      const health = vi
        .spyOn(api, 'health')
        .mockResolvedValue({ ...HEALTH, boot_complete: false });

      render(<UpdateSection />);
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      // Early on there is nothing to close: the restart is simply happening.
      expect(screen.queryByRole('button', { name: 'CLOSE THIS SCREEN' })).not.toBeInTheDocument();

      // Five minutes in — an escape hatch, without stopping the run.
      await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
      expect(screen.getByRole('button', { name: 'CLOSE THIS SCREEN' })).toBeInTheDocument();

      // Fifteen minutes in — the probe stops re-arming and says why.
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
      expect(screen.getByText(/stopped waiting/)).toBeInTheDocument();
      const probes = health.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(health.mock.calls.length).toBe(probes);

      fireEvent.click(screen.getByRole('button', { name: 'CLOSE THIS SCREEN' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the verdict from GET /updates/:id once boot_complete is true', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: APPLYING }));
    vi.spyOn(api, 'health').mockResolvedValue(HEALTH);
    const getRun = vi.spyOn(api, 'getUpdateRun').mockResolvedValue({
      run: mkDetail({ state: 'success', terminal: true, finishedAt: new Date().toISOString() }),
    });

    render(<UpdateSection />);
    await screen.findByRole('alertdialog');

    await waitFor(() => expect(getRun).toHaveBeenCalledWith('run-1'), { timeout: 4_000 });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText(/LAST UPDATE :: APPLIED \(v0\.6\.0\)/)).toBeInTheDocument();
  });
});

describe('UpdateSection — after the update', () => {
  const SNAPSHOT = [
    { orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 'o1-lead' },
    { orchestratorId: 'o2', name: 'web', leadSessionId: 'o2-lead' },
  ];
  const WARNED = [
    mkWarned({ orch_id: 'o1', orch_name: 'stiix-infra', state: 'never_idle', read: false, signalled: false }),
    mkWarned({ orch_id: 'o2', orch_name: 'web' }),
  ];

  function finished(over: Partial<UpdateRunView> = {}): UpdateRunView {
    return mkRun({
      id: 'run-9',
      state: 'success',
      terminal: true,
      finishedAt: new Date(Date.now() - 60_000).toISOString(),
      teamsSnapshot: SNAPSHOT,
      teamsWarned: WARNED,
      ...over,
    });
  }

  it('names the team that did not come back, and what that did to its work', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
      orchestrators: [mkOrch({ id: 'o2', name: 'web' })],
    });

    render(<UpdateSection />);

    expect(await screen.findByText(/TEAMS :: 1 DID NOT COME BACK/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'stiix-infra — notice delivered but never read, the lead was busy for the whole window. Its work was interrupted at an arbitrary point.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/the team was never brought back at all/)).toBeInTheDocument();
  });

  it('RESTART TEAMS restarts exactly the ones that are missing', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
      orchestrators: [mkOrch({ id: 'o2', name: 'web' })],
    });
    const restart = vi
      .spyOn(api, 'restartOrchestrator')
      .mockResolvedValue({ orchestrator: mkOrch({ id: 'o1', name: 'stiix-infra' }) });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'RESTART TEAMS' }));

    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(restart).toHaveBeenCalledWith('o1');
    expect(await screen.findByText(/1 team restarted/)).toBeInTheDocument();
  });

  /**
   * A restart is `restartOrchestrator`: the lead is killed and respawned with
   * no context. So the button validates against the PRESENT before it fires,
   * whichever source produced the list on screen.
   */
  it('skips a team that is running again by the time the button is clicked', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    // The screen says stiix-infra never came back (it was absent when the list
    // was computed); it has been restarted by hand since.
    const list = vi
      .spyOn(api, 'listOrchestrators')
      .mockResolvedValueOnce({ orchestrators: [mkOrch({ id: 'o2', name: 'web' })] })
      .mockResolvedValue({
        orchestrators: [mkOrch({ id: 'o1', name: 'stiix-infra' }), mkOrch({ id: 'o2', name: 'web' })],
      });
    const restart = vi.spyOn(api, 'restartOrchestrator');

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'RESTART TEAMS' }));

    expect(
      await screen.findByText(/0 teams restarted, 1 already running — skipped/),
    ).toBeInTheDocument();
    expect(restart).not.toHaveBeenCalled();
    // The live read happened for the action itself, not only for the display.
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('restarts nothing at all when the live list cannot be read', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    vi.spyOn(api, 'listOrchestrators')
      .mockResolvedValueOnce({ orchestrators: [mkOrch({ id: 'o2', name: 'web' })] })
      .mockRejectedValue(new HttpError('HTTP 500 GET /orchestrators', 500, null));
    const restart = vi.spyOn(api, 'restartOrchestrator');

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'RESTART TEAMS' }));

    expect(await screen.findByText(/nothing was restarted/)).toBeInTheDocument();
    expect(restart).not.toHaveBeenCalled();
  });

  it('counts a team whose lead died on spawn as not back', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
      orchestrators: [
        mkOrch({ id: 'o1', name: 'stiix-infra', sessions: [mkSession({ id: 'o1-lead', status: 'failed' })] }),
        mkOrch({ id: 'o2', name: 'web' }),
      ],
    });

    render(<UpdateSection />);

    expect(await screen.findByText(/the lead died on restart/)).toBeInTheDocument();
  });

  it('says so plainly when every team came back', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
    vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
      orchestrators: [mkOrch({ id: 'o1', name: 'stiix-infra' }), mkOrch({ id: 'o2', name: 'web' })],
    });

    render(<UpdateSection />);

    expect(await screen.findByText(/TEAMS :: ALL BACK/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'RESTART TEAMS' })).not.toBeInTheDocument();
  });

  /**
   * §D.6 — the server writes `teams_reconciled_json` on the boot that follows
   * the update. That record is what was TRUE THEN; `GET /orchestrators` is only
   * what is true now, and the two diverge the moment anyone touches a team.
   */
  describe('the server-side record', () => {
    const RECONCILED = [
      mkReconciled({ orch_id: 'o1', orch_name: 'stiix-infra', back: false, reason: 'lead_dead', lead_id_now: null }),
      mkReconciled({ orch_id: 'o2', orch_name: 'web' }),
    ];

    it('is preferred over the live list, and no live list is even fetched', async () => {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(
        appliable({ run: null, recentRuns: [finished({ teamsReconciled: RECONCILED })] }),
      );
      // Would say "all back" — the exact disagreement the record must win.
      const list = vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
        orchestrators: [mkOrch({ id: 'o1', name: 'stiix-infra' }), mkOrch({ id: 'o2', name: 'web' })],
      });

      render(<UpdateSection />);

      expect(await screen.findByText(/TEAMS :: 1 DID NOT COME BACK/)).toBeInTheDocument();
      expect(screen.getByText(/the lead died on restart/)).toBeInTheDocument();
      expect(screen.getByText(/recorded by the server on the boot that followed the update/)).toBeInTheDocument();
      expect(list).not.toHaveBeenCalled();
    });

    it('still restarts the teams the record names', async () => {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(
        appliable({ run: null, recentRuns: [finished({ teamsReconciled: RECONCILED })] }),
      );
      // Nothing is live, so the record and the present agree: o1 is restarted.
      const list = vi.spyOn(api, 'listOrchestrators').mockResolvedValue({ orchestrators: [] });
      const restart = vi
        .spyOn(api, 'restartOrchestrator')
        .mockResolvedValue({ orchestrator: mkOrch({ id: 'o1', name: 'stiix-infra' }) });

      render(<UpdateSection />);
      fireEvent.click(await screen.findByRole('button', { name: 'RESTART TEAMS' }));

      await waitFor(() => expect(restart).toHaveBeenCalledWith('o1'));
      expect(restart).toHaveBeenCalledTimes(1);
      // The record is the display; the live list is what the ACTION is checked
      // against — even here, where no list was needed to render.
      expect(list).toHaveBeenCalled();
    });

    /**
     * The record is history and never changes, so it would name the same
     * casualty forever. Clicking twice used to kill the lead that the first
     * click had just started.
     */
    it('a second click is a no-op, not a second kill', async () => {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(
        appliable({ run: null, recentRuns: [finished({ teamsReconciled: RECONCILED })] }),
      );
      vi.spyOn(api, 'listOrchestrators').mockResolvedValue({ orchestrators: [] });
      const restart = vi
        .spyOn(api, 'restartOrchestrator')
        .mockResolvedValue({ orchestrator: mkOrch({ id: 'o1', name: 'stiix-infra' }) });

      render(<UpdateSection />);
      const btn = await screen.findByRole('button', { name: 'RESTART TEAMS' });
      fireEvent.click(btn);

      await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
      // The control withdraws itself rather than staying armed on a stale list.
      const after = await screen.findByRole('button', { name: 'RESTARTED' });
      expect(after).toBeDisabled();
      fireEvent.click(after);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it('falls back to the live diff for a run that predates the column', async () => {
      // `teamsReconciled` absent (older server) — the only case where the
      // client-side computation is still the right answer.
      vi.spyOn(api, 'getUpdates').mockResolvedValue(appliable({ run: null, recentRuns: [finished()] }));
      const list = vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
        orchestrators: [mkOrch({ id: 'o2', name: 'web' })],
      });

      render(<UpdateSection />);

      expect(await screen.findByText(/this run predates the server-side record/)).toBeInTheDocument();
      expect(screen.getByText(/TEAMS :: 1 DID NOT COME BACK/)).toBeInTheDocument();
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('treats an empty record as no record, not as "no team was lost"', async () => {
      vi.spyOn(api, 'getUpdates').mockResolvedValue(
        appliable({ run: null, recentRuns: [finished({ teamsReconciled: [] })] }),
      );
      vi.spyOn(api, 'listOrchestrators').mockResolvedValue({
        orchestrators: [mkOrch({ id: 'o2', name: 'web' })],
      });

      render(<UpdateSection />);

      expect(await screen.findByText(/TEAMS :: 1 DID NOT COME BACK/)).toBeInTheDocument();
      expect(screen.getByText(/this run predates the server-side record/)).toBeInTheDocument();
    });
  });
});

describe('UpdateSection — terminal verdicts', () => {
  it('refused is the reassuring one: nothing was touched', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({
        run: null,
        recentRuns: [
          mkRun({
            state: 'refused',
            terminal: true,
            finishedAt: new Date().toISOString(),
            error: 'no writable .env found next to the compose file',
          }),
        ],
      }),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/NOTHING WAS TOUCHED/)).toBeInTheDocument();
    expect(screen.getByText(/no team interrupted/)).toBeInTheDocument();
    expect(screen.getByText(/no writable \.env found/)).toBeInTheDocument();
    expect(screen.queryByText(/^⚠/)).not.toBeInTheDocument();
  });

  it('rolled_back says the service is back on the previous version', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({
        run: null,
        recentRuns: [mkRun({ state: 'rolled_back', terminal: true, finishedAt: new Date().toISOString() })],
      }),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/ROLLED BACK — PREVIOUS VERSION/)).toBeInTheDocument();
    expect(screen.getByText(/running on the previous version again/)).toBeInTheDocument();
  });

  it('a success carrying a review note is flagged rather than celebrated', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({
        run: null,
        recentRuns: [
          mkRun({
            state: 'success',
            terminal: true,
            finishedAt: new Date().toISOString(),
            error: 'Updated. [manual review: served /health but never reported boot_complete]',
          }),
        ],
      }),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/APPLIED — NEEDS A CHECK/)).toBeInTheDocument();
    expect(screen.getByText(/no rollback was triggered/)).toBeInTheDocument();
  });

  it('abandoned offers a retry that re-applies the same version', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({
        run: null,
        recentRuns: [
          mkRun({ state: 'abandoned', terminal: true, finishedAt: new Date().toISOString() }),
        ],
      }),
    );
    const apply = vi
      .spyOn(api, 'applyUpdate')
      .mockResolvedValue({ runId: 'run-2', run: mkDetail({ id: 'run-2' }) });

    render(<UpdateSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'RETRY v0.6.0' }));

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ targetVersion: '0.6.0', graceSeconds: 300 }),
    );
  });

  it('failed is the only alarming verdict', async () => {
    vi.spyOn(api, 'getUpdates').mockResolvedValue(
      appliable({
        run: null,
        recentRuns: [
          mkRun({ state: 'failed', terminal: true, finishedAt: new Date().toISOString(), error: 'compose up timed out' }),
        ],
      }),
    );

    render(<UpdateSection />);

    expect(await screen.findByText(/LAST UPDATE :: FAILED/)).toBeInTheDocument();
    expect(screen.getByText('compose up timed out')).toBeInTheDocument();
  });
});
