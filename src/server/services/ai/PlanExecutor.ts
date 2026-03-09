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
  TurnPlanBuildTrack,
  AIActionType,
  ResolvedAction,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';
import { loadGridPoints } from './MapTopology';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { ContextBuilder } from './ContextBuilder';

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
    // Advance past any stops already completed (e.g., mid-turn pickups/deliveries)
    route = PlanExecutor.skipCompletedStops(route, context);

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
          // JIRA-73: Continue building toward remaining route stops with leftover budget
          const combinedPlan = await PlanExecutor.continuationBuild(
            buildResult.plan as TurnPlanBuildTrack, route, snapshot, context, tag,
          );
          return {
            plan: combinedPlan,
            routeComplete: false,
            routeAbandoned: false,
            updatedRoute: { ...route, phase: 'build' },
            description: `${tag} Building toward ${buildTarget} (${targetCity} already reachable)`,
          };
        }
      }
      // All route stops reachable — build toward demand cities with remaining budget
      if (context.canBuild) {
        // Build toward demand card cities with remaining budget
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
      // JIRA-73: Continue building toward remaining route stops with leftover budget
      const combinedPlan = await PlanExecutor.continuationBuild(
        buildResult.plan as TurnPlanBuildTrack, route, snapshot, context, tag,
      );
      return {
        plan: combinedPlan,
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

    // Pickup failed due to full capacity — try drop-and-retry recovery (BE-003)
    if (stop.action === 'pickup' && actionResult.error && actionResult.error.includes('full')) {
      const dropCandidate = PlanExecutor.evaluateCargoForDrop(snapshot, context);
      if (dropCandidate) {
        const cityName = PlanExecutor.getBotCityName(snapshot);
        if (cityName) {
          console.warn(
            `${tag} Pickup failed (full capacity). Dropping worst load "${dropCandidate.loadType}" ` +
            `(score: ${dropCandidate.score}) at ${cityName} to recover.`,
          );
          return {
            plan: {
              type: AIActionType.DropLoad,
              load: dropCandidate.loadType,
              city: cityName,
            },
            routeComplete: false,
            routeAbandoned: false,
            updatedRoute: { ...route, phase: 'act' },
            description: `${tag} Pickup failed (full). Dropping "${dropCandidate.loadType}" at ${cityName} to free slot.`,
          };
        }
      }
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
    // FR-8: Deliver before build — if carrying a load whose delivery city is reachable,
    // prioritize MOVE to deliver over building track this turn.
    const deliverableDemand = context.demands.find(
      d => d.isLoadOnTrain && d.isDeliveryReachable,
    );
    if (deliverableDemand) {
      console.warn(`[PlanExecutor] Deliver-before-build: overriding BUILD with MOVE to ${deliverableDemand.deliveryCity} for ${deliverableDemand.payout}M delivery`);
      const moveResult = await ActionResolver.resolve(
        { action: 'MOVE', details: { to: deliverableDemand.deliveryCity }, reasoning: '', planHorizon: '' },
        snapshot, context,
      );
      if (moveResult.success && moveResult.plan) {
        return {
          plan: moveResult.plan,
          routeComplete: false,
          routeAbandoned: false,
          updatedRoute: { ...route, phase: 'build' },
          description: `${tag} Deliver-before-build: moving to ${deliverableDemand.deliveryCity} to deliver ${deliverableDemand.loadType} for ${deliverableDemand.payout}M`,
        };
      }
    }

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
   * Find a build target from demand cards — the cheapest actionable demand whose
   * delivery or supply city is not yet on the track network.
   * JIRA-58: Considers total supply+delivery cost, not just the cheaper side.
   * Skips delivery cities when supply is unreachable (>20M track cost).
   */
  static findDemandBuildTarget(context: GameContext): string | null {
    const affordable = context.demands.filter(d => d.isAffordable !== false);
    // Sort by total track cost to make demand actionable (supply + delivery)
    const sorted = [...affordable].sort((a, b) => {
      const aTotalCost = (a.estimatedTrackCostToSupply || 0) + (a.estimatedTrackCostToDelivery || 0);
      const bTotalCost = (b.estimatedTrackCostToSupply || 0) + (b.estimatedTrackCostToDelivery || 0);
      return aTotalCost - bTotalCost;
    });
    for (const demand of sorted) {
      // Prefer supply city first — bot needs to pick up before delivering
      if (!demand.isSupplyOnNetwork && (demand.estimatedTrackCostToSupply || 0) <= 20) {
        return demand.supplyCity;
      }
      // Only target delivery city if supply is already reachable
      if (!demand.isDeliveryOnNetwork && demand.isSupplyOnNetwork) {
        return demand.deliveryCity;
      }
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

  // ── JIRA-73: Continuation build loop ─────────────────────────────────────

  private static readonly MAX_BUILD_BUDGET = 20;

  /**
   * After a primary build during initialBuild, spend remaining budget building
   * toward subsequent route stops. Returns a combined TurnPlanBuildTrack with
   * all segments from primary + continuation builds.
   *
   * JIRA-73: A human would build the entire delivery route during initial build
   * turns, not just toward the first unreachable stop. This mirrors that behavior.
   */
  private static async continuationBuild(
    primaryPlan: TurnPlanBuildTrack,
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    tag: string,
  ): Promise<TurnPlanBuildTrack> {
    const primaryCost = primaryPlan.segments.reduce((sum, s) => sum + s.cost, 0);
    if (primaryCost >= PlanExecutor.MAX_BUILD_BUDGET) {
      return primaryPlan; // Budget fully spent
    }

    // Clone snapshot and apply primary build so continuation builds see updated frontier
    const simSnapshot = ActionResolver.cloneSnapshot(snapshot);
    const simContext: GameContext = {
      ...context,
      citiesOnNetwork: [...context.citiesOnNetwork],
      turnBuildCost: context.turnBuildCost,
      money: context.money,
    };
    ActionResolver.applyPlanToState(primaryPlan, simSnapshot, simContext);

    // Recompute cities on network after primary build
    const gridPoints = snapshot.hexGrid ?? [];
    const network = buildTrackNetwork(simSnapshot.bot.existingSegments);
    simContext.citiesOnNetwork = ContextBuilder.computeCitiesOnNetwork(network, gridPoints);

    let combinedSegments = [...primaryPlan.segments];
    let spentSoFar = primaryCost;

    for (const stop of route.stops) {
      if (spentSoFar >= PlanExecutor.MAX_BUILD_BUDGET) break;

      const isStartingCity = route.startingCity &&
        stop.city.toLowerCase() === route.startingCity.toLowerCase();
      if (isStartingCity) continue;
      if (simContext.citiesOnNetwork.includes(stop.city)) continue;

      const remaining = PlanExecutor.MAX_BUILD_BUDGET - spentSoFar;
      if (remaining <= 0) break;

      console.log(`${tag} JIRA-73: Continuation build toward ${stop.city}, remaining budget ${remaining}M`);

      const contResult = await ActionResolver.resolve(
        { action: 'BUILD', details: { toward: stop.city }, reasoning: '', planHorizon: '' },
        simSnapshot, simContext, route.startingCity,
      );

      if (contResult.success && contResult.plan) {
        const contPlan = contResult.plan as TurnPlanBuildTrack;
        const contCost = contPlan.segments.reduce((sum, s) => sum + s.cost, 0);

        if (contCost > 0) {
          // Apply this build to sim state for next iteration
          ActionResolver.applyPlanToState(contPlan, simSnapshot, simContext);

          // Recompute cities on network after this continuation build
          const updatedNetwork = buildTrackNetwork(simSnapshot.bot.existingSegments);
          simContext.citiesOnNetwork = ContextBuilder.computeCitiesOnNetwork(updatedNetwork, gridPoints);

          combinedSegments.push(...contPlan.segments);
          spentSoFar += contCost;
          console.log(`${tag} JIRA-73: Continuation build ${contCost}M toward ${stop.city} (total ${spentSoFar}M/${PlanExecutor.MAX_BUILD_BUDGET}M)`);
        }
      } else {
        console.log(`${tag} JIRA-73: Continuation build toward ${stop.city} failed, skipping`);
      }
    }

    return {
      type: AIActionType.BuildTrack,
      segments: combinedSegments,
      targetCity: primaryPlan.targetCity,
    };
  }

  // ── Cargo Evaluation ──────────────────────────────────────────────────────

  /**
   * Evaluate each carried load and score by delivery feasibility.
   * Returns loads sorted worst-first (highest score = least feasible).
   *
   * Score heuristic: build cost to delivery minus payout. Higher = worse.
   * Loads with no matching demand get maximum penalty (Infinity).
   * Loads already deliverable on-network get score 0 (best).
   */
  static evaluateCargoForDrop(
    snapshot: WorldSnapshot,
    context: GameContext,
  ): { loadType: string; score: number } | null {
    if (snapshot.bot.loads.length === 0) return null;

    const scored = snapshot.bot.loads.map(loadType => {
      const matchingDemands = context.demands.filter(d => d.loadType === loadType);
      if (matchingDemands.length === 0) {
        // No demand card for this load — worst possible score
        return { loadType, score: Infinity };
      }

      // Find the best (most feasible) delivery option for this load
      const bestScore = Math.min(
        ...matchingDemands.map(d => {
          if (d.isDeliveryOnNetwork) return 0;
          // Score = build cost - payout (higher = worse deal)
          return d.estimatedTrackCostToDelivery - d.payout;
        }),
      );

      return { loadType, score: bestScore };
    });

    // Sort worst-first (highest score)
    scored.sort((a, b) => b.score - a.score);
    return scored[0] ?? null;
  }

  /**
   * Get the city name at the bot's current position, if any.
   */
  private static getBotCityName(snapshot: WorldSnapshot): string | null {
    if (!snapshot.bot.position) return null;
    const grid = loadGridPoints();
    const key = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    return grid.get(key)?.name ?? null;
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

  /**
   * Advance currentStopIndex past stops that are already completed.
   *
   * For pickup stops: completed if the load is already on the train.
   * For deliver stops: completed if the load is NOT on the train AND
   *   the demand card is no longer present (i.e., it was already fulfilled).
   *
   * Stops advancing at the first incomplete stop.
   */
  static skipCompletedStops(route: StrategicRoute, context: GameContext): StrategicRoute {
    let idx = route.currentStopIndex;
    const demandCardIds = context.demands.map(d => d.cardIndex);

    while (idx < route.stops.length) {
      const stop = route.stops[idx];

      if (stop.action === 'pickup') {
        // Pickup is complete if the load type is already on the train
        if (context.loads.includes(stop.loadType)) {
          console.log(`[PlanExecutor] Skipping completed pickup: ${stop.loadType} at ${stop.city} (already on train)`);
          idx++;
          continue;
        }
      } else if (stop.action === 'deliver') {
        // Delivery is complete if the load is NOT on the train AND the demand card is gone
        const loadOnTrain = context.loads.includes(stop.loadType);
        const demandPresent = stop.demandCardId != null && demandCardIds.includes(stop.demandCardId);
        if (!loadOnTrain && !demandPresent) {
          console.log(`[PlanExecutor] Skipping completed delivery: ${stop.loadType} at ${stop.city} (demand fulfilled)`);
          idx++;
          continue;
        }
      }

      // Stop is not complete — stop advancing
      break;
    }

    if (idx !== route.currentStopIndex) {
      return { ...route, currentStopIndex: idx };
    }
    return route;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Check if the bot is currently at the named city */
  private static isBotAtCity(context: GameContext, cityName: string): boolean {
    if (!context.position) return false;
    if (context.position.city === cityName) return true;
    return false;
  }
}
