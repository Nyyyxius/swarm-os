/**
 * Multi-provider Lot 3 — the agent-provider catalogue, for the dialogs.
 *
 * Shaped like `useRoles` (same `{ data, loading, error, refresh }` contract, a
 * `useCallback` refresh, one `useEffect` on mount) so the call sites read the
 * same way. Two deliberate differences:
 *
 *  - **No interval poll.** `useRoles` polls every 5 s because roles are edited
 *    from other surfaces while a dialog is open. The provider catalogue only
 *    changes when someone installs a CLI on the host, so a background timer
 *    would buy nothing. What matters is `refresh()` ON DIALOG OPEN: the server
 *    caches its availability probes for 60 s, so an operator who just ran
 *    `npm i -g opencode-ai` sees it appear by re-opening the dialog — no page
 *    reload, which is the point for a container that runs 24/7.
 *  - **A usable empty state.** A server that predates Lot 2 has no
 *    `/providers` route. The fetch then fails, `providers` stays `[]`, and the
 *    dialogs must still be operable (see `ProviderFields`, which falls back to
 *    free-text model entry). `error` is exposed so the surface can say so
 *    rather than silently offering nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorMessage, type ProviderInfo } from '../api/client';

interface State {
  providers: ProviderInfo[];
  /** Instance default — what a team gets when nobody names a provider. */
  defaultProvider: string | null;
  /** `local` | `ssh` — context for an "installed on the host yet unavailable". */
  transport: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: State = {
  providers: [],
  defaultProvider: null,
  transport: null,
  loading: true,
  error: null,
};

export function useProviders(): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listProviders();
      setState({
        providers: r.providers,
        defaultProvider: r.defaultProvider,
        transport: r.transport,
        loading: false,
        error: null,
      });
    } catch (err) {
      // Keep whatever catalogue we already had: a transient failure must not
      // empty a dialog the operator is in the middle of using.
      setState((s) => ({ ...s, loading: false, error: apiErrorMessage(err) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
