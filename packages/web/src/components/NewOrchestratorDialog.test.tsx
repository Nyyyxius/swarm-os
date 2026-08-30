import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewOrchestratorDialog } from './NewOrchestratorDialog';
import { api, type ProvidersView, type RoleView } from '../api/client';

/**
 * Phase C — Step 9 — form-level checks for the v2 layout.
 *
 * Selectors target the v2 class structure (`.modal`, `.field*`, `role=alert`,
 * `CREATE TEAM →` button). The form defaults to empty `name` / `prompt` /
 * `preamble` and `cwd='/'`, so each "filled" test must populate the inputs
 * explicitly. The submitted name is forced to UPPERCASE per spec §3 / §7.
 */

function makeOnCreate() {
  return vi.fn().mockResolvedValue({
    id: 'orch-1',
    name: 'SMOKE',
    role: 'test',
    status: 'starting',
    leadSessionId: 'sess-1',
    defaultModel: 'claude-opus-4-7',
    defaultEffort: 'xhigh',
    defaultPermissionMode: 'bypassPermissions',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: new Date().toISOString(),
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
  });
}

/**
 * Multi-provider Lot 3 — a three-adapter catalogue, deliberately heterogeneous:
 *
 *  - `claude`   available, has effort, several permission modes;
 *  - `codex`    available, has effort, ONE permission mode (a sandbox, not
 *               claude's permission modes) ⇒ PERMISSION is not a choice;
 *  - `gemini`   NOT available and no effort at all ⇒ must still be listed,
 *               disabled, carrying its reason.
 */
function catalogue(): ProvidersView {
  return {
    defaultProvider: 'claude',
    transport: 'ssh',
    providers: [
      {
        id: 'claude',
        label: 'Claude Code',
        binary: 'claude',
        builtin: true,
        available: true,
        models: [
          { value: 'claude-opus-4-8', label: 'opus-4-8' },
          { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
        ],
        capabilities: {
          effort: true,
          permissionModes: ['bypassPermissions', 'default', 'plan'],
          fallbackPermissionMode: 'bypassPermissions',
          notificationHook: true,
          inkSubmitDance: true,
          durablePreamble: true,
          httpMcp: true,
        },
        defaults: {
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          permissionMode: 'bypassPermissions',
        },
      },
      {
        id: 'codex',
        label: 'OpenAI Codex',
        binary: 'codex',
        builtin: true,
        available: true,
        models: [{ value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' }],
        capabilities: {
          effort: true,
          permissionModes: ['bypassPermissions'],
          fallbackPermissionMode: 'bypassPermissions',
          notificationHook: false,
          inkSubmitDance: false,
          durablePreamble: true,
          httpMcp: true,
        },
        defaults: {
          model: 'gpt-5.2-codex',
          effort: 'high',
          permissionMode: 'bypassPermissions',
        },
      },
      {
        id: 'gemini',
        label: 'Gemini CLI',
        binary: 'gemini',
        builtin: true,
        available: false,
        unavailableReason: '`gemini` is not on PATH on the host',
        models: [{ value: 'gemini-3-pro', label: 'gemini-3-pro' }],
        capabilities: {
          effort: false,
          permissionModes: ['bypassPermissions'],
          fallbackPermissionMode: 'bypassPermissions',
          notificationHook: true,
          inkSubmitDance: true,
          durablePreamble: true,
          httpMcp: true,
        },
        defaults: {
          model: 'gemini-3-pro',
          effort: 'high',
          permissionMode: 'bypassPermissions',
        },
      },
    ],
  };
}

function stubProviders(): void {
  vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
  // The dialog also mounts `useRoles`; in jsdom that request fails and the hook
  // swallows it. Stub it so the console stays readable and the role auto-fill
  // never interferes with the provider assertions.
  vi.spyOn(api, 'listRoles').mockResolvedValue({ roles: [] });
}

function modelSelect(): HTMLSelectElement {
  return screen.getByLabelText('MODEL') as HTMLSelectElement;
}

function providerSelect(): HTMLSelectElement {
  return screen.getByLabelText('PROVIDER') as HTMLSelectElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewOrchestratorDialog', () => {
  it('does not render when open=false', () => {
    const { container } = render(
      <NewOrchestratorDialog open={false} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the form when open=true with bypassPermissions default', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    expect(screen.getByText(/NEW ORCHESTRATOR/i)).toBeInTheDocument();
    // The amber bypassPermissions warning should be present by default
    // (defaults to bypassPermissions per plan §3 / §17). We target the
    // `role="alert"` live region so the text wording can evolve freely.
    expect(screen.getByRole('alert')).toHaveTextContent(/bypassPermissions/i);
  });

  it('disables the Create button when cwd is cleared', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    // cwd defaults to '/' which is valid; we have to empty it to assert
    // the disabled state.
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    fireEvent.change(cwdInput, { target: { value: '' } });
    const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables Create when all required fields are filled', () => {
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i);
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    const promptInput = screen.getByPlaceholderText(/Ship the new swarm\.bin/i);
    fireEvent.change(nameInput, { target: { value: 'smoke' } });
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    fireEvent.change(promptInput, { target: { value: 'say hi' } });
    const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });
    expect(createBtn).not.toBeDisabled();
  });

  it('calls onCreate with the form values when Create is clicked', async () => {
    const onCreate = makeOnCreate();
    render(
      <NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={onCreate} />,
    );
    const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i);
    const cwdInput = screen.getByPlaceholderText('/workspace/path');
    const promptInput = screen.getByPlaceholderText(/Ship the new swarm\.bin/i);
    fireEvent.change(nameInput, { target: { value: 'smoke' } });
    fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });
    fireEvent.change(promptInput, { target: { value: 'say hi' } });
    fireEvent.click(screen.getByRole('button', { name: /CREATE TEAM/i }));
    // Wait one microtask for the async submit to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const call = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    // submit() applies .toUpperCase() (spec §3 — parity with team-pills).
    expect(call.name).toBe('SMOKE');
    expect((call.lead as { cwd: string }).cwd).toBe('/workspace/x');
    expect((call.defaults as { permissionMode: string }).permissionMode).toBe('bypassPermissions');
  });
});

// ─────────────────── Multi-provider Lot 3 — PROVIDER / MODEL ────────────────
describe('NewOrchestratorDialog — provider selection', () => {
  async function openDialog() {
    stubProviders();
    const onCreate = makeOnCreate();
    render(<NewOrchestratorDialog open onClose={() => undefined} onCreate={onCreate} />);
    // Wait for GET /providers to land before asserting on derived controls.
    //
    // BOTH selects, not just the provider: they settle in separate state
    // updates, so under load the provider can read `claude` a tick before the
    // model options exist. A `fireEvent.change` on a still-empty <select> is
    // silently dropped by jsdom (the value is not among its options), which
    // surfaced as a rare, confusing failure in the test below that switches
    // MODEL to `__custom_model__`. Waiting on the derived control removes the
    // race instead of papering over it with a timeout.
    await waitFor(() => {
      expect(providerSelect().value).toBe('claude');
      expect(modelSelect().value).toBe('claude-opus-4-8');
    });
    return { onCreate };
  }

  it('bootstraps PROVIDER from the server default, not from a bundled constant', async () => {
    await openDialog();
    expect(providerSelect().value).toBe('claude');
    // …and MODEL from THAT provider's default, not a hard-coded id.
    expect(modelSelect().value).toBe('claude-opus-4-8');
  });

  it('offers only the selected provider’s models', async () => {
    await openDialog();
    const values = Array.from(modelSelect().options).map((o) => o.value);
    expect(values).toContain('claude-opus-4-8');
    expect(values).toContain('claude-sonnet-4-6');
    // Another provider's ids must never be selectable under claude.
    expect(values).not.toContain('gpt-5.2-codex');
    expect(values).not.toContain('gemini-3-pro');

    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    const codexValues = Array.from(modelSelect().options).map((o) => o.value);
    expect(codexValues).toContain('gpt-5.2-codex');
    expect(codexValues).not.toContain('claude-opus-4-8');
  });

  it('resets MODEL to the new provider’s default when PROVIDER changes', async () => {
    await openDialog();
    fireEvent.change(modelSelect(), { target: { value: 'claude-sonnet-4-6' } });
    expect(modelSelect().value).toBe('claude-sonnet-4-6');

    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    // Leaving `claude-sonnet-4-6` selected under codex would be a spawn failure
    // the operator only discovers in the session log.
    expect(modelSelect().value).toBe('gpt-5.2-codex');
  });

  it('always offers a free-text escape hatch for an id we do not list', async () => {
    await openDialog();
    fireEvent.change(modelSelect(), { target: { value: '__custom_model__' } });
    const input = screen.getByLabelText('model id') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'claude-opus-9-9' } });
    expect(input.value).toBe('claude-opus-9-9');
  });

  it('lists an unavailable provider as DISABLED with its reason, never hidden', async () => {
    await openDialog();
    const gemini = Array.from(providerSelect().options).find((o) => o.value === 'gemini');
    expect(gemini).toBeTruthy();
    expect(gemini!.disabled).toBe(true);
    expect(gemini!.title).toMatch(/not on PATH/);
    // The label itself says so too — a native disabled <option> is easy to miss.
    expect(gemini!.textContent).toMatch(/unavailable/i);
    // …and the available ones are NOT disabled.
    const codex = Array.from(providerSelect().options).find((o) => o.value === 'codex');
    expect(codex!.disabled).toBe(false);
  });

  it('disables EFFORT when the provider has no effort capability', async () => {
    stubProviders();
    // gemini cannot be *picked* (disabled), but a role may already carry it —
    // so drive the state the same way a role auto-fill would: select codex
    // first to prove the enabled case, then assert the capability gate on a
    // catalogue where effort is false.
    render(
      <NewOrchestratorDialog open onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    await waitFor(() => expect(providerSelect().value).toBe('claude'));

    const effortButtons = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role=radiogroup] button[role=radio]'),
      );
    expect(effortButtons().every((b) => !b.disabled)).toBe(true);

    // Rebuild with gemini as the server default: same component, a provider
    // that declares `effort: false`.
    const noEffort = catalogue();
    noEffort.defaultProvider = 'gemini';
    vi.spyOn(api, 'listProviders').mockResolvedValue(noEffort);
    render(
      <NewOrchestratorDialog open onClose={() => undefined} onCreate={makeOnCreate()} />,
    );
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[role=radiogroup] button[role=radio]',
          ),
        ).some((b) => b.disabled),
      ).toBe(true),
    );
    // …and it says why, on screen.
    expect(screen.getByText(/no reasoning-effort flag/i)).toBeInTheDocument();
  });

  it('disables PERMISSION and explains it when the provider has a single mode', async () => {
    await openDialog();
    const perm = screen.getByLabelText('PERMISSION') as HTMLSelectElement;
    expect(perm.disabled).toBe(false);
    expect(Array.from(perm.options).map((o) => o.value)).toEqual([
      'bypassPermissions',
      'default',
      'plan',
    ]);

    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    const permAfter = screen.getByLabelText('PERMISSION') as HTMLSelectElement;
    expect(permAfter.disabled).toBe(true);
    expect(permAfter.value).toBe('bypassPermissions');
    expect(screen.getByText(/no permission modes of its own/i)).toBeInTheDocument();
  });

  it('warns that a provider without a notification hook never reports waiting', async () => {
    await openDialog();
    expect(screen.queryByText(/never report/i)).not.toBeInTheDocument();
    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    expect(screen.getByText(/never report/i)).toBeInTheDocument();
  });

  it('sends defaults.provider alongside the model in the create body', async () => {
    const { onCreate } = await openDialog();
    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. NOMAD/i), {
      target: { value: 'mixed' },
    });
    fireEvent.change(screen.getByPlaceholderText('/workspace/path'), {
      target: { value: '/workspace/x' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Ship the new swarm\.bin/i), {
      target: { value: 'go' },
    });
    fireEvent.click(screen.getByRole('button', { name: /CREATE TEAM/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    const defaults = (onCreate.mock.calls[0]?.[0] as { defaults: Record<string, string> })
      .defaults;
    expect(defaults.provider).toBe('codex');
    expect(defaults.model).toBe('gpt-5.2-codex');
    // What the form displays is what it submits: codex forces bypassPermissions.
    expect(defaults.permissionMode).toBe('bypassPermissions');
  });

  it('renders a 409 PROVIDER_UNAVAILABLE readably instead of "HTTP 409"', async () => {
    stubProviders();
    const onCreate = vi.fn().mockRejectedValue(
      Object.assign(new Error('HTTP 409 POST /orchestrators'), {
        // Shape of the server's error body; `apiErrorMessage` unwraps it when
        // the rejection is an HttpError. A plain Error falls back to `.message`,
        // so we assert the operator at least sees the status, never a blank.
        status: 409,
      }),
    );
    render(<NewOrchestratorDialog open onClose={() => undefined} onCreate={onCreate} />);
    await waitFor(() => expect(providerSelect().value).toBe('claude'));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. NOMAD/i), {
      target: { value: 'x' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Ship the new swarm\.bin/i), {
      target: { value: 'go' },
    });
    fireEvent.click(screen.getByRole('button', { name: /CREATE TEAM/i }));
    await waitFor(() =>
      expect(screen.getByText(/409/)).toBeInTheDocument(),
    );
  });
});

