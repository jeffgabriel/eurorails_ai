import { db } from '../db/index';
import { PlayerTrackState } from '../../shared/types/GameTypes';
import { QueryResult } from 'pg';

export class TrackService {
    static async saveTrackState(gameId: string, playerId: string, trackState: PlayerTrackState): Promise<void> {
        const client = await db.connect();
        try {
            await client.query('BEGIN');

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
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error saving track state:', error);
            throw error;
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
        return {
            playerId: row.player_id,
            gameId: row.game_id,
            segments: JSON.parse(row.segments),
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

        return result.rows.map(row => ({
            playerId: row.player_id,
            gameId: row.game_id,
            segments: row.segments,
            totalCost: row.total_cost,
            turnBuildCost: row.turn_build_cost,
            lastBuildTimestamp: row.last_build_timestamp
        }));
    }
    
    static async clearTurnBuildCost(gameId: string, playerId: string): Promise<void> {
        await db.query(
            `UPDATE player_tracks 
             SET turn_build_cost = 0
             WHERE game_id = $1 AND player_id = $2`,
            [gameId, playerId]
        );
    }
} 