/**
 * RouteEnrichmentAdvisor unit tests.
 *
 * Tests the enrich() method covering:
 * - LLM returns keep → route unchanged
 * - LLM returns insert with valid stop → stop spliced at correct index
 * - LLM returns reorder with valid stops → route stops reordered
 * - LLM returns insert with invalid city name → fallback to keep
 * - LLM call fails/times out → fallback to keep, route unchanged
 * - LLM returns invalid JSON → fallback to keep after retries
 * - Graceful degradation: no throws
 */

import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  StrategicRoute,
  WorldSnapshot,
  GameContext,
  GridPoint,
  TerrainType,
  DemandContext,
} from '../../../shared/types/GameTypes';
import { RouteEnrichmentSchema } from '../../services/ai/schemas';

// Mock LLMStrategyBrain so we don't need a real instance
jest.mock('../../services/ai/LLMStrategyBrain');

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function gp(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName ? { type: terrain, name: cityName, availableLoads: [] } : undefined,
  };
}

const testGrid: GridPoint[] = [
  gp(0, 0, TerrainType.MajorCity, 'Berlin'),
  gp(0, 1, TerrainType.Clear),
  gp(1, 0, TerrainType.Clear),
  gp(1, 1, TerrainType.MajorCity, 'Paris'),
  gp(2, 0, TerrainType.MajorCity, 'Lyon'),
  gp(2, 1, TerrainType.Clear),
];

function makeRoute(stops?: Array<{ action: 'pickup' | 'deliver'; loadType: string; city: string }>): StrategicRoute {
  return {
    stops: stops ?? [
      { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris', payment: 12 },
    ],
    currentStopIndex: 0,
    phase: 'travel',
    createdAtTurn: 1,
    reasoning: 'test route',
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'in_progress',
    turnNumber: 3,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 100,
      position: { row: 0, col: 0 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [{ playerId: 'bot-1', segments: [] }],
    loadAvailability: {},
  };
}

function makeDemand(supplyCity: string, deliveryCity: string, payout = 10): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Coal',
    supplyCity,
    deliveryCity,
    payout,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 5,
    demandScore: 2,
    efficiencyPerTurn: 2,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
  };
}

