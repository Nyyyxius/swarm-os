// Step 6 (Phase B.6) — tests for the additive callback subscription
// added to `useEvents` for mailbox.message + session.created frames.
//
// We stub `WebSocket` globally and the `api.getEventsTicket` HTTP call so
// the hook can complete its connect cycle without a real server. The
// existing waiting-toast path is also covered to guarantee the patch
// hasn't broken it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useEvents } from './useEvents';
import { api } from '../api/client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readyState = 0;
  CLOSED = 3;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Schedule open() on the next tick to mimic the real WS handshake.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }
  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
  send() { /* noop */ }
  emit(payload: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.spyOn(api, 'getEventsTicket').mockResolvedValue({
    ticket: 'tkt', ttlMs: 10_000, kind: 'events',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function waitForSocket(): Promise<FakeWebSocket> {
  await waitFor(() => {
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
  });
  const ws = FakeWebSocket.instances[0]!;
  await waitFor(() => {
    expect(ws.readyState).toBe(1);
  });
  return ws;
}

describe('useEvents — Step 6 callback subscriptions', () => {
  it('fires onMailboxMessage on a well-formed mailbox.message frame', async () => {
    const onMailboxMessage = vi.fn();
    renderHook(() => useEvents({ onMailboxMessage }));
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'mailbox.message',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's1',
        payload: {
          from: 'human',
          to: 's1',
          fromOrchestratorId: 'o2',
        },
      });
    });

    await waitFor(() => {
      expect(onMailboxMessage).toHaveBeenCalledTimes(1);
    });
    expect(onMailboxMessage).toHaveBeenCalledWith({
      kind: 'mailbox.message',
      ts: '2026-05-22T10:00:00.000Z',
      orchestratorId: 'o1',
      sessionId: 's1',
      from: 'human',
      to: 's1',
      fromOrchestratorId: 'o2',
      fromOrchestratorName: undefined,
      fromSessionName: undefined,
    });
  });

  it('does NOT fire onMailboxMessage when payload is missing from/to', async () => {
    const onMailboxMessage = vi.fn();
    renderHook(() => useEvents({ onMailboxMessage }));
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'mailbox.message',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's1',
        payload: { from: 'human' }, // missing `to`
      });
    });
    // Give the next microtask a chance to schedule any spurious call.
    await Promise.resolve();
    expect(onMailboxMessage).not.toHaveBeenCalled();
  });

  it('fires onSessionCreated when session.created arrives', async () => {
    const onSessionCreated = vi.fn();
    renderHook(() => useEvents({ onSessionCreated }));
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'session.created',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 'newbie',
      });
    });

    await waitFor(() => {
      expect(onSessionCreated).toHaveBeenCalledTimes(1);
    });
    expect(onSessionCreated).toHaveBeenCalledWith({
      kind: 'session.created',
      ts: '2026-05-22T10:00:00.000Z',
      orchestratorId: 'o1',
      sessionId: 'newbie',
    });
  });

  it('still surfaces a waiting toast on session.status_changed (regression)', async () => {
    const { result } = renderHook(() => useEvents());
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'session.status_changed',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-wait',
        payload: { status: 'waiting', reason: 'needs human input' },
      });
    });

    await waitFor(() => {
      expect(result.current.waiting).toHaveLength(1);
    });
    expect(result.current.waiting[0]).toMatchObject({
      id: 's-wait',
      reason: 'needs human input',
    });
  });

  it('surfaces a pending approval on approval.requested, keyed by approvalId', async () => {
    const onApprovalRequested = vi.fn();
    const { result } = renderHook(() => useEvents({ onApprovalRequested }));
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: {
          approvalId: 'appr-1',
          category: 'permission',
          requestedSummary: 'Claude wants to run Bash',
          status: 'pending',
        },
      });
    });

    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(1);
    });
    expect(result.current.approvals[0]).toMatchObject({
      id: 'appr-1',
      sessionId: 's-appr',
      orchestratorId: 'o1',
      category: 'permission',
      requestedSummary: 'Claude wants to run Bash',
    });
    expect(onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(onApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval.requested', approvalId: 'appr-1' }),
    );
  });

  it('removes the pending approval when approval.resolved arrives for it', async () => {
    const onApprovalResolved = vi.fn();
    const { result } = renderHook(() => useEvents({ onApprovalResolved }));
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { approvalId: 'appr-2', category: 'permission', status: 'pending' },
      });
    });
    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(1);
    });

    act(() => {
      ws.emit({
        kind: 'approval.resolved',
        ts: '2026-05-22T10:00:05.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { approvalId: 'appr-2', status: 'approved', decision: 'approved', by: 'web' },
      });
    });

    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(0);
    });
    expect(onApprovalResolved).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval.resolved', approvalId: 'appr-2', status: 'approved' }),
    );
  });

  it('dedupes repeated approval.requested for the same approvalId (refresh, not stack)', async () => {
    const { result } = renderHook(() => useEvents());
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { approvalId: 'dup', status: 'pending' },
      });
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:02.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { approvalId: 'dup', status: 'pending' },
      });
    });

    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(1);
    });
    expect(result.current.approvals[0]?.ts).toBe('2026-05-22T10:00:02.000Z');
  });

  it('dismissApproval drops the toast locally without a resolved frame', async () => {
    const { result } = renderHook(() => useEvents());
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { approvalId: 'appr-3', status: 'pending' },
      });
    });
    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(1);
    });

    act(() => {
      result.current.dismissApproval('appr-3');
    });
    await waitFor(() => {
      expect(result.current.approvals).toHaveLength(0);
    });
  });

  it('ignores an approval frame with no approvalId', async () => {
    const { result } = renderHook(() => useEvents());
    const ws = await waitForSocket();

    act(() => {
      ws.emit({
        kind: 'approval.requested',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's-appr',
        payload: { category: 'permission' }, // no approvalId
      });
    });
    await Promise.resolve();
    expect(result.current.approvals).toHaveLength(0);
  });

  it('keeps the WS open when only the callbacks change (no tear-down)', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useEvents({ onMailboxMessage: cb }),
      { initialProps: { cb: cb1 } },
    );
    const ws = await waitForSocket();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Swap the callback prop — must NOT open a second socket.
    rerender({ cb: cb2 });
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The new callback should be the one invoked on the next frame.
    act(() => {
      ws.emit({
        kind: 'mailbox.message',
        ts: '2026-05-22T10:00:00.000Z',
        orchestratorId: 'o1',
        sessionId: 's1',
        payload: { from: 'human', to: 's1' },
      });
    });
    await waitFor(() => {
      expect(cb2).toHaveBeenCalledTimes(1);
    });
    expect(cb1).not.toHaveBeenCalled();
  });
});
