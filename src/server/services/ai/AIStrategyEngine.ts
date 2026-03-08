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
} from '../../../shared/types/GameTypes';
import { db } from '../../db/index';
import { getMajorCityGroups, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { gridToPixel } from './MapTopology';
import { getMemory, updateMemory } from './BotMemory';
import { initTurnLog, logPhase, flushTurnLog, LLMPhaseFields } from './DecisionLogger';

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
  demandRanking?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number; supplyRarity?: string; isStale?: boolean; efficiencyPerTurn?: number; estimatedTurns?: number; trackCostToSupply?: number; trackCostToDelivery?: number }>;
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

      // ── Stage 2: Build game context ──
      const context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);

      // JIRA-60: Inject delivery count from memory for upgrade advice gating
      context.deliveryCount = memory.deliveryCount ?? 0;

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
      let decision: LLMDecisionResult;
      let activeRoute = memory.activeRoute;
      let routeWasCompleted = false;
      let routeWasAbandoned = false;
      let previousRouteStops: RouteStop[] | null = null; // BE-010

      if (activeRoute) {
        // ── Auto-execute from active route (no LLM call) ──
        console.log(`${tag} Active route: stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`);
        const execResult = await PlanExecutor.execute(activeRoute, snapshot, context);

        decision = {
          plan: execResult.plan,
          reasoning: `[route-executor] ${execResult.description}`,
          planHorizon: `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
          model: 'route-executor',
          latencyMs: 0,
          retried: false,
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
        // ── No active route — consult LLM for a new strategic route ──
        const brain = AIStrategyEngine.createBrain(botConfig!);

        // Try to plan a route first (BE-010: pass previous route context)
        const routeResult = await brain.planRoute(snapshot, context, gridPoints, memory.lastAbandonedRouteKey, memory.previousRouteStops);

        if (routeResult) {
          activeRoute = routeResult.route;
          console.log(`${tag} New route planned: ${activeRoute.stops.length} stops, starting at ${activeRoute.startingCity ?? 'current position'}`);

          // Execute the first step of the new route
          const execResult = await PlanExecutor.execute(activeRoute, snapshot, context);

          decision = {
            plan: execResult.plan,
            reasoning: `[route-planned] ${activeRoute.reasoning}. ${execResult.description}`,
            planHorizon: `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
            model: routeResult.model,
            latencyMs: routeResult.latencyMs,
            tokenUsage: routeResult.tokenUsage,
            retried: false,
            llmLog: routeResult.llmLog,
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
          console.warn(`${tag} [LLM] Route planning failed — attempting heuristic fallback`);
          const fallback = await ActionResolver.heuristicFallback(context, snapshot);
          if (fallback.success && fallback.plan && fallback.plan.type !== AIActionType.PassTurn) {
            console.log(`${tag} [heuristic] Fallback produced ${fallback.plan.type}`);
            decision = {
              plan: fallback.plan,
              reasoning: `[heuristic-fallback] LLM planning failed — heuristic produced ${fallback.plan.type}`,
              planHorizon: 'Immediate',
              model: 'heuristic-fallback',
              latencyMs: 0,
              retried: false,
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
        };
      }

      console.log(`${tag} Decision: plan=${decision.plan.type}, model=${decision.model}, latency=${decision.latencyMs}ms, retried=${decision.retried}`);

      // ── Stage 3b: Compose full turn (fill missing phases) ──
      const compositionResult = await TurnComposer.compose(decision.plan, snapshot, context, activeRoute);
      decision.plan = compositionResult.plan;
      const compositionTrace = compositionResult.trace;

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

      // ── Stage 3e: Continuation after route completion ──
      // When the route just completed, fill remaining budget with a heuristic action.
      if (routeWasCompleted) {
        // Simulate plan effects so heuristicFallback sees post-route state
        const simSnapshot = ActionResolver.cloneSnapshot(snapshot);
        const simContext = { ...context };
        const planSteps = decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan];
        for (const step of planSteps) {
          ActionResolver.applyPlanToState(step, simSnapshot, simContext);
        }

        const continuation = await ActionResolver.heuristicFallback(simContext, simSnapshot);
        if (continuation.success && continuation.plan && continuation.plan.type !== AIActionType.PassTurn) {
          decision.plan = { type: 'MultiAction' as const, steps: [...planSteps, continuation.plan] };
          console.log(`${tag} Route complete — continuation ${continuation.plan.type}`);
        }
      }

      // ── Stage 4: Apply guardrails ──
      let guardrailResult = await GuardrailEnforcer.checkPlan(decision.plan, context, snapshot, memory.noProgressTurns);
      let finalPlan: TurnPlan = guardrailResult.plan;

      if (guardrailResult.overridden) {
        console.log(`${tag} Guardrail override: ${guardrailResult.reason}`);
        decision.guardrailOverride = true;
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
      // AND bot is NOT actively traveling with loads toward a delivery (JIRA-45).
      const hadDelivery = (result.payment ?? 0) > 0;
      const hadCashIncrease = result.remainingMoney > snapshot.bot.money;
      const hadNewTrack = result.segmentsBuilt > 0;
      const isActivelyTraveling = snapshot.bot.loads.length > 0 && activeRoute != null;
      const hadDiscard = executedAction === AIActionType.DiscardHand; // JIRA-59: discard = fresh cards = progress
      const madeProgress = hadDelivery || hadCashIncrease || hadNewTrack || isActivelyTraveling || hadDiscard;

      const memoryPatch: Partial<typeof memory> = {
        lastAction: executedAction,
        noProgressTurns: madeProgress ? 0 : (memory.noProgressTurns ?? 0) + 1,
        consecutiveDiscards: executedAction === AIActionType.DiscardHand
          ? memory.consecutiveDiscards + 1 : 0,
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

      // Build demand ranking from context for debug overlay (JIRA-13)
      // FE-001: Compute supply rarity per load type
      const supplyCityCounts = new Map<string, Set<string>>();
      for (const d of context.demands) {
        if (!supplyCityCounts.has(d.loadType)) supplyCityCounts.set(d.loadType, new Set());
        supplyCityCounts.get(d.loadType)!.add(d.supplyCity);
      }
      const demandRanking = [...context.demands]
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
          };
        });

      // INF-001: Compute hand quality for audit logging
      const handQuality = AIStrategyEngine.computeHandQuality(context.demands, snapshot.turnNumber);
      const bestDemandTurns = context.demands.length > 0
        ? Math.min(...context.demands.map(d => d.estimatedTurns))
        : 0;
      console.log(`${tag} [Hand Quality] score=${handQuality.score} (threshold=3.0), stale cards: ${handQuality.staleCards}, best demand: ${bestDemandTurns} turns`);

      // JIRA-32: Extract movement data from composed plan for game log
      // JIRA-36: Also extract concatenated movement path for client animation
      let milepostsMoved: number | undefined;
      let trackUsageFee: number | undefined;
      const movementPath: { row: number; col: number }[] = [];
      const allSteps = finalPlan.type === 'MultiAction' ? finalPlan.steps : [finalPlan];
      for (const step of allSteps) {
        if (step.type === AIActionType.MoveTrain) {
          milepostsMoved = (milepostsMoved ?? 0) + (step.path.length > 0 ? step.path.length - 1 : 0);
          trackUsageFee = (trackUsageFee ?? 0) + step.totalFee;
          if (step.path.length > 0) {
            const last = movementPath[movementPath.length - 1];
            const first = step.path[0];
            const startIndex = (last && last.row === first.row && last.col === first.col) ? 1 : 0;
            movementPath.push(...step.path.slice(startIndex));
          }
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
        compositionTrace,
        movementPath: movementPath.length > 0 ? movementPath : undefined,
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
        llmLatencyMs: 0,
        retried: false,
      };
    }
  }

  /**
   * INF-001: Compute hand quality metrics from demand contexts.
   * Groups demands by card, picks the best demand per card, then averages scores.
   */
  private static computeHandQuality(
    demands: DemandContext[],
    turnNumber: number,
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
    const assessment = avgScore >= 3 ? 'Good' : avgScore >= 1 ? 'Fair' : 'Poor';

    return {
      score: Math.round(avgScore * 100) / 100,
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
  private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
    if (!botConfig) return false;
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const envKey = provider === LLMProvider.Google ? 'GOOGLE_AI_API_KEY' : 'ANTHROPIC_API_KEY';
    return !!process.env[envKey];
  }

  /**
   * Create an LLMStrategyBrain instance from bot config.
   */
  private static createBrain(botConfig: BotConfig): LLMStrategyBrain {
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const skillLevel = (botConfig.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
    const envKey = provider === LLMProvider.Google ? 'GOOGLE_AI_API_KEY' : 'ANTHROPIC_API_KEY';
    const apiKey = process.env[envKey] ?? '';

    return new LLMStrategyBrain({
      skillLevel,
      provider,
      model: botConfig.model,
      apiKey,
      timeoutMs: skillLevel === BotSkillLevel.Easy ? 10000 : 15000,
      maxRetries: 1,
    });
  }
}
