// packages/web/src/components/desktop/SpawnWorkerDialog.test.tsx
//
// Multi-provider Lot 7 — the dialog is LIVE.
//
// It shipped in Phase C — Step 13 with a permanently disabled SPAWN button and
// a `.field-warn` block telling the operator to go call `team.spawn_worker` over
// MCP instead (gap §4-3). `POST /orchestrators/:id/workers` now exists, so the
// contract asserted here is the opposite of the old one:
//
//  - SPAWN submits, gated only on NAME + INITIAL TASK;
//  - the request body carries provider + model, inherited from the team unless
//    the operator changed the select (that inheritance is also stated in the UI —
//    a worker silently running a different model than its team is the surprise
//    this dialog exists to prevent);
//  - a server rejection is rendered with its code AND its reason, and the dialog
//    stays open so the operator can fix the field;
//  - the MCP workaround block is gone: a button plus "actually, go type this
//     elsewhere" is a UI saying two things.
//
// Unchanged from Step 13 and still asserted: ORCHESTRATOR roles are filtered
// out, NAME auto-uppercases, re-opening resets the form, and backdrop / CANCEL /
// Escape / × all close.

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SpawnWorkerDialog from './SpawnWorkerDialog';
import {
  api,
  HttpError,
  type OrchestratorView,
  type ProviderInfo,
  type ProvidersView,
  type RoleView,
} from '../../api/client';

/**
 * Capabilities, built from a partial. Deliberately asserted rather than spelled
 * out at each call site: the capability set is a moving target (a `notificationHook`
 * boolean is on its way to something richer), and a test fixture that has to be
 * re-typed every time the server learns a new capability is a fixture that will
 * be wrong. Only the fields a test actually asserts on are named.
 */
function caps(p: Partial<ProviderInfo['capabilities']> = {}): ProviderInfo['capabilities'] {
  return {
    effort: true,
    permissionModes: ['bypassPermissions', 'default', 'plan'],
    fallbackPermissionMode: 'bypassPermissions',
    notificationHook: true,
    inkSubmitDance: true,
    durablePreamble: true,
    httpMcp: true,
    ...p,
  } as ProviderInfo['capabilities'];
}

function mkOrch(p: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'NOMAD',
    role: 'BUILDER',
    roleId: 'r-orch',
    status: 'running',
    leadSessionId: 's1',
    defaultModel: 'claude-opus-4-7',
    defaultEffort: 'high',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
    ...p,
  };
}

function mkRole(p: Partial<RoleView> = {}): RoleView {
  return {
    id: 'r-builder',
    label: 'BUILDER',
    leadPrompt: null,
    leadPreamble: null,
    workerPreamble: null,
    workerCount: 1,
    defaultModel: null,
    defaultEffort: null,
    defaultPermissionMode: null,
    schedule: null,
    scheduleMessage: null,
    connectors: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...p,
  };
}

const DEFAULT_ROLES: RoleView[] = [
  mkRole({ id: 'r-orch', label: 'ORCHESTRATOR' }),
  mkRole({ id: 'r-builder', label: 'BUILDER' }),
  mkRole({ id: 'r-researcher', label: 'RESEARCHER', workerPreamble: 'be skeptical' }),
];

/**
 * Two available adapters (the team's own `claude`, plus `gemini` with no
 * reasoning-effort flag and no notification hook) so the override path and the
 * capability notes both have something real to render.
 */
