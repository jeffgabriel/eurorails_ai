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
 * Multi-action combining is handled by TurnComposer (post-decision layer).
 * PlanExecutor returns raw single-phase plans.
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

    // During initialBuild, if the current stop's city is the starting city or already
    // connected, find a different build target — but DON'T advance currentStopIndex.
    // Stop actions (pickup/deliver) haven't been completed; we're just choosing where to build.
    if (context.isInitialBuild) {
      const isStartingCity = route.startingCity &&
        targetCity.toLowerCase() === route.startingCity.toLowerCase();
      if (isStartingCity || context.citiesOnNetwork.includes(targetCity)) {
        // Find a route stop that still needs track built to it
        const buildTarget = PlanExecutor.findInitialBuildTarget(route, context);
        if (buildTarget && context.canBuild) {
          console.log(`${tag} ${targetCity} is starting/connected during initialBuild, building toward ${buildTarget} instead`);
          const buildResult = await ActionResolver.resolve(
            { action: 'BUILD', details: { toward: buildTarget }, reasoning: '', planHorizon: '' },
            snapshot, context, route.startingCity,
          );
          if (buildResult.success && buildResult.plan) {
            return {
              plan: buildResult.plan,
              routeComplete: false,
              routeAbandoned: false,
              updatedRoute: route,
              description: `${tag} Building toward ${buildTarget} (${targetCity} already reachable)`,
            };
          }
        }
        // All route stops reachable — build toward demand card cities with remaining budget
        if (context.canBuild) {
          const demandTarget = PlanExecutor.findDemandBuildTarget(context);
          if (demandTarget) {
            console.log(`${tag} All route stops reachable, building toward demand city ${demandTarget}`);
            const buildResult = await ActionResolver.resolve(
              { action: 'BUILD', details: { toward: demandTarget }, reasoning: '', planHorizon: '' },
              snapshot, context, route.startingCity,
            );
            if (buildResult.success && buildResult.plan) {
              return {
                plan: buildResult.plan,
                routeComplete: false,
                routeAbandoned: false,
                updatedRoute: route,
                description: `${tag} Building toward demand city ${demandTarget} (all route stops reachable)`,
              };
            }
          }
        }
        // Nothing to build
        return {
          plan: { type: AIActionType.PassTurn },
          routeComplete: false,
          routeAbandoned: false,
          updatedRoute: route,
          description: `${tag} All route stops reachable during initialBuild`,
        };
      }
    }

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
   * Find a build target from route stops during initialBuild — the first stop
   * city that isn't the starting city and isn't already on the track network.
   * Does NOT modify currentStopIndex (stop actions haven't been completed).
   */
  private static findInitialBuildTarget(route: StrategicRoute, context: GameContext): string | null {
    for (const stop of route.stops) {
      const isStartingCity = route.startingCity &&
        stop.city.toLowerCase() === route.startingCity.toLowerCase();
      if (!isStartingCity && !context.citiesOnNetwork.includes(stop.city)) {
        return stop.city;
      }
    }
    return null;
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
