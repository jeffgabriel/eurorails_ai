import express from 'express';
import { GameService } from '../services/gameService';
import { VictoryService, MajorCityCoordinate } from '../services/victoryService';
import { authenticateToken } from '../middleware/authMiddleware';
import { db } from '../db';
import { emitVictoryTriggered, emitGameOver, emitTieExtended } from '../services/socketService';

const router = express.Router();

// Get game state
router.get('/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const userId = req.user?.id;
        
        if (!userId) {
            return res.status(401).json({ 
                error: 'UNAUTHORIZED',
                details: 'Authentication required to view game state' 
            });
        }

        // Validate game exists and is available (do not depend on lobby flow for this)
        const gameResult = await db.query(
            'SELECT status FROM games WHERE id = $1',
            [gameId]
        );

        if (gameResult.rows.length === 0) {
            return res.status(404).json({
                error: 'GAME_NOT_FOUND',
                details: 'Game not found'
            });
        }

        const gameStatus: string = gameResult.rows[0].status;
        if (gameStatus === 'completed' || gameStatus === 'abandoned') {
            return res.status(410).json({
                error: 'GAME_NOT_AVAILABLE',
                details: `Game is ${gameStatus} and cannot be loaded`
            });
        }

        // Validate membership (and not soft-deleted) before returning any state
        const membershipResult = await db.query(
            'SELECT is_deleted FROM players WHERE game_id = $1 AND user_id = $2 LIMIT 1',
            [gameId, userId]
        );

        if (membershipResult.rows.length === 0) {
            return res.status(403).json({
                error: 'FORBIDDEN',
                details: 'You are not a player in this game'
            });
        }

        if (membershipResult.rows[0].is_deleted === true) {
            return res.status(403).json({
                error: 'FORBIDDEN',
                details: 'You no longer have access to this game'
            });
        }
        
        const gameState = await GameService.getGame(gameId, userId);

        return res.status(200).json(gameState);
    } catch (error: any) {
        console.error('Error in /:gameId route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// End the current player's turn and advance to the next player
// If the next player is an AI, this triggers automatic AI turn execution
router.post('/:gameId/end-turn', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required to end turn'
            });
        }

        // Use PlayerService.endTurnForUser which handles everything in a transaction
        const { PlayerService } = await import('../services/playerService');
        const result = await PlayerService.endTurnForUser(gameId, userId);

        return res.status(200).json({
            success: true,
            currentPlayerIndex: result.currentPlayerIndex,
            nextPlayerId: result.nextPlayerId,
            nextPlayerIsAI: result.nextPlayerIsAI
        });
    } catch (error: any) {
        console.error('Error in /:gameId/end-turn route:', error);

        // Handle specific errors
        if (error.message === 'Not your turn') {
            return res.status(403).json({
                error: 'NOT_YOUR_TURN',
                details: error.message
            });
        }
        if (error.message === 'Player not found in game') {
            return res.status(404).json({
                error: 'PLAYER_NOT_FOUND',
                details: error.message
            });
        }
        if (error.message === 'Game not found') {
            return res.status(404).json({
                error: 'GAME_NOT_FOUND',
                details: error.message
            });
        }

        return res.status(500).json({
            error: 'SERVER_ERROR',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Update camera state (per-player)
router.post('/updateCameraState', authenticateToken, async (req, res) => {
    try {
        const { gameId, playerId, cameraState } = req.body;
        const userId = req.user?.id;
        
        if (!userId) {
            return res.status(401).json({ 
                error: 'UNAUTHORIZED',
                details: 'Authentication required to update camera state' 
            });
        }

        if (!gameId || !playerId || !cameraState) {
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID, player ID, and camera state are required'
            });
        }

        // Validate that player belongs to authenticated user
        const playerCheck = await db.query(
            'SELECT id, user_id FROM players WHERE id = $1 AND game_id = $2',
            [playerId, gameId]
        );
        
        if (playerCheck.rows.length === 0) {
            return res.status(404).json({
                error: 'Not found',
                details: 'Player not found in game'
            });
        }
        
        const player = playerCheck.rows[0];
        if (player.user_id !== userId) {
            return res.status(403).json({
                error: 'Forbidden',
                details: 'Player does not belong to authenticated user'
            });
        }

        await GameService.updatePlayerCameraState(gameId, playerId, cameraState);
        return res.status(200).json({ message: 'Camera state updated successfully' });
    } catch (error: any) {
        console.error('Error in /updateCameraState route:', error);
        return res.status(500).json({
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Declare victory - called when a player believes they've met win conditions
router.post('/:gameId/declare-victory', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId, connectedCities } = req.body as {
            playerId: string;
            connectedCities: MajorCityCoordinate[];
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!playerId || !connectedCities || !Array.isArray(connectedCities)) {
            return res.status(400).json({
                error: 'VALIDATION_ERROR',
                details: 'Player ID and connected cities array are required'
            });
        }

        // Validate player belongs to user
        const playerCheck = await db.query(
            'SELECT id, name, user_id FROM players WHERE id = $1 AND game_id = $2',
            [playerId, gameId]
        );

        if (playerCheck.rows.length === 0) {
            return res.status(404).json({
                error: 'NOT_FOUND',
                details: 'Player not found in game'
            });
        }

        if (playerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({
                error: 'FORBIDDEN',
                details: 'Cannot declare victory for another player'
            });
        }

        const playerName = playerCheck.rows[0].name;

        // Attempt to declare victory
        const result = await VictoryService.declareVictory(gameId, playerId, connectedCities);

        if (!result.success) {
            return res.status(400).json({
                error: 'VICTORY_INVALID',
                details: result.error
            });
        }

        // Emit victory triggered event to all players
        if (result.victoryState) {
            emitVictoryTriggered(
                gameId,
                result.victoryState.triggerPlayerIndex,
                playerName,
                result.victoryState.finalTurnPlayerIndex,
                result.victoryState.victoryThreshold
            );
        }

        return res.status(200).json({
            success: true,
            victoryState: result.victoryState
        });
    } catch (error: any) {
        console.error('Error in /:gameId/declare-victory route:', error);
        return res.status(500).json({
            error: 'SERVER_ERROR',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Resolve victory - called after final turn to determine winner
router.post('/:gameId/resolve-victory', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        // Check if this is actually the final turn
        const isFinal = await VictoryService.isFinalTurn(gameId);
        if (!isFinal) {
            return res.status(400).json({
                error: 'NOT_FINAL_TURN',
                details: 'Victory can only be resolved after the final turn'
            });
        }

        const result = await VictoryService.resolveVictory(gameId);

        if (result.gameOver && result.winnerId && result.winnerName) {
            emitGameOver(gameId, result.winnerId, result.winnerName);
        } else if (result.tieExtended && result.newThreshold) {
            emitTieExtended(gameId, result.newThreshold);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        console.error('Error in /:gameId/resolve-victory route:', error);
        return res.status(500).json({
            error: 'SERVER_ERROR',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Get victory state for a game
router.get('/:gameId/victory-state', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        const victoryState = await VictoryService.getVictoryState(gameId);

        return res.status(200).json({
            victoryState: victoryState || {
                triggered: false,
                triggerPlayerIndex: -1,
                victoryThreshold: 250,
                finalTurnPlayerIndex: -1
            }
        });
    } catch (error: any) {
        console.error('Error in /:gameId/victory-state route:', error);
        return res.status(500).json({
            error: 'SERVER_ERROR',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

export default router; 