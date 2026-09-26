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
const autoCompactInput = () =>
  screen.getByLabelText(/^auto-compact \(%\)/) as HTMLInputElement;
const workerAutoCompactInput = () =>
  screen.getByLabelText(/^auto-compact workers \(%\)/) as HTMLInputElement;
const toolsInput = (label: string) =>
  screen.getByLabelText(label) as HTMLTextAreaElement;
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

// ── AUTO-COMPACT (docs/auto-compact.md, Lot 2) ──────────────────────────────
//
// Same failure mode as the budget, mirrored: here the feature is ON by default
// (35 % instance-wide), so the value that must survive intact is the one that
// turns it OFF. Three states have to reach `onSubmit` distinctly — `null`
// (inherit), `0` (never compact this role) and an integer — and a threshold
// the server would reject must not leave the dialog looking saved.
describe('RoleDialog · AUTO-COMPACT field', () => {
  it('opens empty (inherit) and says what an empty field is worth', () => {
    renderDialog();
    expect(autoCompactInput().value).toBe('');
    expect(
      screen.getByText(/Vide = valeur de l’instance \(35 % par défaut\)/),
    ).toBeTruthy();
  });

  it('submits null — not 0 — when left empty, so the role keeps inheriting', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ autoCompactPct: null });
    expect(onSubmit.mock.calls[0]?.[0].autoCompactPct).toBeNull();
  });

  it('submits 0 as 0 — the per-role opt-out, not an empty field', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(autoCompactInput(), { target: { value: '0' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ autoCompactPct: 0 });
  });

  it('submits a threshold as an integer', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(autoCompactInput(), { target: { value: '40' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ autoCompactPct: 40 });
  });

  it('refuses a threshold above 100 instead of submitting one the server rejects', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(autoCompactInput(), { target: { value: '101' } });
    save();

    expect(
      await screen.findByText(/Le seuil doit être un entier entre 0 et 100/),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pre-fills from an existing role, 0 included', () => {
    renderDialog(role({ autoCompactPct: 20 }));
    expect(autoCompactInput().value).toBe('20');
  });

  it('keeps a disabled role disabled across an edit', async () => {
    const onSubmit = renderDialog(role({ autoCompactPct: 0 }));
    expect(autoCompactInput().value).toBe('0');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].autoCompactPct).toBe(0);
  });

  it('opens on inherit for a role from a server predating the feature', async () => {
    const onSubmit = renderDialog(role());
    expect(autoCompactInput().value).toBe('');
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].autoCompactPct).toBeNull();
  });

  it('leaves the budget field it sits next to untouched', async () => {
    const onSubmit = renderDialog(role({ costBudgetUsd: 50, autoCompactPct: 25 }));
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      costBudgetUsd: 50,
      autoCompactPct: 25,
    });
  });
});

// ── AUTO-COMPACT WORKERS (docs/auto-compact.md §8.2, v0.10.1) ──────────────
//
// The workers' threshold is a SECOND field with the same three states, whose
// instance default is OFF. What has to hold is exactly what holds for the
// lead's field — `null` / `0` / integer reach `onSubmit` distinctly — plus
// that the two fields never bleed into each other.
describe('RoleDialog · AUTO-COMPACT WORKERS field', () => {
  it('opens empty (inherit = off by default) and says so', () => {
    renderDialog();
    expect(workerAutoCompactInput().value).toBe('');
    expect(screen.getByText(/Vide = valeur de l’instance \(désactivé par/)).toBeTruthy();
  });

  it('submits null when left empty, alongside the lead threshold', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(autoCompactInput(), { target: { value: '40' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ autoCompactPct: 40 });
    expect(onSubmit.mock.calls[0]?.[0].workerAutoCompactPct).toBeNull();
  });

  it('submits a worker threshold without touching the lead one', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(workerAutoCompactInput(), { target: { value: '60' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ workerAutoCompactPct: 60 });
    expect(onSubmit.mock.calls[0]?.[0].autoCompactPct).toBeNull();
  });

  it('keeps an explicit 0 as 0 across an edit', async () => {
    const onSubmit = renderDialog(role({ autoCompactPct: 30, workerAutoCompactPct: 0 }));
    expect(workerAutoCompactInput().value).toBe('0');
    expect(autoCompactInput().value).toBe('30');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      autoCompactPct: 30,
      workerAutoCompactPct: 0,
    });
  });

  it('refuses an out-of-range worker threshold instead of submitting it', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(workerAutoCompactInput(), { target: { value: '3.5' } });
    save();

    expect(
      await screen.findByText(/Le seuil doit être un entier entre 0 et 100/),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('opens on inherit for a role from a server predating v0.10.1', async () => {
    const onSubmit = renderDialog(role({ autoCompactPct: 25 }));
    expect(workerAutoCompactInput().value).toBe('');
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].workerAutoCompactPct).toBeNull();
  });
});

