// HTTP API Integration tests for Lobby endpoints
// Run with: npm test -- --runInBand src/server/__tests__/lobbyApiIntegration.test.ts

import request from 'supertest';
import app from '../app';
import { db } from '../db';
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
    // Delete in dependency order to avoid constraint errors
    // Players must be deleted before games due to foreign key constraints
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
    exp: Math.floor(Date.now() / 1000) + (15 * 60), // 15 minutes
  };
  return jwt.sign(payload, JWT_SECRET);
}

describe('Lobby API HTTP Integration Tests', () => {
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;
  let testUserToken: string;
  let testUserToken2: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = uuidv4();
    testUserId2 = uuidv4();
    
    // Create test users in the database
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId, 'testuser1', 'test1@example.com', 'hashedpassword1']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId2, 'testuser2', 'test2@example.com', 'hashedpassword2']
      );
    });
    
    // Generate JWT tokens for test users
    testUserToken = generateTestToken(testUserId, 'testuser1', 'test1@example.com');
    testUserToken2 = generateTestToken(testUserId2, 'testuser2', 'test2@example.com');
  });

  afterEach(async () => {
    // Clean up test data after each test
    await cleanupTestData(testGameIds, testPlayerIds);
    testGameIds = [];
    testPlayerIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestData(testGameIds, testPlayerIds);
    
    // Clean up test users
    await runQuery(async (client) => {
      await client.query('DELETE FROM users WHERE id = $1 OR id = $2', [testUserId, testUserId2]);
    });
  });

  describe('POST /api/lobby/games - Create Game', () => {
    it('should create a new game successfully', async () => {
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.id).toBeDefined();
      expect(response.body.data.joinCode).toHaveLength(8);
      expect(response.body.data.status).toBe('setup');
      expect(response.body.data.createdBy).toBeDefined();
      expect(response.body.data.createdBy).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(response.body.data.maxPlayers).toBe(4);
      expect(response.body.data.isPublic).toBe(true);

      testGameIds.push(response.body.data.id);
    });

    it('should create a private game successfully', async () => {
      const gameData = {
        isPublic: false,
        maxPlayers: 2,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.isPublic).toBe(false);
      expect(response.body.data.maxPlayers).toBe(2);

      testGameIds.push(response.body.data.id);
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/lobby/games')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should validate maxPlayers range', async () => {
      const gameData = {
        isPublic: true,
        maxPlayers: 1, // Invalid: minimum is 2
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/lobby/games/join - Join Game', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);
    });

    it('should join a game successfully', async () => {
      const joinData = {
        joinCode: testGame.joinCode
      };

      const response = await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testGame.id);
      expect(response.body.data.joinCode).toBe(testGame.joinCode);

      testPlayerIds.push(testUserId2);
    });

    it('should handle invalid join code', async () => {
      const joinData = {
        joinCode: 'INVALID'
      };

      const response = await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should handle non-existent game', async () => {
      const joinData = {
        joinCode: 'ABCD1234'
      };

      const response = await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(400);

      expect(response.body.error).toBe('INVALID_JOIN_CODE');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });
    
    it('should require authentication', async () => {
      const joinData = {
        joinCode: testGame.joinCode
      };

      const response = await request(app)
        .post('/api/lobby/games/join')
        .send(joinData)
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /api/lobby/games/:id - Get Game', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);
    });

    it('should get game information successfully', async () => {
      const response = await request(app)
        .get(`/api/lobby/games/${testGame.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testGame.id);
      expect(response.body.data.joinCode).toBe(testGame.joinCode);
      expect(response.body.data.status).toBe('setup');
    });

    it('should handle non-existent game', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .get(`/api/lobby/games/${fakeId}`)
        .expect(404);

      expect(response.body.error).toBe('GAME_NOT_FOUND');
    });

    it('should validate UUID format', async () => {
      const response = await request(app)
        .get('/api/lobby/games/invalid-uuid')
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/lobby/games/:id/players - Get Game Players', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game and add players
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);

      // Add a player
      const joinData = {
        joinCode: testGame.joinCode
      };

      await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(200);

      testPlayerIds.push(testUserId2);
    });

    it('should get game players successfully', async () => {
      const response = await request(app)
        .get(`/api/lobby/games/${testGame.id}/players`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.find((p: any) => p.userId === testUserId)).toBeDefined();
      expect(response.body.data.find((p: any) => p.userId === testUserId2)).toBeDefined();
    });

    it('should handle non-existent game', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .get(`/api/lobby/games/${fakeId}/players`)
        .expect(200);

      // Non-existent games return empty array of players
      expect(response.body.data).toEqual([]);
    });
  });

  describe('POST /api/lobby/games/:id/start - Start Game', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game and add players
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);

      // Add a player
      const joinData = {
        joinCode: testGame.joinCode
      };

      await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(200);

      testPlayerIds.push(testUserId2);
    });

    it('should start game successfully', async () => {
      const startData = {
        creatorUserId: testUserId
      };

      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/start`)
        .send(startData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Game started successfully');

      // Verify game status in database
      const gameResponse = await request(app)
        .get(`/api/lobby/games/${testGame.id}`)
        .expect(200);

      expect(gameResponse.body.data.status).toBe('active');
    });

    it('should handle insufficient players', async () => {
      // Create a game with only 1 player (creator)
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      const singlePlayerGame = response.body.data;
      testGameIds.push(singlePlayerGame.id);

      const startData = {
        creatorUserId: testUserId
      };

      const startResponse = await request(app)
        .post(`/api/lobby/games/${singlePlayerGame.id}/start`)
        .send(startData)
        .expect(400);

      expect(startResponse.body.error).toBe('INSUFFICIENT_PLAYERS');
    });

    it('should handle non-creator trying to start', async () => {
      const startData = {
        creatorUserId: testUserId2 // Not the creator
      };

      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/start`)
        .send(startData)
        .expect(403);

      expect(response.body.error).toBe('NOT_GAME_CREATOR');
    });
  });

  describe('POST /api/lobby/games/:id/leave - Leave Game', () => {
    let testGame: any;

    beforeEach(async () => {
      // Create a test game and add players
      const gameData = {
        isPublic: true,
        maxPlayers: 4,
        createdByUserId: testUserId
      };

      const response = await request(app)
        .post('/api/lobby/games')
        .send(gameData)
        .expect(201);

      testGame = response.body.data;
      testGameIds.push(testGame.id);

      // Add a player
      const joinData = {
        joinCode: testGame.joinCode
      };

      await request(app)
        .post('/api/lobby/games/join')
        .set('Authorization', `Bearer ${testUserToken2}`)
        .send(joinData)
        .expect(200);

      testPlayerIds.push(testUserId2);
    });

    it('should leave game successfully', async () => {
      const leaveData = {
        userId: testUserId2
      };

      const response = await request(app)
        .post(`/api/lobby/games/${testGame.id}/leave`)
        .send(leaveData)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify player was removed
      const playersResponse = await request(app)
        .get(`/api/lobby/games/${testGame.id}/players`)
        .expect(200);

      expect(playersResponse.body.data).toHaveLength(1);
      expect(playersResponse.body.data.find((p: any) => p.userId === testUserId2)).toBeUndefined();
    });

    it('should handle non-existent game', async () => {
      const fakeId = uuidv4();
      const leaveData = {
        userId: testUserId2
      };

      const response = await request(app)
        .post(`/api/lobby/games/${fakeId}/leave`)
        .send(leaveData)
        .expect(404);

      expect(response.body.error).toBe('PLAYER_NOT_IN_GAME');
    });
  });

  describe('POST /api/lobby/players/presence - Update Presence', () => {
    it('should return 404 when updating presence for non-existent player', async () => {
      const presenceData = {
        userId: uuidv4(),
        isOnline: true
      };

      const response = await request(app)
        .post('/api/lobby/players/presence')
        .send(presenceData)
        .expect(404);

      expect(response.body.error).toBe('PLAYER_NOT_FOUND');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/lobby/players/presence')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/lobby/health - Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/lobby/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.service).toBe('lobby-api');
      expect(response.body.message).toBe('Lobby service is healthy');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/api/lobby/unknown')
        .expect(404);

      expect(response.body.error).toBe('NOT_FOUND');
    });

    it('should handle malformed JSON', async () => {
      await request(app)
        .post('/api/lobby/games')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);

      // JSON parsing error - no specific error format expected
    });
  });

  describe('Request ID Tracking', () => {
    it('should include request ID in response headers', async () => {
      const response = await request(app)
        .get('/api/lobby/health')
        .expect(200);

      expect(response.headers['x-request-id']).toBeDefined();
      expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    });
  });
});
