import express, { Request, Response } from 'express';
import { AuthService } from '../services/authService';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { LoginForm, RegisterForm, User } from '../../shared/types/AuthTypes';

const router = express.Router();

// Request/Response interfaces
interface RegisterRequest extends RegisterForm {}

interface LoginRequest extends LoginForm {}

interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

interface RefreshTokenRequest {
  refreshToken: string;
}

// Helper function to validate required fields
function validateRequiredFields(fields: Record<string, any>, res: Response): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `Missing required field: ${key}`,
        details: `${key} is required`
      });
      return false;
    }
  }
  return true;
}

// Helper function to validate email format
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', asyncHandler(async (req: Request, res: Response) => {
  const { username, email, password, confirmPassword }: RegisterRequest = req.body;

  // Validate required fields
  if (!validateRequiredFields({ username, email, password, confirmPassword }, res)) {
    return;
  }

  // Validate email format
  if (!validateEmail(email)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid email format',
      details: 'Please provide a valid email address'
    });
    return;
  }

  try {
    const result = await AuthService.register({
      username,
      email,
      password,
      confirmPassword
    });

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: result.user.id,
          username: result.user.username,
          email: result.user.email,
          emailVerified: result.user.emailVerified,
          createdAt: result.user.createdAt,
          lastActive: result.user.lastActive
        },
        token: result.token,
        refreshToken: result.refreshToken
      },
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    if (error instanceof Error) {
      res.status(400).json({
        error: 'REGISTRATION_FAILED',
        message: error.message,
        details: 'Please check your input and try again'
      });
    } else {
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Registration failed',
        details: 'An unexpected error occurred'
      });
    }
  }
}));

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { email, password }: LoginRequest = req.body;

  // Validate required fields
  if (!validateRequiredFields({ email, password }, res)) {
    return;
  }

  // Validate email format
  if (!validateEmail(email)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid email format',
      details: 'Please provide a valid email address'
    });
    return;
  }

  try {
    const result = await AuthService.login({ email, password });

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: result.user.id,
          username: result.user.username,
          email: result.user.email,
          emailVerified: result.user.emailVerified,
          createdAt: result.user.createdAt,
          lastActive: result.user.lastActive
        },
        token: result.token,
        refreshToken: result.refreshToken
      },
      message: 'Login successful'
    });
  } catch (error) {
    console.error('Login error:', error);
    
    if (error instanceof Error) {
      res.status(401).json({
        error: 'LOGIN_FAILED',
        message: error.message,
        details: 'Invalid email or password'
      });
    } else {
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Login failed',
        details: 'An unexpected error occurred'
      });
    }
  }
}));

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken }: RefreshTokenRequest = req.body;

  // Validate required fields
  if (!validateRequiredFields({ refreshToken }, res)) {
    return;
  }

  try {
    const result = await AuthService.refreshAccessToken(refreshToken);

    res.status(200).json({
      success: true,
      data: {
        token: result.token,
        refreshToken: result.refreshToken
      },
      message: 'Token refreshed successfully'
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    
    res.status(401).json({
      error: 'INVALID_REFRESH_TOKEN',
      message: 'Invalid or expired refresh token',
      details: 'Please login again'
    });
  }
}));

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!; // We know user exists due to requireAuth middleware

  res.status(200).json({
    success: true,
    data: {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        lastActive: user.lastActive
      }
    },
    message: 'User profile retrieved successfully'
  });
}));

/**
 * PUT /api/auth/me
 * Update current user profile
 */
router.put('/me', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { username, email } = req.body;

  // Validate input
  if (username && username.length < 3) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Username must be at least 3 characters long',
      details: 'Please provide a valid username'
    });
    return;
  }

  if (email && !validateEmail(email)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid email format',
      details: 'Please provide a valid email address'
    });
    return;
  }

  try {
    // Update user profile (implementation would go here)
    // For now, just return the current user
    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          lastActive: user.lastActive
        }
      },
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Profile update error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Profile update failed',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post('/change-password', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { currentPassword, newPassword }: ChangePasswordRequest = req.body;

  // Validate required fields
  if (!validateRequiredFields({ currentPassword, newPassword }, res)) {
    return;
  }

  try {
    await AuthService.changePassword(user.id, currentPassword, newPassword);

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Password change error:', error);
    
    if (error instanceof Error) {
      res.status(400).json({
        error: 'PASSWORD_CHANGE_FAILED',
        message: error.message,
        details: 'Please check your current password and try again'
      });
    } else {
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Password change failed',
        details: 'An unexpected error occurred'
      });
    }
  }
}));

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post('/logout', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  // In a stateless JWT system, logout is handled client-side
  // We could implement a token blacklist here if needed
  
  res.status(200).json({
    success: true,
    message: 'Logout successful'
  });
}));

/**
 * DELETE /api/auth/me
 * Delete user account
 */
router.delete('/me', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    await AuthService.deleteUser(user.id);

    res.status(200).json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    console.error('Account deletion error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Account deletion failed',
      details: 'An unexpected error occurred'
    });
  }
}));

export default router;
