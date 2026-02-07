/**
 * Shared test helpers and fixtures for AI integration tests.
 *
 * These tests exercise the AI pipeline components working together
 * (OptionGenerator → Scorer → PlanValidator flow) with mocked DB/Socket
 * but real business logic.
 */
import type { WorldSnapshot, FeasibleOption, TurnPlan, TurnPlanAction } from '../../../../shared/types/AITypes';
import { AIActionType } from '../../../../shared/types/AITypes';
import type { AIDifficulty, AIArchetype } from '../../../../shared/types/AITypes';
import { TrainType } from '../../../../shared/types/GameTypes';
import { LoadType } from '../../../../shared/types/LoadTypes';
import type { DemandCard } from '../../../../shared/types/DemandCard';
import type { ScoredOption } from '../../../services/ai/Scorer';

// --- Snapshot Factories ---

/**
 * Create a minimal WorldSnapshot for integration testing.
 * Override any field by passing partial data.
 */
export function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  const defaults: WorldSnapshot = {
    botPlayerId: 'bot-1',
    botPosition: { x: 100, y: 200, row: 10, col: 15 },
    trackNetworkGraph: new Map([
      ['10,15', new Set(['10,16', '11,15'])],
      ['10,16', new Set(['10,15', '10,17'])],
      ['11,15', new Set(['10,15', '12,15'])],
      ['10,17', new Set(['10,16'])],
      ['12,15', new Set(['11,15'])],
    ]),
    cash: 100,
    demandCards: [
      makeDemandCard(1, 'Berlin', LoadType.Steel, 30),
      makeDemandCard(2, 'Paris', LoadType.Wine, 20),
      makeDemandCard(3, 'London', LoadType.Coal, 15),
    ],
    carriedLoads: [LoadType.Steel],
    trainType: TrainType.Freight,
    otherPlayers: [
      {
        playerId: 'player-2',
        position: { x: 50, y: 50, row: 5, col: 8 },
        carriedLoads: [],
        trainType: TrainType.Freight,
        cash: 80,
        connectedMajorCities: 2,
      },
    ],
    globalLoadAvailability: [
      { loadType: LoadType.Steel, totalCount: 4, availableCount: 2, cities: ['Essen'] },
      { loadType: LoadType.Wine, totalCount: 3, availableCount: 2, cities: ['Bordeaux'] },
      { loadType: LoadType.Coal, totalCount: 5, availableCount: 3, cities: ['Cardiff'] },
      { loadType: LoadType.Oil, totalCount: 4, availableCount: 4, cities: ['Stavanger'] },
      { loadType: LoadType.Wheat, totalCount: 4, availableCount: 3, cities: ['Warszawa'] },
    ],
    activeEvents: [],
    mapTopology: [],
    majorCityConnectionStatus: new Map([
      ['Berlin', true],
      ['Paris', false],
      ['London', false],
      ['Madrid', false],
      ['Roma', false],
      ['Wien', false],
      ['Warszawa', false],
    ]),
    turnNumber: 5,
    snapshotHash: 'test-snapshot-hash',
  } as unknown as WorldSnapshot;

  return { ...defaults, ...overrides } as unknown as WorldSnapshot;
}

/**
 * Create a snapshot with rich state (more cash, loads, connections) for long-running tests.
 */
export function makeRichSnapshot(turnNumber: number): WorldSnapshot {
  return makeSnapshot({
    cash: 150,
    carriedLoads: [LoadType.Steel, LoadType.Wine],
    trainType: TrainType.FastFreight,
    turnNumber,
    snapshotHash: `snapshot-turn-${turnNumber}`,
    majorCityConnectionStatus: new Map([
      ['Berlin', true],
      ['Paris', true],
      ['London', false],
      ['Madrid', false],
      ['Roma', false],
      ['Wien', false],
      ['Warszawa', false],
    ]),
  });
}

// --- Demand Card Factory ---

export function makeDemandCard(
  id: number,
  city: string,
  resource: LoadType,
  payment: number,
): DemandCard {
  return {
    id,
    demands: [
      { city, resource, payment },
      { city: 'Hamburg', resource: LoadType.Fish, payment: 10 },
      { city: 'Milano', resource: LoadType.Marble, payment: 12 },
    ],
  };
}

// --- Option Factories ---

export function makeOption(
  type: AIActionType,
  id: string,
  params: Record<string, unknown> = {},
): FeasibleOption {
  return {
    id,
    type,
    parameters: params,
    score: 0,
    feasible: true,
    rejectionReason: null,
  };
}

export function makeScoredOption(
  type: AIActionType,
  id: string,
  finalScore: number,
  params: Record<string, unknown> = {},
): ScoredOption {
  return {
    ...makeOption(type, id, params),
    finalScore,
    dimensionScores: {},
  };
}

// --- Plan Factory ---

export function makePlan(
  actions: TurnPlanAction[],
  archetype: AIArchetype = 'opportunist',
  difficulty: AIDifficulty = 'hard',
  totalScore: number = 50,
): TurnPlan {
  return {
    actions,
    expectedOutcome: {
      cashChange: 0,
      loadsDelivered: actions.filter(a => a.type === AIActionType.DeliverLoad).length,
      trackSegmentsBuilt: actions.filter(
        a => a.type === AIActionType.BuildTrack || a.type === AIActionType.BuildTowardMajorCity,
      ).length,
      newMajorCitiesConnected: 0,
    },
    totalScore,
    archetype,
    skillLevel: difficulty,
  };
}

// --- Mock DB Setup ---

export interface MockDbSetup {
  mockQuery: jest.Mock;
  mockConnect: jest.Mock;
  mockClient: {
    query: jest.Mock;
    release: jest.Mock;
  };
}

/**
 * Create a standard mock DB configuration for integration tests.
 * Returns the mock functions so tests can customize behavior.
 */
export function createMockDb(): MockDbSetup {
  const mockClientQuery = jest.fn();
  const mockRelease = jest.fn();
  const mockClient = { query: mockClientQuery, release: mockRelease };
  const mockConnect = jest.fn().mockResolvedValue(mockClient);
  const mockQuery = jest.fn();

  return {
    mockQuery,
    mockConnect,
    mockClient,
  };
}

/**
 * Configure mock DB to return a bot player config row.
 */
export function configureBotConfigResponse(
  mockQuery: jest.Mock,
  config: { difficulty: AIDifficulty; archetype: AIArchetype; turnNumber: number } = {
    difficulty: 'hard',
    archetype: 'opportunist',
    turnNumber: 5,
  },
): void {
  mockQuery.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM players')) {
      return {
        rows: [{
          ai_difficulty: config.difficulty,
          ai_archetype: config.archetype,
          current_turn_number: config.turnNumber,
        }],
      };
    }
    // Audit INSERT
    return { rows: [] };
  });
}

// --- Constants ---

export const ALL_DIFFICULTIES: AIDifficulty[] = ['easy', 'medium', 'hard'];
export const ALL_ARCHETYPES: AIArchetype[] = [
  'backbone_builder',
  'freight_optimizer',
  'trunk_sprinter',
  'continental_connector',
  'opportunist',
];
