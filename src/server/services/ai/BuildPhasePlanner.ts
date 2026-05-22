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
import { isFloodRebuildBlocked, isBuildBlockedAtMilepost } from '../restrictionPredicates';
import type { BuildRestriction } from '../../../shared/types/EventCard';

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

    // ── JIRA-256: Eager Flood rebuild pre-step ────────────────────────────
    // When bot has pending Flood rebuilds, block all other building until the
    // rebuild list is empty. This preserves network shape across Flood events.
    const pendingRebuilds = snapshot.bot.pendingFloodRebuilds ?? [];
    const activeEffects = snapshot.activeEffects ?? [];
    if (pendingRebuilds.length > 0) {
      // Filter to segments that are NOT currently Flood-blocked (i.e., actionable rebuilds)
      const rebuildable = pendingRebuilds.filter(
        seg => !isFloodRebuildBlocked(activeEffects, seg).blocked,
      );
      if (rebuildable.length > 0) {
        // Block all other building — emit BuildTrack actions for pending rebuilds up to budget
        const rebuildSegments: typeof rebuildable = [];
        let budgetRemaining = TURN_BUILD_BUDGET;
        for (const seg of rebuildable) {
          if (seg.cost > budgetRemaining) break;
          rebuildSegments.push(seg);
          budgetRemaining -= seg.cost;
        }
        if (rebuildSegments.length > 0) {
          console.info(`[BuildPhasePlanner] Eager Flood rebuild: ${rebuildSegments.length} of ${rebuildable.length} rebuildable segments this turn`);
          const rebuildPlan: TurnPlan = {
            type: AIActionType.BuildTrack,
            segments: rebuildSegments,
            targetCity: 'flood_rebuild',
          };
          trace.outputPlan = ['BuildTrack'];
          return {
            plans: [...plans, rebuildPlan],
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
        // All actionable rebuilds fit in 0 budget (shouldn't happen) — fall through
      }
      // All pending rebuilds are still Flood-blocked — proceed with normal Phase B
      // (spec option b: allow normal building when nothing is rebuildable yet)
    }

    // ── JIRA-256: Phase B restriction check ──────────────────────────────
    // If Rail Strike targets the bot, skip Phase B entirely (no_build_for_player)
    const allBuildRestrictions: BuildRestriction[] = activeEffects.flatMap(
      e => e.restrictions.build,
    );
    const railStrikeBlocked = allBuildRestrictions.some(
      r => r.type === 'no_build_for_player' && r.targetPlayerId === snapshot.bot.playerId,
    );
    if (railStrikeBlocked) {
      console.info(`[BuildPhasePlanner] Rail Strike: skipping Phase B for player ${snapshot.bot.playerId}`);
      trace.build.skipped = true;
      trace.build.target = null;
      if (plans.length === 0) {
        plans.push({ type: AIActionType.PassTurn });
      }
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

    // ── Phase B: Build ────────────────────────────────────────────────────
    const buildTarget = resolveBuildTarget(activeRoute, context);
    if (!buildTarget) {
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
