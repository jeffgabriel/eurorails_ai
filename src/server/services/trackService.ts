import { db } from '../db/index';
import { PlayerTrackState } from '../../shared/types/GameTypes';
import { QueryResult } from 'pg';

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
} 