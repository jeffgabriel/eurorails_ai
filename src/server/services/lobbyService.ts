import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { emitLobbyUpdated, emitToLobby } from './socketService';
import { PlayerService } from './playerService';
import { TrainType } from '../../shared/types/GameTypes';
import type { Player as GamePlayer } from '../../shared/types/GameTypes';

export interface CreateGameData {
  isPublic?: boolean;
  maxPlayers?: number;
  createdByUserId: string;
  creatorColor?: string;
}

export interface JoinGameData {
  userId: string;
  selectedColor?: string;
}

export interface Game {
  id: string;
  joinCode: string;
  createdBy: string;
  status: 'IN_SETUP' | 'ACTIVE' | 'COMPLETE' | 'ABANDONED';
  gameStatus: 'setup' | 'active' | 'completed' | 'abandoned';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
}

export interface Player {
  id: string;
  userId: string;
  name: string;
  color: string;
  isOnline: boolean;
  gameId: string;
}

// Custom error types for better error handling
export class LobbyError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'LobbyError';
  }
}

export class GameNotFoundError extends LobbyError {
  constructor(message: string = 'Game not found') {
    super(message, 'GAME_NOT_FOUND', 404);
  }
}

export class GameFullError extends LobbyError {
  constructor(message: string = 'Game is full') {
    super(message, 'GAME_FULL', 400);
  }
}

export class GameAlreadyStartedError extends LobbyError {
  constructor(message: string = 'Game has already started') {
    super(message, 'GAME_ALREADY_STARTED', 400);
  }
}

export class InvalidJoinCodeError extends LobbyError {
  constructor(message: string = 'Invalid join code') {
    super(message, 'INVALID_JOIN_CODE', 400);
  }
}

export class NotGameCreatorError extends LobbyError {
  constructor(message: string = 'Only the game creator can perform this action') {
    super(message, 'NOT_GAME_CREATOR', 403);
  }
}

export class InsufficientPlayersError extends LobbyError {
  constructor(message: string = 'Need at least 2 players to start the game') {
    super(message, 'INSUFFICIENT_PLAYERS', 400);
  }
}

