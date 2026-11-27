import { db } from "../db/index";
import { Player, Game, GameStatus, TrainType, TRAIN_PROPERTIES, TRACK_USAGE_FEE, TerrainType } from "../../shared/types/GameTypes";
import { getTrainCapacity } from "../../shared/services/trainProperties";
import { PoolClient, QueryResult } from "pg";
import { v4 as uuidv4 } from "uuid";
import { DemandDeckService } from "./demandDeckService";
import { TrackService, getRiverEdgeKeys, segmentCrossesRiver, areSegmentsEqual } from "./trackService";
import { DemandCard } from "../../shared/types/DemandCard";
import { LoadActionResult, LoadType } from "../../shared/types/LoadTypes";
import { computeTrackUsageForMove } from "../../shared/services/trackUsageFees";
import { loadGridPoints } from "./MapTopology";
import { getFerryEdges } from "../../shared/services/majorCityGroups";
import { TrackSegment } from "../../shared/types/TrackTypes";
import { EventCardService } from "./EventCardService";
import { activeEffectManager } from "./ActiveEffectManager";
import { EventCardType, EventCardResult, EventCard } from "../../shared/types/EventCard";
import {
  getCityMilepointKey,
  isBuildBlockedAtMilepost,
  isFloodRebuildBlocked,
  isMovementBlockedAtDest,
  isMovementOnOwnRailBlocked,
  isPickupDeliveryBlocked,
} from "./restrictionPredicates";
import { cleanupGameState } from "./gameCleanupService";
import { lockPlayerForUserTurn } from "./turnGuard";
import {
  MovementRuleError,
  MovementRuleErrorCode,
  computeRemainingMovement,
  findMovePathWithinBudget,
  getTurnMovementAllowance,
  isCityMilepost,
  isCityMilepostOf,
  sumMovementUsed,
} from "./trainMovement";
import {
  buildActionsOf,
  pathToBuildEdges,
  planTrackBuild,
  PlannedTrackSegment,
  TrackBuildEdge,
  TrackBuildError,
  TrackBuildErrorCode,
  TurnActionBuild,
} from "./trackBuild";
import { TrackCostCoord } from "../../shared/services/trackBuildCost";
import { InitialBuildService } from "./InitialBuildService";
import {
  appendTurnAction,
  dropLoadInTransaction,
  getDroppedLoadsInTransaction,
  pickupLoadInTransaction,
  trayChangesForDrop,
  trayChangesForPickup,
  undoLoadActionInTransaction,
  TurnActionDrop,
  TurnActionPickup,
} from "./loadActions";

/**
 * Statuses for the actions the hand UI offers from the first build turn on:
 * train purchase, discard hand, borrow and restart.
 */
const MERCY_ACTION_STATUSES: readonly GameStatus[] = ["initialBuild", "active"];

/**
 * Statuses in which track may be built: the opening build turns and normal
 * play. Kept apart from MERCY_ACTION_STATUSES, which has the same value today
 * but answers a different rule and may change on its own.
 */
const TRACK_BUILD_STATUSES: readonly GameStatus[] = ["initialBuild", "active"];

// ── Event-card restriction errors ────────────────────────────────

/**
 * Closed union of machine-readable error codes for event card restriction
 * violations.  Using a union type (not a plain string) catches typos at
 * compile time and prevents stringly-typed bugs at call sites.
 */
export type ActionRestrictionErrorCode =
  | 'RAIL_STRIKE_BLOCKED'
  | 'COASTAL_STRIKE_BLOCKED'
  | 'SNOW_BLOCKED_TERRAIN'
  | 'SNOW_HALF_RATE_EXCEEDED'
  | 'BUILD_BLOCKED'
  | 'LOST_TURN'
  | 'FLOOD_BRIDGE_REBUILD_BLOCKED'
  | 'OTHER';

/**
 * Thrown by PlayerService action methods when an active event card restriction
 * prevents the requested action.  Carries a machine-readable `code` so callers
 * (routes, bot planners, guardrails) can branch on the specific restriction type
 * without parsing the user-facing message string.
 */
export class ActionRestrictionError extends Error {
  constructor(
    public readonly code: ActionRestrictionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRestrictionError';
  }
}

