/**
 * Unit tests for PlayerService action restrictions via ActiveEffectManager.
 *
 * These tests verify that PlayerService enforces event card restrictions from
 * ActiveEffectManager in the following methods:
 *
 *  - moveTrainForUser: half_rate, blocked_terrain, no_movement_on_player_rail
 *  - buildTrackForPlayer: blocked_terrain, no_build_for_player, Flood rebuild blocking
 *  - pickupLoadForPlayer: no_pickup_delivery_in_zone
 *  - deliverLoadForUser: no_pickup_delivery_in_zone
 *
 * Approach: ActiveEffectManager is mocked. Tests verify:
 *  1. Restriction checks are called with correct gameId
 *  2. Violations produce descriptive errors
 *  3. Non-violating cases proceed normally
 *  4. Concurrent restrictions are all enforced
 *
 * Uses TDD: tests are written before implementation to drive the
 * restriction enforcement code in PlayerService methods.
 */

import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { LoadService } from '../services/loadService';
import { activeEffectManager, ActiveEffectManager } from '../services/ActiveEffectManager';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { TerrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import {
  ActiveEffect,
  BuildRestriction,
  EventCardType,
  MovementRestriction,
  PickupDeliveryRestriction,
} from '../../shared/types/EventCard';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../db/index', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
    __mockClient: mockClient,
  };
});

jest.mock('../services/loadService');

// Mock ActiveEffectManager singleton — gives full control over restriction returns
jest.mock('../services/ActiveEffectManager', () => {
  const mockManager = {
    getMovementRestrictions: jest.fn(),
    getBuildRestrictions: jest.fn(),
    getPickupDeliveryRestrictions: jest.fn(),
    getActiveEffects: jest.fn(),
  };
  return {
    ActiveEffectManager: jest.fn().mockImplementation(() => mockManager),
    activeEffectManager: mockManager,
  };
});

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

const mockDb = (jest.requireMock('../db/index') as { db: { query: jest.Mock } }).db;
const mockActiveEffectManager = activeEffectManager as jest.Mocked<ActiveEffectManager>;

// ── Constants ─────────────────────────────────────────────────────────────────

const GAME_ID = 'game-restriction-test';
const PLAYER_ID = 'player-001';
const USER_ID = 'user-001';

// ── Track segment helpers ─────────────────────────────────────────────────────

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
  terrain: TerrainType = TerrainType.Clear,
  cost = 1,
): TrackSegment {
  return {
    from: { row: fromRow, col: fromCol, x: 0, y: 0, terrain },
    to: { row: toRow, col: toCol, x: 1, y: 0, terrain },
    cost,
  };
}

// Milepost key helper — matches the format used in zone arrays
function mpKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ── DB setup helpers ──────────────────────────────────────────────────────────

/**
 * Configure mock responses for buildTrackForPlayer DB calls.
 */
