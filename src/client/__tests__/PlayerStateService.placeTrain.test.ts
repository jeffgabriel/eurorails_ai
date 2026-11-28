import { PlayerStateService } from '../services/PlayerStateService';
import { authenticatedFetch } from '../services/authenticatedFetch';
import { Player } from '../../shared/types/GameTypes';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

const mockFetch = authenticatedFetch as jest.Mock;

function createPlayer(): Player {
  return {
    id: 'player-1',
    name: 'Test',
    color: '#ff0000',
    money: 50,
    trainType: 'Freight',
    turnNumber: 1,
    trainState: { position: null, remainingMovement: 9, movementHistory: [], loads: [] },
    hand: [],
  } as unknown as Player;
}

describe('PlayerStateService.placeTrain', () => {
  let service: PlayerStateService;
  let player: Player;

  beforeEach(() => {
    service = new PlayerStateService();
    player = createPlayer();
    (service as any).localPlayer = player;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('sends only the game and the milepost, and places the train locally on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ position: { x: 100, y: 200, row: 24, col: 52 } }) });

    const refusal = await service.placeTrain(100, 200, 24, 52, 'game-1');

    expect(refusal).toBeNull();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/players/place-train');
    expect(JSON.parse(init.body)).toEqual({ gameId: 'game-1', to: { row: 24, col: 52 } });
    expect(player.trainState.position).toEqual({ x: 100, y: 200, row: 24, col: 52 });
  });

  it('returns the server\'s reason and leaves the train off the board when refused', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Conflict', code: 'NotYourTurn', details: 'It is not your turn' }),
    });

    expect(await service.placeTrain(100, 200, 24, 52, 'game-1')).toBe('It is not your turn');
    expect(player.trainState.position).toBeNull();
  });

  it('fails without throwing on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));

    expect(await service.placeTrain(100, 200, 24, 52, 'game-1')).toBe('Could not place your train');
    expect(player.trainState.position).toBeNull();
  });

  it('does nothing without a local player', async () => {
    (service as any).localPlayer = null;

    expect(await service.placeTrain(100, 200, 24, 52, 'game-1')).toBe('Could not place your train');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
