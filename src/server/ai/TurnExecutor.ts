/**
 * TurnExecutor — the final stage of the AI pipeline.
 *
 * Translates a validated TurnPlan into actual game state changes by
 * calling the same service methods used for human players.
 *
 * Each action is executed sequentially. If any action fails, execution
 * stops and the ExecutionResult reflects the failure for re-planning.
 * Individual service methods manage their own transactions.
 */

import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { TrackService } from '../services/trackService';
import { loadService } from '../services/loadService';
import { LoadType } from '../../shared/types/LoadTypes';
import { TrackSegment, Point } from '../../shared/types/GameTypes';
import {
  TurnPlan,
  ExecutionResult,
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  DeliverLoadParams,
  PickupAndDeliverParams,
  BuildTrackParams,
  UpgradeTrainParams,
  BuildTowardMajorCityParams,
} from './types';

export class TurnExecutor {
  /**
   * Execute a validated TurnPlan.
   *
   * @param plan - The validated TurnPlan from the Scorer/PlanValidator
   * @param snapshot - The WorldSnapshot used for planning (provides IDs and context)
   * @returns ExecutionResult indicating success/failure with timing info
   */
  static async execute(
    plan: TurnPlan,
    snapshot: WorldSnapshot,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let actionsExecuted = 0;

    try {
      for (const action of plan.actions) {
        await TurnExecutor.executeAction(action, snapshot);
        actionsExecuted++;
      }

      return {
        success: true,
        actionsExecuted,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[BOT:ERROR] TurnExecutor failed after ${actionsExecuted} actions: ${message}`,
      );
      return {
        success: false,
        actionsExecuted,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Dispatch a single action to the appropriate handler.
   */
  private static async executeAction(
    action: FeasibleOption,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    switch (action.params.type) {
      case AIActionType.PassTurn:
        return;
      case AIActionType.DeliverLoad:
        return TurnExecutor.executeDeliverLoad(action.params, snapshot);
      case AIActionType.PickupAndDeliver:
        return TurnExecutor.executePickupAndDeliver(action.params, snapshot);
      case AIActionType.BuildTrack:
        return TurnExecutor.executeBuildTrack(action.params, snapshot);
      case AIActionType.BuildTowardMajorCity:
        return TurnExecutor.executeBuildTowardMajorCity(action.params, snapshot);
      case AIActionType.UpgradeTrain:
        return TurnExecutor.executeUpgradeTrain(action.params, snapshot);
      default:
        throw new Error(`Unknown action type: ${(action.params as { type: string }).type}`);
    }
  }

  /**
   * Move the bot's train along a path, one milepost at a time.
   * path[0] is the current position and is skipped.
   */
  private static async moveAlongPath(
    path: Point[],
    snapshot: WorldSnapshot,
  ): Promise<void> {
    for (let i = 1; i < path.length; i++) {
      await PlayerService.moveTrainForUser({
        gameId: snapshot.gameId,
        userId: snapshot.botUserId,
        to: { row: path[i].row, col: path[i].col },
        movementCost: 1,
      });
    }
  }

  /**
   * DeliverLoad: Move to delivery city, then deliver the carried load.
   */
  private static async executeDeliverLoad(
    params: DeliverLoadParams,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    // Move to delivery city
    if (params.movePath.length > 1) {
      await TurnExecutor.moveAlongPath(params.movePath, snapshot);
    }

    // Deliver the load via shared PlayerService method
    await PlayerService.deliverLoadForUser(
      snapshot.gameId,
      snapshot.botUserId,
      params.city,
      params.loadType,
      params.demandCardId,
    );

    // Return the load chip to the tray (matches human player flow)
    try {
      await loadService.returnLoad(params.city, params.loadType, snapshot.gameId);
    } catch {
      // Best-effort: load tracking is secondary to the delivery itself
    }
  }

  /**
   * PickupAndDeliver: Move to pickup city, pick up load, then optionally
   * continue to delivery city and deliver within the same turn.
   */
  private static async executePickupAndDeliver(
    params: PickupAndDeliverParams,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    // Move to pickup city
    if (params.pickupPath.length > 1) {
      await TurnExecutor.moveAlongPath(params.pickupPath, snapshot);
    }

    // Pick up the load
    await TurnExecutor.pickupLoad(
      snapshot.gameId,
      snapshot.botUserId,
      params.pickupLoadType,
      params.pickupCity,
      snapshot,
    );

    // If a delivery path exists, continue to deliver in the same turn
    if (params.deliverPath.length > 1) {
      await TurnExecutor.moveAlongPath(params.deliverPath, snapshot);

      await PlayerService.deliverLoadForUser(
        snapshot.gameId,
        snapshot.botUserId,
        params.deliverCity,
        params.pickupLoadType,
        params.demandCardId,
      );

      // Return the load chip to the tray
      try {
        await loadService.returnLoad(params.deliverCity, params.pickupLoadType, snapshot.gameId);
      } catch {
        // Best-effort
      }
    }
  }

  /**
   * Add a load to the bot's carried loads.
   * This is a bot-specific operation since there is no server-authoritative
   * pickupLoadForUser method (human clients update loads via player update).
   */
  private static async pickupLoad(
    gameId: string,
    botUserId: string,
    loadType: LoadType,
    city: string,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, loads FROM players
         WHERE game_id = $1 AND user_id = $2
         LIMIT 1 FOR UPDATE`,
        [gameId, botUserId],
      );
      if (result.rows.length === 0) {
        throw new Error('Bot player not found');
      }

      const playerId = result.rows[0].id;
      const currentLoads: string[] = result.rows[0].loads || [];
      const updatedLoads = [...currentLoads, loadType];

      await client.query(
        `UPDATE players SET loads = $1 WHERE game_id = $2 AND id = $3`,
        [updatedLoads, gameId, playerId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // If the load was a dropped load at this city, update tracking
    const droppedLoads = snapshot.droppedLoads.get(city);
    if (droppedLoads && droppedLoads.includes(loadType)) {
      await loadService.pickupDroppedLoad(city, loadType, gameId);
    }
  }

  /**
   * BuildTrack: Append track segments and deduct build cost.
   */
  private static async executeBuildTrack(
    params: BuildTrackParams,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    if (params.segments.length === 0) return;
    await TurnExecutor.buildSegments(params.segments, params.totalCost, snapshot);
  }

  /**
   * BuildTowardMajorCity: Same mechanics as BuildTrack.
   */
  private static async executeBuildTowardMajorCity(
    params: BuildTowardMajorCityParams,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    if (params.segments.length === 0) return;
    await TurnExecutor.buildSegments(params.segments, params.totalCost, snapshot);
  }

  /**
   * Append track segments, update build costs, and deduct money atomically.
   * Uses a single transaction to keep track state and money in sync.
   */
  private static async buildSegments(
    segments: TrackSegment[],
    totalCost: number,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    // Read existing track state
    const existingTrack = await TrackService.getTrackState(
      snapshot.gameId,
      snapshot.botPlayerId,
    );
    const existingSegments = existingTrack?.segments || [];
    const existingTotalCost = existingTrack?.totalCost || 0;
    const existingTurnBuildCost = existingTrack?.turnBuildCost || 0;

    const newSegments = [...existingSegments, ...segments];
    const newTotalCost = existingTotalCost + totalCost;
    const newTurnBuildCost = existingTurnBuildCost + totalCost;

    // Perform track update + money deduction in a single transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Upsert track state
      await client.query(
        `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (game_id, player_id)
         DO UPDATE SET segments = $3, total_cost = $4, turn_build_cost = $5, last_build_timestamp = NOW()`,
        [snapshot.gameId, snapshot.botPlayerId, JSON.stringify(newSegments), newTotalCost, newTurnBuildCost],
      );

      // Deduct money from bot
      await client.query(
        `UPDATE players SET money = money - $1 WHERE game_id = $2 AND user_id = $3`,
        [totalCost, snapshot.gameId, snapshot.botUserId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * UpgradeTrain: Upgrade or crossgrade via shared PlayerService method.
   */
  private static async executeUpgradeTrain(
    params: UpgradeTrainParams,
    snapshot: WorldSnapshot,
  ): Promise<void> {
    await PlayerService.purchaseTrainType(
      snapshot.gameId,
      snapshot.botUserId,
      params.kind,
      params.targetTrainType,
    );
  }
}
