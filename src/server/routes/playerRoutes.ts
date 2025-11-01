import express from 'express';
import { PlayerService } from '../services/playerService';
import { v4 as uuidv4 } from 'uuid';
import { GameStatus } from '../types';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';

const router = express.Router();

// Debug endpoint to verify route registration
router.get('/test', (req, res) => {
    res.json({ message: 'Player routes are working' });
});

// Create game
router.post('/game/create', async (req, res) => {
    console.debug('Received game create request at /api/players/game/create');
    console.debug('Request body:', req.body);
    console.debug('Request headers:', req.headers);

    try {
        const { gameId } = req.body;

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID is required'
            });
        }

        await PlayerService.createGame(gameId);
        console.log('Successfully created game:', gameId);

        // Set the game ID in the session
        req.session.gameId = gameId;
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        return res.status(200).json({ message: 'Game created successfully', gameId });
    } catch (error: any) {
        console.error('Error in /game/create route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Create player
router.post('/create', async (req, res) => {
    console.debug('Received player create request at /api/players/create');
    console.debug('Request body:', req.body);
    console.debug('Request headers:', req.headers);

    try {
        const { gameId, player } = req.body;

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

        // Generate a new UUID for the player
        const newPlayer = {
            ...player,
            id: uuidv4(),
            money: player.money || 50,
            trainType: player.trainType || 'Freight',
            turnNumber: player.turnNumber || 1,
            // Initialize trainState with position explicitly set to null
            trainState: {
                position: null,  // Now properly typed as Point | null
                remainingMovement: 0,
                movementHistory: []
            }
        };

        console.log('Creating new player in database:', { gameId, player: newPlayer });
        await PlayerService.createPlayer(gameId, newPlayer);
        console.log('Successfully created player');

        return res.status(200).json(newPlayer);
    } catch (error: any) {
        console.error('Error in /create route:', error);
        
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
        
        // Generic error case
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Update player
router.post('/update', async (req, res) => {
    console.debug('Received player update request at /api/players/update');
    console.debug('Request body:', req.body);
    console.debug('Request headers:', req.headers);

    try {
        const { gameId, player } = req.body;

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
// Require authentication to enforce per-player hand visibility
router.get('/:gameId', authenticateToken, async (req, res) => {
    console.log('Received get players request at /api/players/:gameId');
    console.log('Request params:', req.params);
    console.log('Request headers:', req.headers);

    try {
        const gameId = req.params.gameId;
        const userId = req.user?.id; // Authentication required, so userId should always be present

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.params);
            return res.status(400).json({ error: 'Game ID is required' });
        }

        if (!userId) {
            console.error('Invalid request - missing userId from authentication');
            return res.status(401).json({ 
                error: 'UNAUTHORIZED',
                details: 'Authentication required to view player data' 
            });
        }

        console.log('Fetching players from database for game:', gameId);
        const players = await PlayerService.getPlayers(gameId, userId);
        console.log('Successfully retrieved players:', players.length, 'players');

        return res.status(200).json(players);
    } catch (error) {
        console.error('Error in GET /:gameId route:', error);
        return res.status(500).json({ error: 'Failed to get players' });
    }
});

// Update current player
router.post('/updateCurrentPlayer', async (req, res) => {
    console.debug('Received current player update request at /api/players/updateCurrentPlayer');
    console.debug('Request body:', req.body);
    console.debug('Request headers:', req.headers);

    try {
        const { gameId, currentPlayerIndex } = req.body;

        // Validate request
        if (!gameId) {
            console.error('Invalid request - missing gameId:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID is required'
            });
        }

        if (typeof currentPlayerIndex !== 'number') {
            console.error('Invalid request - missing or invalid currentPlayerIndex:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Current player index must be a number'
            });
        }

        // Update the current player index
        await PlayerService.updateCurrentPlayerIndex(gameId, currentPlayerIndex);

        // Get the updated game state
        const gameState = await PlayerService.getGameState(gameId);
        
        return res.status(200).json(gameState);
    } catch (error: any) {
        console.error('Error in /updateCurrentPlayer route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Get active game
router.get('/game/active', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        
        if (!userId) {
            return res.status(401).json({ 
                error: 'UNAUTHORIZED',
                details: 'Authentication required to view active game' 
            });
        }
        
        const activeGame = await PlayerService.getActiveGame();
        if (!activeGame) {
            return res.status(404).json({ 
                error: 'Not found',
                details: 'No active game found'
            });
        }

        // Get all players for this game (with hand filtering for authenticated user)
        const players = await PlayerService.getPlayers(activeGame.id, userId);
        
        // Set the game ID in the session
        req.session.gameId = activeGame.id;
        await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        return res.status(200).json({
            ...activeGame,
            players
        });
    } catch (error: any) {
        console.error('Error in /game/active route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// End game
router.post('/game/:gameId/end', async (req, res) => {
    try {
        const { gameId } = req.params;
        await PlayerService.updateGameStatus(gameId, 'completed');
        return res.status(200).json({ message: 'Game ended successfully' });
    } catch (error: any) {
        console.error('Error ending game:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Update game status
router.post('/game/:gameId/status', async (req, res) => {
    try {
        const { gameId } = req.params;
        const { status } = req.body;

        if (!status || !['setup', 'active', 'completed', 'abandoned'].includes(status)) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Invalid game status'
            });
        }

        await PlayerService.updateGameStatus(gameId, status as GameStatus);
        return res.status(200).json({ message: 'Game status updated successfully' });
    } catch (error: any) {
        console.error('Error updating game status:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Fulfill demand card
router.post('/fulfill-demand', authenticateToken, async (req, res) => {
    console.debug('Received fulfill demand request at /api/players/fulfill-demand');
    console.debug('Request body:', req.body);

    try {
        const { gameId, playerId, city, loadType, cardId } = req.body;
        const userId = req.user?.id;

        // Validate request
        if (!gameId || !playerId || !city || !loadType || !cardId) {
            console.error('Invalid request - missing required fields:', req.body);
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID, player ID, city, load type, and card ID are required'
            });
        }

        // Security: Authentication is required, so userId must be present
        if (!userId) {
            return res.status(401).json({ 
                error: 'UNAUTHORIZED',
                details: 'Authentication required to fulfill demand cards' 
            });
        }

        // Verify that the requesting user owns this player
        const players = await PlayerService.getPlayers(gameId, userId);
        const player = players.find(p => p.id === playerId);
        
        if (!player) {
            return res.status(404).json({ 
                error: 'Not found',
                details: 'Player not found in game'
            });
        }
        
        if (player.userId !== userId) {
            return res.status(403).json({ 
                error: 'Forbidden',
                details: 'You can only fulfill demand cards for your own player'
            });
        }

        // Call the service to handle the demand fulfillment
        const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);
        console.log('Successfully fulfilled demand card');

        return res.status(200).json(result);
    } catch (error: any) {
        console.error('Error in /fulfill-demand route:', error);
        
        // Handle specific error cases
        if (error.message === 'Player not found') {
            return res.status(404).json({ 
                error: 'Not found',
                details: error.message
            });
        }
        if (error.message === 'Failed to draw new card') {
            return res.status(500).json({ 
                error: 'Deck error',
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

// Log that routes are being registered
console.log('Player routes registered:');
router.stack.forEach((r: any) => {
    if (r.route && r.route.path) {
        console.log(`${Object.keys(r.route.methods)} ${r.route.path}`);
    }
});

export default router; 