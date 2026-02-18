/**
 * PlanExecutor — Executes an active DeliveryPlan by selecting move/build options
 * aligned with the plan's current phase.
 *
 * Stateless: takes plan + snapshot, returns choices + updated plan.
 * All persistent state lives in BotMemoryState via BotMemory.
 *
 * Phase flow:
 *   build_to_pickup → travel_to_pickup → pickup →
 *   build_to_delivery → travel_to_delivery → deliver
 */

import {
  DeliveryPlan,
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotMemoryState,
  BotConfig,
} from '../../../shared/types/GameTypes';
import { Scorer } from './Scorer';
import { loadGridPoints } from './MapTopology';

/** Amplified loyalty factor when executing a plan (vs 1.5x default) */
const PLAN_LOYALTY_FACTOR = 3.0;

export interface PlanExecutionResult {
  moveChoice: FeasibleOption | null;
  buildChoice: FeasibleOption | null;
  updatedPlan: DeliveryPlan;
  planComplete: boolean;
}

export class PlanExecutor {
  /**
   * Execute one turn of an active delivery plan.
   * Selects the best move/build options aligned with the current plan phase,
   * and advances the phase if milestones are reached.
   */
  static executePlan(
    plan: DeliveryPlan,
    snapshot: WorldSnapshot,
    feasibleMoves: FeasibleOption[],
    feasibleBuilds: FeasibleOption[],
    memory: BotMemoryState,
  ): PlanExecutionResult {
    const tag = `[PlanExec ${snapshot.gameId.slice(0, 8)}]`;
    let updatedPlan = { ...plan };

    // Detect phase transitions BEFORE selecting options
    updatedPlan = PlanExecutor.detectPhaseTransition(updatedPlan, snapshot);

    console.log(`${tag} Phase=${updatedPlan.phase}, target=${updatedPlan.phase.startsWith('build') || updatedPlan.phase === 'pickup' ? updatedPlan.pickupCity : updatedPlan.deliveryCity}`);

    // Check if plan is already complete (deliver phase + load delivered)
    if (updatedPlan.phase === 'deliver') {
      // Phase 0/1.5 handles actual delivery — just signal completion
      return {
        moveChoice: null,
        buildChoice: null,
        updatedPlan,
        planComplete: true,
      };
    }

    // Override memory's build target to align with the plan
    const planTargetCity = PlanExecutor.getCurrentTargetCity(updatedPlan);
    const planMemory: BotMemoryState = {
      ...memory,
      currentBuildTarget: planTargetCity,
      turnsOnTarget: 0, // Reset so loyalty bonus always applies
    };

    let moveChoice: FeasibleOption | null = null;
    let buildChoice: FeasibleOption | null = null;

    switch (updatedPlan.phase) {
      case 'build_to_pickup':
      case 'build_to_delivery': {
        // Score builds toward target city with amplified loyalty
        if (feasibleBuilds.length > 0) {
          const scoredBuilds = Scorer.score([...feasibleBuilds], snapshot, snapshot.bot.botConfig as BotConfig | null, planMemory);
          // Prefer BuildTrack targeting the plan's city
          buildChoice = scoredBuilds.find(o =>
            o.feasible && o.action === AIActionType.BuildTrack && o.targetCity === planTargetCity,
          ) ?? scoredBuilds.find(o => o.feasible && o.action === AIActionType.BuildTrack) ?? scoredBuilds[0] ?? null;
        }
        // Also move if possible (toward target)
        if (feasibleMoves.length > 0) {
          moveChoice = PlanExecutor.selectMoveToward(feasibleMoves, planTargetCity, snapshot);
        }
        break;
      }

      case 'travel_to_pickup':
      case 'travel_to_delivery': {
        // Score moves toward target city
        if (feasibleMoves.length > 0) {
          moveChoice = PlanExecutor.selectMoveToward(feasibleMoves, planTargetCity, snapshot);
        }
        // Still build if we can (toward target)
        if (feasibleBuilds.length > 0) {
          const scoredBuilds = Scorer.score([...feasibleBuilds], snapshot, snapshot.bot.botConfig as BotConfig | null, planMemory);
          buildChoice = scoredBuilds.find(o =>
            o.feasible && o.action === AIActionType.BuildTrack && o.targetCity === planTargetCity,
          ) ?? scoredBuilds.find(o => o.feasible && o.action !== AIActionType.PassTurn) ?? scoredBuilds[0] ?? null;
        }
        break;
      }

      case 'pickup': {
        // Phase 0/1.5 handles actual pickup. Move to pickup city if not there.
        if (feasibleMoves.length > 0) {
          moveChoice = PlanExecutor.selectMoveToward(feasibleMoves, updatedPlan.pickupCity, snapshot);
        }
        // Build toward delivery city if possible
        if (feasibleBuilds.length > 0) {
          const deliveryMemory: BotMemoryState = {
            ...memory,
            currentBuildTarget: updatedPlan.deliveryCity,
            turnsOnTarget: 0,
          };
          const scoredBuilds = Scorer.score([...feasibleBuilds], snapshot, snapshot.bot.botConfig as BotConfig | null, deliveryMemory);
          buildChoice = scoredBuilds.find(o => o.feasible && o.action === AIActionType.BuildTrack) ?? scoredBuilds[0] ?? null;
        }
        break;
      }
    }

    return {
      moveChoice,
      buildChoice,
      updatedPlan,
      planComplete: false,
    };
  }

