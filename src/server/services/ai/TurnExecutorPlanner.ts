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
  TurnPlanDropLoad,
  TurnPlanMoveTrain,
  TurnPlanDeliverLoad,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  AIActionType,
  GridPoint,
  RouteStop,
  TrainType,
  TerrainType,
  TRAIN_PROPERTIES,
  LlmAttempt,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { isStopComplete, resolveBuildTarget, getNetworkFrontier, applyStopEffectToLocalState } from './routeHelpers';
import { computeBuildSegments } from './computeBuildSegments';
import { loadGridPoints, makeKey, getHexNeighbors, hexDistance } from './MapTopology';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { ActionResolver } from './ActionResolver';
import { AdvisorCoordinator } from './AdvisorCoordinator';
import { TripPlanner } from './TripPlanner';
import { getMemory } from './BotMemory';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { computeTrackUsageFees } from '../../../shared/services/computeTrackUsageFees';
import { buildUnionTrackGraph } from '../../../shared/services/trackUsageFees';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { TurnExecutor } from './TurnExecutor';
import { MovementPhasePlanner } from './MovementPhasePlanner';
import { BuildPhasePlanner } from './BuildPhasePlanner';

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
  a3: { movePreprended: boolean; skipped?: boolean; reason?: string; terminationReason?: string };
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
  /** JIRA-179: Build Route Resolver candidate comparison — only present when ENABLE_BUILD_RESOLVER=true */
  buildResolver?: {
    enabled: true;
    targetCity: string;
    budget: number;
    candidates: Array<{
      id: string;
      cost: number;
      segmentCount: number;
      reachesTarget: boolean;
      endpointDistance: number;
      anchorsHit: string[];
      segmentCompact: Array<[number, number, number, number]>;
    }>;
    selected: string;
    ruleBranch: string;
    reasonText: string;
    costDelta: number;
    anchorClassification: Array<{ coord: [number, number]; namedCity: string | null; kept: boolean }>;
  };
}

// ── CappedCityError ────────────────────────────────────────────────────────

/**
 * JIRA-187: Error enum for the 2a/2b/2c capped-city decision tree.
 */
export enum CappedCityError {
  NoViablePath = 'NO_VIABLE_PATH',
  FeesTooHigh = 'FEES_TOO_HIGH',
  NoOpponentStub = 'NO_OPPONENT_STUB',
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
  /** Post-delivery replan LLM log (populated when TripPlanner is called after a delivery) */
  replanLlmLog?: LlmAttempt[];
  /** Post-delivery replan system prompt */
  replanSystemPrompt?: string;
  /** Post-delivery replan user prompt */
  replanUserPrompt?: string;
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
   *   - Delivery stop: deliver load, advance stop index, replan via TripPlanner,
   *     continue on NEW route with remaining budget
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
    // ── Step 1: Initialise shared trace ──────────────────────────────────
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

    // ── Step 2: Phase A — Movement ────────────────────────────────────────
    const phaseAResult = await MovementPhasePlanner.run(
      route,
      snapshot,
      context,
      trace,
      brain,
      gridPoints,
    );

    // ── Step 3: Phase B — Build (consumes PhaseAResult) ───────────────────
    const phaseBResult = await BuildPhasePlanner.run(
      phaseAResult,
      snapshot,
      context,
      trace,
      brain,
      gridPoints,
    );

