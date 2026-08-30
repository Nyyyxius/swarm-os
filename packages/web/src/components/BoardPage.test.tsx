// Lot 16 — cost per card on the kanban (docs/monitoring-agents.md).
//
// The interesting half of this feature is what it does NOT render. Cost
// attribution is honest-or-absent server-side (NULL when the assignee changed
// mid-card, when the session has no counters, on any board written before the
// column existed), so the overwhelming majority of cards will never carry an
// amount. A placeholder on each of them would turn a board into a wall of
// em-dashes that says nothing except "this feature is new" — hence: an amount
// when there is one, nothing at all otherwise.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BoardPage } from './BoardPage';
import type { BoardCard } from '../api/client';

const hoisted = vi.hoisted(() => ({
  cards: [] as unknown[],
  listBoard: vi.fn(),
  listBoardTeams: vi.fn(),
}));

vi.mock('../controller/SwarmController', () => ({
  useSwarmController: () => ({
    boardRev: 0,
    orchestrators: [{ id: 'o1', name: 'ATLAS' }],
  }),
}));

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      listBoard: hoisted.listBoard,
      listBoardTeams: hoisted.listBoardTeams,
    },
  };
});

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'c1',
    orchestratorId: 'o1',
    title: 'Wire the exporter',
    body: '',
    status: 'done',
    assigneeSessionId: 'sess-abcdef123456',
    priority: 2,
    labels: [],
    orderKey: 'a',
    createdBy: 'lead-1',
    createdAt: 1,
    updatedAt: 2,
    version: 1,
    closedAt: null,
    orphanedAt: null,
    autoCreated: false,
    hiddenAt: null,
    ...over,
  };
}

const renderBoard = async () => {
  const view = render(<BoardPage open onClose={() => undefined} />);
  await screen.findByText('Wire the exporter');
  return view;
};

beforeEach(() => {
  hoisted.listBoardTeams.mockReset();
  hoisted.listBoardTeams.mockResolvedValue({
    teams: [{ orchestratorId: 'o1', total: 1, open: 0 }],
  });
  hoisted.listBoard.mockReset();
  hoisted.listBoard.mockImplementation(async () => ({ cards: hoisted.cards }));
});

describe('BOARD · cost per card (Lot 16)', () => {
  it('prints the amount beside the assignee when the server attributed one', async () => {
    hoisted.cards = [card({ costUsd: 0.42 })];
    const { container } = await renderBoard();
    const cost = await waitFor(() => {
      const el = container.querySelector('.board-card-cost');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(cost.textContent).toBe('$0.42');
    expect(cost.getAttribute('title'))
      .toBe('estimated cost while this card was in progress');
    // Same row as the assignee — one footer line, not a third stacked line.
    const foot = container.querySelector('.board-card-foot') as HTMLElement;
    expect(foot.querySelector('.board-card-assignee')?.textContent).toBe('sess-abc…');
    expect(foot.contains(cost)).toBe(true);
  });

  it('formats a four-figure amount with a thousands separator', async () => {
    hoisted.cards = [card({ costUsd: 1234.5 })];
    const { container } = await renderBoard();
    await waitFor(() =>
      expect(container.querySelector('.board-card-cost')?.textContent).toBe('$1,234.50'),
    );
  });

  it('renders NOTHING — not an em-dash — when the cost is null', async () => {
    hoisted.cards = [card({ costUsd: null })];
    const { container } = await renderBoard();
    expect(container.querySelector('.board-card-cost')).toBeNull();
    expect(container.querySelector('.board-card')?.textContent).not.toContain('—');
  });

  it('renders nothing on a board from a server predating the field', async () => {
    // No `costUsd` key at all — the wire shape of an older backend.
    hoisted.cards = [card()];
    const { container } = await renderBoard();
    expect(container.querySelector('.board-card-cost')).toBeNull();
    // The assignee it would have sat beside is untouched.
    expect(container.querySelector('.board-card-assignee')?.textContent).toBe('sess-abc…');
  });

  it('still right-aligns the amount on a card nobody is assigned to', async () => {
    hoisted.cards = [card({ assigneeSessionId: null, costUsd: 3 })];
    const { container } = await renderBoard();
    await waitFor(() =>
      expect(container.querySelector('.board-card-cost')?.textContent).toBe('$3.00'),
    );
    expect(container.querySelector('.board-card-assignee')).toBeNull();
    // The footer still exists (it is what carries the amount) — the layout
    // pushes the lone amount right with `margin-left: auto`, not with a
    // placeholder cell.
    expect(container.querySelector('.board-card-foot')).toBeTruthy();
  });

  it('drops the footer entirely when there is neither assignee nor cost', async () => {
    hoisted.cards = [card({ assigneeSessionId: null, costUsd: null })];
    const { container } = await renderBoard();
    expect(container.querySelector('.board-card-foot')).toBeNull();
  });

  it('ignores a negative amount from a drifting backend', async () => {
    // A negative bill is a bug upstream; rendering it would hide it behind a
    // plausible-looking figure.
    hoisted.cards = [card({ costUsd: -3 })];
    const { container } = await renderBoard();
    expect(container.querySelector('.board-card-cost')).toBeNull();
  });
});