// ── OUTILS (tool lists per role) ────────────────────────────────────────────
//
// Four free-text lists, two states each: `null` (all tools) and a non-empty
// array. What must hold is what reaches `onSubmit`: an empty field is `null`
// (never `[]`, which the server 400s), a typed list comes out clean, and an
// existing role round-trips through the form unchanged.
const TOOL_FIELDS = [
  ['Outils intégrés — lead', 'leadTools'],
  ['Outils intégrés — workers', 'workerTools'],
  ['Outils team-comms — lead', 'leadMcpTools'],
  ['Outils team-comms — workers', 'workerMcpTools'],
] as const;

describe('RoleDialog · OUTILS section', () => {
  it('opens with four empty fields that say empty means all tools', () => {
    renderDialog();
    expect(screen.getByText('outils')).toBeTruthy();
    for (const [label] of TOOL_FIELDS) {
      expect(toolsInput(label).value).toBe('');
      expect(toolsInput(label).placeholder).toBe('Vide = tous les outils');
    }
    expect(screen.getByText(/Prend effet au prochain lancement des sessions/)).toBeTruthy();
  });

  it('submits null — not [] — for every field left empty', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    // Blank-only content is still "empty".
    fireEvent.change(toolsInput('Outils intégrés — workers'), { target: { value: ' \n , ' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0];
    for (const [, key] of TOOL_FIELDS) expect(body[key]).toBeNull();
  });

  it('turns commas and new lines into a clean, de-duplicated list', async () => {
    const onSubmit = renderDialog();
    fillLabel();
    fireEvent.change(toolsInput('Outils intégrés — lead'), {
      target: { value: ' Bash, Read\n\nEdit ,Bash\n  Write  ' },
    });
    fireEvent.change(toolsInput('Outils team-comms — workers'), {
      target: { value: 'memory.search\nboard.list, memory.search' },
    });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0];
    expect(body.leadTools).toEqual(['Bash', 'Read', 'Edit', 'Write']);
    expect(body.workerMcpTools).toEqual(['memory.search', 'board.list']);
    // The other two fields do not bleed into each other.
    expect(body.workerTools).toBeNull();
    expect(body.leadMcpTools).toBeNull();
  });

  it('pre-fills an existing role one entry per line, and saves it back unchanged', async () => {
    const onSubmit = renderDialog(
      role({
        leadTools: ['Bash', 'Read'],
        workerTools: null,
        leadMcpTools: ['team.send_message', 'discord-agent.reply'],
        workerMcpTools: ['memory.search'],
      }),
    );
    expect(toolsInput('Outils intégrés — lead').value).toBe('Bash\nRead');
    expect(toolsInput('Outils intégrés — workers').value).toBe('');
    expect(toolsInput('Outils team-comms — lead').value).toBe(
      'team.send_message\ndiscord-agent.reply',
    );
    expect(toolsInput('Outils team-comms — workers').value).toBe('memory.search');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      leadTools: ['Bash', 'Read'],
      workerTools: null,
      leadMcpTools: ['team.send_message', 'discord-agent.reply'],
      workerMcpTools: ['memory.search'],
    });
  });

  it('clears an override back to null when the operator empties the field', async () => {
    const onSubmit = renderDialog(role({ leadTools: ['Bash'], workerTools: ['Read'] }));
    fireEvent.change(toolsInput('Outils intégrés — lead'), { target: { value: '' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0].leadTools).toBeNull();
    expect(onSubmit.mock.calls[0]?.[0].workerTools).toEqual(['Read']);
  });

  it('opens on "all tools" for a role from a server predating tool lists', async () => {
    const onSubmit = renderDialog(role());
    for (const [label] of TOOL_FIELDS) expect(toolsInput(label).value).toBe('');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0];
    for (const [, key] of TOOL_FIELDS) expect(body[key]).toBeNull();
  });
});
