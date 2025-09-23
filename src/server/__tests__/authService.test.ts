/**
 * AuthService Unit Tests
 * Tests for user authentication, registration, and token management
 */

import { AuthService } from '../services/authService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

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

describe('AuthService', () => {
  let testUserIds: string[] = [];

  afterEach(async () => {
    // Clean up test users after each test
    await cleanupTestUsers(testUserIds);
    testUserIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestUsers(testUserIds);
    await db.end();
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const result = await AuthService.register(userData);
      testUserIds.push(result.user.id);

      expect(result.user.username).toBe(userData.username);
      expect(result.user.email).toBe(userData.email);
      expect(result.user.emailVerified).toBe(false);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.user.id).toBe('string');
      expect(result.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should hash password correctly', async () => {
      const userData = {
        username: 'testuser2',
        email: 'test2@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const result = await AuthService.register(userData);
      testUserIds.push(result.user.id);

      // Verify password is hashed (not plain text)
      const userRecord = await runQuery(async (client) => {
        const dbResult = await client.query('SELECT password_hash FROM users WHERE id = $1', [result.user.id]);
        return dbResult.rows[0];
      });

      expect(userRecord.password_hash).not.toBe(userData.password);
      expect(userRecord.password_hash).toMatch(/^\$2[aby]\$\d+\$.{53}$/); // bcrypt hash pattern
    });

    it('should throw error for duplicate email', async () => {
      const userData = {
        username: 'testuser3',
        email: 'duplicate@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      // Register first user
      const firstResult = await AuthService.register(userData);
      testUserIds.push(firstResult.user.id);

      // Try to register with same email
      await expect(AuthService.register({
        username: 'testuser4',
        email: 'duplicate@example.com',
        password: 'AnotherPassword123',
        confirmPassword: 'AnotherPassword123'
      })).rejects.toThrow('User with this email already exists');
    });

    it('should throw error for duplicate username', async () => {
      const userData = {
        username: 'duplicateuser',
        email: 'unique1@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      // Register first user
      const firstResult = await AuthService.register(userData);
      testUserIds.push(firstResult.user.id);

      // Try to register with same username
      await expect(AuthService.register({
        username: 'duplicateuser',
        email: 'unique2@example.com',
        password: 'AnotherPassword123',
        confirmPassword: 'AnotherPassword123'
      })).rejects.toThrow('Username is already taken');
    });

    it('should validate email format', async () => {
      const userData = {
        username: 'testuser5',
        email: 'invalid-email',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Invalid email format');
    });

    it('should validate password strength', async () => {
      const userData = {
        username: 'testuser6',
        email: 'test6@example.com',
        password: 'weak',
        confirmPassword: 'weak'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Password must be at least 8 characters');
    });
  });

  describe('login', () => {
    let testUser: any;

    beforeEach(async () => {
      // Create a test user for login tests
      const userData = {
        username: 'logintest',
        email: 'login@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const result = await AuthService.register(userData);
      testUser = result.user;
      testUserIds.push(testUser.id);
    });

    it('should login with valid credentials', async () => {
      const loginData = {
        email: 'login@example.com',
        password: 'TestPassword123'
      };

      const result = await AuthService.login(loginData);

      expect(result.user.id).toBe(testUser.id);
      expect(result.user.username).toBe(testUser.username);
      expect(result.user.email).toBe(testUser.email);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('should throw error for invalid email', async () => {
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'TestPassword123'
      };

      await expect(AuthService.login(loginData)).rejects.toThrow('Invalid email or password');
    });

    it('should throw error for invalid password', async () => {
      const loginData = {
        email: 'login@example.com',
        password: 'WrongPassword123'
      };

      await expect(AuthService.login(loginData)).rejects.toThrow('Invalid email or password');
    });

    it('should update last_active timestamp on login', async () => {
      const loginData = {
        email: 'login@example.com',
        password: 'TestPassword123'
      };

      const beforeLogin = new Date();
      await AuthService.login(loginData);
      const afterLogin = new Date();

      const userRecord = await runQuery(async (client) => {
        const result = await client.query('SELECT last_active FROM users WHERE id = $1', [testUser.id]);
        return result.rows[0];
      });

      const lastActive = new Date(userRecord.last_active);
      expect(lastActive.getTime()).toBeGreaterThanOrEqual(beforeLogin.getTime());
      expect(lastActive.getTime()).toBeLessThanOrEqual(afterLogin.getTime());
    });
  });

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      const userData = {
        username: 'verifytest',
        email: 'verify@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const result = await AuthService.register(userData);
      testUserIds.push(result.user.id);

      const decoded = AuthService.verifyToken(result.token);

      expect(decoded).toBeTruthy();
      expect(decoded?.userId).toBe(result.user.id);
      expect(decoded?.username).toBe(result.user.username);
      expect(decoded?.email).toBe(result.user.email);
    });

    it('should return null for invalid token', () => {
      const invalidToken = 'invalid.jwt.token';
      const decoded = AuthService.verifyToken(invalidToken);
      expect(decoded).toBeNull();
    });
  });

  describe('refreshAccessToken', () => {
    let testUser: any;
    let refreshToken: string;

    beforeEach(async () => {
      // Create a test user and generate tokens
      const userData = {
        username: 'refreshtest',
        email: 'refresh@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      const registerResult = await AuthService.register(userData);
      testUser = registerResult.user;
      refreshToken = registerResult.refreshToken!;
      testUserIds.push(testUser.id);
    });

    it('should refresh access token with valid refresh token', async () => {
      const result = await AuthService.refreshAccessToken(refreshToken);

      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('should throw error for invalid refresh token', async () => {
      const invalidToken = 'invalid.refresh.token';

      await expect(AuthService.refreshAccessToken(invalidToken)).rejects.toThrow('Invalid refresh token');
    });
  });

  describe('password validation', () => {
    it('should reject passwords that are too short', async () => {
      const userData = {
        username: 'shortpass',
        email: 'short@example.com',
        password: '123',
        confirmPassword: '123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Password must be at least 8 characters');
    });

    it('should reject passwords without uppercase letters', async () => {
      const userData = {
        username: 'noupper',
        email: 'noupper@example.com',
        password: 'lowercase123',
        confirmPassword: 'lowercase123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Password must contain at least one uppercase letter');
    });

    it('should reject passwords without lowercase letters', async () => {
      const userData = {
        username: 'nolower',
        email: 'nolower@example.com',
        password: 'UPPERCASE123',
        confirmPassword: 'UPPERCASE123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Password must contain at least one lowercase letter');
    });

    it('should reject passwords without numbers', async () => {
      const userData = {
        username: 'nonumber',
        email: 'nonumber@example.com',
        password: 'NoNumbers',
        confirmPassword: 'NoNumbers'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Password must contain at least one number');
    });
  });

  describe('username validation', () => {
    it('should reject usernames that are too short', async () => {
      const userData = {
        username: 'a',
        email: 'shortuser@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Username must be at least 3 characters long');
    });

    it('should reject usernames that are too long', async () => {
      const userData = {
        username: 'a'.repeat(51),
        email: 'longuser@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Username must be no more than 50 characters long');
    });

    it('should reject usernames with invalid characters', async () => {
      const userData = {
        username: 'user@name!',
        email: 'invaliduser@example.com',
        password: 'TestPassword123',
        confirmPassword: 'TestPassword123'
      };

      await expect(AuthService.register(userData)).rejects.toThrow('Username can only contain letters, numbers, underscores, and hyphens');
    });
  });
});
