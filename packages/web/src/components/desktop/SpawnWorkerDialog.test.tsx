// packages/web/src/components/desktop/SpawnWorkerDialog.test.tsx
//
// Phase C — Step 13 : smoke tests for `SpawnWorkerDialog`.
//
// Contract enforced by docs/redesign-desktop/13_spawn-worker-edit-config.md
// §4 + §10 step 8 :
//  - `open={false}` renders nothing.
//  - ORCHESTRATOR-labelled roles are filtered out of the dropdown.
//  - SPAWN button is **always disabled** v1 (gap §4-3), regardless of
//    whether the NAME field is valid.
//  - The disabled button surfaces the `available in v2 …` tooltip.
//  - The `.field-warn` block names the missing endpoint and templates
//    the MCP workaround with the live NAME / ROLE inputs.
//  - Backdrop click, CANCEL, Escape, and the `×` close button all call
//    onClose.
//  - The NAME input auto-uppercases on keystroke (proto v2 parity).
//  - Re-opening the modal resets the form to defaults.

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SpawnWorkerDialog from './SpawnWorkerDialog';
import type { OrchestratorView, RoleView } from '../../api/client';

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
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
    health: 'ok',
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

describe('SpawnWorkerDialog — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open={false}
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when team is null even if open=true', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={null}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the title with the team name when open', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch({ name: 'ATLAS' })}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const title = screen.getByText(/SPAWN WORKER/);
    expect(title.textContent).toMatch(/in ATLAS/);
  });
});

describe('SpawnWorkerDialog — ROLE dropdown', () => {
  it('filters out the ORCHESTRATOR role', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const select = screen.getByLabelText('ROLE') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.label);
    expect(options).toContain('BUILDER');
    expect(options).toContain('RESEARCHER');
    expect(options).not.toContain('ORCHESTRATOR');
  });

  it('pre-selects the first non-ORCHESTRATOR role', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const select = screen.getByLabelText('ROLE') as HTMLSelectElement;
    expect(select.value).toBe('r-builder');
  });

  it('shows the empty-state option when no worker roles exist', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={[mkRole({ id: 'r-orch', label: 'ORCHESTRATOR' })]}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/no worker roles available/i)).toBeInTheDocument();
  });
});

describe('SpawnWorkerDialog — NAME input', () => {
  it('auto-uppercases keystrokes', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const input = screen.getByLabelText('NAME') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'probe-04' } });
    expect(input.value).toBe('PROBE-04');
  });
});

describe('SpawnWorkerDialog — SPAWN button is always disabled v1', () => {
  it('SPAWN button is disabled when NAME is empty', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const btn = screen.getByRole('button', { name: /SPAWN/ });
    expect(btn).toBeDisabled();
  });

  it('SPAWN button remains disabled even when NAME is valid', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'PROBE-04' } });
    const btn = screen.getByRole('button', { name: /SPAWN/ });
    expect(btn).toBeDisabled();
  });

  it('SPAWN button carries the "available in v2" tooltip', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const btn = screen.getByRole('button', { name: /SPAWN/ });
    expect(btn).toHaveAttribute('title', expect.stringMatching(/available in v2/i));
    expect(btn).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('SpawnWorkerDialog — gap §4-3 disclosure', () => {
  it('renders the field-warn block with the missing endpoint name', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const warn = container.querySelector('.field-warn');
    expect(warn).toBeTruthy();
    expect(warn?.textContent ?? '').toMatch(/POST \/orchestrators\/:id\/workers/);
  });

  it('reflects the live NAME input in the MCP template', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'PROBE-04' } });
    const warn = container.querySelector('.field-warn');
    expect(warn?.textContent ?? '').toMatch(/name="PROBE-04"/);
  });

  it('falls back to the default PROBE-04 in the template when NAME is empty', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const warn = container.querySelector('.field-warn');
    expect(warn?.textContent ?? '').toMatch(/name="PROBE-04"/);
  });
});

describe('SpawnWorkerDialog — field-help inheritance line', () => {
  it('shows model / effort / perm inherited from the team', () => {
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch({
          name: 'NOMAD',
          defaultModel: 'claude-opus-4-7',
          defaultEffort: 'high',
          defaultPermissionMode: 'bypassPermissions',
        })}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const help = container.querySelector('.field-help');
    const text = help?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    // Model gets the `claude-` prefix stripped.
    expect(text).toMatch(/MODEL opus-4-7/);
    expect(text).toMatch(/EFFORT high/);
    expect(text).toMatch(/PERM bypassPermissions/);
    expect(text).toMatch(/from NOMAD/);
  });
});

describe('SpawnWorkerDialog — close interactions', () => {
  it('CANCEL button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={onClose}
      />,
    );
    const backdrop = container.querySelector('.modal-backdrop')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click inside the modal does NOT call onClose (stopPropagation)', () => {
    const onClose = vi.fn();
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('NAME'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={onClose}
      />,
    );
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('× close button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SpawnWorkerDialog — reset on re-open', () => {
  it('clears NAME, OVERRIDE and resets ROLE when the modal is re-opened', () => {
    const { rerender } = render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('NAME'), { target: { value: 'X' } });
    expect((screen.getByLabelText('NAME') as HTMLInputElement).value).toBe('X');

    // Close
    rerender(
      <SpawnWorkerDialog
        open={false}
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    // Re-open
    rerender(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    expect((screen.getByLabelText('NAME') as HTMLInputElement).value).toBe('');
  });
});

describe('SpawnWorkerDialog — accessibility', () => {
  it('exposes role=dialog, aria-modal=true and aria-labelledby', () => {
    render(
      <SpawnWorkerDialog
        open
        team={mkOrch()}
        roles={DEFAULT_ROLES}
        onClose={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'spawn-worker-title');
    expect(document.getElementById('spawn-worker-title')).toBeInTheDocument();
  });
});
