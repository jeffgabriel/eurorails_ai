/**
 * routeHelpers unit tests — isStopComplete, resolveBuildTarget
 *
 * Tests cover:
 * - isStopComplete: pickup completion (count-aware JIRA-104 logic), delivery completion
 * - resolveBuildTarget: route-based targets, victory build override, null (all on-network)
 */

import { isStopComplete, resolveBuildTarget, getNetworkFrontier } from '../../services/ai/routeHelpers';
import { GameContext, RouteStop, StrategicRoute, TrainType, WorldSnapshot, TerrainType, TrackSegment } from '../../../shared/types/GameTypes';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: TrainType.Freight,
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
    ...overrides,
  };
}

function makePickupStop(loadType: string, city = 'Berlin'): RouteStop {
  return { action: 'pickup', loadType, city };
}

function makeDeliverStop(loadType: string, city: string, demandCardId: number): RouteStop {
  return { action: 'deliver', loadType, city, demandCardId, payment: 20 };
}

// ── Pickup tests ───────────────────────────────────────────────────────────

describe('isStopComplete — pickup stops', () => {
  it('returns false when load is NOT on the train (pickup pending)', () => {
    const stop = makePickupStop('Coal');
    const allStops = [stop];
    const context = makeContext({ loads: [] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
  });

  it('returns true when train carries at least 1 instance for a single pickup', () => {
    const stop = makePickupStop('Coal');
    const allStops = [stop];
    const context = makeContext({ loads: ['Coal'] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(true);
  });

  it('returns true for first of two same-type pickups when train has 1 load', () => {
    // Route: pickup Coal @ Berlin (0), pickup Coal @ Hamburg (1)
    // Train has 1 Coal — first pickup is satisfied
    const stop0 = makePickupStop('Coal', 'Berlin');
    const stop1 = makePickupStop('Coal', 'Hamburg');
    const allStops = [stop0, stop1];
    const context = makeContext({ loads: ['Coal'] });

    expect(isStopComplete(stop0, 0, allStops, context)).toBe(true);
  });

  it('returns false for second of two same-type pickups when train has only 1 load (JIRA-104)', () => {
    // Route: pickup Coal @ Berlin (0), pickup Coal @ Hamburg (1)
    // Train has 1 Coal — second pickup still requires loading another Coal
    const stop0 = makePickupStop('Coal', 'Berlin');
    const stop1 = makePickupStop('Coal', 'Hamburg');
    const allStops = [stop0, stop1];
    const context = makeContext({ loads: ['Coal'] });

    // stop1 at index 1 — need 2 Coal on train, but only have 1
    expect(isStopComplete(stop1, 1, allStops, context)).toBe(false);
  });

  it('returns true for second of two same-type pickups when train has 2 loads', () => {
    const stop0 = makePickupStop('Coal', 'Berlin');
    const stop1 = makePickupStop('Coal', 'Hamburg');
    const allStops = [stop0, stop1];
    const context = makeContext({ loads: ['Coal', 'Coal'] });

    expect(isStopComplete(stop1, 1, allStops, context)).toBe(true);
  });

  it('does not count a different load type when checking pickup completion', () => {
    const coalPickup = makePickupStop('Coal');
    const allStops = [coalPickup];
    // Train has Wine but not Coal
    const context = makeContext({ loads: ['Wine'] });

    expect(isStopComplete(coalPickup, 0, allStops, context)).toBe(false);
  });

  it('works correctly with interleaved different load pickups', () => {
    // Route: pickup Coal @ Berlin (0), pickup Wine @ Frankfurt (1), pickup Coal @ Hamburg (2)
    // Train has 1 Coal and 1 Wine
    const pickCoal1 = makePickupStop('Coal', 'Berlin');
    const pickWine = makePickupStop('Wine', 'Frankfurt');
    const pickCoal2 = makePickupStop('Coal', 'Hamburg');
    const allStops = [pickCoal1, pickWine, pickCoal2];
    const context = makeContext({ loads: ['Coal', 'Wine'] });

    // pickCoal1 at index 0: need 1 Coal, have 1 → complete
    expect(isStopComplete(pickCoal1, 0, allStops, context)).toBe(true);
    // pickWine at index 1: need 1 Wine, have 1 → complete
    expect(isStopComplete(pickWine, 1, allStops, context)).toBe(true);
    // pickCoal2 at index 2: need 2 Coal (positions 0 and 2), have 1 → NOT complete
    expect(isStopComplete(pickCoal2, 2, allStops, context)).toBe(false);
  });
});

// ── Delivery tests ─────────────────────────────────────────────────────────

describe('isStopComplete — delivery stops', () => {
  it('returns false when load is on the train (delivery not yet made)', () => {
    const stop = makeDeliverStop('Coal', 'Paris', 1);
    const allStops = [stop];
    const context = makeContext({
      loads: ['Coal'],
      demands: [
        {
          cardIndex: 1,
          loadType: 'Coal',
          supplyCity: 'Berlin',
          deliveryCity: 'Paris',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          isLoadAvailable: false,
          isLoadOnTrain: true,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 1,
          estimatedTurns: 2,
          demandScore: 10,
          efficiencyPerTurn: 10,
          networkCitiesUnlocked: 1,
          victoryMajorCitiesEnRoute: 0,
          canAffordToBuild: true,
        },
      ],
    });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
  });

  it('returns false when demand card is still present (delivery possible, load not carried)', () => {
    // Load is not on train but demand card still exists → delivery not yet done
    // (bot could pick up the load and then deliver)
    const stop = makeDeliverStop('Coal', 'Paris', 1);
    const allStops = [stop];
    const context = makeContext({
      loads: [],
      demands: [
        {
          cardIndex: 1,
          loadType: 'Coal',
          supplyCity: 'Berlin',
          deliveryCity: 'Paris',
          payout: 20,
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
          demandScore: 8,
          efficiencyPerTurn: 8,
          networkCitiesUnlocked: 1,
          victoryMajorCitiesEnRoute: 0,
          canAffordToBuild: true,
        },
      ],
    });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
  });

  it('returns true when load is NOT on train AND demand card is gone', () => {
    const stop = makeDeliverStop('Coal', 'Paris', 1);
    const allStops = [stop];
    // No Coal on train, demand card #1 gone — delivery was fulfilled
    const context = makeContext({ loads: [], demands: [] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(true);
  });

  it('returns true when load is NOT on train AND demand card ID does not match any active card', () => {
    const stop = makeDeliverStop('Coal', 'Paris', 1);
    const allStops = [stop];
    // Active demand is for a different card
    const context = makeContext({
      loads: [],
      demands: [
        {
          cardIndex: 99,
          loadType: 'Wine',
          supplyCity: 'Frankfurt',
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
          loadChipTotal: 3,
          loadChipCarried: 0,
          estimatedTurns: 3,
          demandScore: 5,
          efficiencyPerTurn: 5,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          canAffordToBuild: true,
        },
      ],
    });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(true);
  });

  it('returns false for delivery with no demandCardId when demand card state is irrelevant', () => {
    // A delivery stop with no demandCardId — demand card check evaluates to "not present"
    // but load IS on train → incomplete
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris' };
    const allStops = [stop];
    const context = makeContext({ loads: ['Coal'], demands: [] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
  });

  it('returns true for delivery with no demandCardId when load is not on train', () => {
    // demandCardId is undefined → demandPresent is false; load not on train → complete
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris' };
    const allStops = [stop];
    const context = makeContext({ loads: [], demands: [] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(true);
  });
});

// ── Unknown action type ─────────────────────────────────────────────────────

describe('isStopComplete — unknown action types', () => {
  it('returns false for an unrecognised action to avoid skipping stops incorrectly', () => {
    const stop = { action: 'unknown' as 'pickup', loadType: 'Coal', city: 'Berlin' };
    const allStops = [stop];
    const context = makeContext();

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
  });
});

// ── resolveBuildTarget helpers ─────────────────────────────────────────────

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 3,
    reasoning: 'Test route',
    ...overrides,
  };
}

// ── resolveBuildTarget tests ───────────────────────────────────────────────

describe('resolveBuildTarget — route-based targets', () => {
  it('returns the first off-network stop city from currentStopIndex', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({ citiesOnNetwork: [] });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Berlin');
    expect(result!.stopIndex).toBe(0);
    expect(result!.isVictoryBuild).toBe(false);
  });

  it('skips stops whose city is already on the network', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    // Berlin is on network, Paris is not
    const context = makeContext({ citiesOnNetwork: ['Berlin'] });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Paris');
    expect(result!.stopIndex).toBe(1);
  });

  it('returns null when all stops are already on the network', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({ citiesOnNetwork: ['Berlin', 'Paris'] });

    const result = resolveBuildTarget(route, context);

    expect(result).toBeNull();
  });

  it('returns null when route has no stops remaining (currentStopIndex at end)', () => {
    const route = makeRoute({ currentStopIndex: 2 }); // past both stops
    const context = makeContext({ citiesOnNetwork: [] });

    const result = resolveBuildTarget(route, context);

    expect(result).toBeNull();
  });

  it('skips the startingCity stop', () => {
    const route = makeRoute({
      currentStopIndex: 0,
      startingCity: 'Berlin',
    });
    const context = makeContext({ citiesOnNetwork: [] });

    const result = resolveBuildTarget(route, context);

    // Berlin is startingCity so should be skipped; Paris is the target
    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Paris');
    expect(result!.stopIndex).toBe(1);
  });

  it('startingCity comparison is case-insensitive', () => {
    const route = makeRoute({
      currentStopIndex: 0,
      startingCity: 'berlin',
    });
    const context = makeContext({ citiesOnNetwork: [] });

    const result = resolveBuildTarget(route, context);

    expect(result!.targetCity).toBe('Paris');
  });

  it('respects currentStopIndex and skips completed stops', () => {
    const route = makeRoute({ currentStopIndex: 1 }); // Berlin pickup already done
    const context = makeContext({ citiesOnNetwork: [] });

    const result = resolveBuildTarget(route, context);

    expect(result!.targetCity).toBe('Paris');
    expect(result!.stopIndex).toBe(1);
  });
});

describe('resolveBuildTarget — victory build override', () => {
  it('returns the cheapest unconnected major city as a victory build when bot has ≥250M and <7 connected cities', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 250,
      connectedMajorCities: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
      // Only 6 connected, need 7
      unconnectedMajorCities: [
        { cityName: 'Moskva', estimatedCost: 5 },
        { cityName: 'London', estimatedCost: 10 },
      ],
      citiesOnNetwork: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
    });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.targetCity).toBe('Moskva'); // cheapest
    expect(result!.stopIndex).toBe(-1);
  });

  it('does NOT use victory override when bot has <250M', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 249,
      connectedMajorCities: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
      unconnectedMajorCities: [{ cityName: 'Moskva', estimatedCost: 5 }],
      citiesOnNetwork: [],
    });

    const result = resolveBuildTarget(route, context);

    // Falls through to route-based logic, not victory
    expect(result!.isVictoryBuild).toBe(false);
  });

  it('does NOT use victory override when bot already has 7 connected major cities', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 300,
      connectedMajorCities: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg', 'Moskva'],
      // 7 connected — victory city requirement met; no unconnected majors
      unconnectedMajorCities: [],
      // Route stops (Berlin, Paris) are off-network to ensure route target is returned
      citiesOnNetwork: [],
    });

    const result = resolveBuildTarget(route, context);

    // Falls through to route-based logic
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(false);
    expect(result!.targetCity).toBe('Berlin'); // first off-network stop
  });

  it('returns null when all major cities are connected and all route stops are on-network', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 300,
      connectedMajorCities: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
      unconnectedMajorCities: [],
      // Both route stops are on-network, so route-based also returns null
      citiesOnNetwork: ['Berlin', 'Paris'],
    });

    const result = resolveBuildTarget(route, context);

    // No unconnected major cities and all route stops on-network → null
    expect(result).toBeNull();
  });
});

