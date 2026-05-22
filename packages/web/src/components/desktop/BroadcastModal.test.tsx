// packages/web/src/components/desktop/BroadcastModal.test.tsx
//
// Phase C — Step 12 : smoke tests for `BroadcastModal`.
//
// We focus on the contract documented in
// `docs/redesign-desktop/12_broadcast-modal.md` :
//  - `open={false}` renders nothing.
//  - Active-team filter (`endedAt === null` AND status ∈ {running, starting}).
//  - SEND button disabled when text is empty.
//  - SEND iterates `api.broadcastToOrchestrator(id, text)` once per active
//    team (via `Promise.allSettled`).
//  - Partial-failure recap renders both ok + bad dots and the right
//    summary line.
//  - Zero-active-teams degenerate case disables SEND and shows the help.
//  - Cmd/Ctrl + Enter triggers send (parity with `BroadcastBar`).
//  - Esc closes the modal when idle ; backdrop click closes ; clicks
//    inside the modal don't.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BroadcastModal from './BroadcastModal';
import { api, type OrchestratorView } from '../../api/client';

function mkOrch(p: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'NOMAD',
    role: 'BUILDER',
    roleId: null,
    status: 'running',
    leadSessionId: 's1',
    defaultModel: 'opus',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BroadcastModal — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <BroadcastModal open={false} onClose={() => undefined} orchestrators={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal head + textarea when open=true', () => {
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    expect(screen.getByText('◇ BROADCAST')).toBeInTheDocument();
    expect(screen.getByLabelText('BROADCAST')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /BROADCAST/ })).toBeInTheDocument();
  });
});

describe('BroadcastModal — active-team filter', () => {
  it('counts running + starting teams, excludes stopped / ended', () => {
    const orchs: OrchestratorView[] = [
      mkOrch({ id: 'a', name: 'NOMAD', status: 'running' }),
      mkOrch({ id: 'b', name: 'ATLAS', status: 'starting' }),
      mkOrch({ id: 'c', name: 'BORG', status: 'stopping' }),
      mkOrch({ id: 'd', name: 'DEAD', status: 'stopped', endedAt: '2026-01-02T00:00:00Z' }),
      mkOrch({ id: 'e', name: 'FAIL', status: 'failed', endedAt: '2026-01-02T00:00:00Z' }),
    ];
    const { container } = render(
      <BroadcastModal open onClose={() => undefined} orchestrators={orchs} />,
    );
    // Pre-send help line lists only the actives.
    const help = container.querySelector('.field-help')!;
    const text = help.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toMatch(/2 active leads/);
    expect(text).toMatch(/NOMAD · ATLAS/);
    expect(text).not.toMatch(/BORG/);
    expect(text).not.toMatch(/DEAD/);
  });

  it('renders the singular "lead" form when exactly one active team', () => {
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch({ name: 'SOLO' })]}
      />,
    );
    expect(screen.getByText(/active lead:/)).toBeInTheDocument();
    expect(screen.getByText(/SOLO/)).toBeInTheDocument();
  });

  it('shows the "No active teams" help and disables SEND when nothing active', () => {
    render(<BroadcastModal open onClose={() => undefined} orchestrators={[]} />);
    expect(screen.getByText(/No active teams/i)).toBeInTheDocument();
    const sendBtn = screen.getByRole('button', { name: 'BROADCAST →' });
    expect(sendBtn).toBeDisabled();
  });
});

describe('BroadcastModal — SEND button gating', () => {
  it('disabled when textarea is empty / whitespace-only', () => {
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    const sendBtn = screen.getByRole('button', { name: 'BROADCAST →' });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('BROADCAST'), { target: { value: '   ' } });
    expect(sendBtn).toBeDisabled();
  });

  it('enabled once non-empty text is typed', () => {
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    fireEvent.change(screen.getByLabelText('BROADCAST'), { target: { value: 'hello' } });
    expect(screen.getByRole('button', { name: 'BROADCAST →' })).not.toBeDisabled();
  });
});

