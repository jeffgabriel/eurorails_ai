import { PlayerStateService } from '../services/PlayerStateService';
import { LoadService } from '../services/LoadService';
import { authenticatedFetch } from '../services/authenticatedFetch';
import { api } from '../lobby/shared/api';
import { Player } from '../../shared/types/GameTypes';
import { LoadState, LoadType } from '../../shared/types/LoadTypes';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

jest.mock('../lobby/shared/api', () => ({
  api: {
    getLoadState: jest.fn(),
    getDroppedLoads: jest.fn(),
  },
}));

const mockFetch = authenticatedFetch as jest.Mock;

function createPlayer(loads: LoadType[]): Player {
  return {
    id: 'player-1',
    name: 'Test',
    color: '#ff0000',
    money: 50,
    trainType: 'Freight',
    turnNumber: 1,
    trainState: {
      position: { x: 0, y: 0, row: 5, col: 5 },
      remainingMovement: 9,
      movementHistory: [],
      loads,
    },
    hand: [],
  } as unknown as Player;
}

function jsonResponse(ok: boolean, body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: async () => body };
}

describe('PlayerStateService load actions (#310)', () => {
  let service: PlayerStateService;
  let player: Player;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new PlayerStateService();
    player = createPlayer([LoadType.Wine]);
    service.initializeLocalPlayer([player]);
  });

  it('posts a pickup to /api/players/pickup-load and takes the loads from the server', async () => {
    const result = {
      updatedLoads: [LoadType.Wine, LoadType.Cars],
      droppedLoads: [],
      trayChanges: [{ loadType: LoadType.Cars, delta: -1 }],
    };
    mockFetch.mockResolvedValue(jsonResponse(true, result));

    const outcome = await service.pickupLoad('Stuttgart', LoadType.Cars, 'game-1');

    expect(outcome).toEqual({ ok: true, result });
    expect(player.trainState.loads).toEqual([LoadType.Wine, LoadType.Cars]);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/players\/pickup-load$/);
    // The request names the game, city and load only: the server takes the player from the session.
    expect(JSON.parse(options.body)).toEqual({ gameId: 'game-1', city: 'Stuttgart', loadType: LoadType.Cars });
  });

  it('posts a drop to /api/players/drop-load and takes the loads from the server', async () => {
    const result = {
      updatedLoads: [],
      droppedLoads: [{ city_name: 'Berlin', type: LoadType.Wine }],
      trayChanges: [],
    };
    mockFetch.mockResolvedValue(jsonResponse(true, result));

    const outcome = await service.dropLoad('Berlin', LoadType.Wine, 'game-1');

    expect(outcome).toEqual({ ok: true, result });
    expect(player.trainState.loads).toEqual([]);
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/api\/players\/drop-load$/);
  });

  it('returns the server\'s reason and leaves the loads alone when the server refuses', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(false, { error: 'Conflict', code: 'TrainNotAtCity', details: 'Train is not at Stuttgart' }),
    );
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await service.pickupLoad('Stuttgart', LoadType.Cars, 'game-1');

    expect(outcome).toEqual({ ok: false, error: 'Train is not at Stuttgart' });
    expect(player.trainState.loads).toEqual([LoadType.Wine]);
    consoleSpy.mockRestore();
  });

  it('treats a malformed success body as a failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse(true, { updatedLoads: [LoadType.Cars] }));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await service.pickupLoad('Stuttgart', LoadType.Cars, 'game-1');

    expect(outcome.ok).toBe(false);
    expect(player.trainState.loads).toEqual([LoadType.Wine]);
    consoleSpy.mockRestore();
  });

  it('undoes a load action through /api/players/undo-last-action', async () => {
    const result = {
      kind: 'pickup',
      updatedLoads: [],
      droppedLoads: [],
      trayChanges: [{ loadType: LoadType.Wine, delta: 1 }],
    };
    mockFetch.mockResolvedValue(jsonResponse(true, result));

    const undone = await service.undoLoadAction('game-1');

    expect(undone).toEqual(result);
    expect(player.trainState.loads).toEqual([]);
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/api\/players\/undo-last-action$/);
  });

  it('returns null from undoLoadAction when the server undid something that is not a load action', async () => {
    mockFetch.mockResolvedValue(jsonResponse(true, { kind: 'move', updatedMoney: 50 }));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const undone = await service.undoLoadAction('game-1');

    expect(undone).toBeNull();
    expect(player.trainState.loads).toEqual([LoadType.Wine]);
    consoleSpy.mockRestore();
  });
});

describe('LoadService server updates (#310)', () => {
  let loadService: LoadService;

  beforeEach(async () => {
    const states: LoadState[] = [
      { loadType: LoadType.Cars, availableCount: 3, totalCount: 3, cities: ['Stuttgart'] },
      { loadType: LoadType.Steel, availableCount: 3, totalCount: 3, cities: ['Ruhr'] },
    ];
    (api.getLoadState as jest.Mock).mockResolvedValue(states);
    (api.getDroppedLoads as jest.Mock).mockResolvedValue([{ city_name: 'Berlin', type: LoadType.Steel }]);
    // LoadService is a singleton; build a fresh one per test.
    (LoadService as unknown as { instance: LoadService | undefined }).instance = undefined;
    loadService = LoadService.getInstance();
    await loadService.loadInitialState();
  });

  const countAt = (city: string, loadType: LoadType): number =>
    loadService.getCityLoadDetails(city).find((detail) => detail.loadType === loadType)?.count ?? 0;

  it('replaces the dropped chips with the server\'s list and moves the tray counts', () => {
    expect(countAt('Berlin', LoadType.Steel)).toBe(1);

    // Cars dropped in Berlin; the Steel chip that was there went back to the tray.
    loadService.applyServerUpdate({
      droppedLoads: [{ city_name: 'Berlin', type: LoadType.Cars }],
      trayChanges: [{ loadType: LoadType.Steel, delta: 1 }],
    });

    expect(countAt('Berlin', LoadType.Steel)).toBe(0);
    expect(countAt('Berlin', LoadType.Cars)).toBe(1);
    // The tray count never goes above the number of chips in the game.
    expect(countAt('Ruhr', LoadType.Steel)).toBe(3);
  });

  it('takes a chip out of the tray on a pickup and puts it back on undo', () => {
    loadService.applyServerUpdate({
      droppedLoads: [{ city_name: 'Berlin', type: LoadType.Steel }],
      trayChanges: [{ loadType: LoadType.Cars, delta: -1 }],
    });
    expect(countAt('Stuttgart', LoadType.Cars)).toBe(2);

    loadService.adjustTrayCount(LoadType.Cars, 1);
    expect(countAt('Stuttgart', LoadType.Cars)).toBe(3);
  });
});
