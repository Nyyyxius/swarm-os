// packages/web/src/components/desktop/CommandLauncher.test.tsx
//
// Le panneau ⌘K remplace 9 boutons de topbar : ce qui doit être verrouillé,
// c'est qu'aucune destination ne devienne inatteignable — au clavier comme à
// la souris — et que le raccourci global ne vole pas Ctrl+K aux terminaux
// agents (xterm), où c'est un kill-line readline vivant.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import CommandLauncher, {
  LAUNCHER_GROUPS,
  type LauncherActionId,
} from './CommandLauncher';

function renderLauncher(props: Partial<ComponentProps<typeof CommandLauncher>> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(
    <CommandLauncher
      open
      onOpen={onOpen}
      onClose={onClose}
      onPick={onPick}
      {...props}
    />,
  );
  return { onOpen, onClose, onPick };
}

function search() {
  return screen.getByPlaceholderText('jump to…');
}

describe('CommandLauncher — filtrage', () => {
  it('ne garde que les items dont le label ou la desc contient la saisie', () => {
    renderLauncher();
    expect(screen.getByText('ROLES')).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: 'boa' } });
    expect(screen.getByText('BOARD')).toBeInTheDocument();
    expect(screen.queryByText('ROLES')).toBeNull();
  });

  it('affiche « no match » plutôt qu’une liste vide silencieuse', () => {
    renderLauncher();
    fireEvent.change(search(), { target: { value: 'zzzzz' } });
    expect(screen.getByText('no match')).toBeInTheDocument();
  });
});