describe('BroadcastModal — send pipeline', () => {
  it('calls api.broadcastToOrchestrator once per active team', async () => {
    const spy = vi
      .spyOn(api, 'broadcastToOrchestrator')
      .mockResolvedValue({ delivered_to: ['s1', 's2', 's3'] });
    const orchs = [
      mkOrch({ id: 'a', name: 'NOMAD' }),
      mkOrch({ id: 'b', name: 'ATLAS' }),
    ];
    render(<BroadcastModal open onClose={() => undefined} orchestrators={orchs} />);
    fireEvent.change(screen.getByLabelText('BROADCAST'), {
      target: { value: 'freeze deploys' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'BROADCAST →' }));

    await waitFor(() =>
      expect(screen.getByText(/Reached/)).toBeInTheDocument(),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('a', 'freeze deploys');
    expect(spy).toHaveBeenCalledWith('b', 'freeze deploys');
  });

  it('renders an all-green recap when every call resolves', async () => {
    vi.spyOn(api, 'broadcastToOrchestrator').mockResolvedValue({
      delivered_to: ['s1', 's2'],
    });
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch({ name: 'NOMAD' })]}
      />,
    );
    fireEvent.change(screen.getByLabelText('BROADCAST'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'BROADCAST →' }));

    const recap = await waitFor(() => screen.getByText(/Reached/));
    // The summary line interleaves <b> elements with text, so we match
    // against the collapsed textContent of the recap block instead of
    // relying on getByText's per-node matcher.
    const text = recap.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toMatch(/Reached\s+1\s*\/\s*1\s+team/);
    expect(text).toMatch(/2\s+sessions\s+delivered/);
    // Cancel button label flips to CLOSE after a successful send.
    expect(screen.getByRole('button', { name: 'CLOSE' })).toBeInTheDocument();
  });

  it('renders a mixed recap on partial failure (allSettled)', async () => {
    vi.spyOn(api, 'broadcastToOrchestrator').mockImplementation(async (id) => {
      if (id === 'b') throw new Error('HTTP 401 Unauthorized');
      return { delivered_to: ['s1', 's2'] };
    });
    const orchs = [
      mkOrch({ id: 'a', name: 'NOMAD' }),
      mkOrch({ id: 'b', name: 'ATLAS' }),
    ];
    const { container } = render(
      <BroadcastModal open onClose={() => undefined} orchestrators={orchs} />,
    );
    fireEvent.change(screen.getByLabelText('BROADCAST'), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: 'BROADCAST →' }));

    const recap = await waitFor(() => screen.getByText(/Reached/));
    const text = recap.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toMatch(/Reached\s+1\s*\/\s*2\s+teams/);
    expect(text).toMatch(/1\s+error/);
    expect(container.querySelector('.dot.ok')).toBeTruthy();
    expect(container.querySelector('.dot.bad')).toBeTruthy();
    expect(screen.getByText(/HTTP 401 Unauthorized/)).toBeInTheDocument();
  });

  it('clears the textarea after a send completes', async () => {
    vi.spyOn(api, 'broadcastToOrchestrator').mockResolvedValue({
      delivered_to: ['s1'],
    });
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    const ta = screen.getByLabelText('BROADCAST') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'BROADCAST →' }));
    await waitFor(() => expect(screen.getByText(/Reached/)).toBeInTheDocument());
    expect(ta.value).toBe('');
  });
});

describe('BroadcastModal — keyboard parity', () => {
  it('Cmd/Ctrl + Enter triggers send', async () => {
    const spy = vi
      .spyOn(api, 'broadcastToOrchestrator')
      .mockResolvedValue({ delivered_to: ['s1'] });
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    const ta = screen.getByLabelText('BROADCAST');
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('plain Enter does NOT trigger send', () => {
    const spy = vi
      .spyOn(api, 'broadcastToOrchestrator')
      .mockResolvedValue({ delivered_to: [] });
    render(
      <BroadcastModal
        open
        onClose={() => undefined}
        orchestrators={[mkOrch()]}
      />,
    );
    const ta = screen.getByLabelText('BROADCAST');
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('BroadcastModal — close interactions', () => {
  it('Escape calls onClose when idle', () => {
    const onClose = vi.fn();
    render(
      <BroadcastModal open onClose={onClose} orchestrators={[mkOrch()]} />,
    );
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Backdrop click calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <BroadcastModal open onClose={onClose} orchestrators={[mkOrch()]} />,
    );
    const backdrop = container.querySelector('.modal-backdrop')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Click inside the modal does NOT call onClose (stopPropagation)', () => {
    const onClose = vi.fn();
    render(
      <BroadcastModal open onClose={onClose} orchestrators={[mkOrch()]} />,
    );
    fireEvent.click(screen.getByLabelText('BROADCAST'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('CANCEL button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <BroadcastModal open onClose={onClose} orchestrators={[mkOrch()]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BroadcastModal — accessibility', () => {
  it('exposes role=dialog, aria-modal=true, and aria-labelledby pointing to the title', () => {
    render(
      <BroadcastModal open onClose={() => undefined} orchestrators={[mkOrch()]} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'broadcast-title');
    expect(document.getElementById('broadcast-title')).toBeInTheDocument();
  });

  it('auto-focuses the textarea on mount', () => {
    render(
      <BroadcastModal open onClose={() => undefined} orchestrators={[mkOrch()]} />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('BROADCAST'));
  });
});
