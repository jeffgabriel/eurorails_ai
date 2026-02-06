import type { TurnPlan, TurnPlanAction, ExecutionResult } from '../../../shared/types/AITypes';
import { AIActionType } from '../../../shared/types/AITypes';
import type { TrainType } from '../../../shared/types/GameTypes';
import { TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import type { LoadType } from '../../../shared/types/LoadTypes';
import type { PoolClient } from 'pg';
import { db } from '../../db/index';
import { demandDeckService } from '../demandDeckService';
import { TrackService } from '../trackService';
import { emitToGame } from '../socketService';

/**
 * Result of executing an entire TurnPlan.
 */
export interface TurnExecutionResult {
  readonly success: boolean;
  readonly actionResults: readonly ActionExecutionResult[];
  readonly error?: string;
  readonly totalDurationMs: number;
}

/**
 * Result for an individual action within the plan.
 */
export interface ActionExecutionResult {
  readonly actionType: AIActionType;
  readonly success: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * Tracks in-memory deck mutations for rollback compensation.
 */
interface DeckMutation {
  drawnCardId: number;
  discardedCardId: number;
}

/**
 * Executes a validated TurnPlan by calling the same server-side operations
 * used for human players. All actions execute within a single PostgreSQL
 * transaction for atomicity: either all succeed or all roll back.
 */
export class TurnExecutor {
  /**
   * Execute a TurnPlan atomically within a single database transaction.
   *
   * @param plan - The validated TurnPlan to execute
   * @param gameId - The game ID
   * @param playerId - The bot's player ID (not userId)
   * @returns TurnExecutionResult with per-action results
   */
  static async execute(
    plan: TurnPlan,
    gameId: string,
    playerId: string,
  ): Promise<TurnExecutionResult> {
    const startTime = Date.now();
    const actionResults: ActionExecutionResult[] = [];
    const deckMutations: DeckMutation[] = [];

    if (!plan.actions || plan.actions.length === 0) {
      return {
        success: true,
        actionResults: [],
        totalDurationMs: Date.now() - startTime,
      };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < plan.actions.length; i++) {
        const action = plan.actions[i];
        const actionStart = Date.now();

        try {
          const deckMutation = await this.executeAction(
            action,
            gameId,
            playerId,
            client,
          );
          if (deckMutation) {
            deckMutations.push(deckMutation);
          }

          actionResults.push({
            actionType: action.type,
            success: true,
            durationMs: Date.now() - actionStart,
          });
        } catch (error) {
          actionResults.push({
            actionType: action.type,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - actionStart,
          });

          // Rollback everything on first failure
          await client.query('ROLLBACK');
          this.compensateDeckMutations(deckMutations);

          return {
            success: false,
            actionResults,
            error: `Action ${i + 1} (${action.type}) failed: ${error instanceof Error ? error.message : String(error)}`,
            totalDurationMs: Date.now() - startTime,
          };
        }
      }

      await client.query('COMMIT');

      // Emit AI action event for client-side animation after successful commit
      emitToGame(gameId, 'ai:turnComplete', {
        playerId,
        actionCount: plan.actions.length,
        timestamp: Date.now(),
      });

      return {
        success: true,
        actionResults,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      // Safety net: if BEGIN or COMMIT itself fails
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      this.compensateDeckMutations(deckMutations);

      return {
        success: false,
        actionResults,
        error: error instanceof Error ? error.message : String(error),
        totalDurationMs: Date.now() - startTime,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Dispatch a single action to the appropriate handler.
   * Returns a DeckMutation if the action modified the in-memory demand deck.
   */
  private static async executeAction(
    action: TurnPlanAction,
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<DeckMutation | null> {
    switch (action.type) {
      case AIActionType.DeliverLoad:
        return this.executeDeliverLoad(action, gameId, playerId, client);
      case AIActionType.PickupAndDeliver:
        return this.executePickupLoad(action, gameId, playerId, client);
      case AIActionType.BuildTrack:
        return this.executeBuildTrack(action, gameId, playerId, client);
      case AIActionType.UpgradeTrain:
        return this.executeUpgradeTrain(action, gameId, playerId, client);
      case AIActionType.BuildTowardMajorCity:
        return this.executeBuildTrack(action, gameId, playerId, client);
      case AIActionType.PassTurn:
        return null; // No-op
      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }

  /**
   * Execute a DeliverLoad action.
   *
   * Validates the delivery, updates money/loads/hand, manages demand deck,
   * and logs the turn action — all within the caller's transaction.
   */
  private static async executeDeliverLoad(
    action: TurnPlanAction,
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<DeckMutation | null> {
    const loadType = action.parameters.loadType as string;
    const cardId = action.parameters.demandCardId as number;
    const city = action.parameters.city as string;

    // Lock the player row for update
    const playerResult = await client.query(
      `SELECT money, debt_owed AS "debtOwed", hand, loads, current_turn_number AS "turnNumber"
       FROM players
       WHERE game_id = $1 AND id = $2
       FOR UPDATE`,
      [gameId, playerId],
    );
    if (playerResult.rows.length === 0) {
      throw new Error('Player not found');
    }

    const row = playerResult.rows[0];
    const currentMoney: number = row.money;
    const currentDebtOwed: number = Number(row.debtOwed ?? 0);
    const handIds: number[] = Array.isArray(row.hand)
      ? row.hand.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v))
      : [];
    const loads: string[] = Array.isArray(row.loads)
      ? (row.loads as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const turnNumber: number = Number(row.turnNumber ?? 1);

    // Validate card in hand
    if (!handIds.includes(cardId)) {
      throw new Error('Demand card not in hand');
    }

    // Validate load on train
    const loadIndex = loads.indexOf(loadType);
    if (loadIndex === -1) {
      throw new Error(`Load ${loadType} not on train`);
    }

    // Get the demand card and find matching demand
    const demandCard = demandDeckService.getCard(cardId);
    if (!demandCard) {
      throw new Error(`Invalid demand card ${cardId}`);
    }
    const matchingDemand = demandCard.demands.find(
      d => d.city === city && d.resource === loadType,
    );
    if (!matchingDemand) {
      throw new Error(`No matching demand for ${loadType} at ${city} on card ${cardId}`);
    }

    const payment = matchingDemand.payment;

    // Draw replacement card
    const newCard = demandDeckService.drawCard();
    if (!newCard) {
      throw new Error('Failed to draw replacement card');
    }

    // Update hand, removing old card and adding new
    const updatedHandIds = handIds.map(id => (id === cardId ? newCard.id : id));

    // Remove load from train
    const updatedLoads = [...loads];
    updatedLoads.splice(loadIndex, 1);

    // Compute debt repayment (Mercy Rule)
    const repayment = Math.min(payment, currentDebtOwed);
    const netPayment = payment - repayment;
    const updatedMoney = currentMoney + netPayment;
    const updatedDebtOwed = currentDebtOwed - repayment;

    // Persist changes
    await client.query(
      `UPDATE players
       SET money = $1, hand = $2, loads = $3, debt_owed = $4
       WHERE game_id = $5 AND id = $6`,
      [updatedMoney, updatedHandIds, updatedLoads, updatedDebtOwed, gameId, playerId],
    );

    // Discard the fulfilled card
    demandDeckService.discardCard(cardId);

    // Log turn action
    const deliverAction = {
      kind: 'deliver',
      city,
      loadType,
      cardIdUsed: cardId,
      newCardIdDrawn: newCard.id,
      payment,
      repayment,
    };
    await client.query(
      `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (player_id, game_id, turn_number)
       DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
      [playerId, gameId, turnNumber, JSON.stringify([deliverAction])],
    );

    // Emit action event for animation
    emitToGame(gameId, 'ai:action', {
      playerId,
      action: 'deliver',
      loadType,
      city,
      payment,
      timestamp: Date.now(),
    });

    return { drawnCardId: newCard.id, discardedCardId: cardId };
  }

  /**
   * Execute a PickupAndDeliver action (pickup portion).
   *
   * Adds the load to the player's train. The actual movement to the city
   * is handled separately by the movement system.
   */
  private static async executePickupLoad(
    action: TurnPlanAction,
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<null> {
    const loadType = action.parameters.loadType as string;
    const city = (action.parameters.city as string) || '';

    // Lock player row
    const playerResult = await client.query(
      `SELECT train_type AS "trainType", loads
       FROM players
       WHERE game_id = $1 AND id = $2
       FOR UPDATE`,
      [gameId, playerId],
    );
    if (playerResult.rows.length === 0) {
      throw new Error('Player not found');
    }

    const row = playerResult.rows[0];
    const trainType = row.trainType as string;
    const loads: string[] = Array.isArray(row.loads)
      ? (row.loads as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];

    // Validate capacity
    const capacity = TRAIN_PROPERTIES[trainType as keyof typeof TRAIN_PROPERTIES]?.capacity ?? 2;
    if (loads.length >= capacity) {
      throw new Error(`Train at capacity (${loads.length}/${capacity})`);
    }

    // Add load to train
    const updatedLoads = [...loads, loadType];
    await client.query(
      `UPDATE players SET loads = $1 WHERE game_id = $2 AND id = $3`,
      [updatedLoads, gameId, playerId],
    );

    // Emit action event for animation
    emitToGame(gameId, 'ai:action', {
      playerId,
      action: 'pickup',
      loadType,
      city,
      timestamp: Date.now(),
    });

    return null;
  }

  /**
   * Execute a BuildTrack or BuildTowardMajorCity action.
   *
   * Updates the player's track state with new segments. The plan should
   * contain the segments to build and their total cost.
   */
  private static async executeBuildTrack(
    action: TurnPlanAction,
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<null> {
    const segments = action.parameters.segments as Array<{ from: { row: number; col: number }; to: { row: number; col: number } }> | undefined;
    const cost = (action.parameters.estimatedCost as number) || 0;

    if (!segments || segments.length === 0) {
      // No segments to build — plan may have been a no-op or cost only
      return null;
    }

    // Lock player row for money update
    const playerResult = await client.query(
      `SELECT money FROM players WHERE game_id = $1 AND id = $2 FOR UPDATE`,
      [gameId, playerId],
    );
    if (playerResult.rows.length === 0) {
      throw new Error('Player not found');
    }
    const currentMoney: number = playerResult.rows[0].money;

    // Validate funds
    const actualCost = Math.min(cost, 20); // Cap at turn budget
    if (currentMoney < actualCost) {
      throw new Error(`Insufficient funds for track building: ${currentMoney}M < ${actualCost}M`);
    }

    // Get current track state
    const trackState = await TrackService.getTrackState(gameId, playerId);
    const currentSegments = trackState?.segments || [];
    const currentTotalCost = trackState?.totalCost || 0;
    const currentTurnBuildCost = trackState?.turnBuildCost || 0;

    const updatedSegments = [...currentSegments, ...segments];
    const updatedTotalCost = currentTotalCost + actualCost;
    const updatedTurnBuildCost = currentTurnBuildCost + actualCost;

    // Update track state
    await client.query(
      `INSERT INTO player_tracks (player_id, game_id, segments, total_cost, turn_build_cost, last_build_timestamp)
       VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
       ON CONFLICT (player_id, game_id)
       DO UPDATE SET
         segments = $3::jsonb,
         total_cost = $4,
         turn_build_cost = $5,
         last_build_timestamp = NOW()`,
      [playerId, gameId, JSON.stringify(updatedSegments), updatedTotalCost, updatedTurnBuildCost],
    );

    // Deduct money
    await client.query(
      `UPDATE players SET money = money - $1 WHERE game_id = $2 AND id = $3`,
      [actualCost, gameId, playerId],
    );

    // Emit action event for animation
    emitToGame(gameId, 'ai:action', {
      playerId,
      action: 'buildTrack',
      segmentCount: segments.length,
      cost: actualCost,
      timestamp: Date.now(),
    });

    return null;
  }

  /**
   * Execute an UpgradeTrain action.
   *
   * Validates the upgrade/crossgrade transition, deducts cost, and
   * updates the player's train type.
   */
  private static async executeUpgradeTrain(
    action: TurnPlanAction,
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<null> {
    const targetTrainType = action.parameters.targetTrainType as TrainType;
    const kind = action.parameters.kind as 'upgrade' | 'crossgrade';

    // Lock player row
    const playerResult = await client.query(
      `SELECT money, train_type AS "trainType", loads
       FROM players
       WHERE game_id = $1 AND id = $2
       FOR UPDATE`,
      [gameId, playerId],
    );
    if (playerResult.rows.length === 0) {
      throw new Error('Player not found');
    }

    const row = playerResult.rows[0];
    const currentMoney: number = row.money;
    const currentTrainType = row.trainType as string;
    const currentLoadCount = Array.isArray(row.loads) ? row.loads.length : 0;

    // Determine cost
    const cost = kind === 'upgrade' ? 20 : 5;

    // Validate funds
    if (currentMoney < cost) {
      throw new Error(`Insufficient funds for ${kind}: ${currentMoney}M < ${cost}M`);
    }

    // Validate target train type exists
    if (!TRAIN_PROPERTIES[targetTrainType]) {
      throw new Error(`Invalid train type: ${targetTrainType}`);
    }

    // Validate capacity won't drop loads
    const targetCapacity = TRAIN_PROPERTIES[targetTrainType].capacity;
    if (currentLoadCount > targetCapacity) {
      throw new Error(`Cannot ${kind}: carrying ${currentLoadCount} loads but target capacity is ${targetCapacity}`);
    }

    // Apply update
    await client.query(
      `UPDATE players
       SET train_type = $1, money = money - $2
       WHERE game_id = $3 AND id = $4`,
      [targetTrainType, cost, gameId, playerId],
    );

    // Emit action event for animation
    emitToGame(gameId, 'ai:action', {
      playerId,
      action: kind,
      targetTrainType,
      cost,
      timestamp: Date.now(),
    });

    return null;
  }

  /**
   * Compensate in-memory demand deck mutations when the DB transaction
   * rolls back. Returns drawn cards to the deck and restores discarded cards.
   */
  private static compensateDeckMutations(mutations: DeckMutation[]): void {
    // Undo in reverse order
    for (let i = mutations.length - 1; i >= 0; i--) {
      const { drawnCardId, discardedCardId } = mutations[i];
      try {
        demandDeckService.returnDealtCardToTop(drawnCardId);
      } catch {
        // Ignore — best effort
      }
      try {
        demandDeckService.returnDiscardedCardToDealt(discardedCardId);
      } catch {
        // Ignore — best effort
      }
    }
  }
}
