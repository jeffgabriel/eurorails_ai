// Test Cleanup Strategy: Serial Execution Required
// Run with: npm test -- --runInBand src/server/__tests__/lobbyBotRoutes.test.ts

import request from 'supertest';
import express from 'express';
import lobbyRoutes from '../routes/lobbyRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { AuthService } from '../services/authService';
import { LobbyService } from '../services/lobbyService';
import { BotSkillLevel, BotArchetype } from '../../shared/types/GameTypes';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

// Mock AuthService to bypass JWT verification
jest.mock('../services/authService');
const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

// Build test app with lobby routes and error handler
const app = express();
app.use(express.json());
app.use('/api/lobby', lobbyRoutes);
app.use(errorHandler);

async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

async function cleanupTestData(gameIds: string[], userIds: string[]) {
  await runQuery(async (client) => {
    if (gameIds.length > 0) {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
    // Clean up bot synthetic users
    await client.query("DELETE FROM users WHERE email LIKE 'bot-%@bot.internal'");
    if (userIds.length > 0) {
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
  });
}

function mockAuthForUser(userId: string, username: string = 'testuser') {
  mockAuthService.verifyToken.mockReturnValue({
    userId,
    username,
    email: `${username}@example.com`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900
  });
  mockAuthService.findUserById.mockResolvedValue({
    id: userId,
    username,
    email: `${username}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    lastActive: new Date(),
    updatedAt: new Date()
  });
}

describe('LobbyBotRoutes', () => {
  let testGameIds: string[] = [];
  let testUserIds: string[] = [];
  let creatorUserId: string;
  let otherUserId: string;

  beforeAll(async () => {
    creatorUserId = uuidv4();
    otherUserId = uuidv4();

    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [creatorUserId, 'botroute_creator', 'botroute_creator@example.com', 'hash1']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [otherUserId, 'botroute_other', 'botroute_other@example.com', 'hash2']
      );
    });
    testUserIds.push(creatorUserId, otherUserId);
  });

  afterEach(async () => {
    await cleanupTestData(testGameIds, []);
    testGameIds = [];
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cleanupTestData(testGameIds, testUserIds);
  });

  async function createTestGame(maxPlayers: number = 6): Promise<{ id: string; joinCode: string }> {
    const game = await LobbyService.createGame({
      createdByUserId: creatorUserId,
      maxPlayers
    });
    testGameIds.push(game.id);
    return game;
  }

  describe('POST /api/lobby/games/:id/bots', () => {
    describe('happy path', () => {
      it('should add a bot and return 201', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data).toBeDefined();
        expect(response.body.data.isBot).toBe(true);
        expect(response.body.data.botConfig).toEqual({
          skillLevel: 'medium',
          archetype: 'opportunistic'
        });
      });

      it('should accept a custom bot name', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'easy', archetype: 'balanced', name: 'RoboRail' })
          .expect(201);

        expect(response.body.data.name).toBe('RoboRail');
        expect(response.body.data.botConfig.name).toBe('RoboRail');
      });
    });

    describe('authentication', () => {
      it('should return 401 without auth token', async () => {
        const game = await createTestGame();

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(401);

        expect(response.body.error).toBe('UNAUTHORIZED');
      });

      it('should return 401 with invalid token', async () => {
        const game = await createTestGame();
        mockAuthService.verifyToken.mockReturnValue(null);

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer invalid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(401);

        expect(response.body.error).toBe('UNAUTHORIZED');
      });
    });

    describe('validation errors', () => {
      it('should return 400 for invalid gameId UUID', async () => {
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post('/api/lobby/games/not-a-uuid/bots')
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('gameId');
      });

      it('should return 400 for missing skillLevel', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ archetype: 'balanced' })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('skillLevel');
      });

      it('should return 400 for missing archetype', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium' })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('archetype');
      });

      it('should return 400 for invalid skillLevel value', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'godlike', archetype: 'balanced' })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('skill level');
      });

      it('should return 400 for invalid archetype value', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'chaotic' })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('archetype');
      });

      it('should return 400 for name exceeding 30 characters', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'balanced', name: 'A'.repeat(31) })
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('name');
      });
    });

    describe('service errors', () => {
      it('should return 403 when non-creator adds bot', async () => {
        const game = await createTestGame();
        mockAuthForUser(otherUserId, 'botroute_other');

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(403);

        expect(response.body.error).toBe('NOT_GAME_CREATOR');
      });

      it('should return 404 for non-existent game', async () => {
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .post(`/api/lobby/games/${uuidv4()}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(404);

        expect(response.body.error).toBe('GAME_NOT_FOUND');
      });

      it('should return 400 when game is full', async () => {
        const game = await createTestGame(2); // max 2 players
        mockAuthForUser(creatorUserId, 'botroute_creator');

        // Add one bot (creator is player 1, bot is player 2 = full)
        await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'easy', archetype: 'balanced' })
          .expect(201);

        // Second bot should fail
        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(400);

        expect(response.body.error).toBe('GAME_FULL');
      });

      it('should return 400 when game is not in setup status', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        // Add a bot so we have 2 players, then start the game
        await LobbyService.addBot(game.id, creatorUserId, {
          skillLevel: BotSkillLevel.Easy,
          archetype: BotArchetype.Balanced
        });
        await LobbyService.startGame(game.id, creatorUserId);

        const response = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(400);

        expect(response.body.error).toBe('GAME_ALREADY_STARTED');
      });
    });
  });

  describe('DELETE /api/lobby/games/:id/bots/:playerId', () => {
    describe('happy path', () => {
      it('should remove a bot and return 200', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        // Add a bot first
        const addResponse = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(201);

        const botPlayerId = addResponse.body.data.id;

        // Remove the bot
        const response = await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${botPlayerId}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('Bot removed successfully');
      });

      it('should remove the bot from the game players list', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        // Add a bot
        const addResponse = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'hard', archetype: 'aggressive' })
          .expect(201);

        const botPlayerId = addResponse.body.data.id;

        // Verify 2 players
        let players = await LobbyService.getGamePlayers(game.id);
        expect(players).toHaveLength(2);

        // Remove the bot
        await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${botPlayerId}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(200);

        // Verify 1 player remaining
        players = await LobbyService.getGamePlayers(game.id);
        expect(players).toHaveLength(1);
        expect(players[0].userId).toBe(creatorUserId);
      });
    });

    describe('authentication', () => {
      it('should return 401 without auth token', async () => {
        const response = await request(app)
          .delete(`/api/lobby/games/${uuidv4()}/bots/${uuidv4()}`)
          .expect(401);

        expect(response.body.error).toBe('UNAUTHORIZED');
      });
    });

    describe('validation errors', () => {
      it('should return 400 for invalid gameId UUID', async () => {
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/not-a-uuid/bots/${uuidv4()}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('gameId');
      });

      it('should return 400 for invalid playerId UUID', async () => {
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/${uuidv4()}/bots/not-a-uuid`)
          .set('Authorization', 'Bearer valid.token')
          .expect(400);

        expect(response.body.error).toBe('VALIDATION_ERROR');
        expect(response.body.message).toContain('playerId');
      });
    });

    describe('service errors', () => {
      it('should return 403 when non-creator removes bot', async () => {
        const game = await createTestGame();

        // Add a bot as creator
        mockAuthForUser(creatorUserId, 'botroute_creator');
        const addResponse = await request(app)
          .post(`/api/lobby/games/${game.id}/bots`)
          .set('Authorization', 'Bearer valid.token')
          .send({ skillLevel: 'medium', archetype: 'opportunistic' })
          .expect(201);

        const botPlayerId = addResponse.body.data.id;

        // Try to remove as non-creator
        mockAuthForUser(otherUserId, 'botroute_other');
        const response = await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${botPlayerId}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(403);

        expect(response.body.error).toBe('NOT_GAME_CREATOR');
      });

      it('should return 404 for non-existent game', async () => {
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/${uuidv4()}/bots/${uuidv4()}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(404);

        expect(response.body.error).toBe('GAME_NOT_FOUND');
      });

      it('should return 400 when trying to remove a human player', async () => {
        const game = await createTestGame();

        // Join the other user to the game
        await LobbyService.joinGame(game.joinCode, { userId: otherUserId });
        const players = await LobbyService.getGamePlayers(game.id);
        const humanPlayer = players.find(p => p.userId === otherUserId)!;

        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${humanPlayer.id}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(400);

        expect(response.body.error).toBe('NOT_A_BOT');
      });

      it('should return 400 when game is not in setup status', async () => {
        const game = await createTestGame();

        // Add a bot, then start the game
        const bot = await LobbyService.addBot(game.id, creatorUserId, {
          skillLevel: BotSkillLevel.Medium,
          archetype: BotArchetype.Opportunistic
        });
        await LobbyService.startGame(game.id, creatorUserId);

        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${bot.id}`)
          .set('Authorization', 'Bearer valid.token')
          .expect(400);

        expect(response.body.error).toBe('GAME_ALREADY_STARTED');
      });

      it('should return error when player does not exist in game', async () => {
        const game = await createTestGame();
        mockAuthForUser(creatorUserId, 'botroute_creator');

        const response = await request(app)
          .delete(`/api/lobby/games/${game.id}/bots/${uuidv4()}`)
          .set('Authorization', 'Bearer valid.token');

        // LobbyService throws a generic Error for "Player not found",
        // which errorHandler maps to 500
        expect(response.status).toBeGreaterThanOrEqual(400);
      });
    });
  });
});
