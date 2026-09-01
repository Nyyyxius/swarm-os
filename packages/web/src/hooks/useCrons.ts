import { useCallback, useEffect, useState } from 'react';
import { api, HttpError, type CronInput, type CronRunView, type CronView } from '../api/client';

interface State {
  crons: CronView[];
  /**
   * Instance-wide cadence switch (`SWARM_OS_SCHEDULE_ENABLED`). Defaults to
   * `true` so the "SCHEDULING DISABLED" banner never flashes during the first
   * fetch — only a server that actually answered `false` raises it.
   */
  schedulingEnabled: boolean;
  loading: boolean;
  error: string | null;
  /** The endpoint 404s — this backend predates the crons entity. */
  unavailable: boolean;
}

const EMPTY_STATE: State = {
  crons: [],
  schedulingEnabled: true,
  loading: true,
  error: null,
  unavailable: false,
};

/**
 * Poll hook for `GET /crons`, modelled on `useApprovals`/`useBoard` — NOT on
 * `useRoles`. The distinction is load-bearing: `useRoles` polls
 * unconditionally and is already instantiated three times inside
 * always-mounted components, so a fourth unconditional poller would cost every
 * operator a request every 5 s for a screen they may never open. Here the
 * whole interval hangs off `enabled` (`open` in `CronsPage`), so a closed
 * screen issues nothing.
 *
 * Mutations are NON-OPTIMISTIC on purpose: each one awaits `refresh()` before
 * resolving, so what the operator sees after a PAUSE is what the server
 * actually stored (and, for `nextRun`, what the re-armed scheduler actually
 * computed — a value the client cannot derive).
 */
export function useCrons(
  refreshMs = 5000,
  enabled = true,
): State & {
  refresh: () => Promise<void>;
  create: (body: CronInput) => Promise<CronView>;
  update: (id: string, body: Partial<CronInput>) => Promise<CronView>;
  destroy: (id: string) => Promise<void>;
  fire: (id: string) => Promise<CronRunView | null>;
} {
  const [state, setState] = useState<State>(EMPTY_STATE);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listCrons();
      setState({
        crons: res.crons,
        schedulingEnabled: res.schedulingEnabled,
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (err) {
      const is404 = err instanceof HttpError && err.status === 404;
      setState({
        crons: [],
        schedulingEnabled: true,
        loading: false,
        error: is404 ? null : err instanceof Error ? err.message : String(err),
        unavailable: is404,
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs, enabled]);

  const create = useCallback(
    async (body: CronInput) => {
      const res = await api.createCron(body);
      await refresh();
      return res.cron;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, body: Partial<CronInput>) => {
      const res = await api.updateCron(id, body);
      await refresh();
      return res.cron;
    },
    [refresh],
  );

  const destroy = useCallback(
    async (id: string) => {
      await api.deleteCron(id);
      await refresh();
    },
    [refresh],
  );

  const fire = useCallback(
    async (id: string) => {
      const res = await api.fireCron(id);
      // A manual fire writes a run row and, for a message cron, delivers
      // immediately — so `lastRun` is already stale by the time this resolves.
      await refresh();
      return res.run;
    },
    [refresh],
  );

  return { ...state, refresh, create, update, destroy, fire };
}