function catalogue(): ProvidersView {
  return {
    defaultProvider: 'claude',
    transport: 'ssh',
    providers: [
      {
        id: 'claude',
        label: 'Claude Code',
        binary: 'claude',
        builtin: true,
        available: true,
        models: [
          { value: 'claude-opus-4-7', label: 'opus-4-7' },
          { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
        ],
        capabilities: caps(),
        defaults: {
          model: 'claude-opus-4-7',
          effort: 'xhigh',
          permissionMode: 'bypassPermissions',
        },
      },
      {
        id: 'gemini',
        label: 'Gemini CLI',
        binary: 'gemini',
        builtin: true,
        available: true,
        models: [{ value: 'gemini-3-pro', label: 'gemini-3-pro' }],
        capabilities: caps({
          effort: false,
          permissionModes: ['bypassPermissions'],
          notificationHook: false,
        }),
        defaults: {
          model: 'gemini-3-pro',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
      },
    ],
  };
}

function stubProviders(): void {
  vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
}

interface RenderOpts {
  open?: boolean;
  team?: OrchestratorView | null;
  roles?: readonly RoleView[];
  onClose?: () => void;
  onSpawn?: Mock;
}

function renderDialog(opts: RenderOpts = {}) {
  const onClose = opts.onClose ?? (() => undefined);
  const onSpawn: Mock = opts.onSpawn ?? vi.fn().mockResolvedValue(undefined);
  const props = {
    open: opts.open ?? true,
    team: opts.team === undefined ? mkOrch() : opts.team,
    roles: opts.roles ?? DEFAULT_ROLES,
    onClose,
    onSpawn: onSpawn as unknown as (
      orchestratorId: string,
      body: { prompt: string },
    ) => Promise<void>,
  };
  const utils = render(<SpawnWorkerDialog {...props} />);
  return { ...utils, onClose, onSpawn, props };
}

function fillRequired(name = 'PROBE-04', task = 'audit the auth module'): void {
  fireEvent.change(screen.getByLabelText('NAME'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('INITIAL TASK'), { target: { value: task } });
}

function spawnButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /SPAWN/ }) as HTMLButtonElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SpawnWorkerDialog — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = renderDialog({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when team is null even if open=true', () => {
    const { container } = renderDialog({ team: null });
    expect(container.firstChild).toBeNull();
  });

  it('renders the title with the team name when open', () => {
    renderDialog({ team: mkOrch({ name: 'ATLAS' }) });
    const title = screen.getByText(/SPAWN WORKER/);
    expect(title.textContent).toMatch(/in ATLAS/);
  });
});

describe('SpawnWorkerDialog — ROLE dropdown', () => {
  it('filters out the ORCHESTRATOR role', () => {
    renderDialog();
    const select = screen.getByLabelText('ROLE') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.label);
    expect(options).toContain('BUILDER');
    expect(options).toContain('RESEARCHER');
    expect(options).not.toContain('ORCHESTRATOR');
  });

  it('pre-selects the first non-ORCHESTRATOR role', () => {
    renderDialog();
    expect((screen.getByLabelText('ROLE') as HTMLSelectElement).value).toBe('r-builder');
  });

  it('shows the empty-state option when no worker roles exist', () => {
    renderDialog({ roles: [mkRole({ id: 'r-orch', label: 'ORCHESTRATOR' })] });
    expect(screen.getByText(/no worker roles available/i)).toBeInTheDocument();
  });
});

describe('SpawnWorkerDialog — NAME input', () => {
  it('auto-uppercases keystrokes', () => {
    renderDialog();
    const input = screen.getByLabelText('NAME') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'probe-04' } });
    expect(input.value).toBe('PROBE-04');
  });
});

describe('SpawnWorkerDialog — SPAWN gating', () => {
  it('is disabled until both NAME and INITIAL TASK are filled', () => {
    renderDialog();
    expect(spawnButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'PROBE-04' } });
    expect(spawnButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('INITIAL TASK'), { target: { value: 'go' } });
    expect(spawnButton()).toBeEnabled();
  });

  it('no longer advertises itself as a v2 feature', () => {
    renderDialog();
    const btn = spawnButton();
    expect(btn.getAttribute('title') ?? '').not.toMatch(/available in v2/i);
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('stays usable when the deployment has no worker roles at all', () => {
    // ROLE is not required — the server falls back to the team's own role.
    renderDialog({ roles: [] });
    fillRequired();
    expect(spawnButton()).toBeEnabled();
  });
});

describe('SpawnWorkerDialog — the MCP workaround is gone', () => {
  it('never mentions the endpoint as missing, nor a team.spawn_worker snippet', () => {
    const { container } = renderDialog();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/POST \/orchestrators\/:id\/workers/);
    expect(text).not.toMatch(/team\.spawn_worker/);
    expect(text).not.toMatch(/backend endpoint missing/i);
  });
});

