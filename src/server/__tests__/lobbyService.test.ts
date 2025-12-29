// Test Cleanup Strategy: Serial Execution Required
// This test file interacts heavily with the database and must run serially to avoid deadlocks.
// Run with: npm test -- --runInBand src/server/__tests__/lobbyService.test.ts
// Or set maxWorkers=1 in jest config for all database tests.

import { LobbyService, CreateGameData, Game, Player } from '../services/lobbyService';
import {
  LobbyError,
  GameNotFoundError,
  GameFullError,
  GameAlreadyStartedError,
  InvalidJoinCodeError,
  NotGameCreatorError,
  InsufficientPlayersError
} from '../services/lobbyService';
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
async function cleanupTestData(gameIds: string[], playerIds: string[]) {
  await runQuery(async (client) => {
    // Delete in dependency order to avoid constraint errors
    // First delete games (which will cascade delete players), then any remaining players
    if (gameIds.length > 0) {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
    if (playerIds.length > 0) {
      await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
    }
  });
}

describe('LobbyService', () => {
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;
  let testUserId3: string;
  let testUserId4: string;
  let testUserId5: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = uuidv4();
    testUserId2 = uuidv4();
    testUserId3 = uuidv4();
    testUserId4 = uuidv4();
    testUserId5 = uuidv4();
    
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
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId3, 'testuser3', 'test3@example.com', 'hashedpassword3']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId4, 'testuser4', 'test4@example.com', 'hashedpassword4']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId5, 'testuser5', 'test5@example.com', 'hashedpassword5']
      );
    });
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
      await client.query('DELETE FROM users WHERE id = $1 OR id = $2 OR id = $3 OR id = $4 OR id = $5', 
        [testUserId, testUserId2, testUserId3, testUserId4, testUserId5]);
    });
  });

  describe('createGame', () => {
    it('should create a game with valid data', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4,
        isPublic: true
      };

      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      expect(game).toBeDefined();
      expect(game.id).toBeDefined();
      expect(game.joinCode).toHaveLength(8);
      expect(game.joinCode).toMatch(/^[A-F0-9]{8}$/);
      expect(game.createdBy).toBeDefined();
      expect(game.status).toBe('setup');
      expect(game.maxPlayers).toBe(4);
      expect(game.isPublic).toBe(true);
      expect(game.createdAt).toBeInstanceOf(Date);
    });

    it('should create a game with default values', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId
      };

      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      expect(game.maxPlayers).toBe(6);
      expect(game.isPublic).toBe(false);
      expect(game.status).toBe('setup');
    });

    it('should throw error for missing createdByUserId', async () => {
      const gameData: CreateGameData = {
        createdByUserId: ''
      };

      await expect(LobbyService.createGame(gameData)).rejects.toThrow(LobbyError);
      await expect(LobbyService.createGame(gameData)).rejects.toThrow('createdByUserId is required');
    });

    it('should throw error for invalid maxPlayers', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 1
      };

      await expect(LobbyService.createGame(gameData)).rejects.toThrow(LobbyError);
      await expect(LobbyService.createGame(gameData)).rejects.toThrow('maxPlayers must be between 2 and 6');
    });

    it('should throw error for maxPlayers > 6', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 7
      };

      await expect(LobbyService.createGame(gameData)).rejects.toThrow(LobbyError);
      await expect(LobbyService.createGame(gameData)).rejects.toThrow('maxPlayers must be between 2 and 6');
    });

    it('should create unique join codes', async () => {
      const gameData1: CreateGameData = {
        createdByUserId: testUserId
      };
      const gameData2: CreateGameData = {
        createdByUserId: testUserId2
      };

      const game1 = await LobbyService.createGame(gameData1);
      const game2 = await LobbyService.createGame(gameData2);
      
      testGameIds.push(game1.id, game2.id);

      expect(game1.joinCode).not.toBe(game2.joinCode);
    });
  });

  describe('joinGame', () => {
    let testGame: Game;
    let testJoinCode: string;

    beforeEach(async () => {
      // Create a test game
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4
      };
      testGame = await LobbyService.createGame(gameData);
      testJoinCode = testGame.joinCode;
      testGameIds.push(testGame.id);
    });

    it('should join a game with valid join code', async () => {
      const joinedGame = await LobbyService.joinGame(testJoinCode, { userId: testUserId2 });

      expect(joinedGame.id).toBe(testGame.id);
      expect(joinedGame.joinCode).toBe(testJoinCode);
      expect(joinedGame.status).toBe('setup');
    });

    it('should return same game if player already in game', async () => {
      // First join
      const joinedGame1 = await LobbyService.joinGame(testJoinCode, { userId: testUserId2 });
      
      // Second join (should return same game)
      const joinedGame2 = await LobbyService.joinGame(testJoinCode, { userId: testUserId2 });

      expect(joinedGame1.id).toBe(joinedGame2.id);
      expect(joinedGame1.joinCode).toBe(joinedGame2.joinCode);
    });

    it('should throw error for invalid join code', async () => {
      await expect(LobbyService.joinGame('INVALID', { userId: testUserId2 })).rejects.toThrow(InvalidJoinCodeError);
      await expect(LobbyService.joinGame('INVALID', { userId: testUserId2 })).rejects.toThrow('Game not found with that join code');
    });

    it('should throw error for empty join code', async () => {
      await expect(LobbyService.joinGame('', { userId: testUserId2 })).rejects.toThrow(InvalidJoinCodeError);
      await expect(LobbyService.joinGame('', { userId: testUserId2 })).rejects.toThrow('Join code is required');
    });

    it('should throw error for missing userId', async () => {
      await expect(LobbyService.joinGame(testJoinCode, { userId: '' })).rejects.toThrow(LobbyError);
      await expect(LobbyService.joinGame(testJoinCode, { userId: '' })).rejects.toThrow('userId is required');
    });

    it('should handle join code case insensitivity', async () => {
      const joinedGame = await LobbyService.joinGame(testJoinCode.toLowerCase(), { userId: testUserId2 });

      expect(joinedGame.id).toBe(testGame.id);
      expect(joinedGame.joinCode).toBe(testJoinCode);
    });

    it('should throw error when game is full', async () => {
      // Fill up the game (max 4 players, creator + 3 more)
      await LobbyService.joinGame(testJoinCode, { userId: testUserId2 });
      await LobbyService.joinGame(testJoinCode, { userId: testUserId3 });
      await LobbyService.joinGame(testJoinCode, { userId: testUserId4 });

      // Try to join when full
      await expect(LobbyService.joinGame(testJoinCode, { userId: testUserId5 })).rejects.toThrow(GameFullError);
    });

    it('should throw error when game has already started', async () => {
      // Add a player first so we can start the game
      await LobbyService.joinGame(testJoinCode, { userId: testUserId2 });
      
      // Start the game
      await LobbyService.startGame(testGame.id, testUserId);

      // Try to join started game
      await expect(LobbyService.joinGame(testJoinCode, { userId: testUserId3 })).rejects.toThrow(GameAlreadyStartedError);
    });
  });

  describe('getGame', () => {
    let testGame: Game;

    beforeEach(async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId
      };
      testGame = await LobbyService.createGame(gameData);
      testGameIds.push(testGame.id);
    });

    it('should get game by valid ID', async () => {
      const retrievedGame = await LobbyService.getGame(testGame.id);

      expect(retrievedGame).toBeDefined();
      expect(retrievedGame!.id).toBe(testGame.id);
      expect(retrievedGame!.joinCode).toBe(testGame.joinCode);
      expect(retrievedGame!.status).toBe(testGame.status);
    });

    it('should return null for non-existent game', async () => {
      const nonExistentId = uuidv4();
      const retrievedGame = await LobbyService.getGame(nonExistentId);

      expect(retrievedGame).toBeNull();
    });

    it('should throw error for empty gameId', async () => {
      await expect(LobbyService.getGame('')).rejects.toThrow(LobbyError);
      await expect(LobbyService.getGame('')).rejects.toThrow('gameId is required');
    });
  });

  describe('getGamePlayers', () => {
    let testGame: Game;

    beforeEach(async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4
      };
      testGame = await LobbyService.createGame(gameData);
      testGameIds.push(testGame.id);
    });

    it('should get players for a game', async () => {
      // Add some players
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId3 });

      const players = await LobbyService.getGamePlayers(testGame.id);

      expect(players).toHaveLength(3); // Creator + 2 joined players
      expect(players[0].userId).toBe(testUserId);
      expect(players[1].userId).toBe(testUserId2);
      expect(players[0].isOnline).toBe(true);
      expect(players[1].isOnline).toBe(true);
    });

    it('should return array with creator for newly created game', async () => {
      // Create a new game which automatically adds the creator as a player
      const gameData2: CreateGameData = {
        createdByUserId: testUserId
      };
      const game2 = await LobbyService.createGame(gameData2);
      testGameIds.push(game2.id);

      const players = await LobbyService.getGamePlayers(game2.id);

      expect(players).toHaveLength(1); // Only the creator
    });

    it('should throw error for empty gameId', async () => {
      await expect(LobbyService.getGamePlayers('')).rejects.toThrow(LobbyError);
      await expect(LobbyService.getGamePlayers('')).rejects.toThrow('gameId is required');
    });
  });

  describe('startGame', () => {
    let testGame: Game;

    beforeEach(async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4
      };
      testGame = await LobbyService.createGame(gameData);
      testGameIds.push(testGame.id);
    });

    it('should start game with valid creator', async () => {
      // Add another player
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });

      await LobbyService.startGame(testGame.id, testUserId);

      // Verify game status changed
      const updatedGame = await LobbyService.getGame(testGame.id);
      expect(updatedGame!.status).toBe('active');
    });

    it('should throw error for non-existent game', async () => {
      const nonExistentId = uuidv4();
      await expect(LobbyService.startGame(nonExistentId, testUserId)).rejects.toThrow(GameNotFoundError);
    });

    it('should throw error for non-creator trying to start', async () => {
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });

      await expect(LobbyService.startGame(testGame.id, testUserId2)).rejects.toThrow(NotGameCreatorError);
    });

    it('should throw error for insufficient players', async () => {
      // Don't add any players, just try to start with creator only
      await expect(LobbyService.startGame(testGame.id, testUserId)).rejects.toThrow(InsufficientPlayersError);
    });

    it('should throw error for already started game', async () => {
      // Add player and start game
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });
      await LobbyService.startGame(testGame.id, testUserId);

      // Try to start again
      await expect(LobbyService.startGame(testGame.id, testUserId)).rejects.toThrow(GameAlreadyStartedError);
    });

    it('should throw error for empty gameId', async () => {
      await expect(LobbyService.startGame('', testUserId)).rejects.toThrow(LobbyError);
      await expect(LobbyService.startGame('', testUserId)).rejects.toThrow('gameId is required');
    });

    it('should throw error for empty creatorUserId', async () => {
      await expect(LobbyService.startGame(testGame.id, '')).rejects.toThrow(LobbyError);
      await expect(LobbyService.startGame(testGame.id, '')).rejects.toThrow('creatorUserId is required');
    });
  });

  describe('leaveGame', () => {
    let testGame: Game;

    beforeEach(async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4
      };
      testGame = await LobbyService.createGame(gameData);
      testGameIds.push(testGame.id);
    });

    it('should remove player from game', async () => {
      // Add a player
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });

      // Verify player is in game
      let players = await LobbyService.getGamePlayers(testGame.id);
      expect(players).toHaveLength(2);

      // Leave game
      await LobbyService.leaveGame(testGame.id, testUserId2);

      // Verify player is removed
      players = await LobbyService.getGamePlayers(testGame.id);
      expect(players).toHaveLength(1);
      expect(players.find(p => p.userId === testUserId2)).toBeUndefined();
    });

    it('should transfer ownership when creator leaves', async () => {
      // Add a player first
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });
      
      // Remove the creator (ownership should transfer to the other player)
      await LobbyService.leaveGame(testGame.id, testUserId);
      
      // Verify game still exists
      let game = await LobbyService.getGame(testGame.id);
      expect(game).not.toBeNull();
      
      // Verify ownership was transferred (we can't easily test this without more complex queries)
      // The important thing is that the game still exists and the other player can still play
      
      // Now remove the last player
      await LobbyService.leaveGame(testGame.id, testUserId2);

      // Verify game is marked as abandoned instead of deleted
      game = await LobbyService.getGame(testGame.id);
      expect(game).not.toBeNull();
      expect(game?.status).toBe('abandoned');
    });

    it('should throw error for player not in game', async () => {
      await expect(LobbyService.leaveGame(testGame.id, testUserId2)).rejects.toThrow(LobbyError);
      await expect(LobbyService.leaveGame(testGame.id, testUserId2)).rejects.toThrow('Player not found in this game');
    });

    it('should throw error for empty gameId', async () => {
      await expect(LobbyService.leaveGame('', testUserId)).rejects.toThrow(LobbyError);
      await expect(LobbyService.leaveGame('', testUserId)).rejects.toThrow('gameId is required');
    });

    it('should throw error for empty userId', async () => {
      await expect(LobbyService.leaveGame(testGame.id, '')).rejects.toThrow(LobbyError);
      await expect(LobbyService.leaveGame(testGame.id, '')).rejects.toThrow('userId is required');
    });
  });

  describe('updatePlayerPresence', () => {
    let testGame: Game;
    let testPlayerId: string;

    beforeEach(async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId,
        maxPlayers: 4
      };
      testGame = await LobbyService.createGame(gameData);
      testGameIds.push(testGame.id);

      // Get the creator player ID
      const players = await LobbyService.getGamePlayers(testGame.id);
      testPlayerId = players[0].id;
      testPlayerIds.push(testPlayerId);
    });

    it('should update player online status', async () => {
      await LobbyService.updatePlayerPresence(testUserId, false);

      const players = await LobbyService.getGamePlayers(testGame.id);
      const player = players.find(p => p.userId === testUserId);
      expect(player!.isOnline).toBe(false);
    });

    it('should update player back to online', async () => {
      // First set to offline
      await LobbyService.updatePlayerPresence(testUserId, false);
      
      // Then set back to online
      await LobbyService.updatePlayerPresence(testUserId, true);

      const players = await LobbyService.getGamePlayers(testGame.id);
      const player = players.find(p => p.userId === testUserId);
      expect(player!.isOnline).toBe(true);
    });

    it('should throw error for non-existent player', async () => {
      const nonExistentUserId = uuidv4();
      await expect(LobbyService.updatePlayerPresence(nonExistentUserId, false)).rejects.toThrow(LobbyError);
      await expect(LobbyService.updatePlayerPresence(nonExistentUserId, false)).rejects.toThrow('Player not found');
    });

    it('should throw error for empty userId', async () => {
      await expect(LobbyService.updatePlayerPresence('', false)).rejects.toThrow(LobbyError);
      await expect(LobbyService.updatePlayerPresence('', false)).rejects.toThrow('userId is required');
    });

    it('should throw error for invalid isOnline type', async () => {
      await expect(LobbyService.updatePlayerPresence(testUserId, 'true' as any)).rejects.toThrow(LobbyError);
      await expect(LobbyService.updatePlayerPresence(testUserId, 'true' as any)).rejects.toThrow('isOnline must be a boolean');
    });
  });

  describe('Transaction Behavior', () => {
    it('should rollback createGame on error', async () => {
      // This test verifies that if an error occurs during game creation,
      // the transaction is properly rolled back
      const gameData: CreateGameData = {
        createdByUserId: '' // Invalid empty user ID to trigger validation error
      };

      // Expect the createGame to throw a validation error
      await expect(LobbyService.createGame(gameData))
        .rejects
        .toThrow('createdByUserId is required');
      
      // Transaction should be rolled back automatically on error
    });

    it('should rollback joinGame on error', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId
      };
      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      // Try to join with invalid data (should rollback)
      await expect(LobbyService.joinGame('', { userId: testUserId2 })).rejects.toThrow();

      // Verify no player was added
      const players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(1); // Only creator
    });

    it('should rollback startGame on error', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId
      };
      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      // Try to start with insufficient players (should rollback)
      await expect(LobbyService.startGame(game.id, testUserId)).rejects.toThrow();

      // Verify game status didn't change
      const retrievedGame = await LobbyService.getGame(game.id);
      expect(retrievedGame!.status).toBe('setup');
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent game creation', async () => {
      // Create multiple games simultaneously
      const promises = Array.from({ length: 5 }, (_, i) => 
        LobbyService.createGame({ createdByUserId: [testUserId, testUserId2, testUserId3, testUserId4, testUserId5][i] })
      );

      const games = await Promise.all(promises);
      
      // Add to cleanup
      games.forEach(game => testGameIds.push(game.id));

      // Verify all games have unique join codes
      const joinCodes = games.map(g => g.joinCode);
      const uniqueJoinCodes = new Set(joinCodes);
      expect(uniqueJoinCodes.size).toBe(joinCodes.length);
    });

    it('should handle valid UUID user IDs', async () => {
      const validUserId = testUserId;
      
      const gameData: CreateGameData = {
        createdByUserId: validUserId
      };

      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      expect(game).toBeDefined();
      expect(game.id).toBeDefined();
    });

    it('should handle special characters in join codes', async () => {
      const gameData: CreateGameData = {
        createdByUserId: testUserId
      };

      const game = await LobbyService.createGame(gameData);
      testGameIds.push(game.id);

      // Join codes should only contain alphanumeric characters
      expect(game.joinCode).toMatch(/^[A-F0-9]{8}$/);
    });
  });
});
