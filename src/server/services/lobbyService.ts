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
  // games.status is the single source of truth
  status: 'setup' | 'initialBuild' | 'active' | 'completed' | 'abandoned';
  // Backward compatibility for older clients (e.g. SetupScene) that still read gameStatus
  gameStatus: 'setup' | 'initialBuild' | 'active' | 'completed' | 'abandoned';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
}

export interface GameSummary {
  id: string;
  joinCode: string | null;
  createdBy: string | null;
  status: Game['status'];
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  playerCount: number;
  onlineCount: number;
  isOwner: boolean;
}

export interface MyGamesResponse {
  active: GameSummary[];
  setupOwned: GameSummary[];
  archived: GameSummary[];
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
        `INSERT INTO games (join_code, max_players, is_public, status) 
         VALUES (generate_unique_join_code(), $1, $2, $3) 
         RETURNING id, join_code, max_players, is_public, status, created_at, updated_at`,
        [data.maxPlayers || 6, data.isPublic || false, 'setup']
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
        debtOwed: 0,
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
      status: game.status,
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

    // First, do read-only checks without a transaction
    // Find the game by join code
    const gameResult = await db.query(
      `SELECT g.*, g.created_by as creator_user_id 
       FROM games g 
       WHERE g.join_code = $1`,
      [joinCode.toUpperCase()]
    );
    
    if (gameResult.rows.length === 0) {
      throw new InvalidJoinCodeError('Game not found with that join code');
    }
    
    const game = gameResult.rows[0];
    
    // Check if player is already in the game FIRST
    // This allows existing players to rejoin active games after refresh
    const existingPlayer = await db.query(
      'SELECT id, is_deleted FROM players WHERE game_id = $1 AND user_id = $2',
      [game.id, joinData.userId]  
    );
    
    if (existingPlayer.rows.length > 0) {
      // If the user previously soft-deleted the game, restore visibility on join
      if (existingPlayer.rows[0].is_deleted === true) {
        await db.query(
          'UPDATE players SET is_deleted = false WHERE game_id = $1 AND user_id = $2',
          [game.id, joinData.userId]
        );
      }
      // Player already in game, return game info regardless of status
      // This allows rejoining active games
      return {
        id: game.id,
        joinCode: game.join_code,
        createdBy: game.creator_user_id,
        status: game.status,
        gameStatus: game.status,
        maxPlayers: game.max_players,
        isPublic: game.is_public,
        createdAt: game.created_at,
      };
    }
    
    // Only enforce "game must be setup" for NEW players joining
    if (game.status !== 'setup') {
      throw new GameAlreadyStartedError();
    }
    
    // Check if game is full
    const playerCountResult = await db.query(
      'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
      [game.id]
    );
    
    const playerCount = parseInt(playerCountResult.rows[0].count);
    if (playerCount >= game.max_players) {
      throw new GameFullError();
    }
    
    // Get the username for the joining player
    const userResult = await db.query(
      'SELECT username FROM users WHERE id = $1',
      [joinData.userId]
    );
    
    if (userResult.rows.length === 0) {
      throw new LobbyError('User not found', 'USER_NOT_FOUND', 404);
    }
    
    const username = userResult.rows[0].username;
    
    // Now start a transaction only when we need to create a new player
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Handle color selection and player creation
      // Retry logic to handle concurrent joins picking the same color
      const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
      let attempts = 0;
      let playerCreated = false;
      let playerColor: string | undefined;
      
