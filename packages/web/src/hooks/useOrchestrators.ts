import { useCallback, useEffect, useState } from 'react';
import { api, type OrchestratorView } from '../api/client';

interface State {
  orchestrators: OrchestratorView[];
  loading: boolean;
  error: string | null;
}

export function useOrchestrators(refreshMs = 3000): State & {
  refresh: () => Promise<void>;
  create: (body: Parameters<typeof api.createOrchestrator>[0]) => Promise<OrchestratorView>;
  destroy: (id: string) => Promise<void>;
} {
  const [state, setState] = useState<State>({ orchestrators: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await api.listOrchestrators();
      setState({ orchestrators: r.orchestrators, loading: false, error: null });
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
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs]);

  const create = useCallback<
    (body: Parameters<typeof api.createOrchestrator>[0]) => Promise<OrchestratorView>
  >(
    async (body) => {
      const res = await api.createOrchestrator(body);
      await refresh();
      return res.orchestrator;
    },
    [refresh],
  );

  const destroy = useCallback(
    async (id: string) => {
      await api.destroyOrchestrator(id);
      await refresh();
    },
    [refresh],
  );

  return { ...state, refresh, create, destroy };
}
