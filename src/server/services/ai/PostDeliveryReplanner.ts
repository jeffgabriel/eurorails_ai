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
  SnapshotIdentity,
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
import { assertFresh, SnapshotMismatch } from './WorldSnapshotService';

// Re-export for backward compatibility with existing callers
export { assertFresh, SnapshotMismatch };

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

// ── PostDeliveryOutcome discriminated union ───────────────────────────────

/**
 * The existing route still has remaining stops and the planner preserved it
 * (keep_current_plan or strictly-faster gate rejected the candidate in End state).
 * The movement loop continues on the existing route; lastMoveTargetCity is valid.
 */
export interface RouteContinuedOutcome {
  readonly kind: 'route-continued';
  /** The preserved (revalidated) route — same logical route, no replacement. */
  readonly route: StrategicRoute;
  /** Always false — existing stop indices remain valid. */
  readonly moveTargetInvalidated: false;
  /** LLM log from TripPlanner, if called. */
  readonly replanLlmLog?: LlmAttempt[];
  /** System prompt sent to TripPlanner, if called. */
  readonly replanSystemPrompt?: string;
  /** User prompt sent to TripPlanner, if called. */
  readonly replanUserPrompt?: string;
  /**
   * Identity of the snapshot this plan was derived from.
   * Used by assertFresh to detect staleness at apply time.
   */
  readonly derivedFromIdentity?: SnapshotIdentity;
}

/**
 * TripPlanner returned a new route that replaced the existing one.
 * The movement loop continues on the new route; lastMoveTargetCity must be cleared.
 */
export interface RouteReplacedOutcome {
  readonly kind: 'route-replaced';
  /** The new route from TripPlanner (after skipCompletedStops). */
  readonly route: StrategicRoute;
  /** Always true — new route object, stale stop indices are no longer valid. */
  readonly moveTargetInvalidated: true;
  /** LLM log from TripPlanner. */
  readonly replanLlmLog?: LlmAttempt[];
  /** System prompt sent to TripPlanner. */
  readonly replanSystemPrompt?: string;
  /** User prompt sent to TripPlanner. */
  readonly replanUserPrompt?: string;
  /**
   * Upgrade action to inject into the turn plan (JIRA-198), or null when the
   * eligibility gate blocked the LLM-requested upgrade.
   * Undefined when no upgradeOnRoute was emitted by TripPlanner.
   */
  readonly pendingUpgradeAction?: TurnPlanUpgradeTrain | null;
  /**
   * Human-readable reason explaining why an upgrade was blocked (JIRA-198).
   * Undefined when no upgrade was requested or when the upgrade was accepted.
   */
  readonly upgradeSuppressionReason?: string | null;
  /**
   * True when the route was abandoned due to impossibility before TripPlanner
   * was called, but TripPlanner returned a new route afterwards (JIRA-233 R2/R3).
   * The caller should propagate this to AIStrategyEngine for routeHistory recording.
   */
  readonly routeWasAbandoned?: true;
  /**
   * Identity of the snapshot this plan was derived from.
   * Used by assertFresh to detect staleness at apply time.
   */
  readonly derivedFromIdentity?: SnapshotIdentity;
}

/**
 * The route is fully completed OR TripPlanner returned null (for reasons other
 * than keep_current_plan). The caller MUST end the movement loop immediately —
 * there is no viable route to continue on. This is the JIRA-271 fix: previously
 * a fully-completed route with remaining budget would fall through and try to move
 * on a completed route, producing spurious movements.
 */
export interface NoRouteOutcome {
  readonly kind: 'no-route';
  /** The revalidated route (may have stale indices if fully completed). */
  readonly route: StrategicRoute;
  /** Always true — route was replaced/revalidated. */
  readonly moveTargetInvalidated: true;
  /** LLM log from TripPlanner, if called. */
  readonly replanLlmLog?: LlmAttempt[];
  /** System prompt sent to TripPlanner, if called. */
  readonly replanSystemPrompt?: string;
  /** User prompt sent to TripPlanner, if called. */
  readonly replanUserPrompt?: string;
  /**
   * Identity of the snapshot this plan was derived from.
   * Used by assertFresh to detect staleness at apply time.
   */
  readonly derivedFromIdentity?: SnapshotIdentity;
}

/**
 * The impossibility check (JIRA-233 R2) fired and the route was cleared. The
 * caller MUST end the movement loop immediately and propagate routeWasAbandoned
 * to AIStrategyEngine so it can record the event in routeHistory.
 */
export interface RouteAbandonedOutcome {
  readonly kind: 'route-abandoned';
  /** The revalidated route (next stop is impossible). */
  readonly route: StrategicRoute;
  /** Always true — route object was replaced/cleared. */
  readonly moveTargetInvalidated: true;
  /** Always true — signals the impossibility abandonment to the caller. */
  readonly routeWasAbandoned: true;
  /**
   * Identity of the snapshot this plan was derived from.
   * Used by assertFresh to detect staleness at apply time.
   */
  readonly derivedFromIdentity?: SnapshotIdentity;
}

/**
 * Discriminated union returned by PostDeliveryReplanner.replan().
 *
 * ADR-1: The union replaces the previous ReplanResult bag so the caller's
 *        switch dispatch is exhaustive at compile time (ADR-4).
 * ADR-2: `no-route` and `route-abandoned` MUST end the movement loop
 *        immediately, regardless of remaining budget (JIRA-271 fix).
 * ADR-5: Replan-log / upgrade fields attach to specific variants only.
 */
