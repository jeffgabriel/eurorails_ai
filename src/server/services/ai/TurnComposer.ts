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
import { getMajorCityLookup } from '../../../shared/services/majorCityGroups';

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
      // A1: If primary contains a MOVE, scan path for pickup/deliver opportunities
      const movePlan = steps.find(s => s.type === AIActionType.MoveTrain) as TurnPlanMoveTrain | undefined;
      if (movePlan && movePlan.path.length > 0) {
        const pathPlans = await TurnComposer.scanPathOpportunities(
          movePlan.path, simSnapshot, simContext,
        );
        for (const plan of pathPlans) {
          steps.push(plan);
          ActionResolver.applyPlanToState(plan, simSnapshot, simContext);
        }
      }

      // A2: If primary is PICKUP or DELIVER (no MOVE yet), try to chain a MOVE
      const primaryType = steps[0]?.type;
      const hasMove = steps.some(s => s.type === AIActionType.MoveTrain);
      if (!hasMove && (primaryType === AIActionType.PickupLoad || primaryType === AIActionType.DeliverLoad)) {
        const moveTarget = TurnComposer.findMoveTarget(simContext, activeRoute);
        if (moveTarget) {
          const moveResult = await ActionResolver.resolve(
            { action: 'MOVE', details: { to: moveTarget }, reasoning: '', planHorizon: '' },
            simSnapshot, simContext,
          );
          if (moveResult.success && moveResult.plan) {
            steps.push(moveResult.plan);
            ActionResolver.applyPlanToState(moveResult.plan, simSnapshot, simContext);
            // Scan the new move path for opportunities
            const newMovePlan = moveResult.plan as TurnPlanMoveTrain;
            if (newMovePlan.path.length > 0) {
              const pathPlans = await TurnComposer.scanPathOpportunities(
                newMovePlan.path, simSnapshot, simContext,
              );
              for (const plan of pathPlans) {
                steps.push(plan);
                ActionResolver.applyPlanToState(plan, simSnapshot, simContext);
              }
            }
          }
        }
      }
    } catch (err) {
      // Phase A errors are non-fatal — keep the primary plan
      console.warn('[TurnComposer] Phase A error (skipped):', err instanceof Error ? err.message : err);
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
        console.warn('[TurnComposer] Phase B error (skipped):', err instanceof Error ? err.message : err);
      }
    }

    // ── Return result ──
    if (steps.length > 1) {
      return { type: 'MultiAction' as const, steps };
    }
    return primaryPlan;
  }

  /**
   * Scan a move path for pickup/deliver opportunities at intermediate
   * and destination cities.
   */
  private static async scanPathOpportunities(
    path: { row: number; col: number }[],
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<TurnPlan[]> {
    const plans: TurnPlan[] = [];
    const majorCityLookup = getMajorCityLookup();

    // Walk path positions (skip index 0 — that's where the bot started)
    for (let i = 1; i < path.length; i++) {
      const pos = path[i];
      const cityName = majorCityLookup.get(`${pos.row},${pos.col}`);
      if (!cityName) continue;

      // Simulate bot at this position
      snapshot.bot.position = { row: pos.row, col: pos.col };

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
              plans.push(result.plan);
              ActionResolver.applyPlanToState(result.plan, snapshot, context);
            }
          }
        }
      }

      // Check for PICKUP: city produces a load matching a demand, bot has capacity
      const trainCapacity = TurnComposer.getBotCapacity(snapshot);
      if (snapshot.bot.loads.length < trainCapacity) {
        const availableLoads = snapshot.loadAvailability[cityName] ?? [];
        for (const loadType of availableLoads) {
          // Skip if already carrying this load type
          if (snapshot.bot.loads.includes(loadType)) continue;

          // Check if any demand card wants this load
          const hasDemand = snapshot.bot.resolvedDemands.some(rd =>
            rd.demands.some(d => d.loadType === loadType),
          );
          if (!hasDemand) continue;

          const result = await ActionResolver.resolve(
            { action: 'PICKUP', details: { load: loadType, at: cityName }, reasoning: '', planHorizon: '' },
            snapshot, context,
          );
          if (result.success && result.plan) {
            plans.push(result.plan);
            ActionResolver.applyPlanToState(result.plan, snapshot, context);
            break; // One pickup per city to avoid over-filling
          }
        }
      }
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

    // Fallback to demand cards
    if (!buildTarget) {
      buildTarget = PlanExecutor.findDemandBuildTarget(context);
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
   * Find the best MOVE target based on route or demand cards.
   */
  private static findMoveTarget(
    context: GameContext,
    activeRoute?: StrategicRoute | null,
  ): string | null {
    // If there's an active route, move toward the next stop city
    if (activeRoute) {
      const nextStop = activeRoute.stops[activeRoute.currentStopIndex];
      if (nextStop) return nextStop.city;
    }

    // Fallback: move toward the highest-payout demand delivery city on network
    const sorted = [...context.demands].sort((a, b) => b.payout - a.payout);
    for (const demand of sorted) {
      if (demand.isLoadOnTrain && demand.isDeliveryOnNetwork) {
        return demand.deliveryCity;
      }
    }
    for (const demand of sorted) {
      if (!demand.isLoadOnTrain && demand.isSupplyOnNetwork) {
        return demand.supplyCity;
      }
    }
    return null;
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
