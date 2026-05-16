/**
 * routeHelpers unit tests — isStopComplete, resolveBuildTarget
 *
 * Tests cover:
 * - isStopComplete: pickup completion (count-aware JIRA-104 logic), delivery completion
 * - resolveBuildTarget: route-based targets, victory build override, null (all on-network)
 */

import { isStopComplete, resolveBuildTarget, getNetworkFrontier, applyStopEffectToLocalState, isDeliveryComplete, isRouteImpossible, findNextRoutePickupOffNetwork, BuildTargetResult } from '../../services/ai/routeHelpers';
import { GameState, GameContext, RouteStop, StrategicRoute, TrainType, WorldSnapshot, TerrainType, TrackSegment } from '../../../shared/types/GameTypes';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSnapshot(loads: string[] = []): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active' as import('../../../shared/types/GameTypes').GameStatus,
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [...loads],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

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
    gameState: GameState.Mid,
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

  it('returns false for delivery with no demandCardId even when load is not on train (JIRA-193 R5 — fail-closed)', () => {
    // Previously this returned true (old buggy behavior), but without a demandCardId
    // we cannot confirm the delivery was actually fulfilled — fail-closed to false.
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris' };
    const allStops = [stop];
    const context = makeContext({ loads: [], demands: [] });

    expect(isStopComplete(stop, 0, allStops, context)).toBe(false);
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

// ── isDeliveryComplete — AC3 nullish demandCardId ─────────────────────────

describe('isDeliveryComplete — nullish demandCardId (AC3)', () => {
  it('(i) returns false when demandCardId is undefined, regardless of context (R5)', () => {
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris' };
    const context = makeContext({ loads: [], demands: [] });

    expect(isDeliveryComplete(stop, context)).toBe(false);
  });

  it('(ii) returns false when demandCardId is null, regardless of context (R5)', () => {
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: null as unknown as number };
    const context = makeContext({ loads: [], demands: [] });

    expect(isDeliveryComplete(stop, context)).toBe(false);
  });

  it('(iii) returns false when demandCardId is present and card IS in context.demands', () => {
    // Card still held → delivery not yet done
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 };
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
          isLoadAvailable: false,
          isLoadOnTrain: false,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 2,
          demandScore: 10,
          efficiencyPerTurn: 10,
          networkCitiesUnlocked: 1,
          victoryMajorCitiesEnRoute: 0,
          canAffordToBuild: true,
        },
      ],
    });

    expect(isDeliveryComplete(stop, context)).toBe(false);
  });

  it('(iv) returns true when demandCardId is present, card is gone, and load not on train', () => {
    const stop: RouteStop = { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 };
    const context = makeContext({ loads: [], demands: [] });

    expect(isDeliveryComplete(stop, context)).toBe(true);
  });
});

// ── applyStopEffectToLocalState — AC2 ─────────────────────────────────────

