import { db } from '../db';
import { TrackService } from '../services/trackService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';
import { TrainType } from '../../shared/types/GameTypes';

describe('TrackService.resetTrackState', () => {
  let gameId: string;
  let userId: string;
  let playerId: string;

  beforeEach(async () => {
    gameId = uuidv4();
    userId = uuidv4();
    playerId = uuidv4();

    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
    );
    await db.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [gameId, 'setup', 0, 6]
    );
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        playerId,
        gameId,
        userId,
        'Tester',
        '#123456',
        50,
        TrainType.Freight,
        null,
        null,
        null,
        null,
        1,
        [],
        [],
      ]
    );
  });

  afterEach(async () => {
    // Delete in dependency order
    await db.query('DELETE FROM movement_history');
    await db.query('DELETE FROM turn_actions');
    await db.query('DELETE FROM player_tracks');
    await db.query('DELETE FROM players');
    await db.query('DELETE FROM games');
    await db.query('DELETE FROM users');
  });

  it('should upsert an empty track row when none exists', async () => {
    const before = await db.query(
      'SELECT * FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId]
    );
    expect(before.rows.length).toBe(0);

    await TrackService.resetTrackState(gameId, playerId);

    const after = await db.query(
      'SELECT segments, total_cost, turn_build_cost, last_build_timestamp FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId]
    );
    expect(after.rows.length).toBe(1);

    const segments =
      typeof after.rows[0].segments === 'string'
        ? JSON.parse(after.rows[0].segments || '[]')
        : (after.rows[0].segments || []);
    expect(segments).toEqual([]);
    expect(Number(after.rows[0].total_cost)).toBe(0);
    expect(Number(after.rows[0].turn_build_cost)).toBe(0);
    expect(after.rows[0].last_build_timestamp).toBeNull();
  });

  it('should clear an existing track row (segments, costs, timestamp)', async () => {
    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [gameId, playerId, JSON.stringify([{ from: { row: 0, col: 0 }, to: { row: 0, col: 1 } }]), 12, 7]
    );

    const before = await db.query(
      'SELECT segments, total_cost, turn_build_cost, last_build_timestamp FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId]
    );
    expect(before.rows.length).toBe(1);
    expect(Number(before.rows[0].total_cost)).toBe(12);
    expect(Number(before.rows[0].turn_build_cost)).toBe(7);
    expect(before.rows[0].last_build_timestamp).not.toBeNull();

    await TrackService.resetTrackState(gameId, playerId);

    const after = await db.query(
      'SELECT segments, total_cost, turn_build_cost, last_build_timestamp FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId]
    );
    expect(after.rows.length).toBe(1);

    const segments =
      typeof after.rows[0].segments === 'string'
        ? JSON.parse(after.rows[0].segments || '[]')
        : (after.rows[0].segments || []);
    expect(segments).toEqual([]);
    expect(Number(after.rows[0].total_cost)).toBe(0);
    expect(Number(after.rows[0].turn_build_cost)).toBe(0);
    expect(after.rows[0].last_build_timestamp).toBeNull();
  });
});


