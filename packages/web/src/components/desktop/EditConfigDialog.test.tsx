// packages/web/src/components/desktop/EditConfigDialog.test.tsx
//
// Phase C — Step 13 : smoke tests for `EditConfigDialog`.
//
// Contract enforced by docs/redesign-desktop/13_spawn-worker-edit-config.md
// §6 + §10 step 8 :
//  - `open={false}` (or `team=null`) renders nothing.
//  - MODEL / EFFORT / PERMISSION MODE are pre-filled from team defaults.
//  - ROTATE+RESTART button is **always disabled** v1 (gap §4-2),
//    regardless of edits.
//  - The disabled button carries the `available in v2 …` tooltip.
//  - Selecting `bypassPermissions` reveals the inline warning.
//  - The gap `.field-warn` block names the missing endpoint and lists
//    the destroy+recreate losses.
//  - CANCEL, backdrop click, Escape, and `×` close button call onClose.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import EditConfigDialog from './EditConfigDialog';
import { api, type OrchestratorView, type ProvidersView } from '../../api/client';

/**
 * Multi-provider Lot 3 — MODEL options now come from `GET /providers`, so the
 * catalogue is stubbed rather than hard-coded in the bundle. The claude entry
 * declares every permission mode and effort support so the pre-fill assertions
 * below keep testing the pre-fill and not a capability filter.
 */
const CATALOGUE: ProvidersView = {
  defaultProvider: 'claude',
  transport: 'local',
  providers: [
    {
      id: 'claude',
      label: 'Claude Code',
      binary: 'claude',
      builtin: true,
      available: true,
      models: [
        { value: 'claude-opus-4-8', label: 'opus-4-8' },
        { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
        { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
      ],
      capabilities: {
        effort: true,
        permissionModes: [
          'auto',
          'acceptEdits',
          'bypassPermissions',
          'default',
          'dontAsk',
          'plan',
        ],
        fallbackPermissionMode: 'bypassPermissions',
        notificationHook: true,
        inkSubmitDance: true,
        durablePreamble: true,
        httpMcp: true,
      },
      defaults: {
        model: 'claude-opus-4-8',
        effort: 'xhigh',
        permissionMode: 'bypassPermissions',
      },
    },
  ],
};

beforeEach(() => {
  vi.spyOn(api, 'listProviders').mockResolvedValue(CATALOGUE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkOrch(p: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'NOMAD',
    role: 'BUILDER',
    roleId: 'r-orch',
    status: 'running',
    leadSessionId: 's1',
    defaultProvider: 'claude',
    // One of the ids the stubbed catalogue offers. An id it does NOT offer
    // still renders (as "· not in catalogue"), by design.
    defaultModel: 'claude-opus-4-8',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
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

describe('EditConfigDialog — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <EditConfigDialog open={false} team={mkOrch()} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when team is null', () => {
    const { container } = render(
      <EditConfigDialog open team={null} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the title with the team name', () => {
    render(
      <EditConfigDialog open team={mkOrch({ name: 'ATLAS' })} onClose={() => undefined} />,
    );
    const title = screen.getByText(/ROTATE CONFIG/);
    expect(title.textContent).toMatch(/ATLAS/);
  });

  it('renders the restart-warning header', () => {
    render(<EditConfigDialog open team={mkOrch()} onClose={() => undefined} />);
    expect(
      screen.getByText(/Saving will restart all sessions/i),
    ).toBeInTheDocument();
  });
});

describe('EditConfigDialog — pre-filling from team defaults', () => {
  it('pre-fills MODEL from team.defaultModel', () => {
    render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultModel: 'claude-sonnet-4-6' })}
        onClose={() => undefined}
      />,
    );
    const select = screen.getByLabelText('MODEL') as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-4-6');
  });

  it('pre-fills EFFORT from team.defaultEffort (highlights the matching pill)', () => {
    const { container } = render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultEffort: 'max' })}
        onClose={() => undefined}
      />,
    );
    const onPill = container.querySelector('.seg-radio button.on');
    expect(onPill?.textContent).toBe('max');
  });

  it('pre-fills PERMISSION MODE from team.defaultPermissionMode', () => {
    render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultPermissionMode: 'acceptEdits' })}
        onClose={() => undefined}
      />,
    );
    const select = screen.getByLabelText('PERMISSION MODE') as HTMLSelectElement;
    expect(select.value).toBe('acceptEdits');
  });
});