export class LobbyService {
  /**
   * Create a new game
   */
  static async createGame(data: CreateGameData): Promise<Game> {
    // Input validation
    if (!data.createdByUserId) {
      throw new LobbyError('createdByUserId is required', 'MISSING_USER_ID', 400);
    }
    
    if (data.maxPlayers && (data.maxPlayers < 2 || data.maxPlayers > 6)) {
      throw new LobbyError('maxPlayers must be between 2 and 6', 'INVALID_MAX_PLAYERS', 400);
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create the game using the database function for join code generation
      const gameResult = await client.query(
        `INSERT INTO games (join_code, max_players, is_public, lobby_status, status) 
         VALUES (generate_unique_join_code(), $1, $2, $3, $4) 
         RETURNING id, join_code, max_players, is_public, lobby_status, status, created_at`,
        [data.maxPlayers || 6, data.isPublic || false, 'IN_SETUP', 'setup']
      );
      
      const game = gameResult.rows[0];
      
      // Get the username for the game creator
      const userResult = await client.query(
        'SELECT username FROM users WHERE id = $1',
        [data.createdByUserId]
      );
      
      if (userResult.rows.length === 0) {
        throw new LobbyError('User not found', 'USER_NOT_FOUND', 404);
      }
      
      const username = userResult.rows[0].username;
      
      // Create the first player (game creator) using PlayerService to ensure cards are drawn
      const creatorPlayer: GamePlayer = {
        id: uuidv4(),
        userId: data.createdByUserId,
        name: username,
        color: data.creatorColor || '#ff0000',
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: null,
          movementHistory: [],
          remainingMovement: 9,
          loads: []
        },
        hand: []  // Empty - PlayerService will draw cards server-side
      };
      
      // Use PlayerService.createPlayer() to ensure cards are drawn properly
      // Pass the transaction client so the player is created in the same transaction
      await PlayerService.createPlayer(game.id, creatorPlayer, client);
      
      // Update the game with the creator reference (user ID, not player ID)
      await client.query(
        'UPDATE games SET created_by = $1 WHERE id = $2',
        [data.createdByUserId, game.id]
      );
      
      await client.query('COMMIT');
      
    return {
      id: game.id,
      joinCode: game.join_code,
      createdBy: data.createdByUserId, // Use user ID, not player ID
      status: game.lobby_status,
      gameStatus: game.status,
      maxPlayers: game.max_players,
      isPublic: game.is_public,
      createdAt: game.created_at,
    };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Join an existing game
   */
  static async joinGame(joinCode: string, joinData: JoinGameData): Promise<Game> {
    // Input validation
    if (!joinCode || joinCode.trim().length === 0) {
      throw new InvalidJoinCodeError('Join code is required');
    }
    
    if (!joinData.userId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Find the game by join code
      const gameResult = await client.query(
        `SELECT g.*, g.created_by as creator_user_id 
         FROM games g 
         WHERE g.join_code = $1`,
        [joinCode.toUpperCase()]
      );
      
      if (gameResult.rows.length === 0) {
        throw new InvalidJoinCodeError('Game not found with that join code');
      }
      
      const game = gameResult.rows[0];
      
      if (game.lobby_status !== 'IN_SETUP') {
        throw new GameAlreadyStartedError();
      }
      
      // Check if player is already in the game
      const existingPlayer = await client.query(
        'SELECT id FROM players WHERE game_id = $1 AND user_id = $2',
        [game.id, joinData.userId]  
      );
      
      if (existingPlayer.rows.length > 0) {
        // Player already in game, return game info
        await client.query('COMMIT');
        return {
          id: game.id,
          joinCode: game.join_code,
          createdBy: game.creator_user_id,
          status: game.lobby_status,
          gameStatus: game.status,
          maxPlayers: game.max_players,
          isPublic: game.is_public,
          createdAt: game.created_at,
        };
      }
      
      // Check if game is full
      const playerCountResult = await client.query(
        'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
        [game.id]
      );
      
      const playerCount = parseInt(playerCountResult.rows[0].count);
      if (playerCount >= game.max_players) {
        throw new GameFullError();
      }
      
      // Get the username for the joining player
      const userResult = await client.query(
        'SELECT username FROM users WHERE id = $1',
        [joinData.userId]
      );
      
      if (userResult.rows.length === 0) {
        throw new LobbyError('User not found', 'USER_NOT_FOUND', 404);
      }
      
      const username = userResult.rows[0].username;
      
      // Handle color selection
      let playerColor;
      if (joinData.selectedColor) {
        // Check if the selected color is available
        const colorCheck = await client.query(
          'SELECT id FROM players WHERE game_id = $1 AND color = $2',
          [game.id, joinData.selectedColor]
        );
        
        if (colorCheck.rows.length > 0) {
          throw new LobbyError('Color already taken', 'COLOR_TAKEN', 400);
        }
        
        playerColor = joinData.selectedColor;
      } else {
        // Auto-assign color if none selected
        const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
        const usedColors = await client.query(
          'SELECT color FROM players WHERE game_id = $1',
          [game.id]
        );
        
        const availableColors = colors.filter(color => 
          !usedColors.rows.some(row => row.color === color)
        );
        
        playerColor = availableColors[0] || colors[playerCount];
      }
      
      // Create player using PlayerService to ensure cards are drawn
      const joinedPlayer: GamePlayer = {
        id: uuidv4(),
        userId: joinData.userId,
        name: username,
        color: playerColor,
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: null,
          movementHistory: [],
          remainingMovement: 9,
          loads: []
        },
        hand: []  // Empty - PlayerService will draw cards server-side
      };
      
      // Use PlayerService.createPlayer() to ensure cards are drawn properly
      // Pass the transaction client so the player is created in the same transaction
      await PlayerService.createPlayer(game.id, joinedPlayer, client);
      
      await client.query('COMMIT');
      
      // Emit socket event to notify other players in the lobby
      try {
        const players = await LobbyService.getGamePlayers(game.id);
        await emitLobbyUpdated(game.id, 'player-joined', players);
      } catch (socketError) {
        // Log error but don't fail the join operation
        console.error('Failed to emit lobby update:', socketError);
      }
      
      return {
        id: game.id,
        joinCode: game.join_code,
        createdBy: game.creator_user_id,
        status: game.lobby_status,
        gameStatus: game.status,
        maxPlayers: game.max_players,
        isPublic: game.is_public,
        createdAt: game.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get game by ID
   */
  static async getGame(gameId: string): Promise<Game | null> {
    // Input validation
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }

    const result = await db.query(
      `SELECT g.*, g.created_by as creator_user_id 
       FROM games g 
       WHERE g.id = $1`,
      [gameId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const game = result.rows[0];
    return {
      id: game.id,
      joinCode: game.join_code,
      createdBy: game.creator_user_id,
      status: game.lobby_status,
      gameStatus: game.status,
      maxPlayers: game.max_players,
      isPublic: game.is_public,
      createdAt: game.created_at,
    };
  }

  /**
   * Get players in a game (for lobby - includes isOnline status)
   */
  static async getGamePlayers(gameId: string): Promise<(GamePlayer & { isOnline: boolean })[]> {
    // Input validation
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }

    const result = await db.query(
      `SELECT id, user_id, name, color, is_online, game_id 
       FROM players 
       WHERE game_id = $1 
       ORDER BY created_at`,
      [gameId]
    );
    
    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      color: row.color,
      money: 50, // Default for lobby view
      trainType: TrainType.Freight, // Default for lobby view
      turnNumber: 1, // Default for lobby view
      trainState: {
        position: null,
        movementHistory: [],
        remainingMovement: 9,
        loads: []
      },
      hand: [], // Lobby doesn't show hands - this will be loaded when game starts
      isOnline: row.is_online || false, // Include isOnline for lobby
    }));
  }

