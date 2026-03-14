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
  WorldSnapshot,
  GameContext,
  AIActionType,
  StrategicRoute,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';
import { loadGridPoints } from './MapTopology';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';

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
  /** A3: Whether a MOVE was prepended before BUILD */
  a3: { movePreprended: boolean };
  /** Phase B: Build/upgrade target and cost, or why skipped */
  build: { target: string | null; cost: number; skipped: boolean; upgradeConsidered: boolean };
  /** Pickups added during composition */
  pickups: Array<{ load: string; city: string }>;
  /** Deliveries added during composition */
  deliveries: Array<{ load: string; city: string }>;
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

              // Check if this stop's action is still needed
              if (nextStop.action === 'pickup' && simSnapshot.bot.loads.includes(nextStop.loadType)) {
                activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
                continue; // Already picked up — skip
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
        const movementUsed = TurnComposer.countMovementUsed(steps);
        const remainingMovement = context.speed - movementUsed;
        if (remainingMovement > 0) {
          // Try multiple targets — the route's build target city is likely
          // unreachable (that's why PlanExecutor chose BUILD), so fall back
          // to demand-based cities on the existing track network.
          const moveTargets = TurnComposer.findMoveTargets(context, activeRoute);
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
        const canAffordUpgrade = simContext.canUpgrade && simSnapshot.bot.money >= 20;
        if (canAffordUpgrade) {
          trace.build.upgradeConsidered = true;
          const buildBudget = Math.min(20 - simContext.turnBuildCost, simSnapshot.bot.money);
          // Upgrade is preferred when no meaningful build target exists or budget is too low for useful track
          if (buildBudget < 5) {
            console.log(`[TurnComposer] Phase B: upgrade preferred over build (cash=${simSnapshot.bot.money}, buildBudget=${buildBudget}, train=${simSnapshot.bot.trainType})`);
          }
        }

        const buildPlan = await TurnComposer.tryAppendBuild(
          simSnapshot, simContext, activeRoute,
        );
        if (buildPlan) {
          steps.push(buildPlan);
          if (buildPlan.type === AIActionType.BuildTrack) {
            trace.build.target = buildPlan.targetCity ?? null;
            trace.build.cost = buildPlan.segments.reduce((s, seg) => s + seg.cost, 0);
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
   */
  static async tryAppendBuild(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute?: StrategicRoute | null,
  ): Promise<TurnPlan | null> {
    // Check budget: need money and build capacity remaining
    const remainingBudget = Math.min(20 - context.turnBuildCost, snapshot.bot.money);
    if (remainingBudget <= 0) return null;

    // Find build target from route stops first
    let buildTarget: string | null = null;
    if (activeRoute && !activeRoute.stops.every((_, idx) => idx < activeRoute.currentStopIndex)) {
      for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
        const city = activeRoute.stops[i].city;
        if (!context.citiesOnNetwork.includes(city)) {
          buildTarget = city;
          break;
        }
      }
    }

    // Fallback when no route-specific build target exists.
    // Prefer route-stop targets > victory progress > speculative demand builds.
    // BUT: skip speculative builds when mid-route (travel/act phase) — the bot should
    // finish its delivery first to earn money, then build toward victory cities.
    const routeNeedsBuild = activeRoute &&
      activeRoute.stops.slice(activeRoute.currentStopIndex).some(
        stop => !context.citiesOnNetwork.includes(stop.city),
      );
    const isMidRoute = activeRoute &&
      (activeRoute.phase === 'travel' || activeRoute.phase === 'act');
    if (!buildTarget && !routeNeedsBuild && !isMidRoute) {
      // Build toward cheapest unconnected major city (victory progress)
      // Only invest in victory builds when cash > 230M (within striking distance of 250M win)
      if (!buildTarget) {
        const unconnected = context.unconnectedMajorCities ?? [];
        if (unconnected.length > 0 && snapshot.bot.money > 230) {
          // Already sorted by estimatedCost in ContextBuilder
          buildTarget = unconnected[0].cityName;
        }
      }
    }

    if (!buildTarget) return null;

    const result = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: buildTarget }, reasoning: '', planHorizon: '' },
      snapshot, context,
      activeRoute?.startingCity,
    );

    if (result.success && result.plan) {
      return result.plan;
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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
    for (let i = 0; i < path.length - 1; i++) {
      const fromKey = `${path[i].row},${path[i].col}`;
      const toKey = `${path[i + 1].row},${path[i + 1].col}`;
      const fromCity = majorCityLookup.get(fromKey);
      const toCity = majorCityLookup.get(toKey);
      if (!(fromCity && fromCity === toCity)) {
        effectiveCount++;
      }
      if (effectiveCount >= effectiveBudget) {
        return path.slice(0, i + 2); // include both endpoints of the last edge
      }
    }
    return path; // path fits within budget
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