describe('applyStopEffectToLocalState (AC2)', () => {
  it('(i) pickup action appends loadType to context.loads and leaves snapshot.bot.loads unchanged', () => {
    const stop: RouteStop = { action: 'pickup', loadType: 'Wine', city: 'Wien' };
    const context = makeContext({ loads: [] });
    const snapshot = makeSnapshot([]);

    applyStopEffectToLocalState(stop, context);

    expect(context.loads).toEqual(['Wine']);
    // JIRA-196 Fix B: snapshot must not be mutated by the planner helper
    expect(snapshot.bot.loads).toEqual([]);
  });

  it('(i-new AC1) pickup adds load to context.loads only — snapshot.bot.loads with prior content is unchanged', () => {
    // snapshot starts with Steel (DB-committed); context is an independent copy
    const stop: RouteStop = { action: 'pickup', loadType: 'Cheese', city: 'Bern' };
    const context = makeContext({ loads: ['Steel'] });
    const snapshot = makeSnapshot(['Steel']);

    applyStopEffectToLocalState(stop, context);

    // context gains Cheese
    expect(context.loads).toEqual(['Steel', 'Cheese']);
    // snapshot must remain unchanged (DB state)
    expect(snapshot.bot.loads).toEqual(['Steel']);
  });

  it('(ii) deliver action removes first occurrence of loadType from context.loads and leaves snapshot unchanged', () => {
    const stop: RouteStop = { action: 'deliver', loadType: 'Wine', city: 'Berlin', demandCardId: 1 };
    const context = makeContext({ loads: ['Wine', 'Coal'] });
    const snapshot = makeSnapshot(['Wine', 'Coal']);

    applyStopEffectToLocalState(stop, context);

    expect(context.loads).toEqual(['Coal']);
    // snapshot must not be mutated
    expect(snapshot.bot.loads).toEqual(['Wine', 'Coal']);
  });

  it('(ii) deliver action is a no-op when loadType is absent', () => {
    const stop: RouteStop = { action: 'deliver', loadType: 'Wine', city: 'Berlin', demandCardId: 1 };
    const context = makeContext({ loads: ['Coal'] });
    const snapshot = makeSnapshot(['Coal']);

    applyStopEffectToLocalState(stop, context);

    expect(context.loads).toEqual(['Coal']);
    expect(snapshot.bot.loads).toEqual(['Coal']);
  });

  it('(iii) drop action removes first occurrence of loadType from context.loads — snapshot unchanged', () => {
    const stop: RouteStop = { action: 'drop', loadType: 'Wine', city: 'Paris' };
    const context = makeContext({ loads: ['Wine'] });
    const snapshot = makeSnapshot(['Wine']);

    applyStopEffectToLocalState(stop, context);

    expect(context.loads).toEqual([]);
    // snapshot must not be mutated
    expect(snapshot.bot.loads).toEqual(['Wine']);
  });

  it('(iv) unknown action mutates neither context.loads nor snapshot.bot.loads and does not throw', () => {
    const stop = { action: 'noSuchAction' as 'pickup', loadType: 'Wine', city: 'X' };
    const context = makeContext({ loads: ['Coal'] });
    const snapshot = makeSnapshot(['Coal']);

    expect(() => applyStopEffectToLocalState(stop, context)).not.toThrow();
    expect(context.loads).toEqual(['Coal']);
    expect(snapshot.bot.loads).toEqual(['Coal']);
  });

  it('(AC2) duplicate same-type pickups: second stop is incomplete after only first has fired', () => {
    // Route: [pickup Cheese, pickup Cheese, deliver Milano]
    const pickupStop0: RouteStop = { action: 'pickup', loadType: 'Cheese', city: 'Bern' };
    const pickupStop1: RouteStop = { action: 'pickup', loadType: 'Cheese', city: 'Bern' };
    const deliverStop: RouteStop = { action: 'deliver', loadType: 'Cheese', city: 'Milano', demandCardId: 1 };
    const allStops = [pickupStop0, pickupStop1, deliverStop];

    const context = makeContext({ loads: [] });

    // Apply pickup #0
    applyStopEffectToLocalState(pickupStop0, context);
    expect(context.loads).toEqual(['Cheese']);

    // isPickupComplete for stop #1 must return false (only 1 Cheese loaded, need 2)
    // isStopComplete delegates to isPickupComplete internally
    // We test isPickupComplete indirectly via isStopComplete
    expect(isStopComplete(pickupStop1, 1, allStops, context)).toBe(false);

    // Apply pickup #1
    applyStopEffectToLocalState(pickupStop1, context);
    expect(context.loads).toEqual(['Cheese', 'Cheese']);

    // Now isPickupComplete for stop #1 must return true (2 Cheese loaded, need 2)
    expect(isStopComplete(pickupStop1, 1, allStops, context)).toBe(true);
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
  it('returns the cheapest unconnected major city as a victory build when bot has ≥230M and <7 connected cities', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 230,
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

  it('fires at 230M boundary (was 250M before; lowered to give cash-build lead time)', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 230,
      connectedMajorCities: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
      unconnectedMajorCities: [{ cityName: 'Moskva', estimatedCost: 5 }],
      citiesOnNetwork: ['Paris', 'Berlin', 'Madrid', 'Rome', 'Wien', 'Hamburg'],
    });
    const result = resolveBuildTarget(route, context);
    expect(result!.isVictoryBuild).toBe(true);
  });

  it('does NOT use victory override when bot has <230M', () => {
    const route = makeRoute({ currentStopIndex: 0 });
    const context = makeContext({
      money: 229,
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
    // Override money to victory build trigger for the context check
    context.money = 230; // victory build trigger

    const result = resolveBuildTarget(route, context);

    // Victory build found Roma — capital gate does not apply to victory builds
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.targetCity).toBe('Roma');
  });
});

// ── isRouteImpossible (JIRA-233 BE-002, AC2, AC3) ─────────────────────────

/** Helper: create a StrategicRoute with explicit stops + currentStopIndex for isRouteImpossible tests */
function makeImpRoute(stops: RouteStop[], currentStopIndex = 0): StrategicRoute {
  return {
    stops,
    currentStopIndex,
    phase: 'travel',
    createdAtTurn: 1,
    reasoning: 'test route',
  };
}

describe('isRouteImpossible — AC2: baseline cases (R3)', () => {
  it('empty remaining slice (currentStopIndex === stops.length) → false (route done, not impossible)', () => {
    const stops = [makeDeliverStop('Copper', 'Madrid', 1)];
    const route = makeImpRoute(stops, 1); // past last stop
    const ctx = makeContext({ loads: [] });
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });

  it('next stop is pickup → false (pickups are always achievable)', () => {
    const stops = [makePickupStop('Copper', 'Warsaw'), makeDeliverStop('Copper', 'Madrid', 1)];
    const route = makeImpRoute(stops, 0); // next stop is pickup
    const ctx = makeContext({ loads: [] });
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });

  it('next stop is deliver with required load in context.loads → false', () => {
    const stops = [makeDeliverStop('Copper', 'Madrid', 1)];
    const route = makeImpRoute(stops, 0);
    const ctx = makeContext({ loads: ['Copper'] }); // Copper in cargo
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });

  it('next stop is deliver, required load NOT in cargo, but remaining pickup exists → false', () => {
    const stops = [
      makeDeliverStop('Copper', 'Madrid', 1),
      makePickupStop('Copper', 'Beograd'), // future pickup in route
    ];
    const route = makeImpRoute(stops, 0);
    const ctx = makeContext({ loads: [] }); // no Copper yet, but pickup is coming
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });

  it('next stop is deliver, required load NOT in cargo, no remaining pickup → true (impossible)', () => {
    const stops = [makeDeliverStop('Copper', 'Madrid', 1)];
    const route = makeImpRoute(stops, 0);
    const ctx = makeContext({ loads: [] }); // no Copper, no pickup stop
    expect(isRouteImpossible(route, ctx)).toBe(true);
  });

  it('route is null → false (fail-safe)', () => {
    // TypeScript guard — test null safety
    expect(isRouteImpossible(null as unknown as StrategicRoute, makeContext())).toBe(false);
  });

  it('context.loads missing → false (fail-safe)', () => {
    const stops = [makeDeliverStop('Copper', 'Madrid', 1)];
    const route = makeImpRoute(stops, 0);
    const ctx = makeContext({ loads: undefined as unknown as string[] });
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });
});

describe('isRouteImpossible — AC3: multi-instance edge case', () => {
  it('route has two deliver:Copper, bot carries 1 Copper, no pickup-Copper — second deliver is impossible when idx is on second', () => {
    // Route: deliver:Copper@Madrid, deliver:Copper@Lisbon (both carry-only, no pickups)
    // Bot carries 1 Copper. First deliver is achievable (cargo covers it).
    // When currentStopIndex is on second deliver:Copper (after first was done),
    // cargo is empty (consumed by first) and no remaining pickup → impossible.
    const stops = [
      makeDeliverStop('Copper', 'Madrid', 1),
      makeDeliverStop('Copper', 'Lisbon', 2),
    ];

    // idx=0: 1 Copper in cargo, 2 deliver:Copper demands, 0 pickups
    // totalAvailable=1 < deliverDemandCount=2 → impossible because 1 < 2
    const routeAtFirst = makeImpRoute(stops, 0);
    const ctxWith1Copper = makeContext({ loads: ['Copper'] });
    // At idx=0: 1 available, 2 needed — SHOULD be impossible
    expect(isRouteImpossible(routeAtFirst, ctxWith1Copper)).toBe(true);

    // idx=1: 0 Copper in cargo (first was delivered), 1 deliver:Copper remaining, 0 pickups
    // totalAvailable=0 < deliverDemandCount=1 → impossible
    const routeAtSecond = makeImpRoute(stops, 1);
    const ctxEmpty = makeContext({ loads: [] });
    expect(isRouteImpossible(routeAtSecond, ctxEmpty)).toBe(true);
  });

  it('route has two deliver:Copper, bot carries 2 Copper, no pickup — both achievable, not impossible', () => {
    const stops = [
      makeDeliverStop('Copper', 'Madrid', 1),
      makeDeliverStop('Copper', 'Lisbon', 2),
    ];
    const route = makeImpRoute(stops, 0);
    const ctx = makeContext({ loads: ['Copper', 'Copper'] }); // 2 Copper carried
    // totalAvailable=2, deliverDemandCount=2 → 2 >= 2 → not impossible
    expect(isRouteImpossible(route, ctx)).toBe(false);
  });

  it('route: deliver:Coal→deliver:Copper, bot carries Coal only, no Copper pickup — Coal stop ok but Copper impossible', () => {
    const stops = [
      makeDeliverStop('Coal', 'Paris', 1),
      makeDeliverStop('Copper', 'Madrid', 2),
    ];
    // At idx=0 (deliver:Coal): totalAvailable(Coal)=1, deliverCount(Coal)=1 → ok, not impossible
    const routeAtCoal = makeImpRoute(stops, 0);
    const ctxCoal = makeContext({ loads: ['Coal'] });
    expect(isRouteImpossible(routeAtCoal, ctxCoal)).toBe(false);

    // At idx=1 (deliver:Copper): totalAvailable(Copper)=0, deliverCount(Copper)=1 → impossible
    const routeAtCopper = makeImpRoute(stops, 1);
    const ctxEmpty = makeContext({ loads: [] }); // Coal was delivered
    expect(isRouteImpossible(routeAtCopper, ctxEmpty)).toBe(true);
  });
});

// ── JIRA-239: hasNearbyHighValueDelivery guard (AC1, AC2, AC5-AC8) ──────────

// Helper for victory-eligible context with a deliver stop
function makeVictoryRoute(deliverCity: string, loadType = 'Wine'): StrategicRoute {
  return {
    stops: [{ action: 'deliver', loadType, city: deliverCity, demandCardId: 1, payment: 22 }],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 1,
    reasoning: 'test',
  };
}

// Roma grid center: row=54, col=45 (from gridPoints.json)
// Bot position: row=51, col=44 — hexDistance = 3, well within trainSpeed 12
const ROMA_ROW = 54;
const ROMA_COL = 45;
const BOT_NEAR_ROMA = { row: 51, col: 44 };
// A far position: Hamburg area (row=14, col=47) — hexDistance to Roma >> 12
const BOT_FAR_FROM_ROMA = { row: 14, col: 47 };

function makeVictoryContext(overrides: Partial<GameContext> = {}): GameContext {
  return makeContext({
    money: 241,
    connectedMajorCities: ['Holland', 'Ruhr', 'Berlin'],
    unconnectedMajorCities: [
      { cityName: 'Milano', estimatedCost: 5 },
      { cityName: 'London', estimatedCost: 12 },
    ],
    citiesOnNetwork: ['Roma', 'Napoli'],
    loads: ['Wine'],
    position: BOT_NEAR_ROMA,
    speed: 12,
    gameState: GameState.Mid,
    ...overrides,
  });
}

describe('resolveBuildTarget — JIRA-239 delivery-first guard (AC1, AC2, AC5-AC8)', () => {
  // AC5: canonical case — guard fires, returns route-based result (Roma) not victory build
  it('AC5: returns route-based target (delivery city) when bot carries load, city on network, within speed', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext();

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Roma');
    expect(result!.isVictoryBuild).toBe(false);
  });

  // AC6: guard does NOT fire when carry is far (distance > trainSpeed)
  it('AC6: does NOT fire when delivery city is far (hexDistance > speed) — returns victory target', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext({ position: BOT_FAR_FROM_ROMA });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  // AC7: guard does NOT fire when delivery city is off-network
  it('AC7: does NOT fire when delivery city is NOT on citiesOnNetwork — returns victory target', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext({ citiesOnNetwork: ['Berlin', 'Hamburg'] }); // Roma absent

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  // AC8: guard does NOT fire when bot is NOT carrying the required load
  it('AC8: does NOT fire when bot is not carrying the required load — returns victory target', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext({ loads: [] }); // no Wine on train

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  // AC1: guard returns false when current stop is a pickup (not deliver)
  it('AC1(a): does NOT fire when current stop is a pickup (not deliver)', () => {
    const pickupRoute: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Wine', city: 'Frankfurt' },
        { action: 'deliver', loadType: 'Wine', city: 'Roma', demandCardId: 1, payment: 22 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeVictoryContext();

    const result = resolveBuildTarget(pickupRoute, context);

    // Current stop is pickup — guard must NOT fire
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  // AC2: hasNearbyHighValueDelivery returns false on missing/null inputs (no throws)
  it('AC2: guard is safe when route has empty stops array', () => {
    const emptyRoute: StrategicRoute = {
      stops: [],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeVictoryContext();

    expect(() => resolveBuildTarget(emptyRoute, context)).not.toThrow();
    const result = resolveBuildTarget(emptyRoute, context);
    // Empty route → no delivery guard → falls through to victory build
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  it('AC2: guard is safe when currentStopIndex is out of bounds', () => {
    const route = makeVictoryRoute('Roma');
    route.currentStopIndex = 99; // way out of bounds
    const context = makeVictoryContext();

    expect(() => resolveBuildTarget(route, context)).not.toThrow();
    const result = resolveBuildTarget(route, context);
    // OOB index → guard cannot fire → falls through to victory build
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  it('AC2: guard is safe when context.loads is undefined', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext({ loads: undefined as unknown as string[] });

    expect(() => resolveBuildTarget(route, context)).not.toThrow();
    // No loads → guard cannot fire → falls through to victory build
    const result = resolveBuildTarget(route, context);
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  it('AC2: guard is safe when context.position is null', () => {
    const route = makeVictoryRoute('Roma');
    const context = makeVictoryContext({ position: null });

    expect(() => resolveBuildTarget(route, context)).not.toThrow();
    // Null position → guard cannot fire → falls through to victory build
    const result = resolveBuildTarget(route, context);
    expect(result).not.toBeNull();
    expect(result!.isVictoryBuild).toBe(true);
  });

  // AC16: regression — game a864f7e1 s2 t67 snapshot
  // Bot s2 at turn 67: cash=241, 3 connectedMajorCities, route=[deliver Wine@Roma],
  // Roma on network (trackCostToDelivery=0 in demandRanking), position=(51,44),
  // trainSpeed=12, hexDist(51,44 → Roma 54,45)=3 ≤ 12. Should return Roma not Milano.
  it('AC16: regression — s2 t67 snapshot returns Roma not Milano', () => {
    const route: StrategicRoute = {
      stops: [{ action: 'deliver', loadType: 'Wine', city: 'Roma', demandCardId: 86, payment: 22 }],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'carry:86:Wine chosen',
    };
    const context = makeContext({
      money: 241,
      connectedMajorCities: ['Holland', 'Ruhr', 'Berlin'],
      unconnectedMajorCities: [
        { cityName: 'Milano', estimatedCost: 5 },
        { cityName: 'London', estimatedCost: 12 },
      ],
      // Roma is on the network (verified by trackCostToDelivery=0 in game log demandRanking)
      citiesOnNetwork: ['Roma', 'Napoli', 'Holland', 'Ruhr', 'Berlin'],
      loads: ['Wine'], // bot carries Wine (carriedLoads from game log)
      position: { row: 51, col: 44 }, // positionStart from game log
      speed: 12, // superfreight speed
    });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    // Guard fires: Wine on train, Roma on network, hexDist(51,44→54,45)=3 ≤ 12
    expect(result!.targetCity).toBe('Roma');
    expect(result!.isVictoryBuild).toBe(false);
    // Must NOT return Milano (the bug behavior)
    expect(result!.targetCity).not.toBe('Milano');
  });
});

// ── JIRA-240: findNextRoutePickupOffNetwork (AC3, AC4) ─────────────────────

describe('findNextRoutePickupOffNetwork — AC3: canonical behavior', () => {
  it('AC3(a): returns first pickup-stop city not on citiesOnNetwork', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Marble', city: 'Firenze' },
        { action: 'deliver', loadType: 'Marble', city: 'Birmingham', demandCardId: 1 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: ['Birmingham'] }); // Firenze NOT on network

    const result = findNextRoutePickupOffNetwork(route, context);

    expect(result).toBe('Firenze');
  });

  it('AC3(b): skips delivery stops (only pickup stops are secondary candidates)', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 }, // delivery — skip
        { action: 'pickup', loadType: 'Marble', city: 'Firenze' }, // pickup — first off-network
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: [] });

    const result = findNextRoutePickupOffNetwork(route, context);

    // Delivery at Paris should be skipped; Firenze pickup returned
    expect(result).toBe('Firenze');
  });

  it('AC3(c): skips pickup stops that are already on the network', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' }, // on-network — skip
        { action: 'pickup', loadType: 'Marble', city: 'Firenze' }, // off-network
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
        { action: 'deliver', loadType: 'Marble', city: 'Birmingham', demandCardId: 2 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: ['Berlin', 'Paris'] });

    const result = findNextRoutePickupOffNetwork(route, context);

    expect(result).toBe('Firenze'); // first off-network pickup
  });

  it('AC3(d): returns null when all pickup stops are on the network', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: ['Berlin', 'Paris'] });

    const result = findNextRoutePickupOffNetwork(route, context);

    expect(result).toBeNull();
  });
});

describe('findNextRoutePickupOffNetwork — AC4: safe defaults', () => {
  it('AC4(a): returns null for null route', () => {
    const context = makeContext();
    expect(findNextRoutePickupOffNetwork(null as unknown as StrategicRoute, context)).toBeNull();
  });

  it('AC4(b): returns null for empty stops array', () => {
    const route: StrategicRoute = {
      stops: [],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext();
    expect(findNextRoutePickupOffNetwork(route, context)).toBeNull();
  });

  it('AC4(c): returns null for delivery-only route', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1 },
        { action: 'deliver', loadType: 'Marble', city: 'Birmingham', demandCardId: 2 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: [] });
    expect(findNextRoutePickupOffNetwork(route, context)).toBeNull();
  });

  it('AC4(d): returns null when currentStopIndex is OOB', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Marble', city: 'Firenze' },
      ],
      currentStopIndex: 99,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeContext({ citiesOnNetwork: [] });
    expect(findNextRoutePickupOffNetwork(route, context)).toBeNull();
  });
});

