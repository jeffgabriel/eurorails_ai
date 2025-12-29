import { db } from '../db';
import { VictoryService, MajorCityCoordinate } from '../services/victoryService';
import { TrackService } from '../services/trackService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';
import { VICTORY_INITIAL_THRESHOLD, VICTORY_TIE_THRESHOLD, TerrainType } from '../../shared/types/GameTypes';
import { TrackSegment } from '../../shared/types/TrackTypes';

/**
 * Helper to create a TrackSegment with all required fields.
 * Server validation only uses row/col, so we provide dummy values for x/y/terrain/cost.
 */
function createSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// Force Jest to run this test file serially
export const test = { concurrent: false };

// Helper to run a query with automatic connection management
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

describe('VictoryService Integration Tests', () => {
  let gameId: string;
  let playerId1: string;
  let playerId2: string;
  let playerId3: string;
  let userId1: string;
  let userId2: string;
  let userId3: string;

  beforeEach(async () => {
    gameId = uuidv4();
    playerId1 = uuidv4();
    playerId2 = uuidv4();
    playerId3 = uuidv4();
    userId1 = uuidv4();
    userId2 = uuidv4();
    userId3 = uuidv4();

    await runQuery(async (client) => {
      // Create users first
      await client.query(
        'INSERT INTO users (id, email, password_hash, username) VALUES ($1, $2, $3, $4)',
        [userId1, 'player1@test.com', 'hash1', 'Player1']
      );
      await client.query(
        'INSERT INTO users (id, email, password_hash, username) VALUES ($1, $2, $3, $4)',
        [userId2, 'player2@test.com', 'hash2', 'Player2']
      );
      await client.query(
        'INSERT INTO users (id, email, password_hash, username) VALUES ($1, $2, $3, $4)',
        [userId3, 'player3@test.com', 'hash3', 'Player3']
      );

      // Create game
      await client.query(
        `INSERT INTO games (id, status, current_player_index, max_players, victory_threshold)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, 'active', 0, 6, VICTORY_INITIAL_THRESHOLD]
      );

      // Create players (order matters for player_index calculation)
      // Note: color must be a hex code like #RRGGBB per database constraint
      await client.query(
        `INSERT INTO players (id, game_id, user_id, name, money, color, is_deleted, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [playerId1, gameId, userId1, 'Player1', 260, '#FF0000', false]
      );
      await client.query(
        `INSERT INTO players (id, game_id, user_id, name, money, color, is_deleted, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + interval '1 second')`,
        [playerId2, gameId, userId2, 'Player2', 200, '#0000FF', false]
      );
      await client.query(
        `INSERT INTO players (id, game_id, user_id, name, money, color, is_deleted, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + interval '2 seconds')`,
        [playerId3, gameId, userId3, 'Player3', 180, '#00FF00', false]
      );
    });
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      // Delete in dependency order
      await client.query('DELETE FROM turn_actions WHERE game_id = $1', [gameId]);
      await client.query('DELETE FROM player_tracks WHERE game_id = $1', [gameId]);
      await client.query('DELETE FROM players WHERE game_id = $1', [gameId]);
      await client.query('DELETE FROM games WHERE id = $1', [gameId]);
      await client.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [userId1, userId2, userId3]);
    });
  });

  describe('getVictoryState', () => {
    it('should return default victory state for new game', async () => {
      const state = await VictoryService.getVictoryState(gameId);

      expect(state).not.toBeNull();
      expect(state!.triggered).toBe(false);
      expect(state!.triggerPlayerIndex).toBe(-1);
      expect(state!.victoryThreshold).toBe(VICTORY_INITIAL_THRESHOLD);
      expect(state!.finalTurnPlayerIndex).toBe(-1);
    });

    it('should return null for non-existent game', async () => {
      // Use a valid UUID format that doesn't exist
      const state = await VictoryService.getVictoryState('00000000-0000-0000-0000-000000000000');
      expect(state).toBeNull();
    });
  });

  describe('validateCitiesInTrack', () => {
    it('should return true when all claimed cities exist in track', () => {
      const segments: TrackSegment[] = [
        createSegment(10, 20, 10, 21),
        createSegment(10, 21, 15, 25),
      ];
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'Paris', row: 10, col: 20 },
        { name: 'Berlin', row: 15, col: 25 },
      ];

      const result = VictoryService.validateCitiesInTrack(segments, claimedCities);
      expect(result).toBe(true);
    });

    it('should return false when a claimed city is not in track', () => {
      const segments: TrackSegment[] = [
        createSegment(10, 20, 10, 21),
      ];
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'Paris', row: 10, col: 20 },
        { name: 'Berlin', row: 15, col: 25 }, // Not in track
      ];

      const result = VictoryService.validateCitiesInTrack(segments, claimedCities);
      expect(result).toBe(false);
    });

    it('should handle empty track', () => {
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'Paris', row: 10, col: 20 },
      ];

      const result = VictoryService.validateCitiesInTrack([], claimedCities);
      expect(result).toBe(false);
    });

    it('should handle empty claimed cities', () => {
      const segments: TrackSegment[] = [
        createSegment(10, 20, 10, 21),
      ];

      const result = VictoryService.validateCitiesInTrack(segments, []);
      expect(result).toBe(true);
    });
  });

  describe('declareVictory', () => {
    beforeEach(async () => {
      // Create track for player1 with 7 cities
      const cityCoords = [
        { row: 10, col: 20 },
        { row: 15, col: 25 },
        { row: 20, col: 30 },
        { row: 25, col: 35 },
        { row: 30, col: 40 },
        { row: 35, col: 45 },
        { row: 40, col: 50 },
      ];

      // Connect cities linearly using helper
      const segments: TrackSegment[] = [];
      for (let i = 0; i < cityCoords.length - 1; i++) {
        segments.push(createSegment(
          cityCoords[i].row,
          cityCoords[i].col,
          cityCoords[i + 1].row,
          cityCoords[i + 1].col
        ));
      }

      // TrackService.saveTrackState expects a PlayerTrackState object
      // The lastBuildTimestamp is a TIMESTAMP in PostgreSQL, so pass a Date object or ISO string
      await TrackService.saveTrackState(gameId, playerId1, {
        playerId: playerId1,
        gameId: gameId,
        segments,
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      });
    });

    it('should reject victory when player has insufficient money', async () => {
      // Update player1 to have less than threshold
      await runQuery(async (client) => {
        await client.query('UPDATE players SET money = 200 WHERE id = $1', [playerId1]);
      });

      const claimedCities: MajorCityCoordinate[] = [
        { name: 'City1', row: 10, col: 20 },
        { name: 'City2', row: 15, col: 25 },
        { name: 'City3', row: 20, col: 30 },
        { name: 'City4', row: 25, col: 35 },
        { name: 'City5', row: 30, col: 40 },
        { name: 'City6', row: 35, col: 45 },
        { name: 'City7', row: 40, col: 50 },
      ];

      const result = await VictoryService.declareVictory(gameId, playerId1, claimedCities);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient money');
    });

    it('should reject victory with fewer than 7 unique cities', async () => {
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'City1', row: 10, col: 20 },
        { name: 'City2', row: 15, col: 25 },
        { name: 'City3', row: 20, col: 30 },
        { name: 'City4', row: 25, col: 35 },
        { name: 'City5', row: 30, col: 40 },
        { name: 'City6', row: 35, col: 45 },
        // Only 6 cities
      ];

      const result = await VictoryService.declareVictory(gameId, playerId1, claimedCities);

      expect(result.success).toBe(false);
      expect(result.error).toContain('6 unique cities claimed, need 7');
    });

    it('should reject victory when claimed city not in track', async () => {
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'City1', row: 10, col: 20 },
        { name: 'City2', row: 15, col: 25 },
        { name: 'City3', row: 20, col: 30 },
        { name: 'City4', row: 25, col: 35 },
        { name: 'City5', row: 30, col: 40 },
        { name: 'City6', row: 35, col: 45 },
        { name: 'City7', row: 99, col: 99 }, // Not in track
      ];

      const result = await VictoryService.declareVictory(gameId, playerId1, claimedCities);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found in track');
    });

    it('should accept valid victory declaration', async () => {
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'City1', row: 10, col: 20 },
        { name: 'City2', row: 15, col: 25 },
        { name: 'City3', row: 20, col: 30 },
        { name: 'City4', row: 25, col: 35 },
        { name: 'City5', row: 30, col: 40 },
        { name: 'City6', row: 35, col: 45 },
        { name: 'City7', row: 40, col: 50 },
      ];

      const result = await VictoryService.declareVictory(gameId, playerId1, claimedCities);

      expect(result.success).toBe(true);
      expect(result.victoryState).toBeDefined();
      expect(result.victoryState!.triggered).toBe(true);
      expect(result.victoryState!.triggerPlayerIndex).toBe(0); // Player1 is first
      expect(result.victoryState!.finalTurnPlayerIndex).toBe(2); // Player before trigger (3-1=2)
    });

    it('should reject second victory declaration', async () => {
      const claimedCities: MajorCityCoordinate[] = [
        { name: 'City1', row: 10, col: 20 },
        { name: 'City2', row: 15, col: 25 },
        { name: 'City3', row: 20, col: 30 },
        { name: 'City4', row: 25, col: 35 },
        { name: 'City5', row: 30, col: 40 },
        { name: 'City6', row: 35, col: 45 },
        { name: 'City7', row: 40, col: 50 },
      ];

      // First declaration succeeds
      await VictoryService.declareVictory(gameId, playerId1, claimedCities);

      // Second declaration should fail
      const result = await VictoryService.declareVictory(gameId, playerId1, claimedCities);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Victory already declared');
    });
  });

  describe('isFinalTurn', () => {
    it('should return false when victory not triggered', async () => {
      const result = await VictoryService.isFinalTurn(gameId);
      expect(result).toBe(false);
    });

    it('should return true when current player is final turn player', async () => {
      await runQuery(async (client) => {
        await client.query(
          `UPDATE games
           SET victory_triggered = true,
               victory_trigger_player_index = 0,
               final_turn_player_index = 2,
               current_player_index = 2
           WHERE id = $1`,
          [gameId]
        );
      });

      const result = await VictoryService.isFinalTurn(gameId);
      expect(result).toBe(true);
    });

    it('should return false when current player is not final turn player', async () => {
      await runQuery(async (client) => {
        await client.query(
          `UPDATE games
           SET victory_triggered = true,
               victory_trigger_player_index = 0,
               final_turn_player_index = 2,
               current_player_index = 1
           WHERE id = $1`,
          [gameId]
        );
      });

      const result = await VictoryService.isFinalTurn(gameId);
      expect(result).toBe(false);
    });
  });

  describe('resolveVictory', () => {
    it('should declare winner when one player has most money above threshold', async () => {
      // Player1 has 260M, others have less
      await runQuery(async (client) => {
        await client.query(
          `UPDATE games SET victory_threshold = 250 WHERE id = $1`,
          [gameId]
        );
      });

      const result = await VictoryService.resolveVictory(gameId);

      expect(result.gameOver).toBe(true);
      expect(result.winnerId).toBe(playerId1);
      expect(result.winnerName).toBe('Player1');
    });

    it('should extend threshold on tie at initial threshold', async () => {
      // Set two players with same money at threshold
      await runQuery(async (client) => {
        await client.query('UPDATE players SET money = 260 WHERE id = $1', [playerId2]);
        await client.query(
          `UPDATE games SET victory_threshold = 250 WHERE id = $1`,
          [gameId]
        );
      });

      const result = await VictoryService.resolveVictory(gameId);

      expect(result.gameOver).toBe(false);
      expect(result.tieExtended).toBe(true);
      expect(result.newThreshold).toBe(VICTORY_TIE_THRESHOLD);
    });

    it('should pick winner even on tie at max threshold', async () => {
      // Set two players with same money at max threshold
      await runQuery(async (client) => {
        await client.query('UPDATE players SET money = 300 WHERE id IN ($1, $2)', [playerId1, playerId2]);
        await client.query(
          `UPDATE games SET victory_threshold = $2 WHERE id = $1`,
          [gameId, VICTORY_TIE_THRESHOLD]
        );
      });

      const result = await VictoryService.resolveVictory(gameId);

      // Should pick a winner even on tie at max threshold
      expect(result.gameOver).toBe(true);
      expect(result.winnerId).toBeDefined();
    });

    it('should return gameOver=false when no player meets threshold', async () => {
      // Set all players below threshold
      await runQuery(async (client) => {
        await client.query('UPDATE players SET money = 100 WHERE game_id = $1', [gameId]);
        await client.query(
          `UPDATE games SET victory_threshold = 250 WHERE id = $1`,
          [gameId]
        );
      });

      const result = await VictoryService.resolveVictory(gameId);

      expect(result.gameOver).toBe(false);
      expect(result.tieExtended).toBeUndefined();
    });
  });
});
