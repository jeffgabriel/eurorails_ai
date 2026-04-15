/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services in a 6-stage pipeline:
 *   1. WorldSnapshotService.capture()  — frozen game state
 *   2. ContextBuilder.build()          — decision-relevant context for LLM
 *   3. TripPlanner / PlanExecutor      — LLM route planning → TurnPlan
 *   4. GuardrailEnforcer.checkPlan()   — hard safety rules
 *   5. TurnExecutor.executePlan()      — execute against DB
 *
 * LLMStrategyBrain handles retry loop internally.
 * AIStrategyEngine just orchestrates the stages and manages memory/logging.
 */

import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { GuardrailEnforcer } from './GuardrailEnforcer';
import { TurnExecutor } from './TurnExecutor';
import { ActionResolver } from './ActionResolver';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import {
  WorldSnapshot,
  AIActionType,
  BotConfig,
  LLMProvider,
  BotSkillLevel,
  LLMDecisionResult,
  TurnPlan,
  StrategicRoute,
  RouteStop,
  DemandContext,
  GameContext,
  LlmAttempt,
  TimelineStep,
  TurnPlanDropLoad,
  TurnPlanDeliverLoad,
  TurnPlanUpgradeTrain,
  TRAIN_PROPERTIES,
  TrainType,
  InitialBuildPlan,
} from '../../../shared/types/GameTypes';
import { db } from '../../db/index';
import { getMajorCityGroups, getMajorCityLookup, computeEffectivePathLength } from '../../../shared/services/majorCityGroups';
import { gridToPixel, loadGridPoints as loadGridPointsMap } from './MapTopology';
import { RouteValidator } from './RouteValidator';
import { getMemory, updateMemory } from './BotMemory';
import { initTurnLog, logPhase, flushTurnLog, LLMPhaseFields } from './DecisionLogger';
import { TurnValidator } from './TurnValidator';
import { TripPlanner, TripPlanResult } from './TripPlanner';
import { InitialBuildPlanner } from './InitialBuildPlanner';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { MAX_RECOMPOSE_ATTEMPTS } from '../../../shared/constants/gameRules';

/**
 * Minimum number of completed deliveries before a bot may upgrade its train.
 * Prevents premature upgrades that leave the bot cash-poor and unable to build track.
 * Adjust this value to tune bot upgrade timing across all skill levels.
 */