type TurnActionDeliver = {
  kind: "deliver";
  city: string;
  loadType: LoadType;
  cardIdUsed: number;
  newCardIdDrawn: number;
  payment: number;
  repayment: number;
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
  /**
   * Data collected during a transaction for socket emission after COMMIT.
   * Emissions are deferred to avoid notifying clients of effects that may roll back.
   */
  private static pendingEmissions: Array<{
    gameId: string;
    eventResult: EventCardResult;
    drawingPlayerName: string;
    card: EventCard;
  }> = [];

  /**
   * Persist an active effect produced by an event card draw.
   * Extracted to eliminate duplication across fulfillDemand, deliverLoad, and discardHandCore.
   *
   * Socket emissions are deferred — call flushEventEmissions() after COMMIT.
   */
  private static async persistEventEffect(
    gameId: string,
    eventResult: EventCardResult,
    client: import('pg').PoolClient,
    logPrefix: string,
    card?: EventCard,
  ): Promise<void> {
    if (eventResult.persistentEffectDescriptor) {
      console.info(`[${logPrefix}] Persisting active effect: cardId=${eventResult.cardId} gameId=${gameId}`);
      await activeEffectManager.addActiveEffect(
        gameId,
        eventResult.persistentEffectDescriptor,
        eventResult.cardType,
        eventResult.perPlayerEffects,
        client,
        eventResult.floodedRiver,
      );
    }

    // Collect emission data for post-COMMIT broadcast (SP-4).
    if (card) {
      let drawingPlayerName = 'Unknown Player';
      try {
        const nameRow = await client.query(
          'SELECT name FROM players WHERE id = $1 LIMIT 1',
          [eventResult.drawingPlayerId],
        );
        if (nameRow.rows[0]?.name) {
          drawingPlayerName = nameRow.rows[0].name as string;
        }
      } catch (nameErr) {
        console.warn(`[${logPrefix}] Could not look up player name for socket emit: ${nameErr}`);
      }

      PlayerService.pendingEmissions.push({ gameId, eventResult, drawingPlayerName, card });
    }
  }

  /**
   * Flush deferred socket emissions after a successful COMMIT.
   * Non-fatal — game state (DB) is the source of truth.
   */
  private static async flushEventEmissions(): Promise<void> {
    const emissions = PlayerService.pendingEmissions.splice(0);
    if (emissions.length === 0) return;

    try {
      const { emitEventCardDrawn, emitEventEffectApplied, emitToGame } = await import('./socketService');
      const { appendEvent } = await import('./ai/EventLogger');

      for (const { gameId, eventResult, drawingPlayerName, card } of emissions) {
        const affectedPlayerIds = eventResult.perPlayerEffects.map((e) => e.playerId);
        const duration = eventResult.persistentEffectDescriptor ? 'persistent' : 'immediate';

        // Resolve affected player IDs to display names
        let affectedPlayerNames: string[] = [];
        if (affectedPlayerIds.length > 0) {
          try {
            const nameRows = await db.query(
              'SELECT id, name FROM players WHERE id = ANY($1)',
              [affectedPlayerIds],
            );
            const nameMap = new Map<string, string>();
            for (const row of nameRows.rows) {
              nameMap.set(row.id, row.name as string);
            }
            affectedPlayerNames = affectedPlayerIds.map(
              (id) => nameMap.get(id) ?? 'Unknown Player',
            );
          } catch (nameErr) {
            console.warn(`[PlayerService] Could not resolve affected player names: ${nameErr}`);
            affectedPlayerNames = affectedPlayerIds.map(() => 'Unknown Player');
          }
        }

        // Build flood-specific summary when segments were removed
        let effectSummary: string;
        if (eventResult.floodSegmentsRemoved.length > 0) {
          const parts = eventResult.floodSegmentsRemoved.map((r, i) => {
            const name = affectedPlayerNames[i] ?? 'Unknown Player';
            return `${r.removedCount} segment(s) from ${name}`;
          });
          effectSummary = `Flood on ${eventResult.floodedRiver ?? 'river'}: ${parts.join(', ')}`;
        } else {
          effectSummary = `${card.type} affecting ${eventResult.affectedZone.length} mileposts`;
        }

        emitEventCardDrawn(gameId, {
          gameId,
          card,
          drawingPlayerId: eventResult.drawingPlayerId,
          drawingPlayerName,
          affectedZone: eventResult.affectedZone,
          affectedPlayerIds,
          affectedPlayerNames,
          effectSummary,
          duration,
          timestamp: new Date().toISOString(),
        });

        if (eventResult.perPlayerEffects.length > 0) {
          emitEventEffectApplied(gameId, {
            gameId,
            cardId: eventResult.cardId,
            effects: eventResult.perPlayerEffects,
            timestamp: new Date().toISOString(),
          });
        }

        // Flood events remove track segments server-side — notify clients to
        // re-fetch tracks so their in-memory state stays in sync with the DB.
        // Without this, the next client saveTrackState would overwrite the
        // removal with stale data.
        if (eventResult.floodSegmentsRemoved.length > 0) {
          for (const r of eventResult.floodSegmentsRemoved) {
            emitToGame(gameId, 'track:updated', {
              gameId,
              playerId: r.playerId,
              timestamp: Date.now(),
            });
          }
        }

        // JIRA-262: persist event-card draw to logs/events-<gameId>.ndjson for
        // post-hoc analysis. Best-effort, observability-only.
        try {
          const descriptor = eventResult.persistentEffectDescriptor;
          const pendingLostTurnPlayers = eventResult.perPlayerEffects
            .filter(e => e.effectType === 'turn_lost')
            .map(e => e.playerId);
          appendEvent(gameId, {
            timestamp: new Date().toISOString(),
            // Drawing player's current turn = expiresAfter - 1 when descriptor exists;
            // for immediate-only events (Derailment, Excess Profit Tax) descriptor is
            // undefined — fall through to -1 sentinel which downstream analysis can
            // treat as "turn-of-draw unknown, infer from neighboring NDJSON entries".
            turn: descriptor ? descriptor.expiresAfterTurnNumber - 1 : -1,
            phase: 'drawn',
            cardId: eventResult.cardId,
            cardType: String(eventResult.cardType),
            drawingPlayerId: eventResult.drawingPlayerId,
            drawingPlayerIndex: descriptor?.drawingPlayerIndex,
            affectedZone: eventResult.affectedZone,
            restrictionTypes: Array.from(
              new Set(eventResult.perPlayerEffects.map(e => e.effectType)),
            ),
            pendingLostTurnPlayerIds: pendingLostTurnPlayers.length > 0
              ? pendingLostTurnPlayers
              : undefined,
            floodedRiver: eventResult.floodedRiver,
            expiresAfterTurnNumber: descriptor?.expiresAfterTurnNumber,
            note: `Drawn by ${drawingPlayerName}`,
          });
        } catch (logErr) {
          console.warn(`[PlayerService] Event log failed for game ${gameId}: ${logErr instanceof Error ? logErr.message : logErr}`);
        }
      }
    } catch (emitErr) {
      console.error(`[PlayerService] Failed to flush event emissions: ${emitErr}`);
    }
  }

  /**
   * Return the canonical milepost key ("row,col") for a city name by looking
   * up the grid. Returns null if the city is not found.
   */
  private static getCityMilepointKey(cityName: string): string | null {
    const grid = loadGridPoints();
    // Prefer MajorCity center; fall back to any milepost with matching name
    for (const [key, point] of grid) {
      if (point.name === cityName && point.terrain === TerrainType.MajorCity) {
        return key;
      }
    }
    for (const [key, point] of grid) {
      if (point.name === cityName) {
        return key;
      }
    }
    return null;
  }

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
   * @returns true if the user is a non-deleted player in the game, false otherwise
   */
  static async isUserPlayerInGame(gameId: string, userId: string): Promise<boolean> {
    const query = "SELECT id FROM players WHERE game_id = $1 AND user_id = $2 AND is_deleted = false LIMIT 1";
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
    // IMPORTANT: If client is provided, it MUST be used for transaction consistency
    // Check if client is truthy and has a query method (it's a proper database client)
    if (client && typeof client.query === 'function') {
      await PlayerService.insertPlayerWithHand(gameId, player, client);
      return;
    }
    if (client !== undefined) {
      console.error(`PlayerService.createPlayer: Invalid client provided. Expected a database client with query() method, got:`, typeof client);
    }

    // No transaction client: open one so the deck load (which locks the game
    // row), the player insert and the deck persist commit or roll back together.
    // Without it, concurrent joins could load the same deck and deal the same cards.
    const ownClient = await db.connect();
    try {
      await ownClient.query("BEGIN");
      await PlayerService.insertPlayerWithHand(gameId, player, ownClient);
      await ownClient.query("COMMIT");
    } catch (err) {
      await ownClient.query("ROLLBACK");
      throw err;
    } finally {
      ownClient.release();
    }
  }

  /**
   * Insert a player and deal their initial hand from the game's deck, inside
   * the caller's transaction.
   */
  private static async insertPlayerWithHand(
    gameId: string,
    player: Player,
    useClient: import("pg").PoolClient
  ): Promise<void> {
    // Validate and normalize color
    const normalizedColor = this.validateColor(player.color);

    // First check if another player already has this color
    // Also verify the game exists (sanity check - helps debug transaction issues)
    const gameCheckResult = await useClient.query('SELECT id FROM games WHERE id = $1', [gameId]);
    if (gameCheckResult.rows.length === 0) {
      console.error(`PlayerService.createPlayer: Game ${gameId} not found in transaction. This indicates a transaction isolation issue.`);
      throw new Error(`Game ${gameId} not found - transaction may not be properly isolated`);
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
    // Event cards drawn during initial deal are discarded and replaced per game rules
    const demandDeckService = await DemandDeckService.loadForGame(gameId, useClient);
    const handCardIds: number[] = [];
    while (handCardIds.length < 3) {
      const drawResult = demandDeckService.drawCard();
      if (!drawResult) {
        throw new Error(`Failed to draw initial card ${handCardIds.length + 1} for player ${player.id}`);
      }
      if (drawResult.type === 'event') {
        console.warn(`[addPlayer] Drew event card ${drawResult.card.id} during initial deal — discarding`);
        demandDeckService.discardEventCard(drawResult.card.id);
        continue;
      }
      handCardIds.push(drawResult.card.id);
    }

    const query = `
            INSERT INTO players (
                id, game_id, user_id, name, color, money, train_type,
                position_x, position_y, position_row, position_col,
                current_turn_number, hand, loads, camera_state,
                is_bot, bot_config
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      player.cameraState || null,
      player.isBot || false,
      player.botConfig ? JSON.stringify(player.botConfig) : null
    ];
    try {
      await useClient.query(query, values);
      await demandDeckService.persist(useClient);
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
        await this.createPlayer(gameId, player, client);
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

      // Note: movement_history is now persisted per-move in moveTrainForUser
      // to ensure resilience against browser refresh mid-turn.
      // We no longer write it here to avoid duplication.

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
                    debt_owed as "debtOwed",
                    train_type as "trainType",
                    position_x,
                    position_y,
                    position_row,
                    position_col,
                    current_turn_number as "turnNumber",
                    mh.movement_path as "movementHistory",
                    ta.actions as "turnActions",
                    hand,
                    loads,
                    camera_state,
                    is_bot,
                    bot_config
                FROM players
                LEFT JOIN LATERAL (
                    SELECT movement_path
                    FROM movement_history
                    WHERE player_id = players.id
                      AND turn_number = players.current_turn_number
                    LIMIT 1
                ) mh ON true
                LEFT JOIN LATERAL (
                    SELECT actions
                    FROM turn_actions
                    WHERE player_id = players.id
                      AND turn_number = players.current_turn_number
                    LIMIT 1
                ) ta ON true
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
        // Issue #176: Demand cards are public in the board game, so show ALL hands
        // Handle both null and empty array cases
        const handArray = row.hand || [];
        let handCards: any[] = [];
        
        if (!Array.isArray(handArray)) {
          console.error(`Invalid hand data for player ${row.id}:`, handArray);
          handCards = [];
        } else {
          handCards = handArray.map((cardId: number) => {
            const card = DemandDeckService.getCard(cardId);
            if (!card) {
              console.error(`Failed to find card with ID ${cardId} for player ${row.id}`);
              return null;
            }
            return card;
          }).filter(Boolean); // Remove any null entries
        }

        // Normalize trainType from database (legacy values like "Freight" may exist)
        const trainType = this.normalizeTrainType(row.trainType);

        // remainingMovement = the train type's allowance minus the server-computed
        // costs in the current turn's movement history (see trainMovement.ts).
        const movementHistory = row.movementHistory || [];
        const remainingMovement = computeRemainingMovement(trainType, movementHistory);

        // Extract paidOpponentIds from turn_actions for this turn
        // This ensures the "once per turn" fee tracking persists across browser refresh
        const turnActions = row.turnActions || [];
        const paidOpponentIds: string[] = [];
        for (const act of Array.isArray(turnActions) ? turnActions : []) {
          if (act?.kind !== "move") continue;
          const ownersPaid = Array.isArray(act.ownersPaid) ? act.ownersPaid : [];
          for (const p of ownersPaid) {
            const pid = typeof p?.playerId === "string" ? p.playerId : null;
            if (pid && !paidOpponentIds.includes(pid)) {
              paidOpponentIds.push(pid);
            }
          }
        }

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
            movementHistory: movementHistory,
            remainingMovement: remainingMovement, // Calculated from max movement minus costs already spent this turn
            loads: row.loads || [],
            paidOpponentIds: paidOpponentIds, // Track which opponents have been paid for track usage this turn
          },
          hand: handCards,
          cameraState: row.camera_state || undefined,  // Per-player camera state
          isBot: row.is_bot || false,
          botConfig: row.bot_config || undefined,
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
          loads: [],
          lastTraversedEdge: undefined
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

  /**
   * High-level turn advancement: reads current game state, opens a transaction,
   * computes the next player index, and delegates to updateCurrentPlayerIndex
   * with the transactional path (effect cleanup + turn-skip + emit).
   *
   * This is the preferred entry point for all callers that simply want to
   * advance the turn. Use updateCurrentPlayerIndex directly only when the
   * caller already owns a transaction.
   */
  static async advanceTurn(gameId: string): Promise<void> {
    const gameResult = await db.query(
      'SELECT current_player_index FROM games WHERE id = $1',
      [gameId],
    );
    const prevPlayerIndex: number = gameResult.rows[0]?.current_player_index ?? 0;

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS count FROM players WHERE game_id = $1',
      [gameId],
    );
    const playerCount: number = countResult.rows[0]?.count || 1;
    const nextIndex = (prevPlayerIndex + 1) % playerCount;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex, client, prevPlayerIndex);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Charge a player for the track they built this turn and reset the per-turn
   * spend: `money -= turn_build_cost`, then `turn_build_cost = 0`.
   *
   * Idempotent — a second call finds a zero cost and charges nothing — so a
   * retried or repeated settlement can never bill the same construction twice.
   * Must run inside the caller's transaction, with the player row locked.
   *
   * @returns the amount charged and the player's money afterwards.
   */
  static async settleTurnBuildCost(
    client: PoolClient,
    gameId: string,
    playerId: string,
  ): Promise<{ charged: number; money: number }> {
    const trackRow = await client.query(
      `SELECT turn_build_cost
       FROM player_tracks
       WHERE game_id = $1 AND player_id = $2
       FOR UPDATE`,
      [gameId, playerId],
    );
    const charged = Number(trackRow.rows[0]?.turn_build_cost ?? 0);

    const moneyRow = await client.query(
      `UPDATE players
       SET money = money - $1
       WHERE game_id = $2 AND id = $3
       RETURNING money`,
      [charged, gameId, playerId],
    );
    if (charged !== 0) {
      await TrackService.clearTurnBuildCost(gameId, playerId, client);
    }
    return { charged, money: Number(moneyRow.rows[0]?.money ?? 0) };
  }

  /**
   * Settle the calling user's build cost for this turn without ending the turn
   * (server-authoritative, issue #304).
   *
   * The client calls this before its end-of-turn victory check, which must see
   * post-deduction money. `endTurnForUser` settles again in its own
   * transaction, so a skipped or failed call here is still charged at turn end,
   * and a successful one is never charged twice.
   *
   * @throws TurnGuardError when the user may not act right now.
   */
  static async settleBuildCostForUser(
    gameId: string,
    userId: string,
  ): Promise<{ playerId: string; charged: number; money: number }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { player } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: ["active", "initialBuild"],
      });
      const settled = await PlayerService.settleTurnBuildCost(client, gameId, player.id);
      await client.query("COMMIT");
      return { playerId: player.id, ...settled };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * End the calling user's turn (server-authoritative, issue #304).
   *
   * In ONE transaction: confirms the user is the current player (row locks via
   * `lockPlayerForUserTurn`), charges any unsettled build cost and resets
   * `turn_build_cost`, increments that player's `current_turn_number`, and
   * advances the turn — through `InitialBuildService` during `initialBuild`,
   * or the transactional `updateCurrentPlayerIndex` path while `active`.
   *
   * The bookkeeping lives here rather than in `advanceTurn` because bots do
   * their own at the START of their turn (`BotTurnTrigger.onTurnChange`) and
   * then call `advanceTurn`; doing it there would count bot turns twice.
   *
   * The turn number is incremented BEFORE the advance so effect expiry
   * (`cleanupExpiredEffects`) sees the same post-increment number it did when
   * the client persisted the increment ahead of the end-turn call.
   *
   * @returns the ending player's id and new turn number, and the new current
   *   player index — all read inside the transaction, so nothing can fail
   *   between the commit and the response.
   * @throws TurnGuardError when the user may not end the turn.
   */
  static async endTurnForUser(
    gameId: string,
    userId: string,
  ): Promise<{ playerId: string; turnNumber: number; currentPlayerIndex: number }> {
    const client = await db.connect();
    let playerId: string;
    let turnNumber: number;
    let newPlayerIndex: number;
    let emitAfterCommit: (() => Promise<void>) | undefined;
    try {
      await client.query("BEGIN");

      const { player, currentPlayerIndex, gameStatus } = await lockPlayerForUserTurn(
        client,
        gameId,
        userId,
        { allowedStatuses: ["active", "initialBuild"] },
      );
      playerId = player.id;

      await PlayerService.settleTurnBuildCost(client, gameId, playerId);

      const turnRow = await client.query(
        `UPDATE players
         SET current_turn_number = COALESCE(current_turn_number, 1) + 1
         WHERE game_id = $1 AND id = $2
         RETURNING current_turn_number`,
        [gameId, playerId],
      );
      turnNumber = Number(turnRow.rows[0]?.current_turn_number);

      if (gameStatus === "initialBuild") {
        emitAfterCommit = await InitialBuildService.advanceTurnWithClient(
          client,
          gameId,
          currentPlayerIndex,
        );
      } else {
        const countResult = await client.query(
          "SELECT COUNT(*)::int AS count FROM players WHERE game_id = $1",
          [gameId],
        );
        const playerCount: number = countResult.rows[0]?.count || 1;
        const nextIndex = (currentPlayerIndex + 1) % playerCount;
        await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex, client, currentPlayerIndex);
      }

      // Read the resolved index (after any Derailment skips) before committing.
      const indexRow = await client.query(
        "SELECT current_player_index FROM games WHERE id = $1",
        [gameId],
      );
      newPlayerIndex = Number(indexRow.rows[0]?.current_player_index ?? 0);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (emitAfterCommit) {
      await emitAfterCommit();
    }
    return { playerId, turnNumber, currentPlayerIndex: newPlayerIndex };
  }

  /**
   * Advance the current player index for a game.
   *
   * When `client` and `prevPlayerIndex` are provided (transactional path):
   *  1. Uses `client.query` for the UPDATE (participates in caller's transaction).
   *  2. Calls `cleanupExpiredEffects` for the previous player.
   *  3. Calls `consumeLostTurn` for the next player; if lost, recursively
   *     advances with an infinite-loop guard (at most playerCount skips).
   *  4. Emits `emitTurnChange` for the final active player.
   *
   * When neither `client` nor `prevPlayerIndex` is provided (legacy path),
   * skips effect management entirely — existing callers are unaffected.
   */
  static async updateCurrentPlayerIndex(
    gameId: string,
    currentPlayerIndex: number,
    client?: import('pg').PoolClient,
    prevPlayerIndex?: number,
  ): Promise<void> {
    const query = `
            UPDATE games
            SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;

    if (client) {
      await client.query(query, [currentPlayerIndex, gameId]);
    } else {
      await db.query(query, [currentPlayerIndex, gameId]);
    }

    // ── Transactional turn lifecycle (SP-3) ──────────────────────────────────
    if (client && prevPlayerIndex !== undefined) {
      // Step 1: Clean up effects that expired when prevPlayer completed their turn.
      // Use the previous player's current_turn_number as the completed turn number.
      const prevPlayerRow = await client.query(
        'SELECT id, current_turn_number FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
        [gameId, prevPlayerIndex],
      );
      const prevTurnNumber: number = Number(prevPlayerRow.rows[0]?.current_turn_number ?? 0);

      const { expiredCardIds } = await activeEffectManager.cleanupExpiredEffects(
        gameId,
        prevPlayerIndex,
        prevTurnNumber,
        client,
      );
      if (expiredCardIds.length > 0) {
        console.info(
          `[PlayerService] Effects expired on turn end: cardIds=${expiredCardIds.join(',')} prevPlayerIndex=${prevPlayerIndex} gameId=${gameId}`,
        );
        // Emit expiry notifications (SP-4). Non-fatal — game state is source of truth.
        try {
          const { emitEventEffectExpired } = await import('./socketService');
          const expiredAt = new Date().toISOString();
          for (const cardId of expiredCardIds) {
            emitEventEffectExpired(gameId, { gameId, cardId, timestamp: expiredAt });
          }
        } catch (emitErr) {
          console.error(`[PlayerService] Failed to emit effect-expired for gameId=${gameId}:`, emitErr);
        }
      }

      // Step 2: Determine total player count so we can guard against infinite skips.
      const countRow = await client.query(
        'SELECT COUNT(*) AS cnt FROM players WHERE game_id = $1',
        [gameId],
      );
      const playerCount = Number(countRow.rows[0]?.cnt ?? 1);

      // Step 3: Check for Derailment turn-skips, advancing until an active player.
      let resolvedIndex = currentPlayerIndex;
      let skipsRemaining = playerCount; // guard: at most playerCount advances

      while (skipsRemaining > 0) {
        const nextRow = await client.query(
          'SELECT id, current_turn_number FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
          [gameId, resolvedIndex],
        );
        const nextPlayerId: string | undefined = nextRow.rows[0]?.id as string | undefined;

        if (!nextPlayerId) {
          console.warn(`[PlayerService] No player found at index ${resolvedIndex} in game ${gameId}`);
          break;
        }

        const turnSkipped = await activeEffectManager.consumeLostTurn(gameId, nextPlayerId, client);

        if (!turnSkipped) {
          // This player is active — stop here.
          break;
        }

        // Player was skipped due to Derailment.
        console.info(
          `[PlayerService] Player turn skipped (Derailment): playerId=${nextPlayerId} index=${resolvedIndex} gameId=${gameId}`,
        );

        resolvedIndex = (resolvedIndex + 1) % playerCount;
        skipsRemaining--;
      }

      // Step 4: Emit turn change for the resolved active player.
      const { emitTurnChange } = await import('./socketService');
      const finalRow = await client.query(
        'SELECT id, current_turn_number FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
        [gameId, resolvedIndex],
      );
      const finalPlayerId: string | undefined = finalRow.rows[0]?.id as string | undefined;
      if (finalPlayerId) {
        // Update the stored index if we advanced past skipped players.
        if (resolvedIndex !== currentPlayerIndex) {
          await client.query(
            `UPDATE games SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [resolvedIndex, gameId],
          );
        }
        emitTurnChange(gameId, resolvedIndex, finalPlayerId);
      } else {
        console.warn(`[PlayerService] No player found at resolved index ${resolvedIndex} for game ${gameId}`);
      }

      return;
    }

    // ── Legacy path: no client — emit turn change via db.query ───────────────
    const { getSocketIO } = await import('./socketService');
    const io = getSocketIO();
    if (io) {
      // Query players in same order as getPlayers (ORDER BY created_at ASC for consistency)
      const playerQuery = await db.query(
        'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
        [gameId, currentPlayerIndex],
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
    
    const query = `
            UPDATE games
            SET status = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;
    await db.query(query, [finalStatus, gameId]);

    // When a game reaches a terminal state, release its per-game in-memory
    // state. Idempotent, so it is safe even if the game was already cleaned up
    // via another path (e.g. VictoryService.resolveVictory).
    if (finalStatus === "completed" || finalStatus === "abandoned") {
      await cleanupGameState(gameId);
    }
  }

  static async getGameStatus(gameId: string): Promise<GameStatus> {
    const query = "SELECT status FROM games WHERE id = $1";
    const result = await db.query(query, [gameId]);
    return result.rows[0]?.status || "completed";
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
  ): Promise<
    | { restricted: true; reason: string }
    | { restricted?: false; payment: number; repayment: number; updatedMoney: number; updatedDebtOwed: number; updatedLoads: LoadType[]; newCard: DemandCard; cardsDrawnDuringAction: number }
  > {
    const client = await db.connect();
    const discardedEventCardIds: number[] = [];
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId);

      const playerId: string = playerRow.id;
      const currentMoney: number = playerRow.money;
      const currentDebtOwed: number = Number(playerRow.debtOwed ?? 0);
      const currentHand: unknown = playerRow.hand;
      const currentLoads: unknown = playerRow.loads;
      const turnNumber: number = Number(playerRow.turnNumber ?? 1);

      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const loads: LoadType[] = Array.isArray(currentLoads)
        ? (currentLoads as unknown[]).filter((v): v is LoadType => typeof v === "string") as LoadType[]
        : [];

      // The train must be standing on a milepost of the delivery city (#312).
      const trainRow = playerRow.position_row;
      const trainCol = playerRow.position_col;
      if (
        trainRow == null ||
        trainCol == null ||
        !isCityMilepostOf(Number(trainRow), Number(trainCol), city)
      ) {
        throw new MovementRuleError(
          MovementRuleErrorCode.NotAtDeliveryCity,
          `Invalid delivery: train is not at ${city}`,
        );
      }

      // ── Event card restriction checks ─────────────────────────────────────
      // Check pickup/delivery restrictions from active event effects (coastal Strike)
      const deliveryRestrictions = await activeEffectManager.getPickupDeliveryRestrictions(gameId, client);
      if (deliveryRestrictions.length > 0) {
        const cityKey = PlayerService.getCityMilepointKey(city);
        for (const restriction of deliveryRestrictions) {
          if (restriction.type === 'no_pickup_delivery_in_zone') {
            const zoneSet = new Set(restriction.zone);
            if (cityKey && zoneSet.has(cityKey)) {
              console.warn(
                `[PlayerService] Delivery rejected by event restriction: type=no_pickup_delivery_in_zone gameId=${gameId} playerId=${playerId} city=${city} cityKey=${cityKey}`,
              );
              await client.query("ROLLBACK");
              return {
                restricted: true,
                reason: `Strike in effect: no pickups or deliveries allowed at ${city}`,
              };
            }
          }
        }
      }
      // ── End restriction checks ────────────────────────────────────────────

      if (!handIds.includes(cardId)) {
        throw new Error("Demand card not in hand");
      }

      const demandCard = DemandDeckService.getCard(cardId);
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

      // Draw a new card. Keep drawing until we get a demand card — event cards are
      // processed and discarded.
      const demandDeckService = await DemandDeckService.loadForGame(gameId, client);
      let newDrawResult = demandDeckService.drawCard();
      while (newDrawResult !== null && newDrawResult.type === 'event') {
        const eventCardId = newDrawResult.card.id;
        discardedEventCardIds.push(eventCardId);
        console.info(`[deliverLoad] Drew event card ${eventCardId} — processing via EventCardService`);
        const deliverEventResult = await EventCardService.processEventCard(gameId, newDrawResult.card, playerId, client);
        await PlayerService.persistEventEffect(gameId, deliverEventResult, client, 'deliverLoad', newDrawResult.card);
        demandDeckService.discardEventCard(eventCardId);
        newDrawResult = demandDeckService.drawCard();
      }
      if (!newDrawResult) {
        throw new Error("Failed to draw new card");
      }
      const newCard = newDrawResult.card;

      const updatedHandIds = handIds.map((id) => (id === cardId ? newCard.id : id));

      // Compute debt repayment (Mercy Rule): repay debt first from delivery payoff
      const repayment = Math.min(payment, currentDebtOwed);
      const netPayment = payment - repayment;
      const updatedMoney = currentMoney + netPayment;
      const updatedDebtOwed = currentDebtOwed - repayment;

      await client.query(
        `UPDATE players
         SET money = $1, hand = $2, loads = $3, debt_owed = $4
         WHERE game_id = $5 AND id = $6`,
        [updatedMoney, updatedHandIds, updatedLoads, updatedDebtOwed, gameId, playerId]
      );

      // Discard the fulfilled demand card into the deck discard pile.
      // This prevents it from re-entering the draw pile until a reshuffle.
      demandDeckService.discardCard(cardId);

      // Persist server-authored action log for this turn (used for undo).
      const deliverAction: TurnActionDeliver = {
        kind: "deliver",
        city,
        loadType,
        cardIdUsed: cardId,
        newCardIdDrawn: newCard.id,
        payment,
        repayment,
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

      await demandDeckService.persist(client);
      await client.query("COMMIT");
      await PlayerService.flushEventEmissions();
      // cardsDrawnDuringAction = 1 demand card drawn + any event cards processed along the way
      const cardsDrawnDuringAction = 1 + discardedEventCardIds.length;
      return { payment, repayment, updatedMoney, updatedDebtOwed, updatedLoads, newCard, cardsDrawnDuringAction };
    } catch (error) {
      PlayerService.pendingEmissions.length = 0;
      // The deck is persisted in this transaction, so ROLLBACK also restores it.
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Borrow money from the bank for the authenticated user's player (Mercy Rule).
   *
   * Server-authoritative:
   * - Validate it's the player's turn
   * - Validate amount (1-20 ECU, integer)
   * - Update money (+amount) and debt_owed (+2*amount) atomically
   *
   * @param gameId - The game ID
   * @param userId - The authenticated user ID
   * @param amount - Amount to borrow (1-20 ECU)
   * @returns BorrowResult with updated money and debt values
   */
  static async borrowForUser(
    gameId: string,
    userId: string,
    amount: number
  ): Promise<{
    borrowedAmount: number;
    debtIncurred: number;
    updatedMoney: number;
    updatedDebtOwed: number;
  }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Validate amount constraints
      if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
        throw new Error("Amount must be an integer");
      }
      if (amount < 1 || amount > 20) {
        throw new Error("Amount must be between 1 and 20");
      }

      // Mercy borrowing is offered from the first build turn, so allow initialBuild too.
      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: MERCY_ACTION_STATUSES,
      });

      const playerId: string = playerRow.id;
      const currentMoney: number = Number(playerRow.money ?? 0);
      const currentDebtOwed: number = Number(playerRow.debtOwed ?? 0);

      // Calculate new values
      const debtIncurred = amount * 2;
      const updatedMoney = currentMoney + amount;
      const updatedDebtOwed = currentDebtOwed + debtIncurred;

      // Update player state atomically
      await client.query(
        `UPDATE players
         SET money = $1, debt_owed = $2
         WHERE game_id = $3 AND id = $4`,
        [updatedMoney, updatedDebtOwed, gameId, playerId]
      );

      await client.query("COMMIT");

      return {
        borrowedAmount: amount,
        debtIncurred,
        updatedMoney,
        updatedDebtOwed,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Move a train for the authenticated user's player and settle opponent track-usage fees.
   *
   * Server-authoritative on: turn ownership, the route and its milepost count,
   * the per-turn movement limit, the first placement (a city milepost), fee
   * calculation, affordability, and money transfers.
   *
   * Movement limit (#312): the server picks the route (`findMovePathWithinBudget`),
   * counts its mileposts and refuses a move that does not fit in what is left of
   * the train type's allowance this turn. The count is stored as the segment
   * `cost` in `movement_history`, which is the server's record of movement used.
   * `args.movementCost` from the client is ignored.
   *
   * Not enforced here yet: half rate and event-based limits (#313), ferry
   * stop/crossing rules (#314). A ferry edge costs no movement.
   *
   * Fee rule:
   * - ECU 4M per distinct opponent whose track is used at any point in the turn.
   * - We therefore charge only for opponents that have NOT already been paid earlier in the same turn.
   */
  static async moveTrainForUser(args: {
    gameId: string;
    userId: string;
    to: { row: number; col: number; x?: number; y?: number };
    /** Ignored. Still accepted so existing callers keep working; the server counts the mileposts. */
    movementCost?: number;
  }): Promise<{
    feeTotal: number;
    ownersUsed: string[];
    ownersPaid: Array<{ playerId: string; amount: number }>;
    affectedPlayerIds: string[];
    updatedPosition: { row: number; col: number; x?: number; y?: number };
    updatedMoney: number;
    cardsDrawnDuringAction: number;
    /** Mileposts the server counted for this move (not the ignored `args.movementCost`). */
    milepostsMoved: number;
    /** Mileposts left this turn after this move, at the plain train-type limit. */
    remainingMovement: number;
  }> {
    const { gameId, userId, to } = args;
    if (!Number.isInteger(to?.row) || !Number.isInteger(to?.col)) {
      throw new MovementRuleError(
        MovementRuleErrorCode.InvalidDestination,
        "Invalid destination: row and col must be integers",
      );
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId);

      const playerId: string = playerRow.id;
      const currentMoney: number = Number(playerRow.money ?? 0);
      const turnNumber: number = Number(playerRow.turnNumber ?? 1);

      const fromRow = playerRow.position_row;
      const fromCol = playerRow.position_col;
      const fromX = playerRow.position_x;
      const fromY = playerRow.position_y;
      const from =
        fromRow != null && fromCol != null
          ? {
              row: Number(fromRow),
              col: Number(fromCol),
              x: fromX != null && Number.isFinite(Number(fromX)) ? Number(fromX) : undefined,
              y: fromY != null && Number.isFinite(Number(fromY)) ? Number(fromY) : undefined,
            }
          : null;

      // ── Event card restriction checks ─────────────────────────────────────
      // Check movement restrictions from active event effects (Snow, Rail Strike)
      const movementRestrictions = await activeEffectManager.getMovementRestrictions(gameId, client);
      const destKey = `${to.row},${to.col}`;
      const destBlocked = isMovementBlockedAtDest(movementRestrictions, destKey);
      if (destBlocked.blocked) {
        console.warn(
          `[PlayerService] Movement rejected by event restriction: type=blocked_terrain gameId=${gameId} playerId=${playerId} destKey=${destKey}`,
        );
        throw new ActionRestrictionError(
          'SNOW_BLOCKED_TERRAIN',
          `Movement blocked by active event (Snow): destination ${destKey} is in the blocked terrain zone`,
        );
      }
      // no_movement_on_player_rail: checked after track usage is computed (below)
      // half_rate: does not block movement, only caps speed — still a client-side cap.
      // The server enforces the plain train-type limit below; half rate is issue #313.
      // ── End restriction checks ────────────────────────────────────────────

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

      // This turn's movement history, read once: the reversal check, the movement
      // budget and the append below all use it. It is the server's record of movement
      // used; the player row is locked, so a concurrent move or undo cannot change it.
      const turnHistoryResult = await client.query(
        `SELECT movement_path FROM movement_history
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3`,
        [playerId, gameId, turnNumber]
      );
      const hasTurnHistoryRow: boolean = turnHistoryResult.rows.length > 0;
      const turnMovementPath: unknown = turnHistoryResult.rows[0]?.movement_path;

      // Reversal validation: trains may only reverse direction at a city or ferry port.
      if (from && (from.row !== to.row || from.col !== to.col)) {
        const movePath = turnMovementPath;
        if (Array.isArray(movePath) && movePath.length > 0) {
          const lastSeg = movePath[movePath.length - 1];
          if (lastSeg?.from && lastSeg?.to) {
            const lastVecRow = lastSeg.to.row - lastSeg.from.row;
            const lastVecCol = lastSeg.to.col - lastSeg.from.col;
            const proposedVecRow = to.row - from.row;
            const proposedVecCol = to.col - from.col;

            // Only check if last move had a non-zero direction
            if (lastVecRow !== 0 || lastVecCol !== 0) {
              const dot = proposedVecRow * lastVecRow + proposedVecCol * lastVecCol;
              if (dot < 0) {
                // Reversal detected — check if last segment crossed a ferry (skip check if so)
                const ferryEdges = getFerryEdges();
                const lastFromKey = `${lastSeg.from.row},${lastSeg.from.col}`;
                const lastToKey = `${lastSeg.to.row},${lastSeg.to.col}`;
                const lastWasFerry = ferryEdges.some(f => {
                  const aKey = `${f.pointA.row},${f.pointA.col}`;
                  const bKey = `${f.pointB.row},${f.pointB.col}`;
                  return (lastFromKey === aKey && lastToKey === bKey) ||
                         (lastFromKey === bKey && lastToKey === aKey);
                });

                if (!lastWasFerry) {
                  // Only allow reversal at city or ferry port terrain
                  const grid = loadGridPoints();
                  const currentPoint = grid.get(`${from.row},${from.col}`);
                  const terrain = currentPoint?.terrain ?? TerrainType.Clear;
                  const canReverse = [
                    TerrainType.MajorCity, TerrainType.MediumCity,
                    TerrainType.SmallCity, TerrainType.FerryPort,
                  ].includes(terrain);

                  if (!canReverse) {
                    throw new Error(
                      "Invalid direction change - can only reverse at cities or ferry ports"
                    );
                  }
                }
              }
            }
          }
        }
      }

      // First placement: the train starts at a city milepost.
      if (!from && !isCityMilepost(to.row, to.col)) {
        throw new MovementRuleError(
          MovementRuleErrorCode.StartNotACity,
          "Invalid starting position: the train must start at a city",
        );
      }

      // Movement left this turn, from the turn's movement history read above.
      // #313 passes its allowance modifiers (half rate) to getTurnMovementAllowance.
      const movementAllowance = getTurnMovementAllowance(
        PlayerService.normalizeTrainType(playerRow.trainType),
      );
      const movementUsedBefore = sumMovementUsed(turnMovementPath);
      const movementLeftBefore = Math.max(0, movementAllowance - movementUsedBefore);

      // Compute the route, its milepost count and the owners used for this move.
      // If this is the first placement (no from), there is no route and no fee.
      let ownersUsed: string[] = [];
      let usesOwnTrack = false;
      let mileposts = 0;
      if (from && (from.row !== to.row || from.col !== to.col)) {
        // Read on the transaction client: a pooled read here would need a second
        // connection while this one holds the player and game row locks.
        const allTracks = await TrackService.getAllTracks(gameId, client);
        const movePath = findMovePathWithinBudget({
          allTracks,
          from: { row: from.row, col: from.col },
          to: { row: to.row, col: to.col },
          currentPlayerId: playerId,
          maxMileposts: movementLeftBefore,
        });
        if (!movePath) {
          // Tell "no track connection" apart from "too far for this turn".
          const usage = computeTrackUsageForMove({
            allTracks,
            from: { row: from.row, col: from.col },
            to: { row: to.row, col: to.col },
            currentPlayerId: playerId,
          });
          if (!usage.isValid) {
            throw new Error(usage.errorMessage || "Invalid move");
          }
          throw new MovementRuleError(
            MovementRuleErrorCode.MovementExceeded,
            `Invalid move: the destination is beyond the ${movementLeftBefore} of ${movementAllowance} mileposts left this turn`,
          );
        }
        ownersUsed = Array.from(movePath.ownersUsed);
        // Check if any edge in the path is owned by the current player
        usesOwnTrack = movePath.path.some(edge => edge.ownerPlayerIds.includes(playerId));
        mileposts = movePath.mileposts;
      }

      // ── Rail Strike: reject if this move uses the targeted player's own track ──
      // This check must happen after track usage is computed so we know which
      // track edges are involved. The player can still move on opponent or
      // public track; only movement on their own rail is blocked.
      if (usesOwnTrack && isMovementOnOwnRailBlocked(movementRestrictions, playerId, playerId)) {
        console.warn(
          `[PlayerService] Movement rejected by event restriction: type=no_movement_on_player_rail gameId=${gameId} playerId=${playerId}`,
        );
        throw new ActionRestrictionError(
          'RAIL_STRIKE_BLOCKED',
          `Movement blocked by active event (Rail Strike): player ${playerId} cannot move on their own track this turn`,
        );
      }

      const newlyPayable = ownersUsed.filter((pid) => !alreadyPaid.has(pid));
      const ownersPaid: Array<{ playerId: string; amount: number }> = newlyPayable.map((pid) => ({
        playerId: pid,
        amount: TRACK_USAGE_FEE,
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

      // Persist movement history with the server-computed milepost count. The sum of
      // these costs is the movement used this turn (enforced above, shown on reload).
      // Build movement segment matching the TrackSegment structure
      const movementSegment = {
        from: from ? { x: from.x, y: from.y, row: from.row, col: from.col, terrain: 0 } : null,
        to: { x: to.x, y: to.y, row: to.row, col: to.col, terrain: 0 },
        cost: mileposts,
      };

      if (hasTurnHistoryRow) {
        // Append to existing movement path
        const existingPath = Array.isArray(turnMovementPath) ? turnMovementPath : [];
        const updatedPath = [...existingPath, movementSegment];
        await client.query(
          `UPDATE movement_history
           SET movement_path = $1, updated_at = CURRENT_TIMESTAMP
           WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
          [JSON.stringify(updatedPath), playerId, gameId, turnNumber]
        );
      } else {
        // Insert new movement history record
        await client.query(
          `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
           VALUES ($1, $2, $3, $4)`,
          [playerId, gameId, turnNumber, JSON.stringify([movementSegment])]
        );
      }

      await client.query("COMMIT");

      const affectedPlayerIds = [playerId, ...ownersPaid.map((p) => p.playerId)];
      return {
        feeTotal,
        ownersUsed,
        ownersPaid,
        affectedPlayerIds,
        updatedPosition: { row: to.row, col: to.col, x: to.x, y: to.y },
        updatedMoney: currentMoney - feeTotal,
        // Movement never draws cards directly
        cardsDrawnDuringAction: 0,
        milepostsMoved: mileposts,
        remainingMovement: movementLeftBefore - mileposts,
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
    | { kind: "deliver"; updatedMoney: number; updatedDebtOwed: number; updatedLoads: LoadType[]; restoredCard: DemandCard; removedCardId: number }
    | { kind: "move"; updatedMoney: number; restoredPosition: { row: number; col: number; x?: number; y?: number }; ownersReversed: Array<{ playerId: string; amount: number }>; feeTotal: number }
    | ({ kind: "pickup" | "drop" } & LoadActionResult)
  > {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId);

      const playerId: string = playerRow.id;
      const currentMoney: number = playerRow.money;
      const currentDebtOwed: number = Number(playerRow.debtOwed ?? 0);
      const currentHand: unknown = playerRow.hand;
      const currentLoads: unknown = playerRow.loads;
      const turnNumber: number = Number(playerRow.turnNumber ?? 1);

      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const loads: LoadType[] = Array.isArray(currentLoads)
        ? (currentLoads as unknown[]).filter((v): v is LoadType => typeof v === "string") as LoadType[]
        : [];

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
      if (last && (last.kind === "pickup" || last.kind === "drop")) {
        // Load pickup/drop (#310): put the train's loads and the city's chips back.
        const loadAction = last as TurnActionPickup | TurnActionDrop;
        const undone = await undoLoadActionInTransaction(client, {
          gameId,
          playerId,
          action: loadAction,
          currentLoads: loads,
          capacity: getTrainCapacity(PlayerService.normalizeTrainType(playerRow.trainType)),
        });
        await client.query(
          `UPDATE turn_actions
           SET actions = $1::jsonb
           WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
          [JSON.stringify(actions.slice(0, actions.length - 1)), playerId, gameId, turnNumber]
        );
        const droppedLoads = await getDroppedLoadsInTransaction(client, gameId);
        await client.query("COMMIT");
        return { kind: loadAction.kind, ...undone, droppedLoads };
      }
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

        // Pop last action from turn_actions
        const remainingActions = actions.slice(0, actions.length - 1);
        await client.query(
          `UPDATE turn_actions
           SET actions = $1::jsonb
           WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
          [JSON.stringify(remainingActions), playerId, gameId, turnNumber]
        );

        // Also remove the last movement segment from movement_history
        // so remainingMovement is recalculated correctly on refresh
        const historyResult = await client.query(
          `SELECT movement_path FROM movement_history
           WHERE player_id = $1 AND game_id = $2 AND turn_number = $3
           FOR UPDATE`,
          [playerId, gameId, turnNumber]
        );
        if (historyResult.rows.length > 0) {
          const movementPath = historyResult.rows[0].movement_path || [];
          if (Array.isArray(movementPath) && movementPath.length > 0) {
            const updatedPath = movementPath.slice(0, movementPath.length - 1);
            await client.query(
              `UPDATE movement_history
               SET movement_path = $1, updated_at = CURRENT_TIMESTAMP
               WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
              [JSON.stringify(updatedPath), playerId, gameId, turnNumber]
            );
          }
        }

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
      const repayment = Number(last.repayment ?? 0);
      const loadType = last.loadType as LoadType;

      if (!handIds.includes(removedCardId)) {
        throw new Error("Hand does not contain drawn card to undo");
      }
      if (!Number.isFinite(payment)) {
        throw new Error("Invalid payment on action");
      }

      const restoredCard = DemandDeckService.getCard(restoredCardId);
      if (!restoredCard) {
        throw new Error("Invalid demand card on action");
      }

      // Undo debt repayment and money changes:
      // - If debt was repaid, restore it (add back repayment to debt)
      // - Subtract the net payment (payment - repayment) that went to money
      const netPayment = payment - repayment;
      const updatedMoney = currentMoney - netPayment;
      const updatedDebtOwed = currentDebtOwed + repayment;
      if (!Number.isFinite(updatedMoney) || !Number.isFinite(updatedDebtOwed)) {
        throw new Error("Invalid money or debt update");
      }

      const updatedHandIds = handIds.map((id) => (id === removedCardId ? restoredCardId : id));
      const updatedLoads = [...loads, loadType];

      // Return the dealt card to the deck before committing player state.
      const demandDeckService = await DemandDeckService.loadForGame(gameId, client);
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
         SET money = $1, hand = $2, loads = $3, debt_owed = $4
         WHERE game_id = $5 AND id = $6`,
        [updatedMoney, updatedHandIds, updatedLoads, updatedDebtOwed, gameId, playerId]
      );

      const remainingActions = actions.slice(0, actions.length - 1);
      await client.query(
        `UPDATE turn_actions
         SET actions = $1::jsonb
         WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
        [JSON.stringify(remainingActions), playerId, gameId, turnNumber]
      );

      await demandDeckService.persist(client);
      await client.query("COMMIT");
      return { kind: "deliver", updatedMoney, updatedDebtOwed, updatedLoads, restoredCard, removedCardId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Core card-discard logic: discard old hand, draw 3 new Demand cards, persist
   * the hand and the deck in the caller's transaction.
   * Does NOT validate turns or advance the game turn — callers handle that.
   *
   * @returns newHandIds (persisted to DB).
   */
  private static async discardHandCore(
    gameId: string,
    playerId: string,
    handIds: number[],
    client: import("pg").PoolClient
  ): Promise<{ newHandIds: number[] }> {
    const demandDeckService = await DemandDeckService.loadForGame(gameId, client);
    // Discard old hand (must be currently dealt).
    for (const id of handIds) {
      demandDeckService.discardCard(id);
    }

    // Draw replacement hand (future-proof loop structure).
    // Event cards drawn during this process are discarded and replaced.
    const newCards: DemandCard[] = [];
    while (newCards.length < 3) {
      const result = demandDeckService.drawCard();
      if (!result) {
        throw new Error("Failed to draw new demand card");
      }
      if (result.type === 'event') {
        // Process the event card via EventCardService (replaces Project 1 discard stub)
        console.info(`[discardHandCore] Drew event card ${result.card.id} — processing via EventCardService`);
        const discardEventResult = await EventCardService.processEventCard(gameId, result.card, playerId, client);
        await PlayerService.persistEventEffect(gameId, discardEventResult, client, 'discardHandCore', result.card);
        demandDeckService.discardEventCard(result.card.id);
        continue;
      }
      newCards.push(result.card);
    }
    const newHandIds = newCards.map((c) => c.id);

    await client.query(
      `UPDATE players
       SET hand = $1
       WHERE game_id = $2 AND id = $3`,
      [newHandIds, gameId, playerId]
    );
    await demandDeckService.persist(client);

    return { newHandIds };
  }

  /**
   * Discard a player's entire hand and draw 3 new Demand cards.
   * Accepts playerId directly — works for both human and bot players.
   * Does NOT advance the game turn; callers manage turn lifecycle.
   */
  static async discardHandForPlayer(
    gameId: string,
    playerId: string
  ): Promise<{ newHandIds: number[] }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Fetch current hand with row lock.
      const playerResult = await client.query(
        `SELECT hand
         FROM players
         WHERE game_id = $1 AND id = $2
         LIMIT 1
         FOR UPDATE`,
        [gameId, playerId]
      );
      if (playerResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const currentHand: unknown = playerResult.rows[0].hand;
      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];

      const coreResult = await PlayerService.discardHandCore(gameId, playerId, handIds, client);

      await client.query("COMMIT");
      await PlayerService.flushEventEmissions();
      return { newHandIds: coreResult.newHandIds };
    } catch (err) {
      PlayerService.pendingEmissions.length = 0;
      // The deck is persisted in this transaction, so ROLLBACK also restores it.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* rollback best-effort */
      }
      throw err;
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
    try {
      await client.query("BEGIN");

      const { player: playerRow, currentPlayerIndex } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: MERCY_ACTION_STATUSES,
      });

      const playerId: string = playerRow.id;
      const currentHand: unknown = playerRow.hand;
      const turnNumber: number = Number(playerRow.turnNumber ?? 1);
      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];

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

      // Core card logic: discard old hand, draw 3 new cards, persist.
      const coreResult = await PlayerService.discardHandCore(gameId, playerId, handIds, client);

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
      // The deck is persisted in this transaction, so ROLLBACK also restores it.
      await client.query("ROLLBACK");
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
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: MERCY_ACTION_STATUSES,
      });

      const playerId: string = playerRow.id;
      const currentHand: unknown = playerRow.hand;
      const turnNumber: number = Number(playerRow.turnNumber ?? 1);
      const handIds: number[] = Array.isArray(currentHand)
        ? currentHand.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];

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
      const demandDeckService = await DemandDeckService.loadForGame(gameId, client);
      for (const id of handIds) {
        demandDeckService.discardCard(id);
      }

      // Draw replacement hand (event cards discarded and replaced per game rules).
      const newCards: DemandCard[] = [];
      while (newCards.length < 3) {
        const result = demandDeckService.drawCard();
        if (!result) {
          throw new Error("Failed to draw new demand card");
        }
        if (result.type === 'event') {
          console.warn(`[restartPlayer] Drew event card ${result.card.id} during restart hand — discarding`);
          demandDeckService.discardEventCard(result.card.id);
          continue;
        }
        newCards.push(result.card);
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

      await demandDeckService.persist(client);
      await client.query("COMMIT");

      // Return updated player with proper hand filtering for this user (includes new hand).
      const updatedPlayers = await this.getPlayers(gameId, userId);
      const updatedPlayer = updatedPlayers.find((p) => p.id === playerId);
      if (!updatedPlayer) {
        throw new Error("Failed to load updated player");
      }
      return updatedPlayer;
    } catch (error) {
      // The deck is persisted in this transaction, so ROLLBACK also restores it.
      await client.query("ROLLBACK");
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

      // Locks the player row, so a double submit cannot race the funds check.
      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: MERCY_ACTION_STATUSES,
      });
      const playerId: string = playerRow.id;
      const currentMoney: number = playerRow.money;
      const currentTrainType: TrainType = playerRow.trainType as TrainType;
      const currentLoads: unknown = playerRow.loads;
      const currentLoadCount = Array.isArray(currentLoads) ? currentLoads.length : 0;

      // Track spend this turn (server-side). Read on the transaction's client:
      // a pooled read here would need a second connection while this one
      // holds the player row lock.
      const trackState = await TrackService.getTrackState(gameId, playerId, client);
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

  /**
   * Refuse a pickup at a city where an active event (coastal Strike) forbids it.
   * Reads through the caller's transaction client, so it needs no second
   * pooled connection while the caller holds row locks.
   *
   * @throws ActionRestrictionError when the city is in the strike zone.
   */
  private static async assertPickupNotRestricted(
    client: PoolClient,
    gameId: string,
    playerId: string,
    cityName: string,
  ): Promise<void> {
    const pickupRestrictions = await activeEffectManager.getPickupDeliveryRestrictions(gameId, client);
    const pickupCityKey = getCityMilepointKey(cityName) ?? '';
    const pickupBlocked = isPickupDeliveryBlocked(pickupRestrictions, pickupCityKey);
    if (pickupBlocked.blocked) {
      console.warn(
        `[PlayerService] Pickup rejected by event restriction: type=no_pickup_delivery_in_zone gameId=${gameId} playerId=${playerId} city=${cityName} cityKey=${pickupCityKey}`,
      );
      throw new ActionRestrictionError(
        'COASTAL_STRIKE_BLOCKED',
        `Pickup blocked by active event (Strike): city ${cityName} is within the coastal strike zone`,
      );
    }
  }

  /**
   * Pick up a load for a bot player. Validates train capacity and event
   * restrictions, appends the load to the player's loads array and takes a
   * dropped chip of that type out of the city, all in one transaction.
   *
   * Trusted caller: the bot planner has already checked that the bot is at the
   * city and that the city supplies the load. Requests from a client go through
   * `pickupLoadForUser`, which checks both.
   */
  static async pickupLoadForPlayer(
    gameId: string,
    playerId: string,
    loadType: LoadType,
    cityName: string,
  ): Promise<{ updatedLoads: LoadType[]; cardsDrawnDuringAction: number }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Lock the player row and read current state
      const playerResult = await client.query(
        `SELECT loads, train_type as "trainType"
         FROM players
         WHERE id = $1 AND game_id = $2
         FOR UPDATE`,
        [playerId, gameId],
      );
      if (playerResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const currentLoads: LoadType[] = Array.isArray(playerResult.rows[0].loads)
        ? (playerResult.rows[0].loads as LoadType[])
        : [];
      const trainType = PlayerService.normalizeTrainType(playerResult.rows[0].trainType);
      const capacity = getTrainCapacity(trainType);

      // A full train is refused with the capacity error before the event check, as before.
      if (currentLoads.length < capacity) {
        await PlayerService.assertPickupNotRestricted(client, gameId, playerId, cityName);
      }

      const { updatedLoads } = await pickupLoadInTransaction(client, {
        gameId,
        playerId,
        loadType,
        cityName,
        currentLoads,
        capacity,
      });

      await client.query("COMMIT");
      return { updatedLoads, cardsDrawnDuringAction: 0 };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Pick up a load for the authenticated user's player.
   *
   * Server-authoritative:
   * - Validate membership, game status and turn (`lockPlayerForUserTurn`)
   * - Validate the train is at the city, has spare capacity, and the load can
   *   be had there: a chip dropped in the city, or a chip left in the tray for
   *   a load the city produces
   * - Validate no active event forbids the pickup
   * - Update the train's loads and the city's dropped chips, and log the
   *   action for undo, in one transaction
   *
   * @throws TurnGuardError, LoadActionError or ActionRestrictionError.
   */
  static async pickupLoadForUser(
    gameId: string,
    userId: string,
    loadType: LoadType,
    cityName: string,
  ): Promise<LoadActionResult> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId);
      const playerId: string = playerRow.id;
      const currentLoads: LoadType[] = Array.isArray(playerRow.loads)
        ? (playerRow.loads as LoadType[])
        : [];

      const { updatedLoads, source } = await pickupLoadInTransaction(client, {
        gameId,
        playerId,
        loadType,
        cityName,
        currentLoads,
        capacity: getTrainCapacity(PlayerService.normalizeTrainType(playerRow.trainType)),
        boardRules: { position: { row: playerRow.position_row, col: playerRow.position_col } },
      });
      // Thrown after the writes above; the ROLLBACK below discards them.
      await PlayerService.assertPickupNotRestricted(client, gameId, playerId, cityName);

      await appendTurnAction(client, gameId, playerId, Number(playerRow.turnNumber ?? 1), {
        kind: "pickup",
        city: cityName,
        loadType,
        source,
      });
      const droppedLoads = await getDroppedLoadsInTransaction(client, gameId);

      await client.query("COMMIT");
      return { updatedLoads, droppedLoads, trayChanges: trayChangesForPickup(loadType, source) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Drop a load for a bot player at a city. Validates the player is carrying
   * the load, removes it from their loads array and applies the city-drop rule
   * (see `dropLoadInTransaction`), all in one transaction.
   *
   * Trusted caller: the bot executor resolves the city from the bot's
   * position. Requests from a client go through `dropLoadForUser`.
   */
  static async dropLoadForPlayer(
    gameId: string,
    playerId: string,
    loadType: LoadType,
    cityName: string,
  ): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Lock the player row and read current loads
      const playerResult = await client.query(
        `SELECT loads
         FROM players
         WHERE id = $1 AND game_id = $2
         FOR UPDATE`,
        [playerId, gameId],
      );
      if (playerResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const currentLoads: LoadType[] = Array.isArray(playerResult.rows[0].loads)
        ? (playerResult.rows[0].loads as LoadType[])
        : [];

      await dropLoadInTransaction(client, {
        gameId,
        playerId,
        loadType,
        cityName,
        currentLoads,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Drop a load for the authenticated user's player.
   *
   * Server-authoritative:
   * - Validate membership, game status and turn (`lockPlayerForUserTurn`)
   * - Validate the train is at the city and carries the load
   * - Apply the city-drop rule: a load the city produces returns to the tray;
   *   any other load stays in the city and a chip already there returns to
   *   the tray
   * - Update the train's loads and the city's dropped chips, and log the
   *   action for undo, in one transaction
   *
   * @throws TurnGuardError or LoadActionError.
   */
  static async dropLoadForUser(
    gameId: string,
    userId: string,
    loadType: LoadType,
    cityName: string,
  ): Promise<LoadActionResult> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const { player: playerRow } = await lockPlayerForUserTurn(client, gameId, userId);
      const playerId: string = playerRow.id;
      const currentLoads: LoadType[] = Array.isArray(playerRow.loads)
        ? (playerRow.loads as LoadType[])
        : [];

      const { updatedLoads, placement, displaced } = await dropLoadInTransaction(client, {
        gameId,
        playerId,
        loadType,
        cityName,
        currentLoads,
        boardRules: { position: { row: playerRow.position_row, col: playerRow.position_col } },
      });

      await appendTurnAction(client, gameId, playerId, Number(playerRow.turnNumber ?? 1), {
        kind: "drop",
        city: cityName,
        loadType,
        placement,
        displaced,
      });
      const droppedLoads = await getDroppedLoadsInTransaction(client, gameId);

      await client.query("COMMIT");
      return {
        updatedLoads,
        droppedLoads,
        trayChanges: trayChangesForDrop(loadType, placement, displaced),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Validate, price and store new track inside the caller's transaction
   * (issue #308). The one write path for track built through the server:
   * `buildTrackForUser` (humans) and `buildTrackForPlayer` (bots) both end here.
   *
   * Nothing about the board is taken from the caller: the builder's and every
   * other player's track are read (and locked) here, each section's cost is
   * recomputed, and the rules in `planTrackBuild` are applied. The event-card
   * build restrictions are read on `client`, never through the pool, because
   * the caller already holds row locks.
   *
   * Logs one `build` entry per section in `turn_actions`, and charges in one
   * of two ways, never both:
   * - `chargeNow: false` (humans): the cost is added to
   *   `player_tracks.turn_build_cost`, the spend not yet taken from `money`;
   *   `settleTurnBuildCost` charges it later.
   * - `chargeNow: true` (bots): the cost is taken from `money` here and
   *   `turn_build_cost` is left alone, so no later settlement can charge it.
   *
   * The caller must hold the player's row FOR UPDATE.
   *
   * @throws TrackBuildError when a build rule is broken.
   * @throws ActionRestrictionError when an active event card forbids the build.
   */
  private static async applyTrackBuild(
    client: PoolClient,
    args: {
      gameId: string;
      playerId: string;
      money: number;
      turnNumber: number;
      chargeNow: boolean;
      /** Turns the builder's stored track into the sections to build. */
      edgesFor: (ownSegments: readonly TrackSegment[]) => TrackBuildEdge[];
    },
  ): Promise<{ segments: TrackSegment[]; cost: number; turnBuildCost: number; money: number }> {
    const { gameId, playerId, turnNumber } = args;
    let money = args.money;

    // Every player's track in the game, locked so right of way cannot be raced.
    const trackRows = await client.query(
      `SELECT player_id, segments, turn_build_cost,
              COALESCE(pending_flood_rebuilds, '[]'::jsonb) AS pending_flood_rebuilds
       FROM player_tracks
       WHERE game_id = $1
       ORDER BY player_id
       FOR UPDATE`,
      [gameId],
    );
    let ownSegments: TrackSegment[] = [];
    let unsettledCost = 0;
    let pendingFloodRebuilds: TrackSegment[] = [];
    const otherPlayersSegments: TrackSegment[] = [];
    for (const row of trackRows.rows) {
      const segments = PlayerService.parseTrackSegments(row.segments);
      if (row.player_id === playerId) {
        ownSegments = segments;
        unsettledCost = Number(row.turn_build_cost ?? 0);
        pendingFloodRebuilds = PlayerService.parseTrackSegments(row.pending_flood_rebuilds);
      } else {
        otherPlayersSegments.push(...segments);
      }
    }

    const actionsRow = await client.query(
      `SELECT actions
       FROM turn_actions
       WHERE player_id = $1 AND game_id = $2 AND turn_number = $3
       FOR UPDATE`,
      [playerId, gameId, turnNumber],
    );
    const buildsThisTurn = buildActionsOf(actionsRow.rows[0]?.actions);
    const loggedSpend = buildsThisTurn.reduce(
      (sum: number, action: TurnActionBuild): number => sum + action.segment.cost,
      0,
    );

    const plan = planTrackBuild({
      edges: args.edgesFor(ownSegments),
      ownSegments,
      otherPlayersSegments,
      money,
      // The action log survives a mid-turn settlement (which zeroes
      // turn_build_cost); turn_build_cost also counts track saved through the
      // legacy /tracks/save route. The larger of the two is this turn's spend.
      turnSpent: Math.max(unsettledCost, loggedSpend),
      unsettledCost,
      majorCityStartsThisTurn: buildsThisTurn.flatMap(
        (action: TurnActionBuild): string[] => (action.majorCityStart ? [action.majorCityStart] : []),
      ),
    });
    const newSegments = plan.segments.map((planned: PlannedTrackSegment): TrackSegment => planned.segment);

    // ── Event card restriction checks ─────────────────────────────────────
    // Build restrictions from active event effects (Snow blocked_terrain, Rail Strike)
    const buildRestrictions = await activeEffectManager.getBuildRestrictions(gameId, client);
    for (const seg of newSegments) {
      const segDestKey = `${seg.to.row},${seg.to.col}`;
      const buildBlockResult = isBuildBlockedAtMilepost(buildRestrictions, segDestKey, playerId);
      if (buildBlockResult.blocked) {
        console.warn(
          `[PlayerService] Build rejected by event restriction: reason=${buildBlockResult.reason} gameId=${gameId} playerId=${playerId} destKey=${segDestKey}`,
        );
        const errorCode: ActionRestrictionErrorCode =
          buildBlockResult.reason === 'blocked_terrain' ? 'SNOW_BLOCKED_TERRAIN' : 'BUILD_BLOCKED';
        const message =
          buildBlockResult.reason === 'blocked_terrain'
            ? `Build blocked by active event (Snow): destination milepost ${segDestKey} is in the blocked terrain zone`
            : `Build blocked by active event (Rail Strike): player ${playerId} cannot build track this turn`;
        throw new ActionRestrictionError(errorCode, message);
      }
    }

    // Active Flood effects block rebuilding across the flooded river
    // (Product Decision 2: Flood does NOT emit a BuildRestriction — we check floodedRiver directly)
    const activeEffects = await activeEffectManager.getActiveEffects(gameId, client);
    for (const seg of newSegments) {
      const floodResult = isFloodRebuildBlocked(activeEffects, seg);
      if (floodResult.blocked) {
        console.warn(
          `[PlayerService] Build rejected by event restriction: type=flood_rebuild gameId=${gameId} playerId=${playerId} river=${floodResult.river}`,
        );
        throw new ActionRestrictionError(
          'FLOOD_BRIDGE_REBUILD_BLOCKED',
          `Build blocked: cannot rebuild track across the ${floodResult.river} river while Flood event is active`,
        );
      }
    }
    // ── End restriction checks ────────────────────────────────────────────

    // Bridges rebuilt here no longer need rebuilding.
    const updatedPendingRebuilds = pendingFloodRebuilds.filter(
      (pending: TrackSegment): boolean =>
        !newSegments.some((built: TrackSegment): boolean => areSegmentsEqual(pending, built)),
    );

    const allSegments = [...ownSegments, ...newSegments];
    const totalCost = allSegments.reduce((sum: number, seg: TrackSegment): number => sum + seg.cost, 0);
    const turnBuildCost = args.chargeNow ? unsettledCost : unsettledCost + plan.cost;
    await client.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp, pending_flood_rebuilds)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (game_id, player_id)
       DO UPDATE SET segments = $3, total_cost = $4, turn_build_cost = $5, last_build_timestamp = NOW(), pending_flood_rebuilds = $6`,
      [gameId, playerId, JSON.stringify(allSegments), totalCost, turnBuildCost, JSON.stringify(updatedPendingRebuilds)],
    );

    const buildActions: TurnActionBuild[] = plan.segments.map(
      (planned: PlannedTrackSegment): TurnActionBuild => ({ kind: "build", ...planned }),
    );
    await client.query(
      `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (player_id, game_id, turn_number)
       DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
      [playerId, gameId, turnNumber, JSON.stringify(buildActions)],
    );

    if (args.chargeNow) {
      const moneyResult = await client.query(
        `UPDATE players SET money = money - $1 WHERE id = $2 RETURNING money`,
        [plan.cost, playerId],
      );
      money = Number(moneyResult.rows[0]?.money);
    }

    return { segments: newSegments, cost: plan.cost, turnBuildCost, money };
  }

  /** `player_tracks` JSONB comes back parsed; older rows and test setups may hold a string. */
  private static parseTrackSegments(raw: unknown): TrackSegment[] {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(parsed) ? (parsed as TrackSegment[]) : [];
  }

  /**
   * Build track for a bot (server-internal; humans use `buildTrackForUser`).
   *
   * Goes through the same validation as a human build (`applyTrackBuild`):
   * only the endpoints of `newSegments` are used. Their `cost` fields are
   * ignored and recomputed, and the bot's existing track is read from the
   * database rather than taken from the caller.
   *
   * Bots are charged in the same transaction, for exactly the validated cost;
   * they never carry unsettled spend in `turn_build_cost`, so the end-of-turn
   * settlement that charges humans has nothing to charge them.
   *
   * @returns the bot's money after the charge, the cost charged, and the
   *   sections as stored (with server-computed costs).
   * @throws TrackBuildError when a build rule is broken.
   * @throws ActionRestrictionError when an active event card forbids the build.
   */
  static async buildTrackForPlayer(
    gameId: string,
    playerId: string,
    newSegments: TrackSegment[],
  ): Promise<{ remainingMoney: number; cardsDrawnDuringAction: number; cost: number; segments: TrackSegment[] }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const playerResult = await client.query(
        `SELECT money, current_turn_number FROM players WHERE id = $1 AND game_id = $2 FOR UPDATE`,
        [playerId, gameId],
      );
      if (playerResult.rows.length === 0) {
        throw new Error("Player not found in game");
      }

      const built = await PlayerService.applyTrackBuild(client, {
        gameId,
        playerId,
        money: Number(playerResult.rows[0].money),
        turnNumber: Number(playerResult.rows[0].current_turn_number ?? 1),
        chargeNow: true,
        edgesFor: (): TrackBuildEdge[] =>
          newSegments.map((seg: TrackSegment): TrackBuildEdge => ({
            from: { row: seg.from.row, col: seg.from.col },
            to: { row: seg.to.row, col: seg.to.col },
          })),
      });

      await client.query("COMMIT");

      return {
        remainingMoney: built.money,
        cardsDrawnDuringAction: 0,
        cost: built.cost,
        segments: built.segments,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Build track for the calling user's player along `path`, an ordered list of
   * mileposts (issue #308). Server-authoritative: the turn guard picks the
   * player from the session, and `applyTrackBuild` validates and prices the
   * track.
   *
   * Money is NOT deducted here. The cost is added to `turn_build_cost` and
   * charged once by `settleTurnBuildCost` (end of turn, or the explicit
   * settle / victory calls), which is how track saved through the legacy
   * `/api/tracks/save` route is charged too. Charging in both places would
   * bill the same track twice.
   *
   * @returns the sections built (server-priced), their total cost, the turn's
   *   unsettled build spend, and the player's money (unchanged).
   * @throws TurnGuardError when the user may not act right now.
   * @throws TrackBuildError when a build rule is broken.
   * @throws ActionRestrictionError when an active event card forbids the build.
   */
  static async buildTrackForUser(
    gameId: string,
    userId: string,
    path: readonly TrackCostCoord[],
  ): Promise<{ playerId: string; segments: TrackSegment[]; cost: number; turnBuildCost: number; money: number }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { player } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: TRACK_BUILD_STATUSES,
      });
      const built = await PlayerService.applyTrackBuild(client, {
        gameId,
        playerId: player.id,
        money: Number(player.money),
        turnNumber: Number(player.turnNumber ?? 1),
        chargeNow: false,
        edgesFor: (ownSegments: readonly TrackSegment[]): TrackBuildEdge[] =>
          pathToBuildEdges(path, ownSegments),
      });
      await client.query("COMMIT");
      return { playerId: player.id, ...built };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Remove the last track section the calling user built this turn and give
   * its cost back (issue #308).
   *
   * Undo is strictly last-in-first-out across the turn's action log: the
   * player's most recent logged action must be a `build` entry. That keeps the
   * network connected (a section is always removed before the one it hangs
   * off) and matches the order of the client's undo stack.
   *
   * The refund comes off the unsettled `turn_build_cost` first; whatever a
   * mid-turn settlement already charged is returned to `money`.
   *
   * A section a Flood erased after it was built is gone already: its log entry
   * is dropped and nothing is refunded.
   *
   * @throws TurnGuardError when the user may not act right now.
   * @throws TrackBuildError NoSegmentToUndo when the last action is not a build.
   */
  static async undoTrackSegmentForUser(
    gameId: string,
    userId: string,
  ): Promise<{ playerId: string; removedSegment: TrackSegment; refunded: number; turnBuildCost: number; money: number }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { player } = await lockPlayerForUserTurn(client, gameId, userId, {
        allowedStatuses: TRACK_BUILD_STATUSES,
      });
      const playerId = player.id;
      const turnNumber = Number(player.turnNumber ?? 1);

      const actionsRow = await client.query(
        `SELECT actions
         FROM turn_actions
         WHERE player_id = $1 AND game_id = $2 AND turn_number = $3
         FOR UPDATE`,
        [playerId, gameId, turnNumber],
      );
      const actions: unknown[] = Array.isArray(actionsRow.rows[0]?.actions) ? actionsRow.rows[0].actions : [];
      const last = buildActionsOf(actions.slice(-1))[0];
      if (!last) {
        throw new TrackBuildError(
          TrackBuildErrorCode.NoSegmentToUndo,
          actions.length === 0
            ? "No track built this turn to undo"
            : "The last action this turn is not a track build",
        );
      }

      const trackRow = await client.query(
        `SELECT segments, turn_build_cost
         FROM player_tracks
         WHERE game_id = $1 AND player_id = $2
         FOR UPDATE`,
        [gameId, playerId],
      );
      const segments = PlayerService.parseTrackSegments(trackRow.rows[0]?.segments);
      const unsettledCost = Number(trackRow.rows[0]?.turn_build_cost ?? 0);

      let index = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (areSegmentsEqual(segments[i], last.segment)) {
          index = i;
          break;
        }
      }

      let refunded = 0;
      let turnBuildCost = unsettledCost;
      let money = Number(player.money);
      if (index >= 0) {
        refunded = last.segment.cost;
        const fromUnsettled = Math.min(refunded, unsettledCost);
        const fromMoney = refunded - fromUnsettled;
        turnBuildCost = unsettledCost - fromUnsettled;
        const remaining = [...segments.slice(0, index), ...segments.slice(index + 1)];
        const totalCost = remaining.reduce((sum: number, seg: TrackSegment): number => sum + seg.cost, 0);
        await client.query(
          `UPDATE player_tracks
           SET segments = $1, total_cost = $2, turn_build_cost = $3
           WHERE game_id = $4 AND player_id = $5`,
          [JSON.stringify(remaining), totalCost, turnBuildCost, gameId, playerId],
        );
        if (fromMoney > 0) {
          const moneyRow = await client.query(
            `UPDATE players SET money = money + $1 WHERE game_id = $2 AND id = $3 RETURNING money`,
            [fromMoney, gameId, playerId],
          );
          money = Number(moneyRow.rows[0]?.money ?? money);
        }
      }

      await client.query(
        `UPDATE turn_actions
         SET actions = $1::jsonb
         WHERE player_id = $2 AND game_id = $3 AND turn_number = $4`,
        [JSON.stringify(actions.slice(0, -1)), playerId, gameId, turnNumber],
      );

      await client.query("COMMIT");
      return { playerId, removedSegment: last.segment, refunded, turnBuildCost, money };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
