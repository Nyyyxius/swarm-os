// packages/web/src/components/desktop/OpenRouterKeySection.test.tsx
//
// Contract of SETTINGS ▸ OPENROUTER (multi-provider Lot 6b):
//  - the server sends the sentinel '•••' when a key is stored, never the key,
//    and the field renders masked (type=password) with a "configured" dot;
//  - an untouched field cannot be saved: the operator who came for the accent
//    must not be able to rewrite a credential by clicking around;
//  - typing a new key PATCHes the plaintext once;
//  - clearing the field, or REMOVE, PATCHes `null` — the only expression of
//    deletion (echoing the sentinel means "keep");
//  - a rejected save shows the server's message locally and keeps the input, so
//    a mistyped key is fixable without retyping it from scratch.
//
// The hook is mocked rather than the api: `useInstanceSettings` owns a
// module-level singleton store with a once-per-process boot flag, so driving it
// through fetch would make the tests order-dependent for no coverage gain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  INSTANCE_SETTINGS_DEFAULTS,
  type InstanceSettingsPatch,
  type InstanceSettingsView,
} from '../../api/client';

const SENTINEL = '•••';

const hookState: {
  settings: InstanceSettingsView;
  setSettings: (p: InstanceSettingsPatch) => Promise<void>;
} = {
  settings: INSTANCE_SETTINGS_DEFAULTS,
  setSettings: async () => undefined,
};

vi.mock('../../hooks/useInstanceSettings', () => ({
  useInstanceSettings: () => ({
    settings: hookState.settings,
    loading: false,
    error: null,
    setSettings: hookState.setSettings,
    resetSettings: async () => undefined,
    refresh: async () => undefined,
  }),
}));

const { OpenRouterKeySection } = await import('./OpenRouterKeySection');

function setup(openrouterApiKey: string | null) {
  const setSettings = vi.fn<(p: InstanceSettingsPatch) => Promise<void>>(async () => undefined);
  hookState.settings = { ...INSTANCE_SETTINGS_DEFAULTS, openrouterApiKey };
  hookState.setSettings = setSettings;
  const utils = render(<OpenRouterKeySection />);
  const input = screen.getByLabelText('API KEY') as HTMLInputElement;
  return { ...utils, input, setSettings };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('OpenRouterKeySection — masked read', () => {
  it('renders the sentinel masked and reports the key as configured', () => {
    const { input } = setup(SENTINEL);
    expect(input.value).toBe(SENTINEL);
    expect(input.type).toBe('password');
    expect(screen.getByText('key configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'REMOVE' })).toBeInTheDocument();
  });

  it('says opencode is unavailable when no key is stored, and offers no REMOVE', () => {
    const { input } = setup(null);
    expect(input.value).toBe('');
    expect(screen.getByText(/no key · opencode reads as unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'REMOVE' })).toBeNull();
  });

  it('SHOW reveals what the operator typed, and only that', () => {
    const { input } = setup(null);
    fireEvent.change(input, { target: { value: 'sk-or-v1-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show OpenRouter key' }));
    expect((screen.getByLabelText('API KEY') as HTMLInputElement).type).toBe('text');
  });
});

describe('OpenRouterKeySection — writes', () => {
  it('refuses to save an untouched field (the sentinel is not a key)', () => {
    const { setSettings } = setup(SENTINEL);
    const save = screen.getByRole('button', { name: 'SAVE KEY' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(setSettings).not.toHaveBeenCalled();
  });

  it('clears the sentinel on focus so a key cannot be appended to three dots', () => {
    const { input } = setup(SENTINEL);
    fireEvent.focus(input);
    expect(input.value).toBe('');
  });

  it('PATCHes the plaintext key once', async () => {
    const { input, setSettings } = setup(null);
    fireEvent.change(input, { target: { value: '  sk-or-v1-new-key  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE KEY' }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1));
    expect(setSettings).toHaveBeenCalledWith({ openrouterApiKey: 'sk-or-v1-new-key' });
  });

  it('Enter submits, same as SAVE KEY', async () => {
    const { input, setSettings } = setup(null);
    fireEvent.change(input, { target: { value: 'sk-or-v1-enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({
      openrouterApiKey: 'sk-or-v1-enter',
    }));
  });

  it('an emptied field is a deletion, not "leave it alone"', async () => {
    const { input, setSettings } = setup(SENTINEL);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE KEY' }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ openrouterApiKey: null }));
  });

  it('REMOVE deletes without making the operator empty the field first', async () => {
    const { setSettings } = setup(SENTINEL);
    fireEvent.click(screen.getByRole('button', { name: 'REMOVE' }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ openrouterApiKey: null }));
  });

  it('surfaces a rejected save locally and keeps what was typed', async () => {
    const { input, setSettings } = setup(null);
    setSettings.mockRejectedValueOnce(
      new Error('openrouterApiKey must be printable ASCII with no spaces'),
    );
    fireEvent.change(input, { target: { value: 'sk-or-v1-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'SAVE KEY' }));
    expect(await screen.findByText(/printable ASCII/)).toBeInTheDocument();
    expect((screen.getByLabelText('API KEY') as HTMLInputElement).value).toBe('sk-or-v1-bad');
  });
});
