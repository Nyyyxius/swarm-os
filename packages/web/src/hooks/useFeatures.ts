import { useCallback, useEffect, useState } from 'react';
import { api, type FeatureView } from '../api/client';

interface State {
  features: FeatureView[];
  loading: boolean;
  error: string | null;
}

/**
 * Read-only fetch of the built-in features (`GET /features`,
 * docs/builtin-features.md) — the richer `FeatureView[]` (displayName,
 * description, state) that the PluginsPage BUILT-IN section renders, distinct
 * from the controller's boolean visibility MAP.
 *
 * `rev` is the controller's `featuresRev`, bumped on every `feature.changed` WS
 * frame: bumping it refetches. There is deliberately NO poll (features change
 * only via the operator's own verbs, which raise the event) — the mount fetch
 * plus the `rev` refetch cover it. Shaped after `usePlugins`.
 */
export function useFeatures(rev = 0): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>({ features: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await api.listFeatures();
      setState({ features: r.features, loading: false, error: null });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, rev]);

  return { ...state, refresh };
}
