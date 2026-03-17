/**
 * GuardrailEnforcer — Applies hard safety guardrails to LLM action plans.
 *
 * `checkPlan()` enforces hard rules on TurnPlan (checked in priority order):
 *   G1. Force DELIVER when canDeliver has opportunities (highest priority)
 *   Stuck. Force DiscardHand when noProgressTurns >= 3 AND no loads carried
 *   G3. Block UPGRADE during initialBuild phase
 *   G8. Movement budget enforcement (silent truncation)
 *
 * These are NOT strategic overrides — they enforce game rules and mathematical
 * feasibility the LLM must not violate. Strategic decisions remain the LLM's.
 */

import {
  WorldSnapshot,
  GuardrailPlanResult,
  TurnPlan,
  TurnPlanMoveTrain,
  GameContext,
  AIActionType,
} from '../../../shared/types/GameTypes';

export class GuardrailEnforcer {
  /**
   * Enforce hard guardrails on a TurnPlan.
   *
   * Returns the plan unchanged if no guardrail fires. If a guardrail fires,
   * returns a corrected plan with `overridden: true` and a reason string.
   *
   * Guardrails (checked in priority order):
   *   G1: Force DELIVER when bot can deliver but LLM chose something else (highest priority)
   *   Stuck: Force DiscardHand when noProgressTurns >= 3 AND no loads carried AND no active route (JIRA-68)
   *   G3: Block UPGRADE during initialBuild phase
   *   G8: Movement budget enforcement (silent truncation)
   */
  static async checkPlan(
    plan: TurnPlan,
    context: GameContext,
    snapshot: WorldSnapshot,
    noProgressTurns: number = 0,
    hasActiveRoute: boolean = false,
  ): Promise<GuardrailPlanResult> {
    const planType = plan.type === 'MultiAction' ? GuardrailEnforcer.primaryActionType(plan) : plan.type;

    // Guardrail 1: Force DELIVER when canDeliver has opportunities
    // Checked FIRST — delivery opportunities must never be blocked by stuck detection (JIRA-47)
    if (context.canDeliver.length > 0 && planType !== AIActionType.DeliverLoad) {
      const best = GuardrailEnforcer.bestDelivery(context);
      console.warn(`[Guardrail 1] Forced DELIVER: ${best.loadType} at ${best.deliveryCity} for ${best.payout}M (LLM chose ${planType})`);
      return {
        plan: {
          type: AIActionType.DeliverLoad,
          load: best.loadType,
          city: best.deliveryCity,
          cardId: best.cardIndex,
          payout: best.payout,
        },
        overridden: true,
        reason: `Forced DELIVER: ${best.loadType} at ${best.deliveryCity} for ${best.payout}M (LLM chose ${planType})`,
      };
    }

    // Progress-based stuck detection: force DiscardHand after 3+ turns with zero progress
    // JIRA-68: Skip when bot has an active route — traveling toward a pickup is progress
    // JIRA-120: Removed loads.length === 0 gate — carrying loads is not a reason to keep a bad hand
    if (noProgressTurns >= 3 && planType !== AIActionType.DiscardHand && !hasActiveRoute) {
      console.warn(`[Guardrail Stuck] ${noProgressTurns} no-progress turns — forcing DiscardHand`);
      return {
        plan: { type: AIActionType.DiscardHand },
        overridden: true,
        reason: `Progress-based stuck detection: ${noProgressTurns} turns with no deliveries, cash increase, or new cities — forcing DiscardHand`,
      };
    }

    // Guardrail 3: Block UPGRADE during initialBuild phase
    if (context.isInitialBuild && planType === AIActionType.UpgradeTrain) {
      console.warn(`[Guardrail 3] Blocked UPGRADE during initialBuild phase`);
      return {
        plan: { type: AIActionType.PassTurn },
        overridden: true,
        reason: 'Blocked UPGRADE during initialBuild phase (not allowed)',
      };
    }

    // Guardrail 8: Movement budget enforcement (defense-in-depth)
    // For MultiAction plans, ensure total movement doesn't exceed speed limit.
    // This is a silent truncation — returns overridden: false.
    if (plan.type === 'MultiAction') {
      const moveIndices: number[] = [];
      let totalMovement = 0;
      for (let i = 0; i < plan.steps.length; i++) {
        if (plan.steps[i].type === AIActionType.MoveTrain) {
          moveIndices.push(i);
          totalMovement += (plan.steps[i] as TurnPlanMoveTrain).path.length - 1;
        }
      }

      if (totalMovement > context.speed) {
        let excess = totalMovement - context.speed;
        console.warn(
          `[Guardrail 8] Movement budget exceeded: ${totalMovement}mp > ${context.speed}mp limit. Truncating.`,
        );
        const newSteps = [...plan.steps];
        // Truncate from last MOVE backward
        for (let i = moveIndices.length - 1; i >= 0 && excess > 0; i--) {
          const idx = moveIndices[i];
          const movePlan = newSteps[idx] as TurnPlanMoveTrain;
          const currentMp = movePlan.path.length - 1;
          const reduction = Math.min(excess, currentMp);
          const newPathLength = movePlan.path.length - reduction;
          if (newPathLength > 1) {
            newSteps[idx] = { ...movePlan, path: movePlan.path.slice(0, newPathLength) };
          } else {
            newSteps.splice(idx, 1);
          }
          excess -= reduction;
        }
        return {
          plan: { ...plan, steps: newSteps },
          overridden: false,
        };
      }
    }

    // No guardrail fired — return plan unchanged
    return {
      plan,
      overridden: false,
    };
  }

  /**
   * Extract the primary action type from a MultiAction plan.
   * Returns the type of the first step, or PassTurn if empty.
   */
  private static primaryActionType(plan: TurnPlan): AIActionType | 'MultiAction' {
    if (plan.type !== 'MultiAction') return plan.type;
    if (plan.steps.length === 0) return AIActionType.PassTurn;
    // Check if any step is a DELIVER
    for (const step of plan.steps) {
      if (step.type === AIActionType.DeliverLoad) return AIActionType.DeliverLoad;
    }
    // Check if any step is a PICKUP
    for (const step of plan.steps) {
      if (step.type === AIActionType.PickupLoad) return AIActionType.PickupLoad;
    }
    return plan.steps[0].type;
  }

  /**
   * Pick the highest-payout delivery opportunity.
   */
  private static bestDelivery(context: GameContext) {
    return context.canDeliver.reduce((best, opp) =>
      opp.payout > best.payout ? opp : best,
    );
  }
}
