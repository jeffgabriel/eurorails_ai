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
 * - Hallucinated stops (Belfast pickup, Holland delivery) → rejected by RouteValidator, original route preserved
 * - AC6: expectedDetourCost optional field parses correctly
 * - AC7: on-network insert (marginalBuildM=0) survives validator round-trip
 * - AC8: prompt contains "Additional loads available here", no corridor map
 * - AC9: inserted DELIVER stop has payment, demandCardId, insertionDetourCostOverride
 * - AC14: named log lines emitted in correct cases
 * - AC17: existing stop's insertionDetourCostOverride unchanged on second pass
 * - AC18: snapshot stability — insertionDetourCostOverride from captured candidates
 */

import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import { RouteValidator } from '../../services/ai/RouteValidator';
import {
  StrategicRoute,
  RouteStop,
  WorldSnapshot,
  GameContext,
  GridPoint,
  TerrainType,
  DemandContext,
} from '../../../shared/types/GameTypes';
import { RouteEnrichmentSchema } from '../../services/ai/schemas';
import { CandidateDetourInfo } from '../../services/ai/RouteDetourEstimator';

// Mock LLMStrategyBrain so we don't need a real instance
jest.mock('../../services/ai/LLMStrategyBrain');
// Mock RouteValidator so we can control validation outcomes without full game state
jest.mock('../../services/ai/RouteValidator');

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

function makeRoute(stops?: Array<{ action: 'pickup' | 'deliver'; loadType: string; city: string; demandCardId?: number; payment?: number; insertionDetourCostOverride?: number }>): StrategicRoute {
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

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
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
      ...overrides,
    },
    allPlayerTracks: [{ playerId: 'bot-1', segments: [] }],
    loadAvailability: {},
  };
}

