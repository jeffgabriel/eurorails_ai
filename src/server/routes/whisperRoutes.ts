import express, { Request, Response } from 'express';
import { WhisperService } from '../services/ai/WhisperService';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { db } from '../db';

const router = express.Router();

/**
 * GET /api/games/:gameId/whispers
 * Retrieve whisper records for a game, with optional filters.
 */
router.get('/:gameId/whispers', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { gameId } = req.params;
  const { turnNumber, botPlayerId } = req.query;

  try {
    // Verify game exists
    const gameResult = await db.query(
      'SELECT id FROM games WHERE id = $1',
      [gameId],
    );

    if (gameResult.rows.length === 0) {
      res.status(404).json({
        error: 'GAME_NOT_FOUND',
        message: 'Game not found',
      });
      return;
    }

    // Verify user is in the game
    const playerResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 AND is_deleted = false',
      [gameId, user.id],
    );

    if (playerResult.rows.length === 0) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You are not in this game',
      });
      return;
    }

    const filters: { turnNumber?: number; botPlayerId?: string } = {};
    if (turnNumber) {
      filters.turnNumber = parseInt(turnNumber as string, 10);
    }
    if (botPlayerId) {
      filters.botPlayerId = botPlayerId as string;
    }

    const whispers = await WhisperService.getWhispers(gameId, filters);

    res.status(200).json({
      whispers,
      total: whispers.length,
    });
  } catch (error) {
    console.error('Get whispers error:', error);

    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get whispers',
      details: 'An unexpected error occurred',
    });
  }
}));

export default router;