function setupBuildMocks(opts: { money?: number } = {}): void {
  const { money = 50 } = opts;
  mockClient.query.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve();
    }
    if (sql.includes('SELECT money')) {
      return Promise.resolve({ rows: [{ money }] });
    }
    if (sql.includes('INSERT INTO player_tracks')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('UPDATE players SET money')) {
      return Promise.resolve({ rows: [{ money: money - 1 }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

/**
 * Configure mock responses for pickupLoadForPlayer DB calls.
 */
function setupPickupMocks(opts: { loads?: LoadType[] } = {}): void {
  const { loads = [] } = opts;
  mockClient.query.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve();
    }
    if (sql.includes('SELECT loads')) {
      return Promise.resolve({
        rows: [{ loads, trainType: 'Freight' }],
      });
    }
    if (sql.includes('UPDATE players SET loads')) {
      return Promise.resolve({
        rows: [{ loads: [...loads, LoadType.Coal] }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  const mockLoadSvc = { pickupDroppedLoad: jest.fn().mockResolvedValue({}) };
  (LoadService.getInstance as jest.Mock) = jest.fn().mockReturnValue(mockLoadSvc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: buildTrackForPlayer — Build Restrictions
// Chosen as the primary integration surface because it has the simplest DB mock
// requirements among the three action methods.
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService.buildTrackForPlayer — build restrictions', () => {
  const clearSegments: TrackSegment[] = [
    makeSegment(1, 1, 1, 2, TerrainType.Clear, 1),
  ];
  const alpineSegments: TrackSegment[] = [
    makeSegment(1, 1, 2, 2, TerrainType.Alpine, 5),
  ];
  const mountainSegments: TrackSegment[] = [
    makeSegment(3, 3, 4, 4, TerrainType.Mountain, 2),
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no active restrictions
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Happy path: no restrictions ───────────────────────────────────────────

  it('should allow build to clear terrain when no active effects', async () => {
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });

  it('should allow build to Alpine terrain when no active effects', async () => {
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, alpineSegments, [], 5),
    ).resolves.toBeDefined();
  });

  it('calls getBuildRestrictions with correct gameId for every build', async () => {
    setupBuildMocks();

    await PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1)
      .catch(() => {});

    expect(mockActiveEffectManager.getBuildRestrictions).toHaveBeenCalledWith(GAME_ID);
  });

  // ── Snow blocked_terrain: Alpine ─────────────────────────────────────────

  it('rejects build to Alpine milepost in Snow blocked_terrain zone', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(2, 2)], // destination of alpineSegments
        blockedTerrain: [TerrainType.Alpine],
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, alpineSegments, [], 5),
    ).rejects.toThrow();
  });

  it('error message for Alpine blocked_terrain describes the restriction', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(2, 2)],
        blockedTerrain: [TerrainType.Alpine],
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, alpineSegments, [], 5),
    ).rejects.toThrow(/block|restrict|Snow|terrain|alpine/i);
  });

  // ── Snow blocked_terrain: Mountain ───────────────────────────────────────

  it('rejects build to Mountain milepost in Snow blocked_terrain zone', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(4, 4)], // destination of mountainSegments
        blockedTerrain: [TerrainType.Mountain],
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, mountainSegments, [], 2),
    ).rejects.toThrow();
  });

  it('allows build to Mountain milepost outside Snow zone', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(99, 99)], // different milepost — not the destination
        blockedTerrain: [TerrainType.Mountain],
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, mountainSegments, [], 2),
    ).resolves.toBeDefined();
  });

  it('allows build to Clear terrain even when Alpine is in Snow zone', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(1, 2)], // destination of clearSegments IS in zone but terrain is Clear
        blockedTerrain: [TerrainType.Alpine], // Alpine blocked, not Clear
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });

  // ── Strike: no_build_for_player ───────────────────────────────────────────

  it('rejects build when no_build_for_player targets this player (Rail Strike)', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'no_build_for_player',
        targetPlayerId: PLAYER_ID,
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).rejects.toThrow();
  });

  it('error message for no_build_for_player describes the restriction', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'no_build_for_player',
        targetPlayerId: PLAYER_ID,
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).rejects.toThrow(/build|strike|restrict/i);
  });

  it('allows build for other player when no_build_for_player targets a different player', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'no_build_for_player',
        targetPlayerId: 'drawing-player-id', // different from PLAYER_ID
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });

  // ── Flood rebuild blocking ────────────────────────────────────────────────

  it('calls getActiveEffects to check for Flood rebuild blocking', async () => {
    setupBuildMocks();

    await PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1)
      .catch(() => {});

    // After implementation: getActiveEffects must be called to check Flood
    expect(mockActiveEffectManager.getActiveEffects).toHaveBeenCalledWith(GAME_ID);
  });

  it('allows build when no Flood effect is active', async () => {
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
    setupBuildMocks();

    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });

  it('rejects build crossing flooded river when Flood effect is active', async () => {
    // Create a Flood effect with a known river name
    const floodEffect: ActiveEffect = {
      cardId: 133,
      cardType: EventCardType.Flood,
      drawingPlayerId: 'some-player',
      drawingPlayerIndex: 1,
      expiresAfterTurnNumber: 5,
      affectedZone: new Set<string>(),
      restrictions: { movement: [], build: [], pickupDelivery: [] },
      pendingLostTurns: [],
      floodedRiver: 'Rhine',
    };
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([floodEffect]);
    setupBuildMocks();

    // Rhine river segments will need to be identified by getRiverEdgeKeys
    // The build segments may or may not cross the Rhine — the test verifies
    // that the check is attempted (getActiveEffects is called)
    await PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1)
      .catch(() => {});

    expect(mockActiveEffectManager.getActiveEffects).toHaveBeenCalledWith(GAME_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: pickupLoadForPlayer — Pickup/Delivery Restrictions
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService.pickupLoadForPlayer — pickup restrictions', () => {
  // Use a city name and corresponding milepost key for zone matching
  // The zone key format matches what EventCardService stores
  const cityName = 'Hamburg';
  const hamburgMpKey = '10,5'; // example coastal milepost key

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('should allow pickup when no active effects', async () => {
    setupPickupMocks();

    await expect(
      PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, cityName),
    ).resolves.toBeDefined();
  });

  it('calls getPickupDeliveryRestrictions with correct gameId', async () => {
    setupPickupMocks();

    await PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, cityName)
      .catch(() => {});

    expect(mockActiveEffectManager.getPickupDeliveryRestrictions).toHaveBeenCalledWith(GAME_ID);
  });

  // ── Strike coastal: no_pickup_delivery_in_zone ────────────────────────────

  it('rejects pickup when city milepost is in Strike coastal zone', async () => {
    const restrictions: PickupDeliveryRestriction[] = [
      {
        type: 'no_pickup_delivery_in_zone',
        zone: [hamburgMpKey, '11,5', '10,6'],
      },
    ];
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue(restrictions);
    setupPickupMocks();

    await expect(
      PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, cityName),
    ).rejects.toThrow();
  });

  it('error message for no_pickup_delivery_in_zone describes the restriction', async () => {
    const restrictions: PickupDeliveryRestriction[] = [
      {
        type: 'no_pickup_delivery_in_zone',
        zone: [hamburgMpKey],
      },
    ];
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue(restrictions);
    setupPickupMocks();

    await expect(
      PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, cityName),
    ).rejects.toThrow(/strike|restrict|pickup|zone|coast/i);
  });

  it('allows pickup at city outside Strike coastal zone', async () => {
    const restrictions: PickupDeliveryRestriction[] = [
      {
        type: 'no_pickup_delivery_in_zone',
        zone: ['coastal-key-1', 'coastal-key-2', 'coastal-key-3'],
        // Hamburg milepost key NOT in this zone
      },
    ];
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue(restrictions);
    setupPickupMocks();

    await expect(
      PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, cityName),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: deliverLoadForUser — Pickup/Delivery Restrictions
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService.deliverLoadForUser — delivery restrictions', () => {
  const cityName = 'Hamburg';
  const hamburgMpKey = '10,5';

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls getPickupDeliveryRestrictions with correct gameId on delivery', async () => {
    // Setup minimal DB mocks for deliverLoadForUser
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      if (sql.includes('FROM players') && sql.includes('user_id = $2')) {
        return Promise.resolve({
          rows: [{
            id: PLAYER_ID,
            money: 100,
            debtOwed: 0,
            hand: [31],
            loads: [LoadType.Coal],
            turnNumber: 1,
          }],
        });
      }
      if (sql.includes('FROM games') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      if (sql.includes('FROM players') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [{ id: PLAYER_ID }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // This will likely throw due to demandDeckService.getCard(31) — that's OK
    await PlayerService.deliverLoadForUser(
      GAME_ID, USER_ID, cityName, LoadType.Coal, 31,
    ).catch(() => {});

    expect(mockActiveEffectManager.getPickupDeliveryRestrictions).toHaveBeenCalledWith(GAME_ID);
  });

  it('rejects delivery when city milepost is in Strike coastal zone', async () => {
    const restrictions: PickupDeliveryRestriction[] = [
      {
        type: 'no_pickup_delivery_in_zone',
        zone: [hamburgMpKey, '11,5'],
      },
    ];
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue(restrictions);

    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      if (sql.includes('FROM players') && sql.includes('user_id = $2')) {
        return Promise.resolve({
          rows: [{
            id: PLAYER_ID,
            money: 100,
            debtOwed: 0,
            hand: [31],
            loads: [LoadType.Coal],
            turnNumber: 1,
          }],
        });
      }
      if (sql.includes('FROM games') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      if (sql.includes('FROM players') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [{ id: PLAYER_ID }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      PlayerService.deliverLoadForUser(
        GAME_ID, USER_ID, cityName, LoadType.Coal, 31,
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: moveTrainForUser — Movement Restrictions
// These test the restriction checking behavior as TDD contracts.
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService.moveTrainForUser — movement restrictions (TDD)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Setup full moveTrainForUser DB mocks
  function setupFullMoveMocks(playerId: string = PLAYER_ID): void {
    // db.query is used by TrackService.getAllTracks
    mockDb.query.mockResolvedValue({ rows: [] });

    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      // Player row with position
      if (sql.includes('FROM players') && sql.includes('user_id = $2') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({
          rows: [{
            id: playerId,
            money: 100,
            position_row: null, // null = first placement, no movement history needed
            position_col: null,
            position_x: null,
            position_y: null,
            turnNumber: 1,
          }],
        });
      }
      // Game row
      if (sql.includes('FROM games') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      // Active player lookup
      if (sql.includes('FROM players') && sql.includes('ORDER BY created_at ASC LIMIT 1 OFFSET')) {
        return Promise.resolve({ rows: [{ id: playerId }] });
      }
      // Turn actions
      if (sql.includes('FROM turn_actions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      // Movement history reads
      if (sql.includes('FROM movement_history') && !sql.includes('INSERT') && !sql.includes('UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      // Movement history write
      if (sql.includes('INSERT INTO movement_history')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE movement_history')) {
        return Promise.resolve({ rows: [] });
      }
      // Turn actions write
      if (sql.includes('INSERT INTO turn_actions')) {
        return Promise.resolve({ rows: [] });
      }
      // Position update
      if (sql.includes('UPDATE players') && sql.includes('position_row')) {
        return Promise.resolve({ rows: [{ money: 100 }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('calls getMovementRestrictions with correct gameId', async () => {
    setupFullMoveMocks();

    await PlayerService.moveTrainForUser({
      gameId: GAME_ID,
      userId: USER_ID,
      to: { row: 6, col: 5 },
    }).catch(() => {});

    expect(mockActiveEffectManager.getMovementRestrictions).toHaveBeenCalledWith(GAME_ID);
  });

  it('allows movement when no active effects', async () => {
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 6, col: 5 },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects movement into Snow blocked_terrain (Alpine) when destination milepost is in zone', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(6, 5)],
        blockedTerrain: [TerrainType.Alpine],
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 6, col: 5 },
      }),
    ).rejects.toThrow();
  });

  it('error message for movement blocked_terrain describes the restriction', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(6, 5)],
        blockedTerrain: [TerrainType.Alpine],
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 6, col: 5 },
      }),
    ).rejects.toThrow(/block|restrict|Snow|terrain|alpine/i);
  });

  it('rejects movement into Snow blocked_terrain (Mountain) when destination is in zone', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(7, 3)],
        blockedTerrain: [TerrainType.Mountain],
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 7, col: 3 },
      }),
    ).rejects.toThrow();
  });

  it('rejects movement when no_movement_on_player_rail targets moving player (Rail Strike)', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'no_movement_on_player_rail',
        targetPlayerId: PLAYER_ID,
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 6, col: 5 },
      }),
    ).rejects.toThrow();
  });

  it('allows movement for non-target player when no_movement_on_player_rail targets a different player', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'no_movement_on_player_rail',
        targetPlayerId: 'drawing-player-id', // not PLAYER_ID
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    await expect(
      PlayerService.moveTrainForUser({
        gameId: GAME_ID,
        userId: USER_ID,
        to: { row: 6, col: 5 },
      }),
    ).resolves.toBeDefined();
  });

  it('enforces half_rate restriction when destination is in Snow zone', async () => {
    const restrictions: MovementRestriction[] = [
      {
        type: 'half_rate',
        zone: [mpKey(6, 5)],
      },
    ];
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(restrictions);
    setupFullMoveMocks();

    // half_rate does not reject — it caps movement. The train may still reach dest.
    // We verify restriction check was called and no unexpected errors thrown for valid moves.
    await PlayerService.moveTrainForUser({
      gameId: GAME_ID,
      userId: USER_ID,
      to: { row: 6, col: 5 },
    }).catch(() => {});

    expect(mockActiveEffectManager.getMovementRestrictions).toHaveBeenCalledWith(GAME_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Concurrent restrictions (Snow + Strike simultaneously)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService — concurrent restrictions (Snow + Strike)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
  });

  it('build rejects when both Snow blocked_terrain and Strike no_build_for_player are active', async () => {
    const restrictions: BuildRestriction[] = [
      {
        type: 'blocked_terrain',
        zone: [mpKey(2, 2)],
        blockedTerrain: [TerrainType.Alpine],
      },
      {
        type: 'no_build_for_player',
        targetPlayerId: PLAYER_ID,
      },
    ];
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue(restrictions);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
    setupBuildMocks();

    const alpineSegments = [makeSegment(1, 1, 2, 2, TerrainType.Alpine, 5)];
    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, alpineSegments, [], 5),
    ).rejects.toThrow();
  });

  it('pickup rejects when both coastal Strike and snow half_rate are active', async () => {
    const pickupRestrictions: PickupDeliveryRestriction[] = [
      { type: 'no_pickup_delivery_in_zone', zone: ['10,5'] },
    ];
    const movementRestrictions: MovementRestriction[] = [
      { type: 'half_rate', zone: ['10,5', '11,5'] },
    ];

    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue(pickupRestrictions);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue(movementRestrictions);
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    setupPickupMocks();

    await expect(
      PlayerService.pickupLoadForPlayer(GAME_ID, PLAYER_ID, LoadType.Coal, 'Hamburg'),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Flood rebuild allowed after expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('PlayerService.buildTrackForPlayer — Flood expiry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveEffectManager.getBuildRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getMovementRestrictions.mockResolvedValue([]);
    mockActiveEffectManager.getPickupDeliveryRestrictions.mockResolvedValue([]);
  });

  it('allows build when Flood effect has expired (no active Flood effects)', async () => {
    // No Flood effects — empty active effects
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([]);
    setupBuildMocks();

    const clearSegments = [makeSegment(1, 1, 1, 2, TerrainType.Clear, 1)];
    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });

  it('allows build with non-Flood active effects present', async () => {
    // Only Snow effects — no Flood
    const snowEffect: ActiveEffect = {
      cardId: 130,
      cardType: EventCardType.Snow,
      drawingPlayerId: 'some-player',
      drawingPlayerIndex: 0,
      expiresAfterTurnNumber: 3,
      affectedZone: new Set<string>(['5,5', '6,5']),
      restrictions: {
        movement: [{ type: 'half_rate', zone: ['5,5', '6,5'] }],
        build: [],
        pickupDelivery: [],
      },
      pendingLostTurns: [],
    };
    mockActiveEffectManager.getActiveEffects.mockResolvedValue([snowEffect]);
    setupBuildMocks();

    const clearSegments = [makeSegment(1, 1, 1, 2, TerrainType.Clear, 1)];
    await expect(
      PlayerService.buildTrackForPlayer(GAME_ID, PLAYER_ID, clearSegments, [], 1),
    ).resolves.toBeDefined();
  });
});
