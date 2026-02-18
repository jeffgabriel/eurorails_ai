/**
 * GuardrailEnforcer — Applies hard safety rules to LLM-selected options.
 *
 * Three rules:
 * 1. Delivery move override: force delivery if LLM skipped movement
 * 2. Bankruptcy prevention: ensure build cost doesn't leave money below 5M
 * 3. Discard hand override: prefer building track over discarding
 *
 * Pure function — no side effects, no DB access.
 */

import {
  FeasibleOption,
  AIActionType,
  WorldSnapshot,
  GuardrailResult,
} from '../../../shared/types/GameTypes';

export class GuardrailEnforcer {
  /**
   * Check both the move and build selections against hard rules.
   *
   * @param selectedMove - The chosen move option (undefined if moveIndex === -1)
   * @param selectedBuild - The chosen build option
   * @param allMoveOptions - All available move options
   * @param allBuildOptions - All available build options
   * @param snapshot - Current game state snapshot
   * @returns GuardrailResult indicating any overrides applied
   */
  static check(
    selectedMove: FeasibleOption | undefined,
    selectedBuild: FeasibleOption,
    allMoveOptions: FeasibleOption[],
    allBuildOptions: FeasibleOption[],
    snapshot: WorldSnapshot,
  ): GuardrailResult {
    let moveOverridden = false;
    let buildOverridden = false;
    let correctedMoveIndex: number | undefined;
    let correctedBuildIndex: number | undefined;
    const reasons: string[] = [];

    // ── Move guardrails ──

    // Rule 1: If bot has a deliverable load and a reachable delivery city,
    // prefer the move toward that city (don't skip movement)
    if (!selectedMove && allMoveOptions.length > 0) {
      const deliveryMoveIdx = allMoveOptions.findIndex(
        (o) => o.feasible && o.payment != null && o.payment > 0,
      );
      if (deliveryMoveIdx >= 0) {
        moveOverridden = true;
        correctedMoveIndex = deliveryMoveIdx;
        reasons.push('Guardrail: skipped movement but deliverable load reachable');
      }
    }

    // ── Build guardrails ──

    // Rule 2: Never go bankrupt — check build cost against remaining money
    // Account for track usage fees from the selected move
    const moveCost = selectedMove?.estimatedCost ?? 0;
    const remainingAfterMove = snapshot.bot.money - moveCost;

    if (
      selectedBuild.estimatedCost &&
      remainingAfterMove - selectedBuild.estimatedCost < 5
    ) {
      const safeOptions = allBuildOptions
        .map((o, i) => ({ o, i }))
        .filter(
          ({ o }) => !o.estimatedCost || remainingAfterMove - o.estimatedCost >= 5,
        );
      if (safeOptions.length > 0) {
        buildOverridden = true;
        correctedBuildIndex = safeOptions[0].i;
        reasons.push(
          `Guardrail: build would leave ${remainingAfterMove - selectedBuild.estimatedCost!}M (below 5M minimum)`,
        );
      }
    }

    // Rule 3: Never discard hand when buildable track options exist
    if (selectedBuild.action === AIActionType.DiscardHand) {
      const nonDiscardIdx = allBuildOptions.findIndex(
        (o) => o.feasible && o.action === AIActionType.BuildTrack,
      );
      if (nonDiscardIdx >= 0) {
        buildOverridden = true;
        correctedBuildIndex = nonDiscardIdx;
        reasons.push('Guardrail: DiscardHand overridden — buildable track available');
      }
    }

    // Rule 4: DiscardHand is an absolute last resort — override to PassTurn
    // unless the bot has track investment AND has built track (has a plan to commit to).
    // The LLM prompt + Scorer should keep DiscardHand scored below PassTurn,
    // but this guardrail catches edge cases.
    if (
      !buildOverridden &&
      selectedBuild.action === AIActionType.DiscardHand &&
      snapshot.bot.existingSegments.length > 0
    ) {
      const passIdx = allBuildOptions.findIndex(
        (o) => o.feasible && o.action === AIActionType.PassTurn,
      );
      if (passIdx >= 0) {
        buildOverridden = true;
        correctedBuildIndex = passIdx;
        reasons.push('Guardrail: DiscardHand blocked — bot has track investment, commit to current cards');
      }
    }

    return {
      moveOverridden,
      buildOverridden,
      correctedMoveIndex,
      correctedBuildIndex,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    };
  }
}
