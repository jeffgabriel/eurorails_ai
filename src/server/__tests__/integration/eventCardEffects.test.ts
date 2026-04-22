/**
 * Integration tests for event card effects on player_tracks and players.
 *
 * Uses a real PostgreSQL test database (TEST_DATABASE_URL or DATABASE_URL).
 * Covers:
 *   - Flood event: seeds player_tracks rows, calls removeSegmentsCrossingRiver
 *     inside a real transaction, asserts correct JSONB manipulation and total_cost
 *     recomputation.
 *   - Derailment event: seeds players with loads and train positions inside the
 *     derailment zone, calls EventCardService.processEventCard, asserts loads column
 *     updated correctly.
 *   - Concurrency: two concurrent EventCardService.processEventCard calls on the
 *     same game serialize correctly via SELECT ... FOR UPDATE.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '../../db/index';
import { TrackService, getRiverEdgeKeys } from '../../services/trackService';
import { EventCardService } from '../../services/EventCardService';
import { TerrainType, TrackSegment } from '../../../shared/types/GameTypes';
import {
  EventCard,
  EventCardType,
} from '../../../shared/types/EventCard';
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
  // Elbe first edge: Start(30,52) → End transposed to (30,53)
  // canonical key = "30,52|30,53"
  // segment from (30,52) to (30,53)
  const ELBE_CROSSING_SEG = makeSegment(30, 52, 30, 53, 3);
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

// ── Derailment event integration tests ───────────────────────────────────────

/**
 * Derailment integration tests.
 *
 * Seeds players with:
 *   - One player positioned at Paris (row=29, col=32 — the Major City center),
 *     which is within radius 3 of Paris derailment zone.
 *   - One player positioned far from Paris (row=1, col=1), outside the zone.
 *
 * Calls EventCardService.processEventCard with a Derailment card targeting Paris.
 * Asserts that only the player in the zone loses their first load.
 */
describe('Derailment event: EventCardService.processEventCard (integration)', () => {
  let gameId: string;
  let userId1: string;
  let userId2: string;
  let playerId1: string;  // inside Paris zone
  let playerId2: string;  // outside zone

  // Paris Major City center: row=29, col=32
  const PARIS_ROW = 29;
  const PARIS_COL = 32;

  const DERAILMENT_CARD: EventCard = {
    id: 125,
    type: EventCardType.Derailment,
    title: 'Derailment!',
    description: 'Trains within 3 mileposts of Paris lose 1 turn and 1 load',
    effectConfig: {
      type: EventCardType.Derailment,
      cities: ['Paris'],
      radius: 3,
    },
  };

  beforeEach(async () => {
    gameId = uuidv4();
    userId1 = uuidv4();
    userId2 = uuidv4();
    playerId1 = uuidv4();
    playerId2 = uuidv4();

    // Create users
    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId1, `du1_${userId1.slice(0, 6)}`, `du1_${userId1.slice(0, 6)}@test.local`, 'hash']
    );
    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId2, `du2_${userId2.slice(0, 6)}`, `du2_${userId2.slice(0, 6)}@test.local`, 'hash']
    );

    // Create game
    await db.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [gameId, 'active', 0, 6]
    );

    // Player 1: inside Paris zone with 2 loads
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId1, gameId, userId1, 'Player1', '#FF0000', 100, 'freight',
       null, null, PARIS_ROW, PARIS_COL, 1, [], ['coal', 'steel']]
    );

    // Player 2: outside zone (row=1, col=1) with 1 load
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId2, gameId, userId2, 'Player2', '#0000FF', 80, 'freight',
       null, null, 1, 1, 1, [], ['wheat']]
    );
  });

  afterEach(async () => {
    await db.query('DELETE FROM player_tracks WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM players WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [userId1, userId2]);
  });

  it('removes first load from player in zone and leaves outside player unchanged', async () => {
    const result = await EventCardService.processEventCard(
      gameId,
      DERAILMENT_CARD,
      playerId1,
    );

    // Result should contain load_lost and turn_lost for playerId1
    const p1Effects = result.perPlayerEffects.filter(e => e.playerId === playerId1);
    expect(p1Effects.some(e => e.effectType === 'load_lost')).toBe(true);
    expect(p1Effects.some(e => e.effectType === 'turn_lost')).toBe(true);

    // Result should NOT contain effects for playerId2
    const p2Effects = result.perPlayerEffects.filter(e => e.playerId === playerId2);
    expect(p2Effects).toHaveLength(0);

    // DB: player 1 should have lost the first load ('coal')
    const p1Row = await db.query(
      'SELECT loads FROM players WHERE id = $1 AND game_id = $2',
      [playerId1, gameId]
    );
    const p1Loads = p1Row.rows[0].loads as string[];
    expect(p1Loads).toEqual(['steel']);
    expect(p1Loads).not.toContain('coal');

    // DB: player 2 loads unchanged
    const p2Row = await db.query(
      'SELECT loads FROM players WHERE id = $1 AND game_id = $2',
      [playerId2, gameId]
    );
    const p2Loads = p2Row.rows[0].loads as string[];
    expect(p2Loads).toEqual(['wheat']);
  });

  it('produces only turn_lost (no load_lost) for player in zone with no loads', async () => {
    // Update player 1 to have no loads
    await db.query(
      'UPDATE players SET loads = $1 WHERE id = $2 AND game_id = $3',
      [[], playerId1, gameId]
    );

    const result = await EventCardService.processEventCard(
      gameId,
      DERAILMENT_CARD,
      playerId1,
    );

    const p1Effects = result.perPlayerEffects.filter(e => e.playerId === playerId1);
    expect(p1Effects.some(e => e.effectType === 'turn_lost')).toBe(true);
    expect(p1Effects.some(e => e.effectType === 'load_lost')).toBe(false);

    // DB: loads still empty
    const row = await db.query(
      'SELECT loads FROM players WHERE id = $1 AND game_id = $2',
      [playerId1, gameId]
    );
    expect((row.rows[0].loads as string[])).toHaveLength(0);
  });
});

