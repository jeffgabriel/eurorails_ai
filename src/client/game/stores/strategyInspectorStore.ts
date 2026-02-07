import { create } from 'zustand';
import type { StrategyAudit } from '../../../shared/types/AITypes';

/** Max number of cached audits per bot (keeps memory bounded) */
const MAX_CACHE_SIZE = 10;

/** Cached audit entry with timestamp for staleness checks */
interface CachedAudit {
  audit: StrategyAudit;
  receivedAt: number;
}

interface StrategyInspectorState {
  isOpen: boolean;
  gameId: string | null;
  playerId: string | null;
  playerName: string | null;
  auditData: StrategyAudit | null;
  isLoading: boolean;
  error: string | null;
  /** Per-bot audit cache: playerId → latest audit */
  auditCache: Map<string, CachedAudit>;
  /** Player IDs that have fresh audit data since last viewed */
  freshAuditPlayerIds: Set<string>;
}

interface StrategyInspectorActions {
  open: (gameId: string, playerId: string, playerName: string) => void;
  close: () => void;
  fetchAudit: (gameId: string, playerId: string) => Promise<void>;
  receiveAudit: (playerId: string, audit: StrategyAudit) => void;
  /** Mark that a bot has completed a turn (triggers API fetch for cache) */
  markTurnComplete: (gameId: string, playerId: string) => void;
  /** Get cached audit for a player (without opening modal) */
  getCachedAudit: (playerId: string) => StrategyAudit | null;
  /** Check if a player has fresh (unviewed) audit data */
  hasFreshAudit: (playerId: string) => boolean;
  /** Clear the entire cache */
  clearCache: () => void;
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
  auditCache: new Map(),
  freshAuditPlayerIds: new Set(),

  open: (gameId: string, playerId: string, playerName: string) => {
    // Check cache first
    const cached = get().auditCache.get(playerId);

    // Remove from fresh set since user is now viewing
    const freshSet = new Set(get().freshAuditPlayerIds);
    freshSet.delete(playerId);

    if (cached) {
      // Use cached data immediately, then fetch fresh in background
      set({
        isOpen: true,
        gameId,
        playerId,
        playerName,
        auditData: cached.audit,
        isLoading: false,
        error: null,
        freshAuditPlayerIds: freshSet,
      });
      // Background refresh from API
      get().fetchAudit(gameId, playerId);
    } else {
      // No cache - show loading and fetch
      set({
        isOpen: true,
        gameId,
        playerId,
        playerName,
        auditData: null,
        isLoading: true,
        error: null,
        freshAuditPlayerIds: freshSet,
      });
      get().fetchAudit(gameId, playerId);
    }
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
    const state = get();
    // Only show loading spinner if we don't already have data displayed
    if (!state.auditData) {
      set({ isLoading: true, error: null });
    }
    try {
      const token = localStorage.getItem('eurorails.jwt');
      const response = await fetch(`/api/games/${gameId}/ai-audit/${playerId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        if (response.status === 404) {
          // Only show error if we have no cached data to show
          if (!get().auditData) {
            set({ isLoading: false, error: 'No audit data available yet. Wait for the bot to take a turn.' });
          } else {
            set({ isLoading: false });
          }
          return;
        }
        throw new Error(`Failed to fetch audit: ${response.status}`);
      }
      const audit: StrategyAudit = await response.json();

      // Update cache
      const cache = new Map(get().auditCache);
      cache.set(playerId, { audit, receivedAt: Date.now() });
      // Evict oldest entries if cache exceeds size limit
      if (cache.size > MAX_CACHE_SIZE) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of cache) {
          if (entry.receivedAt < oldestTime) {
            oldestTime = entry.receivedAt;
            oldestKey = key;
          }
        }
        if (oldestKey) cache.delete(oldestKey);
      }

      // Only update displayed data if modal is still open for this player
      const currentState = get();
      if (currentState.isOpen && currentState.playerId === playerId) {
        set({ auditData: audit, isLoading: false, auditCache: cache });
      } else {
        set({ auditCache: cache });
      }
    } catch (err) {
      // Only show error if modal is still open for this player
      const currentState = get();
      if (currentState.isOpen && currentState.playerId === playerId && !currentState.auditData) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to fetch audit data',
        });
      }
    }
  },

  receiveAudit: (playerId: string, audit: StrategyAudit) => {
    // Always update cache
    const cache = new Map(get().auditCache);
    cache.set(playerId, { audit, receivedAt: Date.now() });
    if (cache.size > MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of cache) {
        if (entry.receivedAt < oldestTime) {
          oldestTime = entry.receivedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) cache.delete(oldestKey);
    }

    // Mark as fresh
    const freshSet = new Set(get().freshAuditPlayerIds);
    freshSet.add(playerId);

    // If modal is open for this player, update displayed data
    const state = get();
    if (state.isOpen && state.playerId === playerId) {
      freshSet.delete(playerId);
      set({ auditData: audit, isLoading: false, error: null, auditCache: cache, freshAuditPlayerIds: freshSet });
    } else {
      set({ auditCache: cache, freshAuditPlayerIds: freshSet });
    }
  },

  markTurnComplete: (gameId: string, playerId: string) => {
    // Mark as having fresh data available
    const freshSet = new Set(get().freshAuditPlayerIds);
    freshSet.add(playerId);
    set({ freshAuditPlayerIds: freshSet });

    // Pre-fetch audit data into cache
    get().fetchAudit(gameId, playerId);
  },

  getCachedAudit: (playerId: string) => {
    return get().auditCache.get(playerId)?.audit ?? null;
  },

  hasFreshAudit: (playerId: string) => {
    return get().freshAuditPlayerIds.has(playerId);
  },

  clearCache: () => {
    set({ auditCache: new Map(), freshAuditPlayerIds: new Set() });
  },
}));