describe('EditConfigDialog — submit button always disabled v1', () => {
  it('ROTATE+RESTART button is disabled on initial render', () => {
    render(<EditConfigDialog open team={mkOrch()} onClose={() => undefined} />);
    const btn = screen.getByRole('button', { name: /ROTATE \+ RESTART/ });
    expect(btn).toBeDisabled();
  });

  it('ROTATE+RESTART stays disabled after changing MODEL', () => {
    render(<EditConfigDialog open team={mkOrch()} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('MODEL'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    expect(screen.getByRole('button', { name: /ROTATE \+ RESTART/ })).toBeDisabled();
  });

  it('ROTATE+RESTART stays disabled after changing EFFORT', () => {
    const { container } = render(
      <EditConfigDialog open team={mkOrch()} onClose={() => undefined} />,
    );
    const pills = container.querySelectorAll<HTMLButtonElement>('.seg-radio button');
    // Click the first effort pill regardless of which one was preselected.
    fireEvent.click(pills[0]!);
    expect(screen.getByRole('button', { name: /ROTATE \+ RESTART/ })).toBeDisabled();
  });

  it('ROTATE+RESTART carries the "available in v2" tooltip', () => {
    render(<EditConfigDialog open team={mkOrch()} onClose={() => undefined} />);
    const btn = screen.getByRole('button', { name: /ROTATE \+ RESTART/ });
    expect(btn).toHaveAttribute('title', expect.stringMatching(/available in v2/i));
    expect(btn).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('EditConfigDialog — bypassPermissions inline warning', () => {
  it('shows the inline warn when bypassPermissions is selected', () => {
    render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultPermissionMode: 'bypassPermissions' })}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/bypassPermissions :: agent runs unattended/i))
      .toBeInTheDocument();
  });

  it('hides the inline warn after switching away from bypassPermissions', () => {
    render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultPermissionMode: 'bypassPermissions' })}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/agent runs unattended/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('PERMISSION MODE'), {
      target: { value: 'default' },
    });
    expect(screen.queryByText(/agent runs unattended/i)).not.toBeInTheDocument();
  });
});

describe('EditConfigDialog — gap §4-2 disclosure', () => {
  it('renders the field-warn block with the missing endpoint name', () => {
    const { container } = render(
      <EditConfigDialog open team={mkOrch()} onClose={() => undefined} />,
    );
    // The component renders multiple .field-warn blocks (bypassPermissions
    // may render its own); the gap one always carries the PATCH text.
    const warns = container.querySelectorAll('.field-warn');
    const text = Array.from(warns).map((w) => w.textContent ?? '').join(' ');
    expect(text).toMatch(/PATCH \/orchestrators\/:id/);
  });

  it('lists destroy+recreate losses (session, mailboxes, id)', () => {
    const { container } = render(
      <EditConfigDialog open team={mkOrch()} onClose={() => undefined} />,
    );
    const warns = container.querySelectorAll('.field-warn');
    const text = Array.from(warns).map((w) => w.textContent ?? '').join(' ');
    expect(text).toMatch(/lead session context/i);
    expect(text).toMatch(/worker sessions/i);
    expect(text).toMatch(/orchestrator id/i);
  });
});

describe('EditConfigDialog — close interactions', () => {
  it('CANCEL button calls onClose', () => {
    const onClose = vi.fn();
    render(<EditConfigDialog open team={mkOrch()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <EditConfigDialog open team={mkOrch()} onClose={onClose} />,
    );
    const backdrop = container.querySelector('.modal-backdrop')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click inside the modal does NOT call onClose (stopPropagation)', () => {
    const onClose = vi.fn();
    render(<EditConfigDialog open team={mkOrch()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('MODEL'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(<EditConfigDialog open team={mkOrch()} onClose={onClose} />);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('× close button calls onClose', () => {
    const onClose = vi.fn();
    render(<EditConfigDialog open team={mkOrch()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('EditConfigDialog — re-open resets from team defaults', () => {
  it('reverts MODEL changes when the modal is re-opened', async () => {
    // The model we switch TO must be one the catalogue offers, so we wait for
    // `GET /providers` to land before changing it. It is also deliberately
    // neither the team default nor the value we change to — otherwise the test
    // would pass on a component that never resets at all.
    const team = mkOrch({ defaultModel: 'claude-haiku-4-5-20251001' });
    const { rerender } = render(
      <EditConfigDialog open team={team} onClose={() => undefined} />,
    );
    await screen.findByRole('option', { name: /sonnet-4-6/ });
    fireEvent.change(screen.getByLabelText('MODEL'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    expect((screen.getByLabelText('MODEL') as HTMLSelectElement).value)
      .toBe('claude-sonnet-4-6');

    // Close
    rerender(<EditConfigDialog open={false} team={team} onClose={() => undefined} />);
    // Re-open
    rerender(<EditConfigDialog open team={team} onClose={() => undefined} />);
    expect((screen.getByLabelText('MODEL') as HTMLSelectElement).value)
      .toBe('claude-haiku-4-5-20251001');
  });
});

describe('EditConfigDialog — accessibility', () => {
  it('exposes role=dialog, aria-modal=true and aria-labelledby', () => {
    render(<EditConfigDialog open team={mkOrch()} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'edit-config-title');
    expect(document.getElementById('edit-config-title')).toBeInTheDocument();
  });

  it('exposes EFFORT pills as a radiogroup with aria-checked', () => {
    const { container } = render(
      <EditConfigDialog
        open
        team={mkOrch({ defaultEffort: 'high' })}
        onClose={() => undefined}
      />,
    );
    const group = container.querySelector('[role=radiogroup]');
    expect(group).toBeTruthy();
    const checked = container.querySelector('[role=radio][aria-checked=true]');
    expect(checked?.textContent).toBe('high');
  });
});