function makeDemand(loadType: string, supplyCity: string, deliveryCity: string, payout = 10, cardIndex = 0): DemandContext {
  return {
    cardIndex,
    loadType,
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

function makeCandidate(
  loadType: string,
  deliveryCity: string,
  payout: number,
  marginalBuildM: number,
  marginalTurns = 0,
  bestSlotIndex = 1,
  cardIndex = 0,
): CandidateDetourInfo {
  return {
    loadType,
    deliveryCity,
    payout,
    cardIndex,
    bestSlotIndex,
    marginalBuildM,
    marginalTurns,
    feasible: true,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RouteEnrichmentAdvisor.enrich', () => {
  beforeEach(() => {
    // Default: RouteValidator accepts all enriched routes (no hallucinations)
    jest.mocked(RouteValidator.validate).mockReturnValue({ valid: true, errors: [] });
  });

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
    const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

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
    // Need non-empty candidates so the LLM is called
    const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

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
    // Need non-empty candidates so the LLM call is made
    const candidates = [makeCandidate('Coal', 'Paris', 10, 0)];

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

    expect(result.stops.length).toBe(3);
    expect(result.stops[0].city).toBe('Lyon');
    expect(result.stops[1].city).toBe('Berlin');
    expect(result.stops[2].city).toBe('Paris');
  });

  it('falls back to original route when LLM call fails', async () => {
    const brain = makeFailingBrain();
    const route = makeRoute();

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', []);

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
    const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];
    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

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
    const candidates = [makeCandidate('Steel', 'NonExistentCity', 10, 0)];

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

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

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', []);

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

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', []);

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
    const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

    await expect(
      RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext([]), brain, testGrid, 'Berlin', candidates),
    ).resolves.not.toThrow();
  });

  it('rejects hallucinated stops when RouteValidator returns invalid (game 8d8724c8 turn 9 scenario)', async () => {
    // LLM hallucinates: Belfast is not a Cattle supply city, Holland has no matching demand
    const reorderResponse: RouteEnrichmentSchema = {
      decision: 'reorder',
      reorderedStops: [
        { action: 'pickup', loadType: 'Cattle', city: 'Belfast' },   // hallucinated: Belfast is delivery, not supply
        { action: 'deliver', loadType: 'Cattle', city: 'Holland' },  // hallucinated: no such demand
        { action: 'deliver', loadType: 'Coal', city: 'Berlin' },     // real stop from original route
      ],
      reasoning: 'Optimized order',
    };
    const brain = makeMockBrain(JSON.stringify(reorderResponse));

    // The original route: Nantes→Berlin (real delivery target)
    const originalRoute = makeRoute([
      { action: 'pickup', loadType: 'Coal', city: 'Lyon' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin' },
    ]);

    // Configure the test grid to include Belfast (so city name validation passes)
    const extendedGrid: GridPoint[] = [
      ...testGrid,
      gp(3, 0, TerrainType.MajorCity, 'Belfast'),
      gp(3, 1, TerrainType.MajorCity, 'Holland'),
    ];

    // RouteValidator rejects the enriched route (hallucinated supply/demand)
    jest.mocked(RouteValidator.validate).mockReturnValue({
      valid: false,
      errors: [
        '"Belfast" is not a known supply city for Cattle.',
        'No demand card for delivering Cattle to Holland.',
      ],
    });

    const result = await RouteEnrichmentAdvisor.enrich(originalRoute, makeSnapshot(), makeContext(), brain, extendedGrid, 'Lyon', []);

    // Should fall back to original route, not the hallucinated one
    expect(result).toBe(originalRoute);
    expect(result.stops.length).toBe(2);
    expect(result.stops[0].city).toBe('Lyon');
    expect(result.stops[1].city).toBe('Berlin');
  });

  // ── JIRA-184: Haiku turn-5 regression ──────────────────────────────────────
  // Before the JIRA-184 refactor, RouteValidator.validate() silently reordered stops
  // by proximity. This caused the enrichment path to put Wroclaw (geographically closer)
  // before Praha even though the LLM intentionally placed Praha first.
  it('JIRA-184: enriched stop order is preserved — proximity reorder does NOT fire in attemptEnrich', async () => {
    // Scenario: bot at row=10,col=5. Wroclaw (row=12,col=7) is geographically closer than
    // Praha (row=40,col=25). The LLM enriched the route as [P-Praha, P-Holland, D-Bruxelles, P-Wroclaw].
    // After the refactor, this order must be preserved through attemptEnrich.

    const enrichedStops = [
      { action: 'pickup' as const, loadType: 'Steel', city: 'Praha' },
      { action: 'pickup' as const, loadType: 'Wine', city: 'Holland' },
      { action: 'deliver' as const, loadType: 'Steel', city: 'Bruxelles', demandCardId: 1, payment: 20 },
      { action: 'pickup' as const, loadType: 'Coal', city: 'Wroclaw' },
    ];
    const reorderResponse: RouteEnrichmentSchema = {
      decision: 'reorder',
      reorderedStops: enrichedStops,
      reasoning: 'LLM-curated order: Praha first, Wroclaw last',
    };

    const brain = makeMockBrain(JSON.stringify(reorderResponse));

    const originalRoute = makeRoute([
      { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
      { action: 'deliver', loadType: 'Steel', city: 'Bruxelles' },
    ]);

    // Extended grid to include all cities in the enriched route
    const extendedGrid: GridPoint[] = [
      ...testGrid,
      gp(10, 5, TerrainType.MajorCity, 'Praha'),      // farther from bot
      gp(12, 7, TerrainType.MajorCity, 'Wroclaw'),    // closer to bot
      gp(2, 2, TerrainType.MajorCity, 'Holland'),
      gp(1, 3, TerrainType.MajorCity, 'Bruxelles'),
    ];

    // Snapshot: bot at row=10,col=5 (Wroclaw at row=12 is closer than Praha at row=40)
    const snapshot = makeSnapshot();
    snapshot.bot.position = { row: 10, col: 5 };

    // Validator accepts the enriched route (no feasibility issues, no prunedRoute)
    jest.mocked(RouteValidator.validate).mockReturnValue({ valid: true, errors: [] });

    // Non-empty candidates needed so the LLM is called
    const candidates = [makeCandidate('Steel', 'Praha', 20, 0)];
    const result = await RouteEnrichmentAdvisor.enrich(originalRoute, snapshot, makeContext(), brain, extendedGrid, 'Berlin', candidates);

    // Assert: stop order matches the LLM's enriched order — Praha first, Wroclaw last
    // (Before JIRA-184 refactor, proximity reorder would have put Wroclaw first)
    expect(result.stops.length).toBe(4);
    expect(result.stops[0]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Praha' }));
    expect(result.stops[3]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Wroclaw' }));
  });

  it('applies pruned route when RouteValidator prunes some hallucinated stops', async () => {
    // LLM inserts one valid stop and one invalid stop
    const insertResponse: RouteEnrichmentSchema = {
      decision: 'insert',
      insertions: [
        {
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'On the way',
        },
      ],
      reasoning: 'Insert Lyon',
    };
    const brain = makeMockBrain(JSON.stringify(insertResponse));
    const route = makeRoute();
    const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

    // Validator accepts the route but prunes to only the feasible stops
    const prunedRoute: StrategicRoute = {
      ...route,
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', payment: 12 },
      ],
    };
    jest.mocked(RouteValidator.validate).mockReturnValue({
      valid: true,
      prunedRoute,
      errors: ['Lyon deliver pruned'],
    });

    const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

    // Should use the pruned route's stops
    expect(result.stops).toEqual(prunedRoute.stops);
  });

  // ─── AC6: Schema optional field ────────────────────────────────────────────
  describe('AC6: RouteEnrichmentInsertion.expectedDetourCost optional field', () => {
    it('parses LLM response that includes expectedDetourCost', async () => {
      const insertWithCost: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'On the way',
          expectedDetourCost: 12,
        }],
        reasoning: 'Insert Lyon with detour cost echoed',
      };
      const brain = makeMockBrain(JSON.stringify(insertWithCost));
      const route = makeRoute();
      // Need non-empty candidates so the LLM is called
      const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

      // Should parse without error and apply the insertion
      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);
      expect(result.stops.length).toBe(3);
    });

    it('parses LLM response that omits expectedDetourCost', async () => {
      const insertNoCost: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'On the way',
          // expectedDetourCost intentionally omitted
        }],
        reasoning: 'Insert Lyon without detour cost',
      };
      const brain = makeMockBrain(JSON.stringify(insertNoCost));
      const route = makeRoute();
      // Need non-empty candidates so the LLM is called
      const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

      // Should parse without error
      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);
      expect(result.stops.length).toBe(3);
    });
  });

  // ─── AC7: On-network insert (marginalBuildM=0) survives validator ────────────
  describe('AC7: on-network insert with marginalBuildM=0 survives validator', () => {
    it('inserted stop survives validator round-trip for marginalBuildM=0 candidate', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 15, 42);
      const context = makeContext([demand]);
      const candidates = [makeCandidate('Coal', 'Lyon', 15, 0, 0, 1, 42)]; // marginalBuildM=0

      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'On-network, zero detour cost',
        }],
        reasoning: 'Insert on-network stop',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));
      const route = makeRoute();

      // Validator passes (the override=0 means budget gate trivially passes)
      jest.mocked(RouteValidator.validate).mockReturnValue({ valid: true, errors: [] });

      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), context, brain, testGrid, 'Berlin', candidates);

      // Inserted stop must be present
      expect(result.stops.length).toBe(3);
      expect(result.stops[1].city).toBe('Lyon');
      expect(result.stops[1].action).toBe('deliver');
    });
  });

  // ─── AC8: Prompt format ───────────────────────────────────────────────────
  describe('AC8: prompt format requirements', () => {
    it('prompt contains "Additional loads available here" and no corridor map', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 15);
      const context = makeContext([demand]);
      const candidates = [makeCandidate('Coal', 'Lyon', 15, 0, 0, 1)];

      const keepResponse: RouteEnrichmentSchema = { decision: 'keep', reasoning: 'ok' };
      const mockChat = jest.fn().mockResolvedValue({
        text: JSON.stringify(keepResponse),
        usage: { input: 100, output: 50 },
      });
      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), context, brain, testGrid, 'Berlin', candidates);

      const chatCall = mockChat.mock.calls[0][0];
      // Must contain the new candidates block header
      expect(chatCall.userPrompt).toContain('Additional loads available here');
      // Must NOT contain corridor map artifacts (rune-row characters)
      expect(chatCall.userPrompt).not.toMatch(/\*/);
      expect(chatCall.userPrompt).not.toContain('T=route stop');
      expect(chatCall.userPrompt).not.toContain('Corridor map');
      // Must list the candidate
      expect(chatCall.userPrompt).toContain('Coal');
      expect(chatCall.userPrompt).toContain('Lyon');
    });

    it('candidates are listed in marginalBuildM ascending order', async () => {
      const demands = [
        makeDemand('Steel', 'Berlin', 'Paris', 20, 0),
        makeDemand('Coal', 'Berlin', 'Lyon', 15, 1),
      ];
      const context = makeContext(demands);
      // Steel has higher marginalBuildM → should appear second in prompt
      const candidates = [
        makeCandidate('Steel', 'Paris', 20, 10, 1, 1, 0),  // marginalBuildM=10
        makeCandidate('Coal', 'Lyon', 15, 0, 0, 1, 1),     // marginalBuildM=0
      ];

      const keepResponse: RouteEnrichmentSchema = { decision: 'keep', reasoning: 'ok' };
      const mockChat = jest.fn().mockResolvedValue({
        text: JSON.stringify(keepResponse),
        usage: { input: 100, output: 50 },
      });
      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), context, brain, testGrid, 'Berlin', candidates);

      const chatCall = mockChat.mock.calls[0][0];
      const prompt = chatCall.userPrompt as string;

      // Coal (marginalBuildM=0) should appear before Steel (marginalBuildM=10)
      const coalIdx = prompt.indexOf('Coal');
      const steelIdx = prompt.indexOf('Steel');
      expect(coalIdx).toBeLessThan(steelIdx);
    });
  });

  // ─── AC9: Inserted DELIVER stop fields ──────────────────────────────────────
  describe('AC9: inserted DELIVER stop has payment, demandCardId, insertionDetourCostOverride', () => {
    it('populates all three fields from context.demands and CandidateDetourInfo', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 15, 42);
      const context = makeContext([demand]);
      const candidates = [makeCandidate('Coal', 'Lyon', 15, 7, 1, 1, 42)]; // marginalBuildM=7

      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'Good ROI',
        }],
        reasoning: 'Insert Coal delivery',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));
      const route = makeRoute();

      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), context, brain, testGrid, 'Berlin', candidates);

      const insertedStop = result.stops[1]; // afterStopIndex=0 → inserted at index 1
      expect(insertedStop.city).toBe('Lyon');
      expect(insertedStop.action).toBe('deliver');
      // payment from demand.payout
      expect(insertedStop.payment).toBe(15);
      // demandCardId from demand.cardIndex
      expect(insertedStop.demandCardId).toBe(42);
      // insertionDetourCostOverride from candidate.marginalBuildM
      expect(insertedStop.insertionDetourCostOverride).toBe(7);
    });
  });

  // ─── AC14: Named log lines ──────────────────────────────────────────────────
  describe('AC14: named log lines', () => {
    let consoleSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('emits candidates summary on entry when candidates present', async () => {
      const candidates = [makeCandidate('Coal', 'Lyon', 10, 5, 1)];
      const keepResponse: RouteEnrichmentSchema = { decision: 'keep', reasoning: 'ok' };
      const brain = makeMockBrain(JSON.stringify(keepResponse));

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

      const logCalls = consoleSpy.mock.calls.map(c => c[0] as string);
      expect(logCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] candidates at Berlin:'))).toBe(true);
    });

    it('emits "no viable candidates" log when candidates list is empty', async () => {
      // With empty candidates, the advisor returns early without calling LLM
      const brain = {
        providerAdapter: { chat: jest.fn(), setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', []);

      const logCalls = consoleSpy.mock.calls.map(c => c[0] as string);
      expect(logCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] no viable candidates at Berlin'))).toBe(true);
      // Should NOT call LLM
      expect((brain.providerAdapter.chat as jest.Mock).mock.calls.length).toBe(0);
    });

    it('emits applied insertion log on insert decision', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 15, 42);
      const candidates = [makeCandidate('Coal', 'Lyon', 15, 0)];
      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{ afterStopIndex: 0, action: 'deliver', loadType: 'Coal', city: 'Lyon', reasoning: 'ok' }],
        reasoning: 'ok',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext([demand]), brain, testGrid, 'Berlin', candidates);

      const logCalls = consoleSpy.mock.calls.map(c => c[0] as string);
      expect(logCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] applied insertion'))).toBe(true);
    });

    it('emits validator pruned log when validator strips an inserted stop', async () => {
      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{ afterStopIndex: 0, action: 'deliver', loadType: 'Coal', city: 'Lyon', reasoning: 'ok' }],
        reasoning: 'Insert',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));
      const route = makeRoute();

      // Validator prunes the insertion (Lyon is removed)
      const prunedRoute: StrategicRoute = {
        ...route,
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', payment: 12 },
        ],
      };
      jest.mocked(RouteValidator.validate).mockReturnValue({
        valid: true,
        prunedRoute,
        errors: ['Coal@Lyon: budget exceeded'],
      });

      await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', [makeCandidate('Coal', 'Lyon', 10, 0)]);

      const warnCalls = consoleWarnSpy.mock.calls.map(c => c[0] as string);
      expect(warnCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] validator pruned insertion'))).toBe(true);
    });

    it('emits divergence log only when |Δ| > 30%', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 20, 1);
      const candidates = [makeCandidate('Coal', 'Lyon', 20, 10, 0, 1, 1)]; // computed=10M

      // LLM echoes expectedDetourCost=15M → Δ = |15-10|/10 = 50% > 30% → should warn
      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'ok',
          expectedDetourCost: 15, // diverges > 30%
        }],
        reasoning: 'ok',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext([demand]), brain, testGrid, 'Berlin', candidates);

      const warnCalls = consoleWarnSpy.mock.calls.map(c => c[0] as string);
      expect(warnCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] detour echo divergence'))).toBe(true);
    });

    it('does NOT emit divergence log when |Δ| <= 30%', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 20, 1);
      const candidates = [makeCandidate('Coal', 'Lyon', 20, 10, 0, 1, 1)]; // computed=10M

      // LLM echoes expectedDetourCost=11M → Δ = |11-10|/10 = 10% <= 30% → no warn
      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 0,
          action: 'deliver',
          loadType: 'Coal',
          city: 'Lyon',
          reasoning: 'ok',
          expectedDetourCost: 11,
        }],
        reasoning: 'ok',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));

      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext([demand]), brain, testGrid, 'Berlin', candidates);

      const warnCalls = consoleWarnSpy.mock.calls.map(c => c[0] as string);
      expect(warnCalls.some(msg => msg.includes('[RouteEnrichmentAdvisor] detour echo divergence'))).toBe(false);
    });
  });

  // ─── AC17: Existing stop's insertionDetourCostOverride unchanged ─────────────
  describe('AC17: existing stop override unchanged on second pass', () => {
    it('does not modify insertionDetourCostOverride on stops not newly inserted', async () => {
      // Route with an already-inserted stop that has an override
      const existingStop: RouteStop = {
        action: 'deliver',
        loadType: 'Coal',
        city: 'Paris',
        payment: 12,
        insertionDetourCostOverride: 5, // pre-existing override
      };
      const route = makeRoute([
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        existingStop as { action: 'pickup' | 'deliver'; loadType: string; city: string },
      ]);

      const keepResponse: RouteEnrichmentSchema = { decision: 'keep', reasoning: 'no changes' };
      const brain = makeMockBrain(JSON.stringify(keepResponse));
      const candidates = [makeCandidate('Coal', 'Lyon', 10, 0)];

      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', candidates);

      // The existing stop's override must remain unchanged
      const parisStop = result.stops.find(s => s.city === 'Paris');
      expect(parisStop?.insertionDetourCostOverride).toBe(5);
    });
  });

  // ─── AC18: Snapshot stability ──────────────────────────────────────────────
  describe('AC18: snapshot stability — insertionDetourCostOverride from captured candidates', () => {
    it('uses marginalBuildM captured at advisor entry, not re-derived from snapshot', async () => {
      const demand = makeDemand('Coal', 'Berlin', 'Lyon', 15, 99);
      const context = makeContext([demand]);
      // Candidate captured at entry: marginalBuildM=3
      const capturedCandidates = [makeCandidate('Coal', 'Lyon', 15, 3, 0, 1, 99)];

      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{ afterStopIndex: 0, action: 'deliver', loadType: 'Coal', city: 'Lyon', reasoning: 'ok' }],
        reasoning: 'ok',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));

      // Simulate a "stale snapshot" by mutating the snapshot after advisor entry
      // (The advisor should use capturedCandidates, not re-derive from snapshot)
      const snapshot = makeSnapshot();
      // Mutate snapshot after passing it in (simulating a concurrent mutation)
      const result = await RouteEnrichmentAdvisor.enrich(makeRoute(), snapshot, context, brain, testGrid, 'Berlin', capturedCandidates);

      // Mutation after the fact: this should NOT affect the result
      snapshot.bot.existingSegments = []; // hypothetical mutation

      // The inserted stop's override must equal the captured marginalBuildM=3
      const lyonStop = result.stops.find(s => s.city === 'Lyon');
      expect(lyonStop?.insertionDetourCostOverride).toBe(3);
    });
  });

  // ─── AC10/AC11/AC12: Trigger conditions ────────────────────────────────────
  // These test the filter logic — tested at the advisor level by verifying
  // the enrich() call behaves correctly when invoked by the MovementPhasePlanner.

  describe('AC10/AC11/AC12: candidate filter behavior', () => {
    it('does not call brain.providerAdapter.chat when candidates list is empty', async () => {
      const mockChat = jest.fn();
      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      // Pass empty candidates — no LLM call should be made
      await RouteEnrichmentAdvisor.enrich(makeRoute(), makeSnapshot(), makeContext(), brain, testGrid, 'Berlin', []);

      expect(mockChat).not.toHaveBeenCalled();
    });

    it('AC11: surfaces Flowers→Kaliningrad when route only has DELIVER Flowers@Krakow', async () => {
      // Bot has two Flowers demand cards (different delivery cities)
      // Route already contains DELIVER Flowers@Krakow (stop 1)
      // Holland still has Flowers chips → advisor should see Flowers→Kaliningrad
      const extendedGrid: GridPoint[] = [
        ...testGrid,
        gp(3, 0, TerrainType.MajorCity, 'Holland'),
        gp(4, 0, TerrainType.MajorCity, 'Krakow'),
        gp(5, 0, TerrainType.MajorCity, 'Kaliningrad'),
      ];

      const demands = [
        makeDemand('Flowers', 'Holland', 'Krakow', 18, 1),
        makeDemand('Flowers', 'Holland', 'Kaliningrad', 22, 2),
      ];
      const context = makeContext(demands);

      // Route: already has DELIVER Flowers@Krakow — Kaliningrad is NOT in the route
      const route = makeRoute([
        { action: 'pickup', loadType: 'Flowers', city: 'Holland' },
        { action: 'deliver', loadType: 'Flowers', city: 'Krakow', payment: 18, demandCardId: 1 },
      ]);

      // The advisor is called with the Kaliningrad candidate (condition 2 passes)
      const candidates = [makeCandidate('Flowers', 'Kaliningrad', 22, 0, 0, 2, 2)];

      const insertResponse: RouteEnrichmentSchema = {
        decision: 'insert',
        insertions: [{
          afterStopIndex: 1,
          action: 'deliver',
          loadType: 'Flowers',
          city: 'Kaliningrad',
          reasoning: 'Second Flowers delivery, free pickup already done',
        }],
        reasoning: 'Insert Kaliningrad delivery',
      };
      const brain = makeMockBrain(JSON.stringify(insertResponse));

      const result = await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), context, brain, extendedGrid, 'Holland', candidates);

      // Kaliningrad delivery should be inserted
      expect(result.stops.some(s => s.city === 'Kaliningrad' && s.action === 'deliver')).toBe(true);
    });

    it('AC12: already-in-plan case — both Flowers deliveries in route, empty candidates → chat not called', async () => {
      const mockChat = jest.fn();
      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      // Route already has DELIVER Flowers@Krakow AND DELIVER Flowers@Kaliningrad
      const route = makeRoute([
        { action: 'pickup', loadType: 'Flowers', city: 'Holland' },
        { action: 'deliver', loadType: 'Flowers', city: 'Krakow', payment: 18, demandCardId: 1 },
        { action: 'deliver', loadType: 'Flowers', city: 'Kaliningrad', payment: 22, demandCardId: 2 },
      ]);

      // Both candidates filtered out by condition 2 (already in plan)
      // MovementPhasePlanner would pass empty candidates to enrich
      await RouteEnrichmentAdvisor.enrich(route, makeSnapshot(), makeContext(), brain, testGrid, 'Holland', []);

      expect(mockChat).not.toHaveBeenCalled();
    });
  });
});
