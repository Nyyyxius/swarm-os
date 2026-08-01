import { useCallback, useEffect, useState } from 'react';
import { api, HttpError, type BoardCard, type BoardTeam } from '../api/client';

interface State {
  cards: BoardCard[];
  teams: BoardTeam[];
  loading: boolean;
  error: string | null;
  /** True when the backend taskboard surface is absent (404). */
  unavailable: boolean;
}

const EMPTY_STATE: State = {
  cards: [],
  teams: [],
  loading: true,
  error: null,
  unavailable: false,
};

/**
 * Taskboard poll hook — mirrors `useMemoryNotes` in structure.
 * Fetches both the team list and the card list for the selected orch.
 * `orchId` may be `null` (e.g. before the user picks a team); cards
 * stay empty until it is provided. Gate the whole thing with `enabled`.
 * A 404 on the teams endpoint means the backend predates this surface.
 */
export function useBoard(
  orchId: string | null,
  refreshMs = 5000,
  enabled = true,
): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>(EMPTY_STATE);

  const refresh = useCallback(async () => {
    try {
      const teamsRes = await api.listBoardTeams();
      let cards: BoardCard[] = [];
      if (orchId) {
        try {
          const cardsRes = await api.listBoard(orchId);
          cards = cardsRes.cards;
        } catch {
          // orch has no cards yet — treat as empty, not an error
        }
      }
      setState({
        cards,
        teams: teamsRes.teams,
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (err) {
      const is404 = err instanceof HttpError && err.status === 404;
      setState({
        cards: [],
        teams: [],
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
