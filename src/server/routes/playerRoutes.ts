import express from 'express';
import { PlayerService } from '../services/playerService';
import { v4 as uuidv4 } from 'uuid';
import { GameStatus } from '../types';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { emitStatePatch, emitTurnChange, getSocketIO } from '../services/socketService';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

const router = express.Router();

// Debug endpoint to verify route registration
router.get('/test', (req, res) => {
    res.json({ message: 'Player routes are working' });
});

// Create game
router.post('/game/create', async (req, res) => {
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

        await PlayerService.createPlayer(gameId, newPlayer);

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

        await PlayerService.updatePlayer(gameId, player);

        // Get updated player data for socket broadcast
        // Issue #176: Hands are public, so broadcast full player data including hand
        const updatedPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = updatedPlayers.find(p => p.id === player.id);
        
        if (updatedPlayer) {
            // Emit socket update with full player data (including public hand)
            await emitStatePatch(gameId, {
                players: [updatedPlayer]
            } as any);
        }

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
    try {
        const { gameId, playerId } = req.body;

        // Validate request
        if (!gameId || !playerId) {
            console.error('Invalid request - missing gameId or playerId:', req.body);
            return res.status(400).json({ error: 'Missing required fields' });
        }

        await PlayerService.deletePlayer(gameId, playerId);

        return res.status(200).json({ message: 'Player deleted successfully' });
    } catch (error) {
        console.error('Error in /delete route:', error);
        return res.status(500).json({ error: 'Failed to delete player' });
    }
});

// Get players for a game
// Require authentication to enforce per-player hand visibility
router.get('/:gameId', authenticateToken, async (req, res) => {
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

        const players = await PlayerService.getPlayers(gameId, userId);

        return res.status(200).json(players);
    } catch (error) {
        console.error('Error in GET /:gameId route:', error);
        return res.status(500).json({ error: 'Failed to get players' });
    }
});

// Update current player
router.post('/updateCurrentPlayer', async (req, res) => {
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
        
        // Emit turn change and state patch
        emitTurnChange(gameId, currentPlayerIndex);
        await emitStatePatch(gameId, {
            currentPlayerIndex: currentPlayerIndex
        });
        
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

// Upgrade / crossgrade train (authenticated, server-authoritative)
router.post('/upgrade-train', authenticateToken, async (req, res) => {
    try {
        const { gameId, kind, targetTrainType } = req.body as {
            gameId?: string;
            kind?: 'upgrade' | 'crossgrade';
            targetTrainType?: TrainType;
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId || !kind || !targetTrainType) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId, kind, and targetTrainType are required'
            });
        }

        if (kind !== 'upgrade' && kind !== 'crossgrade') {
            return res.status(400).json({
                error: 'Validation error',
                details: 'kind must be "upgrade" or "crossgrade"'
            });
        }

        if (!Object.values(TrainType).includes(targetTrainType)) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Invalid targetTrainType'
            });
        }

        const updatedPlayer = await PlayerService.purchaseTrainType(
            gameId,
            userId,
            kind,
            targetTrainType
        );

        // Broadcast player update
        await emitStatePatch(gameId, {
            players: [updatedPlayer]
        });

        return res.status(200).json({ player: updatedPlayer });
    } catch (error: any) {
        console.error('Error in /upgrade-train route:', error);

        const message = error?.message || 'An unexpected error occurred';
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (
            message.includes('Invalid') ||
            message.includes('Illegal') ||
            message.includes('Cannot') ||
            message.includes('Insufficient') ||
            message.includes('already')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({
            error: 'Server error',
            details: message
        });
    }
});

// Fulfill demand card
router.post('/fulfill-demand', authenticateToken, async (req, res) => {
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

        // Get updated player data for socket broadcast
        // Issue #176: Hands are public, so broadcast full player data including hand
        const updatedPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = updatedPlayers.find(p => p.id === playerId);
        
        if (updatedPlayer) {
            await emitStatePatch(gameId, {
                players: [updatedPlayer]
            } as any);
        }

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

// Deliver a load (authenticated, server-authoritative)
router.post('/deliver-load', authenticateToken, async (req, res) => {
    try {
        const { gameId, city, loadType, cardId } = req.body as {
            gameId?: string;
            city?: string;
            loadType?: LoadType;
            cardId?: number;
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId || !city || !loadType || typeof cardId !== 'number') {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId, city, loadType, and cardId are required'
            });
        }

        if (!Object.values(LoadType).includes(loadType)) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Invalid loadType'
            });
        }

        const result = await PlayerService.deliverLoadForUser(
            gameId,
            userId,
            city,
            loadType,
            cardId
        );

        // Broadcast updated player state
        // Issue #176: Hands are public, so broadcast full player data including hand
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = publicPlayers.find(p => p.userId === userId);
        if (updatedPlayer) {
            await emitStatePatch(gameId, { players: [updatedPlayer] } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'UNAUTHORIZED', details: message });
        }
        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (
            message.includes('Demand') ||
            message.includes('Load') ||
            message.includes('Invalid') ||
            message.includes('Failed to draw')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({
            error: 'Server error',
            details: message
        });
    }
});

