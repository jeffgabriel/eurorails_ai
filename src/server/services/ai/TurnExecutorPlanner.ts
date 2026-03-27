/**
 * TurnExecutorPlanner — Unified turn planning service.
 *
 * Replaces PlanExecutor + TurnComposer as the single entry point for
 * turn execution planning. Produces a complete turn plan (move, pickup,
 * deliver, build) from a route and game state.
 *
 * Architecture:
 *   Phase A — Movement loop: consumes the full movement budget by advancing
 *     through route stops. Pickups advance without reordering (ADR-4).
 *     Deliveries trigger a mid-turn TripPlanner replan and continue on the
 *     NEW route (ADR-3).
 *   Phase B — Build: uses resolveBuildTarget (unified, single source of truth),
 *     shouldDeferBuild JIT gate, and at most 1 BuildAdvisor solvency retry.
 *
 * Helper functions used (all single source of truth):
 *   - isStopComplete   (routeHelpers.ts)
 *   - resolveBuildTarget (routeHelpers.ts)
 *   - getNetworkFrontier (routeHelpers.ts)
 *
 * This file is the planning layer. The DB execution layer is TurnExecutor.ts.
 */

import {
  TurnPlan,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  AIActionType,
  GridPoint,
} from '../../../shared/types/GameTypes';
import { isStopComplete, resolveBuildTarget } from './routeHelpers';
import { CompositionTrace } from './TurnComposer';
import { LLMStrategyBrain } from './LLMStrategyBrain';

// ── TurnExecutorResult ─────────────────────────────────────────────────────

/**
 * Result returned by TurnExecutorPlanner.execute().
 *
 * Contains the plans to be executed this turn plus updated route state.
 */
export interface TurnExecutorResult {
  /** Ordered sequence of turn plans to execute (may be empty if PassTurn) */
  plans: TurnPlan[];
  /** Route state after this turn's planning (advanced stop indices, etc.) */
  updatedRoute: StrategicRoute;
  /** Structured trace of what happened during planning — for debuggability */
  compositionTrace: CompositionTrace;
  /** True when all route stops are completed */
  routeComplete: boolean;
  /** True when the route was abandoned (e.g., stuck, contradictory state) */
  routeAbandoned: boolean;
  /** True when at least one delivery was made this turn */
  hasDelivery: boolean;
}

// ── TurnExecutorPlanner ────────────────────────────────────────────────────

/**
 * TurnExecutorPlanner — Unified turn planning service.
 *
 * Single entry point for all bot turn planning. Replaces PlanExecutor and
 * TurnComposer.
 *
 * Usage:
 *   const result = await TurnExecutorPlanner.execute(route, snapshot, context);
 *   // execute result.plans sequentially against the DB
 */
