/**
 * Integration test: Verifies AIStrategyEngine correctly calls DecisionLogger
 * functions (initTurnLog, logPhase, flushTurnLog) in proper sequence.
 */

// Mock external dependencies before imports
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
  },
}));

jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn(),
}));

jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn().mockReturnValue({
      getCard: jest.fn().mockReturnValue(null),
      drawCard: jest.fn().mockReturnValue(null),
    }),
  },
}));

jest.mock('../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn().mockReturnValue({
      getAvailableLoadsForCity: jest.fn().mockReturnValue([]),
      getSourceCitiesForLoad: jest.fn().mockReturnValue([]),
    }),
  },
}));

// Mock WorldSnapshotService
jest.mock('../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

// Mock OptionGenerator
jest.mock('../services/ai/OptionGenerator', () => ({
  OptionGenerator: {
    generate: jest.fn().mockReturnValue([]),
  },
}));

// Mock Scorer
jest.mock('../services/ai/Scorer', () => ({
  Scorer: {
    score: jest.fn().mockReturnValue([]),
  },
}));

// Mock PlanValidator
jest.mock('../services/ai/PlanValidator', () => ({
  validate: jest.fn().mockReturnValue({ valid: true }),
}));

// Mock TurnExecutor
jest.mock('../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    execute: jest.fn(),
  },
}));

// Mock MapTopology
jest.mock('../services/ai/MapTopology', () => ({
  gridToPixel: jest.fn().mockReturnValue({ x: 0, y: 0 }),
  loadGridPoints: jest.fn().mockReturnValue(new Map()),
}));

// Mock majorCityGroups
jest.mock('../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn().mockReturnValue([]),
  getFerryEdges: jest.fn().mockReturnValue([]),
}));

// Mock BotMemory
jest.mock('../services/ai/BotMemory', () => ({
  getMemory: jest.fn().mockReturnValue({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutivePassTurns: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
  }),
  updateMemory: jest.fn(),
}));

// Mock DecisionLogger — spy on all exports
jest.mock('../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn(),
}));

import { AIStrategyEngine } from '../services/ai/AIStrategyEngine';
import { capture } from '../services/ai/WorldSnapshotService';
import { OptionGenerator } from '../services/ai/OptionGenerator';
import { Scorer } from '../services/ai/Scorer';
import { TurnExecutor } from '../services/ai/TurnExecutor';
import { initTurnLog, logPhase, flushTurnLog } from '../services/ai/DecisionLogger';
import { AIActionType, WorldSnapshot } from '../../shared/types/GameTypes';

const mockCapture = capture as jest.Mock;
const mockGenerate = OptionGenerator.generate as jest.Mock;
const mockScore = Scorer.score as jest.Mock;
const mockExecute = TurnExecutor.execute as jest.Mock;
const mockInitTurnLog = initTurnLog as jest.Mock;
const mockLogPhase = logPhase as jest.Mock;
const mockFlushTurnLog = flushTurnLog as jest.Mock;

function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium', archetype: 'balanced' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    ...overrides,
  };
}

