/**
 * RouteValidator.test.ts — Tests for RouteValidator.validate()
 *
 * Focuses on secondaryBuildTarget validation logic:
 *   - Valid city terrain types are preserved
 *   - Invalid/non-existent cities are stripped with a warning
 *   - Non-city terrain types are stripped with a warning
 *   - Routes without secondaryBuildTarget proceed normally
 */

import { RouteValidator } from '../../services/ai/RouteValidator';
import {
  StrategicRoute,
  GameContext,
  WorldSnapshot,
  TerrainType,
  DemandContext,
} from '../../../shared/types/GameTypes';
import { GridPointData } from '../../services/ai/MapTopology';

// Mock MapTopology — loadGridPoints returns a controllable Map
const mockGridPoints = new Map<string, GridPointData>();
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 15,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Essen', row: 10, col: 5 },
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: 'Essen-Berlin corridor',
    turnBuildCost: 0,
    demands: [makeDemand()],
    canDeliver: [],
    canPickup: [],
    ...overrides,
  } as GameContext;
}

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as WorldSnapshot;
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Essen' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    status: 'active',
    createdAtTurn: 5,
    reasoning: 'Test route',
    ...overrides,
  };
}

// ── Helper to add a grid point ──────────────────────────────────────────
function addGridPoint(row: number, col: number, terrain: TerrainType, name?: string): void {
  const key = `${row},${col}`;
  mockGridPoints.set(key, { row, col, terrain, name });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('RouteValidator', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGridPoints.clear();
    // Suppress console.log noise from RouteValidator's per-stop logging
    jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('secondaryBuildTarget validation', () => {
    it('should preserve a valid secondaryBuildTarget with SmallCity terrain', () => {
      // Arrange
      addGridPoint(20, 30, TerrainType.SmallCity, 'Flensburg');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'Flensburg', reasoning: 'expand network' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeDefined();
      expect(route.secondaryBuildTarget!.city).toBe('Flensburg');
      expect(route.secondaryBuildTarget!.reasoning).toBe('expand network');
    });

    it('should preserve a valid secondaryBuildTarget with MediumCity terrain', () => {
      // Arrange
      addGridPoint(15, 25, TerrainType.MediumCity, 'Kiel');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'Kiel', reasoning: 'medium city hub' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeDefined();
      expect(route.secondaryBuildTarget!.city).toBe('Kiel');
    });

    it('should preserve a valid secondaryBuildTarget with MajorCity terrain', () => {
      // Arrange
      addGridPoint(5, 10, TerrainType.MajorCity, 'Hamburg');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'Hamburg', reasoning: 'connect major city' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeDefined();
      expect(route.secondaryBuildTarget!.city).toBe('Hamburg');
    });

    it('should strip secondaryBuildTarget when city is not found in gridPoints', () => {
      // Arrange — no grid points with "NonExistentCity"
      addGridPoint(1, 1, TerrainType.Clear, 'SomeOtherPlace');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'NonExistentCity', reasoning: 'hallucinated city' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert — route still valid, but secondaryBuildTarget stripped
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripping invalid secondaryBuildTarget "NonExistentCity"'),
      );
    });

    it('should strip secondaryBuildTarget when city exists but has non-city terrain (Clear)', () => {
      // Arrange — "FlatLand" exists but is Clear terrain, not a city
      addGridPoint(12, 18, TerrainType.Clear, 'FlatLand');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'FlatLand', reasoning: 'not actually a city' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert — stripped with warning
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripping invalid secondaryBuildTarget "FlatLand"'),
      );
    });

    it('should strip secondaryBuildTarget when city exists but has Mountain terrain', () => {
      // Arrange — "MountainPass" exists but is Mountain terrain
      addGridPoint(8, 14, TerrainType.Mountain, 'MountainPass');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'MountainPass', reasoning: 'mountain milepost' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripping invalid secondaryBuildTarget "MountainPass"'),
      );
    });

    it('should strip secondaryBuildTarget when city exists but has Alpine terrain', () => {
      // Arrange
      addGridPoint(3, 7, TerrainType.Alpine, 'AlpinePoint');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'AlpinePoint', reasoning: 'alpine area' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripping invalid secondaryBuildTarget "AlpinePoint"'),
      );
    });

    it('should proceed normally when route has no secondaryBuildTarget', () => {
      // Arrange — route without secondaryBuildTarget
      const route = makeRoute(); // no secondaryBuildTarget by default

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert — no warning, no error
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      // console.warn should not have been called for secondaryBuildTarget
      const warnCalls = warnSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('secondaryBuildTarget'),
      );
      expect(warnCalls).toHaveLength(0);
    });

    it('should not fail the overall route when secondaryBuildTarget is invalid', () => {
      // Arrange — route with valid stops but invalid secondaryBuildTarget
      addGridPoint(1, 1, TerrainType.FerryPort, 'FerryOnly');

      const route = makeRoute({
        secondaryBuildTarget: { city: 'FerryOnly', reasoning: 'ferry port not a city' },
      });

      // Act
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());

      // Assert — route still valid (stops are fine), just secondaryBuildTarget stripped
      expect(result.valid).toBe(true);
      expect(route.secondaryBuildTarget).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripping invalid secondaryBuildTarget "FerryOnly"'),
      );
    });
  });
});
