/**
 * PlanExecutor — State machine that auto-executes a StrategicRoute over multiple turns.
 *
 * Given the current route, stop index, phase, and game state, determines which TurnPlan
 * to produce this turn. Advances the route's phase/stop index after execution.
 *
 * Phase logic for each stop:
 *   1. 'build': Is the target city on our track network?
 *      - NO  → resolveBuild({ toward: stop.city }) → stay in 'build' phase
 *      - YES → transition to 'travel' phase
 *   2. 'travel': Are we at the target city?
 *      - NO  → resolveMove({ to: stop.city }) → stay in 'travel'
 *      - YES → transition to 'act' phase
 *   3. 'act': Execute the stop action
 *      - pickup  → resolvePickup  → advance currentStopIndex, reset phase to 'build'
 *      - deliver → resolveDeliver → advance currentStopIndex, reset phase to 'build'
 *      - If this was the last stop → route is complete
 *
 * Multi-action combining (game rules allow move+act+build in one turn):
 *   - When a MoveTrain arrives at the target city, chain the act phase (pickup/deliver)
 *   - After any non-build operational action, append a BuildTrack toward future stops
 */

import {
  StrategicRoute,
  RouteStop,
  WorldSnapshot,
  GameContext,
  TurnPlan,
  AIActionType,
  ResolvedAction,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';
import { getMajorCityLookup } from '../../../shared/services/majorCityGroups';

export interface PlanExecutorResult {
  plan: TurnPlan;
  /** Whether the route should be cleared (completed or abandoned) */
  routeComplete: boolean;
  /** Whether the current stop failed and the route should be abandoned */
  routeAbandoned: boolean;
  /** Updated route (with advanced stop/phase) — save to memory if not cleared */
  updatedRoute: StrategicRoute;
  /** Human-readable description of what happened */
  description: string;
}

export class PlanExecutor {
  /**
   * Determine the TurnPlan for this turn based on the active route.
   *
   * Returns a result containing the plan to execute, whether the route is complete,
   * and the updated route state (advanced stop/phase).
   */
  static async execute(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<PlanExecutorResult> {
    const currentStop = route.stops[route.currentStopIndex];
    if (!currentStop) {
      // All stops completed — route is done
      return PlanExecutor.routeCompleted(route, 'All route stops completed.');
    }

    const tag = `[PlanExecutor stop=${route.currentStopIndex}/${route.stops.length} phase=${route.phase}]`;

    let result: PlanExecutorResult;

    switch (route.phase) {
      case 'build':
        result = await PlanExecutor.executeBuildPhase(route, currentStop, snapshot, context, tag);
        break;
      case 'travel':
        result = await PlanExecutor.executeTravelPhase(route, currentStop, snapshot, context, tag);
        break;
      case 'act':
        result = await PlanExecutor.executeActPhase(route, currentStop, snapshot, context, tag);
        break;
      default:
        return PlanExecutor.routeCompleted(route, `Unknown phase: ${route.phase}`);
    }

    // Enhancement 1: Chain arrival action when move lands at target city
    result = await PlanExecutor.chainArrivalAction(result, route, snapshot, context, tag);

    // Enhancement 3: Chain move toward next stop after pickup/deliver
    result = await PlanExecutor.chainMoveAfterAct(result, snapshot, context, tag);

    // Enhancement 2: Append build step after non-build operational actions
    result = await PlanExecutor.appendBuildStep(result, snapshot, context, tag);

    return result;
  }

  /**
   * Build phase: check if target city is on network, if not → build toward it.
   */
  private static async executeBuildPhase(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    const targetCity = stop.city;

    // Check if target city is already on our track network
    if (context.citiesOnNetwork.includes(targetCity)) {
      console.log(`${tag} ${targetCity} is on network, transitioning to 'travel' phase`);
      const updatedRoute = PlanExecutor.advancePhase(route, 'travel');
      // Recurse into travel phase immediately (same turn)
      return PlanExecutor.executeTravelPhase(updatedRoute, stop, snapshot, context, tag);
    }

    // Need to build toward the target city
    if (!context.canBuild) {
      // Can't build this turn (budget exhausted or no money) — pass and retry next turn
      return {
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: `${tag} Cannot build this turn (budget exhausted). Waiting.`,
      };
    }

    const buildResult = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: targetCity }, reasoning: '', planHorizon: '' },
      snapshot,
      context,
      route.startingCity,
    );

    if (buildResult.success && buildResult.plan) {
      return {
        plan: buildResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: `${tag} Building toward ${targetCity}`,
      };
    }

    // Build failed — still stay in build phase, don't abandon route yet
    // (might succeed next turn with more budget)
    console.warn(`${tag} Build toward ${targetCity} failed: ${buildResult.error}`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: route,
      description: `${tag} Build failed (${buildResult.error}), will retry next turn`,
    };
  }

  /**
   * Travel phase: check if bot is at target city, if not → move toward it.
   */
  private static async executeTravelPhase(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    const targetCity = stop.city;

    // Check if bot is already at the target city
    const atCity = PlanExecutor.isBotAtCity(context, targetCity);
    if (atCity) {
      console.log(`${tag} Bot is at ${targetCity}, transitioning to 'act' phase`);
      const updatedRoute = PlanExecutor.advancePhase(route, 'act');
      // Recurse into act phase immediately (same turn)
      return PlanExecutor.executeActPhase(updatedRoute, stop, snapshot, context, tag);
    }

    // During initialBuild phase, bot can't move — stay in travel phase
    if (context.isInitialBuild) {
      return {
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: `${tag} Initial build phase — cannot move yet`,
      };
    }

    // Try to move toward the target city
    const moveResult = await ActionResolver.resolve(
      { action: 'MOVE', details: { to: targetCity }, reasoning: '', planHorizon: '' },
      snapshot,
      context,
    );

    if (moveResult.success && moveResult.plan) {
      return {
        plan: moveResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: `${tag} Moving toward ${targetCity}`,
      };
    }

    // Move failed — city might not be reachable via our track. Try building instead.
    console.warn(`${tag} Move to ${targetCity} failed: ${moveResult.error}. Trying BUILD fallback.`);
    const updatedRoute = PlanExecutor.advancePhase(route, 'build');
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute,
      description: `${tag} Move failed, reverting to build phase`,
    };
  }

  /**
   * Act phase: execute the stop action (pickup or deliver).
   */
  private static async executeActPhase(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    let actionResult: ResolvedAction;

    if (stop.action === 'pickup') {
      actionResult = await ActionResolver.resolve(
        { action: 'PICKUP', details: { load: stop.loadType, at: stop.city }, reasoning: '', planHorizon: '' },
        snapshot,
        context,
      );
    } else {
      // deliver
      actionResult = await ActionResolver.resolve(
        { action: 'DELIVER', details: { load: stop.loadType, at: stop.city }, reasoning: '', planHorizon: '' },
        snapshot,
        context,
      );
    }

    if (actionResult.success && actionResult.plan) {
      // Advance to next stop
      const isLastStop = route.currentStopIndex >= route.stops.length - 1;
      if (isLastStop) {
        return {
          plan: actionResult.plan,
          routeComplete: true,
          routeAbandoned: false,
          updatedRoute: PlanExecutor.advanceStop(route),
          description: `${tag} Completed final stop: ${stop.action} ${stop.loadType} at ${stop.city}. Route complete!`,
        };
      }

      return {
        plan: actionResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: PlanExecutor.advanceStop(route),
        description: `${tag} ${stop.action} ${stop.loadType} at ${stop.city}. Advancing to next stop.`,
      };
    }

    // Action failed — abandon the route
    console.warn(`${tag} ${stop.action} failed: ${actionResult.error}. Abandoning route.`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: true,
      updatedRoute: route,
      description: `${tag} ${stop.action} failed (${actionResult.error}). Route abandoned.`,
    };
  }

  // ── Multi-Action Combining ─────────────────────────────────────────────

  /**
   * Enhancement 1: When a MoveTrain plan arrives at the target city, chain the
   * act phase (pickup/deliver) into the same turn as a MultiAction.
   */
  private static async chainArrivalAction(
    result: PlanExecutorResult,
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    // Only chain when the primary action is a MoveTrain in the travel phase
    if (result.plan.type !== AIActionType.MoveTrain) return result;
    if (result.routeComplete || result.routeAbandoned) return result;

    const currentStop = result.updatedRoute.stops[result.updatedRoute.currentStopIndex];
    if (!currentStop) return result;

    // Check if the move's final position lands at the target city
    const path = result.plan.path;
    if (path.length === 0) return result;
    const finalPos = path[path.length - 1];
    const majorCityLookup = getMajorCityLookup();
    const arrivedCity = majorCityLookup.get(`${finalPos.row},${finalPos.col}`);
    if (arrivedCity !== currentStop.city) return result;

    console.log(`${tag} Move arrives at ${currentStop.city} — chaining ${currentStop.action} action`);

    // Resolve the act phase for the stop we just arrived at
    const advancedRoute = PlanExecutor.advancePhase(result.updatedRoute, 'act');
    const actResult = await PlanExecutor.executeActPhase(advancedRoute, currentStop, snapshot, context, tag);

    // If act failed, still return the move — don't lose it
    if (actResult.plan.type === AIActionType.PassTurn || actResult.routeAbandoned) {
      return result;
    }

    // Combine move + act into a MultiAction
    return {
      plan: { type: 'MultiAction' as const, steps: [result.plan, actResult.plan] },
      routeComplete: actResult.routeComplete,
      routeAbandoned: false,
      updatedRoute: actResult.updatedRoute,
      description: `${result.description} → ${actResult.description}`,
    };
  }

  /**
   * Enhancement 3: After a pickup or deliver action, chain a MOVE toward the next
   * stop city if the route has more stops. Game rules allow pickup + move in one turn.
   */
  private static async chainMoveAfterAct(
    result: PlanExecutorResult,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    // Only fire when primary plan is PickupLoad or DeliverLoad
    const primaryType = PlanExecutor.getPrimaryActionType(result.plan);
    if (primaryType !== AIActionType.PickupLoad && primaryType !== AIActionType.DeliverLoad) return result;

    // Don't chain if route is complete/abandoned or during initialBuild
    if (result.routeComplete || result.routeAbandoned) return result;
    if (context.isInitialBuild) return result;

    // Find the next stop city from the updated route
    const nextStop = result.updatedRoute.stops[result.updatedRoute.currentStopIndex];
    if (!nextStop) return result;

    const nextCity = nextStop.city;

    // Try to move toward the next stop's city
    const moveResult = await ActionResolver.resolve(
      { action: 'MOVE', details: { to: nextCity }, reasoning: '', planHorizon: '' },
      snapshot,
      context,
    );

    if (!moveResult.success || !moveResult.plan) return result;

    console.log(`${tag} Chaining move toward ${nextCity} after ${primaryType}`);

    // Combine into MultiAction
    const existingSteps = result.plan.type === 'MultiAction' ? result.plan.steps : [result.plan];
    return {
      ...result,
      plan: { type: 'MultiAction' as const, steps: [...existingSteps, moveResult.plan] },
      description: `${result.description} + move toward ${nextCity}`,
    };
  }

  /**
   * Enhancement 2: After any non-BuildTrack operational action, append a BuildTrack
   * step toward the next stop city not yet on the track network.
   * Per game rules, building happens AFTER operating the train.
   */
  private static async appendBuildStep(
    result: PlanExecutorResult,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    // Don't append build if:
    // - Can't build this turn
    // - During initial build phase (no operational actions happening)
    // - The primary action is already a BuildTrack (it IS the build)
    // - The result is a PassTurn (nothing useful to combine with)
    if (!context.canBuild) return result;
    if (context.isInitialBuild) return result;

    const primaryType = PlanExecutor.getPrimaryActionType(result.plan);
    if (primaryType === AIActionType.BuildTrack || primaryType === AIActionType.PassTurn) return result;

    // Find build target: route stops first, then demand cards (including after route completion)
    let buildTarget: string | null;
    if (result.routeComplete || result.routeAbandoned) {
      // Route done — look at demand cards for next build opportunity
      buildTarget = PlanExecutor.findDemandBuildTarget(context);
    } else {
      buildTarget = PlanExecutor.findNextBuildTarget(result.updatedRoute, context);
    }
    if (!buildTarget) return result;

    // Resolve a build toward the target
    const buildResult = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: buildTarget }, reasoning: '', planHorizon: '' },
      snapshot,
      context,
      result.updatedRoute.startingCity,
    );

    if (!buildResult.success || !buildResult.plan) return result;

    console.log(`${tag} Appending build toward ${buildTarget}`);

    // Combine into MultiAction
    const existingSteps = result.plan.type === 'MultiAction' ? result.plan.steps : [result.plan];
    return {
      ...result,
      plan: { type: 'MultiAction' as const, steps: [...existingSteps, buildResult.plan] },
      description: `${result.description} + build toward ${buildTarget}`,
    };
  }

  /**
   * Find the next stop city in the route that is not already on the track network.
   * Searches from the current stop index forward, falling back to demand cards.
   */
  private static findNextBuildTarget(route: StrategicRoute, context: GameContext): string | null {
    for (let i = route.currentStopIndex; i < route.stops.length; i++) {
      const city = route.stops[i].city;
      if (!context.citiesOnNetwork.includes(city)) {
        return city;
      }
    }
    // All route stops are on network — fall back to demand card cities
    return PlanExecutor.findDemandBuildTarget(context);
  }

  /**
   * Find a build target from demand cards — the highest-payout demand whose
   * delivery or supply city is not yet on the track network.
   */
  static findDemandBuildTarget(context: GameContext): string | null {
    const sorted = [...context.demands].sort((a, b) => b.payout - a.payout);
    for (const demand of sorted) {
      if (!demand.isDeliveryOnNetwork) return demand.deliveryCity;
      if (!demand.isSupplyOnNetwork) return demand.supplyCity;
    }
    return null;
  }

  /**
   * Get the primary action type from a plan (unwraps MultiAction to first step).
   */
  private static getPrimaryActionType(plan: TurnPlan): AIActionType | 'MultiAction' {
    if (plan.type === 'MultiAction') {
      return plan.steps.length > 0 ? plan.steps[0].type as AIActionType : AIActionType.PassTurn;
    }
    return plan.type;
  }

  // ── Route State Management ────────────────────────────────────────────────

  /** Advance to a new phase within the same stop */
  private static advancePhase(route: StrategicRoute, newPhase: 'build' | 'travel' | 'act'): StrategicRoute {
    return { ...route, phase: newPhase };
  }

  /** Advance to the next stop, reset phase to 'build' */
  private static advanceStop(route: StrategicRoute): StrategicRoute {
    return {
      ...route,
      currentStopIndex: route.currentStopIndex + 1,
      phase: 'build',
    };
  }

  /** Create a "route completed" result */
  private static routeCompleted(route: StrategicRoute, description: string): PlanExecutorResult {
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: true,
      routeAbandoned: false,
      updatedRoute: route,
      description,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Check if the bot is currently at the named city */
  private static isBotAtCity(context: GameContext, cityName: string): boolean {
    if (!context.position) return false;
    // Check direct city name match from context
    if (context.position.city === cityName) return true;
    // Check if city is in reachable cities with 0 distance (we're AT it)
    // This is a heuristic — the definitive check is in ActionResolver.isBotAtCity
    return false;
  }
}
