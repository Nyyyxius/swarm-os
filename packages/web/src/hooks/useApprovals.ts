import { useCallback, useEffect, useState } from 'react';
import { api, HttpError, type ApprovalListItem } from '../api/client';

interface State {
  approvals: ApprovalListItem[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

const EMPTY_STATE: State = {
  approvals: [],
  loading: true,
  error: null,
  unavailable: false,
};

/**
 * Approval-gate poll hook — mirrors `useBoard` in structure.
 * Fetches all approvals (pending + history) for the selected orchestrator.
 * `orchId` may be `null` (before the user picks a team); approvals stay
 * empty until provided. Gate the whole thing with `enabled`.
 * A 404 on the endpoint means the backend predates the approval gate.
 */
export function useApprovals(
  orchId: string | null,
  refreshMs = 5000,
  enabled = true,
): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>(EMPTY_STATE);

  const refresh = useCallback(async () => {
    if (!orchId) {
      setState({ approvals: [], loading: false, error: null, unavailable: false });
      return;
    }
    try {
      const res = await api.listApprovals(orchId);
      setState({
        approvals: res.approvals,
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (err) {
      const is404 = err instanceof HttpError && err.status === 404;
      setState({
        approvals: [],
        loading: false,
        error: is404 ? null : err instanceof Error ? err.message : String(err),
        unavailable: is404,
      });
    }
  }, [orchId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs, enabled]);

  return { ...state, refresh };
}
