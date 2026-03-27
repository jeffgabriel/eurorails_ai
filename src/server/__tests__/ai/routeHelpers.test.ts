/**
 * routeHelpers unit tests — isStopComplete
 *
 * Tests cover:
 * - Pickup completion (count-aware JIRA-104 logic)
 * - Delivery completion (load gone + demand card gone)
 * - Edge cases: multiple same-type pickups, missing demandCardId
 */

import { isStopComplete } from '../../services/ai/routeHelpers';
import { GameContext, RouteStop } from '../../../shared/types/GameTypes';
import { TrainType } from '../../../shared/types/GameTypes';

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
