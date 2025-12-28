import { db } from '../db';
import { GameState, CameraState, VictoryState, VICTORY_INITIAL_THRESHOLD } from '../../shared/types/GameTypes';
import { PlayerService } from './playerService';

export class GameService {
    /**
     * Update camera state for a specific player
     * @param gameId - The game ID
     * @param playerId - The player ID (must belong to the game)
     * @param cameraState - The camera state to save
     * @throws Error if player not found in game
     */
    static async updatePlayerCameraState(
        gameId: string, 
        playerId: string, 
        cameraState: CameraState
    ): Promise<void> {
        // Validate player belongs to game
        const playerCheck = await db.query(
            'SELECT id FROM players WHERE id = $1 AND game_id = $2',
            [playerId, gameId]
        );
        
        if (playerCheck.rows.length === 0) {
            throw new Error('Player not found in game');
        }
        
        await db.query(
            'UPDATE players SET camera_state = $1 WHERE id = $2',
            [JSON.stringify(cameraState), playerId]
        );
    }

    /**
     * @deprecated Use updatePlayerCameraState instead. This method is kept for backwards compatibility.
     */
    static async updateCameraState(gameId: string, cameraState: GameState['cameraState']): Promise<void> {
        await db.query(
            'UPDATE games SET camera_state = $1 WHERE id = $2',
            [JSON.stringify(cameraState), gameId]
        );
    }

    static async getGame(gameId: string, userId: string): Promise<GameState | null> {
        const result = await db.query(
            'SELECT * FROM games WHERE id = $1',
            [gameId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];

        // Fetch players from the players table, passing userId for hand filtering
        // userId is required for proper hand filtering
        // Camera state is now included in player objects
        const players = await PlayerService.getPlayers(gameId, userId);

        // Build victory state from database columns
        const victoryState: VictoryState = {
            triggered: row.victory_triggered ?? false,
            triggerPlayerIndex: row.victory_trigger_player_index ?? -1,
            victoryThreshold: row.victory_threshold ?? VICTORY_INITIAL_THRESHOLD,
            finalTurnPlayerIndex: row.final_turn_player_index ?? -1,
        };

        return {
            id: row.id,
            players: players,
            currentPlayerIndex: row.current_player_index,
            status: row.status,
            maxPlayers: row.max_players,
            // Camera state is deprecated - now stored per-player
            cameraState: row.camera_state ? row.camera_state : undefined,
            victoryState,
        };
    }
} 