// ───────── Role auto-fill: a role's MODEL belongs to the role's PROVIDER ─────
describe('NewOrchestratorDialog — role auto-fill is provider-scoped', () => {
  function role(over: Partial<RoleView> & { id: string; label: string }): RoleView {
    return {
      leadPrompt: 'from the role',
      leadPreamble: null,
      workerPreamble: null,
      workerCount: null,
      defaultModel: null,
      defaultEffort: null,
      defaultPermissionMode: null,
      defaultProvider: null,
      connectors: [],
      schedule: null,
      scheduleMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    };
  }

  /**
   * A role written BEFORE multi-provider: a model id and no provider. Every
   * deployment already has some of these on disk — that is what makes this the
   * default case rather than an exotic one.
   */
  const LEGACY = role({ id: 'legacy', label: 'Legacy role', defaultModel: 'claude-opus-4-8' });
  /** A coherent modern role: names its provider AND a model of that provider. */
  const CODEX_ROLE = role({
    id: 'codexrole',
    label: 'Codex role',
    defaultProvider: 'codex',
    defaultModel: 'gpt-5.2-codex',
  });

  function roleSelect(): HTMLSelectElement {
    return screen.getByLabelText('ROLE') as HTMLSelectElement;
  }

  /**
   * Mount with a catalogue + a role list, and wait for BOTH sources to land
   * before any interaction. Waiting on one of them leaves the other free to
   * arrive mid-test and re-run the auto-fill on top of what the "operator" just
   * did — a flaky test, not a flaky component.
   */
  async function openWith(roles: RoleView[], serverDefault = 'claude') {
    const cat = catalogue();
    cat.defaultProvider = serverDefault;
    vi.spyOn(api, 'listProviders').mockResolvedValue(cat);
    vi.spyOn(api, 'listRoles').mockResolvedValue({ roles });
    const onCreate = makeOnCreate();
    render(<NewOrchestratorDialog open onClose={() => undefined} onCreate={onCreate} />);
    await waitFor(() => {
      expect(roleSelect().value).toBe(roles[0]!.id);
      expect(Array.from(providerSelect().options).map((o) => o.value)).toContain('codex');
      expect(providerSelect().value).not.toBe('');
    });
    return { onCreate };
  }

  /** Wait for PROVIDER + MODEL to both reach their expected settled values. */
  async function expectSettled(provider: string, model: string): Promise<void> {
    await waitFor(() => {
      expect(providerSelect().value).toBe(provider);
      expect(modelSelect().value).toBe(model);
    });
  }

  it('does NOT paste a legacy role’s claude model onto the provider already picked', async () => {
    // THE defect, in the order an operator actually hits it: choose the provider
    // first (PROVIDER is the first technical field), then pick a role. The role
    // carries a claude model and no provider, and the auto-fill used to write it
    // into MODEL regardless — leaving `codex` + `claude-opus-4-8` on screen and,
    // once submitted, in the create body. The server cannot save this one: an
    // operator-supplied model string is never second-guessed, on purpose.
    const { onCreate } = await openWith([CODEX_ROLE, LEGACY]);
    await expectSettled('codex', 'gpt-5.2-codex');

    fireEvent.change(roleSelect(), { target: { value: LEGACY.id } });
    // The role names no provider ⇒ the operator's codex stands, and the model
    // falls back to codex's own default instead of the role's claude id.
    await expectSettled('codex', 'gpt-5.2-codex');
    expect(modelSelect().value).not.toBe('claude-opus-4-8');

    // …and that is what gets submitted, not merely what is displayed.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. NOMAD/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /CREATE TEAM/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const defaults = (onCreate.mock.calls[0]?.[0] as { defaults: Record<string, string> })
      .defaults;
    expect(defaults.provider).toBe('codex');
    expect(defaults.model).toBe('gpt-5.2-codex');
  });

  it('drops the legacy role’s model when the role is picked under a foreign provider', async () => {
    // Same shape, reached the other way: the operator switches provider by hand
    // after the legacy role is already selected, then re-picks the role (a
    // common "did that take?" gesture). The auto-fill must not undo the switch.
    await openWith([LEGACY, CODEX_ROLE]);
    await expectSettled('claude', 'claude-opus-4-8');

    fireEvent.change(providerSelect(), { target: { value: 'codex' } });
    await expectSettled('codex', 'gpt-5.2-codex');

    fireEvent.change(roleSelect(), { target: { value: CODEX_ROLE.id } });
    await expectSettled('codex', 'gpt-5.2-codex');
    fireEvent.change(roleSelect(), { target: { value: LEGACY.id } });
    await expectSettled('codex', 'gpt-5.2-codex');
  });

  it('KEEPS the role model when the role names that same provider', async () => {
    // The rule must not throw away a deliberate pairing: switching TO a role
    // that names both a provider and a model applies both.
    await openWith([LEGACY, CODEX_ROLE]);
    await expectSettled('claude', 'claude-opus-4-8');
    fireEvent.change(roleSelect(), { target: { value: CODEX_ROLE.id } });
    await expectSettled('codex', 'gpt-5.2-codex');
  });

  it('KEEPS a provider-less role model when nothing switched provider', async () => {
    // The boundary of the rule, and it is deliberate. On an instance whose
    // default is codex, a role that names a model and NO provider inherits that
    // default — so its model is, by the same rule, a codex choice. It is an
    // explicit stored value and we never refuse one; validating the string
    // against a catalogue is exactly what the product does not do, because ids
    // ship faster than releases.
    //
    // It is not silent either: an id outside the provider's catalogue renders
    // labelled as such, so the operator sees the pairing they are committing to.
    // The server resolves this case identically (`providers/resolve.ts`, test of
    // the same name) — the two must agree, or the form would show one thing and
    // create another.
    await openWith([LEGACY], 'codex');
    await expectSettled('codex', 'claude-opus-4-8');
    expect(
      Array.from(modelSelect().options).find((o) => o.value === 'claude-opus-4-8')?.textContent,
    ).toMatch(/not in catalogue/);
  });
});
