import express from 'express';
import { PlayerService } from '../db/playerService';
import { Player } from '../../shared/types/GameTypes';

const router = express.Router();

// Default game ID for development
const DEFAULT_GAME_ID = 'default-game';

// Debug endpoint to verify route registration
router.get('/test', (req, res) => {
    res.json({ message: 'Player routes are working' });
});

// Update player
router.post('/update', async (req, res) => {
    console.log('Received player update request at /api/players/update');
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);

    try {
        const { gameId = DEFAULT_GAME_ID, player } = req.body;

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID is required'
            });
        }

        if (!player) {
            console.error('Invalid request - missing player:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Player data is required'
            });
        }

        if (!player.id) {
            console.error('Invalid request - missing player.id:', player);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Player ID is required'
            });
        }

        if (!player.name) {
            console.error('Invalid request - missing player.name:', player);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Player name is required'
            });
        }

        if (!player.color) {
            console.error('Invalid request - missing player.color:', player);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Player color is required'
            });
        }

        console.log('Updating player in database:', { gameId, player });
        await PlayerService.updatePlayer(gameId, player);
        console.log('Successfully updated player');

        return res.status(200).json({ message: 'Player updated successfully' });
    } catch (error: any) {
        console.error('Error in /update route:', error);
        
        // Handle specific error cases
        if (error.message.includes('Color already taken')) {
            return res.status(409).json({ 
                error: 'Color conflict',
                details: error.message
            });
        }
        if (error.message.includes('Invalid color format')) {
            return res.status(400).json({ 
                error: 'Validation error',
                details: error.message
            });
        }
        if (error.message === 'Player not found') {
            return res.status(404).json({ 
                error: 'Not found',
                details: error.message
            });
        }
        
        // Generic error case
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Delete player
router.post('/delete', async (req, res) => {
    console.log('Received player delete request at /api/players/delete');
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);

    try {
        const { gameId, playerId } = req.body;

        // Validate request
        if (!gameId || !playerId) {
            console.error('Invalid request - missing gameId or playerId:', req.body);
            return res.status(400).json({ error: 'Missing required fields' });
        }

        console.log('Deleting player from database:', { gameId, playerId });
        await PlayerService.deletePlayer(gameId, playerId);
        console.log('Successfully deleted player');

        return res.status(200).json({ message: 'Player deleted successfully' });
    } catch (error) {
        console.error('Error in /delete route:', error);
        return res.status(500).json({ error: 'Failed to delete player' });
    }
});

// Get players for a game
router.get('/:gameId', async (req, res) => {
    console.log('Received get players request at /api/players/:gameId');
    console.log('Request params:', req.params);
    console.log('Request headers:', req.headers);

    try {
        const gameId = req.params.gameId || DEFAULT_GAME_ID;

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.params);
            return res.status(400).json({ error: 'Game ID is required' });
        }

        console.log('Fetching players from database for game:', gameId);
        const players = await PlayerService.getPlayers(gameId);
        console.log('Successfully retrieved players:', players);

        return res.status(200).json(players);
    } catch (error) {
        console.error('Error in GET /:gameId route:', error);
        return res.status(500).json({ error: 'Failed to get players' });
    }
});

// Log that routes are being registered
console.log('Player routes registered:');
router.stack.forEach((r: any) => {
    if (r.route && r.route.path) {
        console.log(`${Object.keys(r.route.methods)} ${r.route.path}`);
    }
});

export default router; 