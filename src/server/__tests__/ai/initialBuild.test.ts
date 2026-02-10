/**
 * InitialBuildService tests
 *
 * Verifies:
 * - Phase initialization (round 1 clockwise order)
 * - Turn advancement within a round
 * - Round 1 → Round 2 transition (reverse order)
 * - Round 2 → Active phase transition
 * - Phase guards on PlayerService methods
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

jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  getSocketIO: jest.fn().mockReturnValue(null),
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

jest.mock('../../../../configuration/gridPoints.json', () => [
  { GridX: 10, GridY: 5, Type: 'Major City', Name: 'Berlin' },
], { virtual: true });

// --- Imports ---

import { InitialBuildService } from '../../services/initialBuildService';
import { PlayerService } from '../../services/playerService';
import { emitTurnChange } from '../../services/socketService';
import { LoadType } from '../../../shared/types/LoadTypes';
import { TrainType } from '../../../shared/types/GameTypes';

const mockEmitTurnChange = emitTurnChange as jest.Mock;

// --- Helpers ---

const GAME_ID = 'game-1';

function setupClient() {
  mockConnect.mockResolvedValue(mockClient);
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockClient.query.mockResolvedValue({ rows: [] });
}

// --- Tests ---

describe('InitialBuildService.initPhase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
  });

  it('should set round 1 with clockwise player order', async () => {
    // Players query returns 3 players in created_at order
    mockClient.query
      .mockResolvedValueOnce({
        rows: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      }) // SELECT players
      .mockResolvedValueOnce({ rows: [] }); // UPDATE games

    await InitialBuildService.initPhase(mockClient, GAME_ID);

    // Verify UPDATE was called with correct params
    const updateCall = mockClient.query.mock.calls[1];
    expect(updateCall[0]).toContain('initial_build_round = 1');
    expect(updateCall[0]).toContain("status = 'initialBuild'");
    expect(updateCall[0]).toContain('current_player_index = 0');
    expect(updateCall[1]).toEqual([JSON.stringify(['p1', 'p2', 'p3']), GAME_ID]);
  });

  it('should reject if fewer than 2 players', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    await expect(
      InitialBuildService.initPhase(mockClient, GAME_ID),
    ).rejects.toThrow('Need at least 2 players');
  });
});

describe('InitialBuildService.advanceTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
    mockEmitTurnChange.mockReset();
  });

  it('should advance to next player within a round', async () => {
    // Setup: round 1, index 0, 3 players
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          initial_build_round: 1,
          initial_build_order: ['p1', 'p2', 'p3'],
          current_player_index: 0,
        }],
      }) // SELECT game FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE current_player_index
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await InitialBuildService.advanceTurn(GAME_ID);

    expect(result.phase).toBe('initialBuild');
    expect(result.currentPlayerIndex).toBe(1);
    expect(result.currentPlayerId).toBe('p2');
    expect(mockEmitTurnChange).toHaveBeenCalledWith(GAME_ID, 1, 'p2');
  });

  it('should transition from round 1 to round 2 with reverse order', async () => {
    // Setup: round 1, last player (index 2 of [p1,p2,p3])
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          initial_build_round: 1,
          initial_build_order: ['p1', 'p2', 'p3'],
          current_player_index: 2,
        }],
      }) // SELECT game FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE round 2
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await InitialBuildService.advanceTurn(GAME_ID);

    expect(result.phase).toBe('initialBuild');
    expect(result.currentPlayerIndex).toBe(0);
    expect(result.currentPlayerId).toBe('p3'); // reversed order: p3 goes first

    // Verify UPDATE set round 2 with reversed order
    const updateCall = mockClient.query.mock.calls[2];
    expect(updateCall[0]).toContain('initial_build_round = 2');
    expect(updateCall[1]).toEqual([JSON.stringify(['p3', 'p2', 'p1']), GAME_ID]);
  });

  it('should transition to active phase after round 2 completes', async () => {
    // Setup: round 2, last player (index 2 of [p3,p2,p1])
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          initial_build_round: 2,
          initial_build_order: ['p3', 'p2', 'p1'],
          current_player_index: 2,
        }],
      }) // SELECT game FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      }) // SELECT players (clockwise)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE to active
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await InitialBuildService.advanceTurn(GAME_ID);

    expect(result.phase).toBe('active');
    // Last player of round 2 is p1 (index 2 of [p3,p2,p1])
    // p1 is index 0 in clockwise order
    expect(result.currentPlayerId).toBe('p1');
    expect(result.currentPlayerIndex).toBe(0);

    // Verify UPDATE set status to active
    const updateCall = mockClient.query.mock.calls[3];
    expect(updateCall[0]).toContain("status = 'active'");
    expect(updateCall[0]).toContain('initial_build_round = 0');
  });

  it('should handle 2-player game correctly', async () => {
    // Round 1 complete (index 1 of [p1,p2])
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          initial_build_round: 1,
          initial_build_order: ['p1', 'p2'],
          current_player_index: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE round 2
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await InitialBuildService.advanceTurn(GAME_ID);

    expect(result.phase).toBe('initialBuild');
    expect(result.currentPlayerId).toBe('p2'); // reversed: [p2, p1]
  });
});

describe('InitialBuildService.getState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return state for initialBuild game', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        status: 'initialBuild',
        initial_build_round: 1,
        initial_build_order: ['p1', 'p2'],
        current_player_index: 0,
      }],
    });

    const state = await InitialBuildService.getState(GAME_ID);

    expect(state).toEqual({
      round: 1,
      order: ['p1', 'p2'],
      currentIndex: 0,
    });
  });

  it('should return null for active game', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'active', initial_build_round: 0, initial_build_order: null, current_player_index: 0 }],
    });

    const state = await InitialBuildService.getState(GAME_ID);
    expect(state).toBeNull();
  });

  it('should return null for non-existent game', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const state = await InitialBuildService.getState(GAME_ID);
    expect(state).toBeNull();
  });
});

describe('Phase guards on PlayerService', () => {
  const USER_ID = 'user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    setupClient();
  });

  describe('moveTrainForUser', () => {
    it('should reject during initialBuild', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: 'p1', money: 50, position_row: 5, position_col: 10, position_x: null, position_y: null, turnNumber: 1 }],
        }) // SELECT player
        .mockResolvedValueOnce({
          rows: [{ current_player_index: 0, status: 'initialBuild' }],
        }); // SELECT game

      await expect(
        PlayerService.moveTrainForUser({
          gameId: GAME_ID,
          userId: USER_ID,
          to: { row: 6, col: 10 },
        }),
      ).rejects.toThrow('Cannot move train during initial build phase');
    });
  });

  describe('deliverLoadForUser', () => {
    it('should reject during initialBuild', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            id: 'p1', money: 50, debtOwed: 0, hand: [1], loads: [LoadType.Coal],
            turnNumber: 1,
          }],
        }) // SELECT player
        .mockResolvedValueOnce({
          rows: [{ current_player_index: 0, status: 'initialBuild' }],
        }); // SELECT game

      await expect(
        PlayerService.deliverLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal, 1),
      ).rejects.toThrow('Cannot deliver loads during initial build phase');
    });
  });

  describe('pickupLoadForUser', () => {
    it('should reject during initialBuild', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ status: 'initialBuild' }],
        }); // SELECT game status

      await expect(
        PlayerService.pickupLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
      ).rejects.toThrow('Cannot pick up loads during initial build phase');
    });
  });

  describe('dropLoadForUser', () => {
    it('should reject during initialBuild', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ status: 'initialBuild' }],
        }); // SELECT game status

      await expect(
        PlayerService.dropLoadForUser(GAME_ID, USER_ID, 'Berlin', LoadType.Coal),
      ).rejects.toThrow('Cannot drop loads during initial build phase');
    });
  });

  describe('discardHandForUser', () => {
    it('should reject during initialBuild', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: 'p1', hand: [1, 2, 3], turnNumber: 1 }],
        }) // SELECT player
        .mockResolvedValueOnce({
          rows: [{ current_player_index: 0, status: 'initialBuild' }],
        }); // SELECT game

      await expect(
        PlayerService.discardHandForUser(GAME_ID, USER_ID),
      ).rejects.toThrow('Action not allowed during initial build phase');
    });
  });
});
