import express from 'express';
import { TrackService } from '../services/trackService';
import { getSocketIO } from '../services/socketService';

const router = express.Router();

// Debug endpoint to verify route registration
router.get('/test', (req, res) => {
    res.json({ message: 'Track routes are working' });
});

// Save track state
router.post('/save', async (req, res) => {
    console.debug('Received track save request at /api/tracks/save');
    console.debug('Request body:', req.body);

    try {
        const { gameId, playerId, trackState } = req.body;

        // Validate request
        if (!gameId || !playerId || !trackState) {
            console.error('Invalid request - missing required fields:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID, Player ID, and track state are required'
            });
        }

        await TrackService.saveTrackState(gameId, playerId, trackState);
        console.log('Successfully saved track state for player:', playerId);

        // Emit track update event to all clients in the game room
        const io = getSocketIO();
        if (io) {
            io.to(gameId).emit('track:updated', {
                gameId,
                playerId,
                timestamp: Date.now()
            });
            console.log(`Emitted track:updated event for game ${gameId}, player ${playerId}`);
        }

        return res.status(200).json({ message: 'Track state saved successfully' });
    } catch (error: any) {
        console.error('Error in /save route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Get track state for a player
router.get('/:gameId/:playerId', async (req, res) => {
    console.debug('Received get track state request');
    console.debug('Request params:', req.params);

    try {
        const { gameId, playerId } = req.params;

        // Validate request
        if (!gameId || !playerId) {
            console.error('Invalid request - missing required params:', req.params);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID and Player ID are required'
            });
        }

        const trackState = await TrackService.getTrackState(gameId, playerId);
        return res.status(200).json(trackState);
    } catch (error: any) {
        console.error('Error in GET /:gameId/:playerId route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Get all tracks for a game
router.get('/:gameId', async (req, res) => {
    console.debug('Received get all tracks request');
    console.debug('Request params:', req.params);

    try {
        const { gameId } = req.params;

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.params);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID is required'
            });
        }

        const tracks = await TrackService.getAllTracks(gameId);
        return res.status(200).json(tracks);
    } catch (error: any) {
        console.error('Error in GET /:gameId route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

console.log('Track routes registered:');
router.stack.forEach((r: any) => {
    if (r.route && r.route.path) {
        console.log(`${Object.keys(r.route.methods)} ${r.route.path}`);
    }
});

export default router; 