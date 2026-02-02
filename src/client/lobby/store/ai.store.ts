/**
 * AI Store
 *
 * Zustand store for managing AI player state during gameplay.
 * Handles AI thinking indicators, turn summaries, and strategies.
 */

import { create } from 'zustand';
import type { TurnSummary, AIStrategy, AIDebugInfo } from '../../../shared/types/AITypes';
import { socketService } from '../shared/socket';
import { debug } from '../shared/config';

interface AIStoreState {
  /** Whether an AI is currently thinking */
  isAIThinking: boolean;
  /** ID of the AI player currently thinking */
  thinkingPlayerId: string | null;
  /** Map of player IDs to their turn summaries */
  aiTurnSummaries: Map<string, TurnSummary>;
  /** Map of player IDs to their current strategies */
  aiStrategies: Map<string, AIStrategy>;
  /** Map of player IDs to their debug info */
  aiDebugInfo: Map<string, AIDebugInfo>;
  /** ID of the currently selected AI player to show in the panel */
  selectedAIPlayerId: string | null;
  /** Whether the bot strategy panel is visible */
  isBotPanelVisible: boolean;
}

interface AIStoreActions {
  /** Set the AI thinking state */
  setAIThinking: (isThinking: boolean, playerId?: string) => void;
  /** Set the turn summary for an AI player */
  setAITurnSummary: (playerId: string, summary: TurnSummary) => void;
  /** Set the strategy for an AI player */
  setAIStrategy: (playerId: string, strategy: AIStrategy) => void;
  /** Set the debug info for an AI player */
  setAIDebugInfo: (playerId: string, debugInfo: AIDebugInfo) => void;
  /** Select an AI player to show in the panel */
  selectAIPlayer: (playerId: string | null) => void;
  /** Toggle the bot strategy panel visibility */
  toggleBotPanel: (visible?: boolean) => void;
  /** Clear all AI state (e.g., when leaving a game) */
  clearAIState: () => void;
  /** Initialize AI socket listeners */
  initializeSocketListeners: () => void;
  /** Remove AI socket listeners */
  removeSocketListeners: () => void;
}

type AIStore = AIStoreState & AIStoreActions;

// Store listener cleanup functions
let cleanupFunctions: Array<() => void> = [];

export const useAIStore = create<AIStore>((set, get) => ({
  // Initial state
  isAIThinking: false,
  thinkingPlayerId: null,
  aiTurnSummaries: new Map(),
  aiStrategies: new Map(),
  aiDebugInfo: new Map(),
  selectedAIPlayerId: null,
  isBotPanelVisible: false,

  // Actions
  setAIThinking: (isThinking: boolean, playerId?: string) => {
    set({
      isAIThinking: isThinking,
      thinkingPlayerId: isThinking ? (playerId ?? null) : null,
    });
  },

  setAITurnSummary: (playerId: string, summary: TurnSummary) => {
    const summaries = new Map(get().aiTurnSummaries);
    summaries.set(playerId, summary);
    set({ aiTurnSummaries: summaries });
  },

  setAIStrategy: (playerId: string, strategy: AIStrategy) => {
    const strategies = new Map(get().aiStrategies);
    strategies.set(playerId, strategy);
    set({ aiStrategies: strategies });
  },

  setAIDebugInfo: (playerId: string, debugInfo: AIDebugInfo) => {
    const debugInfoMap = new Map(get().aiDebugInfo);
    debugInfoMap.set(playerId, debugInfo);
    set({ aiDebugInfo: debugInfoMap });
  },

  selectAIPlayer: (playerId: string | null) => {
    set({
      selectedAIPlayerId: playerId,
      isBotPanelVisible: playerId !== null,
    });
  },

  toggleBotPanel: (visible?: boolean) => {
    set((state) => ({
      isBotPanelVisible: visible !== undefined ? visible : !state.isBotPanelVisible,
    }));
  },

  clearAIState: () => {
    set({
      isAIThinking: false,
      thinkingPlayerId: null,
      aiTurnSummaries: new Map(),
      aiStrategies: new Map(),
      aiDebugInfo: new Map(),
      selectedAIPlayerId: null,
      isBotPanelVisible: false,
    });
  },

  initializeSocketListeners: () => {
    // Clean up any existing listeners first
    get().removeSocketListeners();

    const socket = (socketService as any).socket;
    if (!socket) {
      debug.warn('Cannot initialize AI socket listeners: socket not connected');
      return;
    }

    // Listen for AI thinking event
    const onAIThinking = (data: { playerId: string }) => {
      debug.log('AI thinking:', data.playerId);
      get().setAIThinking(true, data.playerId);
      get().selectAIPlayer(data.playerId);
    };

    // Listen for AI turn complete event
    const onAITurnComplete = (data: {
      playerId: string;
      turnSummary: TurnSummary;
      currentStrategy: AIStrategy;
      debug?: AIDebugInfo;
    }) => {
      debug.log('AI turn complete:', data.playerId);
      get().setAIThinking(false);
      get().setAITurnSummary(data.playerId, data.turnSummary);
      get().setAIStrategy(data.playerId, data.currentStrategy);
      if (data.debug) {
        get().setAIDebugInfo(data.playerId, data.debug);
      }
    };

    socket.on('ai:thinking', onAIThinking);
    socket.on('ai:turn-complete', onAITurnComplete);

    // Store cleanup functions
    cleanupFunctions = [
      () => socket.off('ai:thinking', onAIThinking),
      () => socket.off('ai:turn-complete', onAITurnComplete),
    ];

    debug.log('AI socket listeners initialized');
  },

  removeSocketListeners: () => {
    cleanupFunctions.forEach((cleanup) => cleanup());
    cleanupFunctions = [];
    debug.log('AI socket listeners removed');
  },
}));

// Selector hooks for common use cases
export const useIsAIThinking = () => useAIStore((state) => state.isAIThinking);
export const useThinkingPlayerId = () => useAIStore((state) => state.thinkingPlayerId);
export const useAITurnSummary = (playerId: string | null) =>
  useAIStore((state) => (playerId ? state.aiTurnSummaries.get(playerId) : undefined));
export const useAIStrategy = (playerId: string | null) =>
  useAIStore((state) => (playerId ? state.aiStrategies.get(playerId) : undefined));
export const useAIDebugInfo = (playerId: string | null) =>
  useAIStore((state) => (playerId ? state.aiDebugInfo.get(playerId) : undefined));
export const useSelectedAIPlayerId = () => useAIStore((state) => state.selectedAIPlayerId);
export const useIsBotPanelVisible = () => useAIStore((state) => state.isBotPanelVisible);
