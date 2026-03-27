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
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../shared/types/GameTypes';
import { isStopComplete, resolveBuildTarget, getNetworkFrontier } from './routeHelpers';
import { loadGridPoints, makeKey, getHexNeighbors, hexDistance } from './MapTopology';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { ActionResolver } from './ActionResolver';
import { BuildAdvisor } from './BuildAdvisor';
import { TripPlanner } from './TripPlanner';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { getMemory } from './BotMemory';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';

// ── CompositionTrace ────────────────────────────────────────────────────────

/**
 * Structured trace of what happened during turn planning.
 * Moved here from TurnComposer.ts as part of the JIRA-156 cleanup.
 */
export interface CompositionTrace {
  /** Action types in the primary plan before composition */
  inputPlan: string[];
  /** Action types in the final composed plan */
  outputPlan: string[];
  /** Movement budget: total available, used, wasted */
  moveBudget: { total: number; used: number; wasted: number };
  /** A1: How many intermediate cities had opportunities, how many were accepted */
  a1: { citiesScanned: number; opportunitiesFound: number };
  /** A2: Continuation chaining iterations and termination reason */
  a2: { iterations: number; terminationReason: string };
  /** A3: Whether a MOVE was prepended before BUILD, or skipped with reason */
  a3: { movePreprended: boolean; skipped?: boolean; reason?: string };
  /** Phase B: Build/upgrade target and cost, or why skipped */
  build: { target: string | null; cost: number; skipped: boolean; upgradeConsidered: boolean };
  /** Pickups added during composition */
  pickups: Array<{ load: string; city: string }>;
  /** Deliveries added during composition */
  deliveries: Array<{ load: string; city: string }>;
  /** JIRA-122: JIT build gate decision */
  jitGate?: { deferred: boolean; reason: string; trackRunway: number; intermediateStopTurns: number; effectiveRunway: number; trainSpeed: number; destinationCity: string; currentStopIndex?: number; buildTargetStopIndex?: number; currentStopCity?: string };
  /** JIRA-122: Ferry-aware BFS search result */
  ferryAwareBFS?: { searched: boolean; ferryHopsUsed: number; nearestPointViaFerry: { row: number; col: number; distance: number; ferryCrossings: number } | null };
  /** JIRA-125: Victory build decision */
  victoryBuild?: { target: string | null; cost: number; triggered: boolean; overrodeRoute: boolean };
  /** JIRA-129: Build Advisor decision */
  advisor?: { action: string | null; reasoning: string | null; waypoints: [number, number][]; solvencyRetries: number; latencyMs: number; fallback: boolean; rawResponse?: string; rawWaypoints?: [number, number][]; systemPrompt?: string; userPrompt?: string; error?: string };
}

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
    // Track the last move target city for AC13(b) build direction check
    let lastMoveTargetCity: string | null = null;

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

          // Capture stops before advancing (for AC13(c) mutation check)
          const stopsBeforePickup = activeRoute.stops;

          // Advance stop index — no reorder after pickup (ADR-4)
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };

          // Skip any newly-completed stops
          activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);

          // AC13(c): Verify stops array was NOT mutated by the pickup or skipCompletedStops
          TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(
            stopsBeforePickup,
            activeRoute.stops,
            `pickup(${currentStop.loadType}@${targetCity})`,
            tag,
          );
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
                activeRoute = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
                activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
              }
            } catch (err) {
              console.warn(`${tag} Post-delivery replan failed (${(err as Error).message}). Continuing on existing route.`);
              activeRoute = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
              activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
            }
          } else {
            // No brain available — revalidate existing route and continue
            activeRoute = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
            activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
          }
        }

        // Continue loop — bot may be able to do more actions this turn
        continue;
      }

      // ── Stop city on network but bot is not there? → MOVE ────────────────
      if (context.citiesOnNetwork.includes(targetCity)) {
        lastMoveTargetCity = targetCity; // Track for AC13(b) build direction check
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

      // ── Stop city not on network → A3 frontier approach, then Phase B ───
      //
      // A3: When the next route stop is off-network (needs building), the bot
      // should still use its remaining movement budget to advance toward the
      // construction frontier — the dead-end node on the existing track network
      // closest to the build target. This prevents wasting the movement budget
      // while waiting for Phase B to extend the track.
      //
      // If no frontier node can be found or the move fails, fall straight to Phase B.
      console.log(`${tag} ${targetCity} not on network. Attempting A3 frontier move before Phase B.`);
      trace.a2.terminationReason = 'stop_city_not_on_network';

      if (remainingBudget > 0) {
        // Get frontier nodes sorted by distance to the build target (targetCity)
        const frontierNodes = getNetworkFrontier(snapshot, undefined, targetCity);
        // Filter out the bot's current city (no need to "move" to where we already are)
        const currentCity = context.position?.city;
        const reachableFrontier = frontierNodes.filter(
          n => n.cityName && n.cityName !== currentCity,
        );

        let a3MoveSucceeded = false;
        for (const frontierNode of reachableFrontier) {
          if (!frontierNode.cityName) continue;

          const a3MoveResult = await ActionResolver.resolveMove(
            { to: frontierNode.cityName },
            snapshot,
            remainingBudget,
          );

          if (a3MoveResult.success && a3MoveResult.plan) {
            const a3MovePlan = a3MoveResult.plan as TurnPlanMoveTrain;
            const majorCityLookup = getMajorCityLookup();
            const a3Miles = computeEffectivePathLength(a3MovePlan.path, majorCityLookup);

            plans.push(a3MoveResult.plan);
            lastMoveTargetCity = frontierNode.cityName;
            remainingBudget = Math.max(0, remainingBudget - a3Miles);
            trace.moveBudget.used = context.speed - remainingBudget;
            trace.a3.movePreprended = true;
            console.log(
              `${tag} A3 frontier move: toward "${frontierNode.cityName}" ` +
              `(${a3Miles}mp consumed, remaining=${remainingBudget})`,
            );
            a3MoveSucceeded = true;
            break;
          }
        }

        if (!a3MoveSucceeded) {
          console.log(`${tag} A3 frontier move skipped — no reachable frontier node found`);
        }
      }

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

    // ── Phase B: Build ─────────────────────────────────────────────────────
    //
    // Resolution order:
    //   1. resolveBuildTarget() → null = skip build
    //   2. shouldDeferBuild() JIT gate → deferred = skip build
    //   3. BuildAdvisor.advise() if brain+gridPoints available (max 1 solvency retry)
    //   4. Heuristic fallback (merged near-miss + demand-based): build toward targetCity

    const buildTarget = resolveBuildTarget(activeRoute, context);
    if (!buildTarget) {
      trace.build.skipped = true;
      trace.build.target = null;
      console.log(`${tag} Phase B: no build target — skipping build`);
    } else {
      trace.build.target = buildTarget.targetCity;
      trace.build.skipped = false;
      console.log(
        `${tag} Phase B: build target "${buildTarget.targetCity}" (isVictoryBuild=${buildTarget.isVictoryBuild})`,
      );

      // AC13(b): Build direction must agree with move direction
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove(
        buildTarget.targetCity,
        lastMoveTargetCity,
        activeRoute,
        tag,
      );

      const buildPlan = await TurnExecutorPlanner.executeBuildPhase(
        buildTarget.targetCity,
        buildTarget.isVictoryBuild,
        buildTarget.stopIndex,
        activeRoute,
        snapshot,
        context,
        brain ?? null,
        gridPoints,
        trace,
        tag,
      );

      if (buildPlan) {
        plans.push(buildPlan);
      }
    }

    // If no movement or build plans were produced, emit PassTurn
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

  /**
   * Execute Phase B build logic for a resolved build target.
   *
   * AC7: Max 1 solvency retry (down from MAX_SOLVENCY_RETRIES=2 in TurnComposer).
   * Single heuristic fallback path (merged near-miss + demand-based).
   *
   * Flow:
   *   1. JIT gate (shouldDeferBuild) — skip if sufficient runway, unless victory build
   *   2. BuildAdvisor.advise() if brain+gridPoints available — call LLM for waypoints
   *      a. On build action success → return plan
   *      b. On failure → 1 solvency retry via retryWithSolvencyFeedback → try again
   *   3. Heuristic fallback (single code path) → ActionResolver BUILD toward targetCity
   */
  private static async executeBuildPhase(
    targetCity: string,
    isVictoryBuild: boolean,
    buildTargetStopIndex: number,
    activeRoute: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain | null,
    gridPoints: GridPoint[] | undefined,
    trace: CompositionTrace,
    tag: string,
  ): Promise<TurnPlan | null> {
    // Check build budget
    const remainingBudget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);
    if (remainingBudget <= 0) {
      console.log(`${tag} Phase B: no build budget (turnBuildCost=${context.turnBuildCost}, money=${snapshot.bot.money})`);
      return null;
    }

    // Victory builds skip the JIT gate (R7)
    const useAdvisor = !isVictoryBuild && brain != null && gridPoints != null && gridPoints.length > 0 && !context.isInitialBuild;

    // ── JIT gate (shouldDeferBuild) ──────────────────────────────────────
    if (useAdvisor) {
      const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
      const deferResult = TurnExecutorPlanner.shouldDeferBuild(
        snapshot,
        context,
        activeRoute,
        targetCity,
        trainSpeed,
        buildTargetStopIndex >= 0 ? buildTargetStopIndex : undefined,
      );
      console.log(
        `${tag} JIT gate: ${deferResult.deferred ? 'DEFERRED' : 'BUILD'} (reason=${deferResult.reason}, runway=${deferResult.effectiveRunway.toFixed(1)})`,
      );
      if (deferResult.deferred) {
        trace.build.skipped = true;
        return null;
      }
    }

    // ── BuildAdvisor (LLM) with max 1 solvency retry (AC7) ───────────────
    if (useAdvisor && brain != null && gridPoints != null) {
      try {
        const advisorResult = await BuildAdvisor.advise(
          snapshot,
          context,
          activeRoute,
          gridPoints,
          brain,
        );

        if (advisorResult && (advisorResult.action === 'build' || advisorResult.action === 'buildAlternative')) {
          const advisorTargetCity = advisorResult.target ?? targetCity;
          const waypoints: [number, number][] = advisorResult.waypoints ?? [];

          // Try building toward advisor target
          const details: Record<string, any> = { toward: advisorTargetCity };
          if (waypoints.length > 0) details.waypoints = waypoints;

          const buildResult = await ActionResolver.resolve(
            { action: 'BUILD', details, reasoning: advisorResult.reasoning ?? '', planHorizon: '' },
            snapshot,
            context,
            activeRoute.startingCity,
          );

          if (buildResult.success && buildResult.plan) {
            console.log(`${tag} BuildAdvisor succeeded: building toward "${advisorTargetCity}"`);
            trace.build.cost = buildResult.plan.type === AIActionType.BuildTrack
              ? buildResult.plan.segments.reduce((s, seg) => s + seg.cost, 0)
              : 0;
            return buildResult.plan;
          }

          // ── Solvency retry (max 1) — AC7 ─────────────────────────────
          console.warn(`${tag} BuildAdvisor build failed (${buildResult.error}), attempting 1 solvency retry`);
          const retryAdvisorResult = await BuildAdvisor.retryWithSolvencyFeedback(
            advisorResult,
            remainingBudget + 1, // Indicate overshoot — actual cost exceeded budget
            remainingBudget,
            snapshot,
            context,
            activeRoute,
            gridPoints,
            brain,
          );

          if (retryAdvisorResult && (retryAdvisorResult.action === 'build' || retryAdvisorResult.action === 'buildAlternative')) {
            const retryCity = retryAdvisorResult.target ?? targetCity;
            const retryWaypoints: [number, number][] = retryAdvisorResult.waypoints ?? [];
            const retryDetails: Record<string, any> = { toward: retryCity };
            if (retryWaypoints.length > 0) retryDetails.waypoints = retryWaypoints;

            const retryBuildResult = await ActionResolver.resolve(
              { action: 'BUILD', details: retryDetails, reasoning: retryAdvisorResult.reasoning ?? '', planHorizon: '' },
              snapshot,
              context,
              activeRoute.startingCity,
            );
            if (retryBuildResult.success && retryBuildResult.plan) {
              console.log(`${tag} BuildAdvisor solvency retry succeeded: building toward "${retryCity}"`);
              return retryBuildResult.plan;
            }
          }
        }
      } catch (err) {
        console.warn(`${tag} BuildAdvisor threw error: ${(err as Error).message}. Falling back to heuristic.`);
      }
    }

    // ── Heuristic fallback (merged near-miss + demand-based) ─────────────
    // Single code path: build toward resolveBuildTarget().targetCity (R7)
    console.log(`${tag} Heuristic fallback: building toward "${targetCity}"`);
    try {
      const heuristicResult = await ActionResolver.resolve(
        {
          action: 'BUILD',
          details: { toward: targetCity },
          reasoning: 'heuristic fallback',
          planHorizon: '',
        },
        snapshot,
        context,
        activeRoute.startingCity,
      );

      if (heuristicResult.success && heuristicResult.plan) {
        return heuristicResult.plan;
      }

      console.warn(`${tag} Heuristic build also failed: ${heuristicResult.error}`);
    } catch (err) {
      console.warn(`${tag} Heuristic build threw: ${(err as Error).message}`);
    }

    return null;
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

  /**
   * AC13(b): Build direction must agree with move direction.
   *
   * If the executor has emitted both a MoveTrain plan AND resolved a build target,
   * the build target must be the same as (or directly reachable from) the move
   * destination — not a city in a contradictory direction.
   *
   * Concretely: the build target city must be an unconnected stop in the active route.
   * If the bot is also moving toward a route stop city, the build target must be a
   * LATER stop than the move target (i.e., not "build south, move north").
   *
   * This assertion prevents the case where the bot plans to move toward city A
   * while simultaneously building track toward city B in the opposite direction.
   *
   * @param buildTargetCity - The city that Phase B will build toward.
   * @param moveTargetCity - The city that Phase A moved toward (or null if no move).
   * @param route - Active route at the time of assertion.
   * @param tag - Log prefix.
   */
  static assertBuildDirectionAgreesWithMove(
    buildTargetCity: string | null,
    moveTargetCity: string | null,
    route: StrategicRoute,
    tag: string,
  ): void {
    if (!buildTargetCity || !moveTargetCity) return; // Nothing to compare

    // Find positions of each city in the route stops
    const buildStopIndex = route.stops.findIndex(
      s => s.city.toLowerCase() === buildTargetCity.toLowerCase(),
    );
    const moveStopIndex = route.stops.findIndex(
      s => s.city.toLowerCase() === moveTargetCity.toLowerCase(),
    );

    // If either city is not in the route, we cannot determine direction — skip
    if (buildStopIndex < 0 || moveStopIndex < 0) return;

    // INVARIANT: build target must be at the same or LATER position in the route
    // than the move target. Moving toward stop N while building toward stop N-1 is
    // contradictory (bot is going the wrong direction).
    if (buildStopIndex < moveStopIndex) {
      throw new Error(
        `${tag} INVARIANT VIOLATION: build direction disagrees with move direction. ` +
          `Build target "${buildTargetCity}" is at route stop ${buildStopIndex} but ` +
          `move target "${moveTargetCity}" is at route stop ${moveStopIndex}. ` +
          `Bot cannot build backwards along the route.`,
      );
    }
  }

  /**
   * AC13(c): Route stops array must not be mutated outside of designated mutation points.
   *
   * Designated mutation points:
   *   1. After a delivery: TripPlanner replan replaces the entire route object
   *   2. At route creation: RouteEnrichmentAdvisor.enrich() may reorder stops
   *
   * After a pickup (ADR-4), the stops array must remain identical to the pre-pickup
   * array — only `currentStopIndex` may change.
   *
   * @param beforeStops - The stops array before the sanctioned operation.
   * @param afterStops - The stops array after the sanctioned operation.
   * @param operationTag - Human-readable name of the operation that ran.
   * @param tag - Log prefix.
   */
  static assertStopsNotMutatedAfterPickup(
    beforeStops: RouteStop[],
    afterStops: RouteStop[],
    operationTag: string,
    tag: string,
  ): void {
    if (beforeStops === afterStops) return; // Same reference — no mutation possible

    // Must have same length
    if (beforeStops.length !== afterStops.length) {
      throw new Error(
        `${tag} INVARIANT VIOLATION: route stops were mutated after ${operationTag}. ` +
          `Length changed from ${beforeStops.length} to ${afterStops.length}. ` +
          `Route stops may only be replaced after a delivery (via TripPlanner replan).`,
      );
    }

    // Must have same stop city+action at each index
    for (let i = 0; i < beforeStops.length; i++) {
      const before = beforeStops[i];
      const after = afterStops[i];
      if (before.city !== after.city || before.action !== after.action) {
        throw new Error(
          `${tag} INVARIANT VIOLATION: route stops were mutated after ${operationTag}. ` +
            `Stop ${i} changed from ${before.action}@${before.city} to ${after.action}@${after.city}. ` +
            `Route stops may only be replaced after a delivery (via TripPlanner replan).`,
        );
      }
    }
  }

  // ── Directional filtering ─────────────────────────────────────────────

  /**
   * Filter move-target candidates to only include cities that are closer to
   * (or equidistant from) the build target than the bot's current position.
   *
   * This prevents A3-style prepend moves from sending the bot in the wrong
   * direction (e.g., north when the build target is south).
   *
   * **Fix for R10 / AC12**: When `advisorBuildTargetCity` is null (BuildAdvisor
   * returned null), derives `buildTargetCity` from the route via
   * `resolveBuildTarget()` instead of falling back to the current stop city.
   * This ensures the directional gate still points toward the actual
   * build target even when the LLM advisor is unavailable.
   *
   * @param targets - Candidate move-target city names.
   * @param context - Current game context (used for bot position and resolveBuildTarget).
   * @param route - Active strategic route (used to derive build target when advisor is null).
   * @param advisorBuildTargetCity - The build target from the BuildAdvisor/BuildTrack plan,
   *   or null if the advisor returned null.
   * @returns Filtered candidate cities — only those in the correct direction.
   */
  static filterByDirection(
    targets: string[],
    context: GameContext,
    route: StrategicRoute,
    advisorBuildTargetCity: string | null,
  ): string[] {
    if (!context.position) return targets;

    // Derive build target city: prefer advisor result; fall back to resolveBuildTarget()
    // (R10 fix: when advisor is null, use route-based target, not the current stop city)
    const buildTargetCity: string | null =
      advisorBuildTargetCity ?? resolveBuildTarget(route, context)?.targetCity ?? null;

    if (!buildTargetCity) return targets;

    const grid = loadGridPoints();

    // Find build target coordinates
    let targetRow = -1, targetCol = -1;
    for (const [, gp] of grid) {
      if (gp.name && gp.name === buildTargetCity) {
        targetRow = gp.row;
        targetCol = gp.col;
        break;
      }
    }
    if (targetRow < 0) return targets; // Build target not on grid — no filtering possible

    const botDist =
      Math.abs(context.position.row - targetRow) +
      Math.abs(context.position.col - targetCol);

    return targets.filter(city => {
      for (const [, gp] of grid) {
        if (gp.name && gp.name === city) {
          const candidateDist =
            Math.abs(gp.row - targetRow) + Math.abs(gp.col - targetCol);
          return candidateDist <= botDist;
        }
      }
      return false; // City not found in grid — exclude
    });
  }

  // ── Route State Helpers (migrated from PlanExecutor) ──────────────────

  /**
   * JIRA-123: Revalidate remaining DELIVER stops after a delivery may have
   * consumed a shared demand card. Migrated from PlanExecutor.revalidateRemainingDeliveries().
   */
  static revalidateRemainingDeliveries(
    route: StrategicRoute,
    context: GameContext,
  ): StrategicRoute {
    const tag = '[TurnExecutorPlanner]';
    const demandCardIds = new Set(context.demands.map(d => d.cardIndex));

    const completedDeliveryCards = new Set<number>();
    for (let i = 0; i < route.currentStopIndex; i++) {
      const stop = route.stops[i];
      if (stop.action === 'deliver' && stop.demandCardId != null) {
        completedDeliveryCards.add(stop.demandCardId);
      }
    }

    const remainingStops = route.stops.slice(route.currentStopIndex);
    const invalidatedIndices: number[] = [];
    for (let i = 0; i < remainingStops.length; i++) {
      const stop = remainingStops[i];
      if (stop.action !== 'deliver' || stop.demandCardId == null) continue;

      const cardPresent = demandCardIds.has(stop.demandCardId);
      const loadOnTrain = context.loads.includes(stop.loadType);
      const cardConsumedByPriorDelivery = completedDeliveryCards.has(stop.demandCardId);

      if (!cardPresent && loadOnTrain && cardConsumedByPriorDelivery) {
        console.warn(
          `${tag} JIRA-123: deliver(${stop.loadType}@${stop.city}) invalid — ` +
          `demand card #${stop.demandCardId} consumed by prior delivery, ` +
          `but ${stop.loadType} still on train. Removing stop.`,
        );
        invalidatedIndices.push(route.currentStopIndex + i);
      }
    }

    if (invalidatedIndices.length === 0) return route;

    const invalidatedLoadTypes = new Set(
      invalidatedIndices.map(i => route.stops[i].loadType),
    );
    const keepSet = new Set<number>(route.stops.map((_, i) => i));
    for (const idx of invalidatedIndices) {
      keepSet.delete(idx);
    }
    for (let i = route.currentStopIndex; i < route.stops.length; i++) {
      const stop = route.stops[i];
      if (stop.action === 'pickup' && invalidatedLoadTypes.has(stop.loadType)) {
        keepSet.delete(i);
      }
    }

    const prunedStops = route.stops.filter((_, i) => keepSet.has(i));
    const hasDeliveryRemaining = prunedStops
      .slice(route.currentStopIndex)
      .some(s => s.action === 'deliver');

    if (!hasDeliveryRemaining) {
      console.warn(
        `${tag} JIRA-123: No valid DELIVER stops remain after revalidation — clearing route for re-plan.`,
      );
      return { ...route, stops: prunedStops, currentStopIndex: prunedStops.length };
    }

    return { ...route, stops: prunedStops };
  }

  /**
   * Find carried loads with no matching demand card (dead loads).
   * Migrated from PlanExecutor.findDeadLoads().
   */
  static findDeadLoads(
    carriedLoads: string[],
    resolvedDemands: Array<{ demands: Array<{ loadType: string }> }>,
  ): string[] {
    if (carriedLoads.length === 0) return [];
    return carriedLoads.filter(loadType => {
      const hasMatchingDemand = resolvedDemands.some(card =>
        card.demands.some(d => d.loadType === loadType),
      );
      return !hasMatchingDemand;
    });
  }

  // ── JIT Build Gate (migrated from TurnComposer) ────────────────────────

  /**
   * JIRA-122: Determine whether to defer building this turn.
   * Migrated from TurnComposer.shouldDeferBuild().
   */
  static shouldDeferBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute | null | undefined,
    buildTarget: string,
    trainSpeed: number,
    buildTargetStopIndex?: number,
  ): { deferred: boolean; reason: string; trackRunway: number; intermediateStopTurns: number; effectiveRunway: number } {
    if (context.isInitialBuild || context.turnNumber <= 2) {
      return { deferred: false, reason: 'initial_build_exempt', trackRunway: 0, intermediateStopTurns: 0, effectiveRunway: 0 };
    }

    if (snapshot.bot.money > 230) {
      const unconnected = context.unconnectedMajorCities ?? [];
      if (unconnected.some(c => c.cityName === buildTarget)) {
        return { deferred: false, reason: 'victory_build_exempt', trackRunway: 0, intermediateStopTurns: 0, effectiveRunway: 0 };
      }
    }

    if (!activeRoute) {
      return { deferred: true, reason: 'no_active_route', trackRunway: 0, intermediateStopTurns: 0, effectiveRunway: 0 };
    }

    const routeStops = activeRoute.stops.map(s => s.city.toLowerCase());
    if (!routeStops.includes(buildTarget.toLowerCase())) {
      return { deferred: true, reason: 'target_not_in_route', trackRunway: 0, intermediateStopTurns: 0, effectiveRunway: 0 };
    }

    if (activeRoute.phase !== 'build') {
      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      if (currentStop) {
        const isDeliveryCommitted = context.loads.includes(currentStop.loadType) ||
          activeRoute.phase === 'travel' || activeRoute.phase === 'act';
        if (!isDeliveryCommitted) {
          return { deferred: true, reason: 'not_committed_to_delivery', trackRunway: 0, intermediateStopTurns: 0, effectiveRunway: 0 };
        }
      }
    }

    const stopIndex = buildTargetStopIndex ?? activeRoute.currentStopIndex;
    const intermediateStopTurns = TurnExecutorPlanner.estimateIntermediateStopTurns(
      snapshot, context, activeRoute, stopIndex, trainSpeed,
    );
    const trackRunway = TurnExecutorPlanner.calculateTrackRunway(snapshot, buildTarget, trainSpeed, context);
    const effectiveRunway = intermediateStopTurns + trackRunway;
    if (effectiveRunway >= 2) {
      return { deferred: true, reason: 'sufficient_runway', trackRunway, intermediateStopTurns, effectiveRunway };
    }

    return { deferred: false, reason: 'build_needed', trackRunway, intermediateStopTurns, effectiveRunway };
  }

  /**
   * JIRA-154: Estimate intermediate stop travel time between current stop and build target.
   * Migrated from TurnComposer.estimateIntermediateStopTurns().
   */
  static estimateIntermediateStopTurns(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute,
    buildTargetStopIndex: number,
    trainSpeed: number,
  ): number {
    const currentStopIndex = activeRoute.currentStopIndex;
    if (buildTargetStopIndex <= currentStopIndex || trainSpeed <= 0) return 0;

    const gridPoints = loadGridPoints();
    const cityPositions = new Map<string, { row: number; col: number }>();
    for (const [, gp] of gridPoints) {
      if (gp.name) {
        cityPositions.set(gp.name.toLowerCase(), { row: gp.row, col: gp.col });
      }
    }

    let prevPos: { row: number; col: number } | null = snapshot.bot.position
      ? { row: snapshot.bot.position.row, col: snapshot.bot.position.col }
      : null;

    let totalTurns = 0;
    for (let i = currentStopIndex; i < buildTargetStopIndex; i++) {
      const stop = activeRoute.stops[i];
      if (!stop) continue;
      if (!context.citiesOnNetwork.includes(stop.city)) continue;

      const stopPos = cityPositions.get(stop.city.toLowerCase());
      if (!stopPos || !prevPos) {
        prevPos = stopPos ?? null;
        continue;
      }

      const distance = hexDistance(prevPos.row, prevPos.col, stopPos.row, stopPos.col);
      totalTurns += distance / trainSpeed;
      prevPos = stopPos;
    }

    return totalTurns;
  }

  /**
   * JIRA-122: Calculate track runway (turns of existing track toward destination).
   * Migrated from TurnComposer.calculateTrackRunway().
   */
  static calculateTrackRunway(
    snapshot: WorldSnapshot,
    destinationCity: string,
    trainSpeed: number,
    context: GameContext,
  ): number {
    if (!snapshot.bot.position || trainSpeed <= 0) return 0;

    if (context.citiesOnNetwork.includes(destinationCity)) {
      return 10;
    }

    const networkNodeKeys = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      networkNodeKeys.add(makeKey(seg.from.row, seg.from.col));
      networkNodeKeys.add(makeKey(seg.to.row, seg.to.col));
    }

    const gridPoints = loadGridPoints();
    let destPosition: { row: number; col: number } | null = null;
    for (const [, gp] of gridPoints) {
      if (gp.name && gp.name.toLowerCase() === destinationCity.toLowerCase()) {
        destPosition = { row: gp.row, col: gp.col };
        break;
      }
    }
    if (!destPosition) return 0;

    const botKey = makeKey(snapshot.bot.position.row, snapshot.bot.position.col);
    const visited = new Set<string>();
    visited.add(botKey);

    let frontier = [{ row: snapshot.bot.position.row, col: snapshot.bot.position.col, depth: 0 }];
    let maxDepthOnNetwork = 0;

    while (frontier.length > 0) {
      const nextFrontier: typeof frontier = [];
      for (const node of frontier) {
        const neighbors = getHexNeighbors(node.row, node.col);
        for (const neighbor of neighbors) {
          const key = makeKey(neighbor.row, neighbor.col);
          if (visited.has(key)) continue;
          visited.add(key);

          if (!networkNodeKeys.has(key)) continue;

          const hasSegment = snapshot.bot.existingSegments.some(seg =>
            (makeKey(seg.from.row, seg.from.col) === makeKey(node.row, node.col) && makeKey(seg.to.row, seg.to.col) === key) ||
            (makeKey(seg.to.row, seg.to.col) === makeKey(node.row, node.col) && makeKey(seg.from.row, seg.from.col) === key),
          );
          if (!hasSegment) continue;

          const newDepth = node.depth + 1;
          if (newDepth > maxDepthOnNetwork) maxDepthOnNetwork = newDepth;
          nextFrontier.push({ row: neighbor.row, col: neighbor.col, depth: newDepth });
        }
      }
      frontier = nextFrontier;
    }

    return maxDepthOnNetwork / trainSpeed;
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