describe('CommandLauncher — clavier', () => {
  it('le curseur traverse les frontières de groupe (↓↓ puis ↵ → MEMORY)', () => {
    // Ordre plat sans UPDATE : new-team, roles, memory, … — le 3e item est
    // dans un AUTRE groupe que le 1er, ce que ce cas verrouille.
    const { onPick } = renderLauncher();
    const input = search();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith<[LauncherActionId]>('memory');
  });

  it('↑ ne descend jamais sous zéro', () => {
    const { onPick } = renderLauncher();
    const input = search();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith<[LauncherActionId]>('new-team');
  });

  it('↵ sur une liste vide ne déclenche rien (garde `flat[cursor]`)', () => {
    const { onPick } = renderLauncher();
    fireEvent.change(search(), { target: { value: 'zzzzz' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Escape ferme', () => {
    const { onClose } = renderLauncher();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('⌘K ouvre depuis l’état fermé', () => {
    const { onOpen } = renderLauncher({ open: false });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('⌘K referme quand le panneau est déjà ouvert', () => {
    const { onClose } = renderLauncher({ open: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CommandLauncher — arbitrage des couches', () => {
  it('sort du contexte d’empilement de `.app` (portail vers body)', () => {
    // LA régression à ne jamais réintroduire : `.app` est en position fixed,
    // donc contexte d'empilement de niveau 0. Les overlays de route
    // (`.roles-overlay`, z-index 60) sont rendus hors de `.app` et le
    // recouvrent entièrement — un panneau monté DANS `.app` disparaît sous
    // eux quel que soit son z-index. Rendu ici dans un `.app` pour reproduire
    // la hiérarchie réelle.
    const app = document.createElement('div');
    app.className = 'app';
    document.body.appendChild(app);
    try {
      render(
        <CommandLauncher open onOpen={vi.fn()} onClose={vi.fn()} onPick={vi.fn()} />,
        { container: app },
      );
      expect(document.querySelector('.launcher')).not.toBeNull();
      expect(app.querySelector('.launcher')).toBeNull();
      expect(app.querySelector('.launcher-backdrop')).toBeNull();
    } finally {
      document.body.removeChild(app);
    }
  });

  it('⌘K reste inerte tant qu’une modale est ouverte', () => {
    // Le panneau plafonne à z-index 91, les modales sont à 100 : l'ouvrir
    // sous l'une d'elles donnerait un panneau invisible qui vole le focus.
    const { onOpen } = renderLauncher({ open: false, blocked: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('`blocked` n’empêche pas de refermer un panneau déjà ouvert', () => {
    const { onClose } = renderLauncher({ open: true, blocked: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape ouvert ne traverse pas jusqu’aux handlers des couches du dessous', () => {
    // Huit composants posent un Escape sur `window` en phase de bulle. Le
    // panneau écoute en capture et consomme l'événement : sans ça, un seul
    // Escape refermerait le panneau ET le drawer/overlay en dessous.
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    try {
      const { onClose } = renderLauncher({ open: true });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(underneath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', underneath);
    }
  });

  it('Escape panneau fermé laisse passer l’événement', () => {
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    try {
      renderLauncher({ open: false });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(underneath).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', underneath);
    }
  });
});

describe('CommandLauncher — garde Ctrl+K', () => {
  it('ne vole pas Ctrl+K à un terminal agent (xterm)', () => {
    const term = document.createElement('div');
    term.className = 'xterm';
    const inner = document.createElement('div');
    term.appendChild(inner);
    document.body.appendChild(term);
    try {
      const { onOpen } = renderLauncher({ open: false });
      fireEvent.keyDown(inner, { key: 'k', ctrlKey: true });
      expect(onOpen).not.toHaveBeenCalled();

      // Contrôle : hors terminal, le même raccourci ouvre bien.
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(term);
    }
  });

  it('⌘K reste inconditionnel — Ctrl+K n’est pas une convention macOS', () => {
    const term = document.createElement('div');
    term.className = 'xterm';
    document.body.appendChild(term);
    try {
      const { onOpen } = renderLauncher({ open: false });
      fireEvent.keyDown(term, { key: 'k', metaKey: true });
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(term);
    }
  });
});

describe('CommandLauncher — item UPDATE', () => {
  it('n’affiche aucun compteur chiffré — aucune source honnête à ce jour', () => {
    // Le badge du prototype n'est pas porté : `approvalToasts` repart de zéro
    // à chaque chargement, un compteur nourri par là mentirait.
    renderLauncher();
    expect(document.querySelector('.li-badge')).toBeNull();
  });

  it('n’affiche UPDATE que lorsqu’une release existe', () => {
    renderLauncher();
    expect(screen.queryByText('UPDATE')).toBeNull();
  });

  it('place UPDATE en tête du groupe SYSTEM, version incluse', () => {
    const { onPick } = renderLauncher({ updateAvailable: true, updateLatest: '0.6.0' });
    expect(screen.getByText('v0.6.0 available')).toBeInTheDocument();

    const items = Array.from(document.querySelectorAll('.launcher-item .li-label'))
      .map((n) => n.textContent);
    expect(items.indexOf('UPDATE')).toBe(items.indexOf('SETTINGS') - 1);

    fireEvent.click(screen.getByText('UPDATE'));
    expect(onPick).toHaveBeenCalledWith<[LauncherActionId]>('update');
  });

  it('dégrade la desc quand /info ne connaît que le booléen', () => {
    renderLauncher({ updateAvailable: true, updateLatest: null });
    expect(screen.getByText('a new version is available')).toBeInTheDocument();
  });
});

describe('CommandLauncher — couverture des destinations', () => {
  it('chaque LauncherActionId est atteignable depuis le panneau', () => {
    // Garde-fou contre un id typé mais jamais rendu : la TopBar route un
    // `switch` exhaustif, il faut que la table le nourrisse réellement.
    const ids: LauncherActionId[] = [
      'new-team', 'roles', 'memory', 'board', 'approvals',
      'code-graph', 'skills', 'plugins', 'ide',
      'update', 'settings', 'appearance',
    ];
    const rendered = new Set<string>([
      ...LAUNCHER_GROUPS.flatMap((g) => g.items.map((i) => i.id)),
      'update', // conditionnel — injecté par `updateAvailable`
    ]);
    for (const id of ids) expect(rendered.has(id)).toBe(true);
    expect(rendered.size).toBe(ids.length);
  });

  it('un clic souris route l’id de l’item', () => {
    const { onPick } = renderLauncher();
    fireEvent.click(screen.getByText('CODE GRAPH'));
    expect(onPick).toHaveBeenCalledWith<[LauncherActionId]>('code-graph');
  });

  it('le clic sur le backdrop ferme', () => {
    const { onClose } = renderLauncher();
    const backdrop = document.querySelector('.launcher-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ne rend rien tant que `open` est faux', () => {
    renderLauncher({ open: false });
    expect(document.querySelector('.launcher')).toBeNull();
  });
});
