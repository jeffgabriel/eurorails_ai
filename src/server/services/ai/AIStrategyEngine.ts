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

      // ── Phase 0: Immediate delivery/pickup at current position ──────
      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        console.log(`${tag} Phase 0: Immediate delivery/pickup at current position`);
        const phase0Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 0',
        );
        loadsDelivered.push(...phase0Result.delivered);
        loadsPickedUp.push(...phase0Result.pickedUp);

        // Re-capture snapshot if any state-mutating actions occurred
        if (phase0Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
          console.log(`${tag} Phase 0: Re-captured snapshot after ${phase0Result.delivered.length} deliveries, ${phase0Result.pickedUp.length} pickups`);
        }
      }

      // ── Phase 1: Movement ──────────────────────────────────────────────
      let moveResult: { movedTo?: { row: number; col: number }; milepostsMoved?: number; trackUsageFee?: number } = {};

      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        console.log(`${tag} Phase 1: Movement`);
        try {
          const moveOptions = OptionGenerator.generate(snapshot)
            .filter(o => o.action === AIActionType.MoveTrain && o.feasible);

          if (moveOptions.length > 0) {
            const scoredMoves = Scorer.score(moveOptions, snapshot, botConfig);
            console.log(`${tag} Move options: ${scoredMoves.map(o => `${o.targetCity}(score=${o.score?.toFixed(1)}, miles=${o.mileposts}, fee=${o.estimatedCost ?? 0})`).join(', ')}`);

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              const candidate = scoredMoves[attempt] ?? null;
              if (!candidate || !candidate.feasible) break;

              const validation = validate(candidate, snapshot);
              if (!validation.valid) {
                console.log(`${tag} Move attempt ${attempt}: validation failed — ${validation.reason}`);
                continue;
              }

              try {
                console.log(`${tag} Move attempt ${attempt}: executing MoveTrain to ${candidate.targetCity} (${candidate.mileposts} mileposts, fee=${candidate.estimatedCost ?? 0})`);
                const result = await TurnExecutor.execute(candidate, snapshot);
                if (result.success) {
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
                  console.log(`${tag} Phase 1 SUCCESS: moved to ${dest?.row},${dest?.col}, fee=${result.cost}, money=${result.remainingMoney}`);
                  break;
                }
              } catch (execError) {
                console.error(`${tag} Move attempt ${attempt}: execution threw:`, execError instanceof Error ? execError.message : execError);
              }
            }
          } else {
            console.log(`${tag} Phase 1: No feasible move options`);
          }
        } catch (moveError) {
          console.warn(`${tag} Phase 1 failed (continuing to building):`, moveError instanceof Error ? moveError.message : moveError);
        }
      }

      // ── Phase 1.5: Post-movement delivery/pickup at new position ────
      if (moveResult.movedTo && snapshot.gameStatus === 'active') {
        // Re-capture snapshot to get updated state after movement
        snapshot = await capture(gameId, botPlayerId);
        console.log(`${tag} Phase 1.5: Post-movement delivery/pickup at ${moveResult.movedTo.row},${moveResult.movedTo.col}`);

        const phase15Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 1.5',
        );
        loadsDelivered.push(...phase15Result.delivered);
        loadsPickedUp.push(...phase15Result.pickedUp);

        // Re-capture snapshot if state changed (for Phase 2 building)
        if (phase15Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
          console.log(`${tag} Phase 1.5: Re-captured snapshot after ${phase15Result.delivered.length} deliveries, ${phase15Result.pickedUp.length} pickups`);
        }
      }

      // ── Phase 2: Building ──────────────────────────────────────────────
      console.log(`${tag} Phase 2: Building`);
      const buildOptions = OptionGenerator.generate(snapshot)
        .filter(o => o.action === AIActionType.BuildTrack || o.action === AIActionType.PassTurn);
      console.log(`${tag} Build options: ${buildOptions.map(o => `${o.action}(feasible=${o.feasible}, segments=${o.segments?.length ?? 0}, cost=${o.estimatedCost ?? 0}, reason="${o.reason}")`).join(', ')}`);

      const scoredBuild = Scorer.score(buildOptions, snapshot, botConfig);
      console.log(`${tag} Build scored: ${scoredBuild.map(o => `${o.action}(score=${o.score?.toFixed(1)}, feasible=${o.feasible})`).join(', ')}`);

      // Try each build option in score order
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const candidate = scoredBuild[attempt] ?? null;
        if (!candidate || !candidate.feasible) {
          console.log(`${tag} Build attempt ${attempt}: no feasible candidate, breaking`);
          break;
        }

        const validation = validate(candidate, snapshot);
        if (!validation.valid) {
          console.log(`${tag} Build attempt ${attempt}: validation failed — ${validation.reason}`);
          continue;
        }

        try {
          console.log(`${tag} Build attempt ${attempt}: executing ${candidate.action} (segments=${candidate.segments?.length ?? 0}, cost=${candidate.estimatedCost ?? 0})`);
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            const durationMs = Date.now() - startTime;
            console.log(`${tag} SUCCESS: ${result.action}, built=${result.segmentsBuilt}, cost=${result.cost}, ${durationMs}ms`);
            return {
              action: result.action,
              segmentsBuilt: result.segmentsBuilt,
              cost: result.cost,
              durationMs,
              success: true,
              ...moveResult,
              loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
              loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
            };
          }
        } catch (execError) {
          console.error(`${tag} Build attempt ${attempt}: execution threw:`, execError instanceof Error ? execError.message : execError);
        }
      }

      // All retries exhausted: fall back to PassTurn
      console.log(`${tag} All build retries exhausted, falling back to PassTurn`);
      const passPlan: FeasibleOption = {
        action: AIActionType.PassTurn,
        feasible: true,
        reason: 'Fallback after retries',
      };
      const passResult = await TurnExecutor.execute(passPlan, snapshot);
      const durationMs = Date.now() - startTime;

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
    const deliveryOptions = OptionGenerator.generate(snapshot)
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

    // Try pickups (only after deliveries — may have freed capacity)
    const pickupOptions = OptionGenerator.generate(snapshot)
      .filter(o => o.action === AIActionType.PickupLoad && o.feasible);

    if (pickupOptions.length > 0) {
      const scoredPickups = Scorer.score(pickupOptions, snapshot, botConfig);
      for (const candidate of scoredPickups) {
        if (!candidate.feasible) continue;
        const validation = validate(candidate, snapshot);
        if (!validation.valid) {
          console.log(`${tag} ${phase} pickup validation failed: ${validation.reason}`);
          continue;
        }
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
          }
        } catch (execError) {
          console.error(`${tag} ${phase} pickup execution threw:`, execError instanceof Error ? execError.message : execError);
        }
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