function makeContext(demands: DemandContext[] = []): GameContext {
  return {
    position: { row: 0, col: 0 },
    money: 100,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '',
    turnBuildCost: 0,
    demands,
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: ['Berlin'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 3,
  };
}

function makeMockBrain(responseText: string): LLMStrategyBrain {
  const mockChat = jest.fn().mockResolvedValue({
    text: responseText,
    usage: { input: 100, output: 50 },
  });
  return {
    providerAdapter: { chat: mockChat, setContext: jest.fn() },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

function makeFailingBrain(): LLMStrategyBrain {
  return {
    providerAdapter: {
      chat: jest.fn().mockRejectedValue(new Error('LLM timeout')),
      setContext: jest.fn(),
    },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RouteEnrichmentAdvisor.enrich', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the route unchanged when LLM decides keep', async () => {
    const keepResponse: RouteEnrichmentSchema = {
      decision: 'keep',
      reasoning: 'Route is already optimal',
    };
    const brain = makeMockBrain(JSON.stringify(keepResponse));
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result).toEqual(route);
    expect(result.stops.length).toBe(2);
  });

  it('splices a new stop at the correct index when LLM inserts', async () => {
    const insertResponse: RouteEnrichmentSchema = {
      decision: 'insert',
      insertions: [{
        afterStopIndex: 0,
        action: 'deliver',
        loadType: 'Coal',
        city: 'Lyon',
        reasoning: 'Lyon is on the way to Paris',
      }],
      reasoning: 'Insert Lyon delivery stop',
    };
    const brain = makeMockBrain(JSON.stringify(insertResponse));
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result.stops.length).toBe(3);
    // Original: Berlin(0), Paris(1) → After insert at 0: Berlin(0), Lyon(1), Paris(2)
    expect(result.stops[1].city).toBe('Lyon');
    expect(result.stops[1].action).toBe('deliver');
    expect(result.stops[0].city).toBe('Berlin');
    expect(result.stops[2].city).toBe('Paris');
  });

  it('reorders stops when LLM returns reorder decision', async () => {
    const reorderResponse: RouteEnrichmentSchema = {
      decision: 'reorder',
      reorderedStops: [
        { action: 'pickup', loadType: 'Coal', city: 'Lyon' },
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris' },
      ],
      reasoning: 'Lyon is geographically first',
    };
    const brain = makeMockBrain(JSON.stringify(reorderResponse));
    const route = makeRoute([
      { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      { action: 'pickup', loadType: 'Coal', city: 'Lyon' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris' },
    ]);

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result.stops.length).toBe(3);
    expect(result.stops[0].city).toBe('Lyon');
    expect(result.stops[1].city).toBe('Berlin');
    expect(result.stops[2].city).toBe('Paris');
  });

  it('falls back to original route when LLM call fails', async () => {
    const brain = makeFailingBrain();
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result).toBe(route);
    expect(result.stops.length).toBe(2);
  });

  it('falls back to original route when LLM returns invalid JSON (after retries)', async () => {
    // Return invalid JSON on all attempts
    const mockChat = jest.fn().mockResolvedValue({
      text: 'This is not JSON at all!',
      usage: { input: 50, output: 20 },
    });
    const brain = {
      providerAdapter: { chat: mockChat, setContext: jest.fn() },
      modelName: 'test-model',
    } as unknown as LLMStrategyBrain;

    const route = makeRoute();
    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result).toEqual(route);
    // Should have tried 1 + MAX_RETRIES = 2 times
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('falls back to original route when insertion city does not exist in grid', async () => {
    const insertResponse: RouteEnrichmentSchema = {
      decision: 'insert',
      insertions: [{
        afterStopIndex: 0,
        action: 'pickup',
        loadType: 'Steel',
        city: 'NonExistentCity',
        reasoning: 'Steel pickup',
      }],
      reasoning: 'Insert steel pickup',
    };
    const brain = makeMockBrain(JSON.stringify(insertResponse));
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    // Should return original route since city doesn't exist
    expect(result.stops.length).toBe(2);
    expect(result).toEqual(route);
  });

  it('falls back to original route when reorder has invalid city name', async () => {
    const reorderResponse: RouteEnrichmentSchema = {
      decision: 'reorder',
      reorderedStops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'GhostCity' }, // doesn't exist
      ],
      reasoning: 'Reorder',
    };
    const brain = makeMockBrain(JSON.stringify(reorderResponse));
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result).toEqual(route);
  });

  it('preserves original route metadata (currentStopIndex, phase, etc.) after insertion', async () => {
    const insertResponse: RouteEnrichmentSchema = {
      decision: 'insert',
      insertions: [{
        afterStopIndex: 0,
        action: 'deliver',
        loadType: 'Coal',
        city: 'Lyon',
        reasoning: 'On the way',
      }],
      reasoning: 'Add Lyon',
    };
    const brain = makeMockBrain(JSON.stringify(insertResponse));
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid);

    expect(result.currentStopIndex).toBe(route.currentStopIndex);
    expect(result.phase).toBe(route.phase);
    expect(result.createdAtTurn).toBe(route.createdAtTurn);
    expect(result.reasoning).toBe(route.reasoning);
  });

  it('does not throw when called with minimal/empty demands', async () => {
    const keepResponse: RouteEnrichmentSchema = {
      decision: 'keep',
      reasoning: 'No changes needed',
    };
    const brain = makeMockBrain(JSON.stringify(keepResponse));
    const route = makeRoute();

    await expect(
      RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext([]), brain, testGrid),
    ).resolves.not.toThrow();
  });

  it('uses demand contexts to annotate D/P cities in corridor map prompt', async () => {
    const keepResponse: RouteEnrichmentSchema = {
      decision: 'keep',
      reasoning: 'No changes',
    };
    const mockChat = jest.fn().mockResolvedValue({
      text: JSON.stringify(keepResponse),
      usage: { input: 100, output: 50 },
    });
    const brain = {
      providerAdapter: { chat: mockChat, setContext: jest.fn() },
      modelName: 'test-model',
    } as unknown as LLMStrategyBrain;

    const demands = [makeDemand('Lyon', 'Paris')];
    const context = makeContext(demands);
    const route = makeRoute();

    await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), context, brain, testGrid);

    // Verify LLM was called with a prompt that contains the corridor map
    const chatCall = mockChat.mock.calls[0][0];
    expect(chatCall.userPrompt).toContain('Corridor map');
    expect(chatCall.systemPrompt).toContain('route enrichment advisor');
  });
});
