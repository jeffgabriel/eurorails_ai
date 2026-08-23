/**
 * PostDeliveryReplanner — Extracted post-delivery replan service (JIRA-195 Slice 3a).
 *
 * Owns the in-movement replan branch that was previously embedded in
 * TurnExecutorPlanner.ts:440-487. Returns an explicit `moveTargetInvalidated`
 * boolean signal to prevent JIRA-194's class of stale-locals bug — the caller
 * clears `lastMoveTargetCity` whenever this returns `moveTargetInvalidated: true`.
 *
 * All four sub-paths are preserved:
 *   1. Success: TripPlanner returns a route → enrich and replace activeRoute
 *   2. Null route: TripPlanner returns null → revalidate existing route
 *   3. Throw: TripPlanner throws → revalidate existing route
 *   4. No brain: brain is null or gridPoints empty → revalidate existing route
 *
 * In every sub-path where activeRoute is replaced, `moveTargetInvalidated: true`
 * is returned so MovementPhasePlanner can clear `lastMoveTargetCity` on the
 * phase boundary rather than via implicit shared local mutation.
 */

import {
  BotMemoryState,
  GameContext,
  GameState,
  GridPoint,
  LlmAttempt,
  StrategicRoute,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TripPlanner } from './TripPlanner';
import { getMemory } from './BotMemory';
import { TurnExecutorPlanner } from './TurnExecutorPlanner';
import { NewRoutePlanner } from './NewRoutePlanner';
import { isRouteImpossible } from './routeHelpers';
import { simulateTrip } from './RouteDetourEstimator';
import type { TurnPlanUpgradeTrain } from '../../../shared/types/GameTypes';

/**
 * JIRA-241: Estimate the total turns required to complete the given route
 * starting from the bot's current position. Used by the strictly-faster gate
 * to compare a current in-flight route's remaining work against a candidate's
 * total work.
 *
 * Walks only the stops at or after `route.currentStopIndex` (for in-flight
 * routes) or all stops (for fresh candidates with currentStopIndex=0).
 *
 * Returns Infinity when the simulation reports infeasibility, so an infeasible
 * route never accidentally beats a feasible one in the gate.
 */
function estimateRouteTurns(
  route: StrategicRoute,
  snapshot: WorldSnapshot,
): number {
  const remaining = route.stops.slice(route.currentStopIndex);
  if (remaining.length === 0) return 0;

  const startPos = snapshot.bot.position ?? { row: 0, col: 0 };
  try {
    const sim = simulateTrip(startPos, remaining, {
      bot: {
        playerId: snapshot.bot.playerId,
        existingSegments: snapshot.bot.existingSegments,
        trainType: snapshot.bot.trainType,
        ferryHalfSpeed: snapshot.bot.ferryHalfSpeed ?? false,
      },
      allPlayerTracks: snapshot.allPlayerTracks,
    });
    if (!sim.feasible) return Infinity;
    return sim.turnsToComplete;
  } catch {
    return Infinity;
  }
}

// ── ReplanResult ──────────────────────────────────────────────────────────

/**
 * Result returned by PostDeliveryReplanner.replan().
 *
 * `moveTargetInvalidated` is true in every code path that REPLACES the active
 * route (all four sub-paths set it true — even the no-brain fallback, because
 * revalidateRemainingDeliveries + skipCompletedStops always produce a new route
 * object, and lastMoveTargetCity from the prior route is stale regardless).
 */
export interface ReplanResult {
  /** Updated active route after replan (may be revalidated, enriched, or unchanged). */
  route: StrategicRoute;
  /**
   * True whenever the activeRoute object was replaced. The caller MUST clear
   * `lastMoveTargetCity` when this is true to prevent JIRA-194 stale-index bugs.
   */
  moveTargetInvalidated: boolean;
  /** LLM log from TripPlanner, if called. */
  replanLlmLog?: LlmAttempt[];
  /** System prompt sent to TripPlanner, if called. */
  replanSystemPrompt?: string;
  /** User prompt sent to TripPlanner, if called. */
  replanUserPrompt?: string;
  /**
   * Upgrade action to inject into the turn plan (JIRA-198), or null when the
   * eligibility gate blocked the LLM-requested upgrade.
   * Undefined when the LLM did not request an upgrade (sub-paths 2/3/4 also
   * leave this undefined because no upgradeOnRoute was emitted).
   */
  pendingUpgradeAction?: TurnPlanUpgradeTrain | null;
  /**
   * Human-readable reason explaining why an upgrade was blocked (JIRA-198).
   * Undefined when no upgrade was requested or when the upgrade was accepted.
   */
  upgradeSuppressionReason?: string | null;
  /**
   * True when the active route was abandoned because its next stop became
   * impossible to complete (JIRA-233, R2). Callers must propagate this flag
   * so AIStrategyEngine can record the abandonment in routeHistory.
   */
  routeWasAbandoned?: boolean;
}

