/**
 * BuildPhasePlanner — Phase B of turn execution (JIRA-195 Slice 3b).
 *
 * Extracted from TurnExecutorPlanner.execute() Phase B logic (lines 693-808).
 * Consumes PhaseAResult from MovementPhasePlanner and returns PhaseBResult
 * carrying the final set of turn plans.
 *
 * Phase B responsibilities:
 *   1. JIRA-187 capped-city pre-check (may short-circuit with a different plan set)
 *   2. resolveBuildTarget → determine what to build toward
 *   3. assertBuildDirectionAgreesWithMove (AC13b)
 *   4. executeBuildPhase via AdvisorCoordinator (BuildAdvisor + JIT gate + heuristic fallback)
 *   5. Emit PassTurn if no plans produced
 *
 * Key design decisions:
 *   - Static-method only class (no constructor, no state).
 *   - Consumes AdvisorCoordinator (from Slice 2), NOT BuildAdvisor directly.
 *   - PhaseAResult is the sole input vehicle for phase-crossing state.
 */

import {
  TurnPlan,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  AIActionType,
  GridPoint,
  LlmAttempt,
} from '../../../shared/types/GameTypes';
import { resolveBuildTarget } from './routeHelpers';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import type { PhaseAResult } from './schemas';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { isBuildBlockedAtMilepost, isFloodRebuildBlocked } from '../../services/restrictionPredicates';
import { BuildRestriction } from '../../../shared/types/EventCard';

// ── PhaseBResult ──────────────────────────────────────────────────────────

/**
 * Result returned by BuildPhasePlanner.run().
 *
 * Contains the final set of plans (Phase A + Phase B combined),
 * the updated route, and flags for the TurnExecutorPlanner assembler.
 */
export interface PhaseBResult {
  /** All plans to execute this turn (Phase A movement + Phase B build). */
  plans: TurnPlan[];
  /** Route state after Phase B (may be identical to PhaseAResult.activeRoute). */
  updatedRoute: StrategicRoute;
  /** True when at least one delivery was made this turn. */
  hasDelivery: boolean;
  /** True when all route stops completed. */
  routeComplete: boolean;
  /** True when the route was abandoned. */
  routeAbandoned: boolean;
  /** Post-delivery replan LLM log from Phase A (propagated through). */
  replanLlmLog?: LlmAttempt[];
  /** Post-delivery replan system prompt from Phase A. */
  replanSystemPrompt?: string;
  /** Post-delivery replan user prompt from Phase A. */
  replanUserPrompt?: string;
  /** Accumulated upgrade action from Phase A post-delivery replans (JIRA-198). */
  pendingUpgradeAction?: import('../../../shared/types/GameTypes').TurnPlanUpgradeTrain | null;
  /** Suppression reason when an upgrade was blocked in Phase A (JIRA-198). */
  upgradeSuppressionReason?: string | null;
}

// ── BuildPhasePlanner ─────────────────────────────────────────────────────

/**
 * BuildPhasePlanner — Phase B orchestrator.
 *
 * Takes PhaseAResult (all Phase A state), handles capped-city routing,
 * resolves build target, and runs the build advisor pipeline.
 *
 * Static-method only; no constructor.
 */
export class BuildPhasePlanner {
  /**
   * Run Phase B: capped-city check + build target resolution + build execution.
   *
   * Mirrors Phase B logic from TurnExecutorPlanner.execute() lines 693-808.
   * Returns PhaseBResult combining Phase A plans with any Phase B build plan.
   *
   * @param phaseAResult - Typed handoff from MovementPhasePlanner.run().
   * @param snapshot - Current world snapshot.
   * @param context - Derived game context.
   * @param trace - Shared CompositionTrace (mutated for Phase B build fields).
   * @param brain - Optional LLM strategy brain for AdvisorCoordinator.
   * @param gridPoints - Optional pre-loaded grid points.
   * @returns PhaseBResult with all plans and final route state.
   */
  static async run(
    phaseAResult: PhaseAResult,
    snapshot: WorldSnapshot,
    context: GameContext,
    trace: CompositionTrace,
    brain?: LLMStrategyBrain | null,
    gridPoints?: GridPoint[],
  ): Promise<PhaseBResult> {
    const tag = '[BuildPhasePlanner]';

    // If Phase A terminated with routeComplete or routeAbandoned, skip Phase B
    if (phaseAResult.routeComplete || phaseAResult.routeAbandoned) {
      return {
        plans: phaseAResult.accumulatedPlans,
        updatedRoute: phaseAResult.activeRoute,
        hasDelivery: phaseAResult.hasDelivery,
        routeComplete: phaseAResult.routeComplete,
        routeAbandoned: phaseAResult.routeAbandoned,
        replanLlmLog: phaseAResult.replanLlmLog,
        replanSystemPrompt: phaseAResult.replanSystemPrompt,
        replanUserPrompt: phaseAResult.replanUserPrompt,
        pendingUpgradeAction: phaseAResult.pendingUpgradeAction,
        upgradeSuppressionReason: phaseAResult.upgradeSuppressionReason,
      };
    }

    const activeRoute = phaseAResult.activeRoute;
    const plans: TurnPlan[] = [...phaseAResult.accumulatedPlans];
    const hasDelivery = phaseAResult.hasDelivery;
    const lastMoveTargetCity = phaseAResult.lastMoveTargetCity;

    // ── JIRA-187: Capped-city pre-check ──────────────────────────────────
    const pendingStop = activeRoute.stops[activeRoute.currentStopIndex];
    if (pendingStop && pendingStop.action === 'deliver') {
      const cappedCheck = TurnExecutorPlanner.isCappedCityBlocked(snapshot, pendingStop.city);
      if (cappedCheck) {
        const cappedResult = TurnExecutorPlanner.resolveCappedCityDelivery(
          snapshot,
          activeRoute,
          context,
          pendingStop,
          tag,
        );
        if (cappedResult.handled) {
          trace.outputPlan = cappedResult.plans.map(p => p.type);
          return {
            plans: cappedResult.plans,
            updatedRoute: activeRoute,
            hasDelivery,
            routeComplete: false,
            routeAbandoned: cappedResult.routeAbandoned ?? false,
            replanLlmLog: phaseAResult.replanLlmLog,
            replanSystemPrompt: phaseAResult.replanSystemPrompt,
            replanUserPrompt: phaseAResult.replanUserPrompt,
            pendingUpgradeAction: phaseAResult.pendingUpgradeAction,
            upgradeSuppressionReason: phaseAResult.upgradeSuppressionReason,
          };
        } else {
          // 2c: abandon route
          console.warn(`${tag} Capped city — route abandoned: ${cappedResult.error}`);
          trace.a2.terminationReason = 'capped_city_abandoned';
          trace.outputPlan = [AIActionType.PassTurn];
          return {
            plans: [{ type: AIActionType.PassTurn }],
            updatedRoute: activeRoute,
            hasDelivery,
            routeComplete: false,
            routeAbandoned: true,
            replanLlmLog: phaseAResult.replanLlmLog,
            replanSystemPrompt: phaseAResult.replanSystemPrompt,
            replanUserPrompt: phaseAResult.replanUserPrompt,
            pendingUpgradeAction: phaseAResult.pendingUpgradeAction,
            upgradeSuppressionReason: phaseAResult.upgradeSuppressionReason,
          };
        }
      }
    }

    // ── Flood rebuild pre-step ────────────────────────────────────────────
    // When the bot has pending Flood rebuild segments, prioritise rebuilding
    // the first segment (FIFO) that is no longer blocked by an active Flood
    // event.  If a rebuildable segment exists, return immediately with only
    // the BuildTrack plan — normal routing is deferred to the next turn.
    const pendingRebuilds = snapshot.bot.pendingFloodRebuilds ?? [];
    if (pendingRebuilds.length > 0 && !phaseAResult.hasDelivery) {
      const activeEffects = snapshot.activeEffects ?? [];
      for (const seg of pendingRebuilds) {
        const floodStillActive = isFloodRebuildBlocked(activeEffects, seg);
        if (!floodStillActive.blocked) {
          // Flood has cleared — this segment can be rebuilt now
          const rebuildPlan: TurnPlan = {
            type: AIActionType.BuildTrack,
            segments: [seg],
          };
          console.info(
            `[BuildPhasePlanner] Flood rebuild pre-step: rebuilding erased segment (${seg.from.row},${seg.from.col})→(${seg.to.row},${seg.to.col})`,
          );
          trace.outputPlan = [AIActionType.BuildTrack];
          return {
            plans: [...phaseAResult.accumulatedPlans, rebuildPlan],
            updatedRoute: activeRoute,
            hasDelivery: phaseAResult.hasDelivery,
            routeComplete: false,
            routeAbandoned: false,
            replanLlmLog: phaseAResult.replanLlmLog,
            replanSystemPrompt: phaseAResult.replanSystemPrompt,
            replanUserPrompt: phaseAResult.replanUserPrompt,
            pendingUpgradeAction: phaseAResult.pendingUpgradeAction,
            upgradeSuppressionReason: phaseAResult.upgradeSuppressionReason,
          };
        }
      }
    }

    // ── Phase B: Build ────────────────────────────────────────────────────
    // JIRA-247: When Phase A's A3 origin-is-current-pos branch already
    // committed a BuildTrack into the plan list, skip Phase B's independent
    // build attempt — Phase B's computeBuildSegments invocation can return []
    // at medium-city outer mileposts and produce a no-op PassTurn that masks
    // the already-committed build.
    const phaseAEmittedBuild = phaseAResult.accumulatedPlans.some(
      p => p.type === AIActionType.BuildTrack,
    );
    const buildTarget = phaseAEmittedBuild ? null : resolveBuildTarget(activeRoute, context);
    if (phaseAEmittedBuild) {
      // trace.build.target was set by Phase A's A3 fix.
      trace.build.skipped = true;
    } else if (!buildTarget) {
      trace.build.skipped = true;
      trace.build.target = null;
    } else {
      trace.build.target = buildTarget.targetCity;
      trace.build.skipped = false;

      // AC13(b): Build direction must agree with move direction
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove(
        buildTarget.targetCity,
        lastMoveTargetCity,
        activeRoute,
        tag,
      );

      const buildPlan = await TurnExecutorPlanner.executeBuildPhase(
        buildTarget.targetCity,
        buildTarget.isVictoryBuild,
        buildTarget.stopIndex,
        activeRoute,
        snapshot,
        context,
        brain ?? null,
        gridPoints,
        trace,
        tag,
      );

      if (buildPlan) {
        plans.push(buildPlan);
      }

      // JIRA-240: Secondary bundle build — lay pickup connector if budget remains
      if (buildTarget.secondaryTarget && buildTarget.secondaryEstimatedCost != null) {
        // Compute actual primary build cost from the returned plan's segments.
        // If the primary overran its estimate, the remaining budget may be too small
        // for the secondary — skip cleanly in that case (AC14).
        const primaryCost = buildPlan && buildPlan.type === AIActionType.BuildTrack
          ? (buildPlan as import('../../../shared/types/GameTypes').TurnPlanBuildTrack).segments.reduce(
              (sum: number, seg: import('../../../shared/types/GameTypes').TrackSegment) => sum + seg.cost, 0)
          : 0;
        // Budget available for secondary = turn budget minus what primary actually spent
        const remainingBudget = TURN_BUILD_BUDGET - primaryCost;
        const secondaryCost = buildTarget.secondaryEstimatedCost;

        if (primaryCost > 0 && remainingBudget >= secondaryCost) {
          // Attempt secondary build — lay pickup connector track
          try {
            const secondaryPlan = await TurnExecutorPlanner.executeBuildPhase(
              buildTarget.secondaryTarget,
              false, // secondary is route-based, not a victory build
              -1,
              activeRoute,
              snapshot,
              context,
              brain ?? null,
              gridPoints,
              trace,
              tag,
            );
            if (secondaryPlan) {
              plans.push(secondaryPlan);
              trace.build.secondaryTarget = buildTarget.secondaryTarget;
              trace.build.secondaryStatus = 'success';
            } else {
              trace.build.secondaryTarget = buildTarget.secondaryTarget;
              trace.build.secondaryStatus = 'skipped:no_secondary';
            }
          } catch {
            // Secondary build threw — skip cleanly (no partial segments)
            trace.build.secondaryTarget = buildTarget.secondaryTarget;
            trace.build.secondaryStatus = 'skipped:no_secondary';
          }
        } else {
          // Budget exhausted after primary — skip secondary
          trace.build.secondaryTarget = buildTarget.secondaryTarget;
          trace.build.secondaryStatus = 'skipped:budget_exhausted';
        }
      }
    }

    // If no movement or build plans were produced, emit PassTurn
    if (plans.length === 0) {
      plans.push({ type: AIActionType.PassTurn });
    }

    trace.outputPlan = plans.map(p => p.type);

    return {
      plans,
      updatedRoute: activeRoute,
      hasDelivery,
      routeComplete: false,
      routeAbandoned: false,
      replanLlmLog: phaseAResult.replanLlmLog,
      replanSystemPrompt: phaseAResult.replanSystemPrompt,
      replanUserPrompt: phaseAResult.replanUserPrompt,
      pendingUpgradeAction: phaseAResult.pendingUpgradeAction,
      upgradeSuppressionReason: phaseAResult.upgradeSuppressionReason,
    };
  }
}
