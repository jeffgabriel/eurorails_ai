/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services:
 *   WorldSnapshotService → OptionGenerator → Scorer → PlanValidator → TurnExecutor
 *
 * Turn phases:
 *   Phase 0: Immediate delivery/pickup at current position (before movement)
 *   Phase 1: Movement toward a demand city
 *   Phase 1.5: Post-movement delivery/pickup at new position
 *   Phase 2: Building track
 *
 * Includes 3 retries with PassTurn fallback on failure.
 */

import { capture } from './WorldSnapshotService';
import { OptionGenerator } from './OptionGenerator';
import { Scorer } from './Scorer';
import { validate } from './PlanValidator';
import { TurnExecutor } from './TurnExecutor';
import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotConfig,
} from '../../../shared/types/GameTypes';
import { db } from '../../db/index';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { gridToPixel, loadGridPoints } from './MapTopology';
import { getMemory, updateMemory } from './BotMemory';
import { initTurnLog, logPhase, flushTurnLog } from './DecisionLogger';

const MAX_RETRIES = 3;

export interface BotTurnResult {
  action: AIActionType;
  segmentsBuilt: number;
  cost: number;
  durationMs: number;
  success: boolean;
  error?: string;
  movedTo?: { row: number; col: number };
  milepostsMoved?: number;
  trackUsageFee?: number;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  buildTargetCity?: string;
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn with multi-action sequencing:
   *   Phase 0: immediate deliver/pickup at current position
   *   Phase 1: movement
   *   Phase 1.5: post-movement deliver/pickup at new position
   *   Phase 2: building
   * Falls back to PassTurn after MAX_RETRIES failures.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();
    const tag = `[AIStrategy ${gameId.slice(0, 8)}]`;