describe('SpawnWorkerDialog — submit', () => {
  it('POSTs to the team with the inherited provider and model', async () => {
    stubProviders();
    const { onSpawn } = renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText(/^PROVIDER/) as HTMLSelectElement).value).toBe('claude'),
    );
    fillRequired();
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));

    expect(onSpawn.mock.calls[0]?.[0]).toBe('o1');
    expect(onSpawn.mock.calls[0]?.[1]).toMatchObject({
      name: 'PROBE-04',
      role: 'BUILDER',
      prompt: 'audit the auth module',
      provider: 'claude',
      model: 'claude-opus-4-7',
    });
    // EFFORT / PERMISSION are never sent: they always inherit, and the help line
    // says so. Sending them would make the dialog claim a choice it never offered.
    expect(onSpawn.mock.calls[0]?.[1]).not.toHaveProperty('effort');
    expect(onSpawn.mock.calls[0]?.[1]).not.toHaveProperty('permissionMode');
  });

  it('sends the preamble override only when one was typed', async () => {
    const { onSpawn } = renderDialog();
    fillRequired();
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect(onSpawn.mock.calls[0]?.[1]).not.toHaveProperty('preamble');

    fireEvent.change(screen.getByLabelText(/WORKER PREAMBLE OVERRIDE/), {
      target: { value: 'be relentlessly skeptical' },
    });
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    expect(onSpawn.mock.calls[1]?.[1]).toMatchObject({
      preamble: 'be relentlessly skeptical',
    });
  });

  it('carries a per-agent provider override — this is how a mixed team is built', async () => {
    stubProviders();
    const { onSpawn } = renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText(/^PROVIDER/) as HTMLSelectElement).value).toBe('claude'),
    );
    fireEvent.change(screen.getByLabelText(/^PROVIDER/), { target: { value: 'gemini' } });
    // Switching provider lands on THAT provider's default model, never on the
    // team's claude id — `gemini -m claude-opus-4-7` is not a thing.
    await waitFor(() =>
      expect((screen.getByLabelText(/^MODEL/) as HTMLSelectElement).value).toBe('gemini-3-pro'),
    );
    fillRequired();
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect(onSpawn.mock.calls[0]?.[1]).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3-pro',
    });
  });

  it('closes on success', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fillRequired();
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('SpawnWorkerDialog — inheritance is visible', () => {
  it('marks PROVIDER and MODEL as inherited while they match the team', async () => {
    stubProviders();
    const { container } = renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText(/^PROVIDER/) as HTMLSelectElement).value).toBe('claude'),
    );
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/PROVIDER \/\/ inherited from NOMAD/);
    expect(text).toMatch(/MODEL \/\/ inherited from NOMAD/);
  });

  it('flips to an explicit-override marker once the operator deviates', async () => {
    stubProviders();
    const { container } = renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText(/^PROVIDER/) as HTMLSelectElement).value).toBe('claude'),
    );
    fireEvent.change(screen.getByLabelText(/^PROVIDER/), { target: { value: 'gemini' } });
    await waitFor(() => {
      const text = (container.textContent ?? '').replace(/\s+/g, ' ');
      expect(text).toMatch(/PROVIDER \/\/ overrides NOMAD \(claude\)/);
      expect(text).toMatch(/MODEL \/\/ overrides NOMAD/);
    });
  });

  it('shows model / effort / perm inherited from the team', () => {
    const { container } = renderDialog({
      team: mkOrch({
        name: 'NOMAD',
        defaultModel: 'claude-opus-4-7',
        defaultEffort: 'high',
        defaultPermissionMode: 'bypassPermissions',
      }),
    });
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    // Model gets the `claude-` prefix stripped.
    expect(text).toMatch(/MODEL opus-4-7/);
    expect(text).toMatch(/EFFORT high/);
    expect(text).toMatch(/PERM bypassPermissions/);
    expect(text).toMatch(/from NOMAD/);
  });

  it('discloses the capabilities the chosen provider does NOT have', async () => {
    stubProviders();
    const { container } = renderDialog();
    await waitFor(() =>
      expect((screen.getByLabelText(/^PROVIDER/) as HTMLSelectElement).value).toBe('claude'),
    );
    fireEvent.change(screen.getByLabelText(/^PROVIDER/), { target: { value: 'gemini' } });
    await waitFor(() => {
      const text = (container.textContent ?? '').replace(/\s+/g, ' ');
      // The "EFFORT high" line above is a half-truth for gemini; say so.
      expect(text).toMatch(/no reasoning-effort flag/);
      expect(text).toMatch(/never report/);
    });
  });
});

