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
  TrainType,
  TurnPlan,
} from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import { emitToGame, emitStatePatch } from '../socketService';
import { PlayerService } from '../playerService';
import { LoadService } from '../loadService';
import { DemandDeckService } from '../demandDeckService';
import { gridToPixel, loadGridPoints } from './MapTopology';
import { getTrainCapacity, getTrainSpeed } from '../../../shared/services/trainProperties';
import { getCityNameAtPosition } from '../../../shared/services/cityPositionResolver';

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
  movementPath?: { row: number; col: number }[];
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
      case AIActionType.DropLoad:
        return TurnExecutor.handleDropLoad(plan, snapshot, startTime);
      case AIActionType.UpgradeTrain:
        return TurnExecutor.handleUpgradeTrain(plan, snapshot, startTime);
      case AIActionType.DiscardHand:
        return TurnExecutor.handleDiscardHand(snapshot, startTime);
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
   * Execute a TurnPlan (v6.3 pipeline).
   *
   * Converts the discriminated-union TurnPlan into a FeasibleOption and delegates
   * to the existing execute() method. For MultiAction plans, executes each step
   * sequentially and returns the aggregate result.
   */
  static async executePlan(
    plan: TurnPlan,
    snapshot: WorldSnapshot,
  ): Promise<ExecutionResult> {
    if (plan.type === 'MultiAction') {
      return TurnExecutor.executeMultiAction(plan.steps, snapshot);
    }

    const option = TurnExecutor.planToOption(plan);
    return TurnExecutor.execute(option, snapshot);
  }

  /**
   * Convert a TurnPlan discriminated union into a FeasibleOption for the existing handlers.
   */
  private static planToOption(plan: TurnPlan): FeasibleOption {
    switch (plan.type) {
      case AIActionType.BuildTrack:
        return {
          action: AIActionType.BuildTrack,
          feasible: true,
          reason: 'v6.3 plan',
          segments: plan.segments,
          estimatedCost: plan.segments.reduce((s, seg) => s + seg.cost, 0),
        };
      case AIActionType.MoveTrain:
        return {
          action: AIActionType.MoveTrain,
          feasible: true,
          reason: 'v6.3 plan',
          movementPath: plan.path,
          mileposts: plan.path.length > 0 ? plan.path.length - 1 : 0,
        };
      case AIActionType.DeliverLoad:
        return {
          action: AIActionType.DeliverLoad,
          feasible: true,
          reason: 'v6.3 plan',
          loadType: plan.load as LoadType,
          targetCity: plan.city,
          cardId: plan.cardId,
          payment: plan.payout,
        };
      case AIActionType.PickupLoad:
        return {
          action: AIActionType.PickupLoad,
          feasible: true,
          reason: 'v6.3 plan',
          loadType: plan.load as LoadType,
          targetCity: plan.city,
        };
      case AIActionType.DropLoad:
        return {
          action: AIActionType.DropLoad,
          feasible: true,
          reason: 'v6.3 plan',
          loadType: plan.load as LoadType,
          targetCity: plan.city,
        };
      case AIActionType.UpgradeTrain: {
        // Determine upgrade kind based on cost
        const upgradeKind = plan.cost === 5 ? 'crossgrade' : 'upgrade';
        return {
          action: AIActionType.UpgradeTrain,
          feasible: true,
          reason: 'v6.3 plan',
          targetTrainType: plan.targetTrain as TrainType,
          upgradeKind,
          estimatedCost: plan.cost,
        };
      }
      case AIActionType.DiscardHand:
        return {
          action: AIActionType.DiscardHand,
          feasible: true,
          reason: 'v6.3 plan',
        };
      case AIActionType.PassTurn:
        return {
          action: AIActionType.PassTurn,
          feasible: true,
          reason: 'v6.3 plan',
        };
      default:
        return {
          action: AIActionType.PassTurn,
          feasible: true,
          reason: 'v6.3 plan (unknown type)',
        };
    }
  }

  /**
   * Execute a MultiAction plan: run each step sequentially.
   * Returns aggregate cost/segments. Stops on first failure.
   * Updates snapshot state between steps so subsequent steps see correct position/loads.
   */
  private static async executeMultiAction(
    steps: TurnPlan[],
    snapshot: WorldSnapshot,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let totalCost = 0;
    let totalSegments = 0;
    let lastAction = AIActionType.PassTurn;
    let lastResult: ExecutionResult | null = null;
    const concatenatedPath: { row: number; col: number }[] = [];

    for (const step of steps) {
      // JIRA-83: Skip DELIVER/DROP steps when bot is not at a named city.
      // Earlier steps (MOVE) already committed to DB, so failing the entire turn
      // would misrepresent what happened. Warn and continue instead.
      if (step.type === AIActionType.DeliverLoad || step.type === AIActionType.DropLoad) {
        const grid = loadGridPoints();
        const posKey = snapshot.bot.position
          ? `${snapshot.bot.position.row},${snapshot.bot.position.col}`
          : '';
        const currentPoint = posKey ? grid.get(posKey) : undefined;
        if (!currentPoint?.name) {
          console.warn(`[TurnExecutor] JIRA-83: Skipping ${step.type} — bot not at named city (pos=${posKey})`);
          continue;
        }
      }

      const option = TurnExecutor.planToOption(step);

      let result: ExecutionResult;
      try {
        result = await TurnExecutor.execute(option, snapshot);
      } catch (stepError) {
        // Catch thrown errors from individual steps (e.g., PlayerService.deliverLoadForUser
        // throwing "Demand does not match delivery"). Return a failure result instead of
        // letting the error propagate — earlier steps' DB changes are already committed.
        console.error(`[TurnExecutor] MultiAction step ${step.type} threw:`, stepError instanceof Error ? stepError.message : stepError);
        return {
          success: false,
          action: step.type as AIActionType,
          cost: totalCost,
          segmentsBuilt: totalSegments,
          remainingMoney: snapshot.bot.money,
          durationMs: Date.now() - startTime,
          error: stepError instanceof Error ? stepError.message : String(stepError),
        };
      }

      if (!result.success) {
        return {
          ...result,
          cost: totalCost + result.cost,
          segmentsBuilt: totalSegments + result.segmentsBuilt,
          durationMs: Date.now() - startTime,
        };
      }

      totalCost += result.cost;
      totalSegments += result.segmentsBuilt;
      lastAction = result.action;
      snapshot.bot.money = result.remainingMoney;
      lastResult = result;

      // Collect movement path for animation (deduplicate shared endpoints)
      if (result.movementPath && result.movementPath.length > 0) {
        const last = concatenatedPath[concatenatedPath.length - 1];
        const first = result.movementPath[0];
        const startIndex = (last && last.row === first.row && last.col === first.col) ? 1 : 0;
        concatenatedPath.push(...result.movementPath.slice(startIndex));
      }

      // Update snapshot state so subsequent steps see correct position/loads
      if (step.type === AIActionType.MoveTrain && step.path.length > 0) {
        const dest = step.path[step.path.length - 1];
        snapshot.bot.position = { row: dest.row, col: dest.col };
      }
      if (step.type === AIActionType.PickupLoad) {
        snapshot.bot.loads = [...snapshot.bot.loads, step.load];
      }
      if (step.type === AIActionType.DeliverLoad) {
        snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== step.load);
      }
    }

    return {
      success: true,
      action: lastAction,
      cost: totalCost,
      segmentsBuilt: totalSegments,
      remainingMoney: snapshot.bot.money,
      durationMs: Date.now() - startTime,
      payment: lastResult?.payment,
      newCardId: lastResult?.newCardId,
      movementPath: concatenatedPath.length > 0 ? concatenatedPath : undefined,
    };
  }

  /**
   * BuildTrack: delegate to PlayerService.buildTrackForPlayer which handles
   * UPSERT player_tracks and UPDATE money in a transaction.
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handleBuildTrack(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const newSegments = plan.segments ?? [];
    const cost = plan.estimatedCost ?? newSegments.reduce((s, seg) => s + seg.cost, 0);

    // Delegate to PlayerService — handles UPSERT + money deduction in a transaction
    const { remainingMoney } = await PlayerService.buildTrackForPlayer(
      snapshot.gameId,
      snapshot.bot.playerId,
      newSegments,
      snapshot.bot.existingSegments,
      cost,
    );

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
      movementPath: movePath,
    };
  }

  /**
   * PickupLoad: delegate to PlayerService.pickupLoadForPlayer which handles
   * capacity validation, array_append, and dropped-load clearing in a transaction.
   * Audit INSERT, turn_actions INSERT, and socket emit are best-effort post-commit.
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
    const cityName = snapshot.bot.position
      ? getCityNameAtPosition(snapshot.bot.position.row, snapshot.bot.position.col, loadGridPoints()) ?? ''
      : '';

    // Delegate to PlayerService — handles capacity check, array_append, dropped-load clear
    const { updatedLoads } = await PlayerService.pickupLoadForPlayer(
      snapshot.gameId,
      snapshot.bot.playerId,
      loadType as LoadType,
      cityName,
    );

    // Update snapshot so subsequent steps see the correct loads
    snapshot.bot.loads = updatedLoads;

    // Post-commit: audit record (best-effort)
    try {
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.gameId, snapshot.bot.playerId, snapshot.turnNumber, AIActionType.PickupLoad, 0, snapshot.bot.money, Date.now() - startTime],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] PickupLoad audit insert failed (load was picked up):', auditError instanceof Error ? auditError.message : auditError);
    }

    // Post-commit: record in turn_actions for traceability (best-effort)
    try {
      const pickupAction = { kind: 'pickup', city: cityName, loadType };
      await db.query(
        `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (player_id, game_id, turn_number)
         DO UPDATE SET actions = turn_actions.actions || $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
        [snapshot.bot.playerId, snapshot.gameId, snapshot.turnNumber, JSON.stringify([pickupAction])],
      );
    } catch (turnActionError) {
      console.error('[TurnExecutor] PickupLoad turn_actions insert failed (load was picked up):', turnActionError instanceof Error ? turnActionError.message : turnActionError);
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
    const cityName = snapshot.bot.position
      ? getCityNameAtPosition(snapshot.bot.position.row, snapshot.bot.position.col, loadGridPoints()) ?? ''
      : '';

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

    // Post-delivery: emit refreshed demand ranking for debug overlay (FE-001, JIRA-78)
    // Use fresh player data from DB (same source as emitStatePatch) to stay in sync with Cards tab
    try {
      const freshPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const freshBot = freshPlayers.find((p: any) => p.id === snapshot.bot.playerId);
      const freshHand: number[] = freshBot?.hand?.map((c: any) => c.id) ?? [];
      const demandDeck = DemandDeckService.getInstance();
      const loadSvc = LoadService.getInstance();
      const ranking: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number }> = [];
      for (const cid of freshHand) {
        const card = demandDeck.getCard(cid);
        if (!card) continue;
        for (const d of card.demands) {
          const sourceCities = loadSvc.getSourceCitiesForLoad(d.resource);
          ranking.push({
            loadType: d.resource,
            supplyCity: sourceCities[0] ?? '?',
            deliveryCity: d.city,
            payout: d.payment,
            score: d.payment, // simplified score (full re-score on next turn)
            rank: 0,
          });
        }
      }
      ranking.sort((a, b) => b.score - a.score);
      ranking.forEach((r, i) => { r.rank = i + 1; });
      emitToGame(snapshot.gameId, 'bot:demandRankingUpdate', {
        botPlayerId: snapshot.bot.playerId,
        demandRanking: ranking,
      });
    } catch (rankErr) {
      console.error('[TurnExecutor] DeliverLoad demand ranking emit failed:', rankErr instanceof Error ? rankErr.message : rankErr);
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
   * DropLoad: delegate to PlayerService.dropLoadForPlayer which handles
   * array_remove and city placement (LoadService) in a transaction.
   * Per game rules: "Any load may be dropped at any city without a payoff."
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handleDropLoad(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const loadType = plan.loadType;
    if (!loadType) {
      return {
        success: false,
        action: AIActionType.DropLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'No loadType specified',
      };
    }

    // Resolve city name
    const cityName = snapshot.bot.position
      ? getCityNameAtPosition(snapshot.bot.position.row, snapshot.bot.position.col, loadGridPoints()) ?? ''
      : '';

    console.warn(`[TurnExecutor] DropLoad: dropping "${loadType}" at "${cityName || 'unknown'}" (turn ${snapshot.turnNumber})`);

    if (!cityName) {
      return {
        success: false,
        action: AIActionType.DropLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'Bot is not at a named city',
      };
    }

    // Delegate to PlayerService — handles array_remove and city placement
    await PlayerService.dropLoadForPlayer(
      snapshot.gameId,
      snapshot.bot.playerId,
      loadType as LoadType,
      cityName,
    );

    // Update snapshot so subsequent steps see the correct loads
    snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== loadType);

    // Post-commit: audit record (best-effort)
    try {
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.gameId, snapshot.bot.playerId, snapshot.turnNumber, AIActionType.DropLoad, 0, snapshot.bot.money, Date.now() - startTime],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] DropLoad audit insert failed:', auditError instanceof Error ? auditError.message : auditError);
    }

    // Post-commit: socket emit (best-effort)
    try {
      const publicPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const botPlayer = publicPlayers.find((p: any) => p.id === snapshot.bot.playerId);
      if (botPlayer) {
        await emitStatePatch(snapshot.gameId, { players: [botPlayer] } as any);
      }
    } catch (emitError) {
      console.error('[TurnExecutor] DropLoad post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    return {
      success: true,
      action: AIActionType.DropLoad,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: snapshot.bot.money,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * UpgradeTrain: delegate to PlayerService.purchaseTrainType which handles
   * validation, cost deduction, and DB update in a transaction.
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handleUpgradeTrain(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const targetType = plan.targetTrainType;
    const kind = plan.upgradeKind;
    if (!targetType || !kind) {
      return {
        success: false,
        action: AIActionType.UpgradeTrain,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: snapshot.bot.money,
        durationMs: Date.now() - startTime,
        error: 'UpgradeTrain requires targetTrainType and upgradeKind',
      };
    }

    // Delegate to PlayerService — handles validation, cost calculation, and DB update
    const updatedPlayer = await PlayerService.purchaseTrainType(
      snapshot.gameId,
      snapshot.bot.userId,
      kind,
      targetType,
    );

    const cost = kind === 'upgrade' ? 20 : 5;
    const remainingMoney = updatedPlayer.money;

    // Update snapshot so subsequent steps see the correct train type
    snapshot.bot.trainType = targetType;

    // Audit (best-effort)
    try {
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.gameId, snapshot.bot.playerId, snapshot.turnNumber, AIActionType.UpgradeTrain, cost, remainingMoney, Date.now() - startTime],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] UpgradeTrain audit insert failed:', auditError instanceof Error ? auditError.message : auditError);
    }

    // Socket emit (best-effort)
    try {
      await emitStatePatch(snapshot.gameId, { players: [updatedPlayer] } as any);
    } catch (emitError) {
      console.error('[TurnExecutor] UpgradeTrain post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    return {
      success: true,
      action: AIActionType.UpgradeTrain,
      cost,
      segmentsBuilt: 0,
      remainingMoney,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * DiscardHand: delegate to PlayerService.discardHandForPlayer which handles
   * deck discard/draw and DB update in a transaction.
   * Audit INSERT and socket emit are best-effort post-commit.
   */
  private static async handleDiscardHand(
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    console.warn(`[TurnExecutor] DiscardHand: discarding ${snapshot.bot.demandCards.length} demand cards (turn ${snapshot.turnNumber})`);

    // Delegate to PlayerService — handles discard, draw, and DB update
    const { newHandIds } = await PlayerService.discardHandForPlayer(
      snapshot.gameId,
      snapshot.bot.playerId,
    );

    // Update snapshot so subsequent steps see the correct hand
    snapshot.bot.demandCards = newHandIds;

    // Audit (best-effort)
    try {
      await db.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.gameId, snapshot.bot.playerId, snapshot.turnNumber, AIActionType.DiscardHand, 0, snapshot.bot.money, Date.now() - startTime],
      );
    } catch (auditError) {
      console.error('[TurnExecutor] DiscardHand audit insert failed:', auditError instanceof Error ? auditError.message : auditError);
    }

    // Socket emit (best-effort)
    try {
      const publicPlayers = await PlayerService.getPlayers(snapshot.gameId, '');
      const botPlayer = publicPlayers.find((p: any) => p.id === snapshot.bot.playerId);
      if (botPlayer) {
        await emitStatePatch(snapshot.gameId, { players: [botPlayer] } as any);
      }
    } catch (emitError) {
      console.error('[TurnExecutor] DiscardHand post-commit emit failed:', emitError instanceof Error ? emitError.message : emitError);
    }

    return {
      success: true,
      action: AIActionType.DiscardHand,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: snapshot.bot.money,
      durationMs: Date.now() - startTime,
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