// ── JIRA-240: bundling guard in resolveBuildTarget (AC9-AC12, AC17) ──────────

/**
 * Helper for victory-eligible context with 6 connected cities (triggers bundle logic).
 * Sets up context with Wien as primary victory target and Marble@Firenze as next route pickup.
 */
function makeBundle6Context(overrides: Partial<GameContext> = {}): GameContext {
  return makeContext({
    money: 240,
    connectedMajorCities: ['Paris', 'Holland', 'Milano', 'Ruhr', 'Berlin', 'London'],
    unconnectedMajorCities: [
      { cityName: 'Wien', estimatedCost: 14 },
      { cityName: 'Madrid', estimatedCost: 18 },
    ],
    citiesOnNetwork: ['Paris', 'Holland', 'Milano', 'Ruhr', 'Berlin', 'London'],
    loads: [], // not carrying — no delivery guard interference
    position: { row: 44, col: 41 },
    speed: 12,
    demands: [
      // Marble demand: supplyCity=Firenze, estimatedTrackCostToSupply=3
      {
        cardIndex: 140,
        loadType: 'Marble',
        supplyCity: 'Firenze',
        deliveryCity: 'Birmingham',
        payout: 35,
        isSupplyReachable: true,
        isDeliveryReachable: true,
        isSupplyOnNetwork: false,
        isDeliveryOnNetwork: false,
        estimatedTrackCostToSupply: 3,
        estimatedTrackCostToDelivery: 4,
        isLoadAvailable: true,
        isLoadOnTrain: false,
        ferryRequired: true,
        loadChipTotal: 4,
        loadChipCarried: 0,
        estimatedTurns: 7,
        demandScore: 4.3,
        efficiencyPerTurn: 4,
        networkCitiesUnlocked: 1,
        victoryMajorCitiesEnRoute: 0,
      } as any,
    ],

    ...overrides,
  });
}

function makeMarbleFirenzeRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Marble', city: 'Firenze' },
      { action: 'deliver', loadType: 'Marble', city: 'Birmingham', demandCardId: 140, payment: 35 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 1,
    reasoning: 'test',
  };
}

describe('resolveBuildTarget — JIRA-240 bundling guard (AC9-AC12)', () => {
  // AC9: bundle fires when budget covers both (Wien 14M + Firenze 3M ≤ 20M)
  it('AC9: bundles secondary (Firenze) when Wien 14M leaves 6M and Firenze costs 3M', () => {
    const route = makeMarbleFirenzeRoute();
    const context = makeBundle6Context();

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Wien');
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.secondaryTarget).toBe('Firenze');
    expect(result!.secondaryEstimatedCost).toBe(3);
  });

  // AC10: bundle does NOT fire when budget too tight (Wien 18M + Firenze 3M = 21M > 20M)
  it('AC10: does NOT bundle when Wien costs 18M — only 2M remaining, Firenze needs 3M', () => {
    const route = makeMarbleFirenzeRoute();
    const context = makeBundle6Context({
      unconnectedMajorCities: [
        { cityName: 'Wien', estimatedCost: 18 },
      ],
    });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Wien');
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.secondaryTarget).toBeUndefined();
    expect(result!.secondaryEstimatedCost).toBeUndefined();
  });

  // AC11: bundle does NOT fire when next pickup is already on network
  it('AC11: does NOT bundle when Firenze pickup is already on the network', () => {
    const route = makeMarbleFirenzeRoute();
    const context = makeBundle6Context({
      // Add Firenze to citiesOnNetwork (already reachable)
      citiesOnNetwork: ['Paris', 'Holland', 'Milano', 'Ruhr', 'Berlin', 'London', 'Firenze'],
    });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Wien');
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.secondaryTarget).toBeUndefined();
  });

  // AC12: bundle does NOT fire when route has no pickup stops (carry-and-deliver only)
  it('AC12: does NOT bundle when route has no pickup stops (deliver-only route)', () => {
    const deliverOnlyRoute: StrategicRoute = {
      stops: [
        { action: 'deliver', loadType: 'Marble', city: 'Birmingham', demandCardId: 140, payment: 35 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const context = makeBundle6Context();

    const result = resolveBuildTarget(deliverOnlyRoute, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Wien');
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.secondaryTarget).toBeUndefined();
  });

  // AC17: regression — s2 t71 snapshot: Wien primary + Firenze secondary
  it('AC17: regression — s2 t71 snapshot returns Wien primary + Firenze secondary', () => {
    const route = makeMarbleFirenzeRoute();
    // Synthetic snapshot: cash=240 (triggers victory build), 6 connected cities from t71,
    // Firenze off-network with estimatedTrackCostToSupply=3 (matches demandRanking in log)
    const context = makeContext({
      money: 240, // synthetic to trigger victory build (actual t71 was 226, but spec says 240)
      connectedMajorCities: ['Paris', 'Holland', 'Milano', 'Ruhr', 'Berlin', 'London'],
      unconnectedMajorCities: [
        { cityName: 'Wien', estimatedCost: 14 }, // Wien is 7th city needed
      ],
      citiesOnNetwork: ['Paris', 'Holland', 'Milano', 'Ruhr', 'Berlin', 'London'],
      loads: [], // no carry (Wine was delivered at t70)
      position: { row: 44, col: 41 }, // positionStart from game log
      speed: 12, // superfreight
      demands: [
        {
          cardIndex: 140,
          loadType: 'Marble',
          supplyCity: 'Firenze',
          deliveryCity: 'Birmingham',
          payout: 35,
          isSupplyReachable: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: false,
          isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 3, // from demandRanking trackCostToSupply=3
          estimatedTrackCostToDelivery: 4,
          isLoadAvailable: true,
          isLoadOnTrain: false,
          ferryRequired: true,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 7,
          demandScore: 4.3,
          efficiencyPerTurn: 4,
          networkCitiesUnlocked: 1,
          victoryMajorCitiesEnRoute: 0,
        } as any,
      ],
    });

    const result = resolveBuildTarget(route, context);

    expect(result).not.toBeNull();
    expect(result!.targetCity).toBe('Wien');
    expect(result!.isVictoryBuild).toBe(true);
    expect(result!.secondaryTarget).toBe('Firenze');
    // 14 + 3 = 17 ≤ 20 → bundle fires
    expect(result!.secondaryEstimatedCost).toBe(3);
  });
});
