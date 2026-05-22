import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

/**
 * S3 — StatusBadge tests.
 *
 * Validates that the badge applies the right visual bucket (via the
 * `data-visual` attribute we expose for testing) and pulses only for
 * `waiting`. We don't pin exact Tailwind class names — just the colour
 * family — so the design system can evolve without breaking these tests.
 */

interface Case {
  status: string;
  visual: string;
  label: string;
  pulse: boolean;
  colorHint: string;
}

const CASES: Case[] = [
  // Sessions.
  { status: 'starting', visual: 'idle', label: 'STARTING', pulse: false, colorHint: 'slate' },
  { status: 'running', visual: 'running', label: 'RUNNING', pulse: false, colorHint: 'emerald' },
  { status: 'waiting', visual: 'warn', label: 'WAITING', pulse: true, colorHint: 'amber' },
  { status: 'paused', visual: 'warn', label: 'PAUSED', pulse: false, colorHint: 'amber' },
  { status: 'exited', visual: 'stopped', label: 'EXITED', pulse: false, colorHint: 'slate' },
  { status: 'killed', visual: 'stopped', label: 'KILLED', pulse: false, colorHint: 'slate' },
  {
    status: 'interrupted',
    visual: 'stopped',
    label: 'INTERRUPTED',
    pulse: false,
    colorHint: 'slate',
  },
  { status: 'failed', visual: 'bad', label: 'FAILED', pulse: false, colorHint: 'red' },
  // Orchestrator-only.
  { status: 'stopping', visual: 'idle', label: 'STOPPING', pulse: false, colorHint: 'slate' },
  { status: 'stopped', visual: 'stopped', label: 'STOPPED', pulse: false, colorHint: 'slate' },
];

describe('StatusBadge', () => {
  for (const c of CASES) {
    it(`status="${c.status}" → label=${c.label}, visual=${c.visual}, pulse=${c.pulse}`, () => {
      render(<StatusBadge status={c.status} />);
      const badge = screen.getByText(c.label);
      expect(badge).toBeInTheDocument();
      expect(badge.getAttribute('data-visual')).toBe(c.visual);
      if (c.pulse) {
        expect(badge.className).toContain('status-pulse');
        expect(badge.getAttribute('data-pulse')).toBe('true');
      } else {
        expect(badge.className).not.toContain('status-pulse');
        expect(badge.getAttribute('data-pulse')).toBeNull();
      }
      expect(badge.className).toContain(c.colorHint);
    });
  }

  it('waiting badge gets the pulsation class', () => {
    render(<StatusBadge status="waiting" />);
    const badge = screen.getByText('WAITING');
    expect(badge.className).toContain('status-pulse');
  });

  it('failed badge does NOT pulse', () => {
    render(<StatusBadge status="failed" />);
    const badge = screen.getByText('FAILED');
    expect(badge.className).not.toContain('status-pulse');
    expect(badge.className).toContain('red');
  });

  it('killed and interrupted share the slate family but have distinct labels & tooltips', () => {
    const { unmount } = render(<StatusBadge status="killed" />);
    const killed = screen.getByText('KILLED');
    expect(killed.className).toContain('slate');
    expect(killed.getAttribute('title')).toBeTruthy();
    const killedTooltip = killed.getAttribute('title');
    unmount();

    render(<StatusBadge status="interrupted" />);
    const interrupted = screen.getByText('INTERRUPTED');
    expect(interrupted.className).toContain('slate');
    expect(interrupted.getAttribute('title')).toBeTruthy();
    expect(interrupted.getAttribute('title')).not.toBe(killedTooltip);
  });

  it('falls back gracefully for unknown status', () => {
    render(<StatusBadge status="some-future-status" />);
    const badge = screen.getByText('SOME-FUTURE-STATUS');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('data-visual')).toBe('idle');
  });
});

/**
 * S6 — running → idle transition. `lastActivityAt` is the only prop that
 * unlocks the override; once it crosses 30 s the badge must downgrade
 * without any external state change.
 */
describe('StatusBadge — idle override (S6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows RUNNING when lastActivityAt is fresh', () => {
    const fresh = new Date(Date.now() - 2_000).toISOString();
    render(<StatusBadge status="running" lastActivityAt={fresh} />);
    const badge = screen.getByText('RUNNING');
    expect(badge.getAttribute('data-visual')).toBe('running');
  });

  it('shows IDLE immediately when lastActivityAt is already stale on mount', () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    render(<StatusBadge status="running" lastActivityAt={stale} />);
    const badge = screen.getByText('IDLE');
    expect(badge.getAttribute('data-visual')).toBe('idle');
    expect(badge.className).not.toContain('status-pulse');
  });

  it('transitions running → idle after the 30 s threshold (fake timers)', () => {
    vi.useFakeTimers();
    // Pin "now" so the ISO captured below is also frozen.
    const t0 = new Date('2025-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const justStarted = new Date(t0 - 1_000).toISOString();
    render(<StatusBadge status="running" lastActivityAt={justStarted} />);
    expect(screen.getByText('RUNNING')).toBeInTheDocument();

    // Advance past the 30 s threshold. `useNow` ticks every 5 s.
    act(() => {
      vi.advanceTimersByTime(35_000);
    });

    expect(screen.queryByText('RUNNING')).toBeNull();
    const idle = screen.getByText('IDLE');
    expect(idle.getAttribute('data-visual')).toBe('idle');
    expect(idle.getAttribute('title')).toMatch(/no\s+pty\s+output\s+for/i);
  });

  it('does not override waiting even with a very stale lastActivityAt', () => {
    const ancient = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<StatusBadge status="waiting" lastActivityAt={ancient} />);
    const badge = screen.getByText('WAITING');
    expect(badge.getAttribute('data-visual')).toBe('warn');
    expect(badge.className).toContain('status-pulse');
  });

  it('does not override paused (S5) even with a very stale lastActivityAt', () => {
    const ancient = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<StatusBadge status="paused" lastActivityAt={ancient} />);
    const badge = screen.getByText('PAUSED');
    expect(badge.getAttribute('data-visual')).toBe('warn');
  });

  it('ignores lastActivityAt entirely for orchestrator-only statuses', () => {
    const ancient = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<StatusBadge status="stopping" lastActivityAt={ancient} />);
    // `stopping` is an orchestrator status, never overridden by idle.
    expect(screen.getByText('STOPPING').getAttribute('data-visual')).toBe(
      'idle',
    );
  });

  it('garbage lastActivityAt leaves the badge as RUNNING', () => {
    render(<StatusBadge status="running" lastActivityAt="not-iso" />);
    const badge = screen.getByText('RUNNING');
    expect(badge.getAttribute('data-visual')).toBe('running');
  });
});
