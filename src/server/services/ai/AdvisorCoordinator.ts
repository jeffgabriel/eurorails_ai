/**
 * AdvisorCoordinator — concentrates all LLM advisor invocations inside
 * TurnExecutorPlanner behind two named static methods.
 *
 * Scope (JIRA-195 Slice 2):
 *   - adviseEnrichment: wraps RouteEnrichmentAdvisor.enrich (post-delivery replan path)
 *   - adviseBuild: wraps BuildAdvisor.advise + BuildAdvisor.retryWithSolvencyFeedback
 *     (Phase B build path)
 *
 * Pure code motion — same prompts, same retries, same fallbacks as the
 * inline call sites this replaces. Zero behaviour change intended.
 *
 * Out of scope: RouteOptimizer in TripPlanner.ts, RouteEnrichmentAdvisor in
 * AIStrategyEngine.ts:495, per-turn LLM budget (Slice 2b/2c).
 */

import {
  StrategicRoute,
  WorldSnapshot,
  GameContext,
  GridPoint,
  TurnPlan,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { BuildAdvisor } from './BuildAdvisor';
import { ActionResolver } from './ActionResolver';

/**
 * Result returned by adviseBuild, carrying the resolved plan (or null if
 * the advisor produced no actionable result) and any resolver log for
 * propagation into the composition trace.
 */
export interface AdviseBuildResult {
  plan: TurnPlan | null;
  buildResolverLog?: Record<string, unknown>;
}

/**
 * AdvisorCoordinator — static-method class. No instance state.
 *
 * Precondition checks (brain, gridPoints present, route exists) and the
 * solvency-retry loop live here so callers only pass context; they do not
 * need to know which advisor to invoke or how many retries to perform.
 */
export class AdvisorCoordinator {
  /**
   * Enrich a route with LLM suggestions after a post-delivery replan.
   *
   * Precondition: brain and gridPoints must be non-null/non-empty — callers
   * MUST check before calling (mirrors the inline guard at TurnExecutorPlanner:441).
   *
   * Falls back to the original route on any error (RouteEnrichmentAdvisor
   * already handles this internally; we preserve that semantic here).
   *
   * @param route - Freshly planned route from TripPlanner.
   * @param snapshot - Current world snapshot.
   * @param context - Game context.
   * @param brain - LLM strategy brain.
   * @param gridPoints - Full hex grid.
   * @returns Enriched route, or original route on failure.
   */
  static async adviseEnrichment(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
  ): Promise<StrategicRoute> {
    return RouteEnrichmentAdvisor.enrich(route, snapshot, context, brain, gridPoints);
  }

  /**
   * Ask the BuildAdvisor LLM for track-building waypoints, with at most one
   * solvency retry if the first recommendation exceeds the available budget.
   *
   * Preconditions enforced by caller: brain != null, gridPoints != null.
   * Returns null when both the advisor and solvency retry fail, so the caller
   * can fall through to the heuristic path.
   *
   * @param targetCity - Heuristic-resolved build target (fallback value).
   * @param remainingBudget - Available build budget this turn.
   * @param activeRoute - Current strategic route.
   * @param snapshot - Current world snapshot.
   * @param context - Game context.
   * @param brain - LLM strategy brain.
   * @param gridPoints - Full hex grid.
   * @param tag - Log prefix for tracing.
   * @returns AdviseBuildResult with plan (or null) and optional resolver log.
   */
  static async adviseBuild(
    targetCity: string,
    remainingBudget: number,
    activeRoute: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
    tag: string,
  ): Promise<AdviseBuildResult> {
    try {
      const advisorResult = await BuildAdvisor.advise(
        snapshot,
        context,
        activeRoute,
        gridPoints,
        brain,
      );

      if (advisorResult && (advisorResult.action === 'build' || advisorResult.action === 'buildAlternative')) {
        const advisorTargetCity = advisorResult.target ?? targetCity;
        const waypoints: [number, number][] = advisorResult.waypoints ?? [];

        const details: Record<string, any> = { toward: advisorTargetCity };
        if (waypoints.length > 0) details.waypoints = waypoints;

        const buildResult = await ActionResolver.resolve(
          { action: 'BUILD', details, reasoning: advisorResult.reasoning ?? '', planHorizon: '' },
          snapshot,
          context,
          activeRoute.startingCity,
        );

        if (buildResult.success && buildResult.plan) {
          console.log(`${tag} BuildAdvisor succeeded: building toward "${advisorTargetCity}"`);
          const result: AdviseBuildResult = { plan: buildResult.plan };
          if (buildResult.buildResolverLog) result.buildResolverLog = buildResult.buildResolverLog as Record<string, unknown>;
          return result;
        }

        // ── Solvency retry (max 1) ────────────────────────────────────────
        console.warn(`${tag} BuildAdvisor build failed (${buildResult.error}), attempting 1 solvency retry`);
        const retryAdvisorResult = await BuildAdvisor.retryWithSolvencyFeedback(
          advisorResult,
          remainingBudget + 1, // Indicate overshoot — actual cost exceeded budget
          remainingBudget,
          snapshot,
          context,
          activeRoute,
          gridPoints,
          brain,
        );

        if (retryAdvisorResult && (retryAdvisorResult.action === 'build' || retryAdvisorResult.action === 'buildAlternative')) {
          const retryCity = retryAdvisorResult.target ?? targetCity;
          const retryWaypoints: [number, number][] = retryAdvisorResult.waypoints ?? [];
          const retryDetails: Record<string, any> = { toward: retryCity };
          if (retryWaypoints.length > 0) retryDetails.waypoints = retryWaypoints;

          const retryBuildResult = await ActionResolver.resolve(
            { action: 'BUILD', details: retryDetails, reasoning: retryAdvisorResult.reasoning ?? '', planHorizon: '' },
            snapshot,
            context,
            activeRoute.startingCity,
          );

          if (retryBuildResult.success && retryBuildResult.plan) {
            console.log(`${tag} BuildAdvisor solvency retry succeeded: building toward "${retryCity}"`);
            const result: AdviseBuildResult = { plan: retryBuildResult.plan };
            if (retryBuildResult.buildResolverLog) result.buildResolverLog = retryBuildResult.buildResolverLog as Record<string, unknown>;
            return result;
          }
        }
      }
    } catch (err) {
      console.warn(`${tag} BuildAdvisor threw error: ${(err as Error).message}. Falling back to heuristic.`);
    }

    return { plan: null };
  }
}
