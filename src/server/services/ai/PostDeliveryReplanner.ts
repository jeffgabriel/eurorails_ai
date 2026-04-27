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
  GridPoint,
  LlmAttempt,
  StrategicRoute,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { AdvisorCoordinator } from './AdvisorCoordinator';
import { TripPlanner } from './TripPlanner';
import { getMemory } from './BotMemory';
import { TurnExecutorPlanner } from './TurnExecutorPlanner';

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
    // Sub-path 4: No brain available — revalidate existing route
    if (!brain || !gridPoints || gridPoints.length === 0) {
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      console.log(`${tag} [PostDeliveryReplanner] No brain/gridPoints — revalidating existing route`);
      return { route: skipped, moveTargetInvalidated: true };
    }

    // Sub-paths 1–3: brain is available
    try {
      const memory = await getMemory(snapshot.gameId, snapshot.bot.playerId);
      const tripPlanner = new TripPlanner(brain);

      // JIRA-185: Build a patched memory copy with deliveryCount reflecting
      // deliveries already executed this turn so the LLM prompt's CURRENT STATE
      // block shows the correct count. Do NOT call updateMemory() here — the
      // authoritative write remains in AIStrategyEngine.ts at turn-end (R4).
      const replanMemory: BotMemoryState = {
        ...memory,
        deliveryCount: (memory.deliveryCount ?? 0) + deliveriesThisTurn,
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
        const enrichedRoute = await AdvisorCoordinator.adviseEnrichment(
          replanResult.route,
          snapshot,
          context,
          brain,
          gridPoints,
        );
        const finalRoute = TurnExecutorPlanner.skipCompletedStops(enrichedRoute, context);
        console.log(
          `${tag} [PostDeliveryReplanner] Replan succeeded. New route: ${finalRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
        );
        return {
          route: finalRoute,
          moveTargetInvalidated: true, // JIRA-194: new route — stale stop indices no longer valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
        };
      }

      // Sub-path 2: TripPlanner returned null route
      console.warn(`${tag} [PostDeliveryReplanner] TripPlanner returned null route. Continuing on existing route.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      return {
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
        replanLlmLog,
        replanSystemPrompt,
        replanUserPrompt,
      };
    } catch (err) {
      // Sub-path 3: TripPlanner threw
      console.warn(`${tag} [PostDeliveryReplanner] Replan failed (${(err as Error).message}). Continuing on existing route.`);
      const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
      const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
      return {
        route: skipped,
        moveTargetInvalidated: true, // JIRA-194: route shape replaced — clear stale move target
      };
    }
  }
}
