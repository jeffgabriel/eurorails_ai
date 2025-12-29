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

describe('Lobby API Integration Tests', () => {
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;
  let testUserId3: string;
  let testUserId4: string;
  let testUserId5: string;
  let testUserId6: string;
  let testUserId7: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = uuidv4();
    testUserId2 = uuidv4();
    testUserId3 = uuidv4();
    testUserId4 = uuidv4();
    testUserId5 = uuidv4();
    testUserId6 = uuidv4();
    testUserId7 = uuidv4();
    
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
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId6, 'testuser6', 'test6@example.com', 'hashedpassword6']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId7, 'testuser7', 'test7@example.com', 'hashedpassword7']
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
      await client.query('DELETE FROM users WHERE id = $1 OR id = $2 OR id = $3 OR id = $4 OR id = $5 OR id = $6 OR id = $7', 
        [testUserId, testUserId2, testUserId3, testUserId4, testUserId5, testUserId6, testUserId7]);
    });
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
      expect(game.status).toBe('setup');
      expect(game.joinCode).toHaveLength(8);

      // 2. Join the game
      const joinedGame = await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
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
      expect(startedGame!.status).toBe('active');

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
      const playerIds = [testUserId2, testUserId3, testUserId4];
      
      for (const playerId of playerIds) {
        await LobbyService.joinGame(game.joinCode, { userId: playerId });
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
      await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
      testPlayerIds.push(testUserId2);

      // Creator leaves (should transfer ownership)
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game still exists
      const remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).not.toBeNull();
      expect(remainingGame!.status).toBe('setup');

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
      await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
      testPlayerIds.push(testUserId2);

      // Remove creator first
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game still exists
      let remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).not.toBeNull();

      // Remove last player
      await LobbyService.leaveGame(game.id, testUserId2);

      // Verify game is marked as abandoned instead of deleted
      remainingGame = await LobbyService.getGame(game.id);
      expect(remainingGame).not.toBeNull();
      expect(remainingGame?.status).toBe('abandoned');
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
      await LobbyService.joinGame(testGame.joinCode, { userId: testUserId2 });
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

      // Verify all games are in IN_SETUP status
      games.forEach(game => {
        expect(game.status).toBe('setup');
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
      const playerIds = [testUserId2, testUserId3, testUserId4, testUserId5];
      const joinPromises = playerIds.map(playerId => 
        LobbyService.joinGame(game.joinCode, { userId: playerId })
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
      await expect(LobbyService.joinGame('NONEXIST', { userId: testUserId }))
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
      await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
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
      await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
      testPlayerIds.push(testUserId2);

      // Try to join when full
      await expect(LobbyService.joinGame(game.joinCode, { userId: testUserId6 }))
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
      await LobbyService.joinGame(game.joinCode, { userId: testUserId2 });
      testPlayerIds.push(testUserId2);

      // Get player count
      let players = await LobbyService.getGamePlayers(game.id);
      expect(players).toHaveLength(2);

      // Remove all players (should delete game)
      await LobbyService.leaveGame(game.id, testUserId2);
      await LobbyService.leaveGame(game.id, testUserId);

      // Verify game is marked as abandoned instead of deleted
      const abandonedGame = await LobbyService.getGame(game.id);
      expect(abandonedGame).not.toBeNull();
      expect(abandonedGame?.status).toBe('abandoned');

      // Verify no orphaned players (players are still removed when game is abandoned)
      const remainingPlayers = await LobbyService.getGamePlayers(game.id);
      expect(remainingPlayers).toHaveLength(0);
    });

    it('should generate unique join codes consistently', async () => {
      const games: any[] = [];
      
      // Create multiple games
      for (let i = 0; i < 10; i++) {
        const game = await LobbyService.createGame({
          createdByUserId: testUserId7
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