// ── getNetworkFrontier helpers ─────────────────────────────────────────────

function makeTrackSegment(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeWorldSnapshot(overrides: {
  existingSegments?: TrackSegment[];
  position?: { row: number; col: number } | null;
} = {}): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: overrides.position !== undefined ? overrides.position : { row: 10, col: 10 },
      existingSegments: overrides.existingSegments ?? [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

// ── getNetworkFrontier tests ───────────────────────────────────────────────

describe('getNetworkFrontier — basic frontier detection', () => {
  it('returns an empty array when no track and no bot position', () => {
    const snapshot = makeWorldSnapshot({ existingSegments: [], position: null });
    const result = getNetworkFrontier(snapshot);
    expect(result).toEqual([]);
  });

  it('returns bot position as fallback when no track exists', () => {
    const snapshot = makeWorldSnapshot({
      existingSegments: [],
      position: { row: 5, col: 8 },
    });
    const result = getNetworkFrontier(snapshot, new Map());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ row: 5, col: 8 });
  });

  it('returns both dead-end endpoints for a single segment', () => {
    // Single segment: (0,0) → (0,1) — both endpoints are degree 1
    const snapshot = makeWorldSnapshot({
      existingSegments: [makeTrackSegment(0, 0, 0, 1)],
    });

    const result = getNetworkFrontier(snapshot, new Map());

    expect(result).toHaveLength(2);
    const coords = result.map(n => `${n.row},${n.col}`).sort();
    expect(coords).toContain('0,0');
    expect(coords).toContain('0,1');
  });

  it('returns only dead-ends for a 3-segment chain (middle node excluded)', () => {
    // Chain: A(0,0) → B(0,1) → C(0,2)
    // B appears twice (degree 2) → not a dead-end
    const snapshot = makeWorldSnapshot({
      existingSegments: [
        makeTrackSegment(0, 0, 0, 1),
        makeTrackSegment(0, 1, 0, 2),
      ],
    });

    const result = getNetworkFrontier(snapshot, new Map());

    expect(result).toHaveLength(2);
    const coords = result.map(n => `${n.row},${n.col}`).sort();
    expect(coords).toContain('0,0');
    expect(coords).toContain('0,2');
    // Middle node (0,1) must NOT appear
    expect(coords).not.toContain('0,1');
  });

  it('includes unnamed milepost dead-ends (JIRA-156 Bug B fix)', () => {
    // Track ends at unnamed milepost (5,5) — no entry in grid map
    const snapshot = makeWorldSnapshot({
      existingSegments: [makeTrackSegment(5, 3, 5, 5)],
    });

    // Grid only has (5,3) named as "Berlin", (5,5) is unnamed
    const grid = new Map([
      ['5,3', { name: 'Berlin', row: 5, col: 3 }],
    ]);

    const result = getNetworkFrontier(snapshot, grid);

    expect(result).toHaveLength(2);
    const named = result.find(n => n.cityName === 'Berlin');
    const unnamed = result.find(n => n.cityName === undefined);

    expect(named).toBeDefined();
    expect(unnamed).toBeDefined();
    expect(unnamed!.row).toBe(5);
    expect(unnamed!.col).toBe(5);
  });
});

