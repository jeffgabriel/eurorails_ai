import express from 'express';
import { GameService } from '../services/gameService';
import { authenticateToken } from '../middleware/authMiddleware';

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
        
        const gameState = await GameService.getGame(gameId, userId);
        
        if (!gameState) {
            return res.status(404).json({ 
                error: 'Not found',
                details: 'Game not found'
            });
        }

        return res.status(200).json(gameState);
    } catch (error: any) {
        console.error('Error in /:gameId route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Update camera state
router.post('/updateCameraState', async (req, res) => {
    try {
        const { gameId, cameraState } = req.body;

        if (!gameId || !cameraState) {
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID and camera state are required'
            });
        }

        await GameService.updateCameraState(gameId, cameraState);
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