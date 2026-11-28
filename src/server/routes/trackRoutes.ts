import express, { Request, Response, NextFunction } from 'express';
import { TrackService } from '../services/trackService';
import { ActionRestrictionError, PlayerService } from '../services/playerService';
import { parseBuildRequest, TrackBuildError } from '../services/trackBuild';
import { TurnGuardError } from '../services/turnGuard';
import { emitStatePatch, getSocketIO } from '../services/socketService';
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

/** Tell the game's clients to reload track; best-effort, after the commit. */
function emitTrackUpdated(gameId: string, playerId: string): void {
    const io = getSocketIO();
    if (io) {
        io.to(gameId).emit('track:updated', { gameId, playerId, timestamp: Date.now() });
    }
}

/** Map the errors the validated build/undo services throw to HTTP responses. */
function sendTrackActionError(res: Response, route: string, error: unknown): Response {
    if (error instanceof TurnGuardError || error instanceof TrackBuildError) {
        return res.status(error.httpStatus).json(error.toResponseBody());
    }
    if (error instanceof ActionRestrictionError) {
        return res.status(409).json({ error: 'Conflict', code: error.code, details: error.message });
    }
    console.error(`Error in ${route} route:`, error);
    return res.status(500).json({
        error: 'Server error',
        details: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
}

/**
 * Read the game id of a build/undo request, answering 401/400 itself when the
 * request cannot proceed. The acting player always comes from the session.
 */
function readTrackActionRequest(req: Request, res: Response): { gameId: string; userId: string } | null {
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ error: 'UNAUTHORIZED', details: 'Authentication required' });
        return null;
    }
    const { gameId } = req.body as { gameId?: unknown };
    if (typeof gameId !== 'string' || !isUuid(gameId)) {
        res.status(400).json({ error: 'Validation error', details: 'A valid gameId is required' });
        return null;
    }
    return { gameId, userId };
}

// Build track (authenticated, server-authoritative, #308/#309).
// Body: { gameId, path: [{ row, col }, ...] } for a path of mileposts, or
// { gameId, segments: [{ from: { row, col }, to: { row, col } }, ...] } for the
// sections a player drew (what the client sends on leaving drawing mode).
// The server validates every section, computes its cost, and stores all of
// them or none; the cost is charged when the turn ends.
router.post('/build', authenticateToken, async (req: Request, res: Response) => {
    const request = readTrackActionRequest(req, res);
    if (!request) return res;
    try {
        const build = parseBuildRequest(req.body as { path?: unknown; segments?: unknown });
        const result = await PlayerService.buildTrackForUser(request.gameId, request.userId, build);
        emitTrackUpdated(request.gameId, result.playerId);
        return res.status(200).json({
            segments: result.segments,
            cost: result.cost,
            turnBuildCost: result.turnBuildCost,
            money: result.money,
        });
    } catch (error: unknown) {
        return sendTrackActionError(res, '/build', error);
    }
});

// Undo the last track section built this turn (authenticated, server-authoritative, #308).
// Body: { gameId }.
router.post('/undo-segment', authenticateToken, async (req: Request, res: Response) => {
    const request = readTrackActionRequest(req, res);
    if (!request) return res;
    try {
        const result = await PlayerService.undoTrackSegmentForUser(request.gameId, request.userId);
        emitTrackUpdated(request.gameId, result.playerId);
        try {
            // Money only changes when the section had already been settled.
            await emitStatePatch(request.gameId, {
                players: [{ id: result.playerId, money: result.money }],
            } as any);
        } catch (emitError) {
            console.error('Post-commit emit failed in /undo-segment (track was removed):', emitError);
        }
        return res.status(200).json({
            removedSegment: result.removedSegment,
            refunded: result.refunded,
            turnBuildCost: result.turnBuildCost,
            money: result.money,
        });
    } catch (error: unknown) {
        return sendTrackActionError(res, '/undo-segment', error);
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