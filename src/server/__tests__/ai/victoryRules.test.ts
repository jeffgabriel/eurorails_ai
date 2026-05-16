/**
 * victoryRules unit tests — computeGameState, cheapestUnconnectedMajorConnectorCost
 *
 * Tests cover:
 * - computeGameState: latching rules (once End, never reverts; cash threshold)
 * - cheapestUnconnectedMajorConnectorCost: already connected, partial, empty list
 */

import { computeGameState, cheapestUnconnectedMajorConnectorCost } from '../../services/ai/victoryRules';
import { GameState, GameContext } from '../../../shared/types/GameTypes';
import type { BotMemoryState } from '../../../shared/types/GameTypes';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastAbandonedRouteKey: null,
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '1 segment',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 5,
    gameState: GameState.Mid,
    ...overrides,
  };
}

// ── computeGameState ───────────────────────────────────────────────────────

describe('computeGameState', () => {
  describe('AC1a — cash below threshold, no prior memory → Mid', () => {
    it('returns Mid when cash is 150 and gameState is undefined', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 150 }, memory)).toBe(GameState.Mid);
    });
  });

  describe('AC1b — cash above threshold, no prior memory → latches to End', () => {
    it('returns End when cash is 201 and gameState is undefined', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 201 }, memory)).toBe(GameState.End);
    });
  });

  describe('AC1c — already End in memory + cash below threshold → stays End', () => {
    it('returns End when cash is 180 but gameState is already End', () => {
      const memory = makeMemory({ gameState: GameState.End });
      expect(computeGameState({ money: 180 }, memory)).toBe(GameState.End);
    });
  });

  describe('AC1d — already End in memory + cash above threshold → stays End', () => {
    it('returns End when cash is 300 and gameState is already End', () => {
      const memory = makeMemory({ gameState: GameState.End });
      expect(computeGameState({ money: 300 }, memory)).toBe(GameState.End);
    });
  });

  describe('boundary conditions', () => {
    it('returns Mid when cash is exactly 200 (threshold is exclusive: > 200)', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 200 }, memory)).toBe(GameState.Mid);
    });

    it('returns End when cash is 200.01', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 200.01 }, memory)).toBe(GameState.End);
    });
  });
});

// ── cheapestUnconnectedMajorConnectorCost ──────────────────────────────────

describe('cheapestUnconnectedMajorConnectorCost', () => {
  describe('when all major cities are connected (>= 7)', () => {
    it('returns 0 when connectedMajorCities.length >= 7', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        unconnectedMajorCities: [{ cityName: 'H', estimatedCost: 15 }],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });

    it('returns 0 when connectedMajorCities.length exceeds 7', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
        unconnectedMajorCities: [],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });
  });

  describe('when some major cities are unconnected', () => {
    it('returns estimatedCost of the first (cheapest) unconnected city', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C'],
        unconnectedMajorCities: [
          { cityName: 'Paris', estimatedCost: 8 },
          { cityName: 'Roma', estimatedCost: 20 },
        ],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(8);
    });
  });

  describe('when unconnectedMajorCities is empty', () => {
    it('returns 0 when unconnectedMajorCities is empty (and < 7 connected)', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B'],
        unconnectedMajorCities: [],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });
  });
});
