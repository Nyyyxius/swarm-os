// packages/web/src/components/desktop/TopBar.test.tsx
//
// The update badge, and only it. The invariant worth a test: the badge is
// driven by the SAME `TopBarInfo` object as the version string beside it —
// one `/info` payload, one `setInfo`, one render. A badge fed by its own
// fetch would paint a beat late, which is the flash this design exists to
// avoid.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TopBar, { type TopBarInfo } from './TopBar';
import { api, INSTANCE_SETTINGS_DEFAULTS } from '../../api/client';

const BASE: TopBarInfo = {
  projectName: 'swarm-os',
  version: '0.5.0',
  startedAt: new Date().toISOString(),
};

function renderBar(info: TopBarInfo) {
  const onOpenUpdates = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <TopBar
      teams={[]}
      selectedTeamId={null}
      totalAgents={0}
      info={info}
      onSelectTeam={vi.fn()}
      onNewTeam={vi.fn()}
      onOpenRoles={vi.fn()}
      onOpenPlugins={vi.fn()}
      onOpenIde={vi.fn()}
      onOpenSettings={onOpenSettings}
      onOpenUpdates={onOpenUpdates}
    />,
  );
  return { onOpenUpdates, onOpenSettings };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The instance-label hook GETs /settings on mount; jsdom has no origin for
  // a relative URL, so stub it rather than leave a rejected promise around.
  vi.spyOn(api, 'getInstanceSettings').mockResolvedValue({
    settings: INSTANCE_SETTINGS_DEFAULTS,
  });
});

describe('TopBar — update badge', () => {
  it('is absent while /info carries no update (cold server included)', () => {
    renderBar(BASE);
    expect(screen.queryByRole('button', { name: /update available/i })).toBeNull();
  });

  it('paints in the same render as the version string it belongs to', () => {
    renderBar({ ...BASE, updateAvailable: true, updateLatest: '0.6.0' });
    // Both come from one object: asserting them together IS the invariant.
    expect(screen.getByText(/0\.5\.0/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Update available: version 0.6.0' }),
    ).toBeInTheDocument();
  });

  it('carries the `.dot` indicator and opens SETTINGS on the update section', () => {
    const { onOpenUpdates, onOpenSettings } = renderBar({
      ...BASE,
      updateAvailable: true,
      updateLatest: '0.6.0',
    });
    const badge = screen.getByRole('button', { name: /update available/i });
    expect(badge.className).toContain('tb-action');
    expect(badge.querySelector('.dot')).toBeTruthy();

    fireEvent.click(badge);
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
    // Distinct from the cog: the badge must land on the update section.
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('degrades to a version-less label when /info knows only the boolean', () => {
    renderBar({ ...BASE, updateAvailable: true, updateLatest: null });
    expect(screen.getByRole('button', { name: 'Update available' })).toBeInTheDocument();
  });
});
