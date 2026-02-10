/**
 * Tests for bot player creation (LobbyService.addBot/removeBot)
 * and initial train placement (AIStrategyEngine.placeInitialTrain).
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

jest.mock('../../db', () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () => mockConnect(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitLobbyUpdated: jest.fn().mockResolvedValue(undefined),
  emitToLobby: jest.fn().mockResolvedValue(undefined),
  emitToGame: jest.fn(),
  emitTurnChange: jest.fn(),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

jest.mock('../../services/demandDeckService', () => ({
  demandDeckService: {
    getCard: jest.fn().mockReturnValue({ id: 1, demands: [] }),
    drawCard: jest.fn()
      .mockReturnValueOnce({ id: 1, demands: [{ city: 'Berlin', resource: 'Coal', payment: 30 }] })
      .mockReturnValueOnce({ id: 2, demands: [{ city: 'Paris', resource: 'Wine', payment: 40 }] })
      .mockReturnValueOnce({ id: 3, demands: [{ city: 'Roma', resource: 'Fruit', payment: 25 }] }),
    discardCard: jest.fn(),
    ensureCardIsDealt: jest.fn(),
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

jest.mock('../../services/trackService', () => ({
  TrackService: {
    getTrackState: jest.fn(),
    getAllTracks: jest.fn(),
  },
}));

jest.mock('../../../../configuration/gridPoints.json', () => [
  { GridX: 10, GridY: 5, Type: 'Major City', Name: 'Berlin' },
  { GridX: 20, GridY: 15, Type: 'Major City', Name: 'Paris' },
  { GridX: 30, GridY: 25, Type: 'Major City', Name: 'Roma' },
], { virtual: true });

jest.mock('../../services/botAuditService', () => ({
  BotAuditService: {
    saveTurnAudit: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Imports ---

import { LobbyService, GameNotFoundError, NotGameCreatorError, GameAlreadyStartedError, GameFullError, LobbyError } from '../../services/lobbyService';
import { AIStrategyEngine } from '../../ai/AIStrategyEngine';
import { WorldSnapshotService } from '../../ai/WorldSnapshotService';
import { TrainType, TerrainType } from '../../../shared/types/GameTypes';

// --- Helpers ---

const GAME_ID = 'game-1';
const HOST_USER_ID = 'host-user-1';

function setupClient() {
  mockConnect.mockResolvedValue(mockClient);
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockClient.query.mockResolvedValue({ rows: [] });
}

// --- Tests ---

describe('LobbyService.addBot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
  });

  it('should create a bot player with correct config', async () => {
    // Setup: BEGIN, game check, player count, used colors, INSERT user, createPlayer (game check + color check + INSERT), COMMIT
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: GAME_ID, created_by: HOST_USER_ID, status: 'setup', max_players: 6 }],
      }) // SELECT game
      .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // COUNT players
      .mockResolvedValueOnce({ rows: [{ color: '#ff0000' }] }) // SELECT used colors
      .mockResolvedValueOnce({ rows: [] }) // INSERT bot user
      .mockResolvedValueOnce({ rows: [{ id: GAME_ID }] }) // game exists check in createPlayer
      .mockResolvedValueOnce({ rows: [] }) // color check in createPlayer
      .mockResolvedValueOnce({ rows: [] }) // INSERT player
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const player = await LobbyService.addBot(GAME_ID, HOST_USER_ID, {
      skillLevel: 'hard',
      archetype: 'backbone_builder',
      botName: 'Test Bot',
    });

    expect(player.isBot).toBe(true);
    expect(player.name).toBe('Test Bot');
    expect(player.botConfig).toEqual({
      archetype: 'backbone_builder',
      skillLevel: 'hard',
    });
    expect(player.color).toBe('#0000ff'); // Second color (first is taken)
    expect(player.money).toBe(50);
    expect(player.trainType).toBe(TrainType.Freight);
    expect(player.userId).toBeTruthy(); // Synthetic user UUID
  });

  it('should reject if user is not the host', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: GAME_ID, created_by: 'other-user', status: 'setup', max_players: 6 }],
      });

    await expect(
      LobbyService.addBot(GAME_ID, HOST_USER_ID, {
        skillLevel: 'easy',
        archetype: 'opportunist',
        botName: 'Bot',
      }),
    ).rejects.toThrow(NotGameCreatorError);
  });

  it('should reject if game is not in setup', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: GAME_ID, created_by: HOST_USER_ID, status: 'active', max_players: 6 }],
      });

    await expect(
      LobbyService.addBot(GAME_ID, HOST_USER_ID, {
        skillLevel: 'easy',
        archetype: 'opportunist',
        botName: 'Bot',
      }),
    ).rejects.toThrow(GameAlreadyStartedError);
  });

  it('should reject if game is full', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: GAME_ID, created_by: HOST_USER_ID, status: 'setup', max_players: 2 }],
      })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] }); // COUNT players

    await expect(
      LobbyService.addBot(GAME_ID, HOST_USER_ID, {
        skillLevel: 'easy',
        archetype: 'opportunist',
        botName: 'Bot',
      }),
    ).rejects.toThrow(GameFullError);
  });

  it('should reject if game not found', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT game (empty)

    await expect(
      LobbyService.addBot(GAME_ID, HOST_USER_ID, {
        skillLevel: 'easy',
        archetype: 'opportunist',
        botName: 'Bot',
      }),
    ).rejects.toThrow(GameNotFoundError);
  });
});

describe('LobbyService.removeBot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
  });

  it('should remove a bot player and its synthetic user', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ created_by: HOST_USER_ID, status: 'setup' }],
      }) // SELECT game
      .mockResolvedValueOnce({
        rows: [{ id: 'bot-player-1', user_id: 'bot-user-1', is_bot: true }],
      }) // SELECT player
      .mockResolvedValueOnce({ rows: [] }) // DELETE player
      .mockResolvedValueOnce({ rows: [] }) // DELETE user
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await LobbyService.removeBot(GAME_ID, HOST_USER_ID, 'bot-player-1');

    // Verify DELETE player was called
    const deletePlayerCall = mockClient.query.mock.calls[3];
    expect(deletePlayerCall[0]).toContain('DELETE');
    expect(deletePlayerCall[1]).toEqual(['bot-player-1']);

    // Verify DELETE user was called
    const deleteUserCall = mockClient.query.mock.calls[4];
    expect(deleteUserCall[0]).toContain('DELETE');
    expect(deleteUserCall[1]).toEqual(['bot-user-1']);
  });

  it('should reject removing a human player', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ created_by: HOST_USER_ID, status: 'setup' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'human-player-1', is_bot: false }],
      });

    await expect(
      LobbyService.removeBot(GAME_ID, HOST_USER_ID, 'human-player-1'),
    ).rejects.toThrow('Cannot remove a human player');
  });

  it('should reject if not the host', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ created_by: 'other-user', status: 'setup' }],
      });

    await expect(
      LobbyService.removeBot(GAME_ID, HOST_USER_ID, 'bot-player-1'),
    ).rejects.toThrow(NotGameCreatorError);
  });
});

describe('AIStrategyEngine.placeInitialTrain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should place train at the major city closest to demand card cities', async () => {
    // Mock WorldSnapshotService.capture
    jest.spyOn(WorldSnapshotService, 'capture').mockResolvedValue({
      gameId: GAME_ID,
      botPlayerId: 'bot-1',
      botUserId: 'bot-user-1',
      gamePhase: 'initialBuild',
      turnBuildCostSoFar: 0,
      position: null,
      money: 50,
      debtOwed: 0,
      trainType: TrainType.Freight,
      remainingMovement: 9,
      carriedLoads: [],
      demandCards: [
        { id: 1, demands: [
          { city: 'Berlin', resource: 'Coal' as any, payment: 30 },
          { city: 'Berlin', resource: 'Steel' as any, payment: 40 },
          { city: 'Berlin', resource: 'Wine' as any, payment: 20 },
        ]},
      ],
      trackSegments: [],
      connectedMajorCities: 0,
      opponents: [],
      allPlayerTracks: [],
      loadAvailability: new Map(),
      droppedLoads: new Map(),
      mapPoints: [
        { id: '1', x: 0, y: 0, row: 5, col: 10, terrain: TerrainType.MajorCity, city: { type: TerrainType.MajorCity, name: 'Berlin', availableLoads: [] } },
        { id: '2', x: 0, y: 0, row: 15, col: 20, terrain: TerrainType.MajorCity, city: { type: TerrainType.MajorCity, name: 'Paris', availableLoads: [] } },
        { id: '3', x: 0, y: 0, row: 25, col: 30, terrain: TerrainType.MajorCity, city: { type: TerrainType.MajorCity, name: 'Roma', availableLoads: [] } },
      ] as any[],
      activeEvents: [],
    });

    // Mock DB update for position
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIStrategyEngine.placeInitialTrain(
      GAME_ID,
      'bot-1',
      'bot-user-1',
    );

    // Berlin should be selected since all 3 demands reference Berlin
    expect(result.cityName).toBe('Berlin');
    expect(result.row).toBe(5);
    expect(result.col).toBe(10);

    // Verify DB update was called
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE players'),
      [5, 10, GAME_ID, 'bot-1'],
    );
  });

  it('should fall back to first major city when no demand cards match', async () => {
    jest.spyOn(WorldSnapshotService, 'capture').mockResolvedValue({
      gameId: GAME_ID,
      botPlayerId: 'bot-1',
      botUserId: 'bot-user-1',
      gamePhase: 'initialBuild',
      turnBuildCostSoFar: 0,
      position: null,
      money: 50,
      debtOwed: 0,
      trainType: TrainType.Freight,
      remainingMovement: 9,
      carriedLoads: [],
      demandCards: [],  // No cards
      trackSegments: [],
      connectedMajorCities: 0,
      opponents: [],
      allPlayerTracks: [],
      loadAvailability: new Map(),
      droppedLoads: new Map(),
      mapPoints: [
        { id: '1', x: 0, y: 0, row: 5, col: 10, terrain: TerrainType.MajorCity, city: { type: TerrainType.MajorCity, name: 'Berlin', availableLoads: [] } },
        { id: '2', x: 0, y: 0, row: 15, col: 20, terrain: TerrainType.MajorCity, city: { type: TerrainType.MajorCity, name: 'Paris', availableLoads: [] } },
      ] as any[],
      activeEvents: [],
    });

    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIStrategyEngine.placeInitialTrain(
      GAME_ID,
      'bot-1',
      'bot-user-1',
    );

    // Should still return a valid city (first major city)
    expect(result.cityName).toBeTruthy();
    expect(result.row).toBeDefined();
    expect(result.col).toBeDefined();
  });
});
