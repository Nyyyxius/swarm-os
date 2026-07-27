/**
 * Multi-provider Lot 3 — `useProviders`.
 *
 * What is worth asserting here is not "the fetch works" but the two properties
 * the dialogs depend on:
 *
 *  - the SHAPE arrives whole (catalogue + instance default + transport), since
 *    the whole point of the endpoint is to stop the bundle from inventing its
 *    own defaults;
 *  - `refresh()` really re-hits the server, because the availability verdict is
 *    cached for 60 s server-side and a CLI installed on the host after page
 *    load must become selectable without reloading the page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useProviders } from './useProviders';
import { api, type ProvidersView } from '../api/client';

function catalogue(over: Partial<ProvidersView> = {}): ProvidersView {
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
        version: 'claude 2.0.0',
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
        defaults: {
          model: 'claude-opus-4-8',
          effort: 'xhigh',
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
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProviders', () => {
  it('exposes the catalogue, the instance default and the transport', async () => {
    vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
    const { result } = renderHook(() => useProviders());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.defaultProvider).toBe('claude');
    expect(result.current.transport).toBe('ssh');
    expect(result.current.providers.map((p) => p.id)).toEqual(['claude', 'gemini']);
    expect(result.current.error).toBeNull();
  });

  it('keeps unavailable adapters in the list WITH their reason', async () => {
    // Contract, not an accident: the UI renders them disabled + explained.
    // Filtering them out here would make that impossible downstream.
    vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
    const { result } = renderHook(() => useProviders());
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    const gemini = result.current.providers.find((p) => p.id === 'gemini')!;
    expect(gemini.available).toBe(false);
    expect(gemini.unavailableReason).toMatch(/not on PATH/);
    expect(gemini.capabilities.effort).toBe(false);
  });

  it('re-fetches on refresh() and picks up a newly installed CLI', async () => {
    const spy = vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
    const { result } = renderHook(() => useProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);

    // The host operator just installed the CLI; the server's 60 s probe cache
    // has since expired and now reports it as usable.
    const fixed = catalogue();
    fixed.providers[1]!.available = true;
    delete fixed.providers[1]!.unavailableReason;
    spy.mockResolvedValue(fixed);

    await act(async () => {
      await result.current.refresh();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.providers.find((p) => p.id === 'gemini')?.available).toBe(true);
  });

  it('does not poll on its own — refresh is driven by dialog opens', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
      renderHook(() => useProviders());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a failure without emptying a catalogue it already had', async () => {
    // An older server has no `/providers` route at all. The dialogs must stay
    // operable (free-text model entry), so the hook reports the error and keeps
    // whatever it last knew.
    const spy = vi.spyOn(api, 'listProviders').mockResolvedValue(catalogue());
    const { result } = renderHook(() => useProviders());
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    spy.mockRejectedValue(new Error('HTTP 404 GET /providers'));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toMatch(/404/);
    expect(result.current.providers).toHaveLength(2);
  });
});
