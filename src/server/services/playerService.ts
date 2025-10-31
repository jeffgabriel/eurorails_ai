import { db } from "../db/index";
import { Player, Game, GameStatus, TrainType } from "../../shared/types/GameTypes";
import { QueryResult } from "pg";
import { v4 as uuidv4 } from "uuid";
import { demandDeckService } from "./demandDeckService";

interface PlayerRow {
  id: string;
  user_id: string | null;
  name: string;
  color: string;
  money: number;
  train_type: string;
  position_x: number | null;
  position_y: number | null;
  position_row: number | null;
  position_col: number | null;
  loads: string[];
}

export class PlayerService {
  private static validateColor(color: string): string {
    // Ensure color is a valid hex code
    const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;
    if (!hexColorRegex.test(color)) {
      throw new Error(
        "Invalid color format. Must be a hex color code (e.g., #ff0000)"
      );
    }
    return color.toLowerCase(); // Normalize to lowercase
  }

  static async gameExists(gameId: string): Promise<boolean> {
    const query = "SELECT id FROM games WHERE id = $1";
    const result = await db.query(query, [gameId]);
    return result.rows.length > 0;
  }

  static async playerExists(
    gameId: string,
    playerId: string
  ): Promise<boolean> {
    const query = "SELECT id FROM players WHERE game_id = $1 AND id = $2";
    const result = await db.query(query, [gameId, playerId]);
    return result.rows.length > 0;
  }

  static async createGame(gameId: string): Promise<void> {
    const query = `
            INSERT INTO games (id, status)
            VALUES ($1, 'setup')
            ON CONFLICT (id) DO NOTHING
        `;
    await db.query(query, [gameId]);
  }

  static async createPlayer(gameId: string, player: Player): Promise<void> {
    // Validate and normalize color
    const normalizedColor = this.validateColor(player.color);

    // First check if another player already has this color
    const colorCheckQuery = `
            SELECT id FROM players 
            WHERE game_id = $1 AND color = $2
        `;
    const colorCheckResult = await db.query(colorCheckQuery, [
      gameId,
      normalizedColor,
    ]);

    if (colorCheckResult.rows.length > 0) {
      throw new Error("Color already taken by another player");
    }

    const query = `
            INSERT INTO players (
                id, game_id, user_id, name, color, money, train_type,
                position_x, position_y, position_row, position_col,
                current_turn_number, hand, loads
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `;
    const values = [
      player.id,
      gameId,
      player.userId || null,  // Include userId if provided
      player.name,
      normalizedColor,
      typeof player.money === "number" ? player.money : 50,
      player.trainType || TrainType.Freight,
      player.trainState.position?.x || null,
      player.trainState.position?.y || null,
      player.trainState.position?.row || null,
      player.trainState.position?.col || null,
      player.turnNumber || 1,
      player.hand.map(card => card.id),
      player.trainState.loads || []
    ];
    try {
      await db.query(query, values);
    } catch (err: any) {
      if (
        err.code === "23505" &&
        err.constraint === "players_game_id_color_key"
      ) {
        throw new Error("Color already taken by another player");
      }
      throw err;
    }
  }

