import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewOrchestratorDialog } from './NewOrchestratorDialog';

/**
 * Phase 7 — NewOrchestratorDialog basic UX.
 *
 * Form-level checks only. We don't fight xterm or the Vite-served bundle —
 * Phase 6 polish covers the visual layer; this is just a sanity gate.
 */

function makeOnCreate() {
  return vi.fn().mockResolvedValue({
    id: 'orch-1',
    name: 'smoke',
    role: 'test',
    status: 'starting',
    leadSessionId: 'sess-1',
    defaultModel: 'claude-opus-4-7',
    defaultEffort: 'xhigh',
    defaultPermissionMode: 'bypassPermissions',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: new Date().toISOString(),
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
  });
}

describe('NewOrchestratorDialog', () => {
  it('does not render when open=false', () => {
    const { container } = render(
      <NewOrchestratorDialog open={false} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the form when open=true with bypassPermissions default', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    expect(screen.getByText('New orchestrator')).toBeInTheDocument();
    // The amber bypassPermissions warning should be present by default
    // (defaults to bypassPermissions per plan §3 / §17).
    expect(screen.getByText(/bypassPermissions disables/i)).toBeInTheDocument();
  });

  it('disables the Create button when cwd is empty', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    const createBtn = screen.getByRole('button', { name: /Create/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables Create when all required fields are filled', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    const cwdInput = screen.getByPlaceholderText('/mon-projet');
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    const createBtn = screen.getByRole('button', { name: /Create/i });
    expect(createBtn).not.toBeDisabled();
  });

  it('calls onCreate with the form values when Create is clicked', async () => {
    const onCreate = makeOnCreate();
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={onCreate} />,
    );
    const cwdInput = screen.getByPlaceholderText('/mon-projet');
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    // Wait one microtask for the async submit to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const call = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.name).toBe('smoke');
    expect((call.lead as { cwd: string }).cwd).toBe('/workspace/x');
    expect((call.defaults as { permissionMode: string }).permissionMode).toBe('bypassPermissions');
  });
});
