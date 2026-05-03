/**
 * NewRoutePlanner — Sub-stages D1-D7 + E of the Stage 3 decision gate (JIRA-195b sub-slice D).
 *
 * Owns the no-active-route LLM consultation branch:
 *   D1 — JIRA-170 auto-delivery + snapshot/context refresh
 *   D2 — TripPlanner LLM call (JIRA-126/194)
 *   D3 — RouteEnrichmentAdvisor LLM call (JIRA-165/173)
 *   D4 — JIRA-105 upgrade consumption
 *   D5 — JIRA-89 dead-load drop staging
 *   D6 — JIRA-105b upgrade-before-drop + JIRA-92 cargo conflict (LLM)
 *   D7 — TurnExecutorPlanner.execute for first step + dead-load prefix
 *   E  — JIRA-120 LLM failure counter + heuristic fallback / pass-turn
 *
 * Returns the FULL Stage3Result (vs. Pick<...> for sibling branches) because
 * this branch is the only one that reassigns `snapshot` and `context` (JIRA-170).
 * The reassignment becomes explicit in the type system at the boundary instead
 * of an implicit shared-state side effect on the caller's outer locals.
 *
 * Two extra fields beyond Stage3Result propagate to the caller for downstream use:
 *   - autoDeliveredLoads — JIRA-170 deliveries logged in BotTurnResult
 *   - tripPlanResult     — JIRA-194 selection diagnostic for game/LLM logs
 *
 * Pure code motion from AIStrategyEngine.ts sub-stages D1-D7 + E (lines 278-614).
 * All four LLM call sites preserved verbatim with their existing try/catch shapes.
 * Zero behaviour change.
 */

import {
  WorldSnapshot,
  AIActionType,
  BotSkillLevel,
  LLMDecisionResult,
  TurnPlan,
  StrategicRoute,
  GameContext,
  GridPoint,
  TurnPlanDropLoad,
  TurnPlanDeliverLoad,
  TurnPlanUpgradeTrain,
  TRAIN_PROPERTIES,
  TrainType,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { ContextSerializer } from './prompts/ContextSerializer';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TurnExecutor } from './TurnExecutor';
import { ActionResolver } from './ActionResolver';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { appendLLMCall } from './LLMTranscriptLogger';
import { TripPlanner, TripPlanResult } from './TripPlanner';
import { loadGridPoints as loadGridPointsMap } from './MapTopology';
import type { Stage3Result } from './schemas';

/**
 * Minimum number of completed deliveries before a bot may upgrade its train.
 * Mirrors the constant in AIStrategyEngine.ts (single source of truth re-imported here
 * to avoid a circular import). Keep in lockstep with the canonical export.
 */
const MIN_DELIVERIES_BEFORE_UPGRADE = 2;

/**
 * NewRoutePlanner result — full Stage3Result plus two diagnostic fields the
 * caller's outer scope still needs for game/LLM logging.
 */
export interface NewRoutePlannerResult extends Stage3Result {
  autoDeliveredLoads: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  tripPlanResult: TripPlanResult | null;
}

export class NewRoutePlanner {
  /**
   * Run the no-active-route LLM consultation branch for one turn.
   *
   * Caller must verify `brain` is non-null (no-LLM-key path stays inline in the
   * orchestrator per ADR-2). On entry, `activeRoute` is null; on return, it may be
   * a fresh planned route or null (heuristic-fallback or pass-turn paths).
   *
   * @param snapshot     World state at decision time. May be reassigned internally
   *                     by JIRA-170 auto-delivery refresh; the final value is
   *                     returned via `result.snapshot`.
   * @param context      Decision-relevant context. May be reassigned internally
   *                     by JIRA-170; final value returned via `result.context`.
   * @param brain        LLM brain — required (caller has already verified).
   * @param gridPoints   Hex-grid topology for path planning.
   * @param memory       Bot memory state (deliveryCount, consecutiveLlmFailures).
   * @param tag          Log prefix for traceability.
   * @param gameId       Game UUID — needed for snapshot refresh + LLM transcript log.
   * @param botPlayerId  Bot player UUID — needed for snapshot refresh + LLM transcript log.
   * @param skillLevel   Bot skill level — gates JIRA-92 cargo-conflict LLM call.
   * @returns Full Stage3Result + autoDeliveredLoads + tripPlanResult.
   */
  static async run(
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    tag: string,
    gameId: string,
    botPlayerId: string,
    skillLevel: BotSkillLevel,
  ): Promise<NewRoutePlannerResult> {
    let decision: LLMDecisionResult;
    let activeRoute: StrategicRoute | null = null;
    let routeWasCompleted = false;
    let routeWasAbandoned = false;
    let hasDelivery = false;
    let secondaryDeliveryLog: Stage3Result['secondaryDeliveryLog'];
    const deadLoadDropActions: TurnPlanDropLoad[] = [];
    let pendingUpgradeAction: TurnPlanUpgradeTrain | null = null;
    let upgradeSuppressionReason: string | null = null;
    let execCompositionTrace: CompositionTrace | null = null;
    const autoDeliveredLoads: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];
    let tripPlanResult: TripPlanResult | null = null;

    // ── D1: JIRA-170 Auto-deliver before LLM consultation ──
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
      // JIRA-195: Pass memory so memory-dependent fields are computed correctly in a single pass.
      if (autoDeliveredLoads.length > 0) {
        try {
          snapshot = await capture(gameId, botPlayerId);
          context = await ContextBuilder.build(snapshot, skillLevel, gridPoints, memory);
          console.log(`${tag} [JIRA-170] Refreshed snapshot and context after auto-delivery`);
        } catch (refreshErr) {
          console.warn(`${tag} [JIRA-170] Failed to refresh context after auto-delivery: ${(refreshErr as Error).message}`);
        }
      }
    }

    // ── D2: TripPlanner — consult for a new multi-stop trip (JIRA-126) ──
    const tripPlanner = new TripPlanner(brain);

    const tripResult = await tripPlanner.planTrip(snapshot, context, gridPoints, memory);
    // JIRA-210B: TripPlanResult is now a flat type — no cast needed.
    // Capture result for downstream log writer if route was planned.
    if (tripResult.route) {
      tripPlanResult = tripResult;
      // Write LLM transcript entry when short-circuit diagnostic is present
      if (tripResult.selection) {
        appendLLMCall(gameId, {
          callId: `trip-planner-selection-${snapshot.turnNumber}-${botPlayerId}`,
          gameId,
          playerId: botPlayerId,
          playerName: (snapshot.bot.botConfig as { name?: string } | null)?.name,
          turn: snapshot.turnNumber,
          timestamp: new Date().toISOString(),
          caller: 'trip-planner',
          method: 'shortCircuit',
          model: brain.modelName,
          systemPrompt: '',
          userPrompt: '',
          responseText: '',
          status: 'success',
          latencyMs: 0,
          attemptNumber: 1,
          totalAttempts: 1,
          tripPlannerSelection: tripResult.selection,
        });
      }
    }

    // JIRA-207B (R10e): Handle keep_current_plan — the bot has carried loads but no new
    // options. Preserve the existing activeRoute (null here) and skip heuristic-fallback.
    // In practice this fires when carry-loads exist but no affordable new card is available.
    // The turn will proceed to movement/build phases without a new plan being forced.
    if (!tripResult.route && tripResult.selection?.fallbackReason === 'keep_current_plan') {
      console.log(`${tag} [NewRoutePlanner] keep_current_plan: no new options but carry-loads committed; skip replan`);
      return {
        decision: {
          plan: { type: AIActionType.PassTurn },
          reasoning: '[keep_current_plan] No new options; carry-load commitment preserved; proceeding to movement/build phases',
          planHorizon: 'Immediate',
          model: 'keep_current_plan',
          latencyMs: 0,
          retried: false,
          llmLog: tripResult.llmLog,
        },
        activeRoute,
        routeWasCompleted,
        routeWasAbandoned,
        hasDelivery,
        previousRouteStops: null,
        secondaryDeliveryLog,
        deadLoadDropActions,
        pendingUpgradeAction,
        upgradeSuppressionReason,
        snapshot,
        context,
        execCompositionTrace,
        autoDeliveredLoads,
        tripPlanResult: null,
      };
    }

    // Wrap tripResult into routeResult-compatible shape for downstream code
    const routeResult = tripResult.route
      ? { route: tripResult.route, model: 'trip-planner', latencyMs: tripResult.llmLatencyMs, tokenUsage: tripResult.llmTokens, llmLog: tripResult.llmLog, systemPrompt: tripResult.systemPrompt, userPrompt: tripResult.userPrompt }
      : { route: null as StrategicRoute | null, llmLog: tripResult.llmLog, systemPrompt: undefined as string | undefined, userPrompt: undefined as string | undefined };

    if (routeResult.route) {
      activeRoute = routeResult.route;
      console.log(`${tag} Trip planned: ${activeRoute.stops.length} stops, starting at ${activeRoute.startingCity ?? 'current position'}`);

      // ── D4: JIRA-105 — Consume upgradeOnRoute from LLM route plan ──
      if (activeRoute.upgradeOnRoute) {
        const { action: upgradeAction, reason: upgradeReason } = NewRoutePlanner.tryConsumeUpgrade(activeRoute, snapshot, tag, memory.deliveryCount ?? 0);
        if (upgradeAction) {
          pendingUpgradeAction = upgradeAction;
        } else if (upgradeReason) {
          upgradeSuppressionReason = upgradeReason;
        }
      }

      // ── D5: JIRA-89 — Dead load check + secondary delivery planning ──
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

      // ── D6: JIRA-92 — Cargo conflict check — drop carried loads blocking planned pickups ──
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
        skillLevel !== BotSkillLevel.Easy
      ) {
        console.log(`${tag} JIRA-92: Cargo conflict — route needs ${routePickupCount} pickup slots, only ${effectiveFreeSlots} free`);

        // ── D6a: JIRA-105b — Upgrade-before-drop check ──
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
              const upgradePrompt = ContextSerializer.serializeUpgradeBeforeDropPrompt(
                snapshot, activeRoute, upgradeOptions, totalRoutePayout, context.demands,
              );
              const upgradeResult = await brain.evaluateUpgradeBeforeDrop(upgradePrompt, snapshot, context);

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
              const cargoPrompt = ContextSerializer.serializeCargoConflictPrompt(snapshot, activeRoute, conflictingLoads, context.demands);
              const conflictResult = await brain.evaluateCargoConflict(cargoPrompt, snapshot, context);

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

      // ── D7: TurnExecutorPlanner — execute first step of new route ──
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
      // ── E: LLM fallback — JIRA-120 LLM failure counter + heuristic fallback / pass-turn ──
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

    return {
      decision,
      activeRoute,
      routeWasCompleted,
      routeWasAbandoned,
      hasDelivery,
      previousRouteStops: null,
      secondaryDeliveryLog,
      deadLoadDropActions,
      pendingUpgradeAction,
      upgradeSuppressionReason,
      execCompositionTrace,
      snapshot,
      context,
      autoDeliveredLoads,
      tripPlanResult,
    };
  }

  /**
   * Consume the LLM-emitted upgradeOnRoute hint into a concrete UpgradeTrain action,
   * subject to the JIRA-119 delivery-count gate, the upgrade-path table, and the
   * solvency check. Mirrors AIStrategyEngine.tryConsumeUpgrade verbatim — moved here
   * because this is the only caller after the JIRA-195b sub-slice D extraction.
   */
  static tryConsumeUpgrade(
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
}
