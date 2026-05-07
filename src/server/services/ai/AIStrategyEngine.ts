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
import { ContextSerializer } from './prompts/ContextSerializer';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { GuardrailEnforcer } from './GuardrailEnforcer';
import { TurnExecutor } from './TurnExecutor';
import { ActionResolver } from './ActionResolver';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { appendLLMCall } from './LLMTranscriptLogger';
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
import { Stage3Result } from './schemas';
import { ActiveRouteContinuer } from './ActiveRouteContinuer';
import { InitialBuildRunner } from './InitialBuildRunner';
import { NewRoutePlanner } from './NewRoutePlanner';
import { UPGRADE_DELIVERY_THRESHOLD } from './context/UpgradeGatingConstants';

/**
 * @deprecated Use UPGRADE_DELIVERY_THRESHOLD from UpgradeGatingConstants instead.
 * Re-exported here for backward compatibility with any external callers.
 * JIRA-207A: Consolidated into UpgradeGatingConstants.ts.
 */
export const MIN_DELIVERIES_BEFORE_UPGRADE = UPGRADE_DELIVERY_THRESHOLD;

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
  // JIRA-210B: Trip planning results — single-route shape
  tripPlanning?: {
    trigger: string;
    stops?: string[];
    llmLatencyMs: number;
    llmTokens: { input: number; output: number };
    llmReasoning: string;
    fallbackReason?: 'no_actionable_options' | 'keep_current_plan';
  };
  // JIRA-126: Turn validation results
  turnValidation?: {
    hardGates: Array<{ gate: string; passed: boolean; detail?: string }>;
    outcome: 'passed' | 'hard_reject';
    recomposeCount: number;
    firstViolation?: string;
    firstHardGates?: Array<{ gate: string; passed: boolean; detail?: string }>;
    phaseBStripped?: boolean;
    /** JIRA-203: Termination reason distinguishing lockup recovery from legitimate PassTurn */
    lockupTerminationReason?: string;
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

    let snapshot: WorldSnapshot | undefined;
    try {
      // ── Stage 1: Capture world snapshot ──
      snapshot = await capture(gameId, botPlayerId);
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
          cityName: gridPoints.find(gp => gp.row === snapshot!.bot.position!.row && gp.col === snapshot!.bot.position!.col)?.city?.name,
        }
        : null;

      // ── Stage 2: Build game context ──
      // JIRA-195: Memory passed in so all memory-dependent fields (deliveryCount, upgradeAdvice,
      // enRoutePickups, previousTurnSummary) are computed correctly in a single pass.
      let context = await ContextBuilder.build(snapshot, skillLevel, gridPoints, memory);

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
      const debugUserPrompt = ContextSerializer.serializePrompt(context, skillLevel);
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
      // JIRA-194: Trip planning result (selection diagnostic for game log + LLM transcript)
      let tripPlanResult: import('./TripPlanner').TripPlanResult | null = null;

      if (context.isInitialBuild && (!activeRoute || activeRoute.phase !== 'build')) {
        // ── Initial build (delegated to InitialBuildRunner — JIRA-195b sub-slice C) ──
        const partial = await InitialBuildRunner.run(snapshot, context, brain, gridPoints, memory, tag);
        ({ activeRoute, decision, execCompositionTrace } = partial);
        initialBuildEvaluatedOptions = partial.evaluatedOptions;
        initialBuildEvaluatedPairings = partial.evaluatedPairings;
      } else if (activeRoute) {
        // ── Auto-execute from active route (delegated to ActiveRouteContinuer) ──
        const partial = await ActiveRouteContinuer.run(activeRoute, snapshot, context, brain, gridPoints, tag);
        ({ decision, activeRoute, routeWasCompleted, routeWasAbandoned, hasDelivery, execCompositionTrace, pendingUpgradeAction, upgradeSuppressionReason } = partial);
      } else if (AIStrategyEngine.hasLLMApiKey(botConfig)) {
        // ── No active route, LLM available — delegated to NewRoutePlanner (JIRA-195b sub-slice D) ──
        // NewRoutePlanner owns sub-stages D1-D7 + E. Returns the full Stage3Result
        // including reassigned snapshot and context (the JIRA-170 boundary becomes
        // explicit in the type system) plus autoDeliveredLoads and tripPlanResult
        // for downstream game/LLM logging.
        const stage3Partial = await NewRoutePlanner.run(
          snapshot, context, brain!, gridPoints, memory, tag,
          gameId, botPlayerId, skillLevel,
        );
        ({
          decision, activeRoute, routeWasCompleted, routeWasAbandoned, hasDelivery,
          secondaryDeliveryLog, pendingUpgradeAction, upgradeSuppressionReason,
          execCompositionTrace,
        } = stage3Partial);
        snapshot = stage3Partial.snapshot;
        context = stage3Partial.context;
        if (stage3Partial.deadLoadDropActions.length > 0) {
          deadLoadDropActions.push(...stage3Partial.deadLoadDropActions);
        }
        if (stage3Partial.autoDeliveredLoads.length > 0) {
          autoDeliveredLoads.push(...stage3Partial.autoDeliveredLoads);
        }
        if (stage3Partial.tripPlanResult) {
          tripPlanResult = stage3Partial.tripPlanResult;
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

      // ── JIRA-195b sub-slice A: Assemble Stage3Result from four-branch locals ──
      // The four decision branches still write to bare locals above; this temporary
      // assembly point makes the typed handoff contract explicit so that F1 (and
      // subsequent sub-stages in B/C/D) can read from a named record.
      const stage3: Stage3Result = {
        decision,
        activeRoute,
        routeWasCompleted,
        routeWasAbandoned,
        hasDelivery,
        previousRouteStops,
        secondaryDeliveryLog,
        deadLoadDropActions,
        pendingUpgradeAction,
        upgradeSuppressionReason,
        execCompositionTrace,
        snapshot,
        context,
      };

      // ── F1: JIRA-105: Inject pending upgrade action into decision plan (before TurnComposer) ──
      // JIRA-161: Gate 2 removed — redundant with Gate 1 in tryConsumeUpgrade and
      // the delivery count guard in the upgrade-before-drop path. Gate 2 used stale
      // memory.deliveryCount and silently blocked valid upgrades after the LLM decided to upgrade.
      if (stage3.pendingUpgradeAction) {
        const existingSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        const buildStepsDropped = existingSteps.filter(s => s.type === AIActionType.BuildTrack).length;
        const stepsWithoutBuild = existingSteps.filter(s => s.type !== AIActionType.BuildTrack);
        const newSteps = [...stepsWithoutBuild, stage3.pendingUpgradeAction];
        decision.plan = newSteps.length === 1
          ? newSteps[0]
          : { type: 'MultiAction' as const, steps: newSteps };
        console.log(`${tag} JIRA-105: Injected UpgradeTrain(${stage3.pendingUpgradeAction.targetTrain}) into turn plan${buildStepsDropped > 0 ? ` (dropped ${buildStepsDropped} BuildTrack step(s))` : ''}`);
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
      const firstValidationHardGates = validationResult.valid
        ? undefined
        : validationResult.hardGates.map(g => ({ ...g }));
      const phaseBWasStripped = !validationResult.valid;

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

      // ── JIRA-203: Stuck-state recovery (Phase B strip → PassTurn lockup defense) ──
      // When Phase B is stripped AND the post-strip plan is PassTurn AND we have an active
      // route AND the SAME gate caused the strip on the previous turn AND position hasn't
      // changed, the bot is in a lockup loop. Force RouteAbandoned (via DiscardHand) to
      // break out instead of grinding PassTurn forever.
      //
      // R5 trigger: same gate stripped on CONSECUTIVE turns AND position unchanged.
      // This avoids over-firing on legitimate one-turn strips (e.g., a CASH_SUFFICIENCY
      // gate that resolves after income arrives the next turn).
      let lockupTerminationReason: string | undefined;
      const postStripPlanType = decision.plan.type === 'MultiAction'
        ? (decision.plan.steps[0]?.type ?? AIActionType.PassTurn)
        : decision.plan.type;
      const hasActiveRouteForRecovery = activeRoute != null &&
        activeRoute.currentStopIndex < activeRoute.stops.length;

      if (
        phaseBWasStripped &&
        postStripPlanType === AIActionType.PassTurn &&
        hasActiveRouteForRecovery
      ) {
        // Identify the first failing hard gate from this strip
        const strippedGateName = firstValidationHardGates?.find(g => !g.passed)?.gate ?? null;
        const currentPos = snapshot.bot.position;

        // Check if this is the same gate on consecutive turns with unchanged position (R5)
        const prevGate = memory.lastPhaseBStrippedGate ?? null;
        const prevPos = memory.lastPositionWhenStripped ?? null;
        const positionUnchanged = currentPos != null && prevPos != null &&
          currentPos.row === prevPos.row && currentPos.col === prevPos.col;
        const sameGateConsecutive = strippedGateName != null &&
          prevGate === strippedGateName && positionUnchanged;

        if (sameGateConsecutive) {
          // Lockup detected: force RouteAbandoned + DiscardHand to break the cycle
          console.warn(
            `${tag} [JIRA-203] Stuck-state lockup detected: gate=${strippedGateName} stripped ` +
            `on consecutive turns at position (${currentPos!.row},${currentPos!.col}) — ` +
            `forcing RouteAbandoned + DiscardHand`,
          );
          decision.plan = { type: AIActionType.DiscardHand };
          routeWasAbandoned = true;
          activeRoute = null;
          lockupTerminationReason = 'lockup_route_abandoned';
        } else {
          // One-off strip — not a lockup yet. Surface informational trace only.
          lockupTerminationReason = 'phaseb_stripped_passturn';
          console.log(
            `${tag} [JIRA-203] Phase B stripped → PassTurn (gate=${strippedGateName ?? 'unknown'}). ` +
            `Not a consecutive lockup — no recovery fired this turn.`,
          );
        }
      }

      logPhase('Turn Validation', [], null, null, {
        turnValidation: {
          hardGates: validationResult.hardGates,
          outcome: validationResult.valid ? 'passed' : 'hard_reject',
          recomposeCount,
          firstViolation: firstValidationViolation,
          firstHardGates: firstValidationHardGates,
          phaseBStripped: phaseBWasStripped,
          lockupTerminationReason,
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
      // JIRA-199: tighten hasActiveRoute so an empty-stops or fully-exhausted route
      // is NOT treated as an active route — prevents the Stuck/Unaffordable guardrails
      // from being suppressed by a route that has already been consumed.
      const hasActiveRoute = activeRoute != null && activeRoute.currentStopIndex < activeRoute.stops.length;
      let guardrailResult = await GuardrailEnforcer.checkPlan(decision.plan, context, snapshot, hasActiveRoute);
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
      // JIRA-203: Track Phase B strip state for consecutive-turn stuck-state detection (R5).
      const strippedGateThisTurn = phaseBWasStripped
        ? (firstValidationHardGates?.find(g => !g.passed)?.gate ?? null)
        : null;
      const memoryPatch: Partial<typeof memory> = {
        lastAction: executedAction,
        consecutiveDiscards: executedAction === AIActionType.DiscardHand
          ? memory.consecutiveDiscards + 1 : 0,
        consecutiveLlmFailures: decision.model === 'heuristic-fallback' || decision.model === 'llm-failed'
            || (decision.model === 'route-executor' && decision.llmLog?.length && decision.llmLog.every(e => e.status !== 'success'))
          ? (memory.consecutiveLlmFailures ?? 0) + 1 : 0,
        deliveryCount: (memory.deliveryCount ?? 0) + (hasDelivery ? 1 : 0), // JIRA-60
        totalEarnings: (memory.totalEarnings ?? 0) + (result.payment ?? 0), // JIRA-60
        turnNumber: snapshot.turnNumber,
        lastReasoning: decision.reasoning ?? null,
        lastPlanHorizon: decision.planHorizon ?? null,
        // JIRA-203: Persist strip context for next turn's stuck-state detector
        lastPhaseBStrippedGate: strippedGateThisTurn,
        lastPositionWhenStripped: phaseBWasStripped ? (snapshot.bot.position ?? null) : null,
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
        context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
        console.log(
          `${tag} JIRA-165: Refreshed canDeliver after DiscardHand — ` +
          `${context.canDeliver.length} opportunit(ies) now in context`,
        );

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
      if (hasDelivery) {
        const freshSnapshot = await capture(gameId, botPlayerId);
        context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
        context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
        console.log(
          `${tag} JIRA-165: Refreshed canDeliver after delivery — ` +
          `${context.canDeliver.length} opportunit(ies) now in context`,
        );

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
        // JIRA-210B: Trip planning result — single-route shape (no candidates[], no chosen)
        tripPlanning: tripPlanResult ? {
          trigger: 'no-active-route',
          stops: tripPlanResult.route?.stops.map(s => `${s.action}(${s.loadType}@${s.city})`),
          llmLatencyMs: tripPlanResult.llmLatencyMs,
          llmTokens: tripPlanResult.llmTokens,
          llmReasoning: tripPlanResult.route?.reasoning ?? '',
          ...(tripPlanResult.selection ? {
            fallbackReason: tripPlanResult.selection.fallbackReason,
          } : {}),
        } : undefined,
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
          firstViolation: firstValidationViolation,
          firstHardGates: firstValidationHardGates,
          phaseBStripped: phaseBWasStripped,
          lockupTerminationReason,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      // JIRA-188: Diagnostic snapshot state at time of pipeline error
      console.error(
        `[AIStrategyEngine.takeTurn] JIRA-188 pipeline-error snapshot state:`,
        JSON.stringify({
          position: snapshot?.bot?.position ?? null,
          loads: snapshot?.bot?.loads ?? null,
          resolvedDemands: snapshot?.bot?.resolvedDemands?.map(r => ({
            cardId: r.cardId,
            demands: r.demands?.map((d: { city: string; loadType: string; payment: number }) => ({
              city: d.city,
              loadType: d.loadType,
              payment: d.payment,
            })),
          })) ?? null,
        }),
      );
      console.error(`${tag} PIPELINE ERROR (${durationMs}ms):`, error instanceof Error ? error.stack : error);

      // Update bot memory even on pipeline error
      await updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
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
    if (deliveryCount < UPGRADE_DELIVERY_THRESHOLD) {
      const reason = `only ${deliveryCount} deliveries (need ${UPGRADE_DELIVERY_THRESHOLD})`;
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

  /**
   * Resolve the Anthropic credential from environment variables.
   * Precedence:
   *   1. ANTHROPIC_USE_CLAUDE_CODE=1 → subscription mode (no API key needed).
   *   2. ANTHROPIC_API_KEY set        → api-key mode.
   *   3. Neither set                  → null (no LLM).
   *
   * ANTHROPIC_USE_CLAUDE_CODE is a strict opt-in: only the literal string '1'
   * activates subscription mode. Any other value (e.g. 'true') is ignored.
   * This prevents accidental activation in CI or production environments.
   *
   * Centralised here so hasLLMApiKey and createBrain share the same resolution logic.
   */
  private static resolveAnthropicCredential():
    | { credential: string; mode: 'api-key' | 'subscription' }
    | null {
    if (process.env['ANTHROPIC_USE_CLAUDE_CODE'] === '1') {
      return { credential: '', mode: 'subscription' };
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey) {
      return { credential: apiKey, mode: 'api-key' };
    }
    return null;
  }

  private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
    if (!botConfig) return false;
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    if (provider === LLMProvider.Anthropic) {
      return AIStrategyEngine.resolveAnthropicCredential() !== null;
    }
    const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
    return !!process.env[envKey];
  }

  /**
   * Create an LLMStrategyBrain instance from bot config.
   */
  private static createBrain(botConfig: BotConfig): LLMStrategyBrain {
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const skillLevel = (botConfig.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;

    let apiKey: string;
    let credentialMode: 'api-key' | 'subscription' | undefined;

    if (provider === LLMProvider.Anthropic) {
      const resolved = AIStrategyEngine.resolveAnthropicCredential();
      apiKey = resolved?.credential ?? '';
      credentialMode = resolved?.mode;
    } else {
      const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
      apiKey = process.env[envKey] ?? '';
    }

    return new LLMStrategyBrain({
      skillLevel,
      provider,
      model: botConfig.model,
      apiKey,
      credentialMode,
      timeoutMs: 30000,
      maxRetries: 1,
    });
  }
}