// ── PostDeliveryReplanner ─────────────────────────────────────────────────

/**
 * PostDeliveryReplanner — orchestrates the in-movement replan branch.
 *
 * Invoked by MovementPhasePlanner after every successful delivery.
 * Static-method only class; no constructor, no state.
 */
export class PostDeliveryReplanner {
  /**
   * Run the post-delivery replan for the active route.
   *
   * @param activeRoute - Current route (after advancing the delivered stop index).
   * @param snapshot - Current world snapshot (mutated for early-exec money sync).
   * @param context - Game context (demands/canDeliver updated by JIRA-165 refresh).
   * @param brain - LLM strategy brain, or null if unavailable.
   * @param gridPoints - Pre-loaded grid points, or empty/undefined if unavailable.
   * @param deliveriesThisTurn - Count of deliveries already executed this turn (JIRA-185).
   * @param tag - Log prefix for structured tracing.
   * @returns ReplanResult with updated route and invalidation signal.
   */
  static async replan(
    activeRoute: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain | null | undefined,
    gridPoints: GridPoint[] | undefined,
    deliveriesThisTurn: number,
    tag: string,
  ): Promise<ReplanResult> {
    // Sub-path 4: gridPoints unavailable — cannot plan, revalidate existing route.
    // JIRA-270: brain may be null (Medium-skill bot); TripPlanner.planTrip
    // dispatches Medium deterministically per JIRA-269, so brain presence is
    // not a precondition for planning. Only an empty grid blocks the replan.
    // Impossibility check is preserved in this branch (JIRA-233).
    if (!gridPoints || gridPoints.length === 0) {
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      if (skipped.currentStopIndex < skipped.stops.length && isRouteImpossible(skipped, context)) {
        const nextStop = skipped.stops[skipped.currentStopIndex];
        const remainingCount = skipped.stops.length - skipped.currentStopIndex;
        console.warn(
          `[route-abandoned] route impossible: next stop=${JSON.stringify(nextStop)}, ` +
          `cargo=${JSON.stringify(context.loads)}, remaining stops=${remainingCount}`,
        );
        return { route: skipped, moveTargetInvalidated: true, routeWasAbandoned: true };
      }
      return { route: skipped, moveTargetInvalidated: true };
    }

    // Sub-paths 1–3: planner path (brain may be null; TripPlanner handles skill dispatch).
    // JIRA-233: Compute impossibility check OUTSIDE the try block so routeWasAbandoned
    // is accessible from both the try body and the catch handler.
    let postDeliveryRoute: StrategicRoute | null = activeRoute.currentStopIndex < activeRoute.stops.length
      ? activeRoute    // route still has remaining stops — show them in CURRENT PLAN
      : null;          // route fully completed — render "(no current plan in flight)"

    // JIRA-233 R2/R3: Check for route impossibility BEFORE passing to the downstream
    // planner. If the next stop requires a load that is neither in cargo nor reachable
    // via a remaining pickup stop, the route is dead. Clear it and flag abandonment so
    // AIStrategyEngine can record the event in routeHistory.
    let routeWasAbandoned = false;
    if (postDeliveryRoute && isRouteImpossible(postDeliveryRoute, context)) {
      const nextStop = postDeliveryRoute.stops[postDeliveryRoute.currentStopIndex];
      const remainingCount = postDeliveryRoute.stops.length - postDeliveryRoute.currentStopIndex;
      console.warn(
        `[route-abandoned] route impossible: next stop=${JSON.stringify(nextStop)}, ` +
        `cargo=${JSON.stringify(context.loads)}, remaining stops=${remainingCount}`,
      );
      postDeliveryRoute = null;
      routeWasAbandoned = true;
    }

    try {
      const memory = await getMemory(snapshot.gameId, snapshot.bot.playerId);
      const tripPlanner = new TripPlanner(brain ?? null);

      const replanMemory: BotMemoryState = {
        ...memory,
        deliveryCount: (memory.deliveryCount ?? 0) + deliveriesThisTurn,
        activeRoute: postDeliveryRoute,
      };
      const replanResult = await tripPlanner.planTrip(snapshot, context, gridPoints, replanMemory);

      // Capture replan LLM data for debug overlay propagation
      let replanLlmLog: LlmAttempt[] | undefined;
      let replanSystemPrompt: string | undefined;
      let replanUserPrompt: string | undefined;

      if ('llmLog' in replanResult && replanResult.llmLog) {
        replanLlmLog = replanResult.llmLog;
      }
      if ('systemPrompt' in replanResult && replanResult.systemPrompt) {
        replanSystemPrompt = replanResult.systemPrompt as string;
      }
      if ('userPrompt' in replanResult && replanResult.userPrompt) {
        replanUserPrompt = replanResult.userPrompt as string;
      }

      // Sub-path 1: TripPlanner returned a route
      if (replanResult.route) {
        const finalRoute = TurnExecutorPlanner.skipCompletedStops(replanResult.route, context);

        // JIRA-241: Strictly-faster gate. In `end` state, only swap to the
        // candidate when it shortens the path to victory. When the candidate
        // is not strictly faster than the current route's remaining turns,
        // preserve the existing activeRoute and return without invalidating
        // the move target. This prevents the t80-style abandonment seen in
        // game 181cf810 where a higher-aggregate-velocity replan diverted the
        // bot away from a one-turn winning delivery.
        if (
          context.gameState === GameState.End &&
          postDeliveryRoute &&
          postDeliveryRoute.currentStopIndex < postDeliveryRoute.stops.length
        ) {
          const currentRemaining = estimateRouteTurns(postDeliveryRoute, snapshot);
          const candidateTurns = estimateRouteTurns(finalRoute, snapshot);
          if (candidateTurns >= currentRemaining) {
            const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
            const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
            return {
              route: skipped,
              moveTargetInvalidated: false,
              replanLlmLog,
              replanSystemPrompt,
              replanUserPrompt,
              routeWasAbandoned: routeWasAbandoned || undefined,
            };
          }
        }

        // JIRA-198: Consume the LLM-emitted upgradeOnRoute hint (if any) through
        // the existing eligibility gate. Pass deliveries-already-done-this-turn so
        // the gate counts in-turn deliveries (ADR-5, matches replanMemory convention).
        let pendingUpgradeAction: TurnPlanUpgradeTrain | null | undefined;
        let upgradeSuppressionReason: string | null | undefined;
        if (finalRoute.upgradeOnRoute) {
          const upgradeResult = NewRoutePlanner.tryConsumeUpgrade(
            finalRoute,
            snapshot,
            tag,
            (memory.deliveryCount ?? 0) + deliveriesThisTurn,
          );
          pendingUpgradeAction = upgradeResult.action;
          upgradeSuppressionReason = upgradeResult.reason ?? null;
        }

        return {
          route: finalRoute,
          moveTargetInvalidated: true, // JIRA-194: new route — stale stop indices no longer valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
          pendingUpgradeAction,
          upgradeSuppressionReason,
          routeWasAbandoned: routeWasAbandoned || undefined, // JIRA-233: propagate impossibility signal
        };
      }

      // Sub-path 2a: JIRA-207B (R10e) — TripPlanner returned keep_current_plan.
      // Preserve the existing activeRoute without heuristic-fallback or DiscardHand.
      const replanSelection = 'selection' in replanResult ? replanResult.selection : undefined;
      if (!replanResult.route && replanSelection?.fallbackReason === 'keep_current_plan') {
        const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
        const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
        return {
          route: skipped,
          moveTargetInvalidated: false, // Route unchanged — stale indices remain valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
          routeWasAbandoned: routeWasAbandoned || undefined,
        };
      }

      // Sub-path 2b: TripPlanner returned null route (other reasons).
      console.warn(`${tag} [PostDeliveryReplanner] TripPlanner returned null route. Continuing on existing route.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      return {
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
        replanLlmLog,
        replanSystemPrompt,
        replanUserPrompt,
        routeWasAbandoned: routeWasAbandoned || undefined,
      };
    } catch (err) {
      // Sub-path 3: TripPlanner threw
      console.warn(`${tag} [PostDeliveryReplanner] Replan failed (${(err as Error).message}). Continuing on existing route.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      return {
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
        routeWasAbandoned: routeWasAbandoned || undefined,
      };
    }
  }
}