export const MIN_DELIVERIES_BEFORE_UPGRADE = 4;

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
  // v6.3 fields
  reasoning?: string;
  planHorizon?: string;
  guardrailOverride?: boolean;
  guardrailReason?: string;
  // JIRA-13: demand ranking for debug overlay
  demandRanking?: Array<{ loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; score: number; rank: number; supplyRarity?: string; isStale?: boolean; efficiencyPerTurn?: number; estimatedTurns?: number; trackCostToSupply?: number; trackCostToDelivery?: number; ferryRequired?: boolean }>;
  // JIRA-32: Strategic context and composition trace for NDJSON game log
  gamePhase?: string;
  cash?: number;
  trainType?: string;
  compositionTrace?: CompositionTrace;
  // JIRA-19: LLM decision metadata
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  retried?: boolean;
  // FE-002: Dynamic upgrade advice for debug overlay
  upgradeAdvice?: string;
  // JIRA-161: Reason upgrade was suppressed (if applicable), for debug overlay visibility
  upgradeSuppressionReason?: string | null;
  // JIRA-31: LLM attempt log for debug overlay
  llmLog?: LlmAttempt[];
  // JIRA-36: Movement path for animated bot train movement
  movementPath?: { row: number; col: number }[];
  // Structured action timeline for animated partial turn movements
  actionTimeline?: TimelineStep[];
  // JIRA-89: Secondary delivery planning log
  secondaryDelivery?: {
    action: string;
    reasoning: string;
    pickupCity?: string;
    loadType?: string;
    deliveryCity?: string;
    deadLoadsDropped?: string[];
  };
  // Debug overlay: current active route snapshot (or null if cleared)
  activeRoute?: StrategicRoute | null;
  // Prompt text for NDJSON observability
  systemPrompt?: string;
  userPrompt?: string;
  // Enriched debugging fields
  positionStart?: { row: number; col: number; cityName?: string } | null;
  positionEnd?: { row: number; col: number; cityName?: string } | null;
  carriedLoads?: string[];
  connectedMajorCities?: string[];
  trainSpeed?: number;
  trainCapacity?: number;
  demandCards?: Array<{ loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number }>;
  // JIRA-126: Trip planning results
  tripPlanning?: {
    trigger: string;
    candidates: Array<{
      stops: string[];
      score: number;
      netValue: number;
      estimatedTurns: number;
      buildCostEstimate: number;
      usageFeeEstimate: number;
    }>;
    chosen: number;
    llmLatencyMs: number;
    llmTokens: { input: number; output: number };
    llmReasoning: string;
  };
  // JIRA-126: Turn validation results
  turnValidation?: {
    hardGates: Array<{ gate: string; passed: boolean; detail?: string }>;
    outcome: 'passed' | 'hard_reject';
    recomposeCount: number;
    firstViolation?: string;
  };
  // JIRA-129: Build Advisor fields
  advisorAction?: string;
  advisorWaypoints?: [number, number][];
  advisorReasoning?: string;
  advisorLatencyMs?: number;
  advisorSystemPrompt?: string;
  advisorUserPrompt?: string;
  solvencyRetries?: number;
  // JIRA-143: Actor/action metadata
  actor?: 'llm' | 'system' | 'heuristic' | 'guardrail' | 'error';
  actorDetail?: string;
  llmModel?: string;
  actionBreakdown?: Array<{ action: AIActionType; actor: 'llm' | 'system' | 'heuristic'; detail?: string }>;
  llmCallIds?: string[];
  llmSummary?: { callCount: number; totalLatencyMs: number; totalTokens: { input: number; output: number }; callers: string[] };
  originalPlan?: { action: string; reasoning: string };
  advisorUsedFallback?: boolean;
  // JIRA-148: Initial build planner evaluated options (only on initial build turns)
  initialBuildOptions?: InitialBuildPlan['evaluatedOptions'];
  // Double delivery pairings evaluated during initial build
  initialBuildPairings?: InitialBuildPlan['evaluatedPairings'];
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn via the 6-stage pipeline:
   *   1. WorldSnapshot.capture()
   *   2. ContextBuilder.build()
   *   3. TripPlanner / PlanExecutor (includes retry loop)
   *   4. GuardrailEnforcer.checkPlan()
   *   5. TurnExecutor.executePlan()
   *
   * Falls back to PassTurn on pipeline error.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();
    const tag = `[AIStrategy ${gameId.slice(0, 8)}]`;

    // Load bot memory for state continuity across turns
    const memory = await getMemory(gameId, botPlayerId);

    // Initialize decision logging for this turn
    initTurnLog(gameId, botPlayerId, memory.turnNumber + 1);

    try {
      // ── Stage 1: Capture world snapshot ──
      let snapshot = await capture(gameId, botPlayerId);
      console.log(`${tag} Snapshot: status=${snapshot.gameStatus}, money=${snapshot.bot.money}, segments=${snapshot.bot.existingSegments.length}, position=${snapshot.bot.position ? `${snapshot.bot.position.row},${snapshot.bot.position.col}` : 'none'}, loads=[${snapshot.bot.loads.join(',')}]`);

      // Auto-place bot if no position and has track (skip during initialBuild — no train placement yet)
      if (!snapshot.bot.position && snapshot.bot.existingSegments.length > 0 && snapshot.gameStatus !== 'initialBuild') {
        await AIStrategyEngine.autoPlaceBot(snapshot, memory.activeRoute);
        const placed = snapshot.bot.position as { row: number; col: number } | null;
        console.log(`${tag} Auto-placed bot at ${placed ? `${placed.row},${placed.col}` : 'failed'}`);
      }

      const botConfig = snapshot.bot.botConfig as BotConfig | null;
      const skillLevel = (botConfig?.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
      const gridPoints = snapshot.hexGrid ?? [];

      // Capture start position for NDJSON logging (before any movement)
      const positionStart = snapshot.bot.position
        ? {
          row: snapshot.bot.position.row,
          col: snapshot.bot.position.col,
          cityName: gridPoints.find(gp => gp.row === snapshot.bot.position!.row && gp.col === snapshot.bot.position!.col)?.city?.name,
        }
        : null;

      // ── Stage 2: Build game context ──
      let context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);

      // JIRA-60: Inject delivery count from memory for upgrade advice gating
      context.deliveryCount = memory.deliveryCount ?? 0;

      // JIRA-161: Recalculate upgradeAdvice now that deliveryCount is known.
      // ContextBuilder.build() computed advice without delivery count (no memory at that point).
      // This ensures advice is suppressed when the gate will block the upgrade anyway.
      context.upgradeAdvice = ContextBuilder.computeUpgradeAdvice(
        snapshot, context.demands, context.canBuild, context.deliveryCount,
      );

      // JIRA-87: Inject en-route pickup opportunities from active route
      if (memory.activeRoute?.stops) {
        context.enRoutePickups = ContextBuilder.computeEnRoutePickups(
          snapshot, memory.activeRoute.stops, gridPoints,
        );
      }

      // Inject previous turn summary from memory for LLM context continuity
      if (memory.lastReasoning || memory.lastPlanHorizon) {
        const parts: string[] = [];
        if (memory.lastAction) parts.push(`Action: ${memory.lastAction}`);
        if (memory.lastReasoning) parts.push(`Reasoning: ${memory.lastReasoning}`);
        if (memory.lastPlanHorizon) parts.push(`Plan: ${memory.lastPlanHorizon}`);
        context.previousTurnSummary = parts.join('. ');
      }

      console.log(`${tag} Context: canDeliver=${context.canDeliver.length}, canPickup=${context.canPickup.length}, canBuild=${context.canBuild}, canUpgrade=${context.canUpgrade}, reachable=${context.reachableCities.length} cities, onNetwork=${context.citiesOnNetwork.length} cities`);

      // INF-002: Zero-money gate — warn when bot has no funds
      AIStrategyEngine.zeroMoneyGate(tag, snapshot, context);

      if (context.phase) {
        const uc = context.unconnectedMajorCities ?? [];
        const ucStr = uc.length > 0 ? uc.map(u => `${u.cityName}~${u.estimatedCost}M`).join(', ') : 'none';
        console.log(`${tag} Victory: phase=${context.phase}, unconnected=${ucStr}`);
      }

      // ── Stage 3: Decision Gate — activeRoute check ──
      // If the bot has an active route, auto-execute the next step.
      // If not, consult LLM for a new strategic route.
      // JIRA-131: Always serialize context prompt for debug overlay observability
      const debugUserPrompt = ContextBuilder.serializePrompt(context, skillLevel);
      let decision: LLMDecisionResult;
      // JIRA-129: Create brain at outer scope so BuildAdvisor can use it during Phase B composition
      const brain = AIStrategyEngine.hasLLMApiKey(botConfig) ? AIStrategyEngine.createBrain(botConfig!) : null;
      // JIRA-143: Reset LLM call tracking at turn start
      if (brain) brain.providerAdapter.resetCallIds();
      let activeRoute = memory.activeRoute;

      let routeWasCompleted = false;
      let routeWasAbandoned = false;
      let hasDelivery = false; // set true by TurnExecutorPlanner when a delivery occurs
      let execCompositionTrace: CompositionTrace | null = null; // populated by TurnExecutorPlanner
      let previousRouteStops: RouteStop[] | null = null; // BE-010
      let secondaryDeliveryLog: { action: string; reasoning: string; pickupCity?: string; loadType?: string; deliveryCity?: string; deadLoadsDropped?: string[] } | undefined;
      const deadLoadDropActions: TurnPlanDropLoad[] = [];
      let pendingUpgradeAction: TurnPlanUpgradeTrain | null = null; // JIRA-105
      let upgradeSuppressionReason: string | null = null; // JIRA-161: tracks why an upgrade was blocked
      let initialBuildEvaluatedOptions: InitialBuildPlan['evaluatedOptions']; // JIRA-148
      let initialBuildEvaluatedPairings: InitialBuildPlan['evaluatedPairings'];
      // JIRA-170: Auto-delivered loads (before TripPlanner consultation) to include in turn result
      const autoDeliveredLoads: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];

      if (context.isInitialBuild && (!activeRoute || activeRoute.phase !== 'build')) {
        // ── JIRA-142b: Computed initial build — bypass LLM entirely ──
        // JIRA-167: Only plan on the FIRST initial-build turn. On subsequent turns,
        // activeRoute already has phase='build' from the prior turn, so we fall
        // through to the executor branch to continue building the existing plan.
        // Plan the route and produce a BuildTrack decision with targetCity.
        // Don't go through PlanExecutor.executeInitialBuild — its cold-start
        // segment computation fails. Instead, let TurnComposer Phase B
        // (BuildAdvisor) compute the actual segments.
        // JIRA-148: Pass pre-computed demand scores for corridor/victory-aware route selection
        const demandScores = new Map<string, number>();
        for (const d of context.demands) {
          demandScores.set(`${d.loadType}:${d.deliveryCity}`, d.demandScore);
        }
        const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints, demandScores);
        initialBuildEvaluatedOptions = buildPlan.evaluatedOptions;
        initialBuildEvaluatedPairings = buildPlan.evaluatedPairings;
        console.log(`${tag} Initial build: chose ${buildPlan.route.length > 2 ? 'double' : 'single'} delivery, startingCity=${buildPlan.startingCity}, payout=${buildPlan.totalPayout}M, buildCost=${buildPlan.totalBuildCost}M`);

        activeRoute = {
          stops: buildPlan.route,
          currentStopIndex: 0,
          phase: 'build',
          startingCity: buildPlan.startingCity,
          createdAtTurn: snapshot.turnNumber,
          reasoning: `[initial-build-planner] ${buildPlan.buildPriority}`,
        };

        // JIRA-145: Skip starting city — when first route stop is a pickup at the starting city,
        // we need to target the delivery destination, not build toward ourselves.
        const targetCity = buildPlan.route.find(
          s => s.city.toLowerCase() !== buildPlan.startingCity.toLowerCase(),
        )?.city ?? buildPlan.route[0]?.city ?? buildPlan.startingCity;
        const routeSummary = `Route: ${buildPlan.route.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;

        // Use TurnExecutorPlanner to compute Phase B (BuildAdvisor segments) for the initial build route.
        // All stops are off-network, so TurnExecutorPlanner will resolve build target and call BuildAdvisor.
        const initialExecResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);
        execCompositionTrace = initialExecResult.compositionTrace;
        const initialPlan = initialExecResult.plans.length === 0
          ? { type: AIActionType.BuildTrack as const, segments: [], targetCity }
          : initialExecResult.plans.length === 1
            ? initialExecResult.plans[0]
            : { type: 'MultiAction' as const, steps: initialExecResult.plans };

        decision = {
          plan: initialPlan,
          reasoning: `[initial-build-planner] ${buildPlan.buildPriority}`,
          planHorizon: routeSummary,
          model: 'initial-build-planner',
          latencyMs: 0,
          retried: false,
          userPrompt: `[Computed] Initial build: ${routeSummary}, startingCity=${buildPlan.startingCity}`,
        };
      } else if (activeRoute) {
        // ── Auto-execute from active route (no LLM call) ──
        console.log(`${tag} Active route: stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`);
        const execResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);

        // Convert TurnExecutorResult.plans[] to a single TurnPlan
        const execPlan = execResult.plans.length === 0
          ? { type: AIActionType.PassTurn as const }
          : execResult.plans.length === 1
            ? execResult.plans[0]
            : { type: 'MultiAction' as const, steps: execResult.plans };

        const routeSummary = `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;
        decision = {
          plan: execPlan,
          reasoning: `[route-executor] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`,
          planHorizon: routeSummary,
          model: 'route-executor',
          latencyMs: 0,
          retried: false,
          userPrompt: `[Route] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}. ${routeSummary}`,
          // Propagate post-delivery replan LLM data for debug overlay
          ...(execResult.replanLlmLog && { llmLog: execResult.replanLlmLog }),
          ...(execResult.replanSystemPrompt && { systemPrompt: execResult.replanSystemPrompt }),
          ...(execResult.replanUserPrompt && { userPrompt: execResult.replanUserPrompt }),
        };

        execCompositionTrace = execResult.compositionTrace;
        if (execResult.routeComplete) {
          routeWasCompleted = true;
          console.log(`${tag} Route completed!`);
        } else if (execResult.routeAbandoned) {
          routeWasAbandoned = true;
          console.log(`${tag} Route abandoned: ${execResult.compositionTrace.a2.terminationReason}`);
        } else {
          // Save updated route state (advanced stop/phase)
          activeRoute = execResult.updatedRoute;
        }
        // Propagate hasDelivery from TurnExecutorPlanner (used downstream for route clearing)
        if (execResult.hasDelivery) {
          hasDelivery = true;
        }
      } else if (AIStrategyEngine.hasLLMApiKey(botConfig)) {
        // ── JIRA-170: Auto-deliver before LLM consultation ──
        // When the bot has no active route but can immediately deliver, execute deliveries
        // against the DB now so TripPlanner sees fresh demand cards when planning next trip.
        if (context.canDeliver.length > 0) {
          console.log(`${tag} [JIRA-170] Auto-delivering ${context.canDeliver.length} load(s) before LLM consultation`);
          for (const opp of context.canDeliver) {
            const deliverPlan: TurnPlanDeliverLoad = {
              type: AIActionType.DeliverLoad,
              load: opp.loadType,
              city: opp.deliveryCity,
              cardId: opp.cardIndex,
              payout: opp.payout,
            };
            try {
              const deliverResult = await TurnExecutor.executePlan(deliverPlan, snapshot);
              if (deliverResult.success) {
                hasDelivery = true;
                autoDeliveredLoads.push({
                  loadType: opp.loadType,
                  city: opp.deliveryCity,
                  payment: deliverResult.payment ?? opp.payout,
                  cardId: opp.cardIndex,
                });
                console.log(`${tag} [JIRA-170] Auto-delivered ${opp.loadType} at ${opp.deliveryCity} for ${deliverResult.payment ?? opp.payout}M`);
              } else {
                console.warn(`${tag} [JIRA-170] Auto-delivery of ${opp.loadType} at ${opp.deliveryCity} failed: ${deliverResult.error ?? 'unknown error'}`);
              }
            } catch (autoDeliveryErr) {
              console.warn(`${tag} [JIRA-170] Auto-delivery of ${opp.loadType} at ${opp.deliveryCity} threw: ${(autoDeliveryErr as Error).message}`);
            }
          }

          // Re-capture snapshot and rebuild context so TripPlanner sees fresh demand cards
          if (autoDeliveredLoads.length > 0) {
            try {
              snapshot = await capture(gameId, botPlayerId);
              context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);
              // Re-inject memory-dependent context fields
              context.deliveryCount = memory.deliveryCount ?? 0;
              context.upgradeAdvice = ContextBuilder.computeUpgradeAdvice(
                snapshot, context.demands, context.canBuild, context.deliveryCount,
              );
              if (memory.activeRoute?.stops) {
                context.enRoutePickups = ContextBuilder.computeEnRoutePickups(
                  snapshot, memory.activeRoute.stops, gridPoints,
                );
              }
              if (memory.lastReasoning || memory.lastPlanHorizon) {
                const parts: string[] = [];
                if (memory.lastAction) parts.push(`Action: ${memory.lastAction}`);
                if (memory.lastReasoning) parts.push(`Reasoning: ${memory.lastReasoning}`);
                if (memory.lastPlanHorizon) parts.push(`Plan: ${memory.lastPlanHorizon}`);
                context.previousTurnSummary = parts.join('. ');
              }
              console.log(`${tag} [JIRA-170] Refreshed snapshot and context after auto-delivery`);
            } catch (refreshErr) {
              console.warn(`${tag} [JIRA-170] Failed to refresh context after auto-delivery: ${(refreshErr as Error).message}`);
            }
          }
        }

        // ── No active route — consult TripPlanner for a new multi-stop trip (JIRA-126) ──
        const tripPlanner = new TripPlanner(brain!);

        const tripResult = await tripPlanner.planTrip(snapshot, context, gridPoints, memory);
        // Wrap tripResult into routeResult-compatible shape for downstream code
        const routeResult = tripResult.route
          ? { route: (tripResult as TripPlanResult).route, model: 'trip-planner', latencyMs: (tripResult as TripPlanResult).llmLatencyMs, tokenUsage: (tripResult as TripPlanResult).llmTokens, llmLog: tripResult.llmLog, systemPrompt: (tripResult as TripPlanResult).systemPrompt, userPrompt: (tripResult as TripPlanResult).userPrompt }
          : { route: null as StrategicRoute | null, llmLog: tripResult.llmLog, systemPrompt: undefined as string | undefined, userPrompt: undefined as string | undefined };

        if (routeResult.route) {
          activeRoute = routeResult.route;
          console.log(`${tag} Trip planned: ${activeRoute.stops.length} stops, starting at ${activeRoute.startingCity ?? 'current position'}`);

          // ── Route Enrichment Advisor (JIRA-156 P2): enrich new route with corridor map ──
          if (brain && gridPoints.length > 0) {
            try {
              activeRoute = await RouteEnrichmentAdvisor.enrich(activeRoute, snapshot, context, brain, gridPoints);
            } catch (enrichErr) {
              console.warn(`${tag} RouteEnrichmentAdvisor failed (${(enrichErr as Error).message}), using original route`);
            }
          }

          // ── JIRA-105: Consume upgradeOnRoute from LLM route plan ──
          if (activeRoute.upgradeOnRoute) {
            const { action: upgradeAction, reason: upgradeReason } = AIStrategyEngine.tryConsumeUpgrade(activeRoute, snapshot, tag, memory.deliveryCount ?? 0);
            if (upgradeAction) {
              pendingUpgradeAction = upgradeAction;
            } else if (upgradeReason) {
              upgradeSuppressionReason = upgradeReason;
            }
          }

          // ── JIRA-89: Dead load check + secondary delivery planning ──
          const trainCapacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
          const deadLoads = TurnExecutorPlanner.findDeadLoads(snapshot.bot.loads, snapshot.bot.resolvedDemands);
          const deadLoadDropPlans: TurnPlanDropLoad[] = [];
          if (deadLoads.length > 0 && snapshot.bot.position) {
            // Check if bot is at a city (can only drop at cities)
            const gridPointsMap = loadGridPointsMap();
            const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
            const botCity = gridPointsMap.get(posKey)?.name;
            if (botCity) {
              console.log(`${tag} JIRA-89: Dead loads detected: ${deadLoads.join(', ')} — dropping at ${botCity}`);
              for (const load of deadLoads) {
                deadLoadDropPlans.push({ type: AIActionType.DropLoad, load, city: botCity });
              }
              secondaryDeliveryLog = { action: 'dead_load_drop', reasoning: `Dropped dead loads: ${deadLoads.join(', ')}`, deadLoadsDropped: deadLoads };

              // JIRA-89 fix: Create DropLoad actions and mutate snapshot
              for (const deadLoad of deadLoads) {
                deadLoadDropActions.push({
                  type: AIActionType.DropLoad,
                  load: deadLoad,
                  city: botCity,
                });
                const dropIndex = snapshot.bot.loads.indexOf(deadLoad);
                if (dropIndex >= 0) {
                  snapshot.bot.loads.splice(dropIndex, 1);
                }
              }
            }
          }

          // JIRA-126: Secondary delivery logic removed — TripPlanner already includes
          // multi-stop trip planning with all demand cards considered simultaneously.

          // ── JIRA-92: Cargo conflict check — drop carried loads blocking planned pickups ──
          const routePickupCount = (() => {
            let count = 0;
            for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
              if (activeRoute.stops[i].action === 'pickup') count++;
              else break; // Count consecutive pickups from current index
            }
            return count;
          })();
          const effectiveFreeSlots = trainCapacity - snapshot.bot.loads.length;

          if (
            routePickupCount > effectiveFreeSlots &&
            botConfig!.skillLevel !== BotSkillLevel.Easy &&
            AIStrategyEngine.hasLLMApiKey(botConfig)
          ) {
            console.log(`${tag} JIRA-92: Cargo conflict — route needs ${routePickupCount} pickup slots, only ${effectiveFreeSlots} free`);

            // ── JIRA-105b: Upgrade-before-drop check ──
            // Before asking to drop, check if upgrading gives enough capacity
            let upgradeBeforeDropHandled = false;
            const currentCapacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
            if (
              pendingUpgradeAction === null &&
              currentCapacity < 3 &&
              (memory.deliveryCount ?? 0) >= MIN_DELIVERIES_BEFORE_UPGRADE
            ) {
              // Find capacity-increasing upgrade options (filter ActionResolver.UPGRADE_PATHS to targets with capacity > current)
              const allPaths = ActionResolver.UPGRADE_PATHS[snapshot.bot.trainType] ?? {};
              const paths: Record<string, number> = {};
              for (const [target, cost] of Object.entries(allPaths)) {
                const targetCapacity = TRAIN_PROPERTIES[target as TrainType]?.capacity ?? 0;
                if (targetCapacity > currentCapacity) paths[target] = cost;
              }
              const upgradeOptions: { targetTrain: string; cost: number }[] = [];
              for (const [target, cost] of Object.entries(paths)) {
                if (snapshot.bot.money >= cost) {
                  upgradeOptions.push({ targetTrain: target, cost });
                }
              }

              if (upgradeOptions.length > 0) {
                // Sort by cost ascending (cheapest first)
                upgradeOptions.sort((a, b) => a.cost - b.cost);
                console.log(`${tag} JIRA-105b: Upgrade-before-drop check — ${routePickupCount} pickups needed, ${effectiveFreeSlots} free slots, upgrade to ${upgradeOptions[0].targetTrain} available`);

                // Calculate total route payout
                const totalRoutePayout = activeRoute.stops
                  .filter(s => s.action === 'deliver' && s.payment)
                  .reduce((sum, s) => sum + (s.payment ?? 0), 0);

                try {
                  const upgradePrompt = ContextBuilder.serializeUpgradeBeforeDropPrompt(
                    snapshot, activeRoute, upgradeOptions, totalRoutePayout, context.demands,
                  );
                  const upgradeResult = await brain!.evaluateUpgradeBeforeDrop(upgradePrompt, snapshot, context);

                  if (upgradeResult?.action === 'upgrade' && upgradeResult.targetTrain) {
                    // Validate the target train is in our options
                    const matchedOption = upgradeOptions.find(o => o.targetTrain === upgradeResult.targetTrain);
                    if (matchedOption) {
                      console.log(`${tag} JIRA-105b: Upgrade-before-drop → upgrading to ${upgradeResult.targetTrain} instead of dropping — ${upgradeResult.reasoning}`);
                      pendingUpgradeAction = {
                        type: AIActionType.UpgradeTrain,
                        targetTrain: matchedOption.targetTrain,
                        cost: matchedOption.cost,
                      };
                      upgradeBeforeDropHandled = true;
                    } else {
                      console.warn(`${tag} JIRA-105b: LLM suggested "${upgradeResult.targetTrain}" but not in valid options, falling through to cargo conflict`);
                    }
                  } else {
                    const skipReason = upgradeResult?.reasoning ?? 'LLM returned null';
                    console.log(`${tag} JIRA-105b: Upgrade-before-drop → skip — ${skipReason}`);
                    // JIRA-161: Capture suppression reason for debug overlay
                    upgradeSuppressionReason = `LLM chose drop over upgrade: ${skipReason}`;
                  }
                } catch (err) {
                  console.warn(`${tag} JIRA-105b: Upgrade-before-drop LLM call failed:`, err instanceof Error ? err.message : err);
                }
              }
            }

            // Only run cargo conflict drop if upgrade-before-drop didn't handle it
            if (!upgradeBeforeDropHandled) {
              // Identify carried loads NOT in route's delivery stops
              const routeDeliveryLoads = new Set(
                activeRoute.stops.filter(s => s.action === 'deliver').map(s => s.loadType),
              );
              const conflictingLoads = snapshot.bot.loads.filter(l => !routeDeliveryLoads.has(l));

              if (conflictingLoads.length > 0) {
                try {
                  const cargoPrompt = ContextBuilder.serializeCargoConflictPrompt(snapshot, activeRoute, conflictingLoads, context.demands);
                  const conflictResult = await brain!.evaluateCargoConflict(cargoPrompt, snapshot, context);

                  if (conflictResult?.action === 'drop' && conflictResult.dropLoad) {
                    console.log(`${tag} JIRA-92: evaluateCargoConflict → drop "${conflictResult.dropLoad}" — ${conflictResult.reasoning}`);
                    // Remove the load from snapshot so downstream sees updated capacity
                    const dropIndex = snapshot.bot.loads.indexOf(conflictResult.dropLoad);
                    if (dropIndex >= 0) {
                      snapshot.bot.loads.splice(dropIndex, 1);
                    }
                  } else {
                    console.log(`${tag} JIRA-92: evaluateCargoConflict → keep — ${conflictResult?.reasoning ?? 'LLM returned null'}`);
                  }
                } catch (err) {
                  console.warn(`${tag} JIRA-92: evaluateCargoConflict LLM call failed:`, err instanceof Error ? err.message : err);
                }
              }
            }
          }

          // Execute the first step of the new route via TurnExecutorPlanner
          const execResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);

          // Convert TurnExecutorResult.plans[] to a single TurnPlan
          let execPlan: TurnPlan = execResult.plans.length === 0
            ? { type: AIActionType.PassTurn as const }
            : execResult.plans.length === 1
              ? execResult.plans[0]
              : { type: 'MultiAction' as const, steps: execResult.plans };

          // JIRA-89: Prepend dead load drops to the route plan so they execute first
          if (deadLoadDropPlans.length > 0) {
            const routeSteps = execPlan.type === 'MultiAction' ? execPlan.steps : [execPlan];
            execPlan = { type: 'MultiAction' as const, steps: [...deadLoadDropPlans, ...routeSteps] };
            console.log(`${tag} JIRA-89: Prepended ${deadLoadDropPlans.length} dead load drop(s) to route plan`);
          }

          decision = {
            plan: execPlan,
            reasoning: `[route-planned] ${activeRoute.reasoning}`,
            planHorizon: `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
            model: routeResult.model ?? 'unknown',
            latencyMs: routeResult.latencyMs ?? 0,
            tokenUsage: routeResult.tokenUsage,
            retried: false,
            llmLog: routeResult.llmLog,
            systemPrompt: routeResult.systemPrompt,
            userPrompt: routeResult.userPrompt,
          };

          execCompositionTrace = execResult.compositionTrace;
          if (execResult.routeComplete) {
            routeWasCompleted = true;
          } else if (execResult.routeAbandoned) {
            routeWasAbandoned = true;
          } else {
            activeRoute = execResult.updatedRoute;
          }
          // Propagate hasDelivery from TurnExecutorPlanner
          if (execResult.hasDelivery) {
            hasDelivery = true;
          }
        } else {
          // Route planning failed — try heuristic fallback before passing
          const failedAttempts = routeResult.llmLog.length;
          const failedErrors = routeResult.llmLog.filter(a => a.status !== 'success').map(a => `#${a.attemptNumber}:${a.status}${a.error ? `(${a.error.substring(0, 100)})` : ''}`).join(', ');
          console.warn(`${tag} [LLM] Route planning failed — ${failedAttempts} attempts: [${failedErrors}]. Attempting heuristic fallback`);
          // JIRA-120: Thread LLM failure counter into context for discard gate
          const fallbackContext = { ...context, consecutiveLlmFailures: memory.consecutiveLlmFailures ?? 0 };
          const fallback = await ActionResolver.heuristicFallback(fallbackContext, snapshot, { llmFailed: true });
          if (fallback.success && fallback.plan && fallback.plan.type !== AIActionType.PassTurn) {
            console.log(`${tag} [heuristic] Fallback produced ${fallback.plan.type}`);
            decision = {
              plan: fallback.plan,
              reasoning: `[heuristic-fallback] LLM planning failed — heuristic produced ${fallback.plan.type}`,
              planHorizon: 'Immediate',
              model: 'heuristic-fallback',
              latencyMs: 0,
              retried: false,
              llmLog: routeResult.llmLog,
              systemPrompt: routeResult.systemPrompt,
              userPrompt: routeResult.userPrompt,
            };
          } else {
            // Heuristic also failed — pass turn
            console.error(`${tag} [LLM] Route planning and heuristic fallback both failed — passing turn`);
            decision = {
              plan: { type: AIActionType.PassTurn },
              reasoning: '[llm-failed] LLM planning and heuristic fallback both failed — passing turn',
              planHorizon: 'Immediate',
              model: 'llm-failed',
              latencyMs: 0,
              retried: false,
              llmLog: routeResult.llmLog,
              systemPrompt: routeResult.systemPrompt,
              userPrompt: routeResult.userPrompt,
            };
          }
        }
      } else {
        // No LLM key — pass turn with debug logging
        console.error(`${tag} [LLM] No API key configured — passing turn`);
        decision = {
          plan: { type: AIActionType.PassTurn },
          reasoning: '[no-api-key] No LLM API key configured — passing turn',
          planHorizon: 'Immediate',
          model: 'no-api-key',
          latencyMs: 0,
          retried: false,
          userPrompt: '[No API key] Passing turn — no LLM provider configured',
        };
      }

      console.log(`${tag} Decision: plan=${decision.plan.type}, model=${decision.model}, latency=${decision.latencyMs}ms, retried=${decision.retried}`);

      // ── JIRA-105: Inject pending upgrade action into decision plan (before TurnComposer) ──
      // JIRA-161: Gate 2 removed — redundant with Gate 1 in tryConsumeUpgrade and
      // the delivery count guard in the upgrade-before-drop path. Gate 2 used stale
      // memory.deliveryCount and silently blocked valid upgrades after the LLM decided to upgrade.
      if (pendingUpgradeAction) {
        const existingSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        decision.plan = { type: 'MultiAction' as const, steps: [...existingSteps, pendingUpgradeAction] };
        console.log(`${tag} JIRA-105: Injected UpgradeTrain(${pendingUpgradeAction.targetTrain}) into turn plan`);
      }

      // ── Stage 3b: Validate composed plan against hard gates ──
      // TurnExecutorPlanner already produced a full Phase A + Phase B plan.
      // We validate once; if it violates, strip Phase B and accept as-is (no re-compose).
      let compositionTrace: CompositionTrace = {
        inputPlan: [],
        outputPlan: [],
        moveBudget: { total: context.speed, used: 0, wasted: 0 },
        a1: { citiesScanned: 0, opportunitiesFound: 0 },
        a2: { iterations: 0, terminationReason: 'none' },
        a3: { movePreprended: false },
        build: { target: null, cost: 0, skipped: false, upgradeConsidered: false },
        pickups: [],
        deliveries: [],
      };

      // Use compositionTrace from TurnExecutorPlanner if available (active-route paths)
      if (execCompositionTrace) {
        compositionTrace = execCompositionTrace;
      }

      const recomposeCount = 0;
      const firstCompositionTrace: CompositionTrace | undefined = undefined;
      let validationResult = TurnValidator.validate(decision.plan, context, snapshot);
      const firstValidationViolation = validationResult.valid ? undefined : validationResult.violation;

      if (!validationResult.valid) {
        console.warn(`${tag} [TurnValidator] Hard gate violation: ${validationResult.violation} — stripping Phase B. Pre-strip plan: ${JSON.stringify(decision.plan.type === 'MultiAction' ? decision.plan.steps.map((s: any) => ({ type: s.type, segs: s.segments?.length ?? 0 })) : { type: decision.plan.type, segs: (decision.plan as any).segments?.length ?? 0 })}`);

        // Strip the violating Phase B actions (BUILD/UPGRADE) and accept Phase A only
        const strippedSteps = (decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan])
          .filter(s => s.type !== AIActionType.BuildTrack && s.type !== AIActionType.UpgradeTrain);
        decision.plan = strippedSteps.length === 0
          ? { type: AIActionType.PassTurn as const }
          : strippedSteps.length === 1
            ? strippedSteps[0]
            : { type: 'MultiAction' as const, steps: strippedSteps };

        validationResult = TurnValidator.validate(decision.plan, context, snapshot);
        if (!validationResult.valid) {
          console.warn(`${tag} [TurnValidator] Violation persists after Phase B strip — proceeding with best-effort plan. Violation: ${validationResult.violation}`);
        }
      }

      logPhase('Turn Validation', [], null, null, {
        turnValidation: {
          hardGates: validationResult.hardGates,
          outcome: validationResult.valid ? 'passed' : 'hard_reject',
          recomposeCount,
          firstViolation: recomposeCount > 0 ? firstValidationViolation : undefined,
        },
      });

      // ── Stage 3c: Route state and delivery tracking ──
      // TurnExecutorPlanner already advanced route stops and handled post-delivery replan
      // internally. We only need to:
      //   1. Detect deliveries in the plan (for memory update downstream)
      //   2. Preserve remaining stops for LLM context continuity
      const composedSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
      // hasDelivery may already be set true by TurnExecutorPlanner paths above; also scan composed steps
      if (!hasDelivery) {
        hasDelivery = composedSteps.some(s => s.type === AIActionType.DeliverLoad);
      }

      if (hasDelivery && activeRoute && !routeWasCompleted && !routeWasAbandoned) {
        const remaining = activeRoute.stops.slice(activeRoute.currentStopIndex);
        if (remaining.length > 0) {
          previousRouteStops = remaining;
          console.log(`${tag} Delivery detected — preserving ${remaining.length} remaining route stops for LLM context`);
        } else {
          console.log(`${tag} Delivery detected — no remaining stops, clearing active route`);
        }
        // TurnExecutorPlanner handles internal replan — activeRoute stays as-is (updated by exec above)
      }

      // ── Stage 3e: Continuation after route completion ──
      // When the route just completed, fill remaining budget with a heuristic action.
      // TurnExecutorPlanner handles post-delivery replan internally, so no re-eval needed here.
      if (routeWasCompleted) {
        // Simulate plan effects so heuristicFallback sees post-route state
        const simSnapshot = ActionResolver.cloneSnapshot(snapshot);
        const simContext = { ...context };
        const planSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        for (const step of planSteps) {
          ActionResolver.applyPlanToState(step, simSnapshot, simContext);
        }

        const continuation = await ActionResolver.heuristicFallback(simContext, simSnapshot);
        // JIRA-97: Do not speculatively build track after route completion when LLM
        // re-eval failed. Without a validated route, building wastes money on unvalidated targets.
        const isBuildAction = continuation.plan?.type === AIActionType.BuildTrack;
        if (continuation.success && continuation.plan && continuation.plan.type !== AIActionType.PassTurn && !isBuildAction) {
          decision.plan = { type: 'MultiAction' as const, steps: [...planSteps, continuation.plan] };
          console.log(`${tag} Route complete — continuation ${continuation.plan.type}`);
        } else if (isBuildAction) {
          console.log(`${tag} JIRA-97: Blocked speculative BuildTrack from heuristic continuation (no validated route)`);
        }
      }

      // JIRA-89 fix: Prepend dead load drop actions to the plan
      if (deadLoadDropActions.length > 0) {
        const existingSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        decision.plan = { type: 'MultiAction' as const, steps: [...deadLoadDropActions, ...existingSteps] };
        console.log(`${tag} JIRA-89: Prepended ${deadLoadDropActions.length} dead load drop action(s) to plan`);
      }

      // ── Stage 4: Apply guardrails ──
      // JIRA-143: Snapshot plan before guardrail check for originalPlan capture
      const preGuardrailPlan = { action: decision.plan.type, reasoning: decision.reasoning ?? '' };
      let guardrailResult = await GuardrailEnforcer.checkPlan(decision.plan, context, snapshot, memory.noProgressTurns, activeRoute != null, memory.consecutiveDiscards);
      let finalPlan: TurnPlan = guardrailResult.plan;
      let originalPlan: { action: string; reasoning: string } | undefined;

      if (guardrailResult.overridden) {
        console.log(`${tag} Guardrail override: ${guardrailResult.reason}`);
        decision.guardrailOverride = true;
        originalPlan = preGuardrailPlan;

        // JIRA-177: When the broke-and-stuck guardrail forces a DiscardHand and the bot had
        // an active route, clear the route immediately. JIRA-61 logic (below) only clears routes
        // when cards change — but we must guarantee a fresh TripPlanner call on the next turn
        // regardless of whether the new hand references the same load types.
        if (finalPlan.type === AIActionType.DiscardHand && activeRoute != null && guardrailResult.reason?.includes('Broke-and-stuck')) {
          console.log(
            `${tag} JIRA-177: Clearing stale active route after broke-and-stuck guardrail forced discard`,
          );
          activeRoute = null;
        }
      }

      // Log LLM decision phase
      const llmFields: LLMPhaseFields = {
        llmModel: decision.model,
        llmLatencyMs: decision.latencyMs,
        llmTokenUsage: decision.tokenUsage,
        llmReasoning: decision.reasoning,
        llmPlanHorizon: decision.planHorizon,
        wasGuardrailOverride: guardrailResult.overridden,
        guardrailReason: guardrailResult.reason,
      };
      logPhase('LLM Decision', [], null, null, llmFields);

      // ── Stage 5: Execute the plan ──
      const result = await TurnExecutor.executePlan(finalPlan, snapshot);

      // Log execution phase
      logPhase('Execution', [], null, result);

      const durationMs = Date.now() - startTime;

      // Determine action for result
      const executedAction = finalPlan.type === 'MultiAction'
        ? (finalPlan.steps[0]?.type as AIActionType ?? AIActionType.PassTurn)
        : (finalPlan.type as AIActionType);

      // Concise turn summary
      console.log(`${tag} Turn complete: ${finalPlan.type}${finalPlan.type === AIActionType.BuildTrack ? ` (${result.segmentsBuilt}seg/$${result.cost}M)` : ''} | success=${result.success} | money=${result.remainingMoney} | ${durationMs}ms`);

      // Update bot memory (including reasoning for next-turn context continuity)
      // Progress-based stuck detection: increment noProgressTurns when turn had
      // zero deliveries AND zero net cash increase AND no new cities connected
      // AND bot is NOT actively traveling on an active route (JIRA-45, JIRA-68).
      const hadDelivery = (result.payment ?? 0) > 0 || hasDelivery; // JIRA-84: also check pre-execution composed steps
      const hadCashIncrease = result.remainingMoney > snapshot.bot.money;
      const hadNewTrack = result.segmentsBuilt > 0;
      // JIRA-166: Narrow isActivelyTraveling — don't count as progress when bot is broke
      // and the next route stop is off-network (requires building track the bot can't afford).
      // This allows noProgressTurns to increment so the oscillation guard at line 272 can fire.
      const nextRouteStop = activeRoute
        ? activeRoute.stops[activeRoute.currentStopIndex] ?? null
        : null;
      const nextStopIsOffNetwork = nextRouteStop != null
        && !context.citiesOnNetwork.includes(nextRouteStop.city);
      const botIsBroke = result.remainingMoney < 5;
      const isActivelyTraveling = activeRoute != null
        && !(botIsBroke && nextStopIsOffNetwork);
      if (activeRoute != null && botIsBroke && nextStopIsOffNetwork) {
        console.log(
          `${tag} JIRA-166: isActivelyTraveling=false — broke ($${result.remainingMoney}M) with off-network next stop (${nextRouteStop?.city})`,
        );
      }
      const hadDiscard = executedAction === AIActionType.DiscardHand; // JIRA-59: discard = fresh cards = progress
      const madeProgress = hadDelivery || hadCashIncrease || hadNewTrack || isActivelyTraveling || hadDiscard;

      const memoryPatch: Partial<typeof memory> = {
        lastAction: executedAction,
        noProgressTurns: madeProgress ? 0 : (memory.noProgressTurns ?? 0) + 1,
        consecutiveDiscards: executedAction === AIActionType.DiscardHand
          ? memory.consecutiveDiscards + 1 : 0,
        consecutiveLlmFailures: decision.model === 'heuristic-fallback' || decision.model === 'llm-failed'
            || (decision.model === 'route-executor' && decision.llmLog?.length && decision.llmLog.every(e => e.status !== 'success'))
          ? (memory.consecutiveLlmFailures ?? 0) + 1 : 0,
        deliveryCount: (memory.deliveryCount ?? 0) + (hadDelivery ? 1 : 0), // JIRA-60
        totalEarnings: (memory.totalEarnings ?? 0) + (result.payment ?? 0), // JIRA-60
        turnNumber: snapshot.turnNumber,
        lastReasoning: decision.reasoning ?? null,
        lastPlanHorizon: decision.planHorizon ?? null,
      };

      // Update route state in memory
      if (routeWasCompleted || routeWasAbandoned) {
        const outcome = routeWasCompleted ? 'completed' : 'abandoned';
        const routeToLog = memory.activeRoute ?? activeRoute;
        if (routeToLog) {
          memoryPatch.routeHistory = [
            ...(memory.routeHistory ?? []),
            { route: routeToLog, outcome, turns: memory.turnsOnRoute + 1 },
          ];
          if (routeWasAbandoned) {
            const firstStop = routeToLog.stops[0];
            memoryPatch.lastAbandonedRouteKey = firstStop
              ? `${firstStop.loadType}:${firstStop.city}`
              : null;
          }
        }
        memoryPatch.activeRoute = null;
        memoryPatch.turnsOnRoute = 0;
      } else if (activeRoute) {
        memoryPatch.activeRoute = activeRoute;
        memoryPatch.turnsOnRoute = (memory.turnsOnRoute ?? 0) + 1;
      } else if (memory.activeRoute && !activeRoute) {
        // Route was cleared mid-turn (e.g., delivery triggered re-planning)
        memoryPatch.activeRoute = null;
        memoryPatch.turnsOnRoute = 0;
      }

      // BE-010: Store/clear previous route stops for LLM context
      if (previousRouteStops) {
        memoryPatch.previousRouteStops = previousRouteStops;
      } else if (activeRoute) {
        // New route planned — clear any previous route context
        memoryPatch.previousRouteStops = null;
      }

      await updateMemory(gameId, botPlayerId, memoryPatch);

      flushTurnLog();

      // Extract buildTargetCity from the plan for debug overlay
      let buildTargetCity: string | undefined;
      if (finalPlan.type === AIActionType.BuildTrack && 'targetCity' in finalPlan) {
        buildTargetCity = finalPlan.targetCity;
      } else if (finalPlan.type === 'MultiAction') {
        const buildStep = finalPlan.steps.find(s => s.type === AIActionType.BuildTrack);
        if (buildStep && 'targetCity' in buildStep) {
          buildTargetCity = (buildStep as { targetCity?: string }).targetCity;
        }
      }

      // JIRA-56: After DiscardHand, refresh context.demands from new cards
      if (executedAction === AIActionType.DiscardHand) {
        const freshSnapshot = await capture(gameId, botPlayerId);
        context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);

        // JIRA-61: Invalidate active route if it references demand cards no longer in hand
        if (activeRoute) {
          const remainingStops = activeRoute.stops.slice(activeRoute.currentStopIndex);
          const hasOrphanedStop = remainingStops.some(stop =>
            !context.demands.some(d => d.loadType === stop.loadType),
          );
          if (hasOrphanedStop) {
            console.log(
              `[AIStrategyEngine] JIRA-61: Clearing stale route after discard — ` +
              `route references demand cards no longer in hand`,
            );
            memoryPatch.activeRoute = null;
            memoryPatch.turnsOnRoute = 0;
            activeRoute = null;
          }
        }
      }

      // JIRA-64: After delivery, refresh context.demands from newly drawn card
      if (hadDelivery) {
        const freshSnapshot = await capture(gameId, botPlayerId);
        context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);

        // JIRA-61: Invalidate active route if it references demand cards no longer in hand
        if (activeRoute) {
          const remainingStops = activeRoute.stops.slice(activeRoute.currentStopIndex);
          const hasOrphanedStop = remainingStops.some(stop =>
            !context.demands.some(d => d.loadType === stop.loadType),
          );
          if (hasOrphanedStop) {
            console.log(
              `${tag} JIRA-64: Clearing stale route after delivery — ` +
              `route references demand cards no longer in hand`,
            );
            memoryPatch.activeRoute = null;
            memoryPatch.turnsOnRoute = 0;
            activeRoute = null;
          }
        }

        // JIRA-126: Post-delivery replan is now handled internally by TurnExecutorPlanner.
        // activeRoute is already updated by TurnExecutorPlanner's post-delivery replan.
      }

      // JIRA-85: Always rebuild demands from fresh DB state before ranking.
      // context.demands may be stale after discard or non-delivery turns where
      // the hand changed but rebuildDemands (line 541) was not triggered.
      const rankingSnapshot = await capture(gameId, botPlayerId);
      const freshDemands = ContextBuilder.rebuildDemands(rankingSnapshot, gridPoints);

      // Build demand ranking from context for debug overlay (JIRA-13)
      // FE-001: Compute supply rarity per load type
      const supplyCityCounts = new Map<string, Set<string>>();
      for (const d of freshDemands) {
        if (!supplyCityCounts.has(d.loadType)) supplyCityCounts.set(d.loadType, new Set());
        if (d.supplyCity) supplyCityCounts.get(d.loadType)!.add(d.supplyCity);
      }
      const demandRanking = [...freshDemands]
        .sort((a, b) => b.demandScore - a.demandScore)
        .map((d, i) => {
          const cityCount = supplyCityCounts.get(d.loadType)?.size ?? 1;
          const supplyRarity = cityCount <= 1 ? 'UNIQUE' : cityCount === 2 ? 'LIMITED' : 'COMMON';
          return {
            loadType: d.loadType,
            supplyCity: d.supplyCity,
            deliveryCity: d.deliveryCity,
            payout: d.payout,
            score: d.demandScore,
            rank: i + 1,
            supplyRarity,
            isStale: d.estimatedTurns >= 12,
            efficiencyPerTurn: d.efficiencyPerTurn,
            estimatedTurns: d.estimatedTurns,
            trackCostToSupply: d.estimatedTrackCostToSupply,
            trackCostToDelivery: d.estimatedTrackCostToDelivery,
            ferryRequired: d.ferryRequired,
          };
        });

      // JIRA-32: Extract movement data from composed plan for game log
      // JIRA-36: Also extract concatenated movement path for client animation
      // JIRA-116: Prepend early-executed MOVE paths so movementPath reflects the complete turn trajectory
      let milepostsMoved: number | undefined;
      let trackUsageFee: number | undefined;
      const movementPath: { row: number; col: number }[] = [];
      // JIRA-170: Prepend auto-delivered loads (executed before TripPlanner consultation)
      const loadsDelivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [...autoDeliveredLoads];
      const loadsPickedUp: Array<{ loadType: string; city: string }> = [];
      const allSteps = finalPlan.type === 'MultiAction' ? finalPlan.steps : [finalPlan];
      for (const step of allSteps) {
        if (step.type === AIActionType.MoveTrain) {
          milepostsMoved = (milepostsMoved ?? 0) + computeEffectivePathLength(step.path, getMajorCityLookup());
          trackUsageFee = (trackUsageFee ?? 0) + step.totalFee;
          if (step.path.length > 0) {
            const last = movementPath[movementPath.length - 1];
            const first = step.path[0];
            const startIndex = (last && last.row === first.row && last.col === first.col) ? 1 : 0;
            movementPath.push(...step.path.slice(startIndex));
          }
        }
        if (step.type === AIActionType.DeliverLoad && 'load' in step && 'city' in step) {
          loadsDelivered.push({
            loadType: step.load as string,
            city: step.city as string,
            payment: (step as any).payout ?? 0,
            cardId: (step as any).cardId ?? 0,
          });
        }
        if (step.type === AIActionType.PickupLoad && 'load' in step && 'city' in step) {
          loadsPickedUp.push({
            loadType: step.load as string,
            city: step.city as string,
          });
        }
      }

      // Build structured action timeline for animated partial turn movements
      const actionTimeline = AIStrategyEngine.buildActionTimeline(allSteps);

      // JIRA-143: Map model → actor metadata
      const actorMeta = AIStrategyEngine.mapActorMetadata(decision.model, guardrailResult.overridden);
      // For LLM actors, populate llmModel from brain if not already set by the mapping
      if (actorMeta.actor === 'llm' && !actorMeta.llmModel && brain) {
        actorMeta.llmModel = brain.modelName;
      }

      // JIRA-143: Build actionBreakdown from composed steps
      const actionBreakdown: Array<{ action: AIActionType; actor: 'llm' | 'system' | 'heuristic'; detail?: string }> = [];
      const a1PickupCities = new Set((compositionTrace?.pickups ?? []).map(p => p.city));
      const primaryActor = actorMeta.actor === 'llm' || actorMeta.actor === 'heuristic' ? actorMeta.actor : 'system' as const;
      for (const step of allSteps) {
        if (step.type === AIActionType.BuildTrack) {
          const buildActor = compositionTrace?.advisor?.fallback ? 'heuristic' as const : 'llm' as const;
          actionBreakdown.push({ action: step.type, actor: buildActor, detail: 'build-advisor' });
        } else if (step.type === AIActionType.PickupLoad && 'city' in step && a1PickupCities.has((step as any).city)) {
          actionBreakdown.push({ action: step.type, actor: 'system', detail: 'a1-opportunistic' });
        } else {
          actionBreakdown.push({ action: step.type as AIActionType, actor: primaryActor, detail: actorMeta.actorDetail });
        }
      }

      // JIRA-143: Build llmSummary from call summaries
      let llmSummary: BotTurnResult['llmSummary'];
      if (brain) {
        const summaries = brain.providerAdapter.getCallSummaries();
        if (summaries.length > 0) {
          llmSummary = {
            callCount: summaries.length,
            totalLatencyMs: summaries.reduce((sum, s) => sum + s.latencyMs, 0),
            totalTokens: {
              input: summaries.reduce((sum, s) => sum + (s.tokenUsage?.input ?? 0), 0),
              output: summaries.reduce((sum, s) => sum + (s.tokenUsage?.output ?? 0), 0),
            },
            callers: [...new Set(summaries.map(s => s.caller))],
          };
        }
      }

      return {
        action: result.action,
        segmentsBuilt: result.segmentsBuilt,
        cost: result.cost,
        durationMs,
        success: result.success,
        error: result.error,
        buildTargetCity,
        reasoning: decision.reasoning,
        planHorizon: decision.planHorizon,
        guardrailOverride: guardrailResult.overridden || undefined,
        guardrailReason: guardrailResult.reason,
        // JIRA-143: Actor metadata and LLM call tracking
        actor: actorMeta.actor,
        actorDetail: actorMeta.actorDetail,
        llmModel: actorMeta.llmModel,
        llmCallIds: brain ? brain.providerAdapter.getCallIds() : undefined,
        llmSummary,
        actionBreakdown: actionBreakdown.length > 0 ? actionBreakdown : undefined,
        demandRanking,
        // JIRA-19: LLM decision metadata
        model: decision.model,
        llmLatencyMs: decision.latencyMs,
        tokenUsage: decision.tokenUsage,
        retried: decision.retried,
        upgradeAdvice: context.upgradeAdvice,
        // JIRA-161: Upgrade suppression reason for debug overlay
        upgradeSuppressionReason: upgradeSuppressionReason ?? undefined,
        // JIRA-31: LLM attempt log for debug overlay
        llmLog: decision.llmLog,
        // JIRA-32: Strategic context and composition trace for game log
        gamePhase: context.phase || undefined,
        cash: result.remainingMoney,
        trainType: context.trainType,
        milepostsMoved,
        trackUsageFee,
        loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
        loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
        compositionTrace,
        // JIRA-129/JIRA-145: Extract Build Advisor fields from composition trace.
        // When recomposed, use the first (rejected) composition's advisor trace
        // so we preserve what the LLM originally produced for debugging.
        ...(() => {
          const advisorTrace = (recomposeCount > 0 ? firstCompositionTrace : compositionTrace)?.advisor;
          return {
            advisorAction: advisorTrace?.action ?? undefined,
            advisorWaypoints: advisorTrace?.waypoints?.length ? advisorTrace.waypoints : undefined,
            advisorReasoning: advisorTrace?.reasoning ?? undefined,
            advisorLatencyMs: advisorTrace?.latencyMs ?? undefined,
            advisorSystemPrompt: advisorTrace?.systemPrompt ?? undefined,
            advisorUserPrompt: advisorTrace?.userPrompt ?? undefined,
            solvencyRetries: advisorTrace?.solvencyRetries ?? undefined,
            advisorUsedFallback: advisorTrace?.fallback ?? undefined,
          };
        })(),
        // JIRA-143: Original plan capture
        originalPlan,
        movementPath: movementPath.length > 0 ? movementPath : undefined,
        actionTimeline: actionTimeline.length > 0 ? actionTimeline : undefined,
        secondaryDelivery: secondaryDeliveryLog,
        activeRoute: activeRoute ?? null,
        // JIRA-148: Initial build planner evaluated options for diagnostics
        initialBuildOptions: initialBuildEvaluatedOptions,
        initialBuildPairings: initialBuildEvaluatedPairings,
        // Prompt text for NDJSON + debug overlay observability
        systemPrompt: decision.systemPrompt,
        userPrompt: decision.userPrompt ?? debugUserPrompt,
        // Enriched debugging fields
        positionStart,
        positionEnd: movementPath.length > 0
          ? (() => { const last = movementPath[movementPath.length - 1]; return { row: last.row, col: last.col, cityName: gridPoints.find(gp => gp.row === last.row && gp.col === last.col)?.city?.name }; })()
          : positionStart,
        carriedLoads: snapshot.bot.loads.length > 0 ? [...snapshot.bot.loads] : undefined,
        connectedMajorCities: context.connectedMajorCities.length > 0 ? context.connectedMajorCities : undefined,
        trainSpeed: context.speed,
        trainCapacity: context.capacity,
        demandCards: context.demands.map(d => ({ loadType: d.loadType, supplyCity: d.supplyCity, deliveryCity: d.deliveryCity, payout: d.payout, cardIndex: d.cardIndex })),
        turnValidation: {
          hardGates: validationResult.hardGates,
          outcome: validationResult.valid ? 'passed' : 'hard_reject',
          recomposeCount,
          firstViolation: recomposeCount > 0 ? firstValidationViolation : undefined,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error(`${tag} PIPELINE ERROR (${durationMs}ms):`, error instanceof Error ? error.stack : error);

      // Update bot memory even on pipeline error
      await updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
        noProgressTurns: (memory.noProgressTurns ?? 0) + 1,
        consecutiveDiscards: 0,
        turnNumber: memory.turnNumber + 1,
      });

      flushTurnLog();

      // BE-009: Best-effort audit record for pipeline errors
      try {
        const auditDetails = JSON.stringify({
          source: 'pipeline-error',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        await db.query(
          `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [gameId, botPlayerId, memory.turnNumber + 1, AIActionType.PassTurn, 0, 0, durationMs, auditDetails],
        );
      } catch (auditError) {
        console.warn(`${tag} Failed to write pipeline-error audit record:`, auditError instanceof Error ? auditError.message : auditError);
      }

      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        model: 'pipeline-error',
        actor: 'error' as const,
        actorDetail: 'pipeline-error',
        llmLatencyMs: 0,
        retried: false,
      };
    }
  }

  /** JIRA-143: Map the model field to actor/actorDetail/llmModel metadata. */
  static mapActorMetadata(model: string | undefined, guardrailOverridden: boolean): { actor: BotTurnResult['actor']; actorDetail: string; llmModel?: string } {
    if (guardrailOverridden) {
      return { actor: 'guardrail', actorDetail: 'guardrail-enforcer' };
    }
    switch (model) {
      case 'initial-build-planner':
      case 'route-executor':
        return { actor: 'system', actorDetail: model };
      case 'broke-bot-heuristic':
      case 'heuristic-fallback':
        return { actor: 'heuristic', actorDetail: model };
      case 'trip-planner':
        return { actor: 'llm', actorDetail: 'trip-planner' };
      case 'llm-failed':
      case 'no-api-key':
      case 'pipeline-error':
        return { actor: 'error', actorDetail: model };
      default:
        // If model is an actual LLM model ID (not a known pseudo-label), it came from strategy-brain
        if (model) {
          return { actor: 'llm', actorDetail: 'strategy-brain', llmModel: model };
        }
        return { actor: 'system', actorDetail: 'unknown' };
    }
  }

  /** Build a structured action timeline from composed plan steps. */
  static buildActionTimeline(allSteps: TurnPlan[]): TimelineStep[] {
    const timeline: TimelineStep[] = [];
    for (const step of allSteps) {
      switch (step.type) {
        case AIActionType.MoveTrain:
          if (step.path && step.path.length > 0) {
            timeline.push({ type: 'move', path: step.path.map(p => ({ row: p.row, col: p.col })) });
          }
          break;
        case AIActionType.DeliverLoad:
          timeline.push({
            type: 'deliver',
            loadType: (step as any).load ?? '',
            city: (step as any).city ?? '',
            payment: (step as any).payout ?? 0,
            cardId: (step as any).cardId ?? 0,
          });
          break;
        case AIActionType.PickupLoad:
          timeline.push({
            type: 'pickup',
            loadType: (step as any).load ?? '',
            city: (step as any).city ?? '',
          });
          break;
        case AIActionType.BuildTrack:
          timeline.push({
            type: 'build',
            segmentsBuilt: (step as any).segments?.length ?? 0,
            cost: (step as any).cost ?? 0,
          });
          break;
        case AIActionType.UpgradeTrain:
          timeline.push({
            type: 'upgrade',
            trainType: (step as any).targetTrain ?? '',
          });
          break;
        case AIActionType.DiscardHand:
          timeline.push({ type: 'discard' });
          break;
        // PassTurn and DropLoad don't need timeline entries
      }
    }
    return timeline;
  }

  /**
   * INF-002: Zero-money gate — log when the bot has no money and determine
   * the likely recovery path. Advisory only — does not alter the pipeline flow.
   */
  private static zeroMoneyGate(
    tag: string,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): void {
    if (snapshot.bot.money > 0) return;
    const hasLoads = snapshot.bot.loads.length;
    const deliverables = context.canDeliver;
    if (deliverables.length > 0) {
      console.warn(`${tag} [ZeroMoneyGate] Activated: money=0, loads=${hasLoads}. Found deliverable: ${deliverables[0].loadType} → ${deliverables[0].deliveryCity}`);
    } else if (hasLoads > 0) {
      console.warn(`${tag} [ZeroMoneyGate] Activated: money=0, loads=${hasLoads}. No delivery match — must move toward delivery city`);
    } else {
      console.warn(`${tag} [ZeroMoneyGate] Activated: money=0, loads=0. Discarding hand`);
    }
  }

  /**
   * Auto-place bot at a track endpoint that's at a major city milepost.
   * Prioritizes the LLM-chosen startingCity if available and track exists there.
   * Falls back to any major city milepost on track, then closest major city outpost.
   */
  static async autoPlaceBot(snapshot: WorldSnapshot, activeRoute?: StrategicRoute | null): Promise<void> {
    const majorCityLookup = getMajorCityLookup();

    // Priority 1: Place at LLM-chosen startingCity if track exists there
    if (activeRoute?.startingCity) {
      const groups = getMajorCityGroups();
      const cityGroup = groups.find(
        g => g.cityName.toLowerCase() === activeRoute.startingCity!.toLowerCase(),
      );
      if (cityGroup) {
        const cityMileposts = [cityGroup.center, ...cityGroup.outposts];
        for (const seg of snapshot.bot.existingSegments) {
          for (const end of [seg.from, seg.to]) {
            if (cityMileposts.some(mp => mp.row === end.row && mp.col === end.col)) {
              const pixel = gridToPixel(end.row, end.col);
              await db.query(
                'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
                [end.row, end.col, pixel.x, pixel.y, snapshot.bot.playerId],
              );
              snapshot.bot.position = { row: end.row, col: end.col };
              return;
            }
          }
        }
      }
    }

    // Priority 2: Any track endpoint at a major city milepost
    for (const seg of snapshot.bot.existingSegments) {
      for (const end of [seg.from, seg.to]) {
        const key = `${end.row},${end.col}`;
        if (majorCityLookup.has(key)) {
          const pixel = gridToPixel(end.row, end.col);
          await db.query(
            'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
            [end.row, end.col, pixel.x, pixel.y, snapshot.bot.playerId],
          );
          snapshot.bot.position = { row: end.row, col: end.col };
          return;
        }
      }
    }

    // Fallback: closest major city outpost to any track endpoint
    const groups = getMajorCityGroups();
    if (groups.length === 0) return;

    let bestPoint = groups[0].outposts[0] ?? groups[0].center;
    let bestDist = Infinity;

    for (const group of groups) {
      for (const point of [...group.outposts, group.center]) {
        for (const seg of snapshot.bot.existingSegments) {
          for (const end of [seg.from, seg.to]) {
            const dr = point.row - end.row;
            const dc = point.col - end.col;
            const dist = dr * dr + dc * dc;
            if (dist < bestDist) {
              bestDist = dist;
              bestPoint = point;
            }
          }
        }
      }
    }

    const pixel = gridToPixel(bestPoint.row, bestPoint.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [bestPoint.row, bestPoint.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: bestPoint.row, col: bestPoint.col };
  }

  /**
   * Check if the bot has LLM API key configured.
   * Returns false if no provider or no matching env var — falls back to heuristic.
   */
  /**
   * JIRA-105: Consume upgradeOnRoute from a route, returning a TurnPlanUpgradeTrain if valid.
   * Clears upgradeOnRoute from the route after consumption (one-time use).
   */
  /**
   * JIRA-161: Return shape for tryConsumeUpgrade — exposes rejection reason alongside the action
   * so callers can surface suppression information to the debug overlay.
   */
  private static tryConsumeUpgrade(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    tag: string,
    deliveryCount: number,
  ): { action: TurnPlanUpgradeTrain | null; reason?: string } {
    const targetTrain = route.upgradeOnRoute!;
    route.upgradeOnRoute = undefined; // one-time consumption

    // JIRA-119: Gate 1 — block upgrade before sufficient deliveries
    if (deliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) {
      const reason = `only ${deliveryCount} deliveries (need ${MIN_DELIVERIES_BEFORE_UPGRADE})`;
      console.warn(`${tag} JIRA-119: upgradeOnRoute blocked — ${reason}`);
      return { action: null, reason: `Upgrade blocked: ${reason}` };
    }

    // Validate upgrade path using ActionResolver.UPGRADE_PATHS
    const currentTrain = snapshot.bot.trainType;
    const paths = ActionResolver.UPGRADE_PATHS[currentTrain];
    if (!paths || !(targetTrain in paths)) {
      const reason = `invalid upgrade path "${targetTrain}" from "${currentTrain}"`;
      console.warn(`${tag} JIRA-105: upgradeOnRoute "${targetTrain}" invalid from "${currentTrain}" — skipping`);
      return { action: null, reason: `Upgrade blocked: ${reason}` };
    }

    const cost = paths[targetTrain];
    if (snapshot.bot.money < cost) {
      const reason = `insufficient funds (need ${cost}M, have ${snapshot.bot.money}M)`;
      console.warn(`${tag} JIRA-105: upgradeOnRoute "${targetTrain}" unaffordable (need ${cost}M, have ${snapshot.bot.money}M) — skipping`);
      return { action: null, reason: `Upgrade blocked: ${reason}` };
    }

    console.log(`${tag} JIRA-105: Consuming upgradeOnRoute → ${targetTrain} (cost=${cost}M)`);
    return { action: { type: AIActionType.UpgradeTrain, targetTrain, cost } };
  }

  private static readonly ENV_KEY_MAP: Record<LLMProvider, string> = {
    [LLMProvider.Anthropic]: 'ANTHROPIC_API_KEY',
    [LLMProvider.Google]: 'GOOGLE_AI_API_KEY',
    [LLMProvider.OpenAI]: 'OPENAI_API_KEY',
  };

  private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
    if (!botConfig) return false;
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
    return !!process.env[envKey];
  }

  /**
   * Create an LLMStrategyBrain instance from bot config.
   */
  private static createBrain(botConfig: BotConfig): LLMStrategyBrain {
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const skillLevel = (botConfig.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
    const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
    const apiKey = process.env[envKey] ?? '';

    return new LLMStrategyBrain({
      skillLevel,
      provider,
      model: botConfig.model,
      apiKey,
      timeoutMs: 30000,
      maxRetries: 1,
    });
  }
}
