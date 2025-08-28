import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface CreateGameData {
  isPublic?: boolean;
  maxPlayers?: number;
  createdByUserId: string;
}

export interface Game {
  id: string;
  joinCode: string;
  createdBy: string;
  status: 'IN_SETUP' | 'ACTIVE' | 'COMPLETE';
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

export class LobbyService {
  /**
   * Generate a unique 6-character join code
   */
  private static generateJoinCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Create a new game
   */
  static async createGame(data: CreateGameData): Promise<Game> {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate a unique join code
      let joinCode: string;
      let attempts = 0;
      const maxAttempts = 10;
      
      do {
        joinCode = this.generateJoinCode();
        const existingGame = await client.query(
          'SELECT id FROM games WHERE join_code = $1',
          [joinCode]
        );
        
        if (existingGame.rows.length === 0) {
          break;
        }
        
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('Unable to generate unique join code');
        }
      } while (true);
      
      // Create the game
      const gameResult = await client.query(
        `INSERT INTO games (join_code, max_players, is_public, lobby_status) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id, join_code, max_players, is_public, lobby_status, created_at`,
        [joinCode, data.maxPlayers || 6, data.isPublic || false, 'IN_SETUP']
      );
      
      const game = gameResult.rows[0];
      
      // Create the first player (game creator)
      const playerResult = await client.query(
        `INSERT INTO players (game_id, user_id, name, color) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id`,
        [game.id, data.createdByUserId, 'Player 1', '#ff0000']
      );
      
      const player = playerResult.rows[0];
      
      // Update the game with the creator reference
      await client.query(
        'UPDATE games SET created_by = $1 WHERE id = $2',
        [player.id, game.id]
      );
      
      await client.query('COMMIT');
      
      return {
        id: game.id,
        joinCode: game.join_code,
        createdBy: player.id,
        status: game.lobby_status,
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
  static async joinGame(joinCode: string, userId: string): Promise<Game> {
    const client = await db.connect();
    
    try {
      // Find the game by join code
      const gameResult = await client.query(
        `SELECT g.*, p.id as creator_player_id 
         FROM games g 
         LEFT JOIN players p ON g.created_by = p.id 
         WHERE g.join_code = $1`,
        [joinCode]
      );
      
      if (gameResult.rows.length === 0) {
        throw new Error('Game not found');
      }
      
      const game = gameResult.rows[0];
      
      if (game.lobby_status !== 'IN_SETUP') {
        throw new Error('Game has already started');
      }
      
      // Check if player is already in the game
      const existingPlayer = await client.query(
        'SELECT id FROM players WHERE game_id = $1 AND user_id = $2',
        [game.id, userId]
      );
      
      if (existingPlayer.rows.length > 0) {
        // Player already in game, return game info
        return {
          id: game.id,
          joinCode: game.join_code,
          createdBy: game.creator_player_id,
          status: game.lobby_status,
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
        throw new Error('Game is full');
      }
      
      // Add player to the game
      const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
      const usedColors = await client.query(
        'SELECT color FROM players WHERE game_id = $1',
        [game.id]
      );
      
      const availableColors = colors.filter(color => 
        !usedColors.rows.some(row => row.color === color)
      );
      
      const playerColor = availableColors[0] || colors[playerCount];
      
      await client.query(
        `INSERT INTO players (game_id, user_id, name, color) 
         VALUES ($1, $2, $3, $4)`,
        [game.id, userId, `Player ${playerCount + 1}`, playerColor]
      );
      
      return {
        id: game.id,
        joinCode: game.join_code,
        createdBy: game.creator_player_id,
        status: game.lobby_status,
        maxPlayers: game.max_players,
        isPublic: game.is_public,
        createdAt: game.created_at,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get game by ID
   */
  static async getGame(gameId: string): Promise<Game | null> {
    const result = await db.query(
      `SELECT g.*, p.id as creator_player_id 
       FROM games g 
       LEFT JOIN players p ON g.created_by = p.id 
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
      createdBy: game.creator_player_id,
      status: game.lobby_status,
      maxPlayers: game.max_players,
      isPublic: game.is_public,
      createdAt: game.created_at,
    };
  }

  /**
   * Get players in a game
   */
  static async getGamePlayers(gameId: string): Promise<Player[]> {
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
      isOnline: row.is_online,
      gameId: row.game_id,
    }));
  }

  /**
   * Start a game (change status from IN_SETUP to ACTIVE)
   */
  static async startGame(gameId: string, creatorUserId: string): Promise<void> {
    const client = await db.connect();
    
    try {
      // Verify the user is the creator
      const gameResult = await client.query(
        `SELECT g.*, p.user_id as creator_user_id 
         FROM games g 
         JOIN players p ON g.created_by = p.id 
         WHERE g.id = $1`,
        [gameId]
      );
      
      if (gameResult.rows.length === 0) {
        throw new Error('Game not found');
      }
      
      const game = gameResult.rows[0];
      
      if (game.creator_user_id !== creatorUserId) {
        throw new Error('Only the game creator can start the game');
      }
      
      if (game.lobby_status !== 'IN_SETUP') {
        throw new Error('Game has already started');
      }
      
      // Check minimum players
      const playerCountResult = await client.query(
        'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
        [gameId]
      );
      
      const playerCount = parseInt(playerCountResult.rows[0].count);
      if (playerCount < 2) {
        throw new Error('Need at least 2 players to start the game');
      }
      
      // Update game status
      await client.query(
        'UPDATE games SET lobby_status = $1, status = $2 WHERE id = $3',
        ['ACTIVE', 'initialBuild', gameId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Leave a game
   */
  static async leaveGame(gameId: string, userId: string): Promise<void> {
    await db.query(
      'DELETE FROM players WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    
    // If no players left, delete the game
    const playerCountResult = await db.query(
      'SELECT COUNT(*) as count FROM players WHERE game_id = $1',
      [gameId]
    );
    
    if (parseInt(playerCountResult.rows[0].count) === 0) {
      await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    }
  }

  /**
   * Update player online status
   */
  static async updatePlayerPresence(userId: string, isOnline: boolean): Promise<void> {
    await db.query(
      'UPDATE players SET is_online = $1 WHERE user_id = $2',
      [isOnline, userId]
    );
  }
}
