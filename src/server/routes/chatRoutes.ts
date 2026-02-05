import express, { Request, Response } from 'express';
import { BlockService } from '../services/blockService';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { db } from '../db';

const router = express.Router();

/**
 * GET /api/chat/settings
 * Get user's chat settings
 */
router.get('/settings', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    // Get user's chat_enabled setting
    const userResult = await db.query(
      'SELECT chat_enabled FROM users WHERE id = $1',
      [user.id]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
      return;
    }

    const chatEnabled = userResult.rows[0].chat_enabled;

    // Get blocked users
    const blockedUsers = await BlockService.getBlockedUsers(user.id);

    res.status(200).json({
      success: true,
      data: {
        chatEnabled,
        blockedUsers
      },
      message: 'Chat settings retrieved successfully'
    });
  } catch (error) {
    console.error('Get chat settings error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get chat settings',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * PUT /api/chat/settings
 * Update user's chat enabled status
 */
router.put('/settings', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { chatEnabled } = req.body;

  if (typeof chatEnabled !== 'boolean') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'chatEnabled must be a boolean',
      details: 'Please provide true or false'
    });
    return;
  }

  try {
    await db.query(
      'UPDATE users SET chat_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [chatEnabled, user.id]
    );

    res.status(200).json({
      success: true,
      data: {
        chatEnabled
      },
      message: `Chat ${chatEnabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Update chat settings error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update chat settings',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/chat/block
 * Block a user (prevents chat communication)
 */
router.post('/block', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { blockedUserId } = req.body;

  if (!blockedUserId || typeof blockedUserId !== 'string') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'blockedUserId is required',
      details: 'Please provide a valid user ID'
    });
    return;
  }

  // Check if trying to block self
  if (user.id === blockedUserId) {
    res.status(400).json({
      error: 'CANNOT_BLOCK_SELF',
      message: 'You cannot block yourself',
      details: 'Please select a different user'
    });
    return;
  }

  try {
    // Verify blocked user exists
    const blockedUserResult = await db.query(
      'SELECT id, username FROM users WHERE id = $1',
      [blockedUserId]
    );

    if (blockedUserResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User to block not found',
        details: 'Please provide a valid user ID'
      });
      return;
    }

    await BlockService.blockUser(user.id, blockedUserId);

    res.status(200).json({
      success: true,
      message: 'User blocked successfully',
      details: `${blockedUserResult.rows[0].username} has been blocked`
    });
  } catch (error) {
    console.error('Block user error:', error);
    
    if (error instanceof Error && error.message === 'CANNOT_BLOCK_SELF') {
      res.status(400).json({
        error: 'CANNOT_BLOCK_SELF',
        message: 'You cannot block yourself'
      });
      return;
    }
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to block user',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/chat/unblock
 * Unblock a user
 */
router.post('/unblock', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { blockedUserId } = req.body;

  if (!blockedUserId || typeof blockedUserId !== 'string') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'blockedUserId is required',
      details: 'Please provide a valid user ID'
    });
    return;
  }

  try {
    // Verify blocked user exists
    const blockedUserResult = await db.query(
      'SELECT id, username FROM users WHERE id = $1',
      [blockedUserId]
    );

    if (blockedUserResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User to unblock not found',
        details: 'Please provide a valid user ID'
      });
      return;
    }

    await BlockService.unblockUser(user.id, blockedUserId);

    res.status(200).json({
      success: true,
      message: 'User unblocked successfully',
      details: `${blockedUserResult.rows[0].username} has been unblocked`
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to unblock user',
      details: 'An unexpected error occurred'
    });
  }
}));

export default router;
