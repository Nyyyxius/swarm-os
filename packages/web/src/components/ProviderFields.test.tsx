/**
 * Multi-provider Lot 3 — the capability filters.
 *
 * These pure helpers are what turn `ProviderInfo.capabilities` into "which
 * controls may the operator even see". Getting them wrong is how you end up
 * offering a `--effort` knob to gemini (which has none) or claude's permission
 * modes to codex (which has a sandbox instead), so they are tested directly
 * rather than only through the dialogs.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProviderInfo } from '../api/client';
import { PERMS } from './desktop/constants';
import {
  ModelSelect,
  ProviderSelect,
  defaultModelFor,
  effortNote,
  effortsFor,
  findProvider,
  groupModels,
  isPermissionChoice,
  permissionNote,
  permissionsFor,
  unavailableNote,
} from './ProviderFields';

function mkProvider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    builtin: true,
    available: true,
    models: [{ value: 'claude-opus-4-8', label: 'opus-4-8' }],
    capabilities: {
      effort: true,
      permissionModes: ['bypassPermissions', 'default'],
      fallbackPermissionMode: 'bypassPermissions',
      notificationHook: true,
      inkSubmitDance: true,
      durablePreamble: true,
      httpMcp: true,
    },
    defaults: { model: 'claude-opus-4-8', effort: 'xhigh', permissionMode: 'bypassPermissions' },
    ...over,
  };
}

describe('effortsFor', () => {
  it('returns the full list for a provider that supports effort', () => {
    expect(effortsFor(mkProvider())).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortNote(mkProvider())).toBeNull();
  });

  it('returns nothing — and an explanation — when the provider has no effort', () => {
    const gemini = mkProvider({
      id: 'gemini',
      label: 'Gemini CLI',
      capabilities: { ...mkProvider().capabilities, effort: false },
    });
    expect(effortsFor(gemini)).toEqual([]);
    expect(effortNote(gemini)).toMatch(/no reasoning-effort flag/i);
  });

  it('falls back to the full list for an unknown provider', () => {
    // Degrading to "unfiltered" beats degrading to "no controls at all" when
    // the catalogue never loaded.
    expect(effortsFor(undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('permissionsFor', () => {
  it('keeps only the modes the adapter declares, in our canonical order', () => {
    const p = mkProvider({
      capabilities: {
        ...mkProvider().capabilities,
        permissionModes: ['plan', 'default', 'bypassPermissions'],
      },
    });
    expect(permissionsFor(p)).toEqual(['bypassPermissions', 'default', 'plan']);
    expect(isPermissionChoice(p)).toBe(true);
    expect(permissionNote(p)).toBeNull();
  });

  it('is not a choice when the adapter declares a single mode', () => {
    const codex = mkProvider({
      id: 'codex',
      label: 'OpenAI Codex',
      capabilities: { ...mkProvider().capabilities, permissionModes: ['bypassPermissions'] },
    });
    expect(permissionsFor(codex)).toEqual(['bypassPermissions']);
    expect(isPermissionChoice(codex)).toBe(false);
    expect(permissionNote(codex)).toMatch(/no permission modes of its own/i);
  });

  it('never returns an empty list — an adapter with none still runs somehow', () => {
    const odd = mkProvider({
      capabilities: {
        ...mkProvider().capabilities,
        permissionModes: [],
        fallbackPermissionMode: 'acceptEdits',
      },
    });
    expect(permissionsFor(odd)).toEqual(['acceptEdits']);
  });

  it('passes through a mode we do not know about rather than dropping it', () => {
    const future = mkProvider({
      capabilities: { ...mkProvider().capabilities, permissionModes: ['default', 'sandboxed'] },
    });
    expect(permissionsFor(future)).toEqual(['default', 'sandboxed']);
  });

  it('falls back to our full enum for an unknown provider', () => {
    expect(permissionsFor(undefined)).toEqual([...PERMS]);
  });
});

describe('findProvider / defaultModelFor / unavailableNote', () => {
  const list = [mkProvider(), mkProvider({ id: 'codex', label: 'OpenAI Codex' })];

  it('resolves by id and treats inherit/unknown as undefined', () => {
    expect(findProvider(list, 'codex')?.label).toBe('OpenAI Codex');
    expect(findProvider(list, '')).toBeUndefined();
    expect(findProvider(list, 'nope')).toBeUndefined();
  });

  it('yields the provider default model, or the caller fallback', () => {
    expect(defaultModelFor(list[0])).toBe('claude-opus-4-8');
    expect(defaultModelFor(undefined, 'keep-this')).toBe('keep-this');
  });

  it('explains an unavailable provider with its reason and the transport', () => {
    const gone = mkProvider({
      available: false,
      unavailableReason: '`claude` is not on PATH on the host',
    });
    expect(unavailableNote(gone, 'ssh')).toMatch(/not on PATH/);
    expect(unavailableNote(gone, 'ssh')).toMatch(/ssh/);
    expect(unavailableNote(mkProvider(), 'ssh')).toBeNull();
  });
});

describe('ProviderSelect', () => {
  it('renders unavailable providers as disabled options carrying their reason', () => {
    const list = [
      mkProvider(),
      mkProvider({
        id: 'gemini',
        label: 'Gemini CLI',
        available: false,
        unavailableReason: '`gemini` is not on PATH on the host',
      }),
    ];
    render(
      <ProviderSelect value="claude" providers={list} onChange={() => undefined} />,
    );
    const gemini = screen.getByRole('option', { name: /Gemini CLI/ }) as HTMLOptionElement;
    expect(gemini.disabled).toBe(true);
    expect(gemini.title).toMatch(/not on PATH/);
  });

  it('surfaces a stored provider the server no longer knows about', () => {
    render(
      <ProviderSelect
        value="opencode"
        providers={[mkProvider()]}
        onChange={() => undefined}
      />,
    );
    // Showing the first provider instead would misreport what is stored.
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('opencode');
    expect(screen.getByRole('option', { name: /unknown to this server/ })).toBeTruthy();
  });
});

describe('ModelSelect', () => {
  it('offers only this provider’s models plus the escape hatch', () => {
    render(
      <ModelSelect
        value="claude-opus-4-8"
        provider={mkProvider()}
        onChange={() => undefined}
      />,
    );
    const values = Array.from(
      (screen.getByRole('combobox') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(values).toEqual(['claude-opus-4-8', '__custom_model__']);
  });

  it('keeps a current value the catalogue does not list', () => {
    // The server deliberately never validates model strings, so an id newer
    // than our catalogue must still display as itself.
    render(
      <ModelSelect
        value="claude-opus-9-9"
        provider={mkProvider()}
        onChange={() => undefined}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-9-9');
    expect(screen.getByRole('option', { name: /not in catalogue/ })).toBeTruthy();
  });
});

describe('groupModels — the opencode <optgroup> case', () => {
  it('leaves a vendorless catalogue flat, exactly as before', () => {
    // claude / codex / gemini ids carry no `/`. Wrapping them in a single
    // <optgroup> would change the rendered markup of three providers to solve a
    // problem only the fourth has.
    const flat = [
      { value: 'claude-opus-5', label: 'Opus 5' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    ];
    expect(groupModels(flat)).toEqual([[null, flat]]);
  });

  it('groups vendored ids, preserving the server’s newest-first order', () => {
    const grouped = groupModels([
      { value: 'anthropic/claude-opus-5', label: 'Opus 5' },
      { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { value: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
    ]);
    expect(grouped.map(([vendor]) => vendor)).toEqual(['anthropic', 'openai']);
    expect(grouped[0]?.[1].map((m) => m.value)).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
    ]);
  });

  it('surfaces a bare id ahead of the vendor groups rather than burying it', () => {
    const grouped = groupModels([
      { value: 'anthropic/claude-opus-5', label: 'Opus 5' },
      { value: 'hand-pinned-id', label: 'Hand pinned' },
    ]);
    expect(grouped[0]).toEqual([null, [{ value: 'hand-pinned-id', label: 'Hand pinned' }]]);
  });

  it('renders real <optgroup> elements, and the option values are unchanged', () => {
    render(
      <ModelSelect
        value="anthropic/claude-opus-5"
        provider={mkProvider({
          id: 'opencode',
          models: [
            { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
            { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
          ],
        })}
        onChange={() => undefined}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual([
      'anthropic',
      'openai',
    ]);
    // Grouping is presentation only: the submitted value must not change.
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'anthropic/claude-opus-5',
      'openai/gpt-5.5',
      '__custom_model__',
    ]);
  });
});
