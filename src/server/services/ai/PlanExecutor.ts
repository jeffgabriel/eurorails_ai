/**
 * PlanExecutor — 2-question model that auto-executes a StrategicRoute over multiple turns.
 *
 * Given the current route, stop index, and game state, determines which TurnPlan
 * to produce this turn. Advances the route's stop index after execution.
 *
 * For each stop, two questions determine behavior:
 *   1. Am I there? Is the bot at the stop city?
 *      - YES → execute the action (pickup/deliver), advance currentStopIndex
 *   2. Can I get there? Is the stop city reachable on the track network?
 *      - YES → resolve MOVE toward the stop city
 *      - NO  → resolve BUILD toward the stop city
 *
 * During initialBuild (first two turns), only building is allowed — no movement.
 *
 * Multi-action combining is handled by TurnComposer (post-decision layer).
 * PlanExecutor returns raw single-action plans.
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
   * and the updated route state (advanced stop index).
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

    const tag = `[PlanExecutor stop=${route.currentStopIndex}/${route.stops.length}]`;
    const targetCity = currentStop.city;

    // ── InitialBuild: only building, no movement ──────────────────────────
    if (context.isInitialBuild) {
      return PlanExecutor.executeInitialBuild(route, currentStop, snapshot, context, tag);
    }

    // ── Question 1: Am I there? ───────────────────────────────────────────
    if (PlanExecutor.isBotAtCity(context, targetCity)) {
      console.log(`${tag} Bot is at ${targetCity}, executing action`);
      return PlanExecutor.executeAction(route, currentStop, snapshot, context, tag);
    }

    // ── Question 2: Can I get there? ──────────────────────────────────────
    if (context.citiesOnNetwork.includes(targetCity)) {
      // City is reachable on network → move toward it
      console.log(`${tag} ${targetCity} is on network, moving toward it`);
      return PlanExecutor.resolveMove(route, currentStop, snapshot, context, tag);
    } else {
      // City is NOT on network → build toward it
      console.log(`${tag} ${targetCity} is not on network, building toward it`);
      return PlanExecutor.resolveBuild(route, currentStop, snapshot, context, tag);
    }
  }

  // ── InitialBuild handling ───────────────────────────────────────────────

  /**
   * During initialBuild (first two turns), only building is allowed.
   * Find the best build target from route stops or demand cards.
   */
  private static async executeInitialBuild(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    const targetCity = stop.city;

    // If the current stop's city is the starting city or already on network,
    // find a different build target — but DON'T advance currentStopIndex.
    // Stop actions (pickup/deliver) haven't been completed; we're just choosing where to build.
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
            updatedRoute: { ...route, phase: 'build' },
            description: `${tag} Building toward ${buildTarget} (${targetCity} already reachable)`,
          };
        }
      }
      // All route stops reachable — try secondary build target, then demand cities
      if (context.canBuild) {
        // Priority 1: Secondary build target from LLM route planning
        const secondaryCity = route.secondaryBuildTarget?.city;
        if (secondaryCity && !context.citiesOnNetwork.includes(secondaryCity)) {
          console.log(`${tag} All route stops reachable, building toward secondary target ${secondaryCity}`);
          const buildResult = await ActionResolver.resolve(
            { action: 'BUILD', details: { toward: secondaryCity }, reasoning: '', planHorizon: '' },
            snapshot, context, route.startingCity,
          );
          if (buildResult.success && buildResult.plan) {
            return {
              plan: buildResult.plan,
              routeComplete: false,
              routeAbandoned: false,
              updatedRoute: { ...route, phase: 'build' },
              description: `${tag} Building toward secondary target ${secondaryCity} (all route stops reachable)`,
            };
          }
        }
        // Priority 2: Build toward demand card cities with remaining budget
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
              updatedRoute: { ...route, phase: 'build' },
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
        updatedRoute: { ...route, phase: 'build' },
        description: `${tag} All route stops reachable during initialBuild`,
      };
    }

    // Current stop city needs track — build toward it
    if (!context.canBuild) {
      return {
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: { ...route, phase: 'build' },
        description: `${tag} Cannot build this turn (budget exhausted). Waiting.`,
      };
    }

    const buildResult = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: targetCity }, reasoning: '', planHorizon: '' },
      snapshot, context, route.startingCity,
    );

    if (buildResult.success && buildResult.plan) {
      return {
        plan: buildResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: { ...route, phase: 'build' },
        description: `${tag} Building toward ${targetCity}`,
      };
    }

    console.warn(`${tag} Build toward ${targetCity} failed: ${buildResult.error}`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...route, phase: 'build' },
      description: `${tag} Build failed (${buildResult.error}), will retry next turn`,
    };
  }

  // ── Core actions ────────────────────────────────────────────────────────

  /**
   * Execute the stop action (pickup or deliver) when bot is at the stop city.
   */
  private static async executeAction(
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
        snapshot, context,
      );
    } else {
      actionResult = await ActionResolver.resolve(
        { action: 'DELIVER', details: { load: stop.loadType, at: stop.city }, reasoning: '', planHorizon: '' },
        snapshot, context,
      );
    }

    if (actionResult.success && actionResult.plan) {
      const isLastStop = route.currentStopIndex >= route.stops.length - 1;
      const updatedRoute = PlanExecutor.advanceStop(route);

      if (isLastStop) {
        return {
          plan: actionResult.plan,
          routeComplete: true,
          routeAbandoned: false,
          updatedRoute,
          description: `${tag} Completed final stop: ${stop.action} ${stop.loadType} at ${stop.city}. Route complete!`,
        };
      }

      return {
        plan: actionResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute,
        description: `${tag} ${stop.action} ${stop.loadType} at ${stop.city}. Advancing to next stop.`,
      };
    }

    // Action failed — abandon the route
    console.warn(`${tag} ${stop.action} failed: ${actionResult.error}. Abandoning route.`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: true,
      updatedRoute: { ...route, phase: 'act' },
      description: `${tag} ${stop.action} failed (${actionResult.error}). Route abandoned.`,
    };
  }

  /**
   * Move toward the stop city (city is on network, bot is not there yet).
   */
  private static async resolveMove(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    const moveResult = await ActionResolver.resolve(
      { action: 'MOVE', details: { to: stop.city }, reasoning: '', planHorizon: '' },
      snapshot, context,
    );

    if (moveResult.success && moveResult.plan) {
      return {
        plan: moveResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: { ...route, phase: 'travel' },
        description: `${tag} Moving toward ${stop.city}`,
      };
    }

    // Move failed — city might not actually be reachable via our track. Fall back to build.
    console.warn(`${tag} Move to ${stop.city} failed: ${moveResult.error}. Falling back to build.`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...route, phase: 'build' },
      description: `${tag} Move failed, falling back to build`,
    };
  }

  /**
   * Build toward the stop city (city is not on network).
   */
  private static async resolveBuild(
    route: StrategicRoute,
    stop: RouteStop,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<PlanExecutorResult> {
    if (!context.canBuild) {
      return {
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: { ...route, phase: 'build' },
        description: `${tag} Cannot build this turn (budget exhausted). Waiting.`,
      };
    }

    const buildResult = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: stop.city }, reasoning: '', planHorizon: '' },
      snapshot, context, route.startingCity,
    );

    if (buildResult.success && buildResult.plan) {
      return {
        plan: buildResult.plan,
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: { ...route, phase: 'build' },
        description: `${tag} Building toward ${stop.city}`,
      };
    }

    // Build failed — stay in build phase, retry next turn
    console.warn(`${tag} Build toward ${stop.city} failed: ${buildResult.error}`);
    return {
      plan: { type: AIActionType.PassTurn },
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...route, phase: 'build' },
      description: `${tag} Build failed (${buildResult.error}), will retry next turn`,
    };
  }

  /**
   * Find a build target from demand cards — the cheapest track cost demand whose
   * delivery or supply city is not yet on the track network.
   */
  static findDemandBuildTarget(context: GameContext): string | null {
    const sorted = [...context.demands].sort((a, b) => {
      const aCost = Math.min(a.estimatedTrackCostToSupply || Infinity, a.estimatedTrackCostToDelivery || Infinity);
      const bCost = Math.min(b.estimatedTrackCostToSupply || Infinity, b.estimatedTrackCostToDelivery || Infinity);
      return aCost - bCost;
    });
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
    if (context.position.city === cityName) return true;
    return false;
  }
}
