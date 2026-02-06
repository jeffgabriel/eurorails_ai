import { Request, Response, NextFunction } from 'express';
import { isAIBotsEnabled } from '../config/aiConfig';

/**
 * Middleware that gates AI-related endpoints behind the ENABLE_AI_BOTS feature flag.
 * Returns 403 when the feature is disabled.
 */
export const requireAIEnabled = (req: Request, res: Response, next: NextFunction): void => {
  if (!isAIBotsEnabled()) {
    res.status(403).json({
      error: 'AI_BOTS_DISABLED',
      message: 'AI bot functionality is not enabled',
    });
    return;
  }
  next();
};
