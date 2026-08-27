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

describe('GameStateService.applyTurnEndAccounting', () => {
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

  it('deducts build cost via the API for the local player and persists the turn number', async () => {
    await service.applyTurnEndAccounting(localPlayer, 5);

    expect(playerStateService.updatePlayerMoney).toHaveBeenCalledWith(45, 'game-1');
    expect(localPlayer.turnNumber).toBe(4);
    expect(playerStateService.updatePlayerTurnNumber).toHaveBeenCalledWith(4, 'game-1');
  });

  it('mutates money directly for a non-local player without API calls', async () => {
    await service.applyTurnEndAccounting(otherPlayer, 5);

    expect(otherPlayer.money).toBe(35);
    expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
    expect(otherPlayer.turnNumber).toBe(3);
    expect(playerStateService.updatePlayerTurnNumber).not.toHaveBeenCalled();
  });

  it('skips money handling entirely when build cost is 0 but still increments the turn number', async () => {
    await service.applyTurnEndAccounting(localPlayer, 0);

    expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
    expect(localPlayer.money).toBe(50);
    expect(localPlayer.turnNumber).toBe(4);
  });

  it('defaults a missing turn number to 1 before incrementing', async () => {
    const freshPlayer = createPlayer('other-1', 40, undefined);
    await service.applyTurnEndAccounting(freshPlayer, 0);

    expect(freshPlayer.turnNumber).toBe(2);
  });

  it('still increments the turn number when the money update rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    playerStateService.updatePlayerMoney.mockRejectedValueOnce(new Error('api down'));

    await service.applyTurnEndAccounting(localPlayer, 5);

    expect(errorSpy).toHaveBeenCalled();
    expect(localPlayer.turnNumber).toBe(4);
    expect(playerStateService.updatePlayerTurnNumber).toHaveBeenCalledWith(4, 'game-1');
    errorSpy.mockRestore();
  });

  it('resolves without throwing when turn-number persistence rejects', async () => {
    playerStateService.updatePlayerTurnNumber.mockRejectedValueOnce(new Error('api down'));

    await expect(service.applyTurnEndAccounting(localPlayer, 0)).resolves.toBeUndefined();
    expect(localPlayer.turnNumber).toBe(4);
  });

  it('treats every player as non-local when no PlayerStateService is set', async () => {
    const bareService = new GameStateService(createGameState([localPlayer]));

    await bareService.applyTurnEndAccounting(localPlayer, 5);

    expect(localPlayer.money).toBe(45);
    expect(playerStateService.updatePlayerMoney).not.toHaveBeenCalled();
  });
});
