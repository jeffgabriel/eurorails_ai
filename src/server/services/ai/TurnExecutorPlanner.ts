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
 *     Deliveries trigger post-delivery revalidation and continue on the
 *     (possibly pruned) route with remaining budget.
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
  TurnPlanMoveTrain,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  AIActionType,
  GridPoint,
  RouteStop,
} from '../../../shared/types/GameTypes';
import { isStopComplete, resolveBuildTarget } from './routeHelpers';
import { CompositionTrace } from './TurnComposer';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { ActionResolver } from './ActionResolver';
import { PlanExecutor } from './PlanExecutor';
import { TripPlanner } from './TripPlanner';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { getMemory } from './BotMemory';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';

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
    let remainingBudget = context.speed;

    // ── Phase A: Movement loop ─────────────────────────────────────────────
    //
    // ADR-3: After delivery, revalidate route and continue on (pruned) route
    //   with remaining movement budget.
    // ADR-4: After pickup, continue moving on current route — never reorder.
    //
    // Loop terminates when:
    //   - Movement budget is exhausted (budget == 0)
    //   - All stops are complete (stop index >= stops.length)
    //   - Next stop city is not on the network (need to build — break to Phase B)
    //   - A route was abandoned (action failed)

    let loopIter = 0;
    const MAX_LOOP_ITERS = 20; // safety cap against infinite loops

    while (
      remainingBudget > 0 &&
      activeRoute.currentStopIndex < activeRoute.stops.length &&
      loopIter < MAX_LOOP_ITERS
    ) {
      loopIter++;
      trace.a2.iterations = loopIter;

      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      const targetCity = currentStop.city;

      // ── Already at the stop city? Execute the action ─────────────────────
      if (TurnExecutorPlanner.isBotAtCity(context, targetCity)) {
        console.log(`${tag} At ${targetCity}, executing ${currentStop.action}`);

        const actionResult = await TurnExecutorPlanner.executeStopAction(
          currentStop,
          snapshot,
          context,
          tag,
        );

        if (!actionResult.success) {
          // Action failed — abandon route
          console.warn(`${tag} ${currentStop.action} failed at ${targetCity}: ${actionResult.error}. Abandoning route.`);
          trace.a2.terminationReason = 'action_failed';
          if (plans.length === 0) plans.push({ type: AIActionType.PassTurn });
          trace.outputPlan = plans.map(p => p.type);
          return {
            plans,
            updatedRoute: activeRoute,
            compositionTrace: trace,
            routeComplete: false,
            routeAbandoned: true,
            hasDelivery,
          };
        }

        plans.push(actionResult.plan!);

        if (currentStop.action === 'pickup') {
          trace.pickups.push({ load: currentStop.loadType, city: targetCity });
          console.log(`${tag} Picked up ${currentStop.loadType} at ${targetCity}. Advancing stop index (no reorder — ADR-4).`);

          // Advance stop index — no reorder after pickup (ADR-4)
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };

          // Skip any newly-completed stops
          activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
        } else {
          // Delivery
          hasDelivery = true;
          trace.deliveries.push({ load: currentStop.loadType, city: targetCity });
          console.log(`${tag} Delivered ${currentStop.loadType} at ${targetCity}. Triggering post-delivery replan.`);

          // Advance stop index
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };

          // Post-delivery replan (ADR-3):
          // If brain is available, call TripPlanner.planTrip() to get a fresh route.
          // Then enrich via RouteEnrichmentAdvisor (stub in Project 1 — returns unchanged).
          // Continue moving on the NEW route with remaining budget.
          if (brain && gridPoints && gridPoints.length > 0) {
            try {
              const memory = getMemory(snapshot.gameId, snapshot.bot.playerId);
              const tripPlanner = new TripPlanner(brain);
              const replanResult = await tripPlanner.planTrip(snapshot, context, gridPoints, memory);

              if (replanResult.route) {
                const enrichedRoute = RouteEnrichmentAdvisor.enrich(replanResult.route);
                activeRoute = TurnExecutorPlanner.skipCompletedStops(enrichedRoute, context);
                console.log(
                  `${tag} Post-delivery replan succeeded. New route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
                );
              } else {
                // TripPlanner returned null route — fall back to revalidating existing route
                console.warn(`${tag} Post-delivery TripPlanner returned null route. Continuing on existing route.`);
                activeRoute = PlanExecutor.revalidateRemainingDeliveries(activeRoute, context);
                activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
              }
            } catch (err) {
              console.warn(`${tag} Post-delivery replan failed (${(err as Error).message}). Continuing on existing route.`);
              activeRoute = PlanExecutor.revalidateRemainingDeliveries(activeRoute, context);
              activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
            }
          } else {
            // No brain available — revalidate existing route and continue
            activeRoute = PlanExecutor.revalidateRemainingDeliveries(activeRoute, context);
            activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
          }
        }

        // Continue loop — bot may be able to do more actions this turn
        continue;
      }

      // ── Stop city on network but bot is not there? → MOVE ────────────────
      if (context.citiesOnNetwork.includes(targetCity)) {
        console.log(`${tag} ${targetCity} is on network, moving (budget=${remainingBudget})`);

        const moveResult = await ActionResolver.resolveMove(
          { to: targetCity },
          snapshot,
          remainingBudget,
        );

        if (!moveResult.success || !moveResult.plan) {
          // Cannot reach via existing track — fall through to Phase B
          console.warn(`${tag} MOVE to ${targetCity} failed: ${moveResult.error}. Breaking to Phase B.`);
          trace.a2.terminationReason = 'move_failed_fallthrough_build';
          break;
        }

        plans.push(moveResult.plan);

        // Compute how many effective mileposts the move consumed
        const movePlan = moveResult.plan as TurnPlanMoveTrain;
        const majorCityLookup = getMajorCityLookup();
        const milesConsumed = computeEffectivePathLength(movePlan.path, majorCityLookup);
        remainingBudget = Math.max(0, remainingBudget - milesConsumed);
        trace.moveBudget.used = context.speed - remainingBudget;

        // Budget exhausted or bot did not reach destination (partial move) — stop loop
        if (remainingBudget === 0) {
          trace.a2.terminationReason = 'budget_exhausted';
          break;
        }

        // If the path ended at the target city (reached it), the next loop iteration
        // will detect isBotAtCity and execute the action.
        // However, context.position is read-only here (it reflects start-of-turn state).
        // We cannot update context mid-loop, so after a MOVE we break — the next
        // turn will pick up where we left off.
        // NOTE: In a future iteration when context is mutable mid-turn, this can be
        // replaced with a continue to execute the action in the same turn.
        trace.a2.terminationReason = 'moved_toward_stop';
        break;
      }

      // ── Stop city not on network → break to Phase B (build) ──────────────
      console.log(`${tag} ${targetCity} not on network. Breaking to Phase B (build).`);
      trace.a2.terminationReason = 'stop_city_not_on_network';
      break;
    }

    if (loopIter >= MAX_LOOP_ITERS) {
      console.warn(`${tag} Movement loop hit MAX_LOOP_ITERS (${MAX_LOOP_ITERS}) — safety break`);
      trace.a2.terminationReason = 'max_iterations';
    }

    // ── Route complete check (post-loop) ────────────────────────────────────
    if (activeRoute.currentStopIndex >= activeRoute.stops.length) {
      console.log(`${tag} Route complete after movement loop`);
      trace.a2.terminationReason = 'route_complete';
      if (plans.length > 0) {
        // Already have plans — emit them plus routeComplete flag
        trace.outputPlan = plans.map(p => p.type);
        return {
          plans,
          updatedRoute: activeRoute,
          compositionTrace: trace,
          routeComplete: true,
          routeAbandoned: false,
          hasDelivery,
        };
      }
      return TurnExecutorPlanner.routeComplete(activeRoute, trace);
    }

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

    // If no movement plans were produced, emit PassTurn
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

  // ── Cargo evaluation ──────────────────────────────────────────────────

  /**
   * Evaluate which cargo the bot should drop to free capacity for a desired pickup.
   *
   * Scoring formula (per audit finding #7):
   *   - No demand card for this load → Infinity (worst; drop immediately)
   *   - Delivery on network → 0 (best; keep)
   *   - Otherwise → estimatedTrackCostToDelivery - payout (higher = worse deal)
   *
   * Returns the worst-scored load (highest score) — the one to drop.
   * Returns null if bot carries no loads.
   *
   * Migrated from PlanExecutor.evaluateCargoForDrop() (JIRA-156 BE-008).
   */
  static evaluateCargoForDrop(
    snapshot: WorldSnapshot,
    context: GameContext,
  ): { loadType: string; score: number } | null {
    if (snapshot.bot.loads.length === 0) return null;

    const scored = snapshot.bot.loads.map(loadType => {
      const matchingDemands = context.demands.filter(d => d.loadType === loadType);
      if (matchingDemands.length === 0) {
        // No demand card for this load — worst possible score
        return { loadType, score: Infinity };
      }

      // Find the best (most feasible) delivery option for this load
      const bestScore = Math.min(
        ...matchingDemands.map(d => {
          if (d.isDeliveryOnNetwork) return 0;
          // Score = build cost - payout (higher = worse deal)
          return d.estimatedTrackCostToDelivery - d.payout;
        }),
      );

      return { loadType, score: bestScore };
    });

    // Sort worst-first (highest score) — return the one to drop
    scored.sort((a, b) => b.score - a.score);
    return scored[0] ?? null;
  }

  // ── Movement helpers ──────────────────────────────────────────────────

  /**
   * Check if the bot is currently located at the named city.
   * Uses `context.position.city` which is set by ContextBuilder from the snapshot.
   */
  static isBotAtCity(context: GameContext, cityName: string): boolean {
    if (!context.position) return false;
    return context.position.city === cityName;
  }

  /**
   * Execute a single route stop action (pickup or deliver) via ActionResolver.
   *
   * For pickups: if the train is full, attempts a drop-and-continue recovery:
   *   evaluateCargoForDrop() identifies the worst load to drop, then returns
   *   a DropLoad plan so the movement loop can emit it and retry the pickup
   *   next loop iteration.
   *
   * Returns the resolved action result.
   */
  private static async executeStopAction(
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<{ success: boolean; plan?: TurnPlan; error?: string }> {
    if (stop.action === 'pickup') {
      const result = await ActionResolver.resolve(
        { action: 'PICKUP', details: { load: stop.loadType, at: stop.city }, reasoning: '', planHorizon: '' },
        snapshot,
        context,
      );

      // Full-capacity recovery: if pickup failed due to full train, drop worst load
      if (!result.success && result.error && result.error.includes('full')) {
        const dropCandidate = TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context);
        if (dropCandidate && context.position) {
          const cityName = context.position.city;
          if (cityName) {
            console.warn(
              `${tag} Pickup failed (full capacity). Dropping worst load "${dropCandidate.loadType}" ` +
              `(score: ${dropCandidate.score}) at ${cityName} to recover.`,
            );
            return {
              success: true,
              plan: {
                type: AIActionType.DropLoad,
                load: dropCandidate.loadType,
                city: cityName,
              },
            };
          }
        }
      }

      return result;
    }

    if (stop.action === 'deliver') {
      const result = await ActionResolver.resolve(
        { action: 'DELIVER', details: { load: stop.loadType, at: stop.city }, reasoning: '', planHorizon: '' },
        snapshot,
        context,
      );
      return result;
    }

    return { success: false, error: `${tag} Unknown stop action: ${stop.action}` };
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
