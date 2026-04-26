import { db } from '../db/index';
import { PlayerTrackState, TrackSegment } from '../../shared/types/GameTypes';
import { PoolClient } from 'pg';
import riversData from '../../../configuration/rivers.json';

/**
 * Shape of an entry in configuration/rivers.json
 */
interface RiverEdgeData {
  Start: { Row: number; Col: number };
  End: { Row: number; Col: number };
}

interface RiverData {
  Name: string;
  Edges: RiverEdgeData[];
}

/**
 * Build a canonical edge key "r1,c1|r2,c2" with the numerically smaller
 * coordinate first (by row, then col). Using numeric comparison avoids
 * lexicographic issues (e.g. "10,0" < "2,0" in string comparison).
 */
function canonicalEdgeKey(r1: number, c1: number, r2: number, c2: number): string {
  const aFirst = r1 < r2 || (r1 === r2 && c1 <= c2);
  return aFirst ? `${r1},${c1}|${r2},${c2}` : `${r2},${c2}|${r1},${c1}`;
}

/**
 * Build a set of canonical edge keys for all edges belonging to the named river.
 * Returns null if the river is not found.
 *
 * Note: rivers.json stores End coordinates with Row/Col transposed relative to
 * the hex grid coordinate system. We swap them here to get correct adjacency.
 */
export function getRiverEdgeKeys(riverName: string): Set<string> | null {
  const rivers = riversData as RiverData[];
  const river = rivers.find(r => r.Name === riverName);
  if (!river) return null;

  const keys = new Set<string>();
  for (const edge of river.Edges) {
    // End coords are transposed in rivers.json — swap Row/Col
    const endRow = edge.End.Col;
    const endCol = edge.End.Row;
    keys.add(canonicalEdgeKey(edge.Start.Row, edge.Start.Col, endRow, endCol));
  }
  return keys;
}

/**
 * Return true if the given track segment crosses the named river.
 * A segment crosses a river when its from→to edge matches one of the
 * river's canonical edges (order-independent).
 */
export function segmentCrossesRiver(segment: TrackSegment, riverEdgeKeys: Set<string>): boolean {
  const key = canonicalEdgeKey(segment.from.row, segment.from.col, segment.to.row, segment.to.col);
  return riverEdgeKeys.has(key);
}