export class TurnExecutorPlanner {
  /**
   * Produce a complete turn plan for the bot from the active route and game state.
   *
   * Phase A (Movement): Advances through route stops within the movement budget.
   *   - Pickup stop: pick up load, advance stop index, continue moving (no reorder)
   *   - Delivery stop: deliver load, advance stop index, replan via TripPlanner
   *     (stub in this project), continue on NEW route with remaining budget
   *
   * Phase B (Build): Resolves a build target and optionally appends a BuildTrack
   *   plan after movement completes.
   *
   * @param route - Active strategic route.
   * @param snapshot - Current world snapshot.
   * @param context - Derived game context for this turn.
   * @param brain - Optional LLM strategy brain for BuildAdvisor calls.
   * @param gridPoints - Optional pre-loaded grid points for map queries.
   * @returns TurnExecutorResult with plans, updated route, and trace.
   */
  static async execute(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain?: LLMStrategyBrain | null,
    gridPoints?: GridPoint[],
  ): Promise<TurnExecutorResult> {
    const tag = '[TurnExecutorPlanner]';

    // Initialise trace (mirrors CompositionTrace shape for compatibility)
    const trace: CompositionTrace = {
      inputPlan: [],
      outputPlan: [],
      moveBudget: { total: context.speed, used: 0, wasted: 0 },
      a1: { citiesScanned: 0, opportunitiesFound: 0 },
      a2: { iterations: 0, terminationReason: '' },
      a3: { movePreprended: false },
      build: { target: null, cost: 0, skipped: false, upgradeConsidered: false },
      pickups: [],
      deliveries: [],
    };

    // ── Skip completed stops ────────────────────────────────────────────────
    let activeRoute = TurnExecutorPlanner.skipCompletedStops(route, context);

    // ── Invariant: stop index must not decrease ─────────────────────────────
    TurnExecutorPlanner.assertStopIndexNotDecreased(route, activeRoute, tag);

    // ── Route complete check ────────────────────────────────────────────────
    if (activeRoute.currentStopIndex >= activeRoute.stops.length) {
      console.log(`${tag} Route complete — all stops done`);
      trace.a2.terminationReason = 'route_complete';
      return TurnExecutorPlanner.routeComplete(activeRoute, trace);
    }

    const plans: TurnPlan[] = [];
    let hasDelivery = false;

    // ── Phase A: Movement loop ─────────────────────────────────────────────
    // (Stub for this task — full movement implementation in BE-005/BE-006)
    // The movement loop will:
    //   while (budget remaining && activeRoute.currentStopIndex < stops.length):
    //     check if next stop city is reachable
    //     if reachable: move there, execute action (pickup/deliver), advance index
    //     if deliver: replan via TripPlanner, continue on new route
    //     if not reachable: move as far as possible, break
    //
    // For now, produce a PassTurn placeholder so the shell compiles and tests pass.
    // The actual movement logic is introduced in subsequent tasks.
    trace.a2.terminationReason = 'stub_movement_not_yet_implemented';

    // ── Phase B: Build target resolution ──────────────────────────────────
    const buildTarget = resolveBuildTarget(activeRoute, context);
    if (buildTarget) {
      trace.build.target = buildTarget.targetCity;
      console.log(
        `${tag} Build target: ${buildTarget.targetCity} (isVictoryBuild=${buildTarget.isVictoryBuild})`,
      );
    } else {
      trace.build.skipped = true;
    }

    // PassTurn as placeholder until movement phases are implemented
    if (plans.length === 0) {
      plans.push({ type: AIActionType.PassTurn });
    }

    trace.outputPlan = plans.map(p => p.type);

    return {
      plans,
      updatedRoute: activeRoute,
      compositionTrace: trace,
      routeComplete: false,
      routeAbandoned: false,
      hasDelivery,
    };
  }

  // ── Route state helpers ────────────────────────────────────────────────

  /**
   * Advance past any already-completed stops at the front of the route.
   * Uses the unified isStopComplete() — the single source of truth.
   */
  static skipCompletedStops(
    route: StrategicRoute,
    context: GameContext,
  ): StrategicRoute {
    let idx = route.currentStopIndex;

    while (idx < route.stops.length) {
      const stop = route.stops[idx];
      if (isStopComplete(stop, idx, route.stops, context)) {
        console.log(
          `[TurnExecutorPlanner] Skipping completed stop: ${stop.action}(${stop.loadType}@${stop.city})`,
        );
        idx++;
      } else {
        break;
      }
    }

    if (idx !== route.currentStopIndex) {
      return { ...route, currentStopIndex: idx };
    }
    return route;
  }

  // ── Runtime invariant assertions ────────────────────────────────────────

  /**
   * AC13(a): Route stop index must never decrease.
   * Throws if the updated route has a lower stop index than the original.
   */
  private static assertStopIndexNotDecreased(
    originalRoute: StrategicRoute,
    updatedRoute: StrategicRoute,
    tag: string,
  ): void {
    if (updatedRoute.currentStopIndex < originalRoute.currentStopIndex) {
      throw new Error(
        `${tag} INVARIANT VIOLATION: route stop index decreased from ` +
          `${originalRoute.currentStopIndex} to ${updatedRoute.currentStopIndex}`,
      );
    }
  }

  // ── Return helpers ────────────────────────────────────────────────────

  private static routeComplete(
    route: StrategicRoute,
    trace: CompositionTrace,
  ): TurnExecutorResult {
    trace.outputPlan = [AIActionType.PassTurn];
    return {
      plans: [{ type: AIActionType.PassTurn }],
      updatedRoute: route,
      compositionTrace: trace,
      routeComplete: true,
      routeAbandoned: false,
      hasDelivery: false,
    };
  }
}
