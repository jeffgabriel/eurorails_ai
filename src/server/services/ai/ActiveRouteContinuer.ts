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
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import type { Stage3Result } from './schemas';

/**
 * Number of consecutive PassTurn-only turns on the same route before we abandon.
 * After this many turns of zero forward progress, the route is treated as
 * unreachable and abandoned so TripPlanner can replan instead of letting the
 * bot PassTurn forever.
 */
const STUCK_ROUTE_PASSTURN_THRESHOLD = 3;

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
    memory: BotMemoryState,
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

    // Detect stuck-route: route is alive but execution produced no progress
    // and we have already spent ≥ STUCK_ROUTE_PASSTURN_THRESHOLD - 1 turns on this route.
    // memory.turnsOnRoute is the count of *prior* turns on this route, so >= threshold-1
    // means this is the Nth no-progress turn. Abandon so TripPlanner can replan.
    //
    // JIRA-234 Defect A3: widen "no progress" to also catch the case where the
    // executor produces non-empty plans (e.g., a degenerate MoveTrain or BuildTrack)
    // but the underlying build phase failed to make progress toward an off-network
    // delivery stop. Without this, a bot stuck building toward Oslo with $7M can
    // PassTurn indefinitely because plans.length > 0.
    const trace = execResult.compositionTrace;
    const buildCost = trace?.build?.cost ?? 0;
    const buildTarget = trace?.build?.target ?? null;
    const a2Reason = trace?.a2?.terminationReason ?? '';
    const movesUsed = trace?.moveBudget?.used ?? 0;
    const allPlansArePassTurn = execResult.plans.length > 0
      && execResult.plans.every((p) => p.type === AIActionType.PassTurn);
    const zeroProgressBuild = buildCost === 0
      && buildTarget !== null
      && a2Reason === 'stop_city_not_on_network'
      && movesUsed === 0;
    const noProgress = execResult.plans.length === 0
      || allPlansArePassTurn
      || zeroProgressBuild;
    const turnsOnRoute = memory.turnsOnRoute ?? 0;
    const isStuck = noProgress
      && !execResult.routeComplete
      && !execResult.routeAbandoned
      && turnsOnRoute >= STUCK_ROUTE_PASSTURN_THRESHOLD - 1;

    // When a post-delivery replan ran (PostDeliveryReplanner → TripPlanner.planTrip),
    // the new active route's reasoning carries the planner's full diagnostic — verbose
    // deterministic top-1 reasoning for Medium, or the LLM's reasoning for Easy/Hard.
    // Without surfacing it here, that reasoning would be lost since the per-turn NDJSON
    // record only retains the route-executor's brief tag. JIRA-220 follow-up.
    const replanHappened = !!execResult.replanLlmLog && execResult.replanLlmLog.length > 0;
    const replanRouteReasoning = replanHappened ? (execResult.updatedRoute?.reasoning ?? '') : '';

    const baseReasoning = isStuck
      ? `[stuck-route-abandon] no progress for ${turnsOnRoute + 1} turns (a2=${execResult.compositionTrace.a2.terminationReason || 'none'}); abandoning so TripPlanner can replan`
      : `[route-executor] stop ${activeRoute.currentStopIndex}/${activeRoute.stops.length}, phase=${activeRoute.phase}`;

    const reasoning = replanRouteReasoning.trim().length > 0
      ? `${baseReasoning}; replan triggered\n\n${replanRouteReasoning}`
      : baseReasoning;

    const decision = {
      plan: execPlan,
      reasoning,
      planHorizon: routeSummary,
      model: isStuck ? 'stuck-route-abandon' : 'route-executor',
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
    } else if (isStuck) {
      routeWasAbandoned = true;
      console.log(`${tag} Route abandoned: stuck for ${turnsOnRoute + 1} turns with no progress (a2.terminationReason=${execResult.compositionTrace.a2.terminationReason || 'none'})`);
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