      while (!playerCreated && attempts < colors.length) {
        // Determine color for this attempt
        if (joinData.selectedColor && attempts === 0) {
          // User selected a color - check if available
          const colorCheck = await client.query(
            'SELECT id FROM players WHERE game_id = $1 AND color = $2',
            [game.id, joinData.selectedColor]
          );
          
          if (colorCheck.rows.length > 0) {
            throw new LobbyError('Color already taken', 'COLOR_TAKEN', 400);
          }
          
          playerColor = joinData.selectedColor;
        } else {
          // Auto-assign color - check which colors are currently available
          const usedColors = await client.query(
            'SELECT color FROM players WHERE game_id = $1',
            [game.id]
          );
          
          const availableColors = colors.filter(color => 
            !usedColors.rows.some(row => row.color === color)
          );
          
          // Pick from available colors, or use index-based fallback
          playerColor = availableColors[attempts] || colors[attempts] || colors[0];
        }
        
        // Create player using PlayerService to ensure cards are drawn
        const joinedPlayer: GamePlayer = {
          id: uuidv4(),
          userId: joinData.userId,
          name: username,
          color: playerColor!,
          money: 50,
          debtOwed: 0,
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
        
        try {
          // Use PlayerService.createPlayer() to ensure cards are drawn properly
          // Pass the transaction client so the player is created in the same transaction
          await PlayerService.createPlayer(game.id, joinedPlayer, client);
          playerCreated = true;
        } catch (error: any) {
          // If color conflict and we haven't exhausted all colors, retry with next color
          if (error.message && error.message.includes('Color already taken')) {
            attempts++;
            if (attempts >= colors.length) {
              throw new LobbyError('No available colors', 'NO_COLORS_AVAILABLE', 400);
            }
            // Continue to retry with next color
          } else {
            // Re-throw non-color-conflict errors
            throw error;
          }
        }
      }
      
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
        status: game.status,
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
      status: game.status,
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
      debtOwed: 0, // Default for lobby view
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
      status: game.status,
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
      
      if (game.status !== 'setup') {
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
        'UPDATE games SET status = $1 WHERE id = $2',
        ['active', gameId]
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
      
      if (isCreator.rows.length === 0) {
        throw new LobbyError('Game not found', 'GAME_NOT_FOUND', 404);
      }
      
      const createdBy = isCreator.rows[0].created_by;
      if (createdBy && createdBy === userId) {
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
            'UPDATE games SET status = $1 WHERE id = $2',
            ['abandoned', gameId]
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
          'UPDATE games SET status = $1 WHERE id = $2',
          ['abandoned', gameId]
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

  /**
   * List games for a user, grouped for lobby UI.
   * Filters out soft-deleted games (players.is_deleted = true).
   */
  static async getMyGames(userId: string): Promise<MyGamesResponse> {
    if (!userId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }

    const result = await db.query(
      `
      SELECT
        g.id,
        g.join_code,
        g.created_by,
        g.status,
        g.max_players,
        g.is_public,
        g.created_at,
        g.updated_at,
        COUNT(*) FILTER (WHERE COALESCE(p_all.is_deleted, false) = false)::int AS player_count,
        COUNT(*) FILTER (WHERE p_all.is_online = true AND COALESCE(p_all.is_deleted, false) = false)::int AS online_count
      FROM games g
      JOIN players p_me
        ON p_me.game_id = g.id
       AND p_me.user_id = $1
       AND COALESCE(p_me.is_deleted, false) = false
      LEFT JOIN players p_all
        ON p_all.game_id = g.id
      GROUP BY
        g.id, g.join_code, g.created_by, g.status, g.max_players, g.is_public, g.created_at, g.updated_at
      ORDER BY g.updated_at DESC
      `,
      [userId]
    );

    const rows: GameSummary[] = result.rows.map((row) => {
      const status = row.status as Game['status'];
      return {
        id: row.id,
        joinCode: row.join_code ?? null,
        createdBy: row.created_by ?? null,
        status,
        maxPlayers: row.max_players,
        isPublic: row.is_public,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        playerCount: row.player_count,
        onlineCount: row.online_count,
        isOwner: row.created_by === userId,
      };
    });

    const active = rows.filter(r => r.status === 'active' || r.status === 'initialBuild');
    const setupOwned = rows.filter(r => r.status === 'setup' && r.isOwner);
    const archived = rows.filter(r => r.status === 'completed' || r.status === 'abandoned');

    return { active, setupOwned, archived };
  }

  static async deleteGame(
    gameId: string,
    requestingUserId: string,
    options: { mode: 'soft' | 'hard' | 'transfer'; newOwnerUserId?: string }
  ): Promise<void> {
    if (!gameId || gameId.trim().length === 0) {
      throw new LobbyError('gameId is required', 'MISSING_GAME_ID', 400);
    }
    if (!requestingUserId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }
    if (!options?.mode) {
      throw new LobbyError('mode is required', 'MISSING_MODE', 400);
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const gameResult = await client.query(
        'SELECT id, created_by, status FROM games WHERE id = $1',
        [gameId]
      );
      if (gameResult.rows.length === 0) {
        throw new GameNotFoundError();
      }
      const game = gameResult.rows[0] as { id: string; created_by: string | null; status: string };
      const isOwner = game.created_by === requestingUserId;

      if (options.mode === 'soft') {
        // Non-owner soft delete (hide in lobby)
        if (isOwner) {
          throw new LobbyError('Owner must use hard delete or transfer', 'INVALID_DELETE_MODE', 400);
        }
        const updateResult = await client.query(
          'UPDATE players SET is_deleted = true WHERE game_id = $1 AND user_id = $2',
          [gameId, requestingUserId]
        );
        if (updateResult.rowCount === 0) {
          throw new LobbyError('Player not found in this game', 'PLAYER_NOT_IN_GAME', 404);
        }
        await client.query('COMMIT');
        return;
      }

      // Owner-only modes below
      if (!isOwner) {
        throw new LobbyError('Only the game owner can perform this action', 'NOT_GAME_CREATOR', 403);
      }

      if (options.mode === 'hard') {
        await client.query('DELETE FROM games WHERE id = $1', [gameId]);
        await client.query('COMMIT');
        return;
      }

      // transfer
      const newOwnerUserId = options.newOwnerUserId;
      if (!newOwnerUserId) {
        throw new LobbyError('newOwnerUserId is required for transfer', 'MISSING_NEW_OWNER', 400);
      }
      if (newOwnerUserId === requestingUserId) {
        throw new LobbyError('newOwnerUserId must be different from current owner', 'INVALID_NEW_OWNER', 400);
      }

      // New owner must be a player in the game and online
      const newOwnerResult = await client.query(
        `SELECT user_id, is_online
         FROM players
         WHERE game_id = $1 AND user_id = $2 AND COALESCE(is_deleted, false) = false
         LIMIT 1`,
        [gameId, newOwnerUserId]
      );
      if (newOwnerResult.rows.length === 0) {
        throw new LobbyError('Selected new owner is not a player in this game', 'INVALID_NEW_OWNER', 400);
      }
      if (newOwnerResult.rows[0].is_online !== true) {
        throw new LobbyError('Selected new owner must be online', 'NEW_OWNER_NOT_ONLINE', 400);
      }

      await client.query(
        'UPDATE games SET created_by = $1 WHERE id = $2',
        [newOwnerUserId, gameId]
      );

      // Remove current owner's player record from the game
      await client.query(
        'DELETE FROM players WHERE game_id = $1 AND user_id = $2',
        [gameId, requestingUserId]
      );

      // If that removal leaves no players, abandon the game instead of orphaning it
      const countResult = await client.query(
        'SELECT COUNT(*)::int as count FROM players WHERE game_id = $1',
        [gameId]
      );
      if (countResult.rows[0].count === 0) {
        await client.query(
          'UPDATE games SET status = $1 WHERE id = $2',
          ['abandoned', gameId]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async bulkDeleteGames(
    requestingUserId: string,
    options: { gameIds: string[]; mode: 'soft' | 'hard' }
  ): Promise<void> {
    if (!requestingUserId) {
      throw new LobbyError('userId is required', 'MISSING_USER_ID', 400);
    }
    if (!options?.gameIds || options.gameIds.length === 0) {
      throw new LobbyError('gameIds is required', 'MISSING_GAME_IDS', 400);
    }

    // Process sequentially to keep semantics simple and predictable
    for (const gameId of options.gameIds) {
      if (options.mode === 'soft') {
        // Soft delete is always per-player hide
        await db.query(
          'UPDATE players SET is_deleted = true WHERE game_id = $1 AND user_id = $2',
          [gameId, requestingUserId]
        );
      } else {
        // Hard delete only if owner; otherwise fallback to soft delete
        const ownerResult = await db.query(
          'SELECT created_by FROM games WHERE id = $1',
          [gameId]
        );
        if (ownerResult.rows.length === 0) {
          continue;
        }
        const isOwner = ownerResult.rows[0].created_by === requestingUserId;
        if (isOwner) {
          await db.query('DELETE FROM games WHERE id = $1', [gameId]);
        } else {
          await db.query(
            'UPDATE players SET is_deleted = true WHERE game_id = $1 AND user_id = $2',
            [gameId, requestingUserId]
          );
        }
      }
    }
  }
}
