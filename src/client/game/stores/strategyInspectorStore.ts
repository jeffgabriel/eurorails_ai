import { create } from 'zustand';
import type { StrategyAudit } from '../../../shared/types/AITypes';

interface StrategyInspectorState {
  isOpen: boolean;
  gameId: string | null;
  playerId: string | null;
  playerName: string | null;
  auditData: StrategyAudit | null;
  isLoading: boolean;
  error: string | null;
}

interface StrategyInspectorActions {
  open: (gameId: string, playerId: string, playerName: string) => void;
  close: () => void;
  fetchAudit: (gameId: string, playerId: string) => Promise<void>;
  receiveAudit: (playerId: string, audit: StrategyAudit) => void;
}

type StrategyInspectorStore = StrategyInspectorState & StrategyInspectorActions;

export const useStrategyInspectorStore = create<StrategyInspectorStore>((set, get) => ({
  isOpen: false,
  gameId: null,
  playerId: null,
  playerName: null,
  auditData: null,
  isLoading: false,
  error: null,

  open: (gameId: string, playerId: string, playerName: string) => {
    set({
      isOpen: true,
      gameId,
      playerId,
      playerName,
      auditData: null,
      isLoading: true,
      error: null,
    });
    get().fetchAudit(gameId, playerId);
  },

  close: () => {
    set({
      isOpen: false,
      gameId: null,
      playerId: null,
      playerName: null,
      auditData: null,
      isLoading: false,
      error: null,
    });
  },

  fetchAudit: async (gameId: string, playerId: string) => {
    set({ isLoading: true, error: null });
    try {
      const token = localStorage.getItem('eurorails.jwt');
      const response = await fetch(`/api/games/${gameId}/ai-audit/${playerId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        if (response.status === 404) {
          set({ isLoading: false, error: 'No audit data available yet. Wait for the bot to take a turn.' });
          return;
        }
        throw new Error(`Failed to fetch audit: ${response.status}`);
      }
      const audit: StrategyAudit = await response.json();
      set({ auditData: audit, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch audit data',
      });
    }
  },

  receiveAudit: (playerId: string, audit: StrategyAudit) => {
    const state = get();
    if (state.isOpen && state.playerId === playerId) {
      set({ auditData: audit, isLoading: false, error: null });
    }
  },
}));