export type PostDeliveryOutcome =
  | RouteContinuedOutcome
  | RouteReplacedOutcome
  | NoRouteOutcome
  | RouteAbandonedOutcome;

/**
 * @deprecated Use PostDeliveryOutcome instead. ReplanResult is kept as a
 * type alias for backwards compatibility during the transition period.
 * Will be removed once all callers have been updated.
 */
export type ReplanResult = PostDeliveryOutcome;

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
  ): Promise<PostDeliveryOutcome> {
    // Capture the identity of the snapshot this plan is derived from.
    // Stamped on every returned outcome so that callers can assert freshness
    // before applying the produced plan — preventing stale delivery actions
    // when carried loads or money changed between plan derivation and apply time.
    // (ADR-3: the check compares derivedFromIdentity vs. live identity at apply time.)
    const derivedFromIdentity = snapshot.identity;

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
        const outcome: RouteAbandonedOutcome = { kind: 'route-abandoned', route: skipped, moveTargetInvalidated: true, routeWasAbandoned: true };
        return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
      }
      // No route returned — grid empty, movement loop must end
      const outcome: NoRouteOutcome = { kind: 'no-route', route: skipped, moveTargetInvalidated: true, derivedFromIdentity };
      return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
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
            const outcome: RouteContinuedOutcome = {
              kind: 'route-continued',
              route: skipped,
              moveTargetInvalidated: false,
              replanLlmLog,
              replanSystemPrompt,
              replanUserPrompt,
              derivedFromIdentity,
            };
            return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
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

        const outcome: RouteReplacedOutcome = {
          kind: 'route-replaced',
          route: finalRoute,
          moveTargetInvalidated: true, // JIRA-194: new route — stale stop indices no longer valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
          pendingUpgradeAction,
          upgradeSuppressionReason,
          routeWasAbandoned: routeWasAbandoned || undefined, // JIRA-233: propagate impossibility signal
          derivedFromIdentity,
        };
        return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
      }

      // Sub-path 2a: JIRA-207B (R10e) — TripPlanner returned keep_current_plan.
      // Preserve the existing activeRoute without heuristic-fallback or DiscardHand.
      const replanSelection = 'selection' in replanResult ? replanResult.selection : undefined;
      if (!replanResult.route && replanSelection?.fallbackReason === 'keep_current_plan') {
        const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
        const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
        const outcome: RouteContinuedOutcome = {
          kind: 'route-continued',
          route: skipped,
          moveTargetInvalidated: false, // Route unchanged — stale indices remain valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
          derivedFromIdentity,
        };
        return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
      }

      // Sub-path 2b: TripPlanner returned null route (other reasons) — no viable route.
      // JIRA-271: movement loop MUST end when no route is available, regardless of budget.
      console.warn(`${tag} [PostDeliveryReplanner] TripPlanner returned null route. Ending movement loop.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      // JIRA-233: If impossibility already fired, surface as route-abandoned so the
      // caller can record the abandonment in routeHistory.
      if (routeWasAbandoned) {
        const abandonedOutcome: RouteAbandonedOutcome = { kind: 'route-abandoned', route: skipped, moveTargetInvalidated: true, routeWasAbandoned: true };
        return PostDeliveryReplanner.withFreshnessCheck(abandonedOutcome, derivedFromIdentity, snapshot.identity, tag);
      }
      const noRouteOutcome: NoRouteOutcome = {
        kind: 'no-route',
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
        replanLlmLog,
        replanSystemPrompt,
        replanUserPrompt,
        derivedFromIdentity,
      };
      return PostDeliveryReplanner.withFreshnessCheck(noRouteOutcome, derivedFromIdentity, snapshot.identity, tag);
    } catch (err) {
      // Sub-path 3: TripPlanner threw — no viable route.
      // JIRA-271: movement loop MUST end when no route is available, regardless of budget.
      console.warn(`${tag} [PostDeliveryReplanner] Replan failed (${(err as Error).message}). Ending movement loop.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      if (routeWasAbandoned) {
        const outcome: RouteAbandonedOutcome = { kind: 'route-abandoned', route: skipped, moveTargetInvalidated: true, routeWasAbandoned: true };
        return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
      }
      const outcome: NoRouteOutcome = {
        kind: 'no-route',
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
        derivedFromIdentity,
      };
      return PostDeliveryReplanner.withFreshnessCheck(outcome, derivedFromIdentity, snapshot.identity, tag);
    }
  }

  /**
   * Assert that the snapshot is still fresh (identity unchanged since plan derivation)
   * and return the outcome unchanged on success.
   *
   * On mismatch: fail closed by throwing a SnapshotMismatch. This prevents a stale
   * delivery plan from mutating game state when carried loads or money have changed
   * between plan derivation and apply time.
   *
   * When either identity is undefined (legacy path), the outcome is returned as-is.
   */
  private static withFreshnessCheck<T extends PostDeliveryOutcome>(
    outcome: T,
    derivedFromIdentity: SnapshotIdentity | undefined,
    liveIdentity: SnapshotIdentity | undefined,
    tag: string,
  ): T {
    const check = assertFresh(derivedFromIdentity, liveIdentity);
    if (check.isErr()) {
      console.warn(
        `${tag} [PostDeliveryReplanner] Freshness check failed: ${check.error.reason} — failing closed`,
      );
      throw check.error;
    }
    return outcome;
  }
}