  static async updatePlayer(gameId: string, player: Player): Promise<void> {
    console.log("Starting database update for player:", { gameId, player });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      console.log("Started transaction");

      // Validate and normalize color
      const normalizedColor = this.validateColor(player.color);

      // Check if game exists, create if it doesn't
      const gameExists = await this.gameExists(gameId);
      if (!gameExists) {
        console.log("Game does not exist, creating new game");
        await this.createGame(gameId);
      }

      // Check if player exists
      const exists = await this.playerExists(gameId, player.id);
      console.log("Player exists check:", {
        exists,
        gameId,
        playerId: player.id,
      });

      if (!exists) {
        console.log("Player does not exist, creating new player");
        await this.createPlayer(gameId, player);
        await client.query("COMMIT");
        console.log("Successfully created new player");
        return;
      }

      // First check if another player already has this color
      const colorCheckQuery = `
                SELECT id FROM players 
                WHERE game_id = $1 AND color = $2 AND id != $3
            `;
      const colorCheckValues = [gameId, normalizedColor, player.id];
      const colorCheckResult: QueryResult<PlayerRow> = await client.query(
        colorCheckQuery,
        colorCheckValues
      );

      if (colorCheckResult.rows.length > 0) {
        throw new Error("Color already taken by another player");
      }

      // Normalize the train type to match database format
      const trainType = player.trainType || TrainType.Freight;

      const query = `
                UPDATE players 
                SET name = $1, 
                    user_id = $2,
                    color = $3, 
                    money = $4, 
                    train_type = $5,
                    position_x = $6,
                    position_y = $7,
                    position_row = $8,
                    position_col = $9,
                    current_turn_number = $12,
                    hand = $13,
                    loads = $14
                WHERE game_id = $10 AND id = $11
                RETURNING *
            `;
      // Determine money value with proper type checking
      const moneyValue = typeof player.money === "number" ? player.money : 50;

      const values = [
        player.name,
        player.userId || null,  // Include userId if provided
        normalizedColor,
        moneyValue,
        trainType,
        player.trainState.position?.x
          ? Math.round(player.trainState.position.x)
          : null,
        player.trainState.position?.y
          ? Math.round(player.trainState.position.y)
          : null,
        player.trainState.position?.row
          ? Math.round(player.trainState.position.row)
          : null,
        player.trainState.position?.col
          ? Math.round(player.trainState.position.col)
          : null,
        gameId,
        player.id,
        player.turnNumber,
        player.hand.map(card => card.id),
        player.trainState.loads || [],
      ];
      console.log("Executing update query");

      const result: QueryResult<PlayerRow> = await client.query(query, values);
      console.log("Update result:", {
        rowCount: result.rowCount,
        row: result.rows[0],
      });

      if (result.rows.length === 0) {
        throw new Error("Player update failed");
      }

      if (
        player.trainState.movementHistory &&
        player.trainState.movementHistory.length > 0
      ) {
        const movement_query = `
                    INSERT INTO movement_history (player_id, movement_path, turn_number)
                    VALUES ($1, $2, $3)
                `;
        const movement_values = [
          player.id,
          JSON.stringify(player.trainState.movementHistory),
          player.turnNumber,
        ];
        await client.query(movement_query, movement_values);
      }

      await client.query("COMMIT");
      console.log("Transaction committed successfully");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Database error during player update:", err);

      // Enhance error messages for common issues
      if (err instanceof Error) {
        if (err.message.includes("players_color_check")) {
          throw new Error(
            "Invalid color format. Must be a hex color code (e.g., #ff0000)"
          );
        }
        if (err.message.includes("players_game_id_color_key")) {
          throw new Error("Color already taken by another player");
        }
      }
      throw err;
    } finally {
      client.release();
      console.log("Database connection released");
    }
  }

  static async deletePlayer(gameId: string, playerId: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // First delete the player's movement history
      const deleteMovementHistoryQuery =
        "DELETE FROM movement_history WHERE player_id = $1";
      await client.query(deleteMovementHistoryQuery, [playerId]);

      // First delete the player's tracks
      const deleteTracksQuery =
        "DELETE FROM player_tracks WHERE player_id = $1";
      await client.query(deleteTracksQuery, [playerId]);

      // Then delete the player
      const deletePlayerQuery =
        "DELETE FROM players WHERE game_id = $1 AND id = $2";
      await client.query(deletePlayerQuery, [gameId, playerId]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  static async getPlayers(gameId: string): Promise<Player[]> {
    console.log("Starting database query for players:", { gameId });
    const client = await db.connect();
    try {
      const query = `
                SELECT 
                    players.id, 
                    user_id,
                    name, 
                    color, 
                    money, 
                    train_type as "trainType",
                    position_x,
                    position_y,
                    position_row,
                    position_col,
                    current_turn_number as "turnNumber",
                    mh.movement_path as "movementHistory",
                    hand,
                    loads
                FROM players 
                LEFT JOIN LATERAL (
                    SELECT movement_path 
                    FROM movement_history 
                    WHERE player_id = players.id 
                    ORDER BY id DESC 
                    LIMIT 1
                ) mh ON true
                WHERE players.game_id = $1
            `;
      const values = [gameId];
      console.log("Executing select query:", { query, values });

      const result = await client.query(query, values);
      // console.log("Query result:", {
      //   rowCount: result.rowCount,
      //   firstRow: result.rows[0]
      //     ? {
      //         id: result.rows[0].id,
      //         name: result.rows[0].name,
      //         color: result.rows[0].color,
      //         hasMovementHistory: !!result.rows[0].movementHistory,
      //       }
      //     : null,
      // });

      // // Log the raw hand data before processing
      // console.log("Raw hand data from database:", result.rows.map(row => ({
      //   playerId: row.id,
      //   handIds: row.hand
      // })));

      const players = result.rows.map((row) => {
        // Convert hand IDs to actual cards, with better error handling
        const handCards = row.hand ? row.hand.map((cardId: number) => {
          const card = demandDeckService.getCard(cardId);
          if (!card) {
            console.error(`Failed to find card with ID ${cardId} for player ${row.id}`);
            return null;
          }
          return card;
        }).filter(Boolean) : []; // Remove any null entries

        // Log the processed hand data
        console.log(`Processed hand for player ${row.id}:`, handCards);

        // Cast trainType from database string to TrainType enum
        const trainType = row.trainType as TrainType;

        return {
          ...row,
          userId: row.user_id || undefined,  // Map user_id to userId (optional for backward compatibility)
          trainType,
          trainState: {
            position:
              row.position_x !== null
                ? {
                    x: row.position_x,
                    y: row.position_y,
                    row: row.position_row,
                    col: row.position_col,
                  }
                : undefined,
            turnNumber: row.turnNumber || 1,
            movementHistory: row.movementHistory ? row.movementHistory : [],
            remainingMovement: 9, // Default to 9 for Freight trains
            loads: row.loads || [],
          },
          hand: handCards,
        };
      });

      console.log("Processed players:", {
        count: players.length,
        playerIds: players.map((p) => p.id),
        samplePlayer: players[0]
          ? {
              id: players[0].id,
              hasPosition: !!players[0].trainState.position,
              hasMovementHistory:
                players[0].trainState.movementHistory.length > 0,
              handSize: players[0].hand.length,
              handExample: players[0].hand[0],
            }
          : null,
      });

      return players;
    } catch (err) {
      console.error("Database error during players query:", err);
      throw err;
    } finally {
      client.release();
      console.log("Database connection released");
    }
  }

  static async initializeDefaultGame(): Promise<string> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Create a default game with UUID
      const gameId = uuidv4();
      const createGameQuery = `
                INSERT INTO games (id, status)
                VALUES ($1, 'setup')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            `;
      await client.query(createGameQuery, [gameId]);

      // Create a default player
      const defaultPlayer = {
        id: uuidv4(),
        name: "Player 1",
        color: "#ff0000",
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: { x: 0, y: 0, row: 0, col: 0 },
          movementHistory: [],
          remainingMovement: 9,
        },
        hand: [],
        loads: [],
      };

      const createPlayerQuery = `
                INSERT INTO players (
                    id, game_id, name, color, money, train_type,
                    position_x, position_y, position_row, position_col,
                    current_turn_number, hand, loads
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (id) DO NOTHING
            `;
      await client.query(createPlayerQuery, [
        defaultPlayer.id,
        gameId,
        defaultPlayer.name,
        defaultPlayer.color,
        defaultPlayer.money,
        defaultPlayer.trainType,
        null,
        null,
        null,
        null,
        null,
        defaultPlayer.hand,
        defaultPlayer.loads || []
      ]);

      await client.query("COMMIT");
      return gameId;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error initializing default game:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async updateCurrentPlayerIndex(
    gameId: string,
    currentPlayerIndex: number
  ): Promise<void> {
    const query = `
            UPDATE games 
            SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;
    await db.query(query, [currentPlayerIndex, gameId]);
    
    // Emit turn change event to all clients in the game room
    const { getSocketIO } = await import('./socketService');
    const io = getSocketIO();
    if (io) {
      // Get the player ID for the current player
      const players = await this.getPlayers(gameId);
      const currentPlayer = players[currentPlayerIndex];
      const { emitTurnChange } = await import('./socketService');
      emitTurnChange(gameId, currentPlayerIndex, currentPlayer?.id);
    }
  }

  static async getGameState(
    gameId: string
  ): Promise<{ currentPlayerIndex: number }> {
    const query = `
            SELECT current_player_index
            FROM games
            WHERE id = $1
        `;
    const result = await db.query(query, [gameId]);
    if (result.rows.length === 0) {
      throw new Error("Game not found");
    }
    return {
      currentPlayerIndex: result.rows[0].current_player_index,
    };
  }

  static async getActiveGame(): Promise<{ id: string; status: string; currentPlayerIndex: number; cameraState?: any } | null> {
    const query = `
        SELECT id, status, current_player_index, camera_state
        FROM games 
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
    `;
    const result = await db.query(query);
    if (result.rows.length === 0) {
        return null;
    }
    // If there are other active games, set them to 'interrupted'
    if (result.rows.length > 0) {
        const keepActiveId = result.rows[0].id;
        await db.query(
            `UPDATE games 
             SET status = 'interrupted' 
             WHERE status = 'active' 
             AND id != $1`,
            [keepActiveId]
        );
    }
    return {
        id: result.rows[0].id,
        status: result.rows[0].status,
        currentPlayerIndex: result.rows[0].current_player_index,
        cameraState: result.rows[0].camera_state
    };
  }

  static async updateGameStatus(
    gameId: string,
    status: GameStatus
  ): Promise<void> {
    // If setting a game to active, complete any other active games first
    if (status === "active") {
      await this.endAllActiveGames();
    }

    const query = `
            UPDATE games 
            SET status = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;
    await db.query(query, [status, gameId]);
  }

  static async endAllActiveGames(): Promise<void> {
    const query = `
            UPDATE games 
            SET status = 'completed', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'active'
        `;
    await db.query(query);
  }

  static async getGameStatus(gameId: string): Promise<GameStatus> {
    const query = "SELECT status FROM games WHERE id = $1";
    const result = await db.query(query, [gameId]);
    return result.rows[0]?.status || "completed";
  }

  static async fulfillDemand(
    gameId: string,
    playerId: string,
    city: string,
    loadType: string,
    cardId: number
  ): Promise<{ newCard: any }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Get the player's current state
      const playerQuery = `
        SELECT hand, loads
        FROM players
        WHERE game_id = $1 AND id = $2
      `;
      const playerResult = await client.query(playerQuery, [gameId, playerId]);
      if (playerResult.rows.length === 0) {
        throw new Error('Player not found');
      }

      const player = playerResult.rows[0];
      
      // Draw a new card from the deck first
      const newCard = await demandDeckService.drawCard();
      if (!newCard) {
        throw new Error('Failed to draw new card');
      }
      
      // Create the new hand by replacing the fulfilled card with the new card
      const newHand = player.hand.map(id => id === cardId ? newCard.id : id);

      // Update player's hand in database
      const updateQuery = `
        UPDATE players
        SET hand = $1
        WHERE game_id = $2 AND id = $3
      `;
      await client.query(updateQuery, [newHand, gameId, playerId]);

      await client.query('COMMIT');
      
      return { newCard };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
