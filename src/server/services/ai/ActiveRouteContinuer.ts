/**
 * ActiveRouteContinuer — Sub-stage C of the Stage 3 decision gate (JIRA-195b sub-slice B).
 *
 * When the bot already has an active strategic route from a prior turn, this
 * service drives execution of that route for the current turn by invoking
 * TurnExecutorPlanner and propagating the result fields into a typed
 * Pick<Stage3Result, ...> record.
 *
 * Pure code motion from AIStrategyEngine.ts sub-stage C (lines 320-361).
 * Zero behaviour change. No LLM calls.
 *
 * Key design decisions:
 *   - Static-method only class (no constructor, no state).
 *   - Matches the shape of MovementPhasePlanner / BuildPhasePlanner (JIRA-195 Slice 3).
 *   - JIRA-185 replan LLM data propagation preserved verbatim.
 */

import {
  WorldSnapshot,
  AIActionType,
  GameContext,
  StrategicRoute,
  GridPoint,
} from '../../../shared/types/GameTypes';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import type { Stage3Result } from './schemas';

// ── ActiveRouteContinuer ──────────────────────────────────────────────────

/**
 * ActiveRouteContinuer — continues execution of an in-progress strategic route.
 *
 * Called when AIStrategyEngine determines the bot has an `activeRoute` from a
 * prior turn (the `} else if (activeRoute) {` branch). Delegates to
 * TurnExecutorPlanner.execute and returns a partial Stage3Result carrying the
 * six fields that flow into the downstream sub-stages (F1-F4).
 */
export class ActiveRouteContinuer {
  /**
   * Run active-route continuation for one turn.
   *
   * @param activeRoute  The in-progress strategic route from bot memory.
   * @param snapshot     Frozen world state for this turn.
   * @param context      Decision-relevant bot context for this turn.
   * @param brain        LLM brain (may be null when no API key is configured).
   * @param gridPoints   Full hex-grid topology for path planning.
   * @param tag          Log prefix (e.g. `[bot:42 turn:7]`) for traceability.
   * @returns Partial Stage3Result containing all fields mutated by sub-stage C.
   */
  static async run(
    activeRoute: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain | null,
    gridPoints: GridPoint[],
    tag: string,
  ): Promise<Pick<Stage3Result, 'decision' | 'activeRoute' | 'routeWasCompleted' | 'routeWasAbandoned' | 'hasDelivery' | 'execCompositionTrace' | 'pendingUpgradeAction' | 'upgradeSuppressionReason'>> {
    // ── Auto-execute from active route (no LLM call) ──
    console.log(`${tag} Active route: stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`);
    const execResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);

    // Convert TurnExecutorResult.plans[] to a single TurnPlan
    const execPlan = execResult.plans.length === 0
      ? { type: AIActionType.PassTurn as const }
      : execResult.plans.length === 1
        ? execResult.plans[0]
        : { type: 'MultiAction' as const, steps: execResult.plans };

    const routeSummary = `Route: ${activeRoute.stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;
    const decision = {
      plan: execPlan,
      reasoning: `[route-executor] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`,
      planHorizon: routeSummary,
      model: 'route-executor',
      latencyMs: 0,
      retried: false,
      userPrompt: `[Route] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}. ${routeSummary}`,
      // Propagate post-delivery replan LLM data for debug overlay
      ...(execResult.replanLlmLog && { llmLog: execResult.replanLlmLog }),
      ...(execResult.replanSystemPrompt && { systemPrompt: execResult.replanSystemPrompt }),
      ...(execResult.replanUserPrompt && { userPrompt: execResult.replanUserPrompt }),
    };

    const execCompositionTrace: CompositionTrace = execResult.compositionTrace;
    let routeWasCompleted = false;
    let routeWasAbandoned = false;
    let hasDelivery = false;

    if (execResult.routeComplete) {
      routeWasCompleted = true;
      console.log(`${tag} Route completed!`);
    } else if (execResult.routeAbandoned) {
      routeWasAbandoned = true;
      console.log(`${tag} Route abandoned: ${execResult.compositionTrace.a2.terminationReason}`);
    } else {
      // Save updated route state (advanced stop/phase)
      activeRoute = execResult.updatedRoute;
    }
    // Propagate hasDelivery from TurnExecutorPlanner (used downstream for route clearing)
    if (execResult.hasDelivery) {
      hasDelivery = true;
    }

    return {
      decision,
      activeRoute,
      routeWasCompleted,
      routeWasAbandoned,
      hasDelivery,
      execCompositionTrace,
      // JIRA-198: Forward upgrade signal from TurnExecutorPlanner so the existing
      // injection point at AIStrategyEngine.ts:345 fires for the active-route branch.
      pendingUpgradeAction: execResult.pendingUpgradeAction ?? null,
      upgradeSuppressionReason: execResult.upgradeSuppressionReason ?? null,
    };
  }
}
