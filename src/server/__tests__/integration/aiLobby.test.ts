/**
 * Integration tests for AI Player Lobby API endpoints
 * Tests POST /api/lobby/games/:gameId/ai-player and DELETE /api/lobby/games/:gameId/ai-player/:playerId
 */

import request from 'supertest';
import app from '../../app';
import { db } from '../../db';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

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
async function cleanupTestData(gameIds: string[], playerIds: string[]) {
  await runQuery(async (client) => {
    if (gameIds.length > 0) {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
    }
    if (playerIds.length > 0) {
      await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
  });
}

// Helper function to generate JWT token for testing
function generateTestToken(userId: string, username: string, email: string): string {
  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  const payload = {
    userId,
    email,
    username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (15 * 60),
  };
  return jwt.sign(payload, JWT_SECRET);
}

describe('AI Player Lobby API Integration Tests', () => {
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserToken: string;

  beforeAll(async () => {
    testUserId = uuidv4();

    // Create test user
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId, 'aitest_user', 'aitest@example.com', 'hashedpassword']
      );
    });

    testUserToken = generateTestToken(testUserId, 'aitest_user', 'aitest@example.com');
  });

  afterEach(async () => {
    await cleanupTestData(testGameIds, testPlayerIds);
    testGameIds = [];
    testPlayerIds = [];
  });

  afterAll(async () => {
    await cleanupTestData(testGameIds, testPlayerIds);
    await runQuery(async (client) => {
      await client.query('DELETE FROM users WHERE id = $1', [testUserId]);
    });
  });

  describe('POST /api/lobby/games/:gameId/ai-player - Add AI Player', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game
      const response = await request(app)
        .post('/api/lobby/games')
        .send({
          isPublic: true,
          maxPlayers: 6,
          createdByUserId: testUserId
        })
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);
    });

    it('should add an AI player with easy difficulty and optimizer personality', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.isAI).toBe(true);
      expect(response.body.data.aiDifficulty).toBe('easy');
      expect(response.body.data.aiPersonality).toBe('optimizer');
      expect(response.body.data.id).toBeDefined();

      testPlayerIds.push(response.body.data.id);
    });

    it('should add an AI player with medium difficulty and network_builder personality', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'medium',
          personality: 'network_builder'
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.aiDifficulty).toBe('medium');
      expect(response.body.data.aiPersonality).toBe('network_builder');

      testPlayerIds.push(response.body.data.id);
    });

    it('should add an AI player with hard difficulty and blocker personality', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'hard',
          personality: 'blocker'
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.aiDifficulty).toBe('hard');
      expect(response.body.data.aiPersonality).toBe('blocker');

      testPlayerIds.push(response.body.data.id);
    });

    it('should support all personality types', async () => {
      const personalities = ['optimizer', 'network_builder', 'opportunist', 'blocker', 'steady_hand', 'chaos_agent'];

      for (const personality of personalities.slice(0, 5)) { // Leave room for human player (max 6)
        const response = await request(app)
          .post(`/api/lobby/games/${testGame.id}/ai-player`)
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            difficulty: 'medium',
            personality
          })
          .expect(201);

        expect(response.body.data.aiPersonality).toBe(personality);
        testPlayerIds.push(response.body.data.id);
      }
    });

    it('should generate a unique AI name for each AI player', async () => {
      const aiNames: string[] = [];

      // Add 3 AI players
      for (let i = 0; i < 3; i++) {
        const response = await request(app)
          .post(`/api/lobby/games/${testGame.id}/ai-player`)
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            difficulty: 'easy',
            personality: 'optimizer'
          })
          .expect(201);

        aiNames.push(response.body.data.name);
        testPlayerIds.push(response.body.data.id);
      }

      // All names should be unique
      const uniqueNames = new Set(aiNames);
      expect(uniqueNames.size).toBe(aiNames.length);
    });

    it('should enforce 6 player maximum (humans + AI combined)', async () => {
      // Game already has 1 human player (creator)
      // Add 5 AI players to reach the limit
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .post(`/api/lobby/games/${testGame.id}/ai-player`)
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            difficulty: 'easy',
            personality: 'optimizer'
          })
          .expect(201);
        testPlayerIds.push(response.body.data.id);
      }

      // 7th player should be rejected
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(400);

      expect(response.body.error).toBe('GAME_FULL');
    });

    it('should reject invalid difficulty value', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'extreme', // Invalid
          personality: 'optimizer'
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid personality value', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'invalid_personality' // Invalid
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should only allow game creator to add AI players', async () => {
      // Create another user
      const otherUserId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
          [otherUserId, 'other_user', 'other@example.com', 'hashedpassword']
        );
      });
      const otherUserToken = generateTestToken(otherUserId, 'other_user', 'other@example.com');

      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(403);

      expect(response.body.error).toBe('NOT_GAME_CREATOR');

      // Clean up
      await runQuery(async (client) => {
        await client.query('DELETE FROM users WHERE id = $1', [otherUserId]);
      });
    });

    it('should not allow adding AI players to games already in progress', async () => {
      // Start the game first - need at least 2 players
      await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(201);

      await request(app)
        .post(`/api/lobby/games/${testGame.id}/start`)
        .send({ creatorUserId: testUserId })
        .expect(200);

      // Now try to add another AI player
      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(400);

      expect(response.body.error).toBe('GAME_ALREADY_STARTED');
    });

    it('should handle non-existent game', async () => {
      const fakeGameId = uuidv4();
      const response = await request(app)
        .post(`/api/lobby/games/${fakeGameId}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(404);

      expect(response.body.error).toBe('GAME_NOT_FOUND');
    });
  });

  describe('DELETE /api/lobby/games/:gameId/ai-player/:playerId - Remove AI Player', () => {
    let testGame: any;
    let aiPlayerId: string;

    beforeEach(async () => {
      // Create a test game
      const gameResponse = await request(app)
        .post('/api/lobby/games')
        .send({
          isPublic: true,
          maxPlayers: 6,
          createdByUserId: testUserId
        })
        .expect(201);

      testGame = gameResponse.body.data;
      testGameIds.push(testGame.id);

      // Add an AI player
      const aiResponse = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'easy',
          personality: 'optimizer'
        })
        .expect(201);

      aiPlayerId = aiResponse.body.data.id;
      testPlayerIds.push(aiPlayerId);
    });

    it('should remove an AI player successfully', async () => {
      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${aiPlayerId}`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify player is removed
      const playersResponse = await request(app)
        .get(`/api/lobby/games/${testGame.id}/players`)
        .expect(200);

      const aiPlayers = playersResponse.body.data.filter((p: any) => p.id === aiPlayerId);
      expect(aiPlayers).toHaveLength(0);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${aiPlayerId}`)
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should only allow game creator to remove AI players', async () => {
      // Create another user
      const otherUserId = uuidv4();
      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
          [otherUserId, 'other_user2', 'other2@example.com', 'hashedpassword']
        );
      });
      const otherUserToken = generateTestToken(otherUserId, 'other_user2', 'other2@example.com');

      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${aiPlayerId}`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(403);

      expect(response.body.error).toBe('NOT_GAME_CREATOR');

      // Clean up
      await runQuery(async (client) => {
        await client.query('DELETE FROM users WHERE id = $1', [otherUserId]);
      });
    });

    it('should not allow removing human players via this endpoint', async () => {
      // Try to remove the human creator player
      const playersResponse = await request(app)
        .get(`/api/lobby/games/${testGame.id}/players`)
        .expect(200);

      const humanPlayer = playersResponse.body.data.find((p: any) => p.userId === testUserId);

      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${humanPlayer.id}`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(400);

      expect(response.body.error).toBe('NOT_AI_PLAYER');
    });

    it('should handle non-existent AI player', async () => {
      const fakePlayerId = uuidv4();
      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${fakePlayerId}`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(404);

      expect(response.body.error).toBe('PLAYER_NOT_FOUND');
    });

    it('should not allow removing AI players from games in progress', async () => {
      // Start the game
      await request(app)
        .post(`/api/lobby/games/${testGame.id}/start`)
        .send({ creatorUserId: testUserId })
        .expect(200);

      // Try to remove AI player
      const response = await request(app)
        .delete(`/api/lobby/games/${testGame.id}/ai-player/${aiPlayerId}`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(400);

      expect(response.body.error).toBe('GAME_ALREADY_STARTED');
    });
  });

  describe('AI Player Data Persistence', () => {
    it('should persist AI player data correctly in the database', async () => {
      // Create a game
      const gameResponse = await request(app)
        .post('/api/lobby/games')
        .send({
          isPublic: true,
          maxPlayers: 6,
          createdByUserId: testUserId
        })
        .expect(201);

      const testGame = gameResponse.body.data;
      testGameIds.push(testGame.id);

      // Add an AI player
      const aiResponse = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'hard',
          personality: 'chaos_agent'
        })
        .expect(201);

      testPlayerIds.push(aiResponse.body.data.id);

      // Verify directly in database
      const dbResult = await runQuery(async (client) => {
        return await client.query(
          `SELECT id, is_ai, ai_difficulty, ai_personality, name, color
           FROM players WHERE id = $1`,
          [aiResponse.body.data.id]
        );
      });

      expect(dbResult.rows).toHaveLength(1);
      const dbPlayer = dbResult.rows[0];
      expect(dbPlayer.is_ai).toBe(true);
      expect(dbPlayer.ai_difficulty).toBe('hard');
      expect(dbPlayer.ai_personality).toBe('chaos_agent');
      expect(dbPlayer.name).toBeDefined();
      expect(dbPlayer.color).toBeDefined();
    });

    it('should include AI fields in getGamePlayers response', async () => {
      // Create a game
      const gameResponse = await request(app)
        .post('/api/lobby/games')
        .send({
          isPublic: true,
          maxPlayers: 6,
          createdByUserId: testUserId
        })
        .expect(201);

      const testGame = gameResponse.body.data;
      testGameIds.push(testGame.id);

      // Add an AI player
      const aiResponse = await request(app)
        .post(`/api/lobby/games/${testGame.id}/ai-player`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          difficulty: 'medium',
          personality: 'opportunist'
        })
        .expect(201);

      testPlayerIds.push(aiResponse.body.data.id);

      // Get players
      const playersResponse = await request(app)
        .get(`/api/lobby/games/${testGame.id}/players`)
        .expect(200);

      const aiPlayer = playersResponse.body.data.find((p: any) => p.isAI === true);
      expect(aiPlayer).toBeDefined();
      expect(aiPlayer.aiDifficulty).toBe('medium');
      expect(aiPlayer.aiPersonality).toBe('opportunist');
    });
  });
});
