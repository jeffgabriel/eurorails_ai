/**
 * AuthMiddleware Unit Tests
 * Tests for authentication middleware functionality
 */

import { Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { AuthService } from '../services/authService';
import { v4 as uuidv4 } from 'uuid';

// Mock the AuthService
jest.mock('../services/authService');
const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

describe('authenticateToken middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      user: undefined
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  it('should authenticate valid token and call next', async () => {
    const mockUser = {
      userId: uuidv4(),
      username: 'testuser',
      email: 'test@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (15 * 60)
    };

    mockAuthService.verifyToken.mockReturnValue(mockUser);
    mockAuthService.findUserById.mockResolvedValue({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: new Date(),
      lastActive: new Date(),
      updatedAt: new Date()
    });
    mockRequest.headers = {
      authorization: 'Bearer valid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockAuthService.verifyToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(mockRequest.user).toEqual({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: expect.any(Date),
      lastActive: expect.any(Date),
      updatedAt: expect.any(Date)
    });
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it('should return 401 for missing authorization header', async () => {
    mockRequest.headers = {};

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for malformed authorization header', async () => {
    mockRequest.headers = {
      authorization: 'InvalidFormat'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for missing Bearer prefix', async () => {
    mockRequest.headers = {
      authorization: 'valid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for invalid token', async () => {
    mockAuthService.verifyToken.mockReturnValue(null);
    mockRequest.headers = {
      authorization: 'Bearer invalid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockAuthService.verifyToken).toHaveBeenCalledWith('invalid.jwt.token');
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
      details: 'Please login again to get a new token'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for expired token', async () => {
    mockAuthService.verifyToken.mockReturnValue(null);
    mockRequest.headers = {
      authorization: 'Bearer expired.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockAuthService.verifyToken).toHaveBeenCalledWith('expired.jwt.token');
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
      details: 'Please login again to get a new token'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle case-insensitive authorization header', async () => {
    const mockUser = {
      userId: uuidv4(),
      username: 'testuser',
      email: 'test@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (15 * 60)
    };

    mockAuthService.verifyToken.mockReturnValue(mockUser);
    mockAuthService.findUserById.mockResolvedValue({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: new Date(),
      lastActive: new Date(),
      updatedAt: new Date()
    });
    mockRequest.headers = {
      authorization: 'bearer valid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockAuthService.verifyToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(mockRequest.user).toEqual({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: expect.any(Date),
      lastActive: expect.any(Date),
      updatedAt: expect.any(Date)
    });
    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle mixed case authorization header', async () => {
    const mockUser = {
      userId: uuidv4(),
      username: 'testuser',
      email: 'test@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (15 * 60)
    };

    mockAuthService.verifyToken.mockReturnValue(mockUser);
    mockAuthService.findUserById.mockResolvedValue({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: new Date(),
      lastActive: new Date(),
      updatedAt: new Date()
    });
    mockRequest.headers = {
      authorization: 'BeArEr valid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockAuthService.verifyToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(mockRequest.user).toEqual({
      id: mockUser.userId,
      username: mockUser.username,
      email: mockUser.email,
      emailVerified: true,
      createdAt: expect.any(Date),
      lastActive: expect.any(Date),
      updatedAt: expect.any(Date)
    });
    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle extra whitespace in authorization header', async () => {
    mockRequest.headers = {
      authorization: '  Bearer   valid.jwt.token  '
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle empty token after Bearer', async () => {
    mockRequest.headers = {
      authorization: 'Bearer '
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle multiple spaces between Bearer and token', async () => {
    mockRequest.headers = {
      authorization: 'Bearer    valid.jwt.token'
    };

    await authenticateToken(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Access token required',
      details: 'Please provide a valid access token in the Authorization header'
    });
    expect(mockNext).not.toHaveBeenCalled();
  });
});
