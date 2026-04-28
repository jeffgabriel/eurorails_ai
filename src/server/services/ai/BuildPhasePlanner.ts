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

    // ── Phase B: Build ────────────────────────────────────────────────────
    const buildTarget = resolveBuildTarget(activeRoute, context);
    if (!buildTarget) {
      trace.build.skipped = true;
      trace.build.target = null;
      console.log(`${tag} Phase B: no build target — skipping build`);
    } else {
      trace.build.target = buildTarget.targetCity;
      trace.build.skipped = false;
      console.log(
        `${tag} Phase B: build target "${buildTarget.targetCity}" (isVictoryBuild=${buildTarget.isVictoryBuild})`,
      );

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
