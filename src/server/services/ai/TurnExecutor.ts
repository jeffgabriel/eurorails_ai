/**
 * TurnExecutor — Executes a validated AI bot plan against the database.
 *
 * Handles BuildTrack, MoveTrain (via PlayerService), and PassTurn.
 * Critical DB ops happen in transactions; audit INSERTs are best-effort post-commit.
 */

import { db } from '../../db/index';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
} from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import { emitToGame, emitStatePatch } from '../socketService';
import { PlayerService } from '../playerService';
import { LoadService } from '../loadService';
import { gridToPixel, loadGridPoints } from './MapTopology';

export interface ExecutionResult {
  success: boolean;
  action: AIActionType;
  cost: number;
  segmentsBuilt: number;
  remainingMoney: number;
  durationMs: number;
  error?: string;
  payment?: number;
  newCardId?: number;
}

export class TurnExecutor {
  /**
   * Execute the chosen plan for the bot's turn.
   * Runs all DB mutations in a transaction; emits socket events after commit.
   */
  static async execute(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    switch (plan.action) {
      case AIActionType.BuildTrack:
        return TurnExecutor.handleBuildTrack(plan, snapshot, startTime);
      case AIActionType.MoveTrain:
        return TurnExecutor.handleMoveTrain(plan, snapshot, startTime);
      case AIActionType.PickupLoad:
        return TurnExecutor.handlePickupLoad(plan, snapshot, startTime);
      case AIActionType.DeliverLoad:
        return TurnExecutor.handleDeliverLoad(plan, snapshot, startTime);
      case AIActionType.PassTurn:
        return TurnExecutor.handlePassTurn(snapshot, startTime);
      default:
        return {
          success: true,
          action: plan.action,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: snapshot.bot.money,
          durationMs: Date.now() - startTime,
        };
    }
  }

  /**
   * BuildTrack: save track, deduct money, insert audit — all in one transaction.
   * Emit socket events only after successful commit.
   */
  private static async handleBuildTrack(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const newSegments = plan.segments ?? [];
    const cost = plan.estimatedCost ?? newSegments.reduce((s, seg) => s + seg.cost, 0);
    const allSegments = [...snapshot.bot.existingSegments, ...newSegments];
    const totalCost = allSegments.reduce((s, seg) => s + seg.cost, 0);

    const client = await db.connect();
    let remainingMoney = snapshot.bot.money - cost;

    try {
      await client.query('BEGIN');

      // 1. Save track state (UPSERT directly — avoids TrackService's separate transaction)
      await client.query(
        `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (game_id, player_id)
         DO UPDATE SET segments = $3, total_cost = $4, turn_build_cost = $5, last_build_timestamp = NOW()`,
        [snapshot.gameId, snapshot.bot.playerId, JSON.stringify(allSegments), totalCost, cost],
      );

      // 2. Deduct money from bot player
      const moneyResult = await client.query(
        'UPDATE players SET money = money - $1 WHERE id = $2 RETURNING money',
        [cost, snapshot.bot.playerId],
      );
      remainingMoney = moneyResult.rows[0]?.money ?? remainingMoney;

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // 3. Post-commit: audit record (best-effort — don't let a missing table
    //    undo a successful track build)
    try {
      const auditDurationMs = Date.now() - startTime;
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, segments_built, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.BuildTrack,
          JSON.stringify(newSegments),
          cost,
          remainingMoney,
          auditDurationMs,
        ],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] BuildTrack audit insert failed (track was saved):', auditError instanceof Error ? auditError.message : auditError);
    }

