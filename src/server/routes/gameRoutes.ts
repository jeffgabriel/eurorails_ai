import express from 'express';
import { GameService } from '../services/gameService';
import { authenticateToken } from '../middleware/authMiddleware';
import { db } from '../db';

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

export default router; 