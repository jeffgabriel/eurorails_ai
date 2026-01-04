import { db } from "../db/index";
import { Player, Game, GameStatus, TrainType, TRAIN_PROPERTIES } from "../../shared/types/GameTypes";
import { QueryResult } from "pg";
import { v4 as uuidv4 } from "uuid";
import { demandDeckService } from "./demandDeckService";
import { TrackService } from "./trackService";
import { DemandCard } from "../../shared/types/DemandCard";
import { LoadType } from "../../shared/types/LoadTypes";
import { computeTrackUsageForMove } from "../../shared/services/trackUsageFees";

type TurnActionDeliver = {
  kind: "deliver";
  city: string;
  loadType: LoadType;
  cardIdUsed: number;
  newCardIdDrawn: number;
  payment: number;
};

type TurnActionMove = {
  kind: "move";
  from: { row: number; col: number; x?: number; y?: number } | null;
  to: { row: number; col: number; x?: number; y?: number };
  ownersPaid: Array<{ playerId: string; amount: number }>;
  feeTotal: number;
};

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
  private static normalizeTrainType(raw: unknown): TrainType {
    const s = String(raw ?? "").toLowerCase();
    const compact = s.replace(/[\s_-]+/g, "");
    switch (compact) {
      case "freight":
        return TrainType.Freight;
      case "fastfreight":
        return TrainType.FastFreight;
      case "heavyfreight":
        return TrainType.HeavyFreight;
      case "superfreight":
        return TrainType.Superfreight;
      default:
        return TrainType.Freight;
    }
  }

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

  /**
   * Verify that a user is a player in the specified game
   * @param gameId - The game ID
   * @param userId - The user ID
   * @returns true if the user is a player in the game, false otherwise
   */
  static async isUserPlayerInGame(gameId: string, userId: string): Promise<boolean> {
    const query = "SELECT id FROM players WHERE game_id = $1 AND user_id = $2";
    const result = await db.query(query, [gameId, userId]);
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
        // In tests we often create players without explicit transactions; avoid log spam in Jest.
        if (process.env.NODE_ENV !== 'test') {
          console.warn(
            `PlayerService.createPlayer: No transaction client provided. Using pool connection. This may cause foreign key issues if called within a transaction.`
          );
        }
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
    const handCardIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const card = demandDeckService.drawCard();
      if (!card) {
        throw new Error(`Failed to draw initial card ${i + 1} for player ${player.id}`);
      }
      handCardIds.push(card.id);
    }

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
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Validate and normalize color
      const normalizedColor = this.validateColor(player.color);

      // Check if game exists, create if it doesn't
      const gameExists = await this.gameExists(gameId);
      if (!gameExists) {
        await this.createGame(gameId);
      }

      // Check if player exists
      const exists = await this.playerExists(gameId, player.id);

      if (!exists) {
        await this.createPlayer(gameId, player);
        await client.query("COMMIT");
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

      // Get current position from database to preserve it if not provided in update
      const currentPlayerQuery = await client.query(
        'SELECT position_x, position_y, position_row, position_col FROM players WHERE game_id = $1 AND id = $2',
        [gameId, player.id]
      );
      const currentPosition = currentPlayerQuery.rows[0];
      
      // Only update position if it's explicitly provided (not null/undefined)
      // This allows partial updates (e.g., updating loads without affecting position)
      const positionX = player.trainState?.position?.x !== undefined && player.trainState.position !== null
        ? Math.round(player.trainState.position.x)
        : (currentPosition?.position_x ?? null);
      const positionY = player.trainState?.position?.y !== undefined && player.trainState.position !== null
        ? Math.round(player.trainState.position.y)
        : (currentPosition?.position_y ?? null);
      const positionRow = player.trainState?.position?.row !== undefined && player.trainState.position !== null
        ? Math.round(player.trainState.position.row)
        : (currentPosition?.position_row ?? null);
      const positionCol = player.trainState?.position?.col !== undefined && player.trainState.position !== null
        ? Math.round(player.trainState.position.col)
        : (currentPosition?.position_col ?? null);

      const values = [
        player.name,
        player.userId || null,  // Include userId if provided
        normalizedColor,
        moneyValue,
        trainType,
        positionX,
        positionY,
        positionRow,
        positionCol,
        gameId,
        player.id,
        player.turnNumber,
        // Ensure hand is an array and extract card IDs
        Array.isArray(player.hand) ? player.hand.map((card: any) => typeof card === 'object' && card.id ? card.id : card) : [],
        player.trainState.loads || [],
        player.cameraState || null,
      ];

      const result: QueryResult<PlayerRow> = await client.query(query, values);

      if (result.rows.length === 0) {
        throw new Error("Player update failed");
      }

      if (
        player.trainState.movementHistory &&
        player.trainState.movementHistory.length > 0
      ) {
        // Update existing movement history for this turn, or insert if it doesn't exist
        // This ensures we maintain cumulative movement history across the turn
        // First, try to update existing entry for this turn
        const update_query = `
                    UPDATE movement_history
                    SET movement_path = $2, updated_at = CURRENT_TIMESTAMP
                    WHERE player_id = $1 AND turn_number = $3
                `;
        const movement_values = [
          player.id,
          JSON.stringify(player.trainState.movementHistory),
          player.turnNumber,
        ];
        
        // Try to update first
        const updateResult = await client.query(update_query, movement_values);
        
        // If no row was updated, insert a new one
        if (updateResult.rowCount === 0) {
          const insert_query = `
                      INSERT INTO movement_history (player_id, movement_path, turn_number, game_id)
                      VALUES ($1, $2, $3, $4)
                  `;
          const insert_values = [
            player.id,
            JSON.stringify(player.trainState.movementHistory),
            player.turnNumber,
            gameId,
          ];
          await client.query(insert_query, insert_values);
        }
      }

      await client.query("COMMIT");
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
                ORDER BY players.created_at ASC
            `;
      const values = [gameId];

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
              // Reconcile in-memory deck state after server restarts:
              // ensure cards present in DB hands are considered dealt and removed from draw/discard piles.
              demandDeckService.ensureCardIsDealt(cardId);
              const card = demandDeckService.getCard(cardId);
              if (!card) {
                console.error(`Failed to find card with ID ${cardId} for player ${row.id}`);
                return null;
              }
              return card;
            }).filter(Boolean); // Remove any null entries
          }
        } else {
          // This is another player's data - hide their hand for security
          handCards = [];
        }

        // Normalize trainType from database (legacy values like "Freight" may exist)
        const trainType = this.normalizeTrainType(row.trainType);

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

      return players;
    } catch (err) {
      console.error("Database error during players query:", err);
      throw err;
    } finally {
      client.release();
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
      // Query players in same order as getPlayers (ORDER BY created_at ASC for consistency)
      const playerQuery = await db.query(
        'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
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
    // Database constraint allows: 'setup', 'initialBuild', 'active', 'completed', 'abandoned'
    const allowedStatuses = ['setup', 'initialBuild', 'active', 'completed', 'abandoned'];
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

  /**
   * Deliver a load for the authenticated user's player.
   *
   * Server-authoritative:
   * - Validate it's the player's turn
   * - Validate the specified card is in the player's hand and matches the delivery (city + loadType)
   * - Validate the load is currently being carried
   * - Compute payment from server demand card data (do not trust client payment)
   * - Update money, loads, and hand atomically (transaction)
   */
  static async deliverLoadForUser(
    gameId: string,
    userId: string,
    city: string,
    loadType: LoadType,
    cardId: number
  ): Promise<{ payment: number; updatedMoney: number; updatedLoads: LoadType[]; newCard: DemandCard }> {
    const client = await db.connect();
    let drewCardId: number | null = null;
    let discardedCardId: number | null = null;
    try {
      await client.query("BEGIN");

      const playerRowResult = await client.query(
        `SELECT id, money, hand, loads, current_turn_number as "turnNumber"
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const playerId: string = playerRowResult.rows[0].id as string;
      const currentMoney: number = playerRowResult.rows[0].money as number;
      const currentHand: unknown = playerRowResult.rows[0].hand;
      const currentLoads: unknown = playerRowResult.rows[0].loads;
      const turnNumber: number = Number(playerRowResult.rows[0].turnNumber ?? 1);

      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const loads: LoadType[] = Array.isArray(currentLoads)
        ? (currentLoads as unknown[]).filter((v): v is LoadType => typeof v === "string") as LoadType[]
        : [];

      const gameRow = await client.query(
        `SELECT current_player_index
         FROM games
         WHERE id = $1
         LIMIT 1
         FOR UPDATE`,
        [gameId]
      );
      if (gameRow.rows.length === 0) {
        throw new Error("Game not found");
      }
      const currentPlayerIndex = Number(gameRow.rows[0].current_player_index ?? 0);
      const currentPlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, currentPlayerIndex]
      );
      const activePlayerId = currentPlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      if (!handIds.includes(cardId)) {
        throw new Error("Demand card not in hand");
      }

      const demandCard = demandDeckService.getCard(cardId);
      if (!demandCard) {
        throw new Error("Invalid demand card");
      }

      const matchingDemand = demandCard.demands.find(
        (d) => d.city === city && d.resource === loadType
      );
      if (!matchingDemand) {
        throw new Error("Demand does not match delivery");
      }

      const loadIndex = loads.indexOf(loadType);
      if (loadIndex === -1) {
        throw new Error("Load not on train");
      }
      const updatedLoads = [...loads];
      updatedLoads.splice(loadIndex, 1);

      const payment = matchingDemand.payment;
      if (typeof payment !== "number" || !Number.isFinite(payment) || payment < 0) {
        throw new Error("Invalid payment");
      }

      const newCard = demandDeckService.drawCard();
      if (!newCard) {
        throw new Error("Failed to draw new card");
      }
      drewCardId = newCard.id;

      const updatedHandIds = handIds.map((id) => (id === cardId ? newCard.id : id));
      const updatedMoney = currentMoney + payment;

      await client.query(
        `UPDATE players
         SET money = $1, hand = $2, loads = $3
         WHERE game_id = $4 AND id = $5`,
        [updatedMoney, updatedHandIds, updatedLoads, gameId, playerId]
      );

      // Discard the fulfilled demand card into the deck discard pile.
      // This prevents it from re-entering the draw pile until a reshuffle.
      demandDeckService.discardCard(cardId);
      discardedCardId = cardId;

      // Persist server-authored action log for this turn (used for undo).
      const deliverAction: TurnActionDeliver = {
        kind: "deliver",
        city,
        loadType,
        cardIdUsed: cardId,
        newCardIdDrawn: newCard.id,
        payment,
      };
      await client.query(
        `
          INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (player_id, game_id, turn_number)
          DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP
        `,
        [playerId, gameId, turnNumber, JSON.stringify([deliverAction])]
      );

      await client.query("COMMIT");
      return { payment, updatedMoney, updatedLoads, newCard };
    } catch (error) {
      await client.query("ROLLBACK");
      // Best-effort compensation for in-memory deck mutations.
      // If we drew a replacement card, return it to the top of the draw pile.
      if (typeof drewCardId === "number") {
        try {
          demandDeckService.returnDealtCardToTop(drewCardId);
        } catch {
          // ignore
        }
      }
      // If we discarded the fulfilled card, try to return it to dealt so it isn't lost.
      if (typeof discardedCardId === "number") {
        try {
          demandDeckService.returnDiscardedCardToDealt(discardedCardId);
        } catch {
          // ignore
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move a train for the authenticated user's player and settle opponent track-usage fees.
   *
   * Important constraints:
   * - This endpoint is NOT fully server-authoritative on movement legality (movement points, reversal, ferry).
   * - It IS server-authoritative on: turn ownership, fee calculation, affordability, and money transfers.
   *
   * Fee rule:
   * - ECU 4M per distinct opponent whose track is used at any point in the turn.
   * - We therefore charge only for opponents that have NOT already been paid earlier in the same turn.
   */
  static async moveTrainForUser(args: {
    gameId: string;
    userId: string;
    to: { row: number; col: number; x?: number; y?: number };
  }): Promise<{
    feeTotal: number;
    ownersUsed: string[];
    ownersPaid: Array<{ playerId: string; amount: number }>;
    affectedPlayerIds: string[];
    updatedPosition: { row: number; col: number; x?: number; y?: number };
    updatedMoney: number;
  }> {
    const { gameId, userId, to } = args;
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const playerRowResult = await client.query(
        `SELECT id, money, position_row, position_col, position_x, position_y, current_turn_number as "turnNumber"
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const playerId: string = playerRowResult.rows[0].id as string;
      const currentMoney: number = Number(playerRowResult.rows[0].money ?? 0);
      const turnNumber: number = Number(playerRowResult.rows[0].turnNumber ?? 1);

      const fromRow = playerRowResult.rows[0].position_row;
      const fromCol = playerRowResult.rows[0].position_col;
      const fromX = playerRowResult.rows[0].position_x;
      const fromY = playerRowResult.rows[0].position_y;
      const from =
        fromRow != null && fromCol != null
          ? {
              row: Number(fromRow),
              col: Number(fromCol),
              x: fromX != null && Number.isFinite(Number(fromX)) ? Number(fromX) : undefined,
              y: fromY != null && Number.isFinite(Number(fromY)) ? Number(fromY) : undefined,
            }
          : null;

      // Validate game exists + determine whose turn it is
      const gameRow = await client.query(
        `SELECT current_player_index
         FROM games
         WHERE id = $1
         LIMIT 1
         FOR UPDATE`,
        [gameId]
      );
      if (gameRow.rows.length === 0) {
        throw new Error("Game not found");
      }
      const currentPlayerIndex = Number(gameRow.rows[0].current_player_index ?? 0);
      const currentPlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, currentPlayerIndex]
      );
      const activePlayerId = currentPlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      // Lock action log row for this turn (if it exists) so we can safely compute already-paid opponents.
      const actionsResult = await client.query(
        `SELECT actions
         FROM turn_actions
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3
         FOR UPDATE`,
        [playerId, gameId, turnNumber]
      );
      const actionsJson = actionsResult.rows[0]?.actions;
      const actions: any[] = Array.isArray(actionsJson) ? actionsJson : (actionsJson ? (actionsJson as any) : []);
      const alreadyPaid = new Set<string>();
      for (const act of Array.isArray(actions) ? actions : []) {
        if (act?.kind !== "move") continue;
        const ownersPaid = Array.isArray(act.ownersPaid) ? act.ownersPaid : [];
        for (const p of ownersPaid) {
          const pid = typeof p?.playerId === "string" ? p.playerId : null;
          if (pid) alreadyPaid.add(pid);
        }
      }

      // Compute owners used for this move. If this is the first placement (no from), no fees.
      let ownersUsed: string[] = [];
      if (from && (from.row !== to.row || from.col !== to.col)) {
        const allTracks = await TrackService.getAllTracks(gameId);
        const usage = computeTrackUsageForMove({
          allTracks,
          from: { row: from.row, col: from.col },
          to: { row: to.row, col: to.col },
          currentPlayerId: playerId,
        });
        if (!usage.isValid) {
          throw new Error(usage.errorMessage || "Invalid move");
        }
        ownersUsed = Array.from(usage.ownersUsed);
      }

      const newlyPayable = ownersUsed.filter((pid) => !alreadyPaid.has(pid));
      const ownersPaid: Array<{ playerId: string; amount: number }> = newlyPayable.map((pid) => ({
        playerId: pid,
        amount: 4,
      }));
      const feeTotal = ownersPaid.reduce((sum, p) => sum + p.amount, 0);

      if (feeTotal > 0 && currentMoney < feeTotal) {
        throw new Error("Insufficient funds for track usage fees");
      }

      // Apply money transfers (payer -> payees)
      if (feeTotal > 0) {
        await client.query(
          `UPDATE players
           SET money = money - $1
           WHERE game_id = $2 AND id = $3`,
          [feeTotal, gameId, playerId]
        );

        for (const payee of ownersPaid) {
          await client.query(
            `UPDATE players
             SET money = money + $1
             WHERE game_id = $2 AND id = $3`,
            [payee.amount, gameId, payee.playerId]
          );
        }
      }

      // Persist new position (server stores row/col and best-effort x/y if provided)
      await client.query(
        `UPDATE players
         SET position_row = $1,
             position_col = $2,
             position_x = $3,
             position_y = $4
         WHERE game_id = $5 AND id = $6`,
        [
          Math.round(to.row),
          Math.round(to.col),
          typeof to.x === "number" ? Math.round(to.x) : null,
          typeof to.y === "number" ? Math.round(to.y) : null,
          gameId,
          playerId,
        ]
      );

      // Record server-authored action log for this turn (used for undo and for "already paid" tracking)
      const moveAction: TurnActionMove = {
        kind: "move",
        from: from ? { row: from.row, col: from.col, x: from.x, y: from.y } : null,
        to: { row: to.row, col: to.col, x: to.x, y: to.y },
        ownersPaid,
        feeTotal,
      };
      await client.query(
        `
          INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (player_id, game_id, turn_number)
          DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP
        `,
        [playerId, gameId, turnNumber, JSON.stringify([moveAction])]
      );

      await client.query("COMMIT");

      const affectedPlayerIds = [playerId, ...ownersPaid.map((p) => p.playerId)];
      return {
        feeTotal,
        ownersUsed,
        ownersPaid,
        affectedPlayerIds,
        updatedPosition: { row: to.row, col: to.col, x: to.x, y: to.y },
        updatedMoney: currentMoney - feeTotal,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Undo the last server-tracked action for the authenticated user's player.
   * Supports undoing the most recent delivery OR move this turn.
   */
  static async undoLastActionForUser(
    gameId: string,
    userId: string
  ): Promise<
    | { kind: "deliver"; updatedMoney: number; updatedLoads: LoadType[]; restoredCard: DemandCard; removedCardId: number }
    | { kind: "move"; updatedMoney: number; restoredPosition: { row: number; col: number; x?: number; y?: number }; ownersReversed: Array<{ playerId: string; amount: number }>; feeTotal: number }
  > {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const playerRowResult = await client.query(
        `SELECT id, money, hand, loads, current_turn_number as "turnNumber", position_row, position_col, position_x, position_y
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const playerId: string = playerRowResult.rows[0].id as string;
      const currentMoney: number = playerRowResult.rows[0].money as number;
      const currentHand: unknown = playerRowResult.rows[0].hand;
      const currentLoads: unknown = playerRowResult.rows[0].loads;
      const turnNumber: number = Number(playerRowResult.rows[0].turnNumber ?? 1);

      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const loads: LoadType[] = Array.isArray(currentLoads)
        ? (currentLoads as unknown[]).filter((v): v is LoadType => typeof v === "string") as LoadType[]
        : [];

      const gameRow = await client.query(
        `SELECT current_player_index
         FROM games
         WHERE id = $1
         LIMIT 1
         FOR UPDATE`,
        [gameId]
      );
      if (gameRow.rows.length === 0) {
        throw new Error("Game not found");
      }
      const currentPlayerIndex = Number(gameRow.rows[0].current_player_index ?? 0);
      const currentPlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, currentPlayerIndex]
      );
      const activePlayerId = currentPlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      const actionsResult = await client.query(
        `SELECT actions
         FROM turn_actions
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3
         FOR UPDATE`,
        [playerId, gameId, turnNumber]
      );
      const actionsJson = actionsResult.rows[0]?.actions;
      const actions: any[] = Array.isArray(actionsJson) ? actionsJson : (actionsJson ? (actionsJson as any) : []);
      if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error("No undoable actions");
      }

      const last = actions[actions.length - 1] as (TurnActionDeliver | TurnActionMove | any);
      if (!last || (last.kind !== "deliver" && last.kind !== "move")) {
        throw new Error("Last action is not undoable");
      }

      if (last.kind === "move") {
        const from = last.from as any;
        const ownersPaid = Array.isArray(last.ownersPaid) ? last.ownersPaid : [];
        const feeTotal = Number(last.feeTotal ?? 0);

        if (!from || typeof from.row !== "number" || typeof from.col !== "number") {
          throw new Error("Invalid move action");
        }

        // Reverse money transfers (payees lose, payer gains)
        const ownersReversed: Array<{ playerId: string; amount: number }> = [];
        for (const p of ownersPaid) {
          const pid = typeof p?.playerId === "string" ? p.playerId : null;
          const amt = Number(p?.amount ?? 0);
          if (!pid || !Number.isFinite(amt) || amt <= 0) continue;
          ownersReversed.push({ playerId: pid, amount: amt });
        }

        if (feeTotal > 0) {
          await client.query(
            `UPDATE players
             SET money = money + $1
             WHERE game_id = $2 AND id = $3`,
            [feeTotal, gameId, playerId]
          );
          for (const payee of ownersReversed) {
            await client.query(
              `UPDATE players
               SET money = money - $1
               WHERE game_id = $2 AND id = $3`,
              [payee.amount, gameId, payee.playerId]
            );
          }
        }

        // Restore position to the "from" of the move action
        await client.query(
          `UPDATE players
           SET position_row = $1,
               position_col = $2,
               position_x = $3,
               position_y = $4
           WHERE game_id = $5 AND id = $6`,
          [
            Math.round(from.row),
            Math.round(from.col),
            typeof from.x === "number" ? Math.round(from.x) : null,
            typeof from.y === "number" ? Math.round(from.y) : null,
            gameId,
            playerId,
          ]
        );

        // Pop last action
        const remainingActions = actions.slice(0, actions.length - 1);
        await client.query(
          `UPDATE turn_actions
           SET actions = $1::jsonb
           WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
          [JSON.stringify(remainingActions), playerId, gameId, turnNumber]
        );

        await client.query("COMMIT");
        const updatedMoney = currentMoney + feeTotal;
        return {
          kind: "move",
          updatedMoney,
          restoredPosition: { row: from.row, col: from.col, x: from.x, y: from.y },
          ownersReversed,
          feeTotal,
        };
      }

      const removedCardId = Number(last.newCardIdDrawn);
      const restoredCardId = Number(last.cardIdUsed);
      const payment = Number(last.payment);
      const loadType = last.loadType as LoadType;

      if (!handIds.includes(removedCardId)) {
        throw new Error("Hand does not contain drawn card to undo");
      }
      if (!Number.isFinite(payment)) {
        throw new Error("Invalid payment on action");
      }

      const restoredCard = demandDeckService.getCard(restoredCardId);
      if (!restoredCard) {
        throw new Error("Invalid demand card on action");
      }

      const updatedMoney = currentMoney - payment;
      if (!Number.isFinite(updatedMoney)) {
        throw new Error("Invalid money update");
      }

      const updatedHandIds = handIds.map((id) => (id === removedCardId ? restoredCardId : id));
      const updatedLoads = [...loads, loadType];

      // Return the dealt card to the deck before committing player state.
      const returned = demandDeckService.returnDealtCardToTop(removedCardId);
      if (!returned) {
        throw new Error("Failed to return dealt card to deck");
      }

      // Restore the discarded card back to dealt state (undo discard).
      const restored = demandDeckService.returnDiscardedCardToDealt(restoredCardId);
      if (!restored) {
        throw new Error("Failed to restore discarded card");
      }

      await client.query(
        `UPDATE players
         SET money = $1, hand = $2, loads = $3
         WHERE game_id = $4 AND id = $5`,
        [updatedMoney, updatedHandIds, updatedLoads, gameId, playerId]
      );

      const remainingActions = actions.slice(0, actions.length - 1);
      await client.query(
        `UPDATE turn_actions
         SET actions = $1::jsonb
         WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
        [JSON.stringify(remainingActions), playerId, gameId, turnNumber]
      );

      await client.query("COMMIT");
      return { kind: "deliver", updatedMoney, updatedLoads, restoredCard, removedCardId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Discard the authenticated user's entire hand and draw 3 new Demand cards,
   * consuming (ending) the user's turn by advancing the game's currentPlayerIndex.
   *
   * Server-authoritative:
   * - Validate it's the player's turn
   * - Enforce "start of turn" constraints (MVP):
   *   - player_tracks.turn_build_cost must be 0
   *   - no server-tracked turn_actions exist for this turn (deliveries)
   *   - best-effort: movement_history for this turn must be empty if present
   * - Discard all currently dealt hand cards into the deck discard pile
   * - Draw 3 replacement cards and persist to players.hand
   * - Increment players.current_turn_number for the discarding player
   * - Advance games.current_player_index to the next player
   *
   * Notes:
   * - Deck operations are in-memory; on DB failure we do best-effort compensation
   *   similar to deliverLoadForUser.
   * - Hand privacy is enforced by not broadcasting hand contents to other players.
   */
  static async discardHandForUser(
    gameId: string,
    userId: string
  ): Promise<{ currentPlayerIndex: number; nextPlayerId: string; nextPlayerName: string }> {
    const client = await db.connect();
    const discardedIds: number[] = [];
    const drawnIds: number[] = [];
    try {
      await client.query("BEGIN");

      const playerRowResult = await client.query(
        `SELECT id, hand, current_turn_number as "turnNumber"
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const playerId: string = playerRowResult.rows[0].id as string;
      const currentHand: unknown = playerRowResult.rows[0].hand;
      const turnNumber: number = Number(playerRowResult.rows[0].turnNumber ?? 1);
      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];

      const gameStateResult = await client.query(
        `SELECT current_player_index
         FROM games
         WHERE id = $1
         FOR UPDATE`,
        [gameId]
      );
      if (gameStateResult.rows.length === 0) {
        throw new Error("Game not found");
      }
      const currentPlayerIndex = Number(gameStateResult.rows[0].current_player_index ?? 0);

      // Determine active player by ordering (must match getPlayers ordering).
      const activePlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, currentPlayerIndex]
      );
      const activePlayerId = activePlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      // Start-of-turn constraint: no track spend this turn (server-side).
      const trackRow = await client.query(
        `SELECT turn_build_cost
         FROM player_tracks
         WHERE game_id = $1 AND player_id = $2
         FOR UPDATE`,
        [gameId, playerId]
      );
      const turnBuildCost = trackRow.rows.length > 0 ? Number(trackRow.rows[0].turn_build_cost ?? 0) : 0;
      if (turnBuildCost !== 0) {
        throw new Error("Cannot discard hand after building track this turn");
      }

      // Start-of-turn constraint: no server-tracked actions (deliveries) this turn.
      const actionsRow = await client.query(
        `SELECT actions
         FROM turn_actions
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3`,
        [playerId, gameId, turnNumber]
      );
      if (actionsRow.rows.length > 0) {
        const actionsJson = actionsRow.rows[0]?.actions;
        const actions: any[] = Array.isArray(actionsJson) ? actionsJson : (actionsJson ? (actionsJson as any) : []);
        if (Array.isArray(actions) && actions.length > 0) {
          throw new Error("Cannot discard hand after performing actions this turn");
        }
      }

      // NOTE:
      // We intentionally do NOT gate on movement_history here.
      // The client preserves movementHistory across turns for directionality, and some updates
      // (like persisting turnNumber) can write a non-empty movement_history row at the start of a new turn.
      // That makes movement_history unreliable as a "did you move this turn?" signal.
      // Start-of-turn enforcement remains server-authoritative via:
      // - turn_build_cost === 0
      // - no server-tracked turn_actions this turn

      // Discard old hand (must be currently dealt).
      for (const id of handIds) {
        demandDeckService.discardCard(id);
        discardedIds.push(id);
      }

      // Draw replacement hand (future-proof loop structure).
      const newCards: DemandCard[] = [];
      while (newCards.length < 3) {
        const card = demandDeckService.drawCard();
        if (!card) {
          throw new Error("Failed to draw new demand card");
        }
        newCards.push(card);
        drawnIds.push(card.id);
      }
      const newHandIds = newCards.map((c) => c.id);

      await client.query(
        `UPDATE players
         SET hand = $1
         WHERE game_id = $2 AND id = $3`,
        [newHandIds, gameId, playerId]
      );

      // Increment per-player turn count at END of the active player's turn.
      await client.query(
        `UPDATE players
         SET current_turn_number = COALESCE(current_turn_number, 1) + 1
         WHERE game_id = $1 AND id = $2`,
        [gameId, playerId]
      );

      // Advance the game turn.
      const countResult = await client.query(
        "SELECT COUNT(*)::int as count FROM players WHERE game_id = $1",
        [gameId]
      );
      const playerCount = Number(countResult.rows[0]?.count ?? 0);
      if (!Number.isFinite(playerCount) || playerCount <= 0) {
        throw new Error("Game has no players");
      }
      const nextIndex = (currentPlayerIndex + 1) % playerCount;

      await client.query(
        `UPDATE games
         SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [nextIndex, gameId]
      );

      // Resolve next player identity for response + socket events.
      const nextPlayerQuery = await client.query(
        "SELECT id, name FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, nextIndex]
      );
      const nextPlayerId = nextPlayerQuery.rows[0]?.id as string | undefined;
      const nextPlayerName = nextPlayerQuery.rows[0]?.name as string | undefined;
      if (!nextPlayerId) {
        throw new Error("Failed to resolve next player");
      }

      await client.query("COMMIT");

      // Emit socket events AFTER commit.
      try {
        const { emitTurnChange, emitStatePatch } = await import("./socketService");
        emitTurnChange(gameId, nextIndex, nextPlayerId);
        await emitStatePatch(gameId, { currentPlayerIndex: nextIndex } as any);
      } catch {
        // Socket is best-effort; clients will fall back to polling.
      }

      return { currentPlayerIndex: nextIndex, nextPlayerId, nextPlayerName: nextPlayerName || "Next player" };
    } catch (error) {
      await client.query("ROLLBACK");

      // Best-effort compensation for in-memory deck mutations.
      for (const id of drawnIds) {
        try {
          demandDeckService.returnDealtCardToTop(id);
        } catch {
          // ignore
        }
      }
      for (const id of discardedIds) {
        try {
          demandDeckService.returnDiscardedCardToDealt(id);
        } catch {
          // ignore
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Restart (reset) the authenticated user's player to a clean starting state.
   *
   * Constraints (MVP, matches discard-hand checks):
   * - Must be the active player ("Not your turn" otherwise)
   * - turn_build_cost must be 0
   * - no server-tracked turn_actions exist for this turn
   *
   * Effects:
   * - money -> 50
   * - train_type -> Freight
   * - loads -> []
   * - position_* -> NULL
   * - hand -> replaced with 3 freshly drawn cards (server-authoritative)
   * - player_tracks -> cleared (segments=[], costs reset)
   *
   * Note: Does NOT advance turn or increment current_turn_number.
   */
  static async restartForUser(gameId: string, userId: string): Promise<Player> {
    const client = await db.connect();
    const discardedIds: number[] = [];
    const drawnIds: number[] = [];
    try {
      await client.query("BEGIN");

      const playerRowResult = await client.query(
        `SELECT id, hand, current_turn_number as "turnNumber"
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const playerId: string = playerRowResult.rows[0].id as string;
      const currentHand: unknown = playerRowResult.rows[0].hand;
      const turnNumber: number = Number(playerRowResult.rows[0].turnNumber ?? 1);
      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];

      const gameStateResult = await client.query(
        `SELECT current_player_index
         FROM games
         WHERE id = $1
         FOR UPDATE`,
        [gameId]
      );
      if (gameStateResult.rows.length === 0) {
        throw new Error("Game not found");
      }
      const currentPlayerIndex = Number(gameStateResult.rows[0].current_player_index ?? 0);

      // Determine active player by ordering (must match getPlayers ordering).
      const activePlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, currentPlayerIndex]
      );
      const activePlayerId = activePlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      // Start-of-turn constraint: no track spend this turn (server-side).
      const trackRow = await client.query(
        `SELECT turn_build_cost
         FROM player_tracks
         WHERE game_id = $1 AND player_id = $2
         FOR UPDATE`,
        [gameId, playerId]
      );
      const turnBuildCost = trackRow.rows.length > 0 ? Number(trackRow.rows[0].turn_build_cost ?? 0) : 0;
      if (turnBuildCost !== 0) {
        throw new Error("Cannot restart after building track this turn");
      }

      // Start-of-turn constraint: no server-tracked actions (deliveries) this turn.
      const actionsRow = await client.query(
        `SELECT actions
         FROM turn_actions
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3`,
        [playerId, gameId, turnNumber]
      );
      if (actionsRow.rows.length > 0) {
        const actionsJson = actionsRow.rows[0]?.actions;
        const actions: any[] = Array.isArray(actionsJson) ? actionsJson : (actionsJson ? (actionsJson as any) : []);
        if (Array.isArray(actions) && actions.length > 0) {
          throw new Error("Cannot restart after performing actions this turn");
        }
      }

      // Discard old hand (must be currently dealt).
      for (const id of handIds) {
        demandDeckService.discardCard(id);
        discardedIds.push(id);
      }

      // Draw replacement hand.
      const newCards: DemandCard[] = [];
      while (newCards.length < 3) {
        const card = demandDeckService.drawCard();
        if (!card) {
          throw new Error("Failed to draw new demand card");
        }
        newCards.push(card);
        drawnIds.push(card.id);
      }
      const newHandIds = newCards.map((c) => c.id);

      // Reset player state (does NOT end turn).
      await client.query(
        `UPDATE players
         SET money = 50,
             train_type = $1,
             loads = $2,
             position_x = NULL,
             position_y = NULL,
             position_row = NULL,
             position_col = NULL,
             hand = $3
         WHERE game_id = $4 AND id = $5`,
        [TrainType.Freight, [], newHandIds, gameId, playerId]
      );

      // Clear track state.
      await TrackService.resetTrackState(gameId, playerId, client);

      // Best-effort: clear any action log row for this turn to avoid future confusion.
      await client.query(
        `DELETE FROM turn_actions WHERE player_id = $1 AND game_id = $2 AND turn_number = $3`,
        [playerId, gameId, turnNumber]
      );

      await client.query("COMMIT");

      // Return updated player with proper hand filtering for this user (includes new hand).
      const updatedPlayers = await this.getPlayers(gameId, userId);
      const updatedPlayer = updatedPlayers.find((p) => p.id === playerId);
      if (!updatedPlayer) {
        throw new Error("Failed to load updated player");
      }
      return updatedPlayer;
    } catch (error) {
      await client.query("ROLLBACK");

      // Best-effort compensation for in-memory deck mutations.
      for (const id of drawnIds) {
        try {
          demandDeckService.returnDealtCardToTop(id);
        } catch {
          // ignore
        }
      }
      for (const id of discardedIds) {
        try {
          demandDeckService.returnDiscardedCardToDealt(id);
        } catch {
          // ignore
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Apply a train upgrade or crossgrade for the authenticated user's player.
   *
   * Rules implemented:
   * - upgrade (20M):
   *   - Freight -> FastFreight | HeavyFreight (choice)
   *   - FastFreight | HeavyFreight -> Superfreight
   *   - Requires turn_build_cost === 0 (no track spend yet this turn)
   * - crossgrade (5M):
   *   - FastFreight <-> HeavyFreight
   *   - Allowed even if track has been built this turn, as long as turn_build_cost <= 15
   *
   * Server-authoritative on money + train_type. Track build-limit enforcement remains client-side.
   */
  static async purchaseTrainType(
    gameId: string,
    userId: string,
    kind: "upgrade" | "crossgrade",
    targetTrainType: TrainType
  ): Promise<Player> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Find the requesting user's player in this game
      const playerRowResult = await client.query(
        `SELECT id, money, train_type as "trainType", loads
         FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1`,
        [gameId, userId]
      );
      if (playerRowResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }
      const playerId: string = playerRowResult.rows[0].id;
      const currentMoney: number = playerRowResult.rows[0].money;
      const currentTrainType: TrainType = playerRowResult.rows[0].trainType as TrainType;
      const currentLoads: unknown = playerRowResult.rows[0].loads;
      const currentLoadCount = Array.isArray(currentLoads) ? currentLoads.length : 0;

      // Validate game exists + determine whose turn it is
      const gameState = await this.getGameState(gameId);
      const currentPlayerQuery = await client.query(
        "SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2",
        [gameId, gameState.currentPlayerIndex]
      );
      const activePlayerId = currentPlayerQuery.rows[0]?.id as string | undefined;
      if (!activePlayerId) {
        throw new Error("Game has no active player");
      }
      if (activePlayerId !== playerId) {
        throw new Error("Not your turn");
      }

      // Track spend this turn (server-side)
      const trackState = await TrackService.getTrackState(gameId, playerId);
      const turnBuildCost = trackState?.turnBuildCost ?? 0;

      // Validate target train type
      const isValidTrainType = Object.values(TrainType).includes(targetTrainType);
      if (!isValidTrainType) {
        throw new Error("Invalid train type");
      }

      // Validate transition + determine cost
      let cost = 0;

      if (kind === "upgrade") {
        cost = 20;
        if (turnBuildCost !== 0) {
          throw new Error("Cannot upgrade after building track this turn");
        }
        const legalUpgrade =
          (currentTrainType === TrainType.Freight &&
            (targetTrainType === TrainType.FastFreight ||
              targetTrainType === TrainType.HeavyFreight)) ||
          ((currentTrainType === TrainType.FastFreight ||
            currentTrainType === TrainType.HeavyFreight) &&
            targetTrainType === TrainType.Superfreight);
        if (!legalUpgrade) {
          throw new Error("Illegal upgrade transition");
        }
      } else {
        // crossgrade
        cost = 5;
        if (turnBuildCost > 15) {
          throw new Error("Cannot crossgrade after spending more than 15M on track this turn");
        }
        const targetCapacity = TRAIN_PROPERTIES[targetTrainType]?.capacity;
        if (typeof targetCapacity !== "number") {
          throw new Error("Invalid train type");
        }
        if (currentLoadCount > targetCapacity) {
          throw new Error("Cannot crossgrade: too many loads for target train capacity");
        }
        const legalCrossgrade =
          (currentTrainType === TrainType.FastFreight &&
            targetTrainType === TrainType.HeavyFreight) ||
          (currentTrainType === TrainType.HeavyFreight &&
            targetTrainType === TrainType.FastFreight);
        if (!legalCrossgrade) {
          throw new Error("Illegal crossgrade transition");
        }
      }

      if (currentTrainType === targetTrainType) {
        throw new Error("Train is already that type");
      }

      // Validate funds
      if (currentMoney < cost) {
        throw new Error("Insufficient funds");
      }

      // Apply update
      await client.query(
        `UPDATE players
         SET train_type = $1, money = money - $2
         WHERE game_id = $3 AND id = $4`,
        [targetTrainType, cost, gameId, playerId]
      );

      await client.query("COMMIT");

      // Return updated player with proper hand filtering for this user
      const updatedPlayers = await this.getPlayers(gameId, userId);
      const updatedPlayer = updatedPlayers.find((p) => p.id === playerId);
      if (!updatedPlayer) {
        throw new Error("Failed to load updated player");
      }
      return updatedPlayer;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
