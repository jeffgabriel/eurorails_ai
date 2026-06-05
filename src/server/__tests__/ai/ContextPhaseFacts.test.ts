import { resolveContextPhaseFacts } from '../../services/ai/context/ContextPhaseFacts';
import {
  BotMemoryState,
  GameState,
  TrainType,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { updateMemory } from '../../services/ai/BotMemory';

jest.mock('../../services/ai/BotMemory', () => ({
  updateMemory: jest.fn().mockResolvedValue(undefined),
}));

const mockUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;

function makeSnapshot(overrides?: {
  money?: number;
  turnNumber?: number;
  gameStatus?: WorldSnapshot['gameStatus'];
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: overrides?.gameStatus ?? 'active',
    turnNumber: overrides?.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.money ?? 50,
      position: { row: 0, col: 0 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeMemory(overrides?: Partial<BotMemoryState>): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    ...overrides,
  };
}

describe('resolveContextPhaseFacts', () => {
  beforeEach(() => {
    mockUpdateMemory.mockClear();
  });

  it('derives gameState and display phase from existing memory', () => {
    const memory = makeMemory({ gameState: GameState.Early, deliveryCount: 1 });

    const result = resolveContextPhaseFacts({
      snapshot: makeSnapshot({ money: 90, turnNumber: 10 }),
      memory,
      connectedMajorCities: ['Berlin', 'Paris', 'Wien'],
    });

    expect(result.memoryForPhase).toBe(memory);
    expect(result.gameState).toBe(GameState.Early);
    expect(result.phase).toBe('Mid Game');
    expect(result.endGameLocked).toBe(false);
    expect(result.persisted).toEqual({
      gameStateChanged: false,
      endGameLockedChanged: false,
    });
    expect(mockUpdateMemory).not.toHaveBeenCalled();
  });

  it('uses a default memory fallback when memory is missing', () => {
    const result = resolveContextPhaseFacts({
      snapshot: makeSnapshot({ money: 50, turnNumber: 2 }),
      memory: undefined,
      connectedMajorCities: [],
    });

    expect(result.memoryForPhase.deliveryCount).toBe(0);
    expect(result.memoryForPhase.activeRoute).toBeNull();
    expect(result.gameState).toBe(GameState.Initial);
    expect(result.phase).toBe('Early Game');
    expect(result.persisted.gameStateChanged).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', {
      gameState: GameState.Initial,
    });
  });

  it('latches endGameLocked when cash exceeds the end-game threshold', () => {
    const memory = makeMemory({ gameState: GameState.Mid, endGameLocked: false });

    const result = resolveContextPhaseFacts({
      snapshot: makeSnapshot({ money: 250, turnNumber: 20 }),
      memory,
      connectedMajorCities: ['Berlin', 'Paris', 'Wien'],
    });

    expect(memory.endGameLocked).toBe(true);
    expect(result.endGameLocked).toBe(true);
    expect(result.gameState).toBe(GameState.End);
    expect(result.phase).toBe('End Game');
    expect(result.persisted.endGameLockedChanged).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', {
      gameState: GameState.End,
    });
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', {
      endGameLocked: true,
    });
  });

  it('latches endGameLocked when strategic phase classification is late', () => {
    const memory = makeMemory({ gameState: GameState.Mid, endGameLocked: false, deliveryCount: 5 });

    const result = resolveContextPhaseFacts({
      snapshot: makeSnapshot({ money: 120, turnNumber: 80 }),
      memory,
      connectedMajorCities: ['Berlin'],
    });

    expect(memory.endGameLocked).toBe(true);
    expect(result.endGameLocked).toBe(true);
    expect(result.persisted.endGameLockedChanged).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', {
      endGameLocked: true,
    });
  });

  it('keeps endGameLocked sticky without re-persisting when already true', () => {
    const memory = makeMemory({ gameState: GameState.End, endGameLocked: true });

    const result = resolveContextPhaseFacts({
      snapshot: makeSnapshot({ money: 150, turnNumber: 30 }),
      memory,
      connectedMajorCities: ['Berlin', 'Paris'],
    });

    expect(result.gameState).toBe(GameState.End);
    expect(result.endGameLocked).toBe(true);
    expect(result.persisted).toEqual({
      gameStateChanged: false,
      endGameLockedChanged: false,
    });
    expect(mockUpdateMemory).not.toHaveBeenCalled();
  });
});
