/**
 * TurnComposer — Post-decision layer that composes a complete multi-phase turn.
 *
 * Takes a primary TurnPlan and systematically appends missing phases:
 *   Phase A: Operational (move + pickup/deliver)
 *   Phase B: Build/Upgrade (spend up to 20M on track after operations)
 *
 * Replaces three ad-hoc enhancement methods in PlanExecutor:
 *   - chainArrivalAction → Phase A (scanPathOpportunities)
 *   - chainMoveAfterAct → Phase A (operational enrichment)
 *   - appendBuildStep → Phase B (tryAppendBuild)
 *
 * Runs for ALL decision paths (route executor, LLM, heuristic fallback).
 * Respects the primary decision — only appends, never overrides.
 */

import {
  TurnPlan,
  TurnPlanMoveTrain,
  TurnPlanDeliverLoad,
  TurnPlanBuildTrack,
  WorldSnapshot,
  GameContext,
  AIActionType,
  StrategicRoute,
  TerrainType,
  TrackSegment,
  BuildAdvisorResult,
  RouteStop,
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';
import { loadGridPoints, makeKey, getHexNeighbors } from './MapTopology';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { NetworkBuildAnalyzer } from './NetworkBuildAnalyzer';
import { BuildAdvisor } from './BuildAdvisor';
import { SolvencyCheck } from './SolvencyCheck';
import { RouteValidator } from './RouteValidator';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';

/** JIRA-32: Structured trace of what TurnComposer did during composition. */
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
  jitGate?: { deferred: boolean; reason: string; trackRunway: number; trainSpeed: number; destinationCity: string; currentStopIndex?: number; buildTargetStopIndex?: number; currentStopCity?: string };
  /** JIRA-122: Ferry-aware BFS search result */
  ferryAwareBFS?: { searched: boolean; ferryHopsUsed: number; nearestPointViaFerry: { row: number; col: number; distance: number; ferryCrossings: number } | null };
  /** JIRA-125: Victory build decision */
  victoryBuild?: { target: string | null; cost: number; triggered: boolean; overrodeRoute: boolean };
  /** JIRA-129: Build Advisor decision */
  advisor?: { action: string | null; reasoning: string | null; waypoints: [number, number][]; solvencyRetries: number; latencyMs: number; fallback: boolean; rawResponse?: string; rawWaypoints?: [number, number][]; error?: string };
}

/** JIRA-129: Extended result from tryAppendBuild, may include an updated route from replan */
export interface BuildResult {
  plan: TurnPlan | null;
  updatedRoute?: StrategicRoute;
  advisorAction?: string;
  advisorWaypoints?: [number, number][];
  advisorReasoning?: string;
  advisorLatencyMs?: number;
  solvencyRetries?: number;
}

/** Result from TurnComposer.compose() — the plan plus a trace of what happened. */
export interface CompositionResult {
  plan: TurnPlan;
  trace: CompositionTrace;
}

export class TurnComposer {
  /**
   * Given a primary TurnPlan, attempt to fill in missing turn phases.
   * Returns a MultiAction combining all applicable phases, or the
   * primary plan unchanged if no additional phases are possible.
   *
   * Phase ordering follows game rules:
   *   1. Operational (move + pickup/deliver) — train operations first
   *   2. Build/Upgrade — spend up to 20M on track after operations
   */
  static async compose(
    primaryPlan: TurnPlan,
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute?: StrategicRoute | null,
    brain?: import('./LLMStrategyBrain').LLMStrategyBrain | null,
    gridPoints?: import('../../../shared/types/GameTypes').GridPoint[],
  ): Promise<CompositionResult> {
    // JIRA-32: Initialize composition trace
    const trace: CompositionTrace = {
      inputPlan: TurnComposer.planActionTypes(primaryPlan),
      outputPlan: [],
      moveBudget: { total: context.speed, used: 0, wasted: 0 },
      a1: { citiesScanned: 0, opportunitiesFound: 0 },
      a2: { iterations: 0, terminationReason: '' },
      a3: { movePreprended: false },
      build: { target: null, cost: 0, skipped: false, upgradeConsidered: false },
      pickups: [],
      deliveries: [],
    };

    const wrapResult = (plan: TurnPlan): CompositionResult => {
      trace.outputPlan = TurnComposer.planActionTypes(plan);
      const used = TurnComposer.countMovementUsed(
        plan.type === 'MultiAction' ? plan.steps : [plan],
      );
      trace.moveBudget.used = used;
      trace.moveBudget.wasted = Math.max(0, context.speed - used);
      return { plan, trace };
    };

    // ── Exclusive actions: return unchanged ──
    if (primaryPlan.type === AIActionType.DiscardHand) return wrapResult(primaryPlan);
    if (primaryPlan.type === AIActionType.PassTurn) return wrapResult(primaryPlan);

    // During initialBuild, no operational enrichment is possible (no train movement)
    if (context.isInitialBuild) return wrapResult(primaryPlan);

    // ── Extract existing steps ──
    const steps: TurnPlan[] = primaryPlan.type === 'MultiAction'
      ? [...primaryPlan.steps]
      : [primaryPlan];

    // ── Defensive backstop: validate movement budget before enrichment ──
    const incomingMovement = TurnComposer.countMovementUsed(steps);
    if (incomingMovement > context.speed) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === AIActionType.MoveTrain) {
          const movePlan = steps[i] as TurnPlanMoveTrain;
          const excess = incomingMovement - context.speed;
          const newPathLength = movePlan.path.length - excess;
          console.warn(
            `[TurnComposer] Movement budget exceeded: ${incomingMovement}mp > ${context.speed}mp limit. ` +
            `Truncating last MOVE from ${movePlan.path.length - 1}mp to ${Math.max(0, newPathLength - 1)}mp.`,
          );
          if (newPathLength > 1) {
            steps[i] = { ...movePlan, path: movePlan.path.slice(0, newPathLength) } as TurnPlanMoveTrain;
          } else {
            steps.splice(i, 1);
          }
          break;
        }
      }
    }

    // ── Track which action types are already present ──
    const hasType = (type: AIActionType | 'MultiAction') =>
      steps.some(s => s.type === type);
    const hasBuild = hasType(AIActionType.BuildTrack);
    const hasUpgrade = hasType(AIActionType.UpgradeTrain);

    // Upgrade is mutually exclusive with build — skip build phase if upgrade present
    const skipBuildPhase = hasBuild || hasUpgrade;

    // ── Clone snapshot and simulate existing steps ──
    const simSnapshot = ActionResolver.cloneSnapshot(snapshot);
    const simContext = { ...context };
    for (const step of steps) {
      ActionResolver.applyPlanToState(step, simSnapshot, simContext);
    }

    // ── JIRA-39: DropLoad prefix composition ──
    // Per game rules, dropping a load is free — it doesn't consume movement or end the turn.
    // When the primary plan is DropLoad (PlanExecutor couldn't pick up due to full train),
    // attempt a PICKUP at the same city to compose [DropLoad, PickupLoad].
    // The A2 continuation loop will then chain a MOVE with remaining movement budget.
    if (steps.length === 1 && steps[0].type === AIActionType.DropLoad) {
      const dropPlan = steps[0] as import('../../../shared/types/GameTypes').TurnPlanDropLoad;
      const cityName = dropPlan.city;

      // Try to pick up loads at the same city after the drop freed a cargo slot
      const availableLoads = simSnapshot.loadAvailability[cityName] ?? [];
      for (const loadType of availableLoads) {
        if (simSnapshot.bot.loads.length >= TurnComposer.getBotCapacity(simSnapshot)) break;
        if (simSnapshot.bot.loads.includes(loadType)) continue;

        const hasDemand = simSnapshot.bot.resolvedDemands.some(rd =>
          rd.demands.some(d => d.loadType === loadType),
        );
        if (!hasDemand) continue;

        const pickupResult = await ActionResolver.resolve(
          { action: 'PICKUP', details: { load: loadType, at: cityName }, reasoning: '', planHorizon: '' },
          simSnapshot, simContext,
        );
        if (pickupResult.success && pickupResult.plan) {
          steps.push(pickupResult.plan);
          ActionResolver.applyPlanToState(pickupResult.plan, simSnapshot, simContext);
          console.log(
            `[TurnComposer] JIRA-39: DropLoad prefix — picked up "${loadType}" at "${cityName}" after dropping "${dropPlan.load}"`,
          );
          break;
        }
      }

      // Also try route-based pickup if no demand-matched load was found above
      if (steps.length === 1 && activeRoute) {
        const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
        if (currentStop?.action === 'pickup' && currentStop.city === cityName) {
          const pickupResult = await ActionResolver.resolve(
            { action: 'PICKUP', details: { load: currentStop.loadType, at: cityName }, reasoning: '', planHorizon: '' },
            simSnapshot, simContext,
          );
          if (pickupResult.success && pickupResult.plan) {
            steps.push(pickupResult.plan);
            ActionResolver.applyPlanToState(pickupResult.plan, simSnapshot, simContext);
            console.log(
              `[TurnComposer] JIRA-39: DropLoad prefix — picked up route load "${currentStop.loadType}" at "${cityName}" after dropping "${dropPlan.load}"`,
            );
          }
        }
      }
    }

    // ── Phase A: Operational enrichment ──
    try {
      // A0: Deliver-before-build — if primary plan is BUILD but bot carries a load
      // whose delivery city is reachable this turn, prepend MOVE+DELIVER (FR-8)
      if (hasBuild && !hasType(AIActionType.DeliverLoad)) {
        const deliverable = context.demands.find(
          d => d.isLoadOnTrain && d.isDeliveryReachable,
        );
        if (deliverable) {
          const moveResult = await ActionResolver.resolve(
            { action: 'MOVE', details: { to: deliverable.deliveryCity }, reasoning: '', planHorizon: '' },
            simSnapshot, simContext,
          );
          if (moveResult.success && moveResult.plan) {
            const deliverResult = await ActionResolver.resolve(
              { action: 'DELIVER', details: { load: deliverable.loadType, at: deliverable.deliveryCity }, reasoning: '', planHorizon: '' },
              simSnapshot, simContext,
            );
            if (deliverResult.success && deliverResult.plan) {
              steps.unshift(moveResult.plan, deliverResult.plan);
              ActionResolver.applyPlanToState(moveResult.plan, simSnapshot, simContext);
              ActionResolver.applyPlanToState(deliverResult.plan, simSnapshot, simContext);
            }
          }
        }
      }

      // A1: If primary contains a MOVE, split it for mid-movement pickup/deliver
      // Per game rules, a player can pick up and deliver at ANY city passed through
      // during movement, then continue moving with remaining movement allowance.
      const moveIdx = steps.findIndex(s => s.type === AIActionType.MoveTrain);
      const movePlan = moveIdx >= 0 ? steps[moveIdx] as TurnPlanMoveTrain : undefined;
      if (movePlan && movePlan.path.length > 0) {
        // JIRA-32: Track A1 stats — count intermediate cities (path nodes excluding start/end)
        trace.a1.citiesScanned = Math.max(0, movePlan.path.length - 2);
        const splitResult = await TurnComposer.splitMoveForOpportunities(
          movePlan, simSnapshot, simContext, activeRoute,
        );
        activeRoute = splitResult.route ?? activeRoute;
        const splitPlans = splitResult.plans;
        // Count non-MOVE plans as opportunities found
        trace.a1.opportunitiesFound = splitPlans.filter(s => s.type !== AIActionType.MoveTrain).length;
        // Replace the original MOVE with the interleaved sequence
        if (splitPlans.length > 1) {
          steps.splice(moveIdx, 1, ...splitPlans);
          // Re-simulate from scratch since we restructured the steps
          const reSim = ActionResolver.cloneSnapshot(snapshot);
          const reCtx = { ...context };
          for (const step of steps) {
            ActionResolver.applyPlanToState(step, reSim, reCtx);
          }
          // Update sim state for Phase B
          Object.assign(simSnapshot, reSim);
          Object.assign(simContext, reCtx);
        }
      }

      // A2: Chain continuation MOVEs after PICKUP/DELIVER actions.
      // This handles both:
      //   - Primary was PICKUP/DELIVER (no MOVE yet) — chain a full MOVE
      //   - A1 split a MOVE and found a pickup/deliver at the destination — continue moving
      // The while loop allows repeated chaining: MOVE → PICKUP → MOVE → DELIVER → MOVE...
      // until the movement budget is exhausted or no valid target remains.
      const A2_MAX_ITERATIONS = 5;
      let a2Iterations = 0;
      let a2TerminationReason = '';

      while (a2Iterations < A2_MAX_ITERATIONS) {
        const lastStepType = steps[steps.length - 1]?.type;
        if (lastStepType !== AIActionType.PickupLoad && lastStepType !== AIActionType.DeliverLoad) {
          if (a2Iterations > 0) a2TerminationReason = 'last step is MOVE';
          break;
        }

        // JIRA-38: Before chaining a MOVE, check if the next route stop is at the
        // bot's current city. If so, resolve the action directly (no movement needed).
        // This handles multi-pickup at the same city (e.g., Iron + Steel at Birmingham).
        if (activeRoute) {
          const gridPoints = loadGridPoints();
          const botPos = simSnapshot.bot.position;
          const botCity = botPos ? gridPoints.get(`${botPos.row},${botPos.col}`)?.name : null;
          if (botCity) {
            let sameCityChained = false;
            while (activeRoute.currentStopIndex < activeRoute.stops.length) {
              const nextStop = activeRoute.stops[activeRoute.currentStopIndex];
              if (nextStop.city !== botCity) break;

              // Check if this stop's action is still needed (JIRA-117: count-aware for same load type)
              if (nextStop.action === 'pickup') {
                const loadsOfTypeOnTrain = simSnapshot.bot.loads.filter(l => l === nextStop.loadType).length;
                const sameTypePickupsUpToHere = activeRoute.stops
                  .slice(0, activeRoute.currentStopIndex + 1)
                  .filter(s => s.action === 'pickup' && s.loadType === nextStop.loadType).length;
                if (loadsOfTypeOnTrain >= sameTypePickupsUpToHere) {
                  activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
                  continue; // Already picked up enough of this type — skip
                }
              }
              if (nextStop.action === 'deliver' && !simSnapshot.bot.loads.includes(nextStop.loadType)) {
                activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
                continue; // Already delivered — skip
              }

              // Check capacity for pickups
              if (nextStop.action === 'pickup' && simSnapshot.bot.loads.length >= TurnComposer.getBotCapacity(simSnapshot)) {
                break; // No room — can't pick up more
              }

              const actionType = nextStop.action === 'pickup' ? 'PICKUP' : 'DELIVER';
              const details = nextStop.action === 'pickup'
                ? { load: nextStop.loadType, at: botCity }
                : { load: nextStop.loadType, at: botCity };
              const actionResult = await ActionResolver.resolve(
                { action: actionType, details, reasoning: '', planHorizon: '' },
                simSnapshot, simContext,
              );
              if (actionResult.success && actionResult.plan) {
                steps.push(actionResult.plan);
                ActionResolver.applyPlanToState(actionResult.plan, simSnapshot, simContext);
                activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
                sameCityChained = true;
                console.log(
                  `[TurnComposer] JIRA-38: Same-city chain — ${actionType} "${nextStop.loadType}" at "${botCity}" (no movement needed)`,
                );
              } else {
                break; // Action failed — stop chaining
              }
            }
            if (sameCityChained) {
              a2Iterations++;
              continue; // Re-enter the A2 loop to potentially chain a MOVE after the same-city actions
            }
          }
        }

        const movementUsed = TurnComposer.countMovementUsed(steps);
        const remainingMovement = simContext.speed - movementUsed;
        if (remainingMovement <= 0) {
          a2TerminationReason = 'budget exhausted';
          break;
        }

        // Try multiple targets in priority order — the primary route target
        // may be unreachable if track hasn't been built there yet.
        const moveTargets = TurnComposer.findMoveTargets(simContext, activeRoute);
        let chainedSuccessfully = false;

        for (const moveTarget of moveTargets) {
          const moveResult = await ActionResolver.resolve(
            { action: 'MOVE', details: { to: moveTarget }, reasoning: '', planHorizon: '' },
            simSnapshot, simContext,
          );
          if (moveResult.success && moveResult.plan) {
            let chainedMove = moveResult.plan as TurnPlanMoveTrain;
            // Truncate path to remaining movement allowance using effective mileposts
            // (intra-city hops within major city red areas are free and must not consume budget)
            const chainEffective = computeEffectivePathLength(chainedMove.path, getMajorCityLookup());
            if (chainEffective > remainingMovement) {
              chainedMove = {
                ...chainedMove,
                path: TurnComposer.truncatePathToEffectiveBudget(chainedMove.path, remainingMovement),
              };
            }
            if (chainedMove.path.length > 1) {
              const splitResult = await TurnComposer.splitMoveForOpportunities(
                chainedMove, simSnapshot, simContext, activeRoute,
              );
              activeRoute = splitResult.route ?? activeRoute;
              for (const plan of splitResult.plans) {
                steps.push(plan);
                ActionResolver.applyPlanToState(plan, simSnapshot, simContext);
              }
              chainedSuccessfully = true;
            }
            break; // Found a valid target — exit target loop
          } else {
            console.log(`[TurnComposer] A2 continuation MOVE to ${moveTarget} failed: ${moveResult.error}`);
          }
        }

        if (!chainedSuccessfully) {
          a2TerminationReason = 'no valid target';
          break;
        }

        a2Iterations++;
      }

      if (a2Iterations >= A2_MAX_ITERATIONS) {
        a2TerminationReason = 'iteration cap';
      }
      trace.a2 = { iterations: a2Iterations, terminationReason: a2TerminationReason };
      if (a2Iterations > 0) {
        const totalMovement = TurnComposer.countMovementUsed(steps);
        console.log(
          `[TurnComposer] A2 loop: ${a2Iterations} chained continuation(s), ` +
          `${totalMovement}mp/${simContext.speed}mp used. ` +
          `Terminated: ${a2TerminationReason}`,
        );
      }

      // A3: If primary is BUILD and no MOVE exists, prepend a MOVE before the build.
      // Movement happens BEFORE building per game rules, so resolve against original
      // (pre-build) snapshot to avoid pathfinding on not-yet-built segments.
      const primaryType = steps[0]?.type;
      const hasMove = steps.some(s => s.type === AIActionType.MoveTrain);
      if (!hasMove && primaryType === AIActionType.BuildTrack) {
        // Extract build target city for frontier guard and directional filter
        const buildStep = steps.find(s => s.type === AIActionType.BuildTrack) as TurnPlanBuildTrack | undefined;
        const buildTargetCity = buildStep?.targetCity;

        // Frontier guard: skip A3 if bot is already at the build frontier
        if (buildTargetCity && TurnComposer.isBotAtBuildFrontier(snapshot, context, buildTargetCity)) {
          trace.a3 = { movePreprended: false, skipped: true, reason: 'bot at build frontier' };
          console.log(`[TurnComposer] A3 skipped: bot at build frontier for target "${buildTargetCity}"`);
        } else {
          const movementUsed = TurnComposer.countMovementUsed(steps);
          const remainingMovement = context.speed - movementUsed;
          if (remainingMovement > 0) {
            // Try multiple targets — the route's build target city is likely
            // unreachable (that's why PlanExecutor chose BUILD), so fall back
            // to demand-based cities on the existing track network.
            let moveTargets = TurnComposer.findMoveTargets(context, activeRoute);

            // Directional filter: only accept targets closer to the build target
            if (buildTargetCity) {
              moveTargets = TurnComposer.filterByDirection(moveTargets, context, buildTargetCity);
            }

            for (const moveTarget of moveTargets) {
              const moveResult = await ActionResolver.resolve(
                { action: 'MOVE', details: { to: moveTarget }, reasoning: '', planHorizon: '' },
                snapshot, context,
              );
              if (moveResult.success && moveResult.plan) {
                let chainedMove = moveResult.plan as TurnPlanMoveTrain;
                // Cap movement at remaining allowance using effective mileposts
                // (intra-city hops within major city red areas are free and must not consume budget)
                if (chainedMove.path) {
                  const chainEffective = computeEffectivePathLength(chainedMove.path, getMajorCityLookup());
                  if (chainEffective > remainingMovement) {
                    chainedMove = {
                      ...chainedMove,
                      path: TurnComposer.truncatePathToEffectiveBudget(chainedMove.path, remainingMovement),
                    };
                  }
                }
                if (chainedMove.path && chainedMove.path.length > 0) {
                  const moveSim = ActionResolver.cloneSnapshot(snapshot);
                  const moveCtx = { ...context };
                  const splitResult = await TurnComposer.splitMoveForOpportunities(
                    chainedMove, moveSim, moveCtx, activeRoute,
                  );
                  activeRoute = splitResult.route ?? activeRoute;
                  // Insert move steps before the build step
                  const buildIdx = steps.findIndex(s => s.type === AIActionType.BuildTrack);
                  steps.splice(buildIdx >= 0 ? buildIdx : steps.length, 0, ...splitResult.plans);
                  trace.a3 = { movePreprended: true };
                }
                break; // Successfully prepended a MOVE — stop trying targets
              } else {
                console.log(`[TurnComposer] A3 prepend MOVE to ${moveTarget} failed: ${moveResult.error}`);
              }
            }
          }
        }
      }
    } catch (err) {
      // Phase A errors are non-fatal — keep the primary plan (BE-007: improved logging)
      const phase = steps.length <= 1 ? 'A0/A1' : `A2 (iteration ${steps.length})`;
      console.error(
        `[TurnComposer] Phase ${phase} error:`,
        err instanceof Error ? err.message : err,
        err instanceof Error ? err.stack : '',
      );
    }

    // ── Phase B: Build/Upgrade ──
    // JIRA-105: Skip build if plan already contains an UpgradeTrain action (game rule: upgrade replaces building)
    const hasUpgradeInSteps = steps.some(s => s.type === AIActionType.UpgradeTrain);
    if (!skipBuildPhase && !hasUpgradeInSteps) {
      try {
        // INF-002: Log when upgrade would be preferred over building
        const canAffordUpgrade = simContext.canUpgrade && simSnapshot.bot.money >= TURN_BUILD_BUDGET;
        if (canAffordUpgrade) {
          trace.build.upgradeConsidered = true;
          const buildBudget = Math.min(TURN_BUILD_BUDGET - simContext.turnBuildCost, simSnapshot.bot.money);
          // Upgrade is preferred when no meaningful build target exists or budget is too low for useful track
          if (buildBudget < 5) {
            console.log(`[TurnComposer] Phase B: upgrade preferred over build (cash=${simSnapshot.bot.money}, buildBudget=${buildBudget}, train=${simSnapshot.bot.trainType})`);
          }
        }

        const buildResult = await TurnComposer.tryAppendBuild(
          simSnapshot, simContext, activeRoute, trace, brain, gridPoints,
        );
        if (buildResult.plan) {
          steps.push(buildResult.plan);
          if (buildResult.plan.type === AIActionType.BuildTrack) {
            trace.build.target = buildResult.plan.targetCity ?? null;
            trace.build.cost = buildResult.plan.segments.reduce((s, seg) => s + seg.cost, 0);
          }
        } else if (canAffordUpgrade) {
          console.log(`[TurnComposer] Phase B: upgrade preferred over build (cash=${simSnapshot.bot.money}, no build target found, train=${simSnapshot.bot.trainType})`);
        }
      } catch (err) {
        // Phase B errors are non-fatal
        console.error('[TurnComposer] Phase B error:', err instanceof Error ? err.message : err);
      }
    } else {
      trace.build.skipped = true;
    }

    // ── Collect pickups/deliveries added during composition ──
    const inputTypes = new Set(trace.inputPlan);
    for (const step of steps) {
      if (step.type === AIActionType.PickupLoad && !inputTypes.has(AIActionType.PickupLoad)) {
        trace.pickups.push({ load: step.load, city: step.city });
      }
      if (step.type === AIActionType.DeliverLoad && !inputTypes.has(AIActionType.DeliverLoad)) {
        trace.deliveries.push({ load: step.load, city: step.city });
      }
    }

    // ── Return result ──
    if (steps.length > 1) {
      return wrapResult({ type: 'MultiAction' as const, steps });
    }
    return wrapResult(steps[0] ?? primaryPlan);
  }

  /**
   * Split a MOVE into interleaved [MOVE_SEGMENT, ACTION, MOVE_SEGMENT, ...]
   * when intermediate cities along the path have pickup/deliver opportunities.
   *
   * Per EuroRails rules: "Picking up or unloading a load does not reduce
   * movement — the player may continue moving at full allowance."
   *
   * If no intermediate opportunities exist, returns the original move unchanged.
   */
  private static async splitMoveForOpportunities(
    movePlan: TurnPlanMoveTrain,
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute?: StrategicRoute | null,
  ): Promise<{ plans: TurnPlan[], route: StrategicRoute | null | undefined }> {
    const plans: TurnPlan[] = [];
    const gridPoints = loadGridPoints();
    const path = movePlan.path;
    let lastSplitIndex = 0;
    let currentRoute = activeRoute;

    // Cargo slot reservation: count consecutive upcoming pickup stops so
    // opportunistic pickups don't block planned multi-pickups (BE-002, JIRA-92).
    let reservedSlots = 0;
    if (activeRoute && activeRoute.currentStopIndex < activeRoute.stops.length) {
      for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
        if (activeRoute.stops[i].action === 'pickup') reservedSlots++;
        else break;
      }
    }

    // Walk path positions (skip index 0 — that's where the bot started)
    for (let i = 1; i < path.length; i++) {
      const pos = path[i];
      const cityName = gridPoints.get(`${pos.row},${pos.col}`)?.name;
      if (!cityName) continue;

      // Simulate bot at this position
      snapshot.bot.position = { row: pos.row, col: pos.col };
      const actionPlans: TurnPlan[] = [];

      // Planned stop enforcement: execute the route's next pickup/deliver at this city
      // before opportunistic scans.
      if (currentRoute && currentRoute.currentStopIndex < currentRoute.stops.length) {
        const plannedStop = currentRoute.stops[currentRoute.currentStopIndex];
        if (plannedStop.city === cityName) {
          const plannedActionType = plannedStop.action === 'pickup' ? 'PICKUP' : 'DELIVER';
          const plannedResult = await ActionResolver.resolve(
            { action: plannedActionType, details: { load: plannedStop.loadType, at: cityName }, reasoning: '', planHorizon: '' },
            snapshot, context,
          );
          if (plannedResult.success && plannedResult.plan) {
            actionPlans.push(plannedResult.plan);
            ActionResolver.applyPlanToState(plannedResult.plan, snapshot, context);
            currentRoute = { ...currentRoute, currentStopIndex: currentRoute.currentStopIndex + 1 };
            console.log(
              `[TurnComposer] Planned stop executed at ${cityName}: ${plannedActionType} ${plannedStop.loadType}`,
            );
          } else {
            console.warn(
              `[TurnComposer] Planned stop failed at ${cityName}: ${plannedActionType} ${plannedStop.loadType} (${plannedResult.error ?? 'unknown error'})`,
            );
          }
        }
      }

      // Check for DELIVER: bot carries a load AND demand card exists for load+city
      for (const rd of snapshot.bot.resolvedDemands) {
        for (const demand of rd.demands) {
          if (
            demand.city === cityName &&
            snapshot.bot.loads.includes(demand.loadType)
          ) {
            const result = await ActionResolver.resolve(
              { action: 'DELIVER', details: { load: demand.loadType, at: cityName }, reasoning: '', planHorizon: '' },
              snapshot, context,
            );
            if (result.success && result.plan) {
              actionPlans.push(result.plan);
              ActionResolver.applyPlanToState(result.plan, snapshot, context);
              // JIRA-69: Advance route index past completed delivery stop
              if (currentRoute && currentRoute.currentStopIndex < currentRoute.stops.length) {
                const currentStop = currentRoute.stops[currentRoute.currentStopIndex];
                if (currentStop.action === 'deliver' && currentStop.loadType === demand.loadType && currentStop.city === cityName) {
                  currentRoute = { ...currentRoute, currentStopIndex: currentRoute.currentStopIndex + 1 };
                }
              }
              // JIRA-69: Remove fulfilled demand from context.demands
              const deliverPlan = result.plan as TurnPlanDeliverLoad;
              context.demands = context.demands.filter(d => d.cardIndex !== deliverPlan.cardId);
            }
          }
        }
      }

      // Check for PICKUP: city produces loads matching demands, bot has capacity
      // Pick up ALL matching loads up to cargo capacity (FR-5: multi-load pickup)
      // Reserve slots for planned pickups so opportunistic ones don't block them (BE-002)
      const effectiveCapacity = TurnComposer.getBotCapacity(snapshot) - reservedSlots;
      const availableLoads = snapshot.loadAvailability[cityName] ?? [];
      for (const loadType of availableLoads) {
        // Pick up multiple copies of same type if bot has multiple matching demands (JIRA-52)
        while (snapshot.bot.loads.length < effectiveCapacity) {
          const carriedCount = snapshot.bot.loads.filter(l => l === loadType).length;
          const demandCount = snapshot.bot.resolvedDemands.reduce((count, rd) =>
            count + rd.demands.filter(d => d.loadType === loadType).length, 0);
          if (carriedCount >= demandCount) break;

          // JIRA-57: Skip feasibility check for route-planned pickups.
          // The LLM already evaluated this pickup when planning the route.
          const isRoutePlannedPickup = activeRoute?.stops.some(
            (stop, idx) => idx >= (activeRoute?.currentStopIndex ?? 0) &&
              stop.action === 'pickup' &&
              stop.loadType === loadType &&
              stop.city === cityName,
          );

          // Delivery feasibility pre-filter: reject if no demand has an affordable,
          // profitable delivery path. Prevents picking up "dead weight" loads that
          // the bot can't profitably deliver (Bug 1 / BE-001).
          // JIRA-87: Relaxed gate — also accept deliveries achievable within
          // current movement + 1 turn (estimatedTurns <= 2), allowing multi-turn
          // pickup detours for en-route opportunities.
          if (!isRoutePlannedPickup) {
            const matchingDemands = context.demands.filter(d => d.loadType === loadType);
            if (matchingDemands.length > 0) {
              const hasFeasibleDelivery = matchingDemands.some(
                d => d.isDeliveryOnNetwork ||
                  d.estimatedTurns <= 2 ||
                  (d.estimatedTrackCostToDelivery <= d.payout && d.estimatedTrackCostToDelivery <= snapshot.bot.money),
              );
              if (!hasFeasibleDelivery) {
                const bestDemand = matchingDemands[0];
                console.warn(
                  `[TurnComposer] Rejected infeasible opportunistic pickup: "${loadType}" at "${cityName}" — ` +
                  `delivery to "${bestDemand.deliveryCity}" costs ~${bestDemand.estimatedTrackCostToDelivery}M ` +
                  `(payout: ${bestDemand.payout}M, bot has: ${snapshot.bot.money}M, est. turns: ${bestDemand.estimatedTurns})`,
                );
                break;
              }
            }
          }

          const result = await ActionResolver.resolve(
            { action: 'PICKUP', details: { load: loadType, at: cityName }, reasoning: '', planHorizon: '' },
            snapshot, context,
          );
          if (result?.success && result.plan) {
            actionPlans.push(result.plan);
            ActionResolver.applyPlanToState(result.plan, snapshot, context);
            // JIRA-69: Advance route index past completed pickup stop
            if (currentRoute && currentRoute.currentStopIndex < currentRoute.stops.length) {
              const currentStop = currentRoute.stops[currentRoute.currentStopIndex];
              if (currentStop.action === 'pickup' && currentStop.loadType === loadType && currentStop.city === cityName) {
                currentRoute = { ...currentRoute, currentStopIndex: currentRoute.currentStopIndex + 1 };
              }
            }
          } else {
            break;
          }
        }
      }

      // If actions were found at this intermediate city, split the move here
      if (actionPlans.length > 0) {
        // Emit MOVE segment from lastSplitIndex to this city
        // Propagate fees from original movePlan on the first segment only (fee is per-turn, not per-segment)
        const moveSegment = path.slice(lastSplitIndex, i + 1);
        if (moveSegment.length > 1) {
          const isFirstSegment = plans.filter(p => p.type === AIActionType.MoveTrain).length === 0;
          plans.push({
            type: AIActionType.MoveTrain,
            path: moveSegment,
            fees: isFirstSegment ? movePlan.fees : new Set<string>(),
            totalFee: isFirstSegment ? movePlan.totalFee : 0,
          } as TurnPlanMoveTrain);
        }
        // Emit the actions at this city
        plans.push(...actionPlans);
        lastSplitIndex = i;
      }
    }

    // Emit remaining move segment (from last action city to final destination)
    if (lastSplitIndex < path.length - 1) {
      const remainingPath = path.slice(lastSplitIndex);
      if (remainingPath.length > 1) {
        const isFirstSegment = plans.filter(p => p.type === AIActionType.MoveTrain).length === 0;
        plans.push({
          type: AIActionType.MoveTrain,
          path: remainingPath,
          fees: isFirstSegment ? movePlan.fees : new Set<string>(),
          totalFee: isFirstSegment ? movePlan.totalFee : 0,
        } as TurnPlanMoveTrain);
      }
    }

    // If no actions were found, return the original move unchanged
    if (plans.length === 0) {
      return { plans: [movePlan], route: currentRoute };
    }

    return { plans, route: currentRoute };
  }

  /**
   * Attempt to append a build step using the current (post-operation) budget.
   * JIRA-129: Integrates BuildAdvisor when brain is provided. Falls back to
   * existing logic when brain is null/undefined or advisor returns null.
   */
  static async tryAppendBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute?: StrategicRoute | null,
    trace?: CompositionTrace,
    brain?: LLMStrategyBrain | null,
    gridPoints?: import('../../../shared/types/GameTypes').GridPoint[],
  ): Promise<BuildResult> {
    const emptyResult: BuildResult = { plan: null };

    // Check budget: need money and build capacity remaining
    const remainingBudget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);
    if (remainingBudget <= 0) return emptyResult;

    // Collect unreached route stops for multi-stop look-ahead
    const currentStopIndex = activeRoute?.currentStopIndex ?? 0;
    const currentStop = activeRoute?.stops[currentStopIndex];
    const unreachedRouteStops: string[] = [];
    if (activeRoute) {
      for (let i = currentStopIndex; i < activeRoute.stops.length; i++) {
        const city = activeRoute.stops[i].city;
        if (!context.citiesOnNetwork.includes(city)) {
          unreachedRouteStops.push(city);
        }
      }
    }

    // Guard: route complete or invalid stop index
    if (activeRoute && (!currentStop || currentStopIndex >= activeRoute.stops.length)) {
      return emptyResult;
    }

    // JIRA-125: Victory conditions — unconditional victory build tier
    const victoryConditionsMet = snapshot.bot.money >= 250 &&
      (context.connectedMajorCities?.length ?? 0) < 7;

    // Victory override: filter route stops to major cities only
    let routeStopsForBuild = unreachedRouteStops;
    let victoryOverrodeRoute = false;
    if (victoryConditionsMet && unreachedRouteStops.length > 0) {
      const majorCityNames = new Set(getMajorCityLookup().values());
      routeStopsForBuild = unreachedRouteStops.filter(city => majorCityNames.has(city));
      victoryOverrodeRoute = routeStopsForBuild.length < unreachedRouteStops.length;
    }

    // ── JIRA-129: Build Advisor integration ─────────────────────────────
    // Exemptions: bypass advisor for victory builds, initial build phase, zero budget, or no brain
    const isInitialBuild = context.isInitialBuild === true;
    const useAdvisor = brain && gridPoints && !isInitialBuild && !victoryConditionsMet && remainingBudget > 0;

    const allBuildSegments: TrackSegment[] = [];
    let buildBudgetSpent = context.turnBuildCost;
    let buildSnapshot = snapshot;
    let lastBuildTargetCity: string | undefined;
    let advisorResult: BuildAdvisorResult | null = null;
    let solvencyRetries = 0;
    let advisorLatencyMs = 0;
    let updatedRoute: StrategicRoute | undefined;

    if (useAdvisor) {
      // Call BuildAdvisor
      const advisorStart = Date.now();
      advisorResult = await BuildAdvisor.advise(
        snapshot, context, activeRoute ?? null, gridPoints, brain,
      );
      advisorLatencyMs = Date.now() - advisorStart;

      if (advisorResult) {
        // ── Solvency retry loop (max 2 retries) ────────────────────────
        const MAX_SOLVENCY_RETRIES = 2;
        let currentAdvisorResult: BuildAdvisorResult | null = advisorResult;

        for (let attempt = 0; attempt <= MAX_SOLVENCY_RETRIES; attempt++) {
          if (!currentAdvisorResult) break;

          const buildCity = TurnComposer.getAdvisorBuildTarget(currentAdvisorResult);
          const buildWaypoints = TurnComposer.getAdvisorWaypoints(currentAdvisorResult);

          if (currentAdvisorResult.action === 'useOpponentTrack') {
            // Skip building for this corridor; use alternativeBuild if present
            if (currentAdvisorResult.alternativeBuild) {
              const altCity = currentAdvisorResult.alternativeBuild.target;
              const altWaypoints = currentAdvisorResult.alternativeBuild.waypoints;
              const altResult = await TurnComposer.resolveAdvisorBuild(
                altCity, altWaypoints, buildSnapshot, context, buildBudgetSpent, activeRoute,
              );
              if (altResult.segments.length > 0) {
                allBuildSegments.push(...altResult.segments);
                lastBuildTargetCity = altCity;
                buildBudgetSpent += altResult.cost;
              }
            }
            break;
          }

          if (currentAdvisorResult.action === 'replan' && currentAdvisorResult.newRoute) {
            // Validate the replan route
            const newStops: RouteStop[] = currentAdvisorResult.newRoute;
            const candidateRoute: StrategicRoute = {
              stops: newStops,
              currentStopIndex: 0,
              phase: 'build',
              createdAtTurn: context.turnNumber,
              reasoning: currentAdvisorResult.reasoning,
              startingCity: activeRoute?.startingCity,
            };
            const validation = RouteValidator.validate(candidateRoute, context, snapshot);
            if (validation.valid) {
              updatedRoute = candidateRoute;
              // Build toward new route's first unbuilt stop using waypoints
              const firstStop = newStops[0]?.city;
              if (firstStop && buildWaypoints.length > 0) {
                const replanResult = await TurnComposer.resolveAdvisorBuild(
                  firstStop, buildWaypoints, buildSnapshot, context, buildBudgetSpent, activeRoute,
                );
                if (replanResult.segments.length > 0) {
                  allBuildSegments.push(...replanResult.segments);
                  lastBuildTargetCity = firstStop;
                  buildBudgetSpent += replanResult.cost;
                }
              }
            } else {
              console.log(`[TurnComposer] Advisor replan route rejected by RouteValidator — falling back`);
              // Fall back to alternativeBuild or existing logic
              if (currentAdvisorResult.alternativeBuild) {
                const altCity = currentAdvisorResult.alternativeBuild.target;
                const altWaypoints = currentAdvisorResult.alternativeBuild.waypoints;
                const altResult = await TurnComposer.resolveAdvisorBuild(
                  altCity, altWaypoints, buildSnapshot, context, buildBudgetSpent, activeRoute,
                );
                if (altResult.segments.length > 0) {
                  allBuildSegments.push(...altResult.segments);
                  lastBuildTargetCity = altCity;
                  buildBudgetSpent += altResult.cost;
                }
              }
            }
            break;
          }

          // build or buildAlternative
          if (buildCity) {
            const buildResult = await TurnComposer.resolveAdvisorBuild(
              buildCity, buildWaypoints, buildSnapshot, context, buildBudgetSpent, activeRoute,
            );

            if (buildResult.segments.length > 0) {
              // Solvency check
              const solvency = SolvencyCheck.check(buildResult.segments, buildSnapshot, context);
              if (solvency.canAfford) {
                allBuildSegments.push(...buildResult.segments);
                lastBuildTargetCity = buildCity;
                buildBudgetSpent += buildResult.cost;
                buildSnapshot = {
                  ...buildSnapshot,
                  bot: {
                    ...buildSnapshot.bot,
                    existingSegments: [...buildSnapshot.bot.existingSegments, ...buildResult.segments],
                  },
                };
                break; // Success — exit retry loop
              }

              // Insolvent — retry if attempts remain
              if (attempt < MAX_SOLVENCY_RETRIES) {
                solvencyRetries++;
                const retryStart = Date.now();
                currentAdvisorResult = await BuildAdvisor.retryWithSolvencyFeedback(
                  currentAdvisorResult, solvency.actualCost, solvency.availableForBuild,
                  snapshot, context, activeRoute ?? null, gridPoints, brain,
                );
                advisorLatencyMs += Date.now() - retryStart;
                continue; // Re-run with new advisor result
              }

              // Max retries exhausted — use whatever segments we have if buildable
              if (buildResult.cost <= remainingBudget) {
                allBuildSegments.push(...buildResult.segments);
                lastBuildTargetCity = buildCity;
                buildBudgetSpent += buildResult.cost;
              }
            }
          }
          break; // Exit retry loop
        }
      }

      // Record advisor trace (including raw LLM diagnostics)
      if (trace) {
        const diag = BuildAdvisor.lastDiagnostics;
        trace.advisor = {
          action: advisorResult?.action ?? null,
          reasoning: advisorResult?.reasoning ?? null,
          waypoints: advisorResult?.waypoints ?? [],
          solvencyRetries,
          latencyMs: advisorLatencyMs,
          fallback: !advisorResult || (allBuildSegments.length === 0 && routeStopsForBuild.length > 0),
          rawResponse: diag.rawResponse,
          rawWaypoints: diag.rawWaypoints,
          error: diag.error,
        };
      }

      // Fallback to pre-advisor logic if advisor produced nothing
      if (allBuildSegments.length === 0 && advisorResult === null) {
        console.log('[TurnComposer] BuildAdvisor returned null — falling back to pre-advisor logic');
        // Fall through to existing route-based build logic below
      }
    }

    // ── JIRA-139: Conservative JIT build fallback ──────────────────────
    // Only build if advisor wasn't used or failed, active route has an
    // unreached stop, and track runway is < 2 turns (bot will run out soon).
    if (allBuildSegments.length === 0 && (!useAdvisor || advisorResult === null)) {
      if (routeStopsForBuild.length > 0) {
        const jitCity = routeStopsForBuild[0];
        const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
        const runway = TurnComposer.calculateTrackRunway(snapshot, jitCity, trainSpeed, context);

        if (runway >= 2) {
          console.log(`[TurnComposer] JIT fallback: runway ${runway.toFixed(1)} >= 2 for ${jitCity}, deferring build`);
        } else {
          console.log(`[TurnComposer] JIT fallback: runway ${runway.toFixed(1)} < 2 for ${jitCity}, building`);
          const iterBudget = Math.min(TURN_BUILD_BUDGET - buildBudgetSpent, snapshot.bot.money - (buildBudgetSpent - context.turnBuildCost));
          if (iterBudget > 0) {
            const iterContext = { ...context, turnBuildCost: buildBudgetSpent };
            try {
              const result = await ActionResolver.resolve(
                { action: 'BUILD', details: { toward: jitCity }, reasoning: '', planHorizon: '' },
                buildSnapshot, iterContext,
                activeRoute?.startingCity,
              );
              if (result?.success && result.plan && result.plan.type === AIActionType.BuildTrack && result.plan.segments.length > 0) {
                allBuildSegments.push(...result.plan.segments);
                lastBuildTargetCity = jitCity;
                const cost = result.plan.segments.reduce((s, seg) => s + seg.cost, 0);
                buildBudgetSpent += cost;
              }
            } catch (err) {
              console.warn(`[TurnComposer] JIT fallback build failed for ${jitCity}:`, err instanceof Error ? err.message : err);
            }
          }
        }
      } else {
        console.log('[TurnComposer] JIT fallback: no unreached route stops, skipping build');
      }
    }

    // JIRA-125: Victory build tier — spend remaining budget toward cheapest unconnected major city
    if (victoryConditionsMet) {
      const unconnected = context.unconnectedMajorCities ?? [];
      const victoryBudget = Math.min(TURN_BUILD_BUDGET - buildBudgetSpent, snapshot.bot.money - (buildBudgetSpent - context.turnBuildCost));
      if (unconnected.length > 0 && victoryBudget > 0) {
        const victoryTarget = unconnected.find(uc => !routeStopsForBuild.includes(uc.cityName));
        if (victoryTarget) {
          const iterContext = { ...context, turnBuildCost: buildBudgetSpent };
          try {
            const victoryResult = await ActionResolver.resolve(
              { action: 'BUILD', details: { toward: victoryTarget.cityName }, reasoning: '', planHorizon: '' },
              buildSnapshot, iterContext,
              activeRoute?.startingCity,
            );
            if (victoryResult?.success && victoryResult.plan?.type === AIActionType.BuildTrack && victoryResult.plan.segments.length > 0) {
              allBuildSegments.push(...victoryResult.plan.segments);
              lastBuildTargetCity = victoryTarget.cityName;
              const cost = victoryResult.plan.segments.reduce((s, seg) => s + seg.cost, 0);
              if (trace) {
                trace.victoryBuild = { target: victoryTarget.cityName, cost, triggered: true, overrodeRoute: victoryOverrodeRoute };
              }
            }
          } catch {
            // Victory build resolve failed — fall through
          }
        }
      }
      if (trace && !trace.victoryBuild) {
        trace.victoryBuild = { target: null, cost: 0, triggered: false, overrodeRoute: victoryOverrodeRoute };
      }
    }

    if (allBuildSegments.length > 0) {
      return {
        plan: {
          type: AIActionType.BuildTrack,
          segments: allBuildSegments,
          targetCity: lastBuildTargetCity,
        },
        updatedRoute,
        advisorAction: advisorResult?.action,
        advisorWaypoints: advisorResult?.waypoints,
        advisorReasoning: advisorResult?.reasoning,
        advisorLatencyMs: advisorLatencyMs > 0 ? advisorLatencyMs : undefined,
        solvencyRetries: solvencyRetries > 0 ? solvencyRetries : undefined,
      };
    }

    // Fallback when no route-specific or victory build target exists.
    if (!victoryConditionsMet) {
      const routeNeedsBuild = unreachedRouteStops.length > 0;
      const isMidRoute = activeRoute &&
        (activeRoute.phase === 'travel' || activeRoute.phase === 'act');
      let buildTarget: string | null = null;
      if (!routeNeedsBuild && !isMidRoute) {
        const unconnected = context.unconnectedMajorCities ?? [];
        if (unconnected.length > 0 && snapshot.bot.money > 230) {
          buildTarget = unconnected[0].cityName;
        }
      }

      if (buildTarget) {
        const result = await ActionResolver.resolve(
          { action: 'BUILD', details: { toward: buildTarget }, reasoning: '', planHorizon: '' },
          snapshot, context,
          activeRoute?.startingCity,
        );

        if (result.success && result.plan) {
          return { plan: result.plan };
        }
      }
    }

    return emptyResult;
  }

  /**
   * JIRA-129: Resolve a build toward a target city using advisor waypoints.
   */
  private static async resolveAdvisorBuild(
    targetCity: string,
    waypoints: [number, number][],
    snapshot: WorldSnapshot,
    context: GameContext,
    buildBudgetSpent: number,
    activeRoute?: StrategicRoute | null,
  ): Promise<{ segments: TrackSegment[]; cost: number }> {
    const iterContext = { ...context, turnBuildCost: buildBudgetSpent };
    const details: Record<string, string> & { waypoints?: [number, number][] } = { toward: targetCity };
    if (waypoints.length > 0) {
      details.waypoints = waypoints;
    }
    try {
      const result = await ActionResolver.resolve(
        { action: 'BUILD', details: details as Record<string, string>, reasoning: '', planHorizon: '' },
        snapshot, iterContext,
        activeRoute?.startingCity,
      );
      if (result?.success && result.plan?.type === AIActionType.BuildTrack && result.plan.segments.length > 0) {
        const cost = result.plan.segments.reduce((s, seg) => s + seg.cost, 0);
        return { segments: result.plan.segments, cost };
      }
    } catch {
      // Resolve error
    }
    return { segments: [], cost: 0 };
  }

  /**
   * JIRA-129: Extract the build target city from an advisor result.
   */
  private static getAdvisorBuildTarget(result: BuildAdvisorResult): string | null {
    if (result.action === 'build' || result.action === 'buildAlternative') {
      return result.target;
    }
    return null;
  }

  /**
   * JIRA-129: Extract waypoints from an advisor result.
   */
  private static getAdvisorWaypoints(result: BuildAdvisorResult): [number, number][] {
    return result.waypoints ?? [];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Scan for near-miss build opportunities (ferry ports, demand city spurs)
   * and build the best one if worthwhile and within budget.
   * Returns the build plan if a near-miss was built, or null.
   */
  private static async tryNearMissBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<TurnPlan | null> {
    // Build network node set from existing segments
    const networkNodeKeys = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      networkNodeKeys.add(makeKey(seg.from.row, seg.from.col));
      networkNodeKeys.add(makeKey(seg.to.row, seg.to.col));
    }

    // Skip analysis for tiny networks
    if (networkNodeKeys.size < 3) return null;

    const gridPoints = loadGridPoints();
    const remainingBudget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);

    // Scan for ferry port opportunities
    const ferryOpps = NetworkBuildAnalyzer.findNearbyFerryPorts(networkNodeKeys, gridPoints);

    // Derive demand cities from context for spur scanning
    const demandCities: Array<{ city: string; position: { row: number; col: number } }> = [];
    const seenCities = new Set<string>();
    for (const demand of context.demands) {
      for (const cityName of [demand.supplyCity, demand.deliveryCity]) {
        if (seenCities.has(cityName)) continue;
        seenCities.add(cityName);
        // Resolve city name to grid position
        for (const [, gp] of gridPoints) {
          if (gp.name && gp.name.toLowerCase() === cityName.toLowerCase()) {
            demandCities.push({ city: cityName, position: { row: gp.row, col: gp.col } });
            break;
          }
        }
      }
    }

    const spurOpps = NetworkBuildAnalyzer.findSpurOpportunities(networkNodeKeys, demandCities, gridPoints);

    // Evaluate all opportunities
    const speed = context.speed ?? 9;
    interface EvaluatedOpportunity {
      type: 'ferry' | 'spur';
      target: string;
      buildCost: number;
      netValue: number;
    }
    const evaluated: EvaluatedOpportunity[] = [];

    for (const ferry of ferryOpps) {
      const totalCost = ferry.spurCost + ferry.ferryCost;
      if (totalCost > remainingBudget) continue;
      const eval_ = NetworkBuildAnalyzer.evaluateBuildOption(
        { buildCost: totalCost, distanceSaved: 20, alternativeDistance: 40 },
        context.turnNumber,
        speed,
      );
      if (eval_.isWorthwhile) {
        evaluated.push({
          type: 'ferry',
          target: ferry.ferryName,
          buildCost: totalCost,
          netValue: eval_.turnsSaved * eval_.valuePerTurn - totalCost,
        });
      }
    }

    for (const spur of spurOpps) {
      if (spur.spurCost > remainingBudget) continue;
      const eval_ = NetworkBuildAnalyzer.evaluateBuildOption(
        { buildCost: spur.spurCost, distanceSaved: spur.spurSegments * 2, alternativeDistance: spur.spurSegments * 3 },
        context.turnNumber,
        speed,
      );
      if (eval_.isWorthwhile) {
        evaluated.push({
          type: 'spur',
          target: spur.city,
          buildCost: spur.spurCost,
          netValue: eval_.turnsSaved * eval_.valuePerTurn - spur.spurCost,
        });
      }
    }

    if (evaluated.length === 0) return null;

    // Sort by net value descending and pick the best
    evaluated.sort((a, b) => b.netValue - a.netValue);
    const best = evaluated[0];

    console.log(`[TurnComposer] Near-miss build substituted: ${best.type} ${best.target} (net value ${best.netValue.toFixed(1)}M) over route-directed build`);

    // Build toward the near-miss target via existing pipeline
    try {
      const result = await ActionResolver.resolve(
        { action: 'BUILD', details: { toward: best.target }, reasoning: 'near-miss optimization', planHorizon: '' },
        snapshot, context,
      );
      if (result?.success && result.plan && result.plan.type === AIActionType.BuildTrack && result.plan.segments.length > 0) {
        return result.plan;
      }
    } catch {
      // Near-miss build failed — fall through to standard build
    }

    return null;
  }

  /**
   * JIRA-122: Determine if the bot should defer building this turn.
   * Two-part check:
   *   1. Delivery certainty — is the train committed to a delivery that requires this build?
   *   2. Track runway — does the train have >= 2 turns of existing track toward destination?
   *
   * Exempt: near-miss builds, initial build phase, victory builds.
   * Returns true to defer (skip build), false to proceed.
   */
  static shouldDeferBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute | null | undefined,
    buildTarget: string,
    trainSpeed: number,
  ): { deferred: boolean; reason: string; trackRunway: number } {
    // Exemption: initial build phase (first 2 turns)
    if (context.isInitialBuild || context.turnNumber <= 2) {
      return { deferred: false, reason: 'initial_build_exempt', trackRunway: 0 };
    }

    // Exemption: victory builds (cash > 230M, building toward major city connections)
    if (snapshot.bot.money > 230) {
      const unconnected = context.unconnectedMajorCities ?? [];
      if (unconnected.some(c => c.cityName === buildTarget)) {
        return { deferred: false, reason: 'victory_build_exempt', trackRunway: 0 };
      }
    }

    // Check 1: Delivery certainty — build target must be in active route stops
    if (!activeRoute) {
      return { deferred: true, reason: 'no_active_route', trackRunway: 0 };
    }

    const routeStops = activeRoute.stops.map(s => s.city.toLowerCase());
    const targetInRoute = routeStops.includes(buildTarget.toLowerCase());
    if (!targetInRoute) {
      return { deferred: true, reason: 'target_not_in_route', trackRunway: 0 };
    }

    // Check delivery commitment: train should have the load, be near pickup, or actively building toward route
    // When route phase is 'build', the bot is explicitly in the build-toward-stop phase — allow it
    if (activeRoute.phase !== 'build') {
      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      if (currentStop) {
        const isDeliveryCommitted = context.loads.includes(currentStop.loadType) ||
          activeRoute.phase === 'travel' || activeRoute.phase === 'act';
        if (!isDeliveryCommitted) {
          return { deferred: true, reason: 'not_committed_to_delivery', trackRunway: 0 };
        }
      }
    }

    // Check 2: Track runway — defer if >= 2 turns of existing track remain
    const runway = TurnComposer.calculateTrackRunway(snapshot, buildTarget, trainSpeed, context);
    if (runway >= 2) {
      return { deferred: true, reason: 'sufficient_runway', trackRunway: runway };
    }

    return { deferred: false, reason: 'build_needed', trackRunway: runway };
  }

  /**
   * JIRA-122: Calculate how many turns of existing track the train has
   * before needing new track toward a destination.
   *
   * Counts mileposts of existing track toward destination and divides by train speed.
   */
  static calculateTrackRunway(
    snapshot: WorldSnapshot,
    destinationCity: string,
    trainSpeed: number,
    context: GameContext,
  ): number {
    if (!snapshot.bot.position || trainSpeed <= 0) return 0;

    // If destination is already on the network, full path exists
    if (context.citiesOnNetwork.includes(destinationCity)) {
      // Rough estimate: use existing segment count as proxy
      // A fully connected destination means effectively infinite runway
      return 10;
    }

    // Build a set of network node keys
    const networkNodeKeys = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      networkNodeKeys.add(makeKey(seg.from.row, seg.from.col));
      networkNodeKeys.add(makeKey(seg.to.row, seg.to.col));
    }

    // Find the destination city position
    const gridPoints = loadGridPoints();
    let destPosition: { row: number; col: number } | null = null;
    for (const [, gp] of gridPoints) {
      if (gp.name && gp.name.toLowerCase() === destinationCity.toLowerCase()) {
        destPosition = { row: gp.row, col: gp.col };
        break;
      }
    }
    if (!destPosition) return 0;

    // BFS from bot position along existing network toward destination
    // Count how many mileposts of track exist in the direction of the destination
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

          // Only follow existing network edges
          if (!networkNodeKeys.has(key)) continue;

          // Check if this segment actually exists (both directions)
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

  /**
   * Find MOVE targets in priority order: route stops first, then demand-based fallbacks.
   * Returns ALL candidates so callers can iterate and try resolveMove on each
   * until one succeeds (the primary route target may be unreachable).
   */
  private static findMoveTargets(
    context: GameContext,
    activeRoute?: StrategicRoute | null,
  ): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const add = (city: string) => {
      if (!seen.has(city)) {
        seen.add(city);
        targets.push(city);
      }
    };

    // Priority 1: Route stops (in order, skipping completed ones)
    if (activeRoute) {
      for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
        const stop = activeRoute.stops[i];
        // Skip pickup stops if bot already has the load (pickup was completed during composition)
        if (stop.action === 'pickup' && context.loads.includes(stop.loadType)) {
          continue;
        }
        // Skip deliver stops if bot does NOT have the load (delivery was already completed)
        if (stop.action === 'deliver' && !context.loads.includes(stop.loadType)) {
          continue;
        }
        add(stop.city);
      }
    }

    // Priority 1.5: Frontier approach — when next route stop is off-network,
    // move toward the on-network city closest to that off-network target (JIRA-115).
    // Prevents backtracking to already-visited cities when the bot is at a branch endpoint.
    if (activeRoute) {
      for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
        const stop = activeRoute.stops[i];
        // Skip completed stops (same logic as P1)
        if (stop.action === 'pickup' && context.loads.includes(stop.loadType)) continue;
        if (stop.action === 'deliver' && !context.loads.includes(stop.loadType)) continue;

        if (!context.citiesOnNetwork.includes(stop.city)) {
          // This stop is off-network — find the closest on-network city
          const gridPoints = loadGridPoints();
          // Look up the off-network target's coordinates
          let targetRow = -1, targetCol = -1;
          for (const [, gp] of gridPoints) {
            if (gp.name && gp.name === stop.city) {
              targetRow = gp.row;
              targetCol = gp.col;
              break;
            }
          }
          if (targetRow >= 0) {
            let bestCity = '';
            let bestDist = Infinity;
            for (const networkCity of context.citiesOnNetwork) {
              for (const [, gp] of gridPoints) {
                if (gp.name && gp.name === networkCity) {
                  const dist = Math.abs(gp.row - targetRow) + Math.abs(gp.col - targetCol);
                  if (dist < bestDist) {
                    bestDist = dist;
                    bestCity = networkCity;
                  }
                  break;
                }
              }
            }
            if (bestCity) {
              add(bestCity);
              console.log(
                `[TurnComposer] JIRA-115: Frontier approach — off-network target "${stop.city}", ` +
                `moving toward closest on-network city "${bestCity}" (dist=${bestDist})`,
              );
            }
          }
          break; // Only target the first off-network stop
        }
      }
    }

    // Priority 2: Demand delivery cities on network (bot has the load)
    // Use live context.loads instead of stale demand.isLoadOnTrain — loads change
    // during turn composition (deliveries remove loads, pickups add them).
    const sorted = [...context.demands].sort((a, b) => b.demandScore - a.demandScore);
    for (const demand of sorted) {
      if (context.loads.includes(demand.loadType) && demand.isDeliveryOnNetwork) {
        add(demand.deliveryCity);
      }
    }

    // Priority 3: Demand supply cities on network (bot can pick up)
    // Use live context.loads instead of stale demand.isLoadOnTrain.
    for (const demand of sorted) {
      if (!context.loads.includes(demand.loadType) && demand.isSupplyOnNetwork) {
        add(demand.supplyCity);
      }
    }

    // Priority 4: Reachable cities — always appended as fallback targets.
    // Priorities 1-3 may add cities that are on the network but not reachable
    // from the bot's current position (e.g., on disconnected track segments).
    // If all P1-3 targets fail to resolve, these reachable cities ensure the
    // A2 loop can still chain a continuation MOVE (JIRA-50).
    let reachableAdded = 0;
    for (const city of context.reachableCities) {
      if (!seen.has(city)) {
        add(city);
        reachableAdded++;
        if (reachableAdded >= 3) break;
      }
    }

    return targets;
  }

  /**
   * Check if bot is at or near the build frontier — the point on its existing
   * track network closest to the build target. If true, A3 should skip the
   * move prepend to avoid sending the bot away from the construction area.
   */
  private static isBotAtBuildFrontier(
    snapshot: WorldSnapshot,
    context: GameContext,
    buildTargetCity: string,
  ): boolean {
    if (!context.position || snapshot.bot.existingSegments.length === 0) return false;

    const gridPoints = loadGridPoints();
    let targetRow = -1, targetCol = -1;
    for (const [, gp] of gridPoints) {
      if (gp.name && gp.name === buildTargetCity) {
        targetRow = gp.row;
        targetCol = gp.col;
        break;
      }
    }
    if (targetRow < 0) return false;

    // Find the track endpoint closest to the build target
    let bestDist = Infinity;
    for (const seg of snapshot.bot.existingSegments) {
      for (const pt of [seg.from, seg.to]) {
        const dist = Math.abs(pt.row - targetRow) + Math.abs(pt.col - targetCol);
        if (dist < bestDist) bestDist = dist;
      }
    }

    // Check if bot position is within Manhattan distance 3 of that closest endpoint
    const botRow = context.position.row;
    const botCol = context.position.col;
    let botToFrontierDist = Infinity;
    for (const seg of snapshot.bot.existingSegments) {
      for (const pt of [seg.from, seg.to]) {
        const ptToTarget = Math.abs(pt.row - targetRow) + Math.abs(pt.col - targetCol);
        if (ptToTarget <= bestDist + 1) {
          // This point is near the frontier — check bot distance to it
          const botToPt = Math.abs(botRow - pt.row) + Math.abs(botCol - pt.col);
          if (botToPt < botToFrontierDist) botToFrontierDist = botToPt;
        }
      }
    }

    return botToFrontierDist <= 3;
  }

  /**
   * Filter move targets to only include cities closer to (or equidistant from)
   * the build target than the bot's current position. Prevents A3 from sending
   * the bot in the wrong direction.
   */
  private static filterByDirection(
    targets: string[],
    context: GameContext,
    buildTargetCity: string,
  ): string[] {
    if (!context.position) return targets;

    const gridPoints = loadGridPoints();
    let targetRow = -1, targetCol = -1;
    for (const [, gp] of gridPoints) {
      if (gp.name && gp.name === buildTargetCity) {
        targetRow = gp.row;
        targetCol = gp.col;
        break;
      }
    }
    if (targetRow < 0) return targets;

    const botDist = Math.abs(context.position.row - targetRow) + Math.abs(context.position.col - targetCol);

    return targets.filter(city => {
      for (const [, gp] of gridPoints) {
        if (gp.name && gp.name === city) {
          const candidateDist = Math.abs(gp.row - targetRow) + Math.abs(gp.col - targetCol);
          return candidateDist <= botDist;
        }
      }
      return false; // City not found in grid — exclude
    });
  }

  /**
   * Count total effective mileposts used across all MOVE steps.
   * Intra-city hops (within a major city's red area) are discounted as free.
   */
  private static countMovementUsed(steps: TurnPlan[]): number {
    const majorCityLookup = getMajorCityLookup();
    let used = 0;
    for (const step of steps) {
      if (step.type === AIActionType.MoveTrain) {
        const movePath = (step as TurnPlanMoveTrain).path;
        const rawLength = Math.max(0, movePath.length - 1);
        const effectiveLength = computeEffectivePathLength(movePath, majorCityLookup);
        if (effectiveLength !== rawLength) {
          console.warn(
            `[TurnComposer] Movement step: raw ${rawLength} edges, effective ${effectiveLength}mp (intra-city hops discounted)`,
          );
        }
        used += effectiveLength;
      }
    }
    return used;
  }

  /**
   * Truncate a path to a given effective movement budget.
   * Unlike raw slicing, this correctly skips intra-city hops (which are free)
   * so the truncated path uses exactly `effectiveBudget` real mileposts.
   */
  private static truncatePathToEffectiveBudget(
    path: Array<{ row: number; col: number }>,
    effectiveBudget: number,
  ): Array<{ row: number; col: number }> {
    const majorCityLookup = getMajorCityLookup();
    let effectiveCount = 0;
    let budgetTruncated = path;
    for (let i = 0; i < path.length - 1; i++) {
      const fromKey = `${path[i].row},${path[i].col}`;
      const toKey = `${path[i + 1].row},${path[i + 1].col}`;
      const fromCity = majorCityLookup.get(fromKey);
      const toCity = majorCityLookup.get(toKey);
      if (!(fromCity && fromCity === toCity)) {
        effectiveCount++;
      }
      if (effectiveCount >= effectiveBudget) {
        budgetTruncated = path.slice(0, i + 2); // include both endpoints of the last edge
        break;
      }
    }

    // Ferry port boundary scan: trains must stop at ferry ports (skip index 0 — starting position)
    const grid = loadGridPoints();
    for (let i = 1; i < budgetTruncated.length; i++) {
      const pointKey = `${budgetTruncated[i].row},${budgetTruncated[i].col}`;
      if (grid.get(pointKey)?.terrain === TerrainType.FerryPort) {
        return budgetTruncated.slice(0, i + 1);
      }
    }

    return budgetTruncated;
  }

  /** Extract action type strings from a plan (for trace logging). */
  private static planActionTypes(plan: TurnPlan): string[] {
    if (plan.type === 'MultiAction') {
      return plan.steps.map(s => s.type);
    }
    return [plan.type];
  }

  /**
   * Get the bot's train capacity.
   */
  private static getBotCapacity(snapshot: WorldSnapshot): number {
    const trainType = snapshot.bot.trainType;
    // Match TRAIN_PROPERTIES logic
    switch (trainType) {
      case 'HeavyFreight':
      case 'Superfreight':
        return 3;
      default:
        return 2;
    }
  }
}
