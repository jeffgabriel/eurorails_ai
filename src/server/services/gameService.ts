import { db } from '../db';
import { GameState } from '../../shared/types/GameTypes';
import { PlayerService } from './playerService';

export class GameService {
    static async updateCameraState(gameId: string, cameraState: GameState['cameraState']): Promise<void> {
        await db.query(
            'UPDATE games SET camera_state = $1 WHERE id = $2',
            [JSON.stringify(cameraState), gameId]
        );
    }

    static async getGame(gameId: string): Promise<GameState | null> {
        const result = await db.query(
            'SELECT * FROM games WHERE id = $1',
            [gameId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];

        // Fetch players from the players table
        const players = await PlayerService.getPlayers(gameId);

        return {
            id: row.id,
            players: players,
            currentPlayerIndex: row.current_player_index,
            status: row.status,
            maxPlayers: row.max_players,
            cameraState: row.camera_state ? row.camera_state : undefined
        };
    }
} 