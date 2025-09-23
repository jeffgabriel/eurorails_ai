import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';
import { User } from '../../shared/types/AuthTypes';

// Extend Express Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Authentication middleware that verifies JWT tokens
 */
export const authenticateToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Access token required',
        details: 'Please provide a valid access token in the Authorization header'
      });
      return;
    }

    // Verify token
    const payload = AuthService.verifyToken(token);
    if (!payload) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
        details: 'Please login again to get a new token'
      });
      return;
    }

    // Get user from database
    const user = await AuthService.findUserById(payload.userId);
    if (!user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not found',
        details: 'The user associated with this token no longer exists'
      });
      return;
    }

    // Add user to request object
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Authentication failed',
      details: 'An error occurred while verifying your token'
    });
  }
};

/**
 * Optional authentication middleware - doesn't fail if no token provided
 */
export const optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const payload = AuthService.verifyToken(token);
      if (payload) {
        const user = await AuthService.findUserById(payload.userId);
        if (user) {
          req.user = user;
        }
      }
    }

    next();
  } catch (error) {
    console.error('Optional authentication error:', error);
    // Don't fail the request, just continue without user
    next();
  }
};

/**
 * Middleware to check if user is authenticated (for protected routes)
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: 'This endpoint requires a valid authentication token'
    });
    return;
  }
  next();
};

/**
 * Middleware to check if user email is verified
 */
export const requireEmailVerified = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: 'This endpoint requires a valid authentication token'
    });
    return;
  }

  if (!req.user.emailVerified) {
    res.status(403).json({
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Email verification required',
      details: 'Please verify your email address before accessing this feature'
    });
    return;
  }

  next();
};
