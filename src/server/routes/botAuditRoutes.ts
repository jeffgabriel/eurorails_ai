import express from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { BotAuditService } from '../services/botAuditService';
import { db } from '../db';

const router = express.Router();

/**
 * GET /api/bot-audit/:gameId/:playerId
 * Returns the latest StrategyAudit for a bot player in a game.
 * Requires authentication and game membership.
 */
router.get('/:gameId/:playerId', authenticateToken, async (req, res) => {
  try {
    const { gameId, playerId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        details: 'Authentication required',
      });
    }

    if (!gameId || !playerId) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        details: 'Game ID and Player ID are required',
      });
    }

    // Verify the requesting user is a member of this game
    const membershipResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 LIMIT 1',
      [gameId, userId],
    );

    if (membershipResult.rows.length === 0) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        details: 'You are not a player in this game',
      });
    }

    // Verify the target player is a bot in this game
    const botCheck = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND id = $2 AND is_bot = true LIMIT 1',
      [gameId, playerId],
    );

    if (botCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        details: 'Bot player not found in this game',
      });
    }

    const audit = await BotAuditService.getLatestAudit(gameId, playerId);

    if (!audit) {
      return res.status(200).json({ audit: null });
    }

    return res.status(200).json({ audit });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    console.error('Error in GET /bot-audit/:gameId/:playerId:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      details: message,
    });
  }
});

export default router;
