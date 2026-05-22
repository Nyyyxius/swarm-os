import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewOrchestratorDialog } from './NewOrchestratorDialog';

/**
 * Phase C — Step 9 — form-level checks for the v2 layout.
 *
 * Selectors target the v2 class structure (`.modal`, `.field*`, `role=alert`,
 * `CREATE TEAM →` button). The form defaults to empty `name` / `prompt` /
 * `preamble` and `cwd='/'`, so each "filled" test must populate the inputs
 * explicitly. The submitted name is forced to UPPERCASE per spec §3 / §7.
 */

function makeOnCreate() {
  return vi.fn().mockResolvedValue({
    id: 'orch-1',
    name: 'SMOKE',
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
    expect(screen.getByText(/NEW ORCHESTRATOR/i)).toBeInTheDocument();
    // The amber bypassPermissions warning should be present by default
    // (defaults to bypassPermissions per plan §3 / §17). We target the
    // `role="alert"` live region so the text wording can evolve freely.
    expect(screen.getByRole('alert')).toHaveTextContent(/bypassPermissions/i);
  });

  it('disables the Create button when cwd is cleared', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    // cwd defaults to '/' which is valid; we have to empty it to assert
    // the disabled state.
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    fireEvent.change(cwdInput, { target: { value: '' } });
    const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables Create when all required fields are filled', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i);
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    const promptInput = screen.getByPlaceholderText(/Ship the new swarm\.bin/i);
    fireEvent.change(nameInput, { target: { value: 'smoke' } });
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    fireEvent.change(promptInput, { target: { value: 'say hi' } });
    const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });
    expect(createBtn).not.toBeDisabled();
  });

  it('calls onCreate with the form values when Create is clicked', async () => {
    const onCreate = makeOnCreate();
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={onCreate} />,
    );
    const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i);
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    const promptInput = screen.getByPlaceholderText(/Ship the new swarm\.bin/i);
    fireEvent.change(nameInput, { target: { value: 'smoke' } });
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    fireEvent.change(promptInput, { target: { value: 'say hi' } });
    fireEvent.click(screen.getByRole('button', { name: /CREATE TEAM/i }));
    // Wait one microtask for the async submit to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const call = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    // submit() applies .toUpperCase() (spec §3 — parity with team-pills).
    expect(call.name).toBe('SMOKE');
    expect((call.lead as { cwd: string }).cwd).toBe('/workspace/x');
    expect((call.defaults as { permissionMode: string }).permissionMode).toBe('bypassPermissions');
  });
});