// ── Concurrency integration tests ────────────────────────────────────────────

/**
 * Concurrency integration tests.
 *
 * Verifies that two concurrent EventCardService.processEventCard calls on the
 * same game serialize correctly via SELECT ... FOR UPDATE, ensuring no lost
 * updates or duplicate load removals.
 *
 * Strategy: run two Derailment card draws concurrently (Promise.all) on the
 * same player who has 2 loads. Due to FOR UPDATE locking, the two transactions
 * must serialize. The first draw removes 'coal'; the second sees only 'steel'
 * and removes it. Final state: empty loads array.
 */
describe('Concurrency: concurrent event card draws serialize via SELECT FOR UPDATE', () => {
  let gameId: string;
  let userId1: string;
  let playerId1: string;

  // Paris Major City center: row=29, col=32
  const PARIS_ROW = 29;
  const PARIS_COL = 32;

  const DERAILMENT_CARD: EventCard = {
    id: 125,
    type: EventCardType.Derailment,
    title: 'Derailment!',
    description: 'Trains within 3 mileposts of Paris lose 1 turn and 1 load',
    effectConfig: {
      type: EventCardType.Derailment,
      cities: ['Paris'],
      radius: 3,
    },
  };

  beforeEach(async () => {
    gameId = uuidv4();
    userId1 = uuidv4();
    playerId1 = uuidv4();

    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId1, `cu1_${userId1.slice(0, 6)}`, `cu1_${userId1.slice(0, 6)}@test.local`, 'hash']
    );

    await db.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [gameId, 'active', 0, 6]
    );

    // Player inside Paris zone with 2 loads
    await db.query(
      `INSERT INTO players (
        id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId1, gameId, userId1, 'ConcPlayer', '#00FF00', 100, 'freight',
       null, null, PARIS_ROW, PARIS_COL, 1, [], ['coal', 'steel']]
    );
  });

  afterEach(async () => {
    await db.query('DELETE FROM player_tracks WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM players WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId1]);
  });

  it('two concurrent draws serialize: each removes exactly one load without duplication', async () => {
    // Fire two processEventCard calls concurrently
    const [result1, result2] = await Promise.all([
      EventCardService.processEventCard(gameId, DERAILMENT_CARD, playerId1),
      EventCardService.processEventCard(gameId, DERAILMENT_CARD, playerId1),
    ]);

    // Both should succeed (no error)
    expect(result1.cardType).toBe(EventCardType.Derailment);
    expect(result2.cardType).toBe(EventCardType.Derailment);

    // Final DB state: player should have exactly 0 loads (each draw removed 1 of 2)
    const row = await db.query(
      'SELECT loads FROM players WHERE id = $1 AND game_id = $2',
      [playerId1, gameId]
    );
    const finalLoads = row.rows[0].loads as string[];
    expect(finalLoads).toHaveLength(0);

    // Total load_lost effects across both results should be exactly 2
    const totalLoadLost =
      result1.perPlayerEffects.filter(e => e.effectType === 'load_lost').length +
      result2.perPlayerEffects.filter(e => e.effectType === 'load_lost').length;
    expect(totalLoadLost).toBe(2);
  });
});