    // ── Step 4: Assemble TurnExecutorResult ───────────────────────────────
    // Ensure at least one plan is always returned (PassTurn for idle/complete turns)
    const finalPlans: TurnPlan[] = phaseBResult.plans.length > 0
      ? phaseBResult.plans
      : [{ type: AIActionType.PassTurn }];
    trace.outputPlan = finalPlans.map(p => p.type);
    return {
      plans: finalPlans,
      updatedRoute: phaseBResult.updatedRoute,
      compositionTrace: trace,
      routeComplete: phaseBResult.routeComplete,
      routeAbandoned: phaseBResult.routeAbandoned,
      hasDelivery: phaseBResult.hasDelivery,
      replanLlmLog: phaseBResult.replanLlmLog,
      replanSystemPrompt: phaseBResult.replanSystemPrompt,
      replanUserPrompt: phaseBResult.replanUserPrompt,
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
  static async executeBuildPhase(
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

    // ── AdvisorCoordinator.adviseBuild (LLM) with max 1 solvency retry (AC7) ─
    if (useAdvisor && brain != null && gridPoints != null) {
      const advisorBuildResult = await AdvisorCoordinator.adviseBuild(
        targetCity,
        remainingBudget,
        activeRoute,
        snapshot,
        context,
        brain,
        gridPoints,
        tag,
      );
      if (advisorBuildResult.plan) {
        trace.build.cost = advisorBuildResult.plan.type === AIActionType.BuildTrack
          ? advisorBuildResult.plan.segments.reduce((s, seg) => s + seg.cost, 0)
          : 0;
        // JIRA-179: propagate BuildRouteResolver log to composition trace
        if (advisorBuildResult.buildResolverLog) trace.buildResolver = advisorBuildResult.buildResolverLog as typeof trace.buildResolver;
        return advisorBuildResult.plan;
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
        // JIRA-179: propagate BuildRouteResolver log to composition trace
        if (heuristicResult.buildResolverLog) trace.buildResolver = heuristicResult.buildResolverLog;
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
  static async executeStopAction(
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

    if (stop.action === 'drop') {
      const result = await ActionResolver.resolve(
        { action: 'DROP', details: { load: stop.loadType, city: stop.city }, reasoning: '', planHorizon: '' },
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

          // Directional filter: only expand nodes that are closer to the
          // destination than the current node. This ensures we measure runway
          // toward the build target, not total network depth in all directions.
          const neighborDistToDest = hexDistance(neighbor.row, neighbor.col, destPosition.row, destPosition.col);
          const nodeDistToDest = hexDistance(node.row, node.col, destPosition.row, destPosition.col);
          if (neighborDistToDest >= nodeDistToDest) continue;

          const newDepth = node.depth + 1;
          if (newDepth > maxDepthOnNetwork) maxDepthOnNetwork = newDepth;
          nextFrontier.push({ row: neighbor.row, col: neighbor.col, depth: newDepth });
        }
      }
      frontier = nextFrontier;
    }

    return maxDepthOnNetwork / trainSpeed;
  }

  // ── JIRA-187: Capped-city helpers ─────────────────────────────────────

  /**
   * JIRA-187: Check whether a delivery city is capacity-capped by opponents
   * and the bot has no track into that city.
   *
   * Stateless — re-evaluated fresh each turn. No logging on false evaluations
   * (anti-patterns-logging-noise compliance).
   *
   * @param snapshot  Current world snapshot.
   * @param deliveryCity  Name of the delivery city to check.
   * @returns true when the city is capacity-capped and bot cannot build in.
   */
  static isCappedCityBlocked(snapshot: WorldSnapshot, deliveryCity: string): boolean {
    try {
      const SMALL_CITY_CAP = 2;
      const MEDIUM_CITY_CAP = 3;

      const grid = loadGridPoints();
      const cityGridPoints: Array<{ row: number; col: number; terrain: TerrainType; name?: string }> = [];
      for (const [, gp] of grid) {
        if (gp.name === deliveryCity) {
          cityGridPoints.push(gp);
        }
      }

      if (cityGridPoints.length === 0) return false;

      const cityTerrain = cityGridPoints[0].terrain;
      const cap =
        cityTerrain === TerrainType.SmallCity
          ? SMALL_CITY_CAP
          : cityTerrain === TerrainType.MediumCity
            ? MEDIUM_CITY_CAP
            : 0;

      if (cap === 0) return false;

      const cityCoordSet = new Set<string>(
        cityGridPoints.map(gp => makeKey(gp.row, gp.col)),
      );

      const botPlayerId = snapshot.bot.playerId;
      const opponentIdsWithTrack = new Set<string>();
      let botHasTrack = false;

      for (const playerTrack of snapshot.allPlayerTracks) {
        const pid = playerTrack.playerId;
        for (const seg of playerTrack.segments || []) {
          const fromKey = makeKey(seg.from.row, seg.from.col);
          const toKey = makeKey(seg.to.row, seg.to.col);
          if (cityCoordSet.has(fromKey) || cityCoordSet.has(toKey)) {
            if (pid === botPlayerId) {
              botHasTrack = true;
            } else {
              opponentIdsWithTrack.add(pid);
            }
          }
        }
      }

      if (botHasTrack) return false;
      if (opponentIdsWithTrack.size < cap) return false;

      // City is capped — log info
      console.info(JSON.stringify({
        event: 'capped_city_detected',
        deliveryCity,
        botPlayerId,
        opponentCount: opponentIdsWithTrack.size,
      }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * JIRA-187: 2a/2b/2c Selector decision tree for a capped-city delivery.
   *
   * 2a: If opponent stub exists and incomeVelocity = (payout - fees) / T >= 3,
   *     generate MoveTrain plan along opponent's stub, then Deliver.
   * 2b: If 2a not viable, find nearest own-network city in direction of capped city,
   *     generate DropLoad + DiscardHand (demand discard via PassTurn fallback).
   * 2c: Neither option viable — return { handled: false, error: CappedCityError }.
   *
   * @returns { handled: true; plans: TurnPlan[]; routeAbandoned?: boolean } on 2a/2b
   *          { handled: false; error: CappedCityError } on 2c
   */
  static resolveCappedCityDelivery(
    snapshot: WorldSnapshot,
    activeRoute: StrategicRoute,
    context: GameContext,
    pendingStop: RouteStop,
    tag: string,
  ): { handled: true; plans: TurnPlan[]; routeAbandoned?: boolean } | { handled: false; error: CappedCityError } {
    const deliveryCity = pendingStop.city;
    const payout = pendingStop.payment ?? 0;
    const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;

    // ── 2a: Check track-usage fee path ───────────────────────────────────
    try {
      // Build union graph to find opponent stub
      const allTracks = snapshot.allPlayerTracks.map(pt => ({
        playerId: pt.playerId,
        gameId: '',
        segments: pt.segments,
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(0),
      }));

      const { adjacency, edgeOwners } = buildUnionTrackGraph({ allTracks });

      // Bot's network frontier nodes
      const botPlayerId = snapshot.bot.playerId;
      const botNetworkNodes = new Set<string>();
      const botTrackEntry = snapshot.allPlayerTracks.find(pt => pt.playerId === botPlayerId);
      if (botTrackEntry) {
        for (const seg of botTrackEntry.segments || []) {
          botNetworkNodes.add(makeKey(seg.from.row, seg.from.col));
          botNetworkNodes.add(makeKey(seg.to.row, seg.to.col));
        }
      }
      if (snapshot.bot.position) {
        botNetworkNodes.add(makeKey(snapshot.bot.position.row, snapshot.bot.position.col));
      }

      // Find delivery city coordinates
      const grid = loadGridPoints();
      const cityCoordSet = new Set<string>();
      for (const [, gp] of grid) {
        if (gp.name === deliveryCity) {
          cityCoordSet.add(makeKey(gp.row, gp.col));
        }
      }

      // BFS from bot network to delivery city
      let bestPath: string[] | null = null;
      let bestLen = Infinity;

      for (const startKey of botNetworkNodes) {
        if (!adjacency.has(startKey)) continue;
        if (cityCoordSet.has(startKey)) {
          bestPath = [startKey];
          bestLen = 1;
          break;
        }
        const path = cappedCityBfs(adjacency, startKey, cityCoordSet);
        if (path && path.length < bestLen) {
          bestPath = path;
          bestLen = path.length;
        }
      }

      if (bestPath && bestPath.length > 1) {
        // Count opponent-owned edges in path
        let opponentEdges = 0;
        for (let i = 0; i < bestPath.length - 1; i++) {
          const aKey = bestPath[i];
          const bKey = bestPath[i + 1];
          const [aRow, aCol] = aKey.split(',').map(Number);
          const [bRow, bCol] = bKey.split(',').map(Number);
          const eKey = cappedCityEdgeKey(aRow, aCol, bRow, bCol);
          const owners = edgeOwners.get(eKey);
          if (owners && owners.size > 0 && !owners.has(botPlayerId)) {
            opponentEdges++;
          }
        }

        const turnsOnOpponent = Math.ceil(opponentEdges / trainSpeed);
        const fees = turnsOnOpponent * 4;

        // Check if round-trip fits in movement budget
        const totalPathEdges = bestPath.length - 1;
        const roundTripEdges = totalPathEdges * 2;
        const canRoundTrip = roundTripEdges <= trainSpeed;

        // Compute income velocity
        const netProfit = payout - fees;
        const estimatedTurns = Math.max(turnsOnOpponent, 1);
        const incomeVelocity = netProfit / estimatedTurns;

        if (incomeVelocity >= 3 && fees <= payout) {
          // 2a: Build MoveTrain plan using opponent stub path
          const pathCoords: Array<{ row: number; col: number }> = bestPath.map(key => {
            const [row, col] = key.split(',').map(Number);
            return { row, col };
          });

          const movePlan: TurnPlan = {
            type: AIActionType.MoveTrain,
            path: pathCoords,
          } as TurnPlan;

          const plans: TurnPlan[] = [movePlan];

          // Insert DeliverLoad step at the delivery city
          // Look up cardId and payout from context.demands matching loadType + deliveryCity,
          // then fall back to pendingStop fields if not found in context.
          const matchingDemand = context.demands.find(
            d => d.loadType === pendingStop.loadType && d.deliveryCity === deliveryCity,
          );
          const cardId = matchingDemand?.cardIndex ?? pendingStop.demandCardId;
          const deliverPayout = matchingDemand?.payout ?? payout;

          if (cardId != null) {
            const deliverStep: TurnPlanDeliverLoad = {
              type: AIActionType.DeliverLoad,
              load: pendingStop.loadType,
              city: deliveryCity,
              cardId,
              payout: deliverPayout,
            };
            plans.push(deliverStep);
          } else {
            console.warn(
              `[TurnExecutorPlanner] JIRA-187 2a: no matching demand found for ` +
              `${pendingStop.loadType}→${deliveryCity} — skipping DeliverLoad step`,
            );
          }

          // If round-trip fits, add a return move back to own network
          if (canRoundTrip && bestPath.length > 1) {
            const returnPath = [...bestPath].reverse().map(key => {
              const [row, col] = key.split(',').map(Number);
              return { row, col };
            });
            plans.push({
              type: AIActionType.MoveTrain,
              path: returnPath,
            } as TurnPlan);
          }

          console.info(JSON.stringify({
            event: 'capped_city_resolution',
            branch: '2a',
            deliveryCity,
            fees,
            incomeVelocity,
          }));

          return { handled: true, plans };
        } else if (fees > 0) {
          // Would have to pay fees but they're too high
          // Fall through to 2b
          console.info(JSON.stringify({
            event: 'capped_city_fees_too_high',
            deliveryCity,
            fees,
            payout,
            incomeVelocity,
          }));
        }
      } else {
        // No opponent stub found — fall through to 2b
        console.info(JSON.stringify({
          event: 'capped_city_no_stub',
          deliveryCity,
        }));
      }
    } catch (err) {
      console.warn(`${tag} [JIRA-187] 2a check failed:`, err);
    }

    // ── 2b: Drop at nearest own-network city ─────────────────────────────
    try {
      const nearestNetworkCity = TurnExecutorPlanner.findNearestOwnNetworkCity(
        snapshot,
        deliveryCity,
        context,
      );

      if (nearestNetworkCity) {
        const dropPlan: TurnPlanDropLoad = {
          type: AIActionType.DropLoad,
          city: nearestNetworkCity,
          load: pendingStop.loadType,
        };

        console.info(JSON.stringify({
          event: 'capped_city_resolution',
          branch: '2b',
          deliveryCity,
          dropCity: nearestNetworkCity,
          fees: 0,
          incomeVelocity: 0,
        }));

        return {
          handled: true,
          plans: [dropPlan, { type: AIActionType.PassTurn }],
          routeAbandoned: true,
        };
      }
    } catch (err) {
      console.warn(`${tag} [JIRA-187] 2b check failed:`, err);
    }

    // ── 2c: Abandon route ────────────────────────────────────────────────
    console.warn(JSON.stringify({
      event: 'route_abandoned_capped_city',
      deliveryCity,
      reason: CappedCityError.NoViablePath,
    }));

    console.info(JSON.stringify({
      event: 'capped_city_resolution',
      branch: '2c',
      deliveryCity,
      fees: 0,
      incomeVelocity: 0,
    }));

    return { handled: false, error: CappedCityError.NoViablePath };
  }

  /**
   * JIRA-187: Find the nearest city on the bot's own network that lies
   * in the direction of the capped delivery city.
   */
  private static findNearestOwnNetworkCity(
    snapshot: WorldSnapshot,
    deliveryCity: string,
    context: GameContext,
  ): string | null {
    const grid = loadGridPoints();

    // Find delivery city coordinates
    let deliveryCityPos: { row: number; col: number } | null = null;
    for (const [, gp] of grid) {
      if (gp.name === deliveryCity) {
        deliveryCityPos = { row: gp.row, col: gp.col };
        break;
      }
    }

    if (!deliveryCityPos) return null;

    // Among cities on the bot's own network, find the closest to delivery city
    let bestCity: string | null = null;
    let bestDist = Infinity;

    for (const cityName of context.citiesOnNetwork) {
      let cityPos: { row: number; col: number } | null = null;
      for (const [, gp] of grid) {
        if (gp.name === cityName) {
          cityPos = { row: gp.row, col: gp.col };
          break;
        }
      }
      if (!cityPos) continue;

      const dist = hexDistance(cityPos.row, cityPos.col, deliveryCityPos.row, deliveryCityPos.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestCity = cityName;
      }
    }

    return bestCity;
  }

}

// ── Module-level helpers for JIRA-187 capped-city path-finding ──────────────

/**
 * BFS from startKey to any node in goalKeys over the union track graph.
 * Returns the path (inclusive of start and first goal hit), or null.
 */
function cappedCityBfs(
  adjacency: Map<string, Set<string>>,
  startKey: string,
  goalKeys: Set<string>,
): string[] | null {
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [startKey];
  visited.add(startKey);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (goalKeys.has(cur)) {
      const path: string[] = [cur];
      let step = cur;
      while (parent.has(step)) {
        step = parent.get(step)!;
        path.unshift(step);
      }
      return path;
    }
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Normalize edge key to match trackUsageFees.ts format. */
function cappedCityEdgeKey(aRow: number, aCol: number, bRow: number, bCol: number): string {
  const aKey = `${aRow},${aCol}`;
  const bKey = `${bRow},${bCol}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}
