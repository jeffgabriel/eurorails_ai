import { Request, Response, NextFunction, RequestHandler } from 'express';
import { PlayerService } from '../services/playerService';
import { isUuid } from '../utils/uuid';

/**
 * Builds middleware that allows the request through only when the authenticated
 * user is a non-deleted player in the game named by the given route param.
 *
 * Must run after `authenticateToken`. Responds 401 when there is no user and
 * 403 when the user is not a member (including malformed game ids, so the
 * response does not reveal whether a game exists).
 */
export function requireGameMembership(paramName: string = 'gameId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
        details: 'This endpoint requires a valid authentication token',
      });
      return;
    }

    const gameId = req.params[paramName];
    try {
      const isMember = isUuid(gameId)
        && await PlayerService.isUserPlayerInGame(gameId, userId);

      if (!isMember) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Not a player in this game',
          details: 'You are not a player in this game',
        });
        return;
      }

      next();
    } catch (error) {
      console.error('Game membership check failed:', error);
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Membership check failed',
        details: 'An error occurred while verifying game membership',
      });
    }
  };
}