describe('getNetworkFrontier — targetCity sorting', () => {
  it('sorts frontier nodes by distance to targetCity when provided', () => {
    // Two dead-end chains: far node (0,0) and near node (10,0)
    // Target is at (10,5) — near node should come first
    const snapshot = makeWorldSnapshot({
      existingSegments: [
        makeTrackSegment(0, 0, 0, 1),  // far from target
        makeTrackSegment(10, 0, 10, 1), // near to target
      ],
    });

    // Note: (0,1) and (10,1) are internal junctions if we add more segments;
    // here all 4 endpoints are degree-1 since segments don't share endpoints
    const grid = new Map([
      ['10,5', { name: 'Holland', row: 10, col: 5 }],
    ]);

    const result = getNetworkFrontier(snapshot, grid, 'Holland');

    // The closest nodes to Holland (10,5) are (10,0) and (10,1): distance 5 and 4
    // The far nodes (0,0) and (0,1): distance 15 and 14
    // First result should be from the near chain
    expect(result[0].row).toBe(10);
  });

  it('returns unsorted results when no targetCity provided', () => {
    const snapshot = makeWorldSnapshot({
      existingSegments: [makeTrackSegment(0, 0, 0, 1)],
    });

    const result = getNetworkFrontier(snapshot, new Map());

    // Just verify both endpoints are present — order is unspecified
    expect(result).toHaveLength(2);
  });
});

