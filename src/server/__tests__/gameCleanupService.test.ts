import { cleanupGameState } from '../services/gameCleanupService';

// Mock every per-game cleanup routine so we can assert the orchestration in
// isolation, without a real deck, bot memory store, or database.
jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    destroyInstance: jest.fn(),
  },
}));
jest.mock('../services/ai/BotMemory', () => ({
  clearGameMemory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/ai/BotTurnTrigger', () => ({
  cleanupBotTurnState: jest.fn(),
}));

import { DemandDeckService } from '../services/demandDeckService';
import { clearGameMemory } from '../services/ai/BotMemory';
import { cleanupBotTurnState } from '../services/ai/BotTurnTrigger';

const destroyInstance = DemandDeckService.destroyInstance as jest.Mock;
const clearGameMemoryMock = clearGameMemory as jest.Mock;
const cleanupBotTurnStateMock = cleanupBotTurnState as jest.Mock;

describe('gameCleanupService.cleanupGameState', () => {
  const gameId = 'game-be004';

  beforeEach(() => {
    jest.clearAllMocks();
    clearGameMemoryMock.mockResolvedValue(undefined);
  });

  it('invokes every per-game cleanup routine with the gameId', async () => {
    await cleanupGameState(gameId);

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith(gameId);
    expect(cleanupBotTurnStateMock).toHaveBeenCalledTimes(1);
    expect(cleanupBotTurnStateMock).toHaveBeenCalledWith(gameId);
    expect(clearGameMemoryMock).toHaveBeenCalledTimes(1);
    expect(clearGameMemoryMock).toHaveBeenCalledWith(gameId);
  });

  it('is a no-op for an empty gameId', async () => {
    await cleanupGameState('');

    expect(destroyInstance).not.toHaveBeenCalled();
    expect(cleanupBotTurnStateMock).not.toHaveBeenCalled();
    expect(clearGameMemoryMock).not.toHaveBeenCalled();
  });

  it('is idempotent — calling twice for the same game does not throw and cleans each time', async () => {
    await cleanupGameState(gameId);
    await expect(cleanupGameState(gameId)).resolves.toBeUndefined();

    expect(destroyInstance).toHaveBeenCalledTimes(2);
    expect(cleanupBotTurnStateMock).toHaveBeenCalledTimes(2);
    expect(clearGameMemoryMock).toHaveBeenCalledTimes(2);
  });

  it('is best-effort — a failure in one routine does not prevent the others', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    destroyInstance.mockImplementationOnce(() => {
      throw new Error('deck boom');
    });

    await expect(cleanupGameState(gameId)).resolves.toBeUndefined();

    // Even though the deck cleanup threw, the remaining routines still ran.
    expect(cleanupBotTurnStateMock).toHaveBeenCalledWith(gameId);
    expect(clearGameMemoryMock).toHaveBeenCalledWith(gameId);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('swallows and logs an async bot-memory clear failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearGameMemoryMock.mockRejectedValueOnce(new Error('memory boom'));

    await expect(cleanupGameState(gameId)).resolves.toBeUndefined();

    expect(destroyInstance).toHaveBeenCalledWith(gameId);
    expect(cleanupBotTurnStateMock).toHaveBeenCalledWith(gameId);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