export class TrackService {
    static async saveTrackState(gameId: string, playerId: string, trackState: PlayerTrackState): Promise<void> {
        const client = await db.connect();
        try {
            await client.query('BEGIN');

            // First verify the player exists
            const playerExists = await client.query(
                'SELECT id FROM players WHERE game_id = $1 AND id = $2',
                [gameId, playerId]
            );

            if (playerExists.rows.length === 0) {
                throw new Error('Player does not exist in the database');
            }

            // Check if track state exists
            const existingResult = await client.query(
                'SELECT id FROM player_tracks WHERE game_id = $1 AND player_id = $2',
                [gameId, playerId]
            );

            if (existingResult.rows.length > 0) {
                // Update existing track state
                await client.query(
                    `UPDATE player_tracks
                     SET segments = $1, total_cost = $2, turn_build_cost = $3, last_build_timestamp = $4
                     WHERE game_id = $5 AND player_id = $6`,
                    [
                        JSON.stringify(trackState.segments),
                        trackState.totalCost,
                        trackState.turnBuildCost,
                        trackState.lastBuildTimestamp,
                        gameId,
                        playerId
                    ]
                );
            } else {
                // Insert new track state
                await client.query(
                    `INSERT INTO player_tracks
                     (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        gameId,
                        playerId,
                        JSON.stringify(trackState.segments),
                        trackState.totalCost,
                        trackState.turnBuildCost,
                        trackState.lastBuildTimestamp
                    ]
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async getTrackState(gameId: string, playerId: string): Promise<PlayerTrackState | null> {
        const result = await db.query(
            'SELECT * FROM player_tracks WHERE game_id = $1 AND player_id = $2',
            [gameId, playerId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];
        // segments is stored as JSONB in newer schemas; pg may return it as an object/array.
        // Older rows or test setups may return it as a string. Normalize safely.
        const segments =
            typeof row.segments === 'string'
                ? JSON.parse(row.segments || '[]')
                : (row.segments || []);
        return {
            playerId: row.player_id,
            gameId: row.game_id,
            segments,
            totalCost: row.total_cost,
            turnBuildCost: row.turn_build_cost,
            lastBuildTimestamp: row.last_build_timestamp
        };
    }

    static async getAllTracks(gameId: string): Promise<PlayerTrackState[]> {
        const result = await db.query(
            'SELECT * FROM player_tracks WHERE game_id = $1',
            [gameId]
        );

        return result.rows.map(row => {
            const segments =
                typeof row.segments === 'string'
                    ? JSON.parse(row.segments || '[]')
                    : (row.segments || []);
            return {
                playerId: row.player_id,
                gameId: row.game_id,
                segments,
                totalCost: row.total_cost,
                turnBuildCost: row.turn_build_cost,
                lastBuildTimestamp: row.last_build_timestamp
            };
        });
    }

    static async clearTurnBuildCost(gameId: string, playerId: string): Promise<void> {
        await db.query(
            `UPDATE player_tracks
             SET turn_build_cost = 0
             WHERE game_id = $1 AND player_id = $2`,
            [gameId, playerId]
        );
    }

    /**
     * Reset a player's track state to an empty baseline.
     * If a transaction client is provided, it will be used for consistency.
     */
    static async resetTrackState(
        gameId: string,
        playerId: string,
        client?: { query: (text: string, params?: any[]) => Promise<any> }
    ): Promise<void> {
        const q = client && typeof client.query === 'function' ? client : db;
        const emptySegmentsJson = JSON.stringify([]);
        await q.query(
            `
            INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
            VALUES ($1, $2, $3, 0, 0, NULL)
            ON CONFLICT (game_id, player_id)
            DO UPDATE SET segments = EXCLUDED.segments,
                          total_cost = 0,
                          turn_build_cost = 0,
                          last_build_timestamp = NULL
            `,
            [gameId, playerId, emptySegmentsJson]
        );
    }

    /**
     * Remove all track segments crossing the named river from every player's
     * `player_tracks` row in the game. Operates within a provided transaction
     * client using `SELECT ... FOR UPDATE` to prevent concurrent modification.
     *
     * For each player whose row exists:
     * - Locks the row with SELECT FOR UPDATE
     * - Filters out segments whose from→to edge matches a river edge
     * - Recomputes total_cost as the sum of remaining segments' costs
     * - Updates the row if any segments were removed
     *
     * Players with no segments crossing the river are not modified.
     *
     * @param client  A pg PoolClient in an active transaction (BEGIN already called)
     * @param gameId  The game to operate on
     * @param riverName  River name matching an entry in configuration/rivers.json
     * @returns Per-player removal summary (only players who had segments removed)
     */
    static async removeSegmentsCrossingRiver(
        client: PoolClient,
        gameId: string,
        riverName: string
    ): Promise<Array<{ playerId: string; removedCount: number; newTotalCost: number }>> {
        // Resolve river edge keys; throw if unknown
        const riverEdgeKeys = getRiverEdgeKeys(riverName);
        if (!riverEdgeKeys) {
            throw new Error(`Unknown river: ${riverName}`);
        }

        // Lock all player_tracks rows for this game to prevent concurrent modification
        const lockedRows = await client.query(
            `SELECT player_id, segments, total_cost
             FROM player_tracks
             WHERE game_id = $1
             FOR UPDATE`,
            [gameId]
        );

        const results: Array<{ playerId: string; removedCount: number; newTotalCost: number }> = [];

        for (const row of lockedRows.rows) {
            const playerId: string = row.player_id;
            const rawSegments = typeof row.segments === 'string'
                ? JSON.parse(row.segments || '[]')
                : (row.segments || []) as TrackSegment[];

            const segments = rawSegments as TrackSegment[];
            const remaining = segments.filter(seg => !segmentCrossesRiver(seg, riverEdgeKeys));
            const removedCount = segments.length - remaining.length;

            if (removedCount === 0) {
                // No segments to remove — skip update
                continue;
            }

            const newTotalCost = remaining.reduce((sum, seg) => sum + seg.cost, 0);

            await client.query(
                `UPDATE player_tracks
                 SET segments = $1, total_cost = $2
                 WHERE game_id = $3 AND player_id = $4`,
                [JSON.stringify(remaining), newTotalCost, gameId, playerId]
            );

            results.push({ playerId, removedCount, newTotalCost });
        }

        return results;
    }
}