// Borrow money from the bank
router.post('/borrow', authenticateToken, async (req, res) => {
    try {
        const { gameId, amount } = req.body as {
            gameId?: string;
            amount?: number;
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId || typeof amount !== 'number') {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId and amount are required'
            });
        }

        if (!Number.isInteger(amount) || amount < 1 || amount > 20) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Amount must be an integer between 1 and 20'
            });
        }

        const result = await PlayerService.borrowForUser(
            gameId,
            userId,
            amount
        );

        // Broadcast updated player state
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = publicPlayers.find(p => p.userId === userId);
        if (updatedPlayer) {
            await emitStatePatch(gameId, { players: [updatedPlayer] } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'UNAUTHORIZED', details: message });
        }
        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (
            message.includes('Amount must be') ||
            message.includes('Invalid') ||
            message.includes('Validation')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({
            error: 'Server error',
            details: message
        });
    }
});

// Move train and settle opponent track-usage fees (authenticated, server-authoritative on fees)
router.post('/move-train', authenticateToken, async (req, res) => {
    try {
        const { gameId, to, movementCost } = req.body as {
            gameId?: string;
            to?: { row: number; col: number; x?: number; y?: number };
            movementCost?: number;
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId || !to || typeof to.row !== 'number' || typeof to.col !== 'number') {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId and to{row,col} are required'
            });
        }

        const result = await PlayerService.moveTrainForUser({
            gameId,
            userId,
            to,
            movementCost
        });

        // Broadcast updated player states (payer + any payees)
        // Issue #176: Hands are public, so broadcast full player data including hands
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const patchedPlayers = publicPlayers
            .filter(p => result.affectedPlayerIds.includes(p.id));

        if (patchedPlayers.length > 0) {
            await emitStatePatch(gameId, { players: patchedPlayers } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (message.includes('Insufficient') || message.includes('Invalid') || message.includes('No valid path')) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({ error: 'Server error', details: message });
    }
});

// Undo the last server-tracked per-turn action for the authenticated player (delivery or move)
router.post('/undo-last-action', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.body as { gameId?: string };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId is required'
            });
        }

        const result = await PlayerService.undoLastActionForUser(gameId, userId);

        // Broadcast updated player state(s)
        // Issue #176: Hands are public, so broadcast full player data including hands
        // - deliver undo affects only the local player's state
        // - move undo can affect other players' money too (reverse fee transfer)
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = publicPlayers.find(p => p.userId === userId);
        const patched: any[] = [];
        if (updatedPlayer) {
            patched.push(updatedPlayer);
        }
        if (result && (result as any).kind === 'move') {
            const owners = Array.isArray((result as any).ownersReversed)
                ? (result as any).ownersReversed.map((o: any) => o.playerId).filter((v: any) => typeof v === 'string')
                : [];
            for (const pid of owners) {
                const p = publicPlayers.find(pp => pp.id === pid);
                if (p) {
                    // Avoid dupes
                    if (!patched.find(x => x.id === p.id)) {
                        patched.push(p);
                    }
                }
            }
        }
        if (patched.length > 0) {
            await emitStatePatch(gameId, { players: patched } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (message.includes('No undoable') || message.includes('not undoable') || message.includes('Invalid') || message.includes('Failed')) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({ error: 'Server error', details: message });
    }
});

// Discard entire hand and redraw 3 demand cards (skip turn) - authenticated, server-authoritative
router.post('/discard-hand', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.body as { gameId?: string };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId is required'
            });
        }

        const result = await PlayerService.discardHandForUser(gameId, userId);

        // Return updated player WITH hand to the requesting user only.
        const updatedPlayers = await PlayerService.getPlayers(gameId, userId);
        const updatedPlayer = updatedPlayers.find(p => p.userId === userId);
        if (!updatedPlayer) {
            return res.status(500).json({
                error: 'Server error',
                details: 'Failed to load updated player'
            });
        }

        return res.status(200).json({
            player: updatedPlayer,
            currentPlayerIndex: result.currentPlayerIndex,
            nextPlayerName: result.nextPlayerName,
        });
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (
            message.includes('Cannot discard') ||
            message.includes('Failed to draw') ||
            message.includes('Invalid') ||
            message.includes('not found')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({ error: 'Server error', details: message });
    }
});

// Restart (reset) the authenticated user's player to a clean starting state (does NOT end turn)
router.post('/restart', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.body as { gameId?: string };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!gameId) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId is required'
            });
        }

        const updatedPlayer = await PlayerService.restartForUser(gameId, userId);

        // Broadcast updated player state
        // Issue #176: Hands are public, so broadcast full player data including hand
        await emitStatePatch(gameId, { players: [updatedPlayer] } as any);

        // Broadcast track update so clients reload track state
        const io = getSocketIO();
        if (io) {
            io.to(gameId).emit('track:updated', {
                gameId,
                playerId: updatedPlayer.id,
                timestamp: Date.now()
            });
        }

        return res.status(200).json({ player: updatedPlayer });
    } catch (error: any) {
        const message = error?.message || 'An unexpected error occurred';

        if (message === 'Game not found') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Player not found in game') {
            return res.status(404).json({ error: 'Not found', details: message });
        }
        if (message === 'Not your turn') {
            return res.status(403).json({ error: 'Forbidden', details: message });
        }
        if (
            message.includes('Cannot restart') ||
            message.includes('Invalid') ||
            message.includes('Failed') ||
            message.includes('Cannot')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({ error: 'Server error', details: message });
    }
});

export default router; 