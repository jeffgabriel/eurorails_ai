// Test Cleanup Strategy: Serial Execution Required
// Run with: npm test -- --runInBand src/server/__tests__/lobbyBotService.test.ts

import { LobbyService, CreateGameData, Game } from '../services/lobbyService';
import {
  LobbyError,
  GameNotFoundError,
  GameFullError,
  GameAlreadyStartedError,
  NotGameCreatorError,
  NotABotError
} from '../services/lobbyService';
import { BotSkillLevel, BotArchetype, BotConfig } from '../../shared/types/GameTypes';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

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
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
    if (userIds.length > 0) {
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
  });
}

describe('LobbyService Bot Management', () => {
  let testGameIds: string[] = [];
  let testUserIds: string[] = [];
  let creatorUserId: string;
  let otherUserId: string;

  const defaultBotConfig: BotConfig = {
    skillLevel: BotSkillLevel.Medium,
    archetype: BotArchetype.Opportunistic
  };

  beforeAll(async () => {
    creatorUserId = uuidv4();
    otherUserId = uuidv4();

    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [creatorUserId, 'bottest_creator', 'bottest_creator@example.com', 'hash1']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [otherUserId, 'bottest_other', 'bottest_other@example.com', 'hash2']
      );
    });
    testUserIds.push(creatorUserId, otherUserId);
  });

  afterEach(async () => {
    // Clean up bot synthetic users by pattern
    await runQuery(async (client) => {
      await client.query("DELETE FROM players WHERE is_bot = true AND game_id = ANY($1)", [testGameIds]);
      await client.query("DELETE FROM users WHERE email LIKE 'bot-%@bot.internal'");
    });
    await cleanupTestData(testGameIds, []);
    testGameIds = [];
  });

  afterAll(async () => {
    await cleanupTestData(testGameIds, testUserIds);
  });

  async function createTestGame(maxPlayers: number = 6): Promise<Game> {
    const game = await LobbyService.createGame({
      createdByUserId: creatorUserId,
      maxPlayers
    });
    testGameIds.push(game.id);
    return game;
  }

  describe('addBot', () => {
    describe('happy path', () => {
      it('should create a bot player with correct config', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        expect(bot).toBeDefined();
        expect(bot.isBot).toBe(true);
        expect(bot.botConfig).toEqual(defaultBotConfig);
        expect(bot.name).toBe('Bot 1');
      });

      it('should use custom name when provided', async () => {
        const game = await createTestGame();
        const config: BotConfig = { ...defaultBotConfig, name: 'RoboRail' };
        const bot = await LobbyService.addBot(game.id, creatorUserId, config);

        expect(bot.name).toBe('RoboRail');
      });

      it('should create a synthetic user in the users table', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        const userRow = await runQuery(async (client) => {
          const result = await client.query(
            'SELECT id, email, password_hash FROM users WHERE id = $1',
            [bot.userId]
          );
          return result.rows[0];
        });

        expect(userRow).toBeDefined();
        expect(userRow.password_hash).toBe('BOT_NO_LOGIN');
        expect(userRow.email).toMatch(/^bot-.*@bot\.internal$/);
      });

      it('should store is_bot and bot_config in the players table', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        const playerRow = await runQuery(async (client) => {
          const result = await client.query(
            'SELECT is_bot, bot_config FROM players WHERE id = $1',
            [bot.id]
          );
          return result.rows[0];
        });

        expect(playerRow.is_bot).toBe(true);
        expect(playerRow.bot_config).toEqual(defaultBotConfig);
      });

      it('should assign an available color', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        expect(bot.color).toBeDefined();
        expect(bot.color).toMatch(/^#[0-9a-f]{6}$/);

        // Bot color should differ from the creator's color
        const players = await LobbyService.getGamePlayers(game.id);
        const creatorPlayer = players.find(p => p.userId === creatorUserId);
        expect(bot.color).not.toBe(creatorPlayer?.color);
      });
    });

    describe('error paths', () => {
      it('should throw GameNotFoundError for non-existent game', async () => {
        await expect(
          LobbyService.addBot(uuidv4(), creatorUserId, defaultBotConfig)
        ).rejects.toThrow(GameNotFoundError);
      });

      it('should throw NotGameCreatorError when non-creator adds bot', async () => {
        const game = await createTestGame();
        await expect(
          LobbyService.addBot(game.id, otherUserId, defaultBotConfig)
        ).rejects.toThrow(NotGameCreatorError);
      });

      it('should throw GameAlreadyStartedError when game is not in setup', async () => {
        const game = await createTestGame();
        // Add a second player so we can start the game
        await LobbyService.joinGame(game.joinCode, { userId: otherUserId });
        await LobbyService.startGame(game.id, creatorUserId);

        await expect(
          LobbyService.addBot(game.id, creatorUserId, defaultBotConfig)
        ).rejects.toThrow(GameAlreadyStartedError);
      });

      it('should throw GameFullError when game is at max players', async () => {
        const game = await createTestGame(2); // max 2 players
        // Creator is already player 1, add bot as player 2
        await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        // Third player should fail
        await expect(
          LobbyService.addBot(game.id, creatorUserId, defaultBotConfig)
        ).rejects.toThrow(GameFullError);
      });

      it('should throw for invalid skill level', async () => {
        const game = await createTestGame();
        const badConfig = { skillLevel: 'invalid' as any, archetype: BotArchetype.Balanced };
        await expect(
          LobbyService.addBot(game.id, creatorUserId, badConfig)
        ).rejects.toThrow('Invalid skill level');
      });

      it('should throw for invalid archetype', async () => {
        const game = await createTestGame();
        const badConfig = { skillLevel: BotSkillLevel.Easy, archetype: 'invalid' as any };
        await expect(
          LobbyService.addBot(game.id, creatorUserId, badConfig)
        ).rejects.toThrow('Invalid archetype');
      });
    });
  });

  describe('removeBot', () => {
    describe('happy path', () => {
      it('should remove the bot player and synthetic user', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        await LobbyService.removeBot(game.id, creatorUserId, bot.id);

        // Verify player is gone
        const playerRow = await runQuery(async (client) => {
          const result = await client.query(
            'SELECT id FROM players WHERE id = $1',
            [bot.id]
          );
          return result.rows[0];
        });
        expect(playerRow).toBeUndefined();

        // Verify synthetic user is gone
        const userRow = await runQuery(async (client) => {
          const result = await client.query(
            'SELECT id FROM users WHERE id = $1',
            [bot.userId]
          );
          return result.rows[0];
        });
        expect(userRow).toBeUndefined();
      });

      it('should leave other players unaffected', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        const playersBefore = await LobbyService.getGamePlayers(game.id);
        expect(playersBefore).toHaveLength(2); // creator + bot

        await LobbyService.removeBot(game.id, creatorUserId, bot.id);

        const playersAfter = await LobbyService.getGamePlayers(game.id);
        expect(playersAfter).toHaveLength(1); // just creator
        expect(playersAfter[0].userId).toBe(creatorUserId);
      });
    });

    describe('error paths', () => {
      it('should throw GameNotFoundError for non-existent game', async () => {
        await expect(
          LobbyService.removeBot(uuidv4(), creatorUserId, uuidv4())
        ).rejects.toThrow(GameNotFoundError);
      });

      it('should throw NotGameCreatorError when non-creator removes bot', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);

        await expect(
          LobbyService.removeBot(game.id, otherUserId, bot.id)
        ).rejects.toThrow(NotGameCreatorError);
      });

      it('should throw GameAlreadyStartedError when game is not in setup', async () => {
        const game = await createTestGame();
        const bot = await LobbyService.addBot(game.id, creatorUserId, defaultBotConfig);
        await LobbyService.startGame(game.id, creatorUserId);

        await expect(
          LobbyService.removeBot(game.id, creatorUserId, bot.id)
        ).rejects.toThrow(GameAlreadyStartedError);
      });

      it('should throw NotABotError when trying to remove a human player', async () => {
        const game = await createTestGame();
        await LobbyService.joinGame(game.joinCode, { userId: otherUserId });
        const players = await LobbyService.getGamePlayers(game.id);
        const humanPlayer = players.find(p => p.userId === otherUserId)!;

        await expect(
          LobbyService.removeBot(game.id, creatorUserId, humanPlayer.id)
        ).rejects.toThrow(NotABotError);
      });

      it('should throw when player does not exist in game', async () => {
        const game = await createTestGame();
        await expect(
          LobbyService.removeBot(game.id, creatorUserId, uuidv4())
        ).rejects.toThrow('Player not found in this game');
      });
    });
  });
});
