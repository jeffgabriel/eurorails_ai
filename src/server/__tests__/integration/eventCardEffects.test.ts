/**
 * Integration tests for Flood event card effects on player_tracks.
 *
 * Uses a real PostgreSQL test database (TEST_DATABASE_URL or DATABASE_URL).
 * Seeds player_tracks rows, calls removeSegmentsCrossingRiver inside a real
 * transaction, and asserts correct DB state changes.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '../../db/index';
import { TrackService, getRiverEdgeKeys } from '../../services/trackService';
import { TerrainType, TrackSegment } from '../../../shared/types/GameTypes';
import { v4 as uuidv4 } from 'uuid';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeSegment(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  cost = 1
): TrackSegment {
  return {
    from: { row: fromRow, col: fromCol, x: 0, y: 0, terrain: TerrainType.Clear },
    to: { row: toRow, col: toCol, x: 0, y: 0, terrain: TerrainType.Clear },
    cost,
  };
}

/** Parse segments from a DB row, handling both string and object JSONB formats */
function parseSegments(rawSegments: unknown): TrackSegment[] {
  if (typeof rawSegments === 'string') return JSON.parse(rawSegments || '[]');
  return (rawSegments || []) as TrackSegment[];
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

describe('Flood event: removeSegmentsCrossingRiver (integration)', () => {
  let gameId: string;
  let userId1: string;
  let userId2: string;
  let playerId1: string;
  let playerId2: string;

  // A real Elbe river edge from rivers.json (first edge)
  // Start: {Col:52, Row:30}, End: {Row:53, Col:30}
  // key = "30,52|53,30" (canonical, "30,52" < "53,30")
  // segment from (30,52) to (53,30)
  const ELBE_CROSSING_SEG = makeSegment(30, 52, 53, 30, 3);
  const SAFE_SEG = makeSegment(10, 10, 10, 11, 2);

  beforeEach(async () => {
    gameId = uuidv4();
    userId1 = uuidv4();
    userId2 = uuidv4();
    playerId1 = uuidv4();
    playerId2 = uuidv4();

    // Create users
    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId1, `user1_${userId1.slice(0, 6)}`, `u1_${userId1.slice(0, 6)}@test.local`, 'hash']
    );
    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId2, `user2_${userId2.slice(0, 6)}`, `u2_${userId2.slice(0, 6)}@test.local`, 'hash']
    );

    // Create game
    await db.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [gameId, 'active', 0, 6]
    );

    // Create players (hand is INTEGER[], loads is TEXT[])
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId1, gameId, userId1, 'Player1', '#FF0000', 100, 'freight',
       null, null, null, null, 1, [], []]
    );
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId2, gameId, userId2, 'Player2', '#0000FF', 80, 'freight',
       null, null, null, null, 1, [], []]
    );
  });

  afterEach(async () => {
    await db.query('DELETE FROM player_tracks WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM players WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [userId1, userId2]);
  });

  it('removes crossing segments from both players and preserves non-crossing ones', async () => {
    // Player 1 has: 1 Elbe crossing seg + 1 safe seg → after flood: only safe seg remains
    // Player 2 has: 2 safe segs → after flood: unchanged (no DB update)
    const p1Segments = [ELBE_CROSSING_SEG, SAFE_SEG];
    const p2SafeSeg1 = makeSegment(20, 20, 20, 21, 1);
    const p2SafeSeg2 = makeSegment(20, 21, 20, 22, 1);
    const p2Segments = [p2SafeSeg1, p2SafeSeg2];

    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [gameId, playerId1, JSON.stringify(p1Segments), 5, 0]
    );
    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [gameId, playerId2, JSON.stringify(p2Segments), 2, 0]
    );

    // Run flood inside a real transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const results = await TrackService.removeSegmentsCrossingRiver(client, gameId, 'Elbe');
      await client.query('COMMIT');

      // Only player1 should appear in results
      expect(results).toHaveLength(1);
      expect(results[0].playerId).toBe(playerId1);
      expect(results[0].removedCount).toBe(1);
      expect(results[0].newTotalCost).toBe(SAFE_SEG.cost); // = 2
    } finally {
      client.release();
    }

    // Verify DB state for player 1
    const p1Row = await db.query(
      'SELECT segments, total_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId1]
    );
    expect(p1Row.rows).toHaveLength(1);
    const p1Segs = parseSegments(p1Row.rows[0].segments);
    expect(p1Segs).toHaveLength(1);
    expect(p1Segs[0].from.row).toBe(SAFE_SEG.from.row);
    expect(p1Segs[0].from.col).toBe(SAFE_SEG.from.col);
    expect(Number(p1Row.rows[0].total_cost)).toBe(SAFE_SEG.cost);

    // Verify DB state for player 2 — unchanged
    const p2Row = await db.query(
      'SELECT segments, total_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId2]
    );
    const p2Segs = parseSegments(p2Row.rows[0].segments);
    expect(p2Segs).toHaveLength(2);
    expect(Number(p2Row.rows[0].total_cost)).toBe(2);
  });

  it('returns empty array and makes no DB changes when no tracks cross the river', async () => {
    const safeSegs = [makeSegment(1, 1, 1, 2, 1), makeSegment(2, 2, 2, 3, 1)];
    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [gameId, playerId1, JSON.stringify(safeSegs), 2, 0]
    );

    const client = await db.connect();
    let results: Awaited<ReturnType<typeof TrackService.removeSegmentsCrossingRiver>>;
    try {
      await client.query('BEGIN');
      results = await TrackService.removeSegmentsCrossingRiver(client, gameId, 'Elbe');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(results).toHaveLength(0);

    // Verify DB unchanged
    const row = await db.query(
      'SELECT segments, total_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId1]
    );
    const segs = parseSegments(row.rows[0].segments);
    expect(segs).toHaveLength(2);
    expect(Number(row.rows[0].total_cost)).toBe(2);
  });

  it('handles player with all segments crossing the river (empty segments after flood)', async () => {
    // Get a second Elbe crossing edge
    const elbeKeys = getRiverEdgeKeys('Elbe')!;
    const [key1, key2] = Array.from(elbeKeys).slice(0, 2);
    const parseKey = (k: string) => {
      const [from, to] = k.split('|');
      const [fr, fc] = from.split(',').map(Number);
      const [tr, tc] = to.split(',').map(Number);
      return { fr, fc, tr, tc };
    };
    const k1 = parseKey(key1);
    const k2 = parseKey(key2);
    const seg1 = makeSegment(k1.fr, k1.fc, k1.tr, k1.tc, 3);
    const seg2 = makeSegment(k2.fr, k2.fc, k2.tr, k2.tc, 2);

    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [gameId, playerId1, JSON.stringify([seg1, seg2]), 5, 0]
    );

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const results = await TrackService.removeSegmentsCrossingRiver(client, gameId, 'Elbe');
      await client.query('COMMIT');

      expect(results).toHaveLength(1);
      expect(results[0].removedCount).toBe(2);
      expect(results[0].newTotalCost).toBe(0);
    } finally {
      client.release();
    }

    // Verify DB — empty segments, zero cost
    const row = await db.query(
      'SELECT segments, total_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId1]
    );
    const segs = parseSegments(row.rows[0].segments);
    expect(segs).toHaveLength(0);
    expect(Number(row.rows[0].total_cost)).toBe(0);
  });

  it('handles game with no player_tracks rows (returns empty array)', async () => {
    const client = await db.connect();
    let results: Awaited<ReturnType<typeof TrackService.removeSegmentsCrossingRiver>>;
    try {
      await client.query('BEGIN');
      results = await TrackService.removeSegmentsCrossingRiver(client, gameId, 'Elbe');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(results).toHaveLength(0);
  });

  it('throws and rolls back for an unknown river name', async () => {
    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [gameId, playerId1, JSON.stringify([ELBE_CROSSING_SEG]), 3, 0]
    );

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await expect(
        TrackService.removeSegmentsCrossingRiver(client, gameId, 'UnknownRiver')
      ).rejects.toThrow('Unknown river: UnknownRiver');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Verify DB unchanged
    const row = await db.query(
      'SELECT segments, total_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId1]
    );
    const segs = parseSegments(row.rows[0].segments);
    expect(segs).toHaveLength(1);
  });
});
