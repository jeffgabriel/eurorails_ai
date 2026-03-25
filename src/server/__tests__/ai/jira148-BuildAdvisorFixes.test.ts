/**
 * JIRA-148: Tests for BuildAdvisor prompt cleanup and target validation.
 */

import { getBuildAdvisorPrompt } from '../../services/ai/prompts/systemPrompts';
import {
  GameContext,
  StrategicRoute,
  DemandContext,
} from '../../../shared/types/GameTypes';

// ── Prompt test helpers ──────────────────────────────────────────────────────

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '1 segment',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: ['Berlin'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 5,
    ...overrides,
  };
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Frankfurt',
    payout: 12,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 5,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 2.5,
    efficiencyPerTurn: 1.5,
    corridorCities: 2,
    onRoute: false,
    ...overrides,
  };
}

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JIRA-148: getBuildAdvisorPrompt — no demand cards', () => {
  it('should NOT include DEMAND CARDS section in the prompt', () => {
    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', deliveryCity: 'Frankfurt', payout: 12 }),
        makeDemand({ cardIndex: 2, loadType: 'Wine', deliveryCity: 'Wien', payout: 18 }),
        makeDemand({ cardIndex: 3, loadType: 'Cars', deliveryCity: 'Marseille', payout: 10 }),
      ],
    });
    const route = makeRoute();
    const corridorMap = { rendered: 'test corridor', bounds: { minRow: 0, maxRow: 20, minCol: 0, maxCol: 20 } };

    const { user } = getBuildAdvisorPrompt(context, route, corridorMap);

    expect(user).not.toContain('DEMAND CARDS');
    expect(user).not.toContain('Coal from Essen');
    expect(user).not.toContain('Wine from');
    expect(user).not.toContain('Cars from');
  });

  it('should still include other sections (corridor map, route, cash)', () => {
    const context = makeContext({ demands: [makeDemand()] });
    const route = makeRoute();
    const corridorMap = { rendered: 'test corridor map', bounds: { minRow: 0, maxRow: 20, minCol: 0, maxCol: 20 } };

    const { user } = getBuildAdvisorPrompt(context, route, corridorMap);

    expect(user).toContain('CORRIDOR MAP');
    expect(user).toContain('ACTIVE ROUTE');
    expect(user).toContain('CASH');
    expect(user).toContain('CARRIED LOADS');
  });
});
