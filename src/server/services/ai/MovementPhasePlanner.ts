/**
 * MovementPhasePlanner — Phase A of turn execution (JIRA-195 Slice 3b).
 *
 * Extracted from TurnExecutorPlanner.execute() Phase A logic. Runs the movement
 * loop, emits pick-up/deliver/move/drop plans, and delegates post-delivery
 * replanning to PostDeliveryReplanner.
 *
 * Returns PhaseAResult — the typed handoff record passed to BuildPhasePlanner.
 *
 * Key design decisions:
 *   - Static-method only class (no constructor, no state).
 *   - All four PostDeliveryReplanner sub-paths delegated to PostDeliveryReplanner.replan().
 *   - `new TripPlanner(brain)` does NOT appear here (AC4).
 *   - CompositionTrace fields a1/a2/a3 are populated for compatibility.
 */

import {
  TurnPlan,
  TurnPlanMoveTrain,
  TurnPlanUpgradeTrain,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  AIActionType,
  GridPoint,
  LlmAttempt,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { resolveBuildTarget, applyStopEffectToLocalState } from './routeHelpers';
import { computeBuildSegments } from './computeBuildSegments';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { ActionResolver } from './ActionResolver';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { TurnExecutor } from './TurnExecutor';
import { PostDeliveryReplanner } from './PostDeliveryReplanner';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { loadGridPoints as loadGridPointsMap } from './MapTopology';
import type { PhaseAResult } from './schemas';

// ── MovementPhasePlanner ──────────────────────────────────────────────────

/**
 * MovementPhasePlanner — Phase A orchestrator.
 *
 * Consumes the movement budget by advancing through route stops. Delegates
 * post-delivery replanning to PostDeliveryReplanner.replan(). Returns a
 * PhaseAResult carrying all state needed by BuildPhasePlanner.
 *
 * Static-method only; no constructor.
 */
export class MovementPhasePlanner {
  /**
   * Run Phase A: movement loop.
   *
   * Mirrors the Phase A logic from TurnExecutorPlanner.execute() lines 204-691.
   * Returns PhaseAResult — the typed handoff record for BuildPhasePlanner.
   *
   * @param route - Active strategic route.
   * @param snapshot - Current world snapshot (mutated for position/money sync).
   * @param context - Derived game context for this turn.
   * @param trace - Shared CompositionTrace to be populated during Phase A.
   * @param brain - Optional LLM strategy brain for PostDeliveryReplanner.
   * @param gridPoints - Optional pre-loaded grid points.
   * @returns PhaseAResult with accumulated plans and state for Phase B.
   */
  static async run(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    trace: CompositionTrace,
    brain?: LLMStrategyBrain | null,
    gridPoints?: GridPoint[],
  ): Promise<PhaseAResult> {
    const tag = '[MovementPhasePlanner]';

    // ── Skip completed stops ──────────────────────────────────────────────
    let activeRoute = TurnExecutorPlanner.skipCompletedStops(route, context);

    // ── Invariant: stop index must not decrease ──────────────────────────
    if (activeRoute.currentStopIndex < route.currentStopIndex) {
      throw new Error(
        `${tag} INVARIANT VIOLATION: route stop index decreased from ` +
          `${route.currentStopIndex} to ${activeRoute.currentStopIndex}`,
      );
    }

    // ── Route complete check ─────────────────────────────────────────────
    if (activeRoute.currentStopIndex >= activeRoute.stops.length) {
      console.log(`${tag} Route complete — all stops done`);
      trace.a2.terminationReason = 'route_complete';
      return MovementPhasePlanner.makeResult(activeRoute, [], false, null, 0, snapshot, context, true, false, undefined, undefined, undefined, undefined, undefined);
    }

    const plans: TurnPlan[] = [];
    let hasDelivery = false;
    let remainingBudget = context.speed;
    let lastMoveTargetCity: string | null = null;
    let replanLlmLog: LlmAttempt[] | undefined;
    let replanSystemPrompt: string | undefined;
    let replanUserPrompt: string | undefined;
    // JIRA-185: Count deliveries this turn for post-delivery replan patching
    let deliveriesThisTurn = 0;
    // JIRA-198: Accumulate upgrade signal across multiple in-turn replans.
    // "last non-null action wins" — a later null does NOT clobber a prior non-null.
    let pendingUpgradeAction: TurnPlanUpgradeTrain | null | undefined;
    let upgradeSuppressionReason: string | null | undefined;

    // ── Phase A: Movement loop ────────────────────────────────────────────
    let loopIter = 0;
    const MAX_LOOP_ITERS = 20;

    while (
      remainingBudget > 0 &&
      activeRoute.currentStopIndex < activeRoute.stops.length &&
      loopIter < MAX_LOOP_ITERS
    ) {
      loopIter++;
      trace.a2.iterations = loopIter;

      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      const targetCity = currentStop.city;

      // ── Already at the stop city? Execute the action ─────────────────
      if (TurnExecutorPlanner.isBotAtCity(context, targetCity)) {
        console.log(`${tag} At ${targetCity}, executing ${currentStop.action}`);

        const actionResult = await TurnExecutorPlanner.executeStopAction(
          currentStop,
          snapshot,
          context,
          tag,
        );

        if (!actionResult.success) {
          console.warn(`${tag} ${currentStop.action} failed at ${targetCity}: ${actionResult.error}. Abandoning route.`);
          trace.a2.terminationReason = 'action_failed';
          if (plans.length === 0) plans.push({ type: AIActionType.PassTurn });
          trace.outputPlan = plans.map(p => p.type);
          return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, false, true, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
        }

        plans.push(actionResult.plan!);
        applyStopEffectToLocalState(currentStop, context);

        if (currentStop.action === 'pickup') {
          trace.pickups.push({ load: currentStop.loadType, city: targetCity });
          console.log(`${tag} Picked up ${currentStop.loadType} at ${targetCity}. Advancing stop index (no reorder — ADR-4).`);

          const stopsBeforePickup = activeRoute.stops;
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
          activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);

          // AC13(c): Verify stops array was NOT mutated by the pickup or skipCompletedStops
          TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(
            stopsBeforePickup,
            activeRoute.stops,
            `pickup(${currentStop.loadType}@${targetCity})`,
            tag,
          );
        } else if (currentStop.action === 'drop') {
          console.log(`${tag} Dropped ${currentStop.loadType} at ${targetCity}. Advancing stop index.`);
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
          activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);
        } else {
          // Delivery
          hasDelivery = true;
          deliveriesThisTurn++;
          trace.deliveries.push({ load: currentStop.loadType, city: targetCity });

          console.log(`${tag} Context updated: loads=[${context.loads.join(',')}]`);

          // Filter the just-delivered demand from context.demands
          const deliveredLoadType = currentStop.loadType;
          const deliveredCity = targetCity;
          const deliveredCardId = currentStop.demandCardId;
          const prevDemandCount = context.demands.length;
          context.demands = context.demands.filter(d =>
            !(d.loadType === deliveredLoadType && d.deliveryCity === deliveredCity),
          );
          if (context.demands.length < prevDemandCount) {
            console.log(`${tag} Filtered delivered demand (${deliveredLoadType}→${deliveredCity}) from context.demands`);
          }

          // Filter from snapshot.bot.resolvedDemands
          if (snapshot.bot.resolvedDemands) {
            snapshot.bot.resolvedDemands = snapshot.bot.resolvedDemands.filter(rd => {
              if (deliveredCardId !== undefined && rd.cardId === deliveredCardId) {
                return false;
              }
              const matchesDemand = rd.demands.some(
                d => d.loadType === deliveredLoadType && d.city === deliveredCity,
              );
              return !matchesDemand;
            });
          }

          // JIRA-173: Early delivery execution
          const deliveryPlan = plans[plans.length - 1];
          if (deliveryPlan && deliveryPlan.type === AIActionType.DeliverLoad) {
            try {
              const earlyExecResult = await TurnExecutor.executePlan(deliveryPlan, snapshot);
              if (earlyExecResult.success) {
                (deliveryPlan as { preExecuted?: boolean }).preExecuted = true;
                snapshot.bot.money = earlyExecResult.remainingMoney;
                context.money = snapshot.bot.money;
                console.log(
                  `${tag} JIRA-173: Early delivery execution succeeded ` +
                  `(${deliveryPlan.load}→${deliveryPlan.city}, payment=${earlyExecResult.payment ?? 0}M). ` +
                  `Snapshot.money updated to ${snapshot.bot.money}M.`,
                );
              } else {
                console.warn(
                  `${tag} JIRA-173: Early delivery execution failed (${earlyExecResult.error ?? 'unknown error'}). ` +
                  `Falling back to deferred execution — JIRA-165 refresh will use stale snapshot. ` +
                  `JIRA-185: context.money remains stale (pre-delivery value).`,
                );
              }
            } catch (earlyExecErr) {
              console.warn(
                `${tag} JIRA-173: Early delivery execution threw (${(earlyExecErr as Error).message}). ` +
                `Falling back to deferred execution — JIRA-165 refresh will use stale snapshot. ` +
                `JIRA-185: context.money remains stale (pre-delivery value).`,
              );
            }
          }

          // JIRA-165: Refresh demands from DB after delivery
          if (gridPoints && gridPoints.length > 0) {
            try {
              const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
              freshSnapshot.bot.loads = [...snapshot.bot.loads];
              context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
              context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
              snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
              console.log(
                `${tag} JIRA-165: Refreshed demands from DB after delivery — ` +
                `${context.demands.length} demand(s) now in context`,
              );
              console.log(
                `${tag} JIRA-165: Refreshed canDeliver after delivery — ` +
                `${context.canDeliver.length} opportunit(ies) now in context`,
              );
            } catch (refreshErr) {
              console.warn(
                `${tag} JIRA-165: Demand refresh failed (${(refreshErr as Error).message}), ` +
                `continuing with locally-filtered demands`,
              );
            }
          }

          console.log(`${tag} Delivered ${currentStop.loadType} at ${targetCity}. Triggering post-delivery replan.`);

          // Advance stop index
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };

          // Delegate post-delivery replan to PostDeliveryReplanner
          const replanResult = await PostDeliveryReplanner.replan(
            activeRoute,
            snapshot,
            context,
            brain,
            gridPoints,
            deliveriesThisTurn,
            tag,
          );

          activeRoute = replanResult.route;
          if (replanResult.moveTargetInvalidated) {
            lastMoveTargetCity = null; // JIRA-194: clear stale move target
          }
          if (replanResult.replanLlmLog) replanLlmLog = replanResult.replanLlmLog;
          if (replanResult.replanSystemPrompt) replanSystemPrompt = replanResult.replanSystemPrompt;
          if (replanResult.replanUserPrompt) replanUserPrompt = replanResult.replanUserPrompt;
          // JIRA-198: Merge upgrade signal — last non-null action wins across replans.
          if (replanResult.pendingUpgradeAction !== undefined) {
            if (replanResult.pendingUpgradeAction !== null) {
              // Non-null result: always adopt the latest upgrade decision
              pendingUpgradeAction = replanResult.pendingUpgradeAction;
              upgradeSuppressionReason = null;
            } else if (pendingUpgradeAction === undefined || pendingUpgradeAction === null) {
              // Null result: only update suppression reason if we don't already have a non-null action
              pendingUpgradeAction = null;
              upgradeSuppressionReason = replanResult.upgradeSuppressionReason;
            }
          }
        }

        continue;
      }

      // ── Stop city on network but bot is not there? → MOVE ────────────
      if (context.citiesOnNetwork.includes(targetCity)) {
        lastMoveTargetCity = targetCity;
        console.log(`${tag} ${targetCity} is on network, moving (budget=${remainingBudget})`);

        const moveResult = await ActionResolver.resolveMove(
          { to: targetCity },
          snapshot,
          remainingBudget,
        );

        if (!moveResult.success || !moveResult.plan) {
          console.warn(`${tag} MOVE to ${targetCity} failed: ${moveResult.error}. Breaking to Phase B.`);
          trace.a2.terminationReason = 'move_failed_fallthrough_build';
          break;
        }

        plans.push(moveResult.plan);

        const movePlan = moveResult.plan as TurnPlanMoveTrain;
        const majorCityLookup = getMajorCityLookup();
        const milesConsumed = computeEffectivePathLength(movePlan.path, majorCityLookup);
        remainingBudget = Math.max(0, remainingBudget - milesConsumed);
        trace.moveBudget.used = context.speed - remainingBudget;

        if (remainingBudget === 0) {
          trace.a2.terminationReason = 'budget_exhausted';
          break;
        }

        const dest = movePlan.path[movePlan.path.length - 1];
        if (dest && gridPoints) {
          const arrivedGp = gridPoints.find(gp => gp.row === dest.row && gp.col === dest.col);
          const cityName = arrivedGp?.city?.name ?? undefined;
          context.position = { row: dest.row, col: dest.col, city: cityName };
          snapshot.bot.position = { row: dest.row, col: dest.col };
          console.log(`${tag} Context updated: position=${dest.row},${dest.col} (${cityName ?? 'no city'})`);
        }

        // Ferry arrival guard
        if (dest) {
          const gridPointMap = loadGridPointsMap();
          const destTerrain = gridPointMap.get(`${dest.row},${dest.col}`)?.terrain;
          if (destTerrain === TerrainType.FerryPort) {
            trace.a2.terminationReason = 'ferry_arrival';
            console.log(`${tag} [Ferry] Turn ends at ferry port (${dest.row},${dest.col}) — bot must wait until next turn to cross`);
            break;
          }
        }

        continue;
      }

      // ── Stop city not on network → A3 build-origin preview, then Phase B ─
      console.log(`${tag} ${targetCity} not on network. Attempting A3 build-origin preview move before Phase B.`);
      trace.a2.terminationReason = 'stop_city_not_on_network';

      if (remainingBudget > 0) {
        const a3BuildTarget = resolveBuildTarget(activeRoute, context);
        if (!a3BuildTarget) {
          trace.a3.terminationReason = 'no_build_target';
          console.log(`${tag} A3 skipped — reason=no_build_target`);
        } else {
          const grid = loadGridPointsMap();
          let a3TargetCoord: { row: number; col: number } | null = null;
          for (const [, gp] of grid) {
            if (gp.name && gp.name === a3BuildTarget.targetCity) {
              a3TargetCoord = { row: gp.row, col: gp.col };
              break;
            }
          }

          if (!a3TargetCoord) {
            trace.a3.terminationReason = 'build_dijkstra_failed';
            console.log(`${tag} A3 skipped — reason=build_dijkstra_failed (target city "${a3BuildTarget.targetCity}" not in grid)`);
          } else {
            const a3OccupiedEdges = new Set<string>();
            for (const pt of (snapshot.allPlayerTracks ?? [])) {
              if (pt.playerId === snapshot.bot.playerId) continue;
              for (const seg of pt.segments) {
                const a = `${seg.from.row},${seg.from.col}`;
                const b = `${seg.to.row},${seg.to.col}`;
                a3OccupiedEdges.add(`${a}-${b}`);
                a3OccupiedEdges.add(`${b}-${a}`);
              }
            }
            const a3Budget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);
            const a3OriginResult = computeBuildSegments(
              [],
              snapshot.bot.existingSegments,
              a3Budget > 0 ? a3Budget : TURN_BUILD_BUDGET,
              undefined,
              a3OccupiedEdges,
              [a3TargetCoord],
            );

            if (a3OriginResult.length === 0) {
              trace.a3.terminationReason = 'build_dijkstra_failed';
              console.log(`${tag} A3 skipped — reason=build_dijkstra_failed (Dijkstra returned no segments toward "${a3BuildTarget.targetCity}")`);
            } else {
              const previewBuildOrigin = a3OriginResult[0].from;
              const currentPos = context.position;

              if (
                currentPos &&
                previewBuildOrigin.row === currentPos.row &&
                previewBuildOrigin.col === currentPos.col
              ) {
                trace.a3.terminationReason = 'origin_is_current_position';
                console.log(`${tag} A3 skipped — reason=origin_is_current_position (bot already at build origin (${previewBuildOrigin.row},${previewBuildOrigin.col}))`);
              } else {
                const a3MoveResult = await ActionResolver.resolveMove(
                  { toRow: previewBuildOrigin.row, toCol: previewBuildOrigin.col },
                  snapshot,
                  remainingBudget,
                );

                if (a3MoveResult.success && a3MoveResult.plan) {
                  const a3MovePlan = a3MoveResult.plan as TurnPlanMoveTrain;
                  const majorCityLookupA3 = getMajorCityLookup();
                  const a3Miles = computeEffectivePathLength(a3MovePlan.path, majorCityLookupA3);

                  plans.push(a3MoveResult.plan);
                  remainingBudget = Math.max(0, remainingBudget - a3Miles);
                  trace.moveBudget.used = context.speed - remainingBudget;
                  trace.a3.movePreprended = true;
                  trace.a3.terminationReason = 'a3_move_success';
                  console.log(
                    `${tag} A3 move toward build origin (${previewBuildOrigin.row},${previewBuildOrigin.col}) for "${a3BuildTarget.targetCity}" — reason=a3_move_success (${a3Miles}mp consumed, remaining=${remainingBudget})`,
                  );
                } else {
                  const moveError = (a3MoveResult as { success: false; error?: string }).error ?? 'unknown';
                  trace.a3.terminationReason = `a3_move_failed:${moveError}`;
                  console.log(`${tag} A3 skipped — reason=a3_move_failed:${moveError}`);
                }
              }
            }
          }
        }
      }

      break;
    }

    if (loopIter >= MAX_LOOP_ITERS) {
      console.warn(`${tag} Movement loop hit MAX_LOOP_ITERS (${MAX_LOOP_ITERS}) — safety break`);
      trace.a2.terminationReason = 'max_iterations';
    }

    // ── Route complete check (post-loop) ─────────────────────────────────
    if (activeRoute.currentStopIndex >= activeRoute.stops.length) {
      console.log(`${tag} Route complete after movement loop`);
      trace.a2.terminationReason = 'route_complete';
      return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, true, false, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
    }

    return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, false, false, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
  }

  /**
   * Construct a PhaseAResult from Phase A local state.
   * Snapshots snapshot.bot.loads and context.loads at the time of call.
   */
  private static makeResult(
    activeRoute: StrategicRoute,
    plans: TurnPlan[],
    hasDelivery: boolean,
    lastMoveTargetCity: string | null,
    deliveriesThisTurn: number,
    snapshot: WorldSnapshot,
    context: GameContext,
    routeComplete: boolean,
    routeAbandoned: boolean,
    replanLlmLog?: LlmAttempt[],
    replanSystemPrompt?: string,
    replanUserPrompt?: string,
    pendingUpgradeAction?: TurnPlanUpgradeTrain | null,
    upgradeSuppressionReason?: string | null,
  ): PhaseAResult {
    return {
      activeRoute,
      lastMoveTargetCity,
      deliveriesThisTurn,
      accumulatedPlans: plans,
      loadStateMutations: {
        snapshotLoads: [...snapshot.bot.loads],
        contextLoads: [...context.loads],
      },
      replanLlmLog,
      replanSystemPrompt,
      replanUserPrompt,
      pendingUpgradeAction,
      upgradeSuppressionReason,
      routeAbandoned,
      routeComplete,
      hasDelivery,
    };
  }
}
