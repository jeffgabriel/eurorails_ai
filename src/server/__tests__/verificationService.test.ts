/**
 * VerificationService Unit Tests
 * Tests for email verification token generation, sending, and verification
 */

import { VerificationService } from '../services/verificationService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

// Mock EmailService
jest.mock('../services/emailService', () => ({
  getEmailService: jest.fn(() => ({
    sendEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

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

async function cleanupTestTokens(userIds: string[]) {
  if (userIds.length > 0) {
    await runQuery(async (client) => {
      await client.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [userIds]);
    });
  }
}

describe('VerificationService', () => {
  let testUserIds: string[] = [];

  beforeEach(async () => {
    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test data
    await cleanupTestTokens(testUserIds);
    await cleanupTestUsers(testUserIds);
    testUserIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestTokens(testUserIds);
    await cleanupTestUsers(testUserIds);
  });

  describe('generateVerificationToken', () => {
    it('should generate a verification token for a user', async () => {
      // Create test user
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser', 'test@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId);

      const token = await VerificationService.generateVerificationToken(userId);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);

      // Verify token was stored in database
      const tokenRecord = await runQuery(async (client) => {
        const result = await client.query(
          'SELECT * FROM email_verification_tokens WHERE user_id = $1',
          [userId]
        );
        return result.rows[0];
      });

      expect(tokenRecord).toBeDefined();
      expect(tokenRecord.user_id).toBe(userId);
      expect(tokenRecord.expires_at).toBeDefined();
    });

    it('should replace existing token for user', async () => {
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser2', 'test2@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId);

      const firstToken = await VerificationService.generateVerificationToken(userId);
      const secondToken = await VerificationService.generateVerificationToken(userId);

      expect(firstToken).not.toBe(secondToken);

      // Verify only one token exists
      const tokens = await runQuery(async (client) => {
        const result = await client.query(
          'SELECT * FROM email_verification_tokens WHERE user_id = $1',
          [userId]
        );
        return result.rows;
      });

      expect(tokens.length).toBe(1);
      expect(tokens[0].token).toBeDefined();
    });
  });

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser3', 'test3@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId);

      const token = await VerificationService.generateVerificationToken(userId);
      const result = await VerificationService.verifyToken(token);

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userId);

      // Verify user is now email_verified
      const user = await runQuery(async (client) => {
        const dbResult = await client.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
        return dbResult.rows[0];
      });

      expect(user.email_verified).toBe(true);
    });

    it('should reject invalid token', async () => {
      const result = await VerificationService.verifyToken('invalid-token-12345');

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TOKEN');
    });

    it('should reject expired token', async () => {
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser4', 'test4@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId);

      const token = await VerificationService.generateVerificationToken(userId);

      // Manually expire the token
      await runQuery(async (client) => {
        await client.query(
          'UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE user_id = $1',
          [userId]
        );
      });

      const result = await VerificationService.verifyToken(token);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TOKEN_EXPIRED');
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('should delete expired tokens', async () => {
      const userId1 = uuidv4();
      const userId2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
          [userId1, 'testuser5', 'test5@example.com', 'hash', false, userId2, 'testuser6', 'test6@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId1, userId2);

      // Create one expired and one valid token
      await VerificationService.generateVerificationToken(userId1);
      await VerificationService.generateVerificationToken(userId2);

      // Expire first token
      await runQuery(async (client) => {
        await client.query(
          'UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE user_id = $1',
          [userId1]
        );
      });

      const deletedCount = await VerificationService.cleanupExpiredTokens();

      expect(deletedCount).toBe(1);

      // Verify only valid token remains
      const remainingTokens = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM email_verification_tokens WHERE user_id = ANY($1)', [
          [userId1, userId2],
        ]);
        return result.rows;
      });

      expect(remainingTokens.length).toBe(1);
      expect(remainingTokens[0].user_id).toBe(userId2);
    });
  });

  describe('isEmailVerified', () => {
    it('should return true for verified user', async () => {
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser7', 'test7@example.com', 'hash', true]
        );
      });
      testUserIds.push(userId);

      const isVerified = await VerificationService.isEmailVerified(userId);

      expect(isVerified).toBe(true);
    });

    it('should return false for unverified user', async () => {
      const userId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'testuser8', 'test8@example.com', 'hash', false]
        );
      });
      testUserIds.push(userId);

      const isVerified = await VerificationService.isEmailVerified(userId);

      expect(isVerified).toBe(false);
    });

    it('should return false for non-existent user', async () => {
      const isVerified = await VerificationService.isEmailVerified(uuidv4());

      expect(isVerified).toBe(false);
    });
  });
});
