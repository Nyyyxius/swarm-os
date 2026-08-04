// packages/web/src/components/desktop/TopBar.test.tsx
//
// The update signal, and only it. The invariant worth a test: it is driven by
// the SAME `TopBarInfo` object as the version string beside it — one `/info`
// payload, one `setInfo`, one render. A badge fed by its own fetch would paint
// a beat late, which is the flash this design exists to avoid.
//
// Step 20 moved the signal from a standalone UPDATE button onto the MENU
// button (dot) + a conditional item inside the ⌘K panel. The surface changed;
// the invariant did not.

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
  const onOpenRoles = vi.fn();
  const onNewTeam = vi.fn();
  render(
    <TopBar
      teams={[]}
      selectedTeamId={null}
      totalAgents={0}
      info={info}
      onSelectTeam={vi.fn()}
      onNewTeam={onNewTeam}
      onOpenRoles={onOpenRoles}
      onOpenPlugins={vi.fn()}
      onOpenIde={vi.fn()}
      onOpenSettings={onOpenSettings}
      onOpenUpdates={onOpenUpdates}
    />,
  );
  return { onOpenUpdates, onOpenSettings, onOpenRoles, onNewTeam };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The instance-label hook GETs /settings on mount; jsdom has no origin for
  // a relative URL, so stub it rather than leave a rejected promise around.
  vi.spyOn(api, 'getInstanceSettings').mockResolvedValue({
    settings: INSTANCE_SETTINGS_DEFAULTS,
  });
});

describe('TopBar — chrome', () => {
  it('ne garde que NEW TEAM et MENU — les 9 destinations sont dans le panneau', () => {
    renderBar(BASE);
    expect(screen.getByRole('button', { name: /NEW TEAM/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MENU' })).toBeInTheDocument();
    // Les anciens boutons de destination n'existent plus dans la barre.
    expect(screen.queryByRole('button', { name: 'ROLES' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PLUGINS' })).toBeNull();
  });

  it('le panneau reste fermé tant que MENU n’est pas cliqué', () => {
    renderBar(BASE);
    const menu = screen.getByRole('button', { name: 'MENU' });
    expect(screen.queryByRole('dialog', { name: 'command launcher' })).toBeNull();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menu);
    expect(screen.getByRole('dialog', { name: 'command launcher' })).toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-expanded', 'true');
  });

  it('la barre ne porte que deux actions — un 3ᵉ bouton doit faire échouer ce test', () => {
    renderBar(BASE);
    // Compter plutôt que nommer : une assertion par label raterait la
    // réapparition d'un bouton sous un autre nom.
    expect(document.querySelectorAll('.topbar-right .tb-action')).toHaveLength(2);
  });

  it('rend le focus à MENU quand le panneau se referme', () => {
    renderBar(BASE);
    const menu = screen.getByRole('button', { name: 'MENU' });
    fireEvent.click(menu);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(menu);
  });

  it('route un item du panneau vers le handler correspondant', () => {
    const { onOpenRoles } = renderBar(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'MENU' }));
    fireEvent.click(screen.getByText('ROLES'));
    expect(onOpenRoles).toHaveBeenCalledTimes(1);
    // Choisir un item referme le panneau.
    expect(screen.queryByRole('dialog', { name: 'command launcher' })).toBeNull();
  });
});

describe('TopBar — update signal', () => {
  it('is absent while /info carries no update (cold server included)', () => {
    renderBar(BASE);
    const menu = screen.getByRole('button', { name: 'MENU' });
    expect(menu.querySelector('.dot.warn')).toBeNull();
  });

  it('paints in the same render as the version string it belongs to', () => {
    renderBar({ ...BASE, updateAvailable: true, updateLatest: '0.6.0' });
    // Both come from one object: asserting them together IS the invariant.
    expect(screen.getByText(/0\.5\.0/)).toBeInTheDocument();
    const menu = screen.getByRole('button', {
      name: 'MENU — update available: version 0.6.0',
    });
    expect(menu.querySelector('.dot.warn')).toBeTruthy();
  });

  it('degrades to a version-less label when /info knows only the boolean', () => {
    renderBar({ ...BASE, updateAvailable: true, updateLatest: null });
    expect(
      screen.getByRole('button', { name: 'MENU — update available' }),
    ).toBeInTheDocument();
  });

  it('expose UPDATE dans le panneau et l’ouvre sur la bonne section', () => {
    const { onOpenUpdates, onOpenSettings } = renderBar({
      ...BASE,
      updateAvailable: true,
      updateLatest: '0.6.0',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'MENU — update available: version 0.6.0' }),
    );
    expect(screen.getByText('v0.6.0 available')).toBeInTheDocument();

    fireEvent.click(screen.getByText('UPDATE'));
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
    // Distinct du cog d'antan : l'item doit atterrir sur la section update.
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('n’expose pas d’item UPDATE quand il n’y a rien à mettre à jour', () => {
    renderBar(BASE);
    fireEvent.click(screen.getByRole('button', { name: 'MENU' }));
    expect(screen.queryByText('UPDATE')).toBeNull();
  });
});