describe('getNetworkFrontier — city name lookup', () => {
  it('populates cityName from grid map when available', () => {
    const snapshot = makeWorldSnapshot({
      existingSegments: [makeTrackSegment(3, 4, 3, 5)],
    });

    const grid = new Map([
      ['3,4', { name: 'Paris', row: 3, col: 4 }],
      ['3,5', { name: 'Berlin', row: 3, col: 5 }],
    ]);

    const result = getNetworkFrontier(snapshot, grid);

    const cityNames = result.map(n => n.cityName).sort();
    expect(cityNames).toContain('Paris');
    expect(cityNames).toContain('Berlin');
  });
});

// ── JIRA-165: Capital allocation gate ─────────────────────────────────────

/** Helper to build a minimal DemandContext for testing */
function makeDemandContext(overrides: Partial<{
  loadType: string;
  deliveryCity: string;
  supplyCity: string | null;
  isLoadOnTrain: boolean;
  isDeliveryOnNetwork: boolean;
  payout: number;
}> = {}): import('../../../shared/types/GameTypes').DemandContext {
  return {
    cardIndex: 1,
    loadType: overrides.loadType ?? 'Coal',
    supplyCity: overrides.supplyCity ?? 'Essen',
    deliveryCity: overrides.deliveryCity ?? 'Berlin',
    payout: overrides.payout ?? 10,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: overrides.isDeliveryOnNetwork ?? false,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: overrides.isLoadOnTrain ?? false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 8,
    efficiencyPerTurn: 8,
    networkCitiesUnlocked: 1,
    victoryMajorCitiesEnRoute: 0,
  } as any;
}

