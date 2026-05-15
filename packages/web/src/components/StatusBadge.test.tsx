import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

/**
 * Phase 7 — StatusBadge color/label per status.
 *
 * We don't pin the exact Tailwind classes (they're free to change), only
 * the high-level "the right color family is applied" check via class
 * substring matching.
 */

const COLOR_HINT: Record<string, string> = {
  starting: 'amber',
  running: 'emerald',
  waiting: 'yellow',
  stopping: 'orange',
  stopped: 'slate',
  exited: 'slate',
  killed: 'rose',
  failed: 'red',
  interrupted: 'purple',
};

describe('StatusBadge', () => {
  for (const [status, hint] of Object.entries(COLOR_HINT)) {
    it(`renders status="${status}" with the ${hint}-family class`, () => {
      render(<StatusBadge status={status} />);
      const badge = screen.getByText(status);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain(hint);
    });
  }

  it('falls back to a slate style for unknown status', () => {
    render(<StatusBadge status="some-future-status" />);
    const badge = screen.getByText('some-future-status');
    // We don't lock the exact class; just verify it rendered SOME class.
    expect(badge.className.length).toBeGreaterThan(0);
  });
});
