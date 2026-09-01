// COST BUDGET fields of the role dialog — Lot 14 (docs/monitoring-agents.md).
//
// The dialog is the only place a budget is ever set, and a budget that looks
// set but is not is the single failure this feature cannot afford: nobody
// notices until the bill. So the tests are about what reaches `onSubmit`, and
// what does NOT reach it:
//
//   1. a filled field is submitted as a number, with its action;
//   2. an empty field is submitted as `null` — the only way to clear a
//      ceiling, and it must survive the round-trip through an edit;
//   3. a malformed field submits NOTHING and says why;
//   4. a role from a server predating Lot 14 (no budget fields at all) opens
//      on the empty defaults instead of throwing or inventing a zero.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleDialog } from './RoleDialog';
import { api, type RoleView } from '../api/client';

function role(over: Partial<RoleView> = {}): RoleView {
  return {
    id: 'r1',
    label: 'researcher',
    leadPrompt: null,
    leadPreamble: null,
    workerPreamble: null,
    workerCount: null,
    defaultModel: null,
    defaultEffort: null,
    defaultPermissionMode: null,
    defaultProvider: null,
    connectors: [],
    createdAt: '2026-08-30T09:00:00.000Z',
    updatedAt: '2026-08-30T09:00:00.000Z',
    ...over,
  };
}

// `Field` wraps its help paragraph inside the <label>, so the input's
// accessible name is the caption FOLLOWED BY the help line (which is a fine
// thing for a screen reader to read out, and the reaper fields next door do
// the same). Anchor on the caption instead of demanding an exact match.
const budgetInput = () =>
  screen.getByLabelText(/^cost budget \(usd\)/) as HTMLInputElement;
const actionButton = (label: string) =>
  screen.getByRole('radio', { name: label });

function renderDialog(initial: RoleView | null = null) {
  const onSubmit = vi.fn().mockResolvedValue(role());
  render(
    <RoleDialog
      open
      onClose={() => undefined}
      onSubmit={onSubmit}
      initial={initial}
    />,
  );
  return onSubmit;
}

/** The one field the dialog refuses to submit without. */
function fillLabel(value = 'researcher') {
  fireEvent.change(screen.getByLabelText('label (required)'), {
    target: { value },
  });
}

const save = () =>
  fireEvent.click(screen.getByRole('button', { name: /^(Create|Save)$/ }));

beforeEach(() => {
  // Everything the dialog fetches on open. Left unstubbed these reach the real
  // `request` helper and spray failures through every assertion below.
  vi.spyOn(api, 'getPreambleDefaults').mockResolvedValue({
    lead: 'lead default', worker: 'worker default',
  });
  vi.spyOn(api, 'listSkills').mockResolvedValue({ skills: [] });
  vi.spyOn(api, 'listProviders').mockResolvedValue({
    defaultProvider: 'claude', transport: 'local', providers: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RoleDialog · COST BUDGET section', () => {
  it('offers the amount and its consequence, defaulting to NOTIFY', () => {
    renderDialog();
    expect(screen.getByText('cost budget')).toBeTruthy();
    expect(budgetInput().value).toBe('');
    expect(actionButton('NOTIFY').getAttribute('aria-checked')).toBe('true');
    expect(actionButton('PAUSE TEAM').getAttribute('aria-checked')).toBe('false');
  });

  it('says what the budget covers and what each action does', () => {
    renderDialog();
    expect(screen.getByText(/Cumulé par TEAM de ce rôle, workers retirés inclus/))
      .toBeTruthy();
    expect(screen.getByText(/SIGSTOP de toute l’équipe, reprise manuelle/)).toBeTruthy();
  });

  it('submits the amount as a number, with the chosen action', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(budgetInput(), { target: { value: '50' } });
    fireEvent.click(actionButton('PAUSE TEAM'));
    expect(actionButton('PAUSE TEAM').getAttribute('aria-checked')).toBe('true');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      costBudgetUsd: 50,
      budgetAction: 'pause',
    });
  });

  it('submits null — not 0, not undefined — when the field is left empty', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0];
    expect(body.costBudgetUsd).toBeNull();
    expect(body.budgetAction).toBe('notify');
  });

  it('clears a stored budget when the operator empties the field', async () => {
    const onSubmit = renderDialog(role({ costBudgetUsd: 50, budgetAction: 'pause' }));
    expect(budgetInput().value).toBe('50');
    fireEvent.change(budgetInput(), { target: { value: '' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].costBudgetUsd).toBeNull();
    // The action survives the clear: it is what the NEXT budget will do.
    expect(onSubmit.mock.calls[0]?.[0].budgetAction).toBe('pause');
  });

  it('refuses a malformed amount instead of saving no budget at all', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(budgetInput(), { target: { value: '-5' } });
    save();

    expect(await screen.findByText(/Le budget doit être un nombre > 0/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pre-fills from an existing role, including its action', () => {
    renderDialog(role({ costBudgetUsd: 12.5, budgetAction: 'pause' }));
    expect(budgetInput().value).toBe('12.5');
    expect(actionButton('PAUSE TEAM').getAttribute('aria-checked')).toBe('true');
  });

  it('opens empty on a role from a server predating Lot 14', async () => {
    // No `costBudgetUsd`, no `budgetAction` — the fields are simply absent
    // from the payload. Empty field, NOTIFY, and a save that carries `null`.
    const onSubmit = renderDialog(role());
    expect(budgetInput().value).toBe('');
    expect(actionButton('NOTIFY').getAttribute('aria-checked')).toBe('true');
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].costBudgetUsd).toBeNull();
  });

  it('leaves the reaper fields it sits next to untouched', async () => {
    // The budget section was added beside the dead-worker reaper; the two are
    // edited in the same dialog and saved by the same button.
    const onSubmit = renderDialog(role({
      autoRemoveDeadWorkers: true,
      autoRemoveDeadWorkersDelayMs: 900_000,
      costBudgetUsd: 50,
    }));
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      autoRemoveDeadWorkers: true,
      autoRemoveDeadWorkersDelayMs: 900_000,
      costBudgetUsd: 50,
    });
  });
});
