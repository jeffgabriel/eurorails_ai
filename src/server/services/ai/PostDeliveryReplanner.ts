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
import { TripPlanner } from './TripPlanner';
import { getMemory } from './BotMemory';
import { TurnExecutorPlanner } from './TurnExecutorPlanner';
import { NewRoutePlanner } from './NewRoutePlanner';
import type { TurnPlanUpgradeTrain } from '../../../shared/types/GameTypes';

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
      //
      // JIRA-210A: Patch activeRoute into replanMemory from the post-advance parameter.
      // When the just-completed delivery was the route's last stop, currentStopIndex equals
      // stops.length → set null so CURRENT PLAN renders "(no current plan in flight)".
      // Otherwise, pass the post-advance route through so remaining stops are visible.
      const postDeliveryRoute = activeRoute.currentStopIndex < activeRoute.stops.length
        ? activeRoute    // route still has remaining stops — show them in CURRENT PLAN
        : null;          // route fully completed — render "(no current plan in flight)"
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
        console.log(
          `${tag} [PostDeliveryReplanner] Replan succeeded. New route: ${finalRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
        );

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
        };
      }

      // Sub-path 2a: JIRA-207B (R10e) — TripPlanner returned keep_current_plan.
      // Preserve the existing activeRoute without heuristic-fallback or DiscardHand.
      const replanSelection = 'selection' in replanResult ? replanResult.selection : undefined;
      if (!replanResult.route && replanSelection?.fallbackReason === 'keep_current_plan') {
        console.log(`${tag} [PostDeliveryReplanner] keep_current_plan: preserving existing activeRoute, no replan triggered`);
        const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
        const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
        return {
          route: skipped,
          moveTargetInvalidated: false, // Route unchanged — stale indices remain valid
          replanLlmLog,
          replanSystemPrompt,
          replanUserPrompt,
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
