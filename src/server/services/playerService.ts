import { db } from "../db/index";
import { Player, Game, GameStatus, TrainType, TRAIN_PROPERTIES } from "../../shared/types/GameTypes";
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
  camera_state: any;
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

  static async createPlayer(gameId: string, player: Player, client?: any): Promise<void> {
    // Validate and normalize color
    const normalizedColor = this.validateColor(player.color);

    // Use provided client if available (for transactions), otherwise get a new connection
    // IMPORTANT: If client is provided, it MUST be used for transaction consistency
    // Check if client is truthy and has a query method (it's a proper database client)
    let useClient: any;
    if (client && typeof client.query === 'function') {
      // Transaction client provided - use it
      useClient = client;
    } else {
      // No transaction client - use pool (but warn if client was expected)
      if (client !== undefined) {
        console.error(`PlayerService.createPlayer: Invalid client provided. Expected a database client with query() method, got:`, typeof client);
      } else {
        console.warn(`PlayerService.createPlayer: No transaction client provided. Using pool connection. This may cause foreign key issues if called within a transaction.`);
      }
      useClient = db;
    }

    // First check if another player already has this color
    // Also verify the game exists (sanity check - helps debug transaction issues)
    if (client && typeof client.query === 'function') {
      const gameCheckResult = await client.query('SELECT id FROM games WHERE id = $1', [gameId]);
      if (gameCheckResult.rows.length === 0) {
        console.error(`PlayerService.createPlayer: Game ${gameId} not found in transaction. This indicates a transaction isolation issue.`);
        throw new Error(`Game ${gameId} not found - transaction may not be properly isolated`);
      }
    }
    
    const colorCheckQuery = `
            SELECT id FROM players 
            WHERE game_id = $1 AND color = $2
        `;
    const colorCheckResult = await useClient.query(colorCheckQuery, [
      gameId,
      normalizedColor,
    ]);

    if (colorCheckResult.rows.length > 0) {
      throw new Error("Color already taken by another player");
    }

    // ALWAYS draw 3 initial cards server-side (ignore any client-provided cards)
    // Cards must be drawn server-side to ensure proper deck management and prevent duplicates
    console.log(`Drawing initial 3 cards server-side for new player ${player.id} (${player.name})`);
    const handCardIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const card = demandDeckService.drawCard();
      if (!card) {
        throw new Error(`Failed to draw initial card ${i + 1} for player ${player.id}`);
      }
      handCardIds.push(card.id);
      console.log(`Drew card ${card.id} for player ${player.id}`);
    }
    console.log(`Successfully drew ${handCardIds.length} initial cards for player ${player.id}`);

    const query = `
            INSERT INTO players (
                id, game_id, user_id, name, color, money, train_type,
                position_x, position_y, position_row, position_col,
                current_turn_number, hand, loads, camera_state
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      handCardIds,  // Use the drawn card IDs
      player.trainState.loads || [],
      player.cameraState || null
    ];
    try {
      await useClient.query(query, values);
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
                    loads = $14,
                    camera_state = $15
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
        // Ensure hand is an array and extract card IDs
        Array.isArray(player.hand) ? player.hand.map((card: any) => typeof card === 'object' && card.id ? card.id : card) : [],
        player.trainState.loads || [],
        player.cameraState || null,
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

  /**
   * Get all players for a game, with optional filtering of hand data for security
   * @param gameId - The game ID
   * @param requestingUserId - Optional user ID of the requesting user. If provided, only that user's hand will be included.
   * @returns Array of players, with hands filtered based on requestingUserId
   */
  static async getPlayers(gameId: string, requestingUserId: string): Promise<Player[]> {
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
                    loads,
                    camera_state
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

      // Log the raw hand data before processing for debugging
      console.log("Raw hand data from database:", result.rows.map(row => ({
        playerId: row.id,
        playerName: row.name,
        handIds: row.hand,
        handType: typeof row.hand,
        handLength: Array.isArray(row.hand) ? row.hand.length : 'not array',
        user_id: row.user_id
      })));

      const players = result.rows.map((row) => {
        // Security: Only include hand data for the requesting user's own player
        // If requestingUserId is provided, only show that player's hand
        // Otherwise, hide all hands (for backward compatibility, but not secure)
        let handCards: any[] = [];
        
        if (requestingUserId && row.user_id === requestingUserId) {
          // This is the requesting user's player - show their hand
          // Handle both null and empty array cases
          const handArray = row.hand || [];
          if (!Array.isArray(handArray)) {
            console.error(`Invalid hand data for player ${row.id}:`, handArray);
            handCards = [];
          } else {
            handCards = handArray.map((cardId: number) => {
              const card = demandDeckService.getCard(cardId);
              if (!card) {
                console.error(`Failed to find card with ID ${cardId} for player ${row.id}`);
                return null;
              }
              return card;
            }).filter(Boolean); // Remove any null entries
          }
          
          console.log(`Processed hand for requesting player ${row.id}:`, {
            playerName: row.name,
            handIds: handArray,
            cardCount: handCards.length,
            cards: handCards.map(c => c.id)
          });
        } else {
          // This is another player's data - hide their hand for security
          handCards = [];
          console.log(`Hidden hand for player ${row.id} (not requesting user)`);
        }

        // Cast trainType from database string to TrainType enum
        const trainType = row.trainType as TrainType;

        // Calculate remainingMovement based on train type
        // Note: This is a default value; actual remainingMovement should be managed client-side
        // or stored in the database if we want to persist it across server refreshes
        const trainProps = TRAIN_PROPERTIES[trainType];
        const defaultMovement = trainProps ? trainProps.speed : 9; // Fallback to 9 if train type is invalid

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
            remainingMovement: defaultMovement, // Calculate based on train type instead of hardcoding
            loads: row.loads || [],
          },
          hand: handCards,
          cameraState: row.camera_state || undefined,  // Per-player camera state
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
      // Get the player ID for the current player (internal query - doesn't need hand data)
      // Query players in same order as getPlayers (no explicit ORDER BY, but we'll use created_at for consistency)
      const playerQuery = await db.query(
        'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at LIMIT 1 OFFSET $2',
        [gameId, currentPlayerIndex]
      );
      // Validate that we have a valid player at this index
      if (playerQuery.rows && playerQuery.rows.length > 0 && currentPlayerIndex >= 0) {
        const currentPlayerId = playerQuery.rows[0]?.id;
        const { emitTurnChange } = await import('./socketService');
        emitTurnChange(gameId, currentPlayerIndex, currentPlayerId);
      } else {
        console.warn(`No player found at index ${currentPlayerIndex} for game ${gameId}`);
      }
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
    // If there are other active games, set them to 'completed' (only one active game at a time)
    if (result.rows.length > 0) {
        const keepActiveId = result.rows[0].id;
        await db.query(
            `UPDATE games 
             SET status = 'completed' 
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
    // Validate status is lowercase and matches database constraint
    // Database constraint allows: 'setup', 'initialBuild', 'active', 'completed'
    const allowedStatuses = ['setup', 'initialBuild', 'active', 'completed'];
    const normalizedStatus = status.toLowerCase();
    
    let finalStatus: string;
    if (!allowedStatuses.includes(normalizedStatus)) {
      // If status is not in the allowed list, default to 'completed' for safety
      console.warn(`PlayerService.updateGameStatus: Status '${status}' not allowed. Valid values: ${allowedStatuses.join(', ')}. Using 'completed'.`);
      finalStatus = 'completed';
    } else {
      finalStatus = normalizedStatus;
    }
    
    // If setting a game to active, complete any other active games first
    if (finalStatus === "active") {
      await this.endAllActiveGames();
    }

    const query = `
            UPDATE games 
            SET status = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;
    await db.query(query, [finalStatus, gameId]);
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
