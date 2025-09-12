// Integration tests for Lobby API Routes
// Run with: npm test -- --runInBand src/server/__tests__/lobbyRoutes.test.ts

import { LobbyService } from '../services/lobbyService';
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
    // Players must be deleted before games due to foreign key constraints
    if (playerIds.length > 0) {
      await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
  });
}

describe('Lobby API Integration Tests', () => {
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = uuidv4();
    testUserId2 = uuidv4();
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
  });

  describe('End-to-End Lobby Workflow', () => {
    it('should complete full lobby workflow: create -> join -> start -> leave', async () => {
      // 1. Create a game
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4,
        isPublic: true
      });
      testGameIds.push(game.id);

      expect(game).toBeDefined();
      expect(game.status).toBe('IN_SETUP');
      expect(game.joinCode).toHaveLength(8);

      // 2. Join the game
      const joinedGame = await LobbyService.joinGame(game.joinCode, testUserId2);
      expect(joinedGame.id).toBe(game.id);
      testPlayerIds.push(testUserId2);

      // 3. Verify players are in the game
      let players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(2);
      expect(players.find(p => p.userId === testUserId)).toBeDefined();
      expect(players.find(p => p.userId === testUserId2)).toBeDefined();

      // 4. Start the game
      await LobbyService.startGame(game.id, testUserId);

      // 5. Verify game status changed
      const startedGame = await LobbyService.getGame(game.id);
      expect(startedGame!.status).toBe('ACTIVE');

      // 6. Leave the game
      await LobbyService.leaveGame(game.id, testUserId2);

      // 7. Verify player was removed
      players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(1);
      expect(players.find(p => p.userId === testUserId2)).toBeUndefined();
    });

    it('should handle multiple players joining and leaving', async () => {
      // Create a game
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 6
      });
      testGameIds.push(game.id);

      // Add multiple players
      const playerIds = [uuidv4(), uuidv4(), uuidv4()];
      
      for (const playerId of playerIds) {
        await LobbyService.joinGame(game.joinCode, playerId);
        testPlayerIds.push(playerId);
      }

      // Verify all players are in the game
      let players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(4); // Creator + 3 joined players

      // Remove some players
      await LobbyService.leaveGame(game.id, playerIds[0]);
      await LobbyService.leaveGame(game.id, playerIds[1]);

      // Verify players were removed
      players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(2); // Creator + 1 remaining player
    });

    it('should handle ownership transfer when creator leaves', async () => {
      // Create a game
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGameIds.push(game.id);

      // Add another player
      await LobbyService.joinGame(game.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);

      // Creator leaves (should transfer ownership)
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game still exists
      const remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).not.toBeNull();
      expect(remainingGame!.status).toBe('IN_SETUP');

      // Verify only one player remains
      const players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(1);
      expect(players[0].userId).toBe(testUserId2);
    });

    it('should delete game when last player leaves', async () => {
      // Create a game
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGameIds.push(game.id);

      // Add another player
      await LobbyService.joinGame(game.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);

      // Remove creator first
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game still exists
      let remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).not.toBeNull();

      // Remove last player
      await LobbyService.leaveGame(game.id, testUserId2);

      // Verify game is deleted
      remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).toBeNull();
    });
  });

  describe('Player Presence Management', () => {
    let testGame: any;

    beforeEach(async () => {
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGame = game;
      testGameIds.push(game.id);
    });

    it('should update player online status', async () => {
      // Add a player
      await LobbyService.joinGame(testGame.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);

      // Update presence
      await LobbyService.updatePlayerPresence(testUserId, false);
      await LobbyService.updatePlayerPresence(testUserId2, false);

      // Verify presence was updated
      const players = await LobbyService.getGamePlayers(testGame.id);
      const creator = players.find(p => p.userId === testUserId);
      const joinedPlayer = players.find(p => p.userId === testUserId2);

      expect(creator!.isOnline).toBe(false);
      expect(joinedPlayer!.isOnline).toBe(false);

      // Update back to online
      await LobbyService.updatePlayerPresence(testUserId, true);
      await LobbyService.updatePlayerPresence(testUserId2, true);

      // Verify presence was updated again
      const updatedPlayers = await LobbyService.getGamePlayers(testGame.id);
      const updatedCreator = updatedPlayers.find(p => p.userId === testUserId);
      const updatedJoinedPlayer = updatedPlayers.find(p => p.userId === testUserId2);

      expect(updatedCreator!.isOnline).toBe(true);
      expect(updatedJoinedPlayer!.isOnline).toBe(true);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent game creation', async () => {
      // Create multiple games simultaneously
      const promises = Array.from({ length: 5 }, () => 
        LobbyService.createGame({ createdByUserId: uuidv4() })
      );

      const games = await Promise.all(promises);
      
      // Add to cleanup
      games.forEach(game => testGameIds.push(game.id));

      // Verify all games have unique join codes
      const joinCodes = games.map(g => g.joinCode);
      const uniqueJoinCodes = new Set(joinCodes);
      expect(uniqueJoinCodes.size).toBe(joinCodes.length);

      // Verify all games are in IN_SETUP status
      games.forEach(game => {
        expect(game.status).toBe('IN_SETUP');
        expect(game.joinCode).toHaveLength(8);
      });
    });

    it('should handle concurrent joins to the same game', async () => {
      // Create a game
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 6
      });
      testGameIds.push(game.id);

      // Multiple players try to join simultaneously
      const playerIds = Array.from({ length: 4 }, () => uuidv4());
      const joinPromises = playerIds.map(playerId => 
        LobbyService.joinGame(game.joinCode, playerId)
      );
      // Track player IDs for cleanup
      testPlayerIds.push(...playerIds);

      const results = await Promise.all(joinPromises);

      // All should succeed
      results.forEach(result => {
        expect(result.id).toBe(game.id);
      });

      // Verify all players are in the game
      const players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(5); // Creator + 4 joined players
    });
  });

  describe('Error Scenarios', () => {
    it('should handle joining a non-existent game', async () => {
      await expect(LobbyService.joinGame('NONEXIST', testUserId))
        .rejects.toThrow('Game not found with that join code');
    });

    it('should handle starting a game with insufficient players', async () => {
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGameIds.push(game.id);

      await expect(LobbyService.startGame(game.id, testUserId))
        .rejects.toThrow('Need at least 2 players to start the game');
    });

    it('should handle starting a game that has already started', async () => {
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGameIds.push(game.id);

      // Add a player and start the game
      await LobbyService.joinGame(game.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);
      await LobbyService.startGame(game.id, testUserId);

      // Try to start again
      await expect(LobbyService.startGame(game.id, testUserId))
        .rejects.toThrow('Game has already started');
    });

    it('should handle joining a full game', async () => {
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 2 // Only 2 players allowed
      });
      testGameIds.push(game.id);

      // Fill the game
      await LobbyService.joinGame(game.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);

      // Try to join when full
      await expect(LobbyService.joinGame(game.joinCode, uuidv4()))
        .rejects.toThrow('Game is full');
    });
  });

  describe('Data Integrity', () => {
    it('should maintain referential integrity when deleting games', async () => {
      const game = await LobbyService.createGame({
        createdByUserId: testUserId,
        maxPlayers: 4
      });
      testGameIds.push(game.id);

      // Add a player
      await LobbyService.joinGame(game.joinCode, testUserId2);
      testPlayerIds.push(testUserId2);

      // Get player count
      let players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(2);

      // Remove all players (should delete game)
      await LobbyService.leaveGame(game.id, testUserId2);
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game is deleted
      const deletedGame = await LobbyService.getGame(game.id);
      expect(deletedGame).toBeNull();

      // Verify no orphaned players
      const remainingPlayers = await LobbyService.getGamePlayers(game.id);
      expect(remainingPlayers).toHaveLength(0);
    });

    it('should generate unique join codes consistently', async () => {
      const games: any[] = [];
      
      // Create multiple games
      for (let i = 0; i < 10; i++) {
        const game = await LobbyService.createGame({
          createdByUserId: uuidv4()
        });
        games.push(game);
        testGameIds.push(game.id);
      }

      // Verify all join codes are unique
      const joinCodes = games.map(g => g.joinCode);
      const uniqueJoinCodes = new Set(joinCodes);
      expect(uniqueJoinCodes.size).toBe(joinCodes.length);

      // Verify all join codes are valid format
      joinCodes.forEach(code => {
        expect(code).toMatch(/^[A-Z0-9]{8}$/);
      });
    });
  });
});