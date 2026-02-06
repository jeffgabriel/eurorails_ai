import { LobbyService } from '../services/lobbyService';
import {
  LobbyError,
  GameNotFoundError,
  GameFullError,
  GameAlreadyStartedError,
  NotGameCreatorError,
} from '../services/lobbyService';
import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { emitLobbyUpdated } from '../services/socketService';
import type { AIPlayerConfig } from '../../shared/types/AITypes';

// Mock dependencies
jest.mock('../db', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
  };
});

jest.mock('../services/playerService', () => ({
  PlayerService: {
    createPlayer: jest.fn(),
  },
}));

jest.mock('../services/socketService', () => ({
  emitLobbyUpdated: jest.fn(),
  emitToLobby: jest.fn(),
}));

// Get the mock client for assertions
const getMockClient = () => {
  return (db.connect as jest.Mock).mock.results[0]?.value;
};

describe('LobbyService AI Player Management', () => {
  const gameId = 'game-123';
  const hostUserId = 'host-user-456';
  const nonHostUserId = 'non-host-user-789';

  let mockClient: { query: jest.Mock; release: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    (db.connect as jest.Mock).mockResolvedValue(mockClient);
  });

  describe('addAIPlayer', () => {
    const validConfig: AIPlayerConfig = {
      difficulty: 'medium',
      archetype: 'backbone_builder',
    };

    function setupGameQuery(overrides?: Partial<{ created_by: string; status: string; max_players: number }>) {
      const defaults = {
        id: gameId,
        created_by: hostUserId,
        status: 'setup',
        max_players: 6,
      };
      return { rows: [{ ...defaults, ...overrides }] };
    }

    function setupSuccessfulAdd() {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery()) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // player count
        .mockResolvedValueOnce({ rows: [{ color: '#ff0000' }, { color: '#0000ff' }] }) // used colors
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // AI player count (for name)
        .mockResolvedValueOnce(undefined); // COMMIT
    }

    it('creates an AI player with correct config', async () => {
      setupSuccessfulAdd();
      // Mock getGamePlayers for the socket emission
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await LobbyService.addAIPlayer(gameId, hostUserId, validConfig);

      expect(result.isAI).toBe(true);
      expect(result.aiDifficulty).toBe('medium');
      expect(result.aiArchetype).toBe('backbone_builder');
      expect(result.name).toBe('Bot-1');
      expect(result.money).toBe(50);
      expect(result.isOnline).toBe(false);
    });

    it('uses custom name when provided', async () => {
      setupSuccessfulAdd();
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await LobbyService.addAIPlayer(gameId, hostUserId, {
        ...validConfig,
        name: 'AlphaBot',
      });

      expect(result.name).toBe('AlphaBot');
    });

    it('auto-numbers bot names based on existing AI players', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery()) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // player count
        .mockResolvedValueOnce({ rows: [{ color: '#ff0000' }] }) // used colors
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // AI player count = 2
        .mockResolvedValueOnce(undefined); // COMMIT
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await LobbyService.addAIPlayer(gameId, hostUserId, validConfig);

      expect(result.name).toBe('Bot-3');
    });

    it('assigns an available color to the bot', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery()) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // player count
        .mockResolvedValueOnce({ rows: [{ color: '#ff0000' }, { color: '#0000ff' }] }) // used colors
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // AI player count
        .mockResolvedValueOnce(undefined); // COMMIT
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await LobbyService.addAIPlayer(gameId, hostUserId, validConfig);

      // First two colors (#ff0000, #0000ff) are taken, so should get #008000
      expect(result.color).toBe('#008000');
    });

    it('calls PlayerService.createPlayer with AI fields', async () => {
      setupSuccessfulAdd();
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await LobbyService.addAIPlayer(gameId, hostUserId, validConfig);

      expect(PlayerService.createPlayer).toHaveBeenCalledTimes(1);
      const [, player] = (PlayerService.createPlayer as jest.Mock).mock.calls[0];
      expect(player.isAI).toBe(true);
      expect(player.aiDifficulty).toBe('medium');
      expect(player.aiArchetype).toBe('backbone_builder');
      expect(player.userId).toBeUndefined();
    });

    it('emits lobby update after adding bot', async () => {
      setupSuccessfulAdd();
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await LobbyService.addAIPlayer(gameId, hostUserId, validConfig);

      expect(emitLobbyUpdated).toHaveBeenCalledWith(gameId, 'player-joined', expect.any(Array));
    });

    it('throws NotGameCreatorError if user is not the host', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery()) // game lookup — host is hostUserId
        .mockResolvedValueOnce(undefined); // ROLLBACK

      await expect(
        LobbyService.addAIPlayer(gameId, nonHostUserId, validConfig),
      ).rejects.toThrow(NotGameCreatorError);
    });

    it('throws GameNotFoundError if game does not exist', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // no game found

      await expect(
        LobbyService.addAIPlayer(gameId, hostUserId, validConfig),
      ).rejects.toThrow(GameNotFoundError);
    });

    it('throws GameAlreadyStartedError if game is not in setup', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery({ status: 'active' }));

      await expect(
        LobbyService.addAIPlayer(gameId, hostUserId, validConfig),
      ).rejects.toThrow(GameAlreadyStartedError);
    });

    it('throws GameFullError if game is at max capacity', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery({ max_players: 3 }))
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }); // 3/3 players

      await expect(
        LobbyService.addAIPlayer(gameId, hostUserId, validConfig),
      ).rejects.toThrow(GameFullError);
    });

    it('throws when no colors are available', async () => {
      const allUsed = [
        { color: '#ff0000' },
        { color: '#0000ff' },
        { color: '#008000' },
        { color: '#ffd700' },
        { color: '#000000' },
        { color: '#8b4513' },
      ];
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery())
        .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // player count (not yet full in a 6-player game)
        .mockResolvedValueOnce({ rows: allUsed }); // all colors used

      await expect(
        LobbyService.addAIPlayer(gameId, hostUserId, validConfig),
      ).rejects.toThrow('No available colors');
    });

    it('rolls back transaction on error', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // no game found

      await expect(
        LobbyService.addAIPlayer(gameId, hostUserId, validConfig),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('removeAIPlayer', () => {
    const aiPlayerId = 'ai-player-abc';

    function setupGameQuery(overrides?: Partial<{ created_by: string; status: string }>) {
      const defaults = {
        id: gameId,
        created_by: hostUserId,
        status: 'setup',
      };
      return { rows: [{ ...defaults, ...overrides }] };
    }

    it('removes an AI player successfully', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery()) // game lookup
        .mockResolvedValueOnce({ rows: [{ id: aiPlayerId, is_ai: true }] }) // player lookup
        .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
        .mockResolvedValueOnce(undefined); // COMMIT
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).resolves.toBeUndefined();
    });

    it('emits lobby update after removing bot', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery())
        .mockResolvedValueOnce({ rows: [{ id: aiPlayerId, is_ai: true }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce(undefined); // COMMIT
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId);

      expect(emitLobbyUpdated).toHaveBeenCalledWith(gameId, 'player-left', expect.any(Array));
    });

    it('throws NotGameCreatorError if user is not the host', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery());

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, nonHostUserId),
      ).rejects.toThrow(NotGameCreatorError);
    });

    it('throws GameNotFoundError if game does not exist', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).rejects.toThrow(GameNotFoundError);
    });

    it('throws GameAlreadyStartedError if game is not in setup', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery({ status: 'active' }));

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).rejects.toThrow(GameAlreadyStartedError);
    });

    it('throws if player is not found in the game', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery())
        .mockResolvedValueOnce({ rows: [] }); // no player found

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).rejects.toThrow('Player not found in this game');
    });

    it('throws if player is not an AI player', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(setupGameQuery())
        .mockResolvedValueOnce({ rows: [{ id: aiPlayerId, is_ai: false }] }); // human player

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).rejects.toThrow('Cannot remove a human player using this endpoint');
    });

    it('rolls back transaction on error', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // no game found

      await expect(
        LobbyService.removeAIPlayer(gameId, aiPlayerId, hostUserId),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('startGame AI validation', () => {
    function setupStartGameBase() {
      return {
        id: gameId,
        creator_user_id: hostUserId,
        status: 'setup',
      };
    }

    it('allows starting with mixed human and AI players', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [setupStartGameBase()] }) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // total player count
        .mockResolvedValueOnce({ rows: [{ human_count: 1, ai_count: 2 }] }) // human/AI count
        .mockResolvedValueOnce(undefined) // UPDATE status
        .mockResolvedValueOnce(undefined); // COMMIT

      await expect(
        LobbyService.startGame(gameId, hostUserId),
      ).resolves.toBeUndefined();
    });

    it('allows starting with only human players (no bots)', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [setupStartGameBase()] }) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // total player count
        .mockResolvedValueOnce({ rows: [{ human_count: 2, ai_count: 0 }] }) // human/AI count
        .mockResolvedValueOnce(undefined) // UPDATE status
        .mockResolvedValueOnce(undefined); // COMMIT

      await expect(
        LobbyService.startGame(gameId, hostUserId),
      ).resolves.toBeUndefined();
    });

    it('rejects starting with only AI players', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [setupStartGameBase()] }) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // total player count = 3
        .mockResolvedValueOnce({ rows: [{ human_count: 0, ai_count: 3 }] }); // all AI

      await expect(
        LobbyService.startGame(gameId, hostUserId),
      ).rejects.toThrow('Cannot start a game with only AI players');
    });

    it('returns NO_HUMAN_PLAYERS error code for bot-only game', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [setupStartGameBase()] }) // game lookup
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // total player count
        .mockResolvedValueOnce({ rows: [{ human_count: 0, ai_count: 2 }] }); // all AI

      try {
        await LobbyService.startGame(gameId, hostUserId);
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(LobbyError);
        expect((error as LobbyError).code).toBe('NO_HUMAN_PLAYERS');
        expect((error as LobbyError).statusCode).toBe(400);
      }
    });
  });
});
