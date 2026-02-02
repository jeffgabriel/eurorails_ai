import { db } from '../db';
import { GameState, CameraState, VictoryState, VICTORY_INITIAL_THRESHOLD, Player } from '../../shared/types/GameTypes';
import { PlayerService } from './playerService';
import { getAIService } from './ai/aiService';
import { AI_TURN_TIMEOUT_MS } from './ai/aiConfig';
import { emitTurnChange } from './socketService';

export class GameService {
    /**
     * End the current player's turn and advance to the next player.
     * If the next player is an AI, automatically triggers AI turn execution.
     *
     * @param gameId - The game ID
     * @returns The new currentPlayerIndex and next player info
     */
    static async endTurn(gameId: string): Promise<{
        currentPlayerIndex: number;
        nextPlayerId: string;
        nextPlayerIsAI: boolean;
    }> {
        // Get all players in order
        const playersResult = await db.query(
            `SELECT id, name, is_ai as "isAI"
             FROM players
             WHERE game_id = $1
             ORDER BY created_at ASC`,
            [gameId]
        );

        if (playersResult.rows.length === 0) {
            throw new Error('No players found in game');
        }

        const players = playersResult.rows;
        const playerCount = players.length;

        // Get current player index
        const gameResult = await db.query(
            `SELECT current_player_index FROM games WHERE id = $1`,
            [gameId]
        );

        if (gameResult.rows.length === 0) {
            throw new Error('Game not found');
        }

        const currentIndex = gameResult.rows[0].current_player_index;
        const nextIndex = (currentIndex + 1) % playerCount;
        const nextPlayer = players[nextIndex];

        // Update the current player index in the database
        await db.query(
            `UPDATE games
             SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [nextIndex, gameId]
        );

        // Emit turn:change event to all clients in the game room
        emitTurnChange(gameId, nextIndex, nextPlayer.id);

        // If next player is an AI, trigger AI turn execution with timeout
        if (nextPlayer.isAI) {
            // Execute AI turn in the background with timeout
            this.executeAITurnWithTimeout(gameId, nextPlayer.id)
                .catch((error) => {
                    console.error(`AI turn execution failed for player ${nextPlayer.id}:`, error);
                });
        }

        return {
            currentPlayerIndex: nextIndex,
            nextPlayerId: nextPlayer.id,
            nextPlayerIsAI: nextPlayer.isAI || false,
        };
    }

    /**
     * Execute an AI turn with a 30-second timeout.
     * If the AI turn exceeds the timeout, forces the turn to end.
     * After AI turn completes (or times out), recursively advances to the next player.
     *
     * @param gameId - The game ID
     * @param aiPlayerId - The AI player's ID
     */
    private static async executeAITurnWithTimeout(
        gameId: string,
        aiPlayerId: string
    ): Promise<void> {
        const aiService = getAIService();

        // Create a timeout promise
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
            setTimeout(() => {
                resolve({ timedOut: true });
            }, AI_TURN_TIMEOUT_MS);
        });

        // Create the AI turn execution promise
        const aiTurnPromise = aiService.executeAITurn(gameId, aiPlayerId)
            .then((result) => ({ timedOut: false, result }));

        // Race between AI turn and timeout
        const outcome = await Promise.race([aiTurnPromise, timeoutPromise]);

        if ('timedOut' in outcome && outcome.timedOut) {
            console.warn(`AI turn timed out for player ${aiPlayerId} after ${AI_TURN_TIMEOUT_MS}ms`);
            // Note: The AI turn may still be running in the background,
            // but we proceed to end the turn to prevent game stalls
        }

        // Advance to the next player by calling endTurn recursively
        // This handles consecutive AI players
        try {
            await this.endTurn(gameId);
        } catch (error) {
            console.error(`Failed to advance turn after AI player ${aiPlayerId}:`, error);
        }
    }
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