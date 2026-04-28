/**
 * InitialBuildRunner — Sub-stage B of the Stage 3 decision gate (JIRA-195b sub-slice C).
 *
 * When the bot is in the initial-build phase (first turns before any active route
 * with phase='build'), this service plans and executes the heuristic initial build
 * by invoking InitialBuildPlanner and TurnExecutorPlanner.
 *
 * Pure code motion from AIStrategyEngine.ts sub-stage B (lines 267-320).
 * Zero behaviour change. No LLM calls — InitialBuildPlanner is heuristic.
 *
 * Key design decisions:
 *   - Static-method only class (no constructor, no state).
 *   - Matches the shape of ActiveRouteContinuer (JIRA-195b sub-slice B).
 *   - JIRA-148 demand-score injection (memory.deliveryCount → planInitialBuild) preserved verbatim.
 *   - JIRA-167: Only called on the FIRST initial-build turn; subsequent turns with
 *     phase='build' fall through to ActiveRouteContinuer.
 */

import {
  WorldSnapshot,
  AIActionType,
  GameContext,
  GridPoint,
  InitialBuildPlan,
} from '../../../shared/types/GameTypes';
import { InitialBuildPlanner } from './InitialBuildPlanner';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import type { BotMemoryState } from '../../../shared/types/GameTypes';
import type { Stage3Result } from './schemas';

// ── InitialBuildRunner ────────────────────────────────────────────────────────

/**
 * InitialBuildRunner — plans and executes the bot's initial build on the first turns.
 *
 * Called when AIStrategyEngine determines `context.isInitialBuild` is true and no
 * active route with phase='build' exists yet (the first `if (context.isInitialBuild ...)`
 * branch). Delegates to InitialBuildPlanner.planInitialBuild (heuristic, no LLM) and
 * TurnExecutorPlanner.execute for Phase B segments.
 */
export class InitialBuildRunner {
  /**
   * Run the initial-build branch for one turn.
   *
   * @param snapshot     Frozen world state for this turn.
   * @param context      Decision-relevant bot context for this turn.
   * @param brain        LLM brain (may be null; not used — InitialBuildPlanner is heuristic).
   * @param gridPoints   Full hex-grid topology for path planning.
   * @param memory       Bot memory state; supplies deliveryCount for JIRA-148 demand-score injection.
   * @param tag          Log prefix (e.g. `[bot:42 turn:7]`) for traceability.
   * @returns Partial Stage3Result carrying activeRoute, decision, and execCompositionTrace.
   */
  static async run(
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain | null,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    tag: string,
  ): Promise<
    Pick<Stage3Result, 'activeRoute' | 'decision' | 'execCompositionTrace'> & {
      evaluatedOptions?: InitialBuildPlan['evaluatedOptions'];
      evaluatedPairings?: InitialBuildPlan['evaluatedPairings'];
    }
  > {
    // ── JIRA-142b: Computed initial build — bypass LLM entirely ──
    // JIRA-167: Only plan on the FIRST initial-build turn. On subsequent turns,
    // activeRoute already has phase='build' from the prior turn, so we fall
    // through to the executor branch to continue building the existing plan.
    // Plan the route and produce a BuildTrack decision with targetCity.
    // Don't go through PlanExecutor.executeInitialBuild — its cold-start
    // segment computation fails. Instead, let TurnComposer Phase B
    // (BuildAdvisor) compute the actual segments.
    // JIRA-148: Pass pre-computed demand scores for corridor/victory-aware route selection
    const demandScores = new Map<string, number>();
    for (const d of context.demands) {
      demandScores.set(`${d.loadType}:${d.deliveryCity}`, d.demandScore);
    }
    const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints, demandScores);
    console.log(`${tag} Initial build: chose ${buildPlan.route.length > 2 ? 'double' : 'single'} delivery, startingCity=${buildPlan.startingCity}, payout=${buildPlan.totalPayout}M, buildCost=${buildPlan.totalBuildCost}M`);

    let activeRoute = {
      stops: buildPlan.route,
      currentStopIndex: 0,
      phase: 'build' as const,
      startingCity: buildPlan.startingCity,
      createdAtTurn: snapshot.turnNumber,
      reasoning: `[initial-build-planner] ${buildPlan.buildPriority}`,
    };

    // JIRA-145: Skip starting city — when first route stop is a pickup at the starting city,
    // we need to target the delivery destination, not build toward ourselves.
    const targetCity = buildPlan.route.find(
      s => s.city.toLowerCase() !== buildPlan.startingCity.toLowerCase(),
    )?.city ?? buildPlan.route[0]?.city ?? buildPlan.startingCity;
    const routeSummary = `Route: ${buildPlan.route.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`;

    // Use TurnExecutorPlanner to compute Phase B (BuildAdvisor segments) for the initial build route.
    // All stops are off-network, so TurnExecutorPlanner will resolve build target and call BuildAdvisor.
    const initialExecResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);
    const execCompositionTrace: CompositionTrace = initialExecResult.compositionTrace;
    const initialPlan = initialExecResult.plans.length === 0
      ? { type: AIActionType.BuildTrack as const, segments: [], targetCity }
      : initialExecResult.plans.length === 1
        ? initialExecResult.plans[0]
        : { type: 'MultiAction' as const, steps: initialExecResult.plans };

    const decision = {
      plan: initialPlan,
      reasoning: `[initial-build-planner] ${buildPlan.buildPriority}`,
      planHorizon: routeSummary,
      model: 'initial-build-planner',
      latencyMs: 0,
      retried: false,
      userPrompt: `[Computed] Initial build: ${routeSummary}, startingCity=${buildPlan.startingCity}`,
    };

    return {
      activeRoute,
      decision,
      execCompositionTrace,
      evaluatedOptions: buildPlan.evaluatedOptions,
      evaluatedPairings: buildPlan.evaluatedPairings,
    };
  }
}
