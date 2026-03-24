/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services in a 6-stage pipeline:
 *   1. WorldSnapshotService.capture()  — frozen game state
 *   2. ContextBuilder.build()          — decision-relevant context for LLM
 *   3. LLMStrategyBrain.decideAction() — LLM intent → ActionResolver → TurnPlan
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
import { PlanExecutor } from './PlanExecutor';
import { TurnComposer, CompositionTrace } from './TurnComposer';
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
  TurnPlanMoveTrain,
  TurnPlanDropLoad,
  TurnPlanUpgradeTrain,
  TRAIN_PROPERTIES,
  TrainType,
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
  demandRanking?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number; supplyRarity?: string; isStale?: boolean; efficiencyPerTurn?: number; estimatedTurns?: number; trackCostToSupply?: number; trackCostToDelivery?: number; ferryRequired?: boolean }>;
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
  // Hand quality metrics for audit logging
  handQuality?: { score: number; staleCards: number; assessment: string };
  // FE-002: Dynamic upgrade advice for debug overlay
  upgradeAdvice?: string;
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
  demandCards?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; cardIndex: number }>;
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
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn via the 6-stage pipeline:
   *   1. WorldSnapshot.capture()
   *   2. ContextBuilder.build()
   *   3. LLMStrategyBrain.decideAction() (includes retry loop)
   *   4. GuardrailEnforcer.checkPlan()
   *   5. TurnExecutor.executePlan()
   *
   * Falls back to PassTurn on pipeline error.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();
    const tag = `[AIStrategy ${gameId.slice(0, 8)}]`;

    // Load bot memory for state continuity across turns
    const memory = getMemory(gameId, botPlayerId);

    // Initialize decision logging for this turn
    initTurnLog(gameId, botPlayerId, memory.turnNumber + 1);

    try {
      // ── Stage 1: Capture world snapshot ──
      const snapshot = await capture(gameId, botPlayerId);
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
      const context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);

      // JIRA-60: Inject delivery count from memory for upgrade advice gating
      context.deliveryCount = memory.deliveryCount ?? 0;

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
      let previousRouteStops: RouteStop[] | null = null; // BE-010
      let secondaryDeliveryLog: { action: string; reasoning: string; pickupCity?: string; loadType?: string; deliveryCity?: string; deadLoadsDropped?: string[] } | undefined;
      const deadLoadDropActions: TurnPlanDropLoad[] = [];
      let pendingUpgradeAction: TurnPlanUpgradeTrain | null = null; // JIRA-105

      if (!activeRoute && context.isInitialBuild) {
        // ── JIRA-142b: Computed initial build — bypass LLM entirely ──
        // Plan the route and produce a BuildTrack decision with targetCity.
        // Don't go through PlanExecutor.executeInitialBuild — its cold-start
        // segment computation fails. Instead, let TurnComposer Phase B
        // (BuildAdvisor) compute the actual segments.
        const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints);
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
        decision = {
          plan: { type: AIActionType.BuildTrack, segments: [], targetCity },
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
        const execResult = await PlanExecutor.execute(activeRoute, snapshot, context);

        const routeSummary = `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;
        decision = {
          plan: execResult.plan,
          reasoning: `[route-executor] ${execResult.description}`,
          planHorizon: routeSummary,
          model: 'route-executor',
          latencyMs: 0,
          retried: false,
          userPrompt: `[Route] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}. ${routeSummary}`,
        };

        if (execResult.routeComplete) {
          routeWasCompleted = true;
          console.log(`${tag} Route completed!`);
        } else if (execResult.routeAbandoned) {
          routeWasAbandoned = true;
          console.log(`${tag} Route abandoned: ${execResult.description}`);
        } else {
          // Save updated route state (advanced stop/phase)
          activeRoute = execResult.updatedRoute;
        }
      } else if (AIStrategyEngine.hasLLMApiKey(botConfig)) {
        // ── Pre-LLM discard gate: broke bot with no deliverable hand ──
        // If cash < 5M, no affordable demands, and no immediate delivery,
        // skip the LLM entirely and discard immediately (saves 1-3 LLM calls).
        const isBroke = snapshot.bot.money < 5;
        const noAffordableDemands = context.demands.length > 0 && context.demands.every(d => !d.isAffordable);
        const noDelivery = !context.canDeliver || context.canDeliver.length === 0;
        const noDeliverableOnNetwork = context.demands.every(d =>
          !(d.isLoadOnTrain && d.isDeliveryOnNetwork),
        );

        if (!context.isInitialBuild && isBroke && noAffordableDemands && noDelivery && noDeliverableOnNetwork) {
          console.warn(`${tag} [pre-LLM] Broke bot gate — cash=${snapshot.bot.money}M, no affordable demands, no delivery. Skipping LLM, discarding hand.`);
          decision = {
            plan: { type: AIActionType.DiscardHand },
            reasoning: `[broke-bot-gate] Cash=${snapshot.bot.money}M with no affordable demands — discarding hand (LLM skipped)`,
            planHorizon: 'Immediate',
            model: 'broke-bot-heuristic',
            latencyMs: 0,
            retried: false,
            userPrompt: `[Heuristic] Broke bot gate — cash=${snapshot.bot.money}M, discarding hand`,
          };
        } else {
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

          // ── JIRA-105: Consume upgradeOnRoute from LLM route plan ──
          if (activeRoute.upgradeOnRoute) {
            const upgradeResult = AIStrategyEngine.tryConsumeUpgrade(activeRoute, snapshot, tag, memory.deliveryCount ?? 0);
            if (upgradeResult) {
              pendingUpgradeAction = upgradeResult;
            }
          }

          // ── JIRA-89: Dead load check + secondary delivery planning ──
          const trainCapacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
          const deadLoads = PlanExecutor.findDeadLoads(snapshot.bot.loads, snapshot.bot.resolvedDemands);
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
              currentCapacity < 3
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
                    console.log(`${tag} JIRA-105b: Upgrade-before-drop → skip — ${upgradeResult?.reasoning ?? 'LLM returned null'}`);
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

          // Execute the first step of the new route
          const execResult = await PlanExecutor.execute(activeRoute, snapshot, context);

          // JIRA-89: Prepend dead load drops to the route plan so they execute first
          let routePlan: TurnPlan = execResult.plan;
          if (deadLoadDropPlans.length > 0) {
            const routeSteps = routePlan.type === 'MultiAction' ? routePlan.steps : [routePlan];
            routePlan = { type: 'MultiAction' as const, steps: [...deadLoadDropPlans, ...routeSteps] };
            console.log(`${tag} JIRA-89: Prepended ${deadLoadDropPlans.length} dead load drop(s) to route plan`);
          }

          decision = {
            plan: routePlan,
            reasoning: `[route-planned] ${activeRoute.reasoning}. ${execResult.description}`,
            planHorizon: `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
            model: routeResult.model ?? 'unknown',
            latencyMs: routeResult.latencyMs ?? 0,
            tokenUsage: routeResult.tokenUsage,
            retried: false,
            llmLog: routeResult.llmLog,
            systemPrompt: routeResult.systemPrompt,
            userPrompt: routeResult.userPrompt,
          };

          if (execResult.routeComplete) {
            routeWasCompleted = true;
          } else if (execResult.routeAbandoned) {
            routeWasAbandoned = true;
          } else {
            activeRoute = execResult.updatedRoute;
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
        } // close broke-bot-gate else
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
      // ── JIRA-119: Gate 2 — suppress pending upgrade if delivery count too low ──
      if (pendingUpgradeAction) {
        const effectiveDeliveryCount = memory.deliveryCount ?? 0;
        if (effectiveDeliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) {
          console.warn(`${tag} JIRA-119: Suppressed pending upgrade — only ${effectiveDeliveryCount} deliveries (need ${MIN_DELIVERIES_BEFORE_UPGRADE})`);
          pendingUpgradeAction = null;
        }
      }
      if (pendingUpgradeAction) {
        const existingSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        decision.plan = { type: 'MultiAction' as const, steps: [...existingSteps, pendingUpgradeAction] };
        console.log(`${tag} JIRA-105: Injected UpgradeTrain(${pendingUpgradeAction.targetTrain}) into turn plan`);
      }

      // ── Stage 3b: Compose full turn (fill missing phases) ──
      let compositionResult = await TurnComposer.compose(decision.plan, snapshot, context, activeRoute, brain, gridPoints);
      decision.plan = compositionResult.plan;
      let compositionTrace = compositionResult.trace;

      // ── Stage 3.5: TurnValidator — validate composed plan against hard gates ──
      let recomposeCount = 0;
      let validationResult = TurnValidator.validate(decision.plan, context, snapshot);
      const firstValidationViolation = validationResult.valid ? undefined : validationResult.violation;
      // JIRA-145: Preserve original advisor trace before recomposition overwrites it
      const firstCompositionTrace = !validationResult.valid ? compositionTrace : undefined;

      while (!validationResult.valid && recomposeCount < MAX_RECOMPOSE_ATTEMPTS) {
        recomposeCount++;
        console.warn(`${tag} [TurnValidator] Hard gate violation: ${validationResult.violation} — re-composing (attempt ${recomposeCount}/${MAX_RECOMPOSE_ATTEMPTS}). Pre-recompose plan: ${JSON.stringify(decision.plan.type === 'MultiAction' ? decision.plan.steps.map((s: any) => ({ type: s.type, segs: s.segments?.length ?? 0 })) : { type: decision.plan.type, segs: (decision.plan as any).segments?.length ?? 0 })}`);

        // Strip the violating Phase B actions (BUILD/UPGRADE) from the primary plan and re-compose
        const strippedSteps = (decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan])
          .filter(s => s.type !== AIActionType.BuildTrack && s.type !== AIActionType.UpgradeTrain);
        const strippedPlan: TurnPlan = strippedSteps.length === 0
          ? { type: AIActionType.PassTurn as const }
          : strippedSteps.length === 1
            ? strippedSteps[0]
            : { type: 'MultiAction' as const, steps: strippedSteps };

        compositionResult = await TurnComposer.compose(strippedPlan, snapshot, context, activeRoute, brain, gridPoints);
        decision.plan = compositionResult.plan;
        compositionTrace = compositionResult.trace;
        validationResult = TurnValidator.validate(decision.plan, context, snapshot);
      }

      if (!validationResult.valid) {
        console.warn(`${tag} [TurnValidator] Exhausted ${MAX_RECOMPOSE_ATTEMPTS} re-composition attempts — proceeding with best-effort plan. Violation: ${validationResult.violation}`);
      }

      logPhase('Turn Validation', [], null, null, {
        turnValidation: {
          hardGates: validationResult.hardGates,
          outcome: validationResult.valid ? 'passed' : 'hard_reject',
          recomposeCount,
          firstViolation: recomposeCount > 0 ? firstValidationViolation : undefined,
        },
      });

      // ── Stage 3c: Sync route after TurnComposer delivery ──
      // TurnComposer.scanPathOpportunities may deliver loads along a MOVE path.
      // Detect deliveries inside composed MultiAction steps to advance the route.
      const composedSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
      const hasDelivery = composedSteps.some(s => s.type === AIActionType.DeliverLoad);

      if (activeRoute && !routeWasCompleted && !routeWasAbandoned) {
        const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
        if (currentStop?.action === 'deliver') {
          const matchesRouteStop = composedSteps.some(
            s => s.type === AIActionType.DeliverLoad &&
              'load' in s && s.load === currentStop.loadType,
          );
          if (matchesRouteStop) {
            const isLastStop = activeRoute.currentStopIndex >= activeRoute.stops.length - 1;
            if (isLastStop) {
              routeWasCompleted = true;
              console.log(`${tag} Route completed via TurnComposer delivery of ${currentStop.loadType}`);
            } else {
              activeRoute = {
                ...activeRoute,
                currentStopIndex: activeRoute.currentStopIndex + 1,
                phase: 'build',
              };
              console.log(`${tag} Route advanced via TurnComposer delivery of ${currentStop.loadType}`);
            }
          }
        }
      }

      // Clear active route after any delivery — new demand card drawn means
      // LLM should re-evaluate the route on the next turn.
      // BE-010: Preserve remaining stops for LLM context on next turn.
      // JIRA-64: Save pre-clear route for post-delivery LLM re-evaluation.
      // JIRA-83: Capture preDeliveryRoute even when routeWasCompleted — the completed
      // route still has valuable context for LLM re-evaluation (demand strategy, stops served).
      let preDeliveryRoute: StrategicRoute | null = null;
      if (hasDelivery && activeRoute && !routeWasAbandoned) {
        preDeliveryRoute = activeRoute;
      }
      if (hasDelivery && activeRoute && !routeWasCompleted && !routeWasAbandoned) {
        const remaining = activeRoute.stops.slice(activeRoute.currentStopIndex);
        if (remaining.length > 0) {
          previousRouteStops = remaining;
          console.log(`${tag} Delivery detected — preserving ${remaining.length} remaining route stops for LLM context`);
        } else {
          console.log(`${tag} Delivery detected — no remaining stops, clearing active route`);
        }
        activeRoute = null;
      }

      // ── Stage 3d: Post-delivery TripPlanner call (JIRA-126) ──
      // After any delivery, the bot has a new demand card. TripPlanner generates a fresh
      // multi-stop trip plan from scratch, replacing the old re-eval system.
      let reEvalHandled = false;
      let earlyExecutedSteps: TurnPlan[] = [];
      if (
        hasDelivery
        && AIStrategyEngine.hasLLMApiKey(botConfig)
      ) {
        try {
          // JIRA-91: Execute delivery steps (everything through last DeliverLoad) against DB
          // before the LLM call so capture() returns real post-delivery state with new demand card.
          const lastDelivIdx = (() => {
            for (let i = composedSteps.length - 1; i >= 0; i--) {
              if (composedSteps[i].type === AIActionType.DeliverLoad) return i;
            }
            return -1;
          })();
          earlyExecutedSteps = composedSteps.slice(0, lastDelivIdx + 1);
          await TurnExecutor.executePlan(
            { type: 'MultiAction' as const, steps: earlyExecutedSteps },
            ActionResolver.cloneSnapshot(snapshot),
          );
          console.log(`${tag} JIRA-91: Early-executed ${earlyExecutedSteps.length} delivery steps`);

          // Now capture() returns real DB state with new demand card, updated money, correct loads
          const freshSnap = await capture(gameId, botPlayerId);
          const freshContext = await ContextBuilder.build(freshSnap, skillLevel, gridPoints);
          const postDeliveryTripPlanner = new TripPlanner(brain!);
          const llmStart = Date.now();

          let newRoute: StrategicRoute | null = null;
          let reEvalReasoning: string | null = null;

          // JIRA-126: Use TripPlanner for all post-delivery planning (both route-completed and mid-route)
          console.log(`${tag} JIRA-126: Post-delivery trip planning with fresh state`);
          // Build a city-aware user prompt when loads are available for pickup at current location
          let reEvalUserPrompt: string | undefined;
          if (freshContext.canPickup.length > 0) {
            const cityName = freshContext.position?.city ?? 'current city';
            const loadList = freshContext.canPickup.map(p => `${p.loadType} (best: ${p.bestPayout}M → ${p.bestDeliveryCity})`).join(', ');
            reEvalUserPrompt = `You are at ${cityName} and can pick up: ${loadList}. ` +
              `Plan the best multi-stop trip. Can you find a profitable route that delivers multiple loads from here, ` +
              `or picks up multiples of one load type? Consider all 3 demand cards simultaneously.`;
          }
          const tripResult = await postDeliveryTripPlanner.planTrip(freshSnap, freshContext, gridPoints, memory, reEvalUserPrompt);
          const llmMs = Date.now() - llmStart;

          // Always capture llmLog from tripResult (even on failure)
          if (tripResult.llmLog?.length) {
            decision.llmLog = [...(decision.llmLog ?? []), ...tripResult.llmLog];
          }
          if (tripResult.route) {
            newRoute = tripResult.route;
            reEvalReasoning = newRoute.reasoning ?? null;
            // Fix: surface LLM model/latency so NDJSON log reflects the actual LLM call
            decision.model = 'trip-planner';
            decision.latencyMs = llmMs;
            if ((tripResult as TripPlanResult).llmTokens) decision.tokenUsage = (tripResult as TripPlanResult).llmTokens;
            console.log(`${tag} JIRA-126: Post-delivery trip plan: ${newRoute.stops.length} stops, reasoning=${newRoute.reasoning} (${llmMs}ms)`);
            logPhase('trip-planning', [], null, null, { llmReasoning: `trip-plan: ${newRoute.reasoning}`, llmLatencyMs: llmMs });
          } else {
            console.warn(`${tag} JIRA-126: Post-delivery trip planning failed (${llmMs}ms) — falling through to heuristic`);
          }

          if (newRoute) {
            // JIRA-129: Update activeRoute IMMEDIATELY so Phase B composition
            // (tryAppendBuild, upgrade logic) sees the new route, not stale state.
            activeRoute = newRoute;

            const planSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
            let wastedMovement = compositionTrace.moveBudget?.wasted ?? 0;

            // JIRA-90: When route completed, A2 heuristic continuations consumed movement
            // that should be redirected toward the new LLM-planned route. Strip post-delivery
            // A2 steps and reclaim their movement budget.
            let coreSteps = planSteps;
            if (routeWasCompleted) {
              const lastDeliveryIdx = (() => {
                for (let i = planSteps.length - 1; i >= 0; i--) {
                  if (planSteps[i].type === AIActionType.DeliverLoad) return i;
                }
                return -1;
              })();
              if (lastDeliveryIdx >= 0 && lastDeliveryIdx < planSteps.length - 1) {
                const postDeliverySteps = planSteps.slice(lastDeliveryIdx + 1);
                // Calculate movement used by post-delivery heuristic steps
                const majorCityLookup = getMajorCityLookup();
                let reclaimedMovement = 0;
                for (const step of postDeliverySteps) {
                  if (step.type === AIActionType.MoveTrain) {
                    reclaimedMovement += computeEffectivePathLength((step as TurnPlanMoveTrain).path, majorCityLookup);
                  }
                }
                if (reclaimedMovement > 0) {
                  coreSteps = planSteps.slice(0, lastDeliveryIdx + 1);
                  wastedMovement += reclaimedMovement;
                  console.log(`${tag} JIRA-90: Reclaimed ${reclaimedMovement}mp from ${postDeliverySteps.length} A2 heuristic steps for LLM-guided replanning`);
                }
              }
            }

            // JIRA-91: Simulate remaining core steps against fresh post-delivery state.
            // Delivery steps are already executed against DB, so skip them in simulation.
            const postDeliveryCoreSteps = coreSteps.slice(earlyExecutedSteps.length);
            const simSnapshot = ActionResolver.cloneSnapshot(freshSnap);
            const simContext = { ...freshContext, speed: wastedMovement };
            for (const step of postDeliveryCoreSteps) {
              ActionResolver.applyPlanToState(step, simSnapshot, simContext);
            }

            // Execute route step with remaining movement (if any)
            let reCompSteps: typeof planSteps = [];
            if (wastedMovement > 0) {
              const routeExec = await PlanExecutor.execute(newRoute, simSnapshot, simContext);
              if (routeExec.plan.type !== AIActionType.PassTurn) {
                const reComposition = await TurnComposer.compose(routeExec.plan, simSnapshot, simContext, newRoute, brain, gridPoints);
                reCompSteps = reComposition.plan.type === 'MultiAction'
                  ? reComposition.plan.steps : [reComposition.plan];

                compositionTrace.a2.terminationReason = `re-eval → ${reComposition.trace.a2.terminationReason}`;
                compositionTrace.moveBudget.wasted = reComposition.trace.moveBudget.wasted;
              }
            }

            // JIRA-100: Apply reCompSteps to sim state before build phase
            for (const step of reCompSteps) {
              ActionResolver.applyPlanToState(step, simSnapshot, simContext);
            }

            // ── JIRA-105: Consume upgradeOnRoute from post-delivery new route ──
            let postDeliveryUpgrade: TurnPlanUpgradeTrain | null = null;
            if (newRoute.upgradeOnRoute) {
              const upgradeResult = AIStrategyEngine.tryConsumeUpgrade(newRoute, simSnapshot, tag, (memory.deliveryCount ?? 0) + 1);
              if (upgradeResult) {
                postDeliveryUpgrade = upgradeResult;
              }
            }

            // Re-compose build phase targeting the new route, replacing old build step
            // JIRA-100: Skip if reCompSteps already contains a BUILD (game rule: one build per turn)
            // JIRA-105: Skip build if upgrade is pending (game rule: upgrade replaces build)
            const reCompHasBuild = reCompSteps.some(s => s.type === AIActionType.BuildTrack);
            const skipBuildForUpgrade = postDeliveryUpgrade !== null;
            const reBuildResult = (reCompHasBuild || skipBuildForUpgrade) ? { plan: null } : await TurnComposer.tryAppendBuild(simSnapshot, simContext, newRoute, undefined, brain, gridPoints);
            const phaseBAction = postDeliveryUpgrade ?? reBuildResult.plan;
            if (phaseBAction) {
              const nonBuildSteps = coreSteps.filter(s => s.type !== AIActionType.BuildTrack);
              decision.plan = { type: 'MultiAction' as const, steps: [...nonBuildSteps, ...reCompSteps, phaseBAction] };
              if (postDeliveryUpgrade) {
                console.log(`${tag} JIRA-105: Post-delivery upgrade to ${postDeliveryUpgrade.targetTrain} (replacing build phase)`);
              } else {
                console.log(`${tag} JIRA-90: Re-targeted build phase toward ${(phaseBAction as any).targetCity ?? 'new route'}`);
              }
            } else if (reCompSteps.length > 0) {
              decision.plan = { type: 'MultiAction' as const, steps: [...coreSteps, ...reCompSteps] };
            }

            console.log(`${tag} JIRA-90: Post-delivery re-composed with ${reCompSteps.length} movement steps + build retarget (reclaimed ${wastedMovement}mp)`);
            reEvalHandled = true;

            // JIRA-109: Update debug overlay fields to reflect post-re-eval route
            decision.planHorizon = `Route: ${newRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;
            if (reEvalReasoning) {
              decision.reasoning = `${decision.reasoning} | [re-eval] ${reEvalReasoning}`;
            }
          }
        } catch (err) {
          console.warn(`${tag} JIRA-86: Post-delivery LLM call error, keeping existing plan:`, err instanceof Error ? err.message : err);
        }
      }

      // ── Stage 3e: Continuation after route completion ──
      // When the route just completed, fill remaining budget with a heuristic action.
      // JIRA-83: Skip if re-eval already handled continuation with LLM-guided route.
      if (routeWasCompleted && !reEvalHandled) {
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

      // JIRA-91: Strip delivery steps that were already executed against DB in Stage 3d.
      // These steps must not be re-executed in Stage 5 or checked by guardrails.
      if (earlyExecutedSteps.length > 0) {
        const planSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        const remainingSteps = planSteps.slice(earlyExecutedSteps.length);
        decision.plan = remainingSteps.length === 0
          ? { type: AIActionType.PassTurn as const }
          : remainingSteps.length === 1
            ? remainingSteps[0]
            : { type: 'MultiAction' as const, steps: remainingSteps };
        console.log(`${tag} JIRA-91: Stripped ${earlyExecutedSteps.length} early-executed delivery steps from plan, ${remainingSteps.length} steps remain`);
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
      let guardrailResult = await GuardrailEnforcer.checkPlan(decision.plan, context, snapshot, memory.noProgressTurns, activeRoute != null);
      let finalPlan: TurnPlan = guardrailResult.plan;
      let originalPlan: { action: string; reasoning: string } | undefined;

      if (guardrailResult.overridden) {
        console.log(`${tag} Guardrail override: ${guardrailResult.reason}`);
        decision.guardrailOverride = true;
        originalPlan = preGuardrailPlan;
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
      const isActivelyTraveling = activeRoute != null;
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
      // JIRA-99/JIRA-129: When reEvalHandled is true, Stage 3d already set activeRoute to the
      // replacement route immediately after TripPlanner validation. Don't clear it — let the else-if branch save it.
      if ((routeWasCompleted || routeWasAbandoned) && !reEvalHandled) {
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
      } else if (reEvalHandled && activeRoute) {
        // JIRA-99: Route completed but Stage 3d planned a replacement — log the old
        // route as completed AND save the new replacement route.
        const routeToLog = memory.activeRoute;
        if (routeToLog) {
          memoryPatch.routeHistory = [
            ...(memory.routeHistory ?? []),
            { route: routeToLog, outcome: 'completed', turns: memory.turnsOnRoute + 1 },
          ];
        }
        memoryPatch.activeRoute = activeRoute;
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

      updateMemory(gameId, botPlayerId, memoryPatch);

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

        // JIRA-126: Post-delivery route re-evaluation replaced by TripPlanner.
        // Stage 3d now handles all post-delivery planning via TripPlanner.planTrip().
        // If Stage 3d didn't handle it (reEvalHandled=false), restore previous route.
        if (!reEvalHandled && activeRoute == null && preDeliveryRoute) {
          activeRoute = preDeliveryRoute;
          memoryPatch.activeRoute = activeRoute;
        }
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
        supplyCityCounts.get(d.loadType)!.add(d.supplyCity);
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

      // INF-001: Compute hand quality for audit logging
      const handQuality = AIStrategyEngine.computeHandQuality(freshDemands, snapshot.turnNumber, snapshot.bot.money);
      const bestDemandTurns = freshDemands.length > 0
        ? Math.min(...freshDemands.map(d => d.estimatedTurns))
        : 0;
      console.log(`${tag} [Hand Quality] score=${handQuality.score} (threshold=3.0), stale cards: ${handQuality.staleCards}, best demand: ${bestDemandTurns} turns`);

      // JIRA-32: Extract movement data from composed plan for game log
      // JIRA-36: Also extract concatenated movement path for client animation
      // JIRA-116: Prepend early-executed MOVE paths so movementPath reflects the complete turn trajectory
      let milepostsMoved: number | undefined;
      let trackUsageFee: number | undefined;
      const movementPath: { row: number; col: number }[] = [];
      // JIRA-144: Declare before earlyExecutedSteps loop so both loops contribute
      const loadsDelivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];
      const loadsPickedUp: Array<{ loadType: string; city: string }> = [];
      // Extract MOVE paths, deliveries, and pickups from early-executed steps (stripped by JIRA-91) before processing finalPlan
      for (const earlyStep of earlyExecutedSteps) {
        if (earlyStep.type === AIActionType.MoveTrain && 'path' in earlyStep && (earlyStep as any).path?.length > 0) {
          const path = (earlyStep as any).path as Array<{ row: number; col: number }>;
          milepostsMoved = (milepostsMoved ?? 0) + computeEffectivePathLength(path, getMajorCityLookup());
          trackUsageFee = (trackUsageFee ?? 0) + ((earlyStep as any).totalFee ?? 0);
          const last = movementPath[movementPath.length - 1];
          const first = path[0];
          const startIndex = (last && last.row === first.row && last.col === first.col) ? 1 : 0;
          movementPath.push(...path.slice(startIndex));
        }
        if (earlyStep.type === AIActionType.DeliverLoad && 'load' in earlyStep && 'city' in earlyStep) {
          loadsDelivered.push({
            loadType: (earlyStep as any).load as string,
            city: (earlyStep as any).city as string,
            payment: (earlyStep as any).payout ?? 0,
            cardId: (earlyStep as any).cardId ?? 0,
          });
        }
        if (earlyStep.type === AIActionType.PickupLoad && 'load' in earlyStep && 'city' in earlyStep) {
          loadsPickedUp.push({
            loadType: (earlyStep as any).load as string,
            city: (earlyStep as any).city as string,
          });
        }
      }
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
        actionBreakdown: actionBreakdown.length > 0 ? actionBreakdown : undefined,
        demandRanking,
        // JIRA-19: LLM decision metadata
        model: decision.model,
        llmLatencyMs: decision.latencyMs,
        tokenUsage: decision.tokenUsage,
        retried: decision.retried,
        handQuality,
        upgradeAdvice: context.upgradeAdvice,
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
      updateMemory(gameId, botPlayerId, {
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
   * INF-001: Compute hand quality metrics from demand contexts.
   * Groups demands by card, picks the best demand per card, then averages scores.
   */
  private static computeHandQuality(
    demands: DemandContext[],
    turnNumber: number,
    money: number = Infinity,
  ): { score: number; staleCards: number; assessment: string } {
    if (demands.length === 0) {
      return { score: 0, staleCards: 0, assessment: 'Poor' };
    }

    // Group by cardIndex, pick best demand per card
    const cardGroups = new Map<number, DemandContext[]>();
    for (const d of demands) {
      if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
      cardGroups.get(d.cardIndex)!.push(d);
    }

    let totalBestScore = 0;
    let staleCards = 0;
    for (const [, cardDemands] of cardGroups) {
      const best = cardDemands.reduce((a, b) => a.demandScore > b.demandScore ? a : b);
      totalBestScore += best.demandScore;
      // Cards held for 12+ turns are stale
      if (best.estimatedTurns >= 12) staleCards++;
    }

    const avgScore = totalBestScore / cardGroups.size;

    // JIRA-71: If bot is broke (cash < 5M) and no demand is affordable, clamp to "Poor"
    const isBroke = money < 5 && demands.every(d => !d.isAffordable);
    const assessment = isBroke ? 'Poor' : avgScore >= 3 ? 'Good' : avgScore >= 1 ? 'Fair' : 'Poor';

    return {
      score: isBroke ? 0 : Math.round(avgScore * 100) / 100,
      staleCards,
      assessment,
    };
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
  private static tryConsumeUpgrade(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    tag: string,
    deliveryCount: number,
  ): TurnPlanUpgradeTrain | null {
    const targetTrain = route.upgradeOnRoute!;
    route.upgradeOnRoute = undefined; // one-time consumption

    // JIRA-119: Gate 1 — block upgrade before sufficient deliveries
    if (deliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) {
      console.warn(`${tag} JIRA-119: upgradeOnRoute blocked — only ${deliveryCount} deliveries (need ${MIN_DELIVERIES_BEFORE_UPGRADE})`);
      return null;
    }

    // Validate upgrade path using ActionResolver.UPGRADE_PATHS
    const currentTrain = snapshot.bot.trainType;
    const paths = ActionResolver.UPGRADE_PATHS[currentTrain];
    if (!paths || !(targetTrain in paths)) {
      console.warn(`${tag} JIRA-105: upgradeOnRoute "${targetTrain}" invalid from "${currentTrain}" — skipping`);
      return null;
    }

    const cost = paths[targetTrain];
    if (snapshot.bot.money < cost) {
      console.warn(`${tag} JIRA-105: upgradeOnRoute "${targetTrain}" unaffordable (need ${cost}M, have ${snapshot.bot.money}M) — skipping`);
      return null;
    }

    console.log(`${tag} JIRA-105: Consuming upgradeOnRoute → ${targetTrain} (cost=${cost}M)`);
    return { type: AIActionType.UpgradeTrain, targetTrain, cost };
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
