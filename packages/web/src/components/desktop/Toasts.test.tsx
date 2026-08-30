// BUDGET EXCEEDED toast — Lot 14 (docs/monitoring-agents.md).
//
// The toast is the ONLY moment this event is ever surfaced: the server emits
// it once per crossing, and nothing on any page replays it. So what is tested
// is that it says the whole thing (which team, how far past, and whether the
// team is still running) and that both of its buttons do what they say.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Toasts, { type BudgetToast, type WaitingToast } from './Toasts';

function budget(over: Partial<BudgetToast> = {}): BudgetToast {
  return {
    id: 'o1',
    teamId: 'o1',
    teamName: 'ATLAS',
    costUsd: 52.1,
    budgetUsd: 50,
    action: 'pause',
    at: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

function waiting(over: Partial<WaitingToast> = {}): WaitingToast {
  return {
    id: 'w1',
    sessionId: 's1',
    teamId: 'o1',
    teamName: 'ATLAS',
    agentName: 'AGENT-1',
    at: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

function renderToasts(props: Partial<Parameters<typeof Toasts>[0]> = {}) {
  const onBudgetOpen = vi.fn();
  const onBudgetDismiss = vi.fn();
  const utils = render(
    <Toasts
      items={[]}
      onOpen={() => undefined}
      onDismiss={() => undefined}
      onBudgetOpen={onBudgetOpen}
      onBudgetDismiss={onBudgetDismiss}
      {...props}
    />,
  );
  return { ...utils, onBudgetOpen, onBudgetDismiss };
}

describe('Toasts · BUDGET EXCEEDED', () => {
  it('names the team, the overrun and the fact that it was paused', () => {
    const { container } = renderToasts({ budgets: [budget()] });
    const toast = container.querySelector('.toast-budget') as HTMLElement;
    expect(toast).toBeTruthy();
    expect(toast.querySelector('.t-title')?.textContent).toBe('BUDGET EXCEEDED');
    expect(toast.querySelector('.t-id')?.textContent).toBe('ATLAS');
    expect(toast.querySelector('.t-budget-figure')?.textContent)
      .toBe('$52.10 / $50.00 · TEAM PAUSED');
  });

  it('says NOTIFY — not PAUSED — when the team is still running', () => {
    const { container } = renderToasts({ budgets: [budget({ action: 'notify' })] });
    expect(container.querySelector('.t-budget-figure')?.textContent)
      .toBe('$52.10 / $50.00 · NOTIFY');
  });

  it('renders with a figure missing rather than not at all', () => {
    // A partial payload still means a team crossed its ceiling; dropping the
    // toast over a missing number would drop the only notice there is.
    const { container } = renderToasts({
      budgets: [budget({ costUsd: undefined })],
    });
    expect(container.querySelector('.t-budget-figure')?.textContent)
      .toBe('— / $50.00 · TEAM PAUSED');
  });

  it('opens the team on OPEN TEAM', () => {
    const { onBudgetOpen } = renderToasts({ budgets: [budget()] });
    fireEvent.click(screen.getByRole('button', { name: '→ OPEN TEAM' }));
    expect(onBudgetOpen).toHaveBeenCalledTimes(1);
    expect(onBudgetOpen.mock.calls[0]?.[0]).toMatchObject({ id: 'o1', teamId: 'o1' });
  });

  it('closes on DISMISS, by id', () => {
    const { onBudgetDismiss, onBudgetOpen } = renderToasts({ budgets: [budget()] });
    fireEvent.click(screen.getByRole('button', { name: 'DISMISS' }));
    expect(onBudgetDismiss).toHaveBeenCalledWith('o1');
    // Dismissing is not opening: the team must not be selected on the way out.
    expect(onBudgetOpen).not.toHaveBeenCalled();
  });

  it('leads the stack, closest to the corner', () => {
    // `.toasts` is `column-reverse`, so the first child is the bottom-most —
    // the most prominent slot, and this is the only toast reporting a team
    // that may already be stopped.
    const { container } = renderToasts({
      budgets: [budget()],
      items: [waiting()],
      notices: [{ id: 'n1', kind: 'ok', title: 'COMPACT SCHEDULED', at: Date.now() }],
    });
    const first = container.querySelector('.toasts')?.firstElementChild;
    expect(first?.className).toContain('toast-budget');
  });

  it('stays out of the way entirely when no team is over budget', () => {
    const { container } = renderToasts({ items: [waiting()] });
    expect(container.querySelector('.toast-budget')).toBeNull();
    // …and the waiting toast it shares the stack with is untouched.
    expect(container.querySelector('.toast .t-title')?.textContent)
      .toBe('SESSION WAITING');
  });

  it('shows one toast per team', () => {
    const { container } = renderToasts({
      budgets: [budget(), budget({ id: 'o2', teamId: 'o2', teamName: 'NOVA' })],
    });
    expect(container.querySelectorAll('.toast-budget')).toHaveLength(2);
  });
});