  /**
   * Get game by join code
   */
  static async getGameByJoinCode(joinCode: string): Promise<Game | null> {
    // Input validation
    if (!joinCode || joinCode.trim().length === 0) {
      throw new LobbyError('Join code is required', 'MISSING_JOIN_CODE', 400);
    }

    const result = await db.query(
      `SELECT g.*, g.created_by as creator_user_id 
       FROM games g 
       WHERE g.join_code = $1`,
      [joinCode.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const game = result.rows[0];
    return {
      id: game.id,
      joinCode: game.join_code,
      createdBy: game.creator_user_id,
      status: game.lobby_status,
      gameStatus: game.status,
      maxPlayers: game.max_players,
      isPublic: game.is_public,
      createdAt: game.created_at,
    };
  }

  /**
   * Get available colors for a game
   */
  static async getAvailableColors(gameId: string): Promise<string[]> {
    // Input validation
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }

    // Check if game exists
    const gameResult = await db.query(
      'SELECT id FROM games WHERE id = $1',
      [gameId]
    );
    
    if (gameResult.rows.length === 0) {
      throw new LobbyError('Game not found', 'GAME_NOT_FOUND', 404);
    }

    // Get used colors
    const usedColorsResult = await db.query(
      'SELECT color FROM players WHERE game_id = $1',
      [gameId]
    );
    
    const usedColors = usedColorsResult.rows.map(row => row.color);
    
    // All available colors
    const allColors = ['#ff0000', '#0000ff', '#008000', '#ffd700', '#000000', '#8b4513'];
    
    // Return colors that are not in use
    return allColors.filter(color => !usedColors.includes(color));
  }

  static async startGame(gameId: string, creatorUserId: string): Promise<void> {
    // Input validation
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }
    
    if (!creatorUserId) {
      throw new LobbyError('creatorUserId is required', 'MISSING_USER_ID', 400);
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Verify the user is the creator
      const gameResult = await client.query(
        `SELECT g.*, g.created_by as creator_user_id 
         FROM games g 
         WHERE g.id = $1`,
        [gameId]
      );
      
      if (gameResult.rows.length === 0) {
        throw new GameNotFoundError();
      }
      
      const game = gameResult.rows[0];
      
      if (game.creator_user_id !== creatorUserId) {
        throw new NotGameCreatorError();
      }
      
      if (game.lobby_status !== 'IN_SETUP') {
        throw new GameAlreadyStartedError();
      }
      
      // Check minimum players
      const playerCountResult = await client.query(
        'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
        [gameId]
      );
      
      const playerCount = parseInt(playerCountResult.rows[0].count);
      if (playerCount < 2) {
        throw new InsufficientPlayersError();
      }
      
      // Update game status
      await client.query(
        'UPDATE games SET lobby_status = $1, status = $2 WHERE id = $3',
        ['ACTIVE', 'active', gameId]
      );
      
      await client.query('COMMIT');
      
      // Emit socket event to notify all clients in the lobby that game is starting
      try {
        await emitToLobby(gameId, 'game-started', {
          gameId,
          timestamp: Date.now(),
        });
      } catch (socketError) {
        // Log error but don't fail the start game operation
        console.error('Failed to emit game-started event:', socketError);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Leave a game
   */
  static async leaveGame(gameId: string, userId: string): Promise<void> {
    // Input validation
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }
    
    if (!userId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Check if player exists in the game
      const playerResult = await client.query(
        'SELECT id FROM players WHERE game_id = $1 AND user_id = $2',
        [gameId, userId]
      );
      
      if (playerResult.rows.length === 0) {
        throw new LobbyError('Player not found in this game', 'PLAYER_NOT_IN_GAME', 404);
      }
      
      // Check if this is the creator (compare user IDs)
      const isCreator = await client.query(
        'SELECT created_by FROM games WHERE id = $1',
        [gameId]
      );
      
      if (isCreator.rows[0].created_by === userId) {
        // If this is the creator, we need to transfer ownership or abandon the game
        const remainingPlayers = await client.query(
          'SELECT user_id FROM players WHERE game_id = $1 AND user_id != $2 ORDER BY created_at LIMIT 1',
          [gameId, userId]
        );
        
        if (remainingPlayers.rows.length > 0) {
          // Transfer ownership to another player (use user_id, not player id)
          await client.query(
            'UPDATE games SET created_by = $1 WHERE id = $2',
            [remainingPlayers.rows[0].user_id, gameId]
          );
        } else {
          // No other players, mark game as abandoned instead of deleting
          await client.query(
            'UPDATE games SET lobby_status = $1 WHERE id = $2',
            ['ABANDONED', gameId]
          );
        }
      }
      
      // Remove the player
      await client.query(
        'DELETE FROM players WHERE game_id = $1 AND user_id = $2',
        [gameId, userId]
      );
      
      // If no players left, mark game as abandoned instead of deleting
      const playerCountResult = await client.query(
        'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
        [gameId]
      );
      
      if (parseInt(playerCountResult.rows[0].count) === 0) {
        await client.query(
          'UPDATE games SET lobby_status = $1 WHERE id = $2',
          ['ABANDONED', gameId]
        );
      }
      
      await client.query('COMMIT');
      
      // Emit socket event to notify other players in the lobby
      try {
        const players = await LobbyService.getGamePlayers(gameId);
        await emitLobbyUpdated(gameId, 'player-left', players);
      } catch (socketError) {
        // Log error but don't fail the leave operation
        console.error('Failed to emit lobby update:', socketError);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update player online status
   */
  static async updatePlayerPresence(userId: string, isOnline: boolean): Promise<void> {
    // Input validation
    if (!userId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }
    
    if (typeof isOnline !== 'boolean') {
      throw new LobbyError('isOnline must be a boolean', 'INVALID_IS_ONLINE', 400);
    }

    const result = await db.query(
      'UPDATE players SET is_online = $1 WHERE user_id = $2',
      [isOnline, userId]
    );
    
    if (result.rowCount === 0) {
      throw new LobbyError('Player not found', 'PLAYER_NOT_FOUND', 404);
    }
  }
}
