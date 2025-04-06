import express from 'express';
import { GameService } from '../services/gameService';

const router = express.Router();

// Get game state
router.get('/:gameId', async (req, res) => {
    try {
        const { gameId } = req.params;
        const gameState = await GameService.getGame(gameId);
        
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