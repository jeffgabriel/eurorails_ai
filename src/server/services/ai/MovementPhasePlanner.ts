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
  TrainType,
  TrackSegment,
  TRAIN_PROPERTIES,
} from '../../../shared/types/GameTypes';
import {
  resolveBuildTarget,
  applyStopEffectToLocalState,
  isRouteImpossible,
  hasCarriedDeliverableOnNetwork,
} from './routeHelpers';
import { computeBuildSegments } from './computeBuildSegments';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { ActionResolver } from './ActionResolver';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { TurnExecutor } from './TurnExecutor';
import { PostDeliveryReplanner } from './PostDeliveryReplanner';
import { computeEffectivePathLength, getMajorCityLookup, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { isCoordOnNetwork } from './context/NetworkContext';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { loadGridPoints as loadGridPointsMap } from '../MapTopology';
import type { PhaseAResult } from './schemas';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { computeCandidateDetourCosts, MAX_DETOUR_TURNS } from './RouteDetourEstimator';

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
    // JIRA-233: Track route abandonment from impossibility check in PostDeliveryReplanner.
    let routeAbandonedByImpossibility = false;

    // ── Phase A: Movement loop ────────────────────────────────────────────
    let loopIter = 0;
    const MAX_LOOP_ITERS = 20;
    // JIRA-202: Allow one extra iteration when a move lands exactly on the
    // current stop city with budget = 0 (free stop-action on arrival turn).
    let pendingArrivalStopAction = false;

    while (
      (remainingBudget > 0 || pendingArrivalStopAction) &&
      activeRoute.currentStopIndex < activeRoute.stops.length &&
      loopIter < MAX_LOOP_ITERS
    ) {
      pendingArrivalStopAction = false;
      loopIter++;
      trace.a2.iterations = loopIter;

      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      const targetCity = currentStop.city;

      // ── Already at the stop city? Execute the action ─────────────────
      if (TurnExecutorPlanner.isBotAtCity(context, targetCity)) {
        const _stopActionStart = Date.now();
        const actionResult = await TurnExecutorPlanner.executeStopAction(
          currentStop,
          snapshot,
          context,
          tag,
        );
        if (trace.timing) {
          trace.timing.stopActionMs += Date.now() - _stopActionStart;
          trace.timing.stopActionCount += 1;
        }

        if (!actionResult.success) {
          // A single stop-action failure (e.g., load not yet available, transient validation)
          // is not grounds for abandoning the route — replanning every time we trip on a
          // single failure leaks LLM cost and was the dominant cause of pure-abandonment in
          // the 7-day log analysis. Return without progress; if the same failure persists
          // for ≥3 turns, ActiveRouteContinuer's stuck-route detector will abandon.
          console.warn(`${tag} ${currentStop.action} failed at ${targetCity}: ${actionResult.error}. Preserving route — will retry next turn (stuck-route detector abandons after 3 no-progress turns).`);
          trace.a2.terminationReason = 'action_failed';
          trace.outputPlan = plans.map(p => p.type);
          return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, false, false, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
        }

        plans.push(actionResult.plan!);
        applyStopEffectToLocalState(currentStop, context);

        if (currentStop.action === 'pickup') {
          // JIRA-220 follow-up — early-exec the pickup so the load is committed to
          // DB before any subsequent same-turn deliver early-exec runs. Without this,
          // a route containing pickup→deliver of the same load in one turn caused
          // the deliver early-exec to fail (DB still showed empty loads), which
          // caused the JIRA-165 refresh to capture pre-deliver state, which caused
          // the post-delivery replan to pick a fresh route around the
          // about-to-be-replaced card — resulting in a stuck route on the next
          // turn (see analysis of game 1a10d393). Mark the plan preExecuted so the
          // end-of-turn flush skips it.
          const pickupPlan = actionResult.plan!;
          if (pickupPlan.type === AIActionType.PickupLoad) {
            try {
              const earlyPickupResult = await TurnExecutor.executePlan(pickupPlan, snapshot);
              if (earlyPickupResult.success) {
                (pickupPlan as { preExecuted?: boolean }).preExecuted = true;
              } else {
                console.warn(
                  `${tag} JIRA-220 early pickup execution failed ` +
                  `(${earlyPickupResult.error ?? 'unknown error'}). ` +
                  `Pickup will be retried at end-of-turn flush.`,
                );
              }
            } catch (earlyPickupErr) {
              console.warn(
                `${tag} JIRA-220 early pickup execution threw ` +
                `(${(earlyPickupErr as Error).message}). ` +
                `Pickup will be retried at end-of-turn flush.`,
              );
            }
          }

          trace.pickups.push({ load: currentStop.loadType, city: targetCity });

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

          // JIRA-214 P2: Fire advisor trigger after pickup
          activeRoute = await MovementPhasePlanner.maybeFireAdvisor(
            activeRoute, targetCity, snapshot, context, brain, gridPoints, tag,
          );
        } else if (currentStop.action === 'drop') {
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
          activeRoute = TurnExecutorPlanner.skipCompletedStops(activeRoute, context);

          // JIRA-214 P2: Fire advisor trigger after drop
          activeRoute = await MovementPhasePlanner.maybeFireAdvisor(
            activeRoute, targetCity, snapshot, context, brain, gridPoints, tag,
          );
        } else {
          // Delivery
          hasDelivery = true;
          deliveriesThisTurn++;
          trace.deliveries.push({ load: currentStop.loadType, city: targetCity });

          // Filter the just-delivered demand from context.demands
          const deliveredLoadType = currentStop.loadType;
          const deliveredCity = targetCity;
          const deliveredCardId = currentStop.demandCardId;
          context.demands = context.demands.filter(d =>
            !(d.loadType === deliveredLoadType && d.deliveryCity === deliveredCity),
          );

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
              freshSnapshot.bot.loads = [...context.loads];
              context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
              context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
              snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
            } catch (refreshErr) {
              console.warn(
                `${tag} JIRA-165: Demand refresh failed (${(refreshErr as Error).message}), ` +
                `continuing with locally-filtered demands`,
              );
            }
          }

          // Advance stop index
          activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };

          // JIRA-214 P2: Fire advisor trigger after delivery (before post-delivery replan)
          activeRoute = await MovementPhasePlanner.maybeFireAdvisor(
            activeRoute, targetCity, snapshot, context, brain, gridPoints, tag,
          );

          // Defer post-delivery replan when the next remaining stop is at the
          // same city — the bot has more in-city work to do (another delivery,
          // pickup, or drop) without moving. Replanning between back-to-back
          // same-city stops is wasted work: the planner would see the bot at
          // the same position with another stop queued and almost always
          // commit to executing it. Each replan is a full trip-planning pass
          // (10-20s at mid-game candidate counts in game 181cf810). Skipping
          // the redundant first call halves per-turn replan cost on the
          // double-delivery turns that dominate the slow-turn tail.
          //
          // Guard with isRouteImpossible: if the remaining route is impossible
          // (e.g. the next same-city stop needs a load not in cargo), force
          // the replan so the impossibility check at PostDeliveryReplanner
          // catches it now rather than burning turns via stuck-route-abandon.
          const nextStopAfterDelivery = activeRoute.stops[activeRoute.currentStopIndex];
          const nextStopIsSameCity = !!nextStopAfterDelivery && nextStopAfterDelivery.city === targetCity;
          if (nextStopIsSameCity && !isRouteImpossible(activeRoute, context)) {
            continue;
          }
          // Delegate post-delivery replan to PostDeliveryReplanner
          const _replanStart = Date.now();
          const replanResult = await PostDeliveryReplanner.replan(
            activeRoute,
            snapshot,
            context,
            brain,
            gridPoints,
            deliveriesThisTurn,
            tag,
          );
          if (trace.timing) {
            trace.timing.replanMs += Date.now() - _replanStart;
            trace.timing.replanCount += 1;
          }

          activeRoute = replanResult.route;
          if (replanResult.moveTargetInvalidated) {
            lastMoveTargetCity = null; // JIRA-194: clear stale move target
          }
          // JIRA-233: propagate route abandonment from impossibility check
          if (replanResult.routeWasAbandoned) {
            routeAbandonedByImpossibility = true;
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

        const _moveResolveStart = Date.now();
        const moveResult = await ActionResolver.resolveMove(
          { to: targetCity },
          snapshot,
          remainingBudget,
        );
        if (trace.timing) {
          trace.timing.moveResolveMs += Date.now() - _moveResolveStart;
          trace.timing.moveResolveCount += 1;
        }

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

        // Update position context before any post-move checks (ferry, arrival).
        const dest = movePlan.path[movePlan.path.length - 1];
        if (dest && gridPoints) {
          const arrivedGp = gridPoints.find(gp => gp.row === dest.row && gp.col === dest.col);
          const cityName = arrivedGp?.city?.name ?? undefined;
          context.position = { row: dest.row, col: dest.col, city: cityName };
          snapshot.bot.position = { row: dest.row, col: dest.col };
        }

        // Ferry arrival guard takes precedence over arrival stop action (R5).
        if (dest) {
          const gridPointMap = loadGridPointsMap();
          const destTerrain = gridPointMap.get(`${dest.row},${dest.col}`)?.terrain;
          if (destTerrain === TerrainType.FerryPort) {
            trace.a2.terminationReason = 'ferry_arrival';
            break;
          }
        }

        if (remainingBudget === 0) {
          // JIRA-202: When the final move lands on the current stop city, the free
          // stop action (pickup / deliver / drop) still executes this turn.
          // Set pendingArrivalStopAction so the loop runs one more iteration whose
          // isBotAtCity branch handles the stop action (R1, R2, R3).
          if (TurnExecutorPlanner.isBotAtCity(context, targetCity)) {
            trace.a2.terminationReason = 'arrival_stop_action';
            pendingArrivalStopAction = true;
            continue;
          }
          trace.a2.terminationReason = 'budget_exhausted';
          break;
        }

        continue;
      }

      // ── Stop city not on network → A3 build-origin preview, then Phase B ─
      trace.a2.terminationReason = 'stop_city_not_on_network';

      if (remainingBudget > 0) {
        const a3BuildTarget = resolveBuildTarget(activeRoute, context);
        if (!a3BuildTarget) {
          trace.a3.terminationReason = 'no_build_target';
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
              // JIRA-244 Fix B: distinguish "target already reachable" from "no path found".
              // computeBuildSegments returns [] when no NEW segments are needed (target is
              // already on-network via the existing track or a paid ferry crossing).
              const a3Network = snapshot.bot.existingSegments.length > 0
                ? buildTrackNetwork(snapshot.bot.existingSegments)
                : null;
              const a3FerryEdges = getFerryEdges();
              if (a3Network && isCoordOnNetwork(a3TargetCoord, a3Network, a3FerryEdges)) {
                // Target is reachable — A2 will handle movement on next loop iteration.
                trace.a3.terminationReason = 'a3_target_already_reachable';
                continue;
              }
              // No path to build target AND bot is carrying a load it can deliver
              // on-network right now → abandon this route so the next turn produces
              // a fresh carry-deliver plan instead of retrying a doomed build.
              if (hasCarriedDeliverableOnNetwork(context)) {
                console.warn(`${tag} a3_abandon_for_carry_deliver — empty build path, carry-deliverable on-network`);
                trace.a3.terminationReason = 'a3_abandon_for_carry_deliver';
                routeAbandonedByImpossibility = true;
                break;
              }
              trace.a3.terminationReason = 'build_dijkstra_failed';
            } else {
              const previewBuildOrigin = a3OriginResult[0].from;
              const currentPos = context.position;
              const lastSeg = a3OriginResult[a3OriginResult.length - 1];

              // computeBuildSegments returned segments but the path does not reach
              // the build target (partial path) AND bot carries a deliverable
              // on-network load → abandon so the next turn produces a carry-deliver
              // plan instead of committing budget to a partial route.
              if (
                (lastSeg.to.row !== a3TargetCoord.row || lastSeg.to.col !== a3TargetCoord.col) &&
                hasCarriedDeliverableOnNetwork(context)
              ) {
                console.warn(`${tag} a3_abandon_for_carry_deliver_partial — partial build path, carry-deliverable on-network`);
                trace.a3.terminationReason = 'a3_abandon_for_carry_deliver_partial';
                routeAbandonedByImpossibility = true;
                break;
              }

              if (
                currentPos &&
                previewBuildOrigin.row === currentPos.row &&
                previewBuildOrigin.col === currentPos.col
              ) {
                // JIRA-247: Commit a3OriginResult as a BuildTrack plan directly
                // instead of `continue`-ing the loop and deferring to Phase B.
                // The prior partial fix set trace.build.target and looped, which
                // re-entered A2/A3 with unchanged inputs (livelock to
                // MAX_LOOP_ITERS) and then handed off to Phase B whose
                // independent computeBuildSegments call returned [] at
                // medium-city outer mileposts (game f3ed7b8f T95: bot at
                // (4,61) building toward Stockholm Medium City at (4,62)).
                // Truncate the path to fit the build budget — computeBuildSegments
                // may return more segments than the bot can afford this turn.
                const truncated: TrackSegment[] = [];
                let accCost = 0;
                for (const seg of a3OriginResult) {
                  if (accCost + seg.cost > a3Budget) break;
                  truncated.push(seg);
                  accCost += seg.cost;
                }
                trace.a3.terminationReason = 'a3_build_origin_is_current_pos';
                trace.build.target = a3BuildTarget.targetCity;
                if (truncated.length > 0) {
                  console.warn(`${tag} a3_build_origin_is_current_pos — committing ${truncated.length} seg(s) cost ${accCost}M toward ${a3BuildTarget.targetCity}`);
                  trace.build.cost = accCost;
                  plans.push({
                    type: AIActionType.BuildTrack,
                    segments: truncated,
                    targetCity: a3BuildTarget.targetCity,
                  });
                } else {
                  console.warn(`${tag} a3_build_origin_is_current_pos — budget ${a3Budget}M too small for cheapest segment (${a3OriginResult[0]?.cost ?? '?'}M), no build committed`);
                }
                break;
              } else {
                const _a3MoveStart = Date.now();
                const a3MoveResult = await ActionResolver.resolveMove(
                  { toRow: previewBuildOrigin.row, toCol: previewBuildOrigin.col },
                  snapshot,
                  remainingBudget,
                );
                if (trace.timing) {
                  trace.timing.moveResolveMs += Date.now() - _a3MoveStart;
                  trace.timing.moveResolveCount += 1;
                }

                if (a3MoveResult.success && a3MoveResult.plan) {
                  const a3MovePlan = a3MoveResult.plan as TurnPlanMoveTrain;
                  const majorCityLookupA3 = getMajorCityLookup();
                  const a3Miles = computeEffectivePathLength(a3MovePlan.path, majorCityLookupA3);

                  plans.push(a3MoveResult.plan);
                  remainingBudget = Math.max(0, remainingBudget - a3Miles);
                  trace.moveBudget.used = context.speed - remainingBudget;
                  trace.a3.movePreprended = true;
                  trace.a3.terminationReason = 'a3_move_success';
                } else {
                  const moveError = (a3MoveResult as { success: false; error?: string }).error ?? 'unknown';
                  trace.a3.terminationReason = `a3_move_failed:${moveError}`;
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
      trace.a2.terminationReason = 'route_complete';
      return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, true, false, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
    }

    // JIRA-233: surface route abandonment from impossibility check
    if (routeAbandonedByImpossibility) {
      trace.a2.terminationReason = 'route_impossible';
      return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, false, true, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
    }

    return MovementPhasePlanner.makeResult(activeRoute, plans, hasDelivery, lastMoveTargetCity, deliveriesThisTurn, snapshot, context, false, false, replanLlmLog, replanSystemPrompt, replanUserPrompt, pendingUpgradeAction, upgradeSuppressionReason);
  }

  /**
   * Advisor trigger: fires after each pickup/deliver/drop action at `currentCity`.
   *
   * Peeks at the next pending stop in `route`. If the next stop is at a different
   * city, there is no next stop, or Phase A is terminating, runs the 5-condition
   * pre-LLM filter, computes detour costs, and invokes RouteEnrichmentAdvisor.
   *
   * Returns the (potentially enriched) route. Never throws — falls back to input
   * route on any error.
   *
   * R8 — JIRA-214 P2 BE-002.
   */
  private static async maybeFireAdvisor(
    route: StrategicRoute,
    currentCity: string,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain | null | undefined,
    gridPoints: GridPoint[] | undefined,
    tag: string,
  ): Promise<StrategicRoute> {
    // Guard: brain and gridPoints are required for the advisor
    if (!brain || !gridPoints || gridPoints.length === 0) return route;

    // Peek at the next pending stop
    const nextStop = route.stops[route.currentStopIndex];
    if (nextStop && nextStop.city.toLowerCase() === currentCity.toLowerCase()) {
      // Same-city next stop → more planned actions here; do not fire
      return route;
    }
    // Different-city next stop, no next stop, or end of stops → fire

    // ── Pre-LLM filter (conditions 1-3: pure data checks) ──────────────────
    const trainCapacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    const availableLoads = snapshot.loadAvailability[currentCity] ?? [];

    const earlyPassCandidates = context.demands.filter(d => {
      // Condition 1: load available at currentCity AND demand.supplyCity === currentCity
      if (!d.supplyCity) return false;
      const supplyMatch = d.supplyCity.toLowerCase() === currentCity.toLowerCase();
      if (!supplyMatch) return false;
      if (!availableLoads.includes(d.loadType)) return false;

      // Condition 2: route does NOT already contain DELIVER for (loadType, deliveryCity)
      const alreadyPlanned = route.stops.some(
        s => s.action === 'deliver' && s.loadType === d.loadType && s.city === d.deliveryCity,
      );
      if (alreadyPlanned) return false;

      // Condition 3: train has a free slot
      if (snapshot.bot.loads.length >= trainCapacity) return false;

      return true;
    });

    if (earlyPassCandidates.length === 0) {
      return route;
    }

    // ── Conditions 4-5: require per-candidate CandidateDetourInfo ──────────
    const rawCandidates = earlyPassCandidates.map(d => ({
      loadType: d.loadType,
      deliveryCity: d.deliveryCity,
      payout: d.payout,
      cardIndex: d.cardIndex,
    }));

    let detourInfos;
    try {
      detourInfos = computeCandidateDetourCosts(currentCity, rawCandidates, route, snapshot);
    } catch (err) {
      console.warn(`${tag} [Advisor] computeCandidateDetourCosts failed (${(err as Error).message}), skipping advisor`);
      return route;
    }

    // Apply conditions 4 and 5
    const viableCandidates = detourInfos.filter(c => {
      // Condition 4: marginalBuildM <= snapshot.bot.money
      if (c.marginalBuildM > snapshot.bot.money) return false;
      // Condition 5: marginalTurns <= MAX_DETOUR_TURNS
      if (c.marginalTurns > MAX_DETOUR_TURNS) return false;
      return true;
    });

    if (viableCandidates.length === 0) {
      return route;
    }

    // ── Invoke advisor (awaited inline) ────────────────────────────────────
    try {
      const enriched = await RouteEnrichmentAdvisor.enrich(
        route, snapshot, context, brain, gridPoints, currentCity, viableCandidates,
      );
      return enriched;
    } catch (err) {
      console.warn(`${tag} [Advisor] RouteEnrichmentAdvisor.enrich failed (${(err as Error).message}), continuing without enrichment`);
      return route;
    }
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