    // 4. Emit socket events AFTER successful commit (best-effort — don't let
    //    socket errors undo a successful DB write)
    try {
      emitToGame(snapshot.gameId, 'track:updated', {
        gameId: snapshot.gameId,
        playerId: snapshot.bot.playerId,
        timestamp: Date.now(),
      });

      await emitStatePatch(snapshot.gameId, {
        players: [{ id: snapshot.bot.playerId, money: remainingMoney } as any],
      });
    } catch (emitError) {
      console.error('[TurnExecutor] Post-commit emit failed (track was saved):', emitError instanceof Error ? emitError.message : emitError);
    }

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      action: AIActionType.BuildTrack,
      cost,
      segmentsBuilt: newSegments.length,
      remainingMoney,
      durationMs,
    };
  }

  /**
   * MoveTrain: move the bot to the final position in the movement path.
   * Delegates to PlayerService.moveTrainForUser which handles track usage fees.
   * Audit INSERT is best-effort post-commit.
   */
  private static async handleMoveTrain(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const movePath = plan.movementPath ?? [];
    if (movePath.length === 0) {
      return {
        success: false,
        action: AIActionType.MoveTrain,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'Empty movement path',
      };
    }

    // Get final destination from the movement path
    const destination = movePath[movePath.length - 1];
    const pixel = gridToPixel(destination.row, destination.col);

    // Call PlayerService.moveTrainForUser (handles track usage fees in its own transaction)
    const moveResult = await PlayerService.moveTrainForUser({
      gameId: snapshot.gameId,
      userId: snapshot.bot.userId,
      to: { row: destination.row, col: destination.col, x: pixel.x, y: pixel.y },
    });

    const cost = moveResult.feeTotal;
    const remainingMoney = moveResult.updatedMoney;

    // Post-commit: audit record (best-effort)
    try {
      const auditDurationMs = Date.now() - startTime;
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.MoveTrain,
          cost,
          remainingMoney,
          auditDurationMs,
        ],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] MoveTrain audit insert failed (move was executed):', auditError instanceof Error ? auditError.message : auditError);
    }

    // Emit socket events with full player data (matches human movement route pattern)
    try {
      const publicPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const patchedPlayers = publicPlayers
        .filter((p: any) => moveResult.affectedPlayerIds.includes(p.id));
      if (patchedPlayers.length > 0) {
        await emitStatePatch(snapshot.gameId, { players: patchedPlayers } as any);
      }
    } catch (emitError) {
      console.error('[TurnExecutor] MoveTrain post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      action: AIActionType.MoveTrain,
      cost,
      segmentsBuilt: 0,
      remainingMoney,
      durationMs,
    };
  }

  /**
   * PickupLoad: append load to player's loads array.
   * If it's a dropped load, also clear it from load_chips via LoadService.
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handlePickupLoad(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const loadType = plan.loadType;
    if (!loadType) {
      return {
        success: false,
        action: AIActionType.PickupLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'No loadType specified',
      };
    }

    // Resolve city name for dropped load check
    const grid = loadGridPoints();
    const posKey = snapshot.bot.position
      ? `${snapshot.bot.position.row},${snapshot.bot.position.col}`
      : '';
    const currentPoint = posKey ? grid.get(posKey) : undefined;
    const cityName = currentPoint?.name ?? '';

    // Critical DB op: append load to player's loads array
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE players SET loads = array_append(loads, $1) WHERE id = $2',
        [loadType, snapshot.bot.playerId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // If this is a dropped load at the city, clear it (best-effort — separate from critical tx)
    if (cityName) {
      try {
        const loadSvc = LoadService.getInstance();
        await loadSvc.pickupDroppedLoad(cityName, loadType as LoadType, snapshot.gameId);
      } catch (droppedErr) {
        console.error('[TurnExecutor] PickupLoad dropped-load clear failed (load was picked up):', droppedErr instanceof Error ? droppedErr.message : droppedErr);
      }
    }

    // Post-commit: audit record (best-effort)
    try {
      const auditDurationMs = Date.now() - startTime;
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.PickupLoad,
          0,
          snapshot.bot.money,
          auditDurationMs,
        ],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] PickupLoad audit insert failed (load was picked up):', auditError instanceof Error ? auditError.message : auditError);
    }

    // Post-commit: socket emit (best-effort)
    try {
      const publicPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const botPlayer = publicPlayers.find((p: any) => p.id === snapshot.bot.playerId);
      if (botPlayer) {
        await emitStatePatch(snapshot.gameId, { players: [botPlayer] } as any);
      }
    } catch (emitError) {
      console.error('[TurnExecutor] PickupLoad post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    return {
      success: true,
      action: AIActionType.PickupLoad,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: snapshot.bot.money,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * DeliverLoad: delegate to PlayerService.deliverLoadForUser which handles
   * validation, payment, debt repayment, card replacement, and DB update.
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handleDeliverLoad(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const loadType = plan.loadType;
    const cardId = plan.cardId;

    if (!loadType || cardId == null) {
      return {
        success: false,
        action: AIActionType.DeliverLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'DeliverLoad requires loadType and cardId',
      };
    }

    // Resolve city name from bot position
    const grid = loadGridPoints();
    const posKey = snapshot.bot.position
      ? `${snapshot.bot.position.row},${snapshot.bot.position.col}`
      : '';
    const currentPoint = posKey ? grid.get(posKey) : undefined;
    const cityName = currentPoint?.name ?? '';

    if (!cityName) {
      return {
        success: false,
        action: AIActionType.DeliverLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'Bot is not at a named city',
      };
    }

    // Delegate to PlayerService — handles validation, payment, debt, card draw, DB update
    const deliverResult = await PlayerService.deliverLoadForUser(
      snapshot.gameId,
      snapshot.bot.userId,
      cityName,
      loadType as LoadType,
      cardId,
    );

    const payment = deliverResult.payment;
    const newCardId = deliverResult.newCard.id;
    const remainingMoney = deliverResult.updatedMoney;

    // Post-commit: audit record (best-effort)
    try {
      const auditDurationMs = Date.now() - startTime;
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.DeliverLoad,
          0,
          remainingMoney,
          auditDurationMs,
        ],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] DeliverLoad audit insert failed (delivery was executed):', auditError instanceof Error ? auditError.message : auditError);
    }

    // Post-commit: socket emit (best-effort)
    try {
      const publicPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const botPlayer = publicPlayers.find((p: any) => p.id === snapshot.bot.playerId);
      if (botPlayer) {
        await emitStatePatch(snapshot.gameId, { players: [botPlayer] } as any);
      }
    } catch (emitError) {
      console.error('[TurnExecutor] DeliverLoad post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    return {
      success: true,
      action: AIActionType.DeliverLoad,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney,
      durationMs: Date.now() - startTime,
      payment,
      newCardId,
    };
  }

  /**
   * PassTurn: insert audit record only, no track or money changes.
   */
  private static async handlePassTurn(
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const durationMs = Date.now() - startTime;

    // Audit insert is best-effort — don't let a missing table crash the turn
    try {
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.PassTurn,
          0,
          snapshot.bot.money,
          durationMs,
        ],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] PassTurn audit insert failed:', auditError instanceof Error ? auditError.message : auditError);
    }

    return {
      success: true,
      action: AIActionType.PassTurn,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: snapshot.bot.money,
      durationMs,
    };
  }
}
