import express from 'express';
import { PlayerService } from '../services/playerService';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { requireGameMembership } from '../middleware/gameMembership';
import { emitStatePatch, getSocketIO } from '../services/socketService';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import { TurnGuardError } from '../services/turnGuard';
import { GameSettingsService, GameSettingsError } from '../services/gameSettingsService';
import { isUuid } from '../utils/uuid';

const router = express.Router();

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

// Edit the caller's own player (Settings menu): name and/or color only.
// The player is found from the token, so no other player can be targeted.
router.patch('/me', authenticateToken, async (req, res) => {
    try {
        const { gameId, name, color } = req.body as {
            gameId?: string;
            name?: string;
            color?: string;
        };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                details: 'Authentication required'
            });
        }

        if (!isUuid(gameId)) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Game ID is required'
            });
        }

        if (name === undefined && color === undefined) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'Provide a name or a color to change'
            });
        }

        const profile = await GameSettingsService.updateOwnPlayer(gameId, userId, { name, color });

        const updatedPlayers = await PlayerService.getPlayers(gameId, userId);
        const updatedPlayer = updatedPlayers.find(p => p.id === profile.id);
        if (updatedPlayer) {
            await emitStatePatch(gameId, { players: [updatedPlayer] } as any);
        }

        return res.status(200).json({ player: profile });
    } catch (error: any) {
        if (error instanceof GameSettingsError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }
        console.error('Error in PATCH /me route:', error);
        return res.status(500).json({
            error: 'Server error',
            details: 'Failed to update player'
        });
    }
});

// Get players for a game
// Require authentication to enforce per-player hand visibility
router.get('/:gameId', authenticateToken, requireGameMembership('gameId'), async (req, res) => {
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

// End the caller's turn (authenticated, server-authoritative).
// The server decides who is next and owns the end-of-turn bookkeeping (turn
// number, build-cost reset); any `currentPlayerIndex` in the body is ignored.
router.post('/updateCurrentPlayer', authenticateToken, async (req, res) => {
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
                details: 'Game ID is required'
            });
        }

        const result = await PlayerService.endTurnForUser(gameId, userId);

        // The ending player's turn_build_cost was reset; tell clients to refresh
        // that player's track state (the client's /tracks/save clear used to do this).
        const io = getSocketIO();
        if (io) {
            io.to(gameId).emit('track:updated', {
                gameId,
                playerId: result.playerId,
                timestamp: Date.now()
            });
        }

        // Broadcast the ending player's new turn number and settled money (the
        // client's /players/update calls used to trigger this patch).
        const updatedPlayers = await PlayerService.getPlayers(gameId, userId);
        const endingPlayer = updatedPlayers.find(p => p.id === result.playerId);
        if (endingPlayer) {
            await emitStatePatch(gameId, { players: [endingPlayer] } as any);
        }

        return res.status(200).json({
            currentPlayerIndex: result.currentPlayerIndex,
            playerId: result.playerId,
            turnNumber: result.turnNumber,
        });
    } catch (error: any) {
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }
        if (error?.stale) {
            return res.status(409).json({
                error: 'Conflict',
                details: error.message,
            });
        }
        console.error('Error in /updateCurrentPlayer route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});

// Settle the caller's build cost for this turn (authenticated, server-authoritative).
// Charges money for turn_build_cost and resets it, atomically and idempotently.
// The client calls it before its end-of-turn victory check; ending the turn
// settles again, so nothing is ever charged twice or left unpaid.
router.post('/settle-build-cost', authenticateToken, async (req, res) => {
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
                details: 'Game ID is required'
            });
        }

        const result = await PlayerService.settleBuildCostForUser(gameId, userId);

        if (result.charged !== 0) {
            const io = getSocketIO();
            if (io) {
                io.to(gameId).emit('track:updated', {
                    gameId,
                    playerId: result.playerId,
                    timestamp: Date.now()
                });
            }
            const updatedPlayers = await PlayerService.getPlayers(gameId, userId);
            const updatedPlayer = updatedPlayers.find(p => p.id === result.playerId);
            if (updatedPlayer) {
                await emitStatePatch(gameId, { players: [updatedPlayer] } as any);
            }
        }

        return res.status(200).json({ charged: result.charged, money: result.money });
    } catch (error: any) {
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }
        console.error('Error in /settle-build-cost route:', error);
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

        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';
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

        // If delivery was restricted by an active event, return the restriction info
        if ('restricted' in result && result.restricted) {
            return res.status(200).json(result);
        }

        // Broadcast updated player state
        // Issue #176: Hands are public, so broadcast full player data including hand
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = publicPlayers.find(p => p.userId === userId);
        if (updatedPlayer) {
            await emitStatePatch(gameId, { players: [updatedPlayer] } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

        if (message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'UNAUTHORIZED', details: message });
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
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

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
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

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
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

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
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

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

// Borrow money from the bank (Mercy Rule) - authenticated, server-authoritative
router.post('/borrow', authenticateToken, async (req, res) => {
    try {
        const { gameId, amount } = req.body as { gameId?: string; amount?: number };
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                message: 'Authentication required',
                details: 'Authentication required'
            });
        }

        if (!gameId) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'gameId is required'
            });
        }

        if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) {
            return res.status(400).json({
                error: 'Validation error',
                details: 'amount is required and must be an integer'
            });
        }

        const result = await PlayerService.borrowForUser(gameId, userId, amount);

        // Broadcast updated public player state (do not leak hand)
        const publicPlayers = await PlayerService.getPlayers(gameId, '');
        const updatedPlayer = publicPlayers.find(p => p.userId === userId);
        if (updatedPlayer) {
            const { hand: _hand, ...playerWithoutHand } = updatedPlayer as any;
            await emitStatePatch(gameId, { players: [playerWithoutHand] } as any);
        }

        return res.status(200).json(result);
    } catch (error: any) {
        if (error instanceof TurnGuardError) {
            return res.status(error.httpStatus).json(error.toResponseBody());
        }

        const message = error?.message || 'An unexpected error occurred';

        if (
            message.includes('Amount must be') ||
            message.includes('Invalid') ||
            message.includes('integer')
        ) {
            return res.status(400).json({ error: 'Validation error', details: message });
        }

        return res.status(500).json({ error: 'Server error', details: message });
    }
});

export default router; 