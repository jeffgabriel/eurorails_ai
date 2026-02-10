/**
 * Tests for PlayerService.pickupLoadForUser and dropLoadForUser
 *
 * These server-authoritative methods validate position, capacity, and
 * load availability before modifying player state.
 */

// --- Mocks ---

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../../db/index', () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () => mockConnect(),
  },
}));

jest.mock('../../services/loadService', () => ({
  loadService: {
    isLoadAvailableAtCity: jest.fn(),
    getDroppedLoads: jest.fn(),
    pickupDroppedLoad: jest.fn(),
    setLoadInCity: jest.fn(),
  },
}));

jest.mock('../../services/demandDeckService', () => ({
  demandDeckService: {
    getCard: jest.fn(),
    drawCard: jest.fn(),
    discardCard: jest.fn(),
    ensureCardIsDealt: jest.fn(),
    returnDealtCardToTop: jest.fn(),
    returnDiscardedCardToDealt: jest.fn(),
  },
}));

jest.mock('../../services/trackService', () => ({
  TrackService: {
    getTrackState: jest.fn(),
    getAllTracks: jest.fn(),
  },
}));

// Mock gridPoints.json with test data
jest.mock('../../../../configuration/gridPoints.json', () => [
  { GridX: 10, GridY: 5, Type: 'Major City', Name: 'Berlin' },
  { GridX: 11, GridY: 5, Type: 'Major City Outpost', Name: 'Berlin' },
  { GridX: 20, GridY: 8, Type: 'Small City', Name: 'Lubeck' },
  { GridX: 30, GridY: 12, Type: 'Milepost', Name: null },
], { virtual: true });

// --- Imports ---

import { PlayerService } from '../../services/playerService';
import { loadService } from '../../services/loadService';
import { LoadType } from '../../../shared/types/LoadTypes';
import { TrainType } from '../../../shared/types/GameTypes';

const mockLoadService = loadService as jest.Mocked<typeof loadService>;

// --- Helpers ---

const GAME_ID = 'game-1';
const USER_ID = 'user-1';
const PLAYER_ID = 'player-1';

function makePlayerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAYER_ID,
    trainType: TrainType.Freight,
    loads: [],
    position_row: 5,
    position_col: 10,
    ...overrides,
  };
}

function setupClient() {
  mockConnect.mockResolvedValue(mockClient);
  mockClient.query.mockReset();
  mockClient.release.mockReset();

  // Default: BEGIN, player SELECT, COMMIT
  mockClient.query.mockResolvedValue({ rows: [] });
}

function setupPlayerQuery(player: ReturnType<typeof makePlayerRow>) {
  // Call order: BEGIN, SELECT player, (...validation...), UPDATE, COMMIT
  mockClient.query
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [player] }); // SELECT player FOR UPDATE
  // Additional calls (UPDATE, COMMIT) default to { rows: [] }
}

// --- Tests ---

describe('PlayerService.pickupLoadForUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(false);
    mockLoadService.getDroppedLoads.mockResolvedValue([]);
    mockLoadService.pickupDroppedLoad.mockResolvedValue({
      loadState: {} as any,
      droppedLoads: [],
    });
  });

  it('should pick up a configured load at a city', async () => {
    const player = makePlayerRow({ position_row: 5, position_col: 10 }); // Berlin
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true); // Coal available in Berlin

    const result = await PlayerService.pickupLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Coal,
    );

    expect(result.updatedLoads).toEqual([LoadType.Coal]);

    // Verify UPDATE was called with correct loads
    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('UPDATE players SET loads'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([[LoadType.Coal], GAME_ID, PLAYER_ID]);
  });

  it('should pick up a dropped load at a city', async () => {
    const player = makePlayerRow({ position_row: 5, position_col: 10 }); // Berlin
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(false);
    mockLoadService.getDroppedLoads.mockResolvedValue([
      { city_name: 'Berlin', type: LoadType.Wine },
    ]);

    const result = await PlayerService.pickupLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Wine,
    );

    expect(result.updatedLoads).toEqual([LoadType.Wine]);
    expect(mockLoadService.pickupDroppedLoad).toHaveBeenCalledWith(
      'Berlin',
      LoadType.Wine,
      GAME_ID,
    );
  });

  it('should reject if player is not at the city', async () => {
    const player = makePlayerRow({ position_row: 12, position_col: 30 }); // Milepost, not a city
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true);

    await expect(
      PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('Player is not at Berlin');
  });

  it('should reject if train is at capacity', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal, LoadType.Wine], // Freight capacity = 2
      trainType: TrainType.Freight,
    });
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true);

    await expect(
      PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Steel),
    ).rejects.toThrow('Train at capacity (2/2)');
  });

  it('should allow pickup when HeavyFreight has 2 of 3 loads', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal, LoadType.Wine],
      trainType: TrainType.HeavyFreight, // capacity = 3
    });
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true);

    const result = await PlayerService.pickupLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Steel,
    );

    expect(result.updatedLoads).toEqual([
      LoadType.Coal,
      LoadType.Wine,
      LoadType.Steel,
    ]);
  });

  it('should reject if load is not available at city', async () => {
    const player = makePlayerRow({ position_row: 5, position_col: 10 });
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(false);
    mockLoadService.getDroppedLoads.mockResolvedValue([]);

    await expect(
      PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Oranges),
    ).rejects.toThrow('Oranges is not available at Berlin');
  });

  it('should reject if player not found', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT — no player

    await expect(
      PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('Player not found in game');
  });

  it('should work at major city outpost mileposts', async () => {
    // Berlin outpost is at (row=5, col=11)
    const player = makePlayerRow({ position_row: 5, position_col: 11 });
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true);

    const result = await PlayerService.pickupLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Coal,
    );

    expect(result.updatedLoads).toEqual([LoadType.Coal]);
  });

  it('should reject if player has no position', async () => {
    const player = makePlayerRow({ position_row: null, position_col: null });
    setupPlayerQuery(player);
    mockLoadService.isLoadAvailableAtCity.mockReturnValue(true);

    await expect(
      PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('Player is not at Berlin');
  });
});

describe('PlayerService.dropLoadForUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
    mockLoadService.setLoadInCity.mockResolvedValue({
      loadState: {} as any,
      droppedLoads: [],
    });
  });

  it('should drop a load at a city', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal, LoadType.Wine],
    });
    setupPlayerQuery(player);

    const result = await PlayerService.dropLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Coal,
    );

    expect(result.updatedLoads).toEqual([LoadType.Wine]);
    expect(mockLoadService.setLoadInCity).toHaveBeenCalledWith(
      'Berlin',
      LoadType.Coal,
      GAME_ID,
    );
  });

  it('should reject if player is not at the city', async () => {
    const player = makePlayerRow({
      position_row: 12,
      position_col: 30,
      loads: [LoadType.Coal],
    });
    setupPlayerQuery(player);

    await expect(
      PlayerService.dropLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('Player is not at Berlin');
  });

  it('should reject if load is not on the train', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal],
    });
    setupPlayerQuery(player);

    await expect(
      PlayerService.dropLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Wine),
    ).rejects.toThrow('Wine is not on the train');
  });

  it('should reject if player not found', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT — no player

    await expect(
      PlayerService.dropLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('Player not found in game');
  });

  it('should drop only one instance when duplicates exist', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal, LoadType.Coal, LoadType.Wine],
      trainType: TrainType.HeavyFreight,
    });
    setupPlayerQuery(player);

    const result = await PlayerService.dropLoadForUser(
      GAME_ID,
      USER_ID,
      'Berlin',
      LoadType.Coal,
    );

    // Only one Coal removed, one Coal + Wine remain
    expect(result.updatedLoads).toEqual([LoadType.Coal, LoadType.Wine]);
  });

  it('should work at small cities', async () => {
    // Lubeck is at (row=8, col=20)
    const player = makePlayerRow({
      position_row: 8,
      position_col: 20,
      loads: [LoadType.Fish],
    });
    setupPlayerQuery(player);

    const result = await PlayerService.dropLoadForUser(
      GAME_ID,
      USER_ID,
      'Lubeck',
      LoadType.Fish,
    );

    expect(result.updatedLoads).toEqual([]);
    expect(mockLoadService.setLoadInCity).toHaveBeenCalledWith(
      'Lubeck',
      LoadType.Fish,
      GAME_ID,
    );
  });

  it('should rollback on error', async () => {
    const player = makePlayerRow({
      position_row: 5,
      position_col: 10,
      loads: [LoadType.Coal],
    });
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [player] }) // SELECT
      .mockRejectedValueOnce(new Error('DB write failed')); // UPDATE fails

    await expect(
      PlayerService.dropLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
    ).rejects.toThrow('DB write failed');

    // Verify ROLLBACK was called
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