describe('AIStrategyEngine DecisionLogger integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls initTurnLog at the start, logPhase for each phase, and flushTurnLog at the end (PassTurn fallback)', async () => {
    const snapshot = makeSnapshot();
    mockCapture.mockResolvedValue(snapshot);

    // No options generated → PassTurn fallback
    mockGenerate.mockReturnValue([]);
    mockScore.mockReturnValue([]);
    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.PassTurn,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 50,
      durationMs: 1,
    });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // initTurnLog must be called first
    expect(mockInitTurnLog).toHaveBeenCalledTimes(1);
    expect(mockInitTurnLog).toHaveBeenCalledWith('game-1', 'bot-1', 1);

    // logPhase called for Phase 0, Phase 1, and Phase 2
    // Phase 1.5 is skipped when no movement occurs
    const phaseCalls = mockLogPhase.mock.calls.map((c: any[]) => c[0]);
    expect(phaseCalls).toContain('Phase 0');
    expect(phaseCalls).toContain('Phase 2');

    // flushTurnLog must be called exactly once at the end
    expect(mockFlushTurnLog).toHaveBeenCalledTimes(1);

    // Verify ordering: initTurnLog before logPhase, logPhase before flushTurnLog
    const initOrder = mockInitTurnLog.mock.invocationCallOrder[0];
    const firstPhaseOrder = mockLogPhase.mock.invocationCallOrder[0];
    const flushOrder = mockFlushTurnLog.mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(firstPhaseOrder);
    expect(firstPhaseOrder).toBeLessThan(flushOrder);
  });

  it('calls flushTurnLog even when pipeline throws', async () => {
    mockCapture.mockRejectedValue(new Error('DB connection failed'));

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(mockInitTurnLog).toHaveBeenCalledTimes(1);
    expect(mockFlushTurnLog).toHaveBeenCalledTimes(1);
  });

  it('logs Phase 1 with move options when movement succeeds', async () => {
    const snapshot = makeSnapshot();
    mockCapture.mockResolvedValue(snapshot);

    const moveOption = {
      action: AIActionType.MoveTrain,
      feasible: true,
      reason: 'path found',
      score: 80,
      movementPath: [{ row: 10, col: 10 }, { row: 11, col: 10 }],
      mileposts: 1,
    };

    // Phase 0: executeLoadActions calls generate 3 times (delivery, drop, pickup)
    // Phase 1: movement
    // Phase 1.5: executeLoadActions calls generate 3 times
    // Phase 2: build options
    mockGenerate
      .mockReturnValueOnce([]) // Phase 0: delivery options
      .mockReturnValueOnce([]) // Phase 0: drop options
      .mockReturnValueOnce([]) // Phase 0: pickup options
      .mockReturnValueOnce([moveOption]) // Phase 1: move options
      .mockReturnValueOnce([]) // Phase 1.5: delivery options
      .mockReturnValueOnce([]) // Phase 1.5: drop options
      .mockReturnValueOnce([]) // Phase 1.5: pickup options
      .mockReturnValue([]); // Phase 2: build options

    mockScore
      .mockReturnValueOnce([moveOption]) // Phase 1: scored moves
      .mockReturnValue([]); // Phase 2: scored builds

    mockExecute
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.MoveTrain,
        cost: 4,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 2,
      })
      .mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 1,
      });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Find the Phase 1 logPhase call
    const phase1Call = mockLogPhase.mock.calls.find((c: any[]) => c[0] === 'Phase 1');
    expect(phase1Call).toBeDefined();
    // Phase 1 should have options
    expect(phase1Call![1]).toHaveLength(1);
    // Phase 1 should have a chosen option
    expect(phase1Call![2]).not.toBeNull();
    expect(phase1Call![2].action).toBe(AIActionType.MoveTrain);
    // Phase 1 should have a result
    expect(phase1Call![3]).not.toBeNull();
    expect(phase1Call![3].success).toBe(true);
  });

  it('logs Phase 2 with build options when build succeeds', async () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, position: null, existingSegments: [] } });
    // Bot with no position, no segments → skip Phase 0, 1, 1.5
    mockCapture.mockResolvedValue(snapshot);

    const buildOption = {
      action: AIActionType.BuildTrack,
      feasible: true,
      reason: 'expand network',
      score: 100,
      targetCity: 'Paris',
      segments: [],
      estimatedCost: 10,
    };

    mockGenerate.mockReturnValue([buildOption]);
    mockScore.mockReturnValue([buildOption]);
    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.BuildTrack,
      cost: 10,
      segmentsBuilt: 3,
      remainingMoney: 40,
      durationMs: 5,
    });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Find the Phase 2 logPhase call
    const phase2Call = mockLogPhase.mock.calls.find((c: any[]) => c[0] === 'Phase 2');
    expect(phase2Call).toBeDefined();
    // Should have the build option in the options array
    expect(phase2Call![1].length).toBeGreaterThanOrEqual(1);
    // Should have a chosen build option
    expect(phase2Call![2]).not.toBeNull();
    expect(phase2Call![2].action).toBe(AIActionType.BuildTrack);
    // Should have a success result
    expect(phase2Call![3]).not.toBeNull();
    expect(phase2Call![3].cost).toBe(10);

    expect(mockFlushTurnLog).toHaveBeenCalledTimes(1);
  });

  it('logs Phase 1.5 when movement occurred', async () => {
    const snapshot = makeSnapshot();
    // Need movedTo to trigger Phase 1.5
    mockCapture.mockResolvedValue(snapshot);

    const moveOption = {
      action: AIActionType.MoveTrain,
      feasible: true,
      reason: 'path found',
      score: 80,
      movementPath: [{ row: 10, col: 10 }, { row: 11, col: 10 }],
      mileposts: 1,
    };

    mockGenerate
      .mockReturnValueOnce([]) // Phase 0: delivery options
      .mockReturnValueOnce([]) // Phase 0: drop options
      .mockReturnValueOnce([]) // Phase 0: pickup options
      .mockReturnValueOnce([moveOption]) // Phase 1: move options
      .mockReturnValueOnce([]) // Phase 1.5: delivery options
      .mockReturnValueOnce([]) // Phase 1.5: drop options
      .mockReturnValueOnce([]) // Phase 1.5: pickup options
      .mockReturnValue([]); // Phase 2: build options

    mockScore.mockReturnValueOnce([moveOption]).mockReturnValue([]);
    mockExecute
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.MoveTrain,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      })
      .mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    const phaseNames = mockLogPhase.mock.calls.map((c: any[]) => c[0]);
    expect(phaseNames).toContain('Phase 1.5');
  });
});
