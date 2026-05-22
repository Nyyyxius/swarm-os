// packages/web/src/components/desktop/SettingsDrawer.test.tsx
//
// Phase C — Step 11 : smoke tests for `SettingsDrawer`.
//
// We focus on the contract:
//  - AUTH banners surface for missing/invalid states.
//  - SHOW/HIDE toggles input type.
//  - SAVE/CLEAR call into `api/client.ts` token helpers (the canonical
//    `'swarm-os.token'` key — never `'swarm.token'` from the prototype).
//  - Escape + backdrop close ; inside clicks don't.
//  - ABOUT renders project/version/started/sessions and a HH:MM:SS uptime.
//  - WS pip swaps `.dot.ok`/`.dot.warn` from the `wsConnected` prop.
//  - Auto-focus lands on the token input at mount.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SettingsDrawer, { type SettingsDrawerProps } from './SettingsDrawer';
import type { HealthView, InfoView } from '../../api/client';

function renderDrawer(over: Partial<SettingsDrawerProps> = {}) {
  const onClose = vi.fn();
  const onTokenSaved = vi.fn();
  const onTokenCleared = vi.fn();
  const utils = render(
    <SettingsDrawer
      info={over.info ?? null}
      health={over.health ?? null}
      authState={over.authState ?? 'unknown'}
      wsConnected={over.wsConnected ?? true}
      onClose={over.onClose ?? onClose}
      onTokenSaved={over.onTokenSaved ?? onTokenSaved}
      onTokenCleared={over.onTokenCleared ?? onTokenCleared}
    />,
  );
  return { ...utils, onClose, onTokenSaved, onTokenCleared };
}

const FIXED_INFO: InfoView = {
  project_name: 'swarm-os',
  version: '0.1.0',
  // Use a fixed date in the past — `formatClockShort` reads local hours, so
  // we don't assert on the exact value, only that the cell renders.
  started_at: new Date('2026-05-22T08:05:00Z').toISOString(),
};

const HEALTH_2: HealthView = {
  status: 'ok',
  project_name: 'swarm-os',
  orchestrators_active: 1,
  sessions_active: 2,
  sessions_waiting: 0,
  uptime_seconds: 3600,
};

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* noop */ }
});

describe('SettingsDrawer — AUTH section', () => {
  it('renders the "No token set" warn when authState=missing and token empty', () => {
    renderDrawer({ authState: 'missing' });
    expect(screen.getByText(/No token set/i)).toBeInTheDocument();
    const input = screen.getByLabelText('X-AUTH-TOKEN') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: 'SAVE' })).toBeInTheDocument();
  });

  it('renders the "Token rejected (HTTP 401)" warn when authState=invalid + token present', () => {
    window.localStorage.setItem('swarm-os.token', 'abc');
    renderDrawer({ authState: 'invalid' });
    expect(screen.getByText(/Token rejected/i)).toBeInTheDocument();
  });

  it('does not render any warn banner when authState=ok and token present', () => {
    window.localStorage.setItem('swarm-os.token', 'good-token');
    renderDrawer({ authState: 'ok' });
    expect(screen.queryByText(/No token set/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Token rejected/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CLEAR' })).toBeInTheDocument();
  });

  it('toggles input type=password ↔ text via SHOW/HIDE', () => {
    renderDrawer({ authState: 'ok' });
    const input = screen.getByLabelText('X-AUTH-TOKEN') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show token' }));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(input.type).toBe('password');
  });

  it('SAVE writes to localStorage via setToken and flashes "✓ SAVED"', () => {
    vi.useFakeTimers();
    try {
      const { onTokenSaved } = renderDrawer({ authState: 'missing' });
      const input = screen.getByLabelText('X-AUTH-TOKEN') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'xyz123 ' } }); // trailing space → trimmed
      fireEvent.click(screen.getByRole('button', { name: 'SAVE' }));
      expect(window.localStorage.getItem('swarm-os.token')).toBe('xyz123');
      expect(screen.getByRole('button', { name: '✓ SAVED' })).toBeInTheDocument();
      expect(onTokenSaved).toHaveBeenCalledTimes(1);
      // After 1.5 s the label reverts to "SAVE".
      act(() => { vi.advanceTimersByTime(1_600); });
      expect(screen.getByRole('button', { name: 'SAVE' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CLEAR removes the stored token and fires onTokenCleared', () => {
    window.localStorage.setItem('swarm-os.token', 'old-token');
    const { onTokenCleared } = renderDrawer({ authState: 'ok' });
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR' }));
    expect(window.localStorage.getItem('swarm-os.token')).toBe(null);
    expect(onTokenCleared).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText('X-AUTH-TOKEN') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});

describe('SettingsDrawer — close interactions', () => {
  it('Escape keydown calls onClose', () => {
    const { onClose } = renderDrawer({ authState: 'ok' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Backdrop click calls onClose', () => {
    const { container, onClose } = renderDrawer({ authState: 'ok' });
    const backdrop = container.querySelector('.drawer-backdrop')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Click inside the drawer does NOT call onClose (stopPropagation)', () => {
    const { onClose } = renderDrawer({ authState: 'ok' });
    const input = screen.getByLabelText('X-AUTH-TOKEN');
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SettingsDrawer — ABOUT section', () => {
  it('renders project, version, started, sessions, and a HH:MM:SS uptime', () => {
    renderDrawer({
      info: FIXED_INFO,
      health: HEALTH_2,
      authState: 'ok',
    });
    expect(screen.getByText('swarm-os')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // sessions_active
    // UPTIME cell is rendered with a HH:MM:SS format (digits + colons).
    const uptimeCells = screen.getAllByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(uptimeCells.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to "—" / 0 when info + health are null', () => {
    renderDrawer({ info: null, health: null, authState: 'ok' });
    // Multiple "—" cells (project, version, uptime, started).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('SettingsDrawer — EVENTS section', () => {
  it('renders dot.ok + LIVE when wsConnected=true', () => {
    const { container } = renderDrawer({ wsConnected: true, authState: 'ok' });
    expect(container.querySelector('.dot.ok')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders dot.warn + RECONNECTING… when wsConnected=false', () => {
    const { container } = renderDrawer({ wsConnected: false, authState: 'ok' });
    expect(container.querySelector('.dot.warn')).toBeTruthy();
    expect(screen.getByText(/RECONNECTING/)).toBeInTheDocument();
  });
});

describe('SettingsDrawer — accessibility', () => {
  it('auto-focuses the token input on mount', () => {
    renderDrawer({ authState: 'ok' });
    const input = screen.getByLabelText('X-AUTH-TOKEN');
    expect(document.activeElement).toBe(input);
  });

  it('exposes role=dialog, aria-modal, and labelled by SETTINGS title', () => {
    renderDrawer({ authState: 'ok' });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'settings-drawer-title');
    expect(document.getElementById('settings-drawer-title')?.textContent).toBe('SETTINGS');
  });
});
