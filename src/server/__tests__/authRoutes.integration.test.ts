/**
 * AuthRoutes Integration Tests
 * Tests for authentication API endpoints
 */

import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/authRoutes';
import { AuthService } from '../services/authService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

// Mock the AuthService
jest.mock('../services/authService');
const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

// Helper function to run database queries with proper connection handling
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

// Helper function to clean up test data
async function cleanupTestUsers(userIds: string[]) {
  if (userIds.length > 0) {
    await runQuery(async (client) => {
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    });
  }
}

describe('AuthRoutes', () => {
  let testUserIds: string[] = [];

  afterEach(async () => {
    // Clean up test users after each test
    await cleanupTestUsers(testUserIds);
    testUserIds = [];
    jest.clearAllMocks();
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestUsers(testUserIds);
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const mockUser = {
        id: uuidv4(),
        username: userData.username,
        email: userData.email,
        emailVerified: false,
        createdAt: new Date(),
        lastActive: new Date(),
        updatedAt: new Date()
      };

      const mockTokens = {
        accessToken: 'mock.access.token',
        refreshToken: 'mock.refresh.token'
      };

      mockAuthService.register.mockResolvedValue({
        user: mockUser,
        token: mockTokens.accessToken,
        refreshToken: mockTokens.refreshToken
      });

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: mockUser.id,
            username: mockUser.username,
            email: mockUser.email,
            emailVerified: mockUser.emailVerified,
            createdAt: mockUser.createdAt.toISOString(),
            lastActive: mockUser.lastActive.toISOString(),
          },
          token: mockTokens.accessToken,
          refreshToken: mockTokens.refreshToken
        },
        message: 'User registered successfully'
      });

      expect(mockAuthService.register).toHaveBeenCalledWith(userData);
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'testuser'
          // missing email and password
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message).toContain('required');
    });

    it('should return 400 for invalid email format', async () => {
      const userData = {
        username: 'testuser',
        email: 'invalid-email',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message).toContain('email');
    });

    it('should return 400 for weak password', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'weak',
        confirmPassword: 'weak'
      };

      mockAuthService.register.mockRejectedValue(new Error('Password must be at least 8 characters long'));

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toBe('REGISTRATION_FAILED');
      expect(response.body.message).toBe('Password must be at least 8 characters long');
    });

    it('should return 409 for duplicate email', async () => {
      const userData = {
        username: 'testuser',
        email: 'duplicate@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      mockAuthService.register.mockRejectedValue(new Error('User with this email already exists'));

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toBe('REGISTRATION_FAILED');
      expect(response.body.message).toBe('User with this email already exists');
    });

    it('should return 409 for duplicate username', async () => {
      const userData = {
        username: 'duplicateuser',
        email: 'test@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      mockAuthService.register.mockRejectedValue(new Error('Username is already taken'));

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toBe('REGISTRATION_FAILED');
      expect(response.body.message).toBe('Username is already taken');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with valid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'TestPassword123'
      };

      const mockUser = {
        id: uuidv4(),
        username: 'testuser',
        email: loginData.email,
        emailVerified: true,
        createdAt: new Date(),
        lastActive: new Date(),
        updatedAt: new Date()
      };

      const mockTokens = {
        accessToken: 'mock.access.token',
        refreshToken: 'mock.refresh.token'
      };

      mockAuthService.login.mockResolvedValue({
        user: mockUser,
        token: mockTokens.accessToken,
        refreshToken: mockTokens.refreshToken
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: mockUser.id,
            username: mockUser.username,
            email: mockUser.email,
            emailVerified: mockUser.emailVerified,
            createdAt: mockUser.createdAt.toISOString(),
            lastActive: mockUser.lastActive.toISOString(),
          },
          token: mockTokens.accessToken,
          refreshToken: mockTokens.refreshToken
        },
        message: 'Login successful'
      });

      expect(mockAuthService.login).toHaveBeenCalledWith(loginData);
    });

    it('should return 400 for missing credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com'
          // missing password
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message).toContain('required');
    });

    it('should return 401 for invalid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'WrongPassword123'
      };

      mockAuthService.login.mockRejectedValue(new Error('Invalid email or password'));

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(401);

      expect(response.body.error).toBe('LOGIN_FAILED');
      expect(response.body.message).toBe('Invalid email or password');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should logout successfully', async () => {
      const mockDecoded = {
        userId: uuidv4(),
        username: 'testuser',
        email: 'test@example.com',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (15 * 60)
      };

      mockAuthService.verifyToken.mockReturnValue(mockDecoded);
      mockAuthService.findUserById.mockResolvedValue({
        id: mockDecoded.userId,
        username: mockDecoded.username,
        email: mockDecoded.email,
        emailVerified: true,
        createdAt: new Date(),
        lastActive: new Date(),
        updatedAt: new Date()
      });

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer valid.access.token')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Logout successful'
      });
    });
  });

  describe('POST /api/auth/refresh-token', () => {
    it('should refresh token successfully', async () => {
      const refreshToken = 'valid.refresh.token';
      const mockUser = {
        id: uuidv4(),
        username: 'testuser',
        email: 'test@example.com',
        emailVerified: true,
        createdAt: new Date(),
        lastActive: new Date(),
        updatedAt: new Date()
      };

      const mockTokens = {
        accessToken: 'new.access.token',
        refreshToken: 'new.refresh.token'
      };

      mockAuthService.refreshAccessToken.mockResolvedValue({
        token: mockTokens.accessToken,
        refreshToken: mockTokens.refreshToken
      });

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          token: mockTokens.accessToken,
          refreshToken: mockTokens.refreshToken
        },
        message: 'Token refreshed successfully'
      });

      expect(mockAuthService.refreshAccessToken).toHaveBeenCalledWith(refreshToken);
    });

    it('should return 400 for missing refresh token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message).toContain('required');
    });

    it('should return 401 for invalid refresh token', async () => {
      const refreshToken = 'invalid.refresh.token';

      mockAuthService.refreshAccessToken.mockRejectedValue(new Error('Invalid refresh token'));

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      expect(response.body.error).toBe('INVALID_REFRESH_TOKEN');
      expect(response.body.message).toBe('Invalid or expired refresh token');
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user profile with valid token', async () => {
      const mockUser = {
        id: uuidv4(),
        username: 'testuser',
        email: 'test@example.com',
        emailVerified: true,
        createdAt: new Date(),
        lastActive: new Date(),
        updatedAt: new Date()
      };

      const mockDecoded = {
        userId: mockUser.id,
        username: mockUser.username,
        email: mockUser.email,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (15 * 60)
      };

      mockAuthService.verifyToken.mockReturnValue(mockDecoded);
      mockAuthService.findUserById.mockResolvedValue(mockUser);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer valid.access.token')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: mockUser.id,
            username: mockUser.username,
            email: mockUser.email,
            emailVerified: mockUser.emailVerified,
            createdAt: mockUser.createdAt.toISOString(),
            lastActive: mockUser.lastActive.toISOString(),
          }
        },
        message: 'User profile retrieved successfully'
      });

      expect(mockAuthService.verifyToken).toHaveBeenCalledWith('valid.access.token');
      expect(mockAuthService.findUserById).toHaveBeenCalledWith(mockUser.id);
    });

    it('should return 401 for missing authorization header', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('Access token required');
    });

    it('should return 401 for invalid token', async () => {
      mockAuthService.verifyToken.mockReturnValue(null);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid.token')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('Invalid or expired token');
    });

    it('should return 401 for non-existent user', async () => {
      const mockDecoded = {
        userId: uuidv4(),
        username: 'testuser',
        email: 'test@example.com',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (15 * 60)
      };

      mockAuthService.verifyToken.mockReturnValue(mockDecoded);
      mockAuthService.findUserById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer valid.access.token')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('User not found');
    });
  });
});
