import { GameStateService } from '../services/GameStateService';
import { PlayerStateService } from '../services/PlayerStateService';
import { FullGameState, Player } from '../../shared/types/GameTypes';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

jest.mock('../config/apiConfig', () => ({
  config: { apiBaseUrl: 'http://test' },
}));

function createPlayer(id: string, money: number, turnNumber?: number): Player {
  return {
    id,
    name: id,
    color: '#ff0000',
    money,
    turnNumber,
    trainState: {
      position: null,
      remainingMovement: 0,
      movementHistory: [],
      loads: [],
    },
    hand: [],
  } as unknown as Player;
}

function createGameState(players: Player[]): FullGameState {
  return {
    id: 'game-1',
    players,
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 4,
  } as unknown as FullGameState;
}

describe('GameStateService turn-end accounting', () => {
  let service: GameStateService;
  let localPlayer: Player;
  let otherPlayer: Player;
  let playerStateService: jest.Mocked<PlayerStateService>;

  beforeEach(() => {
    localPlayer = createPlayer('local-1', 50, 3);
    otherPlayer = createPlayer('other-1', 40, 2);
    service = new GameStateService(createGameState([localPlayer, otherPlayer]));

    playerStateService = {
      getLocalPlayerId: jest.fn().mockReturnValue('local-1'),
      updatePlayerMoney: jest.fn().mockResolvedValue(true),
      updatePlayerTurnNumber: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PlayerStateService>;
    service.setPlayerStateService(playerStateService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('applyBuildCostDeduction', () => {
    it('deducts build cost via the API for the local player', async () => {
      await service.applyBuildCostDeduction(localPlayer, 5);

      expect(playerStateService.updatePlayerMoney).toHaveBeenCalledWith(45, 'game-1');
    });

    it('mutates money directly for a non-local player without API calls', async () => {
      await service.applyBuildCostDeduction(otherPlayer, 5);

      expect(otherPlayer.money).toBe(35);
      expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
    });

    it('is a no-op when build cost is 0', async () => {
      await service.applyBuildCostDeduction(localPlayer, 0);

      expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
      expect(localPlayer.money).toBe(50);
    });

    it('does not throw when the money update rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      playerStateService.updatePlayerMoney.mockRejectedValueOnce(new Error('api down'));

      await expect(service.applyBuildCostDeduction(localPlayer, 5)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('treats every player as non-local when no PlayerStateService is set', async () => {
      const bareService = new GameStateService(createGameState([localPlayer]));

      await bareService.applyBuildCostDeduction(localPlayer, 5);

      expect(localPlayer.money).toBe(45);
      expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
    });
  });

  describe('applyTurnNumberIncrement', () => {
    it('persists the incremented turn number for the local player via the API', async () => {
      // Server-authoritative: the local turnNumber is advanced inside
      // updatePlayerTurnNumber on success, not before the await.
      await service.applyTurnNumberIncrement(localPlayer);

      expect(playerStateService.updatePlayerTurnNumber).toHaveBeenCalledWith(4, 'game-1');
    });

    it('increments a non-local player directly without persisting', async () => {
      await service.applyTurnNumberIncrement(otherPlayer);

      expect(otherPlayer.turnNumber).toBe(3);
      expect(playerStateService.updatePlayerTurnNumber).not.toHaveBeenCalled();
    });

    it('defaults a missing turn number to 1 before incrementing', async () => {
      const freshPlayer = createPlayer('other-1', 40, undefined);
      await service.applyTurnNumberIncrement(freshPlayer);

      expect(freshPlayer.turnNumber).toBe(2);
    });

    it('does not advance the local turn number when persistence fails', async () => {
      playerStateService.updatePlayerTurnNumber.mockResolvedValueOnce(false);

      await service.applyTurnNumberIncrement(localPlayer);

      // Local state stays in sync with the server (no premature increment).
      expect(localPlayer.turnNumber).toBe(3);
    });

    it('does not throw when the update rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      playerStateService.updatePlayerTurnNumber.mockRejectedValueOnce(new Error('api down'));

      await expect(service.applyTurnNumberIncrement(localPlayer)).resolves.toBeUndefined();
      expect(localPlayer.turnNumber).toBe(3);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