describe('SpawnWorkerDialog — server errors are legible', () => {
  it('renders 409 PROVIDER_UNAVAILABLE with its code and its reason', async () => {
    const onSpawn = vi.fn().mockRejectedValue(
      new HttpError('HTTP 409 POST /orchestrators/o1/workers', 409, {
        error: "provider 'gemini' is not available",
        code: 'PROVIDER_UNAVAILABLE',
        unavailableReason: '`gemini` is not on PATH on the host',
      }),
    );
    const onClose = vi.fn();
    renderDialog({ onSpawn, onClose });
    fillRequired();
    fireEvent.click(spawnButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/PROVIDER_UNAVAILABLE/);
    expect(alert.textContent ?? '').toMatch(/is not available/);
    // The sentence that actually tells the operator what to fix.
    expect(alert.textContent ?? '').toMatch(/not on PATH on the host/);
    // …and the dialog stays open so they can fix it.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders 400 UNKNOWN_PROVIDER with the list of providers it knows', async () => {
    const onSpawn = vi.fn().mockRejectedValue(
      new HttpError('HTTP 400 POST /orchestrators/o1/workers', 400, {
        error: "unknown provider 'gemni'",
        code: 'UNKNOWN_PROVIDER',
        known: ['claude', 'codex', 'gemini'],
      }),
    );
    renderDialog({ onSpawn });
    fillRequired();
    fireEvent.click(spawnButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/UNKNOWN_PROVIDER/);
    expect(alert.textContent ?? '').toMatch(/known providers: claude, codex, gemini/);
  });

  it('renders 429 MAX_WORKERS_PER_ORCH as the cap message, not "HTTP 429"', async () => {
    const onSpawn = vi.fn().mockRejectedValue(
      new HttpError('HTTP 429 POST /orchestrators/o1/workers', 429, {
        error: 'max workers per orchestrator (20) reached',
        code: 'MAX_WORKERS_PER_ORCH',
      }),
    );
    renderDialog({ onSpawn });
    fillRequired();
    fireEvent.click(spawnButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/max workers per orchestrator \(20\) reached/);
    expect(alert.textContent ?? '').not.toMatch(/^HTTP 429$/);
  });

  it('renders a 413 prompt-too-large body', async () => {
    const onSpawn = vi.fn().mockRejectedValue(
      new HttpError('HTTP 413 POST /orchestrators/o1/workers', 413, {
        error: 'prompt+preamble too large: 70000 bytes > 65536',
      }),
    );
    renderDialog({ onSpawn });
    fillRequired();
    fireEvent.click(spawnButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/too large: 70000 bytes > 65536/);
  });

  it('re-enables SPAWN after a failure so the operator can retry', async () => {
    const onSpawn = vi
      .fn()
      .mockRejectedValueOnce(
        new HttpError('HTTP 429 POST /orchestrators/o1/workers', 429, {
          error: 'max workers per orchestrator (20) reached',
          code: 'MAX_WORKERS_PER_ORCH',
        }),
      )
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    renderDialog({ onSpawn, onClose });
    fillRequired();
    fireEvent.click(spawnButton());
    await screen.findByRole('alert');
    expect(spawnButton()).toBeEnabled();
    fireEvent.click(spawnButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('SpawnWorkerDialog — close interactions', () => {
  it('CANCEL button calls onClose', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn();
    const { container } = renderDialog({ onClose });
    fireEvent.click(container.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click inside the modal does NOT call onClose (stopPropagation)', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByLabelText('NAME'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('× close button calls onClose', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SpawnWorkerDialog — reset on re-open', () => {
  it('clears NAME, TASK and the error banner when the modal is re-opened', async () => {
    const onSpawn = vi.fn().mockRejectedValue(
      new HttpError('HTTP 429 POST /orchestrators/o1/workers', 429, {
        error: 'max workers per orchestrator (20) reached',
        code: 'MAX_WORKERS_PER_ORCH',
      }),
    );
    const props = {
      team: mkOrch(),
      roles: DEFAULT_ROLES,
      onClose: () => undefined,
      onSpawn: onSpawn as unknown as (
        orchestratorId: string,
        body: { prompt: string },
      ) => Promise<void>,
    };
    const { rerender } = render(<SpawnWorkerDialog open {...props} />);
    fillRequired('X', 'y');
    fireEvent.click(spawnButton());
    await screen.findByRole('alert');

    rerender(<SpawnWorkerDialog open={false} {...props} />);
    rerender(<SpawnWorkerDialog open {...props} />);

    expect((screen.getByLabelText('NAME') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('INITIAL TASK') as HTMLTextAreaElement).value).toBe('');
    // A stale error from the previous attempt would read as a fresh failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('SpawnWorkerDialog — accessibility', () => {
  it('exposes role=dialog, aria-modal=true and aria-labelledby', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'spawn-worker-title');
    expect(document.getElementById('spawn-worker-title')).toBeInTheDocument();
  });
});