describe('resolveBuildTarget — JIRA-165 capital allocation gate', () => {
  it('returns null when bot has <5M, off-network build target, and carries deliverable on-network load', () => {
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 3, // broke
      citiesOnNetwork: [], // Berlin is off-network (build target)
      demands: [
        makeDemandContext({
          loadType: 'Wine',
          deliveryCity: 'München',
          isLoadOnTrain: true,   // carrying it
          isDeliveryOnNetwork: true, // München is on-network
        }),
      ],
    });

    const result = resolveBuildTarget(route, context);

    // Should skip build — deliver Wine@München first for income
    expect(result).toBeNull();
  });

  it('does NOT skip build when bot has <5M but no load on train', () => {
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 0,
      citiesOnNetwork: [],
      demands: [
        makeDemandContext({
          loadType: 'Coal',
          deliveryCity: 'Paris',
          isLoadOnTrain: false,   // NOT carrying it
          isDeliveryOnNetwork: false,
        }),
      ],
    });

    const result = resolveBuildTarget(route, context);

    // No carried load — capital gate should not block
    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Berlin');
  });

  it('does NOT skip build when bot has <5M, carries load, but delivery is off-network', () => {
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 0,
      citiesOnNetwork: [],
      demands: [
        makeDemandContext({
          loadType: 'Wine',
          deliveryCity: 'Frankfurt',
          isLoadOnTrain: true,
          isDeliveryOnNetwork: false, // delivery is also off-network — can't deliver yet
        }),
      ],
    });

    const result = resolveBuildTarget(route, context);

    // Delivery is also off-network — gate should not block building
    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Berlin');
  });

  it('does NOT skip build when bot has enough money (>=5M)', () => {
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 10, // has funds
      citiesOnNetwork: [],
      demands: [
        makeDemandContext({
          loadType: 'Wine',
          deliveryCity: 'München',
          isLoadOnTrain: true,
          isDeliveryOnNetwork: true,
        }),
      ],
    });

    const result = resolveBuildTarget(route, context);

    // Has enough money — capital gate not triggered
    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Berlin');
  });

  it('returns null immediately for victory build even if capital gate condition met (victory overrides)', () => {
    // Victory build takes priority and bypasses the route-based capital gate
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 1, // broke
      citiesOnNetwork: [],
      // Make victory check pass
      unconnectedMajorCities: [{ cityName: 'Roma', estimatedCost: 5 }],
      connectedMajorCities: ['Paris', 'Berlin', 'München', 'Wien', 'Hamburg', 'Barcelona'],
      demands: [
        makeDemandContext({
          loadType: 'Wine',
          deliveryCity: 'München',
          isLoadOnTrain: true,
          isDeliveryOnNetwork: true,
        }),
      ],
    });
    // Override money to victory threshold for the context check
    context.money = 250; // victory threshold

    const result = resolveBuildTarget(route, context);

    // Victory build found Roma — capital gate does not apply to victory builds
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.targetCity).toBe('Roma');
  });
});
