import { PlanExecutor, PlanExecutionResult } from '../../services/ai/PlanExecutor';
import {
  DeliveryPlan,
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotMemoryState,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { Scorer } from '../../services/ai/Scorer';

// Mock Scorer — return options in the same order (no reranking)
jest.mock('../../services/ai/Scorer', () => ({
  Scorer: {
    score: jest.fn((options: FeasibleOption[]) => [...options]),
  },
}));

// Mock MapTopology — two cities: PickupCity at (5,5) and DeliveryCity at (15,10)
const mockGridPoints = new Map<string, { row: number; col: number; name?: string; terrain?: number }>([
  ['5,5', { row: 5, col: 5, name: 'PickupCity', terrain: TerrainType.MajorCity }],
  ['5,6', { row: 5, col: 6, terrain: TerrainType.Clear }],
  ['10,8', { row: 10, col: 8, terrain: TerrainType.Clear }],
  ['15,10', { row: 15, col: 10, name: 'DeliveryCity', terrain: TerrainType.MajorCity }],
]);

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// --- Helpers ---

function makePlan(overrides?: Partial<DeliveryPlan>): DeliveryPlan {
  return {
    demandCardId: 42,
    loadType: 'Steel',
    pickupCity: 'PickupCity',
    deliveryCity: 'DeliveryCity',
    payment: 25,
    phase: 'build_to_pickup',
    createdAtTurn: 1,
    reasoning: 'test plan',
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-test-1234',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 8 },
      existingSegments: [],
      demandCards: [42],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: { PickupCity: ['Steel'] },
  };
}

function makeMemory(overrides?: Partial<BotMemoryState>): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutivePassTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 5,
    activePlan: null,
    turnsOnPlan: 0,
    planHistory: [],
    ...overrides,
  };
}

function makeMoveOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move',
    ...overrides,
  };
}

function makeBuildOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    estimatedCost: 5,
    ...overrides,
  };
}

