import express, { Request, Response, NextFunction } from 'express';
import { TrackService } from '../services/trackService';
import { getSocketIO } from '../services/socketService';
import { authenticateToken } from '../middleware/authMiddleware';
import { requireGameMembership } from '../middleware/gameMembership';
import { db } from '../db';
import { isUuid } from '../utils/uuid';

const router = express.Router();

const PUBLIC_MAP_STATUSES = ['completed', 'abandoned'];
const requireMember = requireGameMembership('gameId');

/**
 * All-tracks reads are limited to the game's players, except for completed or
 * abandoned games: those back the public read-only map viewer (/map/:id),
 * matching GET /api/game/:gameId/map-data. The viewer only needs the aggregate
 * route, so the per-player route has no such exception.
 */
async function requireMemberUnlessFinished(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { gameId } = req.params;
    try {
        if (isUuid(gameId)) {
            const result = await db.query('SELECT status FROM games WHERE id = $1', [gameId]);
            if (result.rows.length > 0 && PUBLIC_MAP_STATUSES.includes(result.rows[0].status)) {
                next();
                return;
            }
        }
    } catch (error) {
        console.error('Track read access check failed:', error);
        res.status(500).json({ error: 'Server error', details: 'Failed to verify access' });
        return;
    }
    await authenticateToken(req, res, () => requireMember(req, res, next));
}

// Save track state
router.post('/save', async (req, res) => {
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

        // Emit track update event to all clients in the game room
        const io = getSocketIO();
        if (io) {
            io.to(gameId).emit('track:updated', {
                gameId,
                playerId,
                timestamp: Date.now()
            });
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
router.get('/:gameId/:playerId', authenticateToken, requireMember, async (req, res) => {
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
router.get('/:gameId', requireMemberUnlessFinished, async (req, res) => {
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

export default router; 