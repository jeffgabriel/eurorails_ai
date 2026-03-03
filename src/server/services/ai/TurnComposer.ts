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
  WorldSnapshot,
  GameContext,
  AIActionType,
  StrategicRoute,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';
import { PlanExecutor } from './PlanExecutor';
import { loadGridPoints } from './MapTopology';

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
  ): Promise<TurnPlan> {
    // ── Exclusive actions: return unchanged ──
    if (primaryPlan.type === AIActionType.DiscardHand) return primaryPlan;
    if (primaryPlan.type === AIActionType.PassTurn) return primaryPlan;

    // During initialBuild, no operational enrichment is possible (no train movement)
    if (context.isInitialBuild) return primaryPlan;

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
        const splitPlans = await TurnComposer.splitMoveForOpportunities(
          movePlan, simSnapshot, simContext,
        );
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

      // A2: If the last step is PICKUP or DELIVER, try to chain a continuation MOVE.
      // This handles both:
      //   - Primary was PICKUP/DELIVER (no MOVE yet) — chain a full MOVE
      //   - A1 split a MOVE and found a pickup/deliver at the destination — continue moving
      const lastStepType = steps[steps.length - 1]?.type;
      if (lastStepType === AIActionType.PickupLoad || lastStepType === AIActionType.DeliverLoad) {
        // Cap continuation MOVE at remaining movement allowance
        const movementUsed = TurnComposer.countMovementUsed(steps);
        const remainingMovement = simContext.speed - movementUsed;

        if (remainingMovement > 0) {
          // Try multiple targets in priority order — the primary route target
          // may be unreachable if track hasn't been built there yet.
          const moveTargets = TurnComposer.findMoveTargets(simContext, activeRoute);
          for (const moveTarget of moveTargets) {
            const moveResult = await ActionResolver.resolve(
              { action: 'MOVE', details: { to: moveTarget }, reasoning: '', planHorizon: '' },
              simSnapshot, simContext,
            );
            if (moveResult.success && moveResult.plan) {
              let chainedMove = moveResult.plan as TurnPlanMoveTrain;
              // Truncate path to remaining movement allowance
              if (chainedMove.path.length - 1 > remainingMovement) {
                chainedMove = {
                  ...chainedMove,
                  path: chainedMove.path.slice(0, remainingMovement + 1),
                };
              }
              if (chainedMove.path.length > 1) {
                const splitPlans = await TurnComposer.splitMoveForOpportunities(
                  chainedMove, simSnapshot, simContext,
                );
                for (const plan of splitPlans) {
                  steps.push(plan);
                  ActionResolver.applyPlanToState(plan, simSnapshot, simContext);
                }
              }
              break; // Successfully chained a MOVE — stop trying targets
            } else {
              console.log(`[TurnComposer] A2 continuation MOVE to ${moveTarget} failed: ${moveResult.error}`);
            }
          }
        }
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
              // Cap movement at remaining allowance
              if (chainedMove.path && chainedMove.path.length - 1 > remainingMovement) {
                chainedMove = {
                  ...chainedMove,
                  path: chainedMove.path.slice(0, remainingMovement + 1),
                };
              }
              if (chainedMove.path && chainedMove.path.length > 0) {
                const moveSim = ActionResolver.cloneSnapshot(snapshot);
                const moveCtx = { ...context };
                const splitPlans = await TurnComposer.splitMoveForOpportunities(
                  chainedMove, moveSim, moveCtx,
                );
                // Insert move steps before the build step
                const buildIdx = steps.findIndex(s => s.type === AIActionType.BuildTrack);
                steps.splice(buildIdx >= 0 ? buildIdx : steps.length, 0, ...splitPlans);
              }
              break; // Successfully prepended a MOVE — stop trying targets
            } else {
              console.log(`[TurnComposer] A3 prepend MOVE to ${moveTarget} failed: ${moveResult.error}`);
            }
          }
        }
      }
    } catch (err) {
      // Phase A errors are non-fatal — keep the primary plan
      console.error('[TurnComposer] Phase A error:', err instanceof Error ? err.message : err);
    }

    // ── Phase B: Build/Upgrade ──
    if (!skipBuildPhase) {
      try {
        const buildPlan = await TurnComposer.tryAppendBuild(
          simSnapshot, simContext, activeRoute,
        );
        if (buildPlan) {
          steps.push(buildPlan);
        }
      } catch (err) {
        // Phase B errors are non-fatal
        console.error('[TurnComposer] Phase B error:', err instanceof Error ? err.message : err);
      }
    }

    // ── Return result ──
    if (steps.length > 1) {
      return { type: 'MultiAction' as const, steps };
    }
    return steps[0] ?? primaryPlan;
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
  ): Promise<TurnPlan[]> {
    const plans: TurnPlan[] = [];
    const gridPoints = loadGridPoints();
    const path = movePlan.path;
    let lastSplitIndex = 0;

    // Walk path positions (skip index 0 — that's where the bot started)
    for (let i = 1; i < path.length; i++) {
      const pos = path[i];
      const cityName = gridPoints.get(`${pos.row},${pos.col}`)?.name;
      if (!cityName) continue;

      // Simulate bot at this position
      snapshot.bot.position = { row: pos.row, col: pos.col };
      const actionPlans: TurnPlan[] = [];

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
            }
          }
        }
      }

      // Check for PICKUP: city produces loads matching demands, bot has capacity
      // Pick up ALL matching loads up to cargo capacity (FR-5: multi-load pickup)
      const availableLoads = snapshot.loadAvailability[cityName] ?? [];
      for (const loadType of availableLoads) {
        if (snapshot.bot.loads.length >= TurnComposer.getBotCapacity(snapshot)) break;
        if (snapshot.bot.loads.includes(loadType)) continue;
        const hasDemand = snapshot.bot.resolvedDemands.some(rd =>
          rd.demands.some(d => d.loadType === loadType),
        );
        if (!hasDemand) continue;
        const result = await ActionResolver.resolve(
          { action: 'PICKUP', details: { load: loadType, at: cityName }, reasoning: '', planHorizon: '' },
          snapshot, context,
        );
        if (result.success && result.plan) {
          actionPlans.push(result.plan);
          ActionResolver.applyPlanToState(result.plan, snapshot, context);
        }
      }

      // If actions were found at this intermediate city, split the move here
      if (actionPlans.length > 0) {
        // Emit MOVE segment from lastSplitIndex to this city
        const moveSegment = path.slice(lastSplitIndex, i + 1);
        if (moveSegment.length > 1) {
          plans.push({
            type: AIActionType.MoveTrain,
            path: moveSegment,
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
        plans.push({
          type: AIActionType.MoveTrain,
          path: remainingPath,
        } as TurnPlanMoveTrain);
      }
    }

    // If no actions were found, return the original move unchanged
    if (plans.length === 0) {
      return [movePlan];
    }

    return plans;
  }

  /**
   * Attempt to append a build step using the current (post-operation) budget.
   */
  private static async tryAppendBuild(
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
      // Priority 3: Build toward demand cities (last resort greedy heuristic)
      if (!buildTarget) {
        buildTarget = PlanExecutor.findDemandBuildTarget(context);
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
    const sorted = [...context.demands].sort((a, b) => b.payout - a.payout);
    for (const demand of sorted) {
      if (demand.isLoadOnTrain && demand.isDeliveryOnNetwork) {
        add(demand.deliveryCity);
      }
    }

    // Priority 3: Demand supply cities on network (bot can pick up)
    for (const demand of sorted) {
      if (!demand.isLoadOnTrain && demand.isSupplyOnNetwork) {
        add(demand.supplyCity);
      }
    }

    return targets;
  }

  /**
   * Count total mileposts used across all MOVE steps.
   * Path includes the start position, so milepost count = path.length - 1.
   */
  private static countMovementUsed(steps: TurnPlan[]): number {
    let used = 0;
    for (const step of steps) {
      if (step.type === AIActionType.MoveTrain) {
        used += Math.max(0, (step as TurnPlanMoveTrain).path.length - 1);
      }
    }
    return used;
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