function seg(fromRow: number, fromCol: number, toRow: number, toCol: number) {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// --- Tests ---

describe('PlanExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Phase transitions', () => {
    it('should transition build_to_pickup → travel_to_pickup when pickup city is on network', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      // Bot has track reaching PickupCity at (5,5)
      const snapshot = makeSnapshot({
        existingSegments: [seg(5, 4, 5, 5)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('travel_to_pickup');
    });

    it('should transition travel_to_pickup → pickup when bot is at pickup city', () => {
      const plan = makePlan({ phase: 'travel_to_pickup' });
      const snapshot = makeSnapshot({
        position: { row: 5, col: 5 }, // At PickupCity
        existingSegments: [seg(5, 4, 5, 5)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('pickup');
    });

    it('should transition pickup → build_to_delivery when load acquired but delivery city not on network', () => {
      const plan = makePlan({ phase: 'pickup' });
      const snapshot = makeSnapshot({
        position: { row: 5, col: 5 },
        loads: ['Steel'],
        existingSegments: [seg(5, 4, 5, 5)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('build_to_delivery');
    });

    it('should transition pickup → travel_to_delivery when load acquired and delivery city on network', () => {
      const plan = makePlan({ phase: 'pickup' });
      const snapshot = makeSnapshot({
        position: { row: 5, col: 5 },
        loads: ['Steel'],
        existingSegments: [seg(5, 4, 5, 5), seg(15, 9, 15, 10)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('travel_to_delivery');
    });

    it('should transition build_to_delivery → travel_to_delivery when delivery city on network', () => {
      const plan = makePlan({ phase: 'build_to_delivery' });
      const snapshot = makeSnapshot({
        loads: ['Steel'],
        existingSegments: [seg(15, 9, 15, 10)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('travel_to_delivery');
    });

    it('should transition travel_to_delivery → deliver when bot is at delivery city', () => {
      const plan = makePlan({ phase: 'travel_to_delivery' });
      const snapshot = makeSnapshot({
        position: { row: 15, col: 10 }, // At DeliveryCity
        loads: ['Steel'],
        existingSegments: [seg(15, 9, 15, 10)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('deliver');
      expect(result.planComplete).toBe(true);
    });

    it('should skip ahead when bot already has load during build_to_pickup phase', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot({
        loads: ['Steel'], // Already carrying the load
        existingSegments: [],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('build_to_delivery');
    });

    it('should skip ahead to travel_to_delivery when bot has load and delivery city is on network', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot({
        loads: ['Steel'],
        existingSegments: [seg(15, 9, 15, 10)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('travel_to_delivery');
    });

    it('should NOT transition when conditions are not met', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot({
        existingSegments: [], // No track to PickupCity
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.updatedPlan.phase).toBe('build_to_pickup');
    });
  });

  describe('Move selection', () => {
    it('should prefer a direct move to target city', () => {
      const plan = makePlan({ phase: 'travel_to_pickup' });
      const snapshot = makeSnapshot({
        existingSegments: [seg(5, 4, 5, 5)],
      });
      const directMove = makeMoveOption({
        targetCity: 'PickupCity',
        movementPath: [{ row: 5, col: 5 }],
      });
      const otherMove = makeMoveOption({
        targetCity: 'SomeOtherCity',
        movementPath: [{ row: 20, col: 20 }],
      });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [otherMove, directMove], [], makeMemory(),
      );

      expect(result.moveChoice).toBe(directMove);
    });

    it('should select closest move when no direct move available', () => {
      const plan = makePlan({ phase: 'travel_to_pickup' });
      const snapshot = makeSnapshot({
        existingSegments: [seg(5, 4, 5, 5)],
      });
      const closeMove = makeMoveOption({
        movementPath: [{ row: 6, col: 5 }], // Close to PickupCity (5,5)
      });
      const farMove = makeMoveOption({
        movementPath: [{ row: 20, col: 20 }], // Far from PickupCity
      });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [farMove, closeMove], [], makeMemory(),
      );

      expect(result.moveChoice).toBe(closeMove);
    });

    it('should return null moveChoice when no feasible moves', () => {
      const plan = makePlan({ phase: 'travel_to_pickup' });
      const snapshot = makeSnapshot({
        existingSegments: [seg(5, 4, 5, 5)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.moveChoice).toBeNull();
    });
  });

  describe('Build selection', () => {
    it('should select build targeting plan city during build phase', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot();
      const targetBuild = makeBuildOption({
        targetCity: 'PickupCity',
        estimatedCost: 5,
      });
      const otherBuild = makeBuildOption({
        targetCity: 'SomeCity',
        estimatedCost: 3,
      });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [], [otherBuild, targetBuild], makeMemory(),
      );

      expect(result.buildChoice).toBe(targetBuild);
    });

    it('should fall back to any build when no target-specific build exists', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot();
      const anyBuild = makeBuildOption({
        targetCity: 'SomeCity',
        estimatedCost: 5,
      });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [], [anyBuild], makeMemory(),
      );

      expect(result.buildChoice).toBe(anyBuild);
    });

    it('should return null buildChoice when no feasible builds', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot();

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.buildChoice).toBeNull();
    });
  });

  describe('Phase-specific behavior', () => {
    it('should select move and build during build_to_pickup phase', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot();
      const move = makeMoveOption({ movementPath: [{ row: 5, col: 6 }] });
      const build = makeBuildOption({ targetCity: 'PickupCity' });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [move], [build], makeMemory(),
      );

      expect(result.moveChoice).toBe(move);
      expect(result.buildChoice).toBe(build);
    });

    it('should build toward delivery city during pickup phase', () => {
      const plan = makePlan({ phase: 'pickup' });
      const snapshot = makeSnapshot({
        position: { row: 5, col: 5 },
        existingSegments: [seg(5, 4, 5, 5)],
      });
      const build = makeBuildOption({ targetCity: 'DeliveryCity' });

      const result = PlanExecutor.executePlan(
        plan, snapshot, [], [build], makeMemory(),
      );

      expect(result.buildChoice).toBe(build);
      expect(Scorer.score).toHaveBeenCalled();
    });

    it('should return planComplete=true for deliver phase', () => {
      const plan = makePlan({ phase: 'deliver' });
      const snapshot = makeSnapshot({
        position: { row: 15, col: 10 },
        loads: ['Steel'],
        existingSegments: [seg(15, 9, 15, 10)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.planComplete).toBe(true);
      expect(result.moveChoice).toBeNull();
      expect(result.buildChoice).toBeNull();
    });

    it('should return planComplete=false for non-deliver phases', () => {
      const plan = makePlan({ phase: 'travel_to_pickup' });
      const snapshot = makeSnapshot({
        existingSegments: [seg(5, 4, 5, 5)],
      });

      const result = PlanExecutor.executePlan(plan, snapshot, [], [], makeMemory());

      expect(result.planComplete).toBe(false);
    });
  });

  describe('Memory override for Scorer', () => {
    it('should pass plan target city as currentBuildTarget to Scorer', () => {
      const plan = makePlan({ phase: 'build_to_pickup' });
      const snapshot = makeSnapshot();
      const build = makeBuildOption();

      PlanExecutor.executePlan(plan, snapshot, [], [build], makeMemory());

      expect(Scorer.score).toHaveBeenCalledWith(
        expect.any(Array),
        snapshot,
        null, // botConfig
        expect.objectContaining({ currentBuildTarget: 'PickupCity' }),
      );
    });

    it('should pass delivery city as target during build_to_delivery', () => {
      const plan = makePlan({ phase: 'build_to_delivery' });
      const snapshot = makeSnapshot({ loads: ['Steel'] });
      const build = makeBuildOption();

      PlanExecutor.executePlan(plan, snapshot, [], [build], makeMemory());

      expect(Scorer.score).toHaveBeenCalledWith(
        expect.any(Array),
        snapshot,
        null,
        expect.objectContaining({ currentBuildTarget: 'DeliveryCity' }),
      );
    });
  });
});