    // Accumulators for load actions across all phases
    const loadsPickedUp: Array<{ loadType: string; city: string }> = [];
    const loadsDelivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];

    // Load bot memory for state continuity across turns
    const memory = getMemory(gameId, botPlayerId);

    // Initialize decision logging for this turn
    initTurnLog(gameId, botPlayerId, memory.turnNumber + 1);

    try {
      // 1. Capture world snapshot
      let snapshot = await capture(gameId, botPlayerId);
      console.log(`${tag} Snapshot: status=${snapshot.gameStatus}, money=${snapshot.bot.money}, segments=${snapshot.bot.existingSegments.length}, position=${snapshot.bot.position ? `${snapshot.bot.position.row},${snapshot.bot.position.col}` : 'none'}, loads=[${snapshot.bot.loads.join(',')}]`);

      // 2. Auto-place bot if no position and has track
      if (!snapshot.bot.position && snapshot.bot.existingSegments.length > 0) {
        await AIStrategyEngine.autoPlaceBot(snapshot);
        const placed = snapshot.bot.position as { row: number; col: number } | null;
        console.log(`${tag} Auto-placed bot at ${placed ? `${placed.row},${placed.col}` : 'failed'}`);
      }

      const botConfig = snapshot.bot.botConfig as BotConfig | null;

      // ── Ferry crossing: if bot is at a ferry port, cross if beneficial ──
      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        const ferryCrossed = await AIStrategyEngine.handleFerryCrossing(snapshot, tag);
        if (ferryCrossed) {
          snapshot = await capture(gameId, botPlayerId);
          snapshot.bot.ferryHalfSpeed = true;
          console.log(`${tag} Ferry crossed — now at ${snapshot.bot.position?.row},${snapshot.bot.position?.col}, half speed this turn`);
        }
      }

      // ── Phase 0: Immediate delivery/pickup/drop at current position ──
      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        const phase0Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 0',
        );
        loadsDelivered.push(...phase0Result.delivered);
        loadsPickedUp.push(...phase0Result.pickedUp);

        // Re-capture snapshot if any state-mutating actions occurred
        if (phase0Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
        }

        logPhase('Phase 0', [], null, null);
      }

      // ── Phase 1: Movement ──────────────────────────────────────────────
      let moveResult: { movedTo?: { row: number; col: number }; milepostsMoved?: number; trackUsageFee?: number } = {};
      let phase1Options: FeasibleOption[] = [];
      let phase1Chosen: FeasibleOption | null = null;

      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        try {
          const moveActions = new Set([AIActionType.MoveTrain]);
          const moveOptions = OptionGenerator.generate(snapshot, moveActions)
            .filter(o => o.feasible);
          phase1Options = moveOptions;

          if (moveOptions.length > 0) {
            const scoredMoves = Scorer.score(moveOptions, snapshot, botConfig);
            phase1Options = scoredMoves;

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              const candidate = scoredMoves[attempt] ?? null;
              if (!candidate || !candidate.feasible) break;

              const validation = validate(candidate, snapshot);
              if (!validation.valid) continue;

              try {
                const result = await TurnExecutor.execute(candidate, snapshot);
                if (result.success) {
                  phase1Chosen = candidate;
                  // Update snapshot position and money for subsequent phases
                  const dest = candidate.movementPath?.[candidate.movementPath.length - 1];
                  if (dest) {
                    snapshot.bot.position = { row: dest.row, col: dest.col };
                  }
                  snapshot.bot.money = result.remainingMoney;
                  moveResult = {
                    movedTo: dest,
                    milepostsMoved: candidate.mileposts,
                    trackUsageFee: result.cost,
                  };
                  logPhase('Phase 1', phase1Options, phase1Chosen, result);
                  break;
                }
              } catch (execError) {
                console.error(`${tag} Move attempt ${attempt} threw:`, execError instanceof Error ? execError.message : execError);
              }
            }
          }

          // Log Phase 1 if no move succeeded
          if (!phase1Chosen) {
            logPhase('Phase 1', phase1Options, null, null);
          }
        } catch (moveError) {
          console.warn(`${tag} Phase 1 failed (continuing to building):`, moveError instanceof Error ? moveError.message : moveError);
          logPhase('Phase 1', phase1Options, null, null);
        }
      }

      // ── Phase 1.5: Post-movement delivery/pickup/drop at new position
      if (moveResult.movedTo && snapshot.gameStatus === 'active') {
        // Re-capture snapshot to get updated state after movement
        snapshot = await capture(gameId, botPlayerId);

        const phase15Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 1.5',
        );
        loadsDelivered.push(...phase15Result.delivered);
        loadsPickedUp.push(...phase15Result.pickedUp);

        // Re-capture snapshot if state changed (for Phase 2 building)
        if (phase15Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
        }

        logPhase('Phase 1.5', [], null, null);
      }

      // ── Phase 2: Building ──────────────────────────────────────────────
      const buildActions = new Set([AIActionType.BuildTrack, AIActionType.UpgradeTrain, AIActionType.PassTurn]);
      const buildOptions = OptionGenerator.generate(snapshot, buildActions, memory);

      const scoredBuild = Scorer.score(buildOptions, snapshot, botConfig, memory);

      // Try each build option in score order
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const candidate = scoredBuild[attempt] ?? null;
        if (!candidate || !candidate.feasible) break;

        const validation = validate(candidate, snapshot);
        if (!validation.valid) continue;

        try {
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            const durationMs = Date.now() - startTime;

            // Concise turn summary
            const parts: string[] = [];
            if (moveResult.movedTo) parts.push(`Move→${moveResult.movedTo.row},${moveResult.movedTo.col}(${moveResult.milepostsMoved}mi)`);
            for (const d of loadsDelivered) parts.push(`Deliver→${d.loadType}@${d.city}/$${d.payment}M`);
            for (const p of loadsPickedUp) parts.push(`Pickup→${p.loadType}@${p.city}`);
            if (result.action === AIActionType.BuildTrack) parts.push(`Build→${result.segmentsBuilt}seg/$${result.cost}M→${candidate.targetCity ?? '?'}`);
            else if (result.action === AIActionType.UpgradeTrain) parts.push(`Upgrade→${candidate.targetTrainType}`);
            console.log(`${tag} Turn complete: ${parts.join(', ') || 'PassTurn'} | money=${snapshot.bot.money}→${result.remainingMoney}`);

            // Update bot memory after successful Phase 2
            const deliveryEarnings = loadsDelivered.reduce((sum, d) => sum + d.payment, 0);
            const buildTarget = result.action === AIActionType.BuildTrack ? (candidate.targetCity ?? null) : memory.currentBuildTarget;
            updateMemory(gameId, botPlayerId, {
              lastAction: result.action,
              consecutivePassTurns: 0,
              deliveryCount: memory.deliveryCount + loadsDelivered.length,
              totalEarnings: memory.totalEarnings + deliveryEarnings,
              turnNumber: snapshot.turnNumber,
              currentBuildTarget: buildTarget,
              turnsOnTarget: buildTarget === memory.currentBuildTarget
                ? memory.turnsOnTarget + 1
                : (buildTarget ? 1 : 0),
            });

            logPhase('Phase 2', scoredBuild, candidate, result);
            flushTurnLog();

            return {
              action: result.action,
              segmentsBuilt: result.segmentsBuilt,
              cost: result.cost,
              durationMs,
              success: true,
              ...moveResult,
              loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
              loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
              buildTargetCity: candidate.targetCity,
            };
          }
        } catch (execError) {
          console.error(`${tag} Build attempt ${attempt} threw:`, execError instanceof Error ? execError.message : execError);
        }
      }

      // All retries exhausted: fall back to PassTurn
      const passPlan: FeasibleOption = {
        action: AIActionType.PassTurn,
        feasible: true,
        reason: 'Fallback after retries',
      };
      const passResult = await TurnExecutor.execute(passPlan, snapshot);
      const durationMs = Date.now() - startTime;

      // Concise summary for PassTurn fallback
      const parts: string[] = [];
      if (moveResult.movedTo) parts.push(`Move→${moveResult.movedTo.row},${moveResult.movedTo.col}(${moveResult.milepostsMoved}mi)`);
      for (const d of loadsDelivered) parts.push(`Deliver→${d.loadType}@${d.city}/$${d.payment}M`);
      for (const p of loadsPickedUp) parts.push(`Pickup→${p.loadType}@${p.city}`);
      parts.push('PassTurn(fallback)');
      console.log(`${tag} Turn complete: ${parts.join(', ')} | money=${snapshot.bot.money}`);

      // Update bot memory for PassTurn fallback
      const ptDeliveryEarnings = loadsDelivered.reduce((sum, d) => sum + d.payment, 0);
      updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
        consecutivePassTurns: memory.consecutivePassTurns + 1,
        deliveryCount: memory.deliveryCount + loadsDelivered.length,
        totalEarnings: memory.totalEarnings + ptDeliveryEarnings,
        turnNumber: snapshot.turnNumber,
      });

      logPhase('Phase 2', scoredBuild, passPlan, passResult);
      flushTurnLog();

      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: passResult.success,
        ...moveResult,
        loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
        loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error(`${tag} PIPELINE ERROR (${durationMs}ms):`, error instanceof Error ? error.stack : error);

      // Update bot memory even on pipeline error
      updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
        consecutivePassTurns: memory.consecutivePassTurns + 1,
        turnNumber: memory.turnNumber + 1,
      });

      flushTurnLog();

      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
        loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
      };
    }
  }

  /**
   * Execute all feasible delivery and pickup actions at the bot's current position.
   * Deliveries are tried first (higher value), then pickups.
   * Returns what was delivered/picked up and whether snapshot needs refresh.
   */
  private static async executeLoadActions(
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
    tag: string,
    phase: string,
  ): Promise<{
    delivered: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
    pickedUp: Array<{ loadType: string; city: string }>;
    stateChanged: boolean;
  }> {
    const delivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];
    const pickedUp: Array<{ loadType: string; city: string }> = [];
    let stateChanged = false;

    // Try deliveries first (highest priority — immediate income)
    const loadActions = new Set([AIActionType.DeliverLoad, AIActionType.PickupLoad, AIActionType.DropLoad]);
    const deliveryOptions = OptionGenerator.generate(snapshot, loadActions)
      .filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    if (deliveryOptions.length > 0) {
      const scoredDeliveries = Scorer.score(deliveryOptions, snapshot, botConfig);
      for (const candidate of scoredDeliveries) {
        if (!candidate.feasible) continue;
        const validation = validate(candidate, snapshot);
        if (!validation.valid) {
          console.log(`${tag} ${phase} delivery validation failed: ${validation.reason}`);
          continue;
        }
        try {
          console.log(`${tag} ${phase}: executing DeliverLoad ${candidate.loadType} to ${candidate.targetCity} (card=${candidate.cardId}, payment=${candidate.payment})`);
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            delivered.push({
              loadType: candidate.loadType!,
              city: candidate.targetCity!,
              payment: result.payment ?? candidate.payment ?? 0,
              cardId: candidate.cardId!,
            });
            // Update snapshot inline for subsequent actions in same phase
            snapshot.bot.money = result.remainingMoney;
            snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== candidate.loadType);
            snapshot.bot.demandCards = snapshot.bot.demandCards.filter(c => c !== candidate.cardId);
            if (result.newCardId != null) {
              snapshot.bot.demandCards.push(result.newCardId);
            }
            stateChanged = true;
            console.log(`${tag} ${phase}: delivered ${candidate.loadType}, payment=${result.payment}, money=${result.remainingMoney}`);
          }
        } catch (execError) {
          console.error(`${tag} ${phase} delivery execution threw:`, execError instanceof Error ? execError.message : execError);
        }
      }
    }

    // Try drop loads (escape valve — drop truly orphaned loads before pickups)
    const dropOptions = OptionGenerator.generate(snapshot, loadActions)
      .filter(o => o.action === AIActionType.DropLoad && o.feasible);

    if (dropOptions.length > 0) {
      const scoredDrops = Scorer.score(dropOptions, snapshot, botConfig);
      for (const candidate of scoredDrops) {
        if (!candidate.feasible) continue;
        // Score gate: only drop if the Scorer thinks it's clearly beneficial.
        // Prevents marginal drops that create oscillation loops.
        if ((candidate.score ?? 0) <= 0) {
          console.log(`${tag} ${phase}: skipping DropLoad ${candidate.loadType} (score=${candidate.score} ≤ 0)`);
          continue;
        }
        const validation = validate(candidate, snapshot);
        if (!validation.valid) continue;
        try {
          console.log(`${tag} ${phase}: executing DropLoad ${candidate.loadType} at ${candidate.targetCity} (score=${candidate.score})`);
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== candidate.loadType);
            stateChanged = true;
            console.log(`${tag} ${phase}: dropped ${candidate.loadType}, loads=[${snapshot.bot.loads.join(',')}]`);
          }
        } catch (execError) {
          console.error(`${tag} ${phase} drop execution threw:`, execError instanceof Error ? execError.message : execError);
        }
      }
    }

    // Try pickups (only after deliveries/drops — may have freed capacity)
    // Re-generate options before each pickup to respect train capacity limits
    let pickupAttempts = 0;
    const maxPickupAttempts = 3; // safety bound
    while (pickupAttempts < maxPickupAttempts) {
      pickupAttempts++;
      const pickupOptions = OptionGenerator.generate(snapshot, loadActions)
        .filter(o => o.action === AIActionType.PickupLoad && o.feasible);

      if (pickupOptions.length === 0) break;

      const scoredPickups = Scorer.score(pickupOptions, snapshot, botConfig);
      const candidate = scoredPickups.find(o => o.feasible);
      if (!candidate) break;

      const validation = validate(candidate, snapshot);
      if (!validation.valid) break;
      try {
        console.log(`${tag} ${phase}: executing PickupLoad ${candidate.loadType} at ${candidate.targetCity}`);
        const result = await TurnExecutor.execute(candidate, snapshot);
        if (result.success) {
          pickedUp.push({
            loadType: candidate.loadType!,
            city: candidate.targetCity!,
          });
          // Update snapshot inline
          snapshot.bot.loads.push(candidate.loadType!);
          stateChanged = true;
          console.log(`${tag} ${phase}: picked up ${candidate.loadType}, loads=[${snapshot.bot.loads.join(',')}]`);
        } else {
          break;
        }
      } catch (execError) {
        console.error(`${tag} ${phase} pickup execution threw:`, execError instanceof Error ? execError.message : execError);
        break;
      }
    }

    return { delivered, pickedUp, stateChanged };
  }

  /**
   * Auto-place bot at the best major city when it has track but no position.
   * Picks the major city closest to the bot's existing track network.
   */
  static async autoPlaceBot(snapshot: WorldSnapshot): Promise<void> {
    const groups = getMajorCityGroups();
    if (groups.length === 0) return;

    // Find the major city closest to any existing track endpoint
    let bestCity = groups[0].center;
    let bestDist = Infinity;

    for (const group of groups) {
      for (const seg of snapshot.bot.existingSegments) {
        const dr = group.center.row - seg.to.row;
        const dc = group.center.col - seg.to.col;
        const dist = dr * dr + dc * dc;
        if (dist < bestDist) {
          bestDist = dist;
          bestCity = group.center;
        }
      }
    }

    const pixel = gridToPixel(bestCity.row, bestCity.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [bestCity.row, bestCity.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: bestCity.row, col: bestCity.col };
  }

  /**
   * Handle ferry crossing when bot starts its turn at a ferry port.
   * Game rule: stop at port one turn, teleport to other side next turn at half speed.
   * Returns true if the bot crossed a ferry (caller should re-capture snapshot and set ferryHalfSpeed).
   */
  private static async handleFerryCrossing(
    snapshot: WorldSnapshot,
    tag: string,
  ): Promise<boolean> {
    if (!snapshot.bot.position) return false;

    const ferryEdges = getFerryEdges();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;

    // Find which ferry port (if any) the bot is at
    let otherSide: { row: number; col: number } | null = null;
    let ferryName = '';

    for (const ferry of ferryEdges) {
      const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
      const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
      if (posKey === aKey) {
        otherSide = ferry.pointB;
        ferryName = ferry.name;
        break;
      }
      if (posKey === bKey) {
        otherSide = ferry.pointA;
        ferryName = ferry.name;
        break;
      }
    }

    if (!otherSide) return false;

    // Bot is at a ferry port. Decide whether crossing is beneficial:
    // Cross if any demand city target is closer (Euclidean) from the other side.
    const grid = loadGridPoints();
    const curR = snapshot.bot.position.row;
    const curC = snapshot.bot.position.col;
    let shouldCross = false;

    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        for (const [, point] of grid) {
          if (point.name === demand.city) {
            const currentDist = (curR - point.row) ** 2 + (curC - point.col) ** 2;
            const otherDist = (otherSide.row - point.row) ** 2 + (otherSide.col - point.col) ** 2;
            if (otherDist < currentDist) {
              shouldCross = true;
              break;
            }
          }
        }
        if (shouldCross) break;
      }
      if (shouldCross) break;
    }

    if (!shouldCross) {
      console.log(`${tag} At ferry port ${ferryName} but no demand city closer from other side — staying`);
      return false;
    }

    // Cross the ferry: teleport to other side
    console.log(`${tag} Crossing ferry ${ferryName} to ${otherSide.row},${otherSide.col}`);
    const pixel = gridToPixel(otherSide.row, otherSide.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [otherSide.row, otherSide.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: otherSide.row, col: otherSide.col };
    return true;
  }
}
