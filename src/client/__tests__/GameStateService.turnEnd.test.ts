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
      settleBuildCost: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PlayerStateService>;
    service.setPlayerStateService(playerStateService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('applyBuildCostDeduction', () => {
    it('asks the server to settle the build cost for the local player', async () => {
      await service.applyBuildCostDeduction(localPlayer, 5);

      expect(playerStateService.settleBuildCost).toHaveBeenCalledWith('game-1');
      // Money is set from the server response inside settleBuildCost, never computed here.
      expect(localPlayer.money).toBe(50);
    });

    it('mutates money directly for a non-local player without API calls', async () => {
      await service.applyBuildCostDeduction(otherPlayer, 5);

      expect(otherPlayer.money).toBe(35);
      expect(playerStateService.settleBuildCost).not.toHaveBeenCalled();
    });

    it('is a no-op when build cost is 0', async () => {
      await service.applyBuildCostDeduction(localPlayer, 0);

      expect(playerStateService.settleBuildCost).not.toHaveBeenCalled();
      expect(localPlayer.money).toBe(50);
    });

    it('does not throw when the settlement rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      playerStateService.settleBuildCost.mockRejectedValueOnce(new Error('api down'));

      await expect(service.applyBuildCostDeduction(localPlayer, 5)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('treats every player as non-local when no PlayerStateService is set', async () => {
      const bareService = new GameStateService(createGameState([localPlayer]));

      await bareService.applyBuildCostDeduction(localPlayer, 5);

      expect(localPlayer.money).toBe(45);
      expect(playerStateService.settleBuildCost).not.toHaveBeenCalled();
    });
  });

  describe('nextPlayerTurn', () => {
    const { authenticatedFetch } = jest.requireMock('../services/authenticatedFetch') as {
      authenticatedFetch: jest.Mock;
    };

    function respond(ok: boolean, body: unknown): void {
      authenticatedFetch.mockResolvedValueOnce({ ok, json: async () => body });
    }

    it('asks the server to end the turn without choosing the next player', async () => {
      respond(true, { currentPlayerIndex: 1, playerId: 'local-1', turnNumber: 4 });

      await service.nextPlayerTurn();

      expect(authenticatedFetch).toHaveBeenCalledTimes(1);
      const [url, init] = authenticatedFetch.mock.calls[0];
      expect(url).toBe('http://test/api/players/updateCurrentPlayer');
      expect(JSON.parse(init.body)).toEqual({ gameId: 'game-1' });
    });

    it('applies the server index and the server-assigned turn number on success', async () => {
      respond(true, { currentPlayerIndex: 1, playerId: 'local-1', turnNumber: 4 });

      await service.nextPlayerTurn();

      expect(service.getGameState().currentPlayerIndex).toBe(1);
      expect(localPlayer.turnNumber).toBe(4);
      expect(otherPlayer.turnNumber).toBe(2);
    });

    it('applies the turn number to the player the server names, not the local index', async () => {
      // Local index is stale (already points at the other player).
      service.getGameState().currentPlayerIndex = 1;
      respond(true, { currentPlayerIndex: 1, playerId: 'local-1', turnNumber: 4 });

      await service.nextPlayerTurn();

      expect(localPlayer.turnNumber).toBe(4);
      expect(otherPlayer.turnNumber).toBe(2);
    });

    it('leaves the index alone and does not notify when the response has no index', async () => {
      const listener = jest.fn();
      service.onTurnChange(listener);
      respond(true, {});

      await service.nextPlayerTurn();

      expect(service.getGameState().currentPlayerIndex).toBe(0);
      expect(localPlayer.turnNumber).toBe(3);
      expect(listener).not.toHaveBeenCalled();
    });

    it('changes nothing locally when the server refuses', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      respond(false, { error: 'Forbidden', code: 'NotYourTurn' });

      await service.nextPlayerTurn();

      expect(service.getGameState().currentPlayerIndex).toBe(0);
      expect(localPlayer.turnNumber).toBe(3);
      errorSpy.mockRestore();
    });

    it('does not throw or change local state when the request rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      authenticatedFetch.mockRejectedValueOnce(new Error('api down'));

      await expect(service.nextPlayerTurn()).resolves.toBeUndefined();
      expect(localPlayer.turnNumber).toBe(3);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