  /**
   * Detect and apply phase transitions based on current game state.
   */
  private static detectPhaseTransition(plan: DeliveryPlan, snapshot: WorldSnapshot): DeliveryPlan {
    const grid = loadGridPoints();
    const onNetwork = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      onNetwork.add(`${seg.from.row},${seg.from.col}`);
      onNetwork.add(`${seg.to.row},${seg.to.col}`);
    }

    // Helper: check if a city is on the bot's track network
    const cityOnNetwork = (cityName: string): boolean => {
      for (const [key, point] of grid) {
        if (point.name === cityName && onNetwork.has(key)) return true;
      }
      return false;
    };

    // Helper: check if bot is at a city
    const botAtCity = (cityName: string): boolean => {
      if (!snapshot.bot.position) return false;
      const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
      const point = grid.get(posKey);
      return point?.name === cityName;
    };

    const hasLoad = snapshot.bot.loads.includes(plan.loadType);

    switch (plan.phase) {
      case 'build_to_pickup':
        if (cityOnNetwork(plan.pickupCity)) {
          return { ...plan, phase: 'travel_to_pickup' };
        }
        break;

      case 'travel_to_pickup':
        if (botAtCity(plan.pickupCity)) {
          return { ...plan, phase: 'pickup' };
        }
        break;

      case 'pickup':
        if (hasLoad) {
          // Load picked up — transition based on delivery city reachability
          if (cityOnNetwork(plan.deliveryCity)) {
            return { ...plan, phase: 'travel_to_delivery' };
          }
          return { ...plan, phase: 'build_to_delivery' };
        }
        break;

      case 'build_to_delivery':
        if (cityOnNetwork(plan.deliveryCity)) {
          return { ...plan, phase: 'travel_to_delivery' };
        }
        break;

      case 'travel_to_delivery':
        if (botAtCity(plan.deliveryCity)) {
          return { ...plan, phase: 'deliver' };
        }
        break;
    }

    // If bot already has the load and we're still in a pre-pickup phase, skip ahead
    if (hasLoad && (plan.phase === 'build_to_pickup' || plan.phase === 'travel_to_pickup' || plan.phase === 'pickup')) {
      if (cityOnNetwork(plan.deliveryCity)) {
        return { ...plan, phase: 'travel_to_delivery' };
      }
      return { ...plan, phase: 'build_to_delivery' };
    }

    return plan;
  }

  /**
   * Get the current target city based on plan phase.
   */
  private static getCurrentTargetCity(plan: DeliveryPlan): string {
    switch (plan.phase) {
      case 'build_to_pickup':
      case 'travel_to_pickup':
      case 'pickup':
        return plan.pickupCity;
      case 'build_to_delivery':
      case 'travel_to_delivery':
      case 'deliver':
        return plan.deliveryCity;
    }
  }

  /**
   * Select the best move option heading toward a target city.
   * Prefers moves directly to the target, then closest approach.
   */
  private static selectMoveToward(
    feasibleMoves: FeasibleOption[],
    targetCity: string,
    snapshot: WorldSnapshot,
  ): FeasibleOption | null {
    // Direct move to target city
    const directMove = feasibleMoves.find(
      o => o.feasible && o.action === AIActionType.MoveTrain && o.targetCity === targetCity,
    );
    if (directMove) return directMove;

    // Score remaining moves by proximity to target city
    const grid = loadGridPoints();
    let targetRow = 0;
    let targetCol = 0;
    for (const [, point] of grid) {
      if (point.name === targetCity) {
        targetRow = point.row;
        targetCol = point.col;
        break;
      }
    }

    let bestMove: FeasibleOption | null = null;
    let bestDist = Infinity;

    for (const option of feasibleMoves) {
      if (!option.feasible || option.action !== AIActionType.MoveTrain) continue;
      const pathEnd = option.movementPath?.[option.movementPath.length - 1];
      if (!pathEnd) continue;

      const dist = (pathEnd.row - targetRow) ** 2 + (pathEnd.col - targetCol) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestMove = option;
      }
    }

    return bestMove;
  }
}
