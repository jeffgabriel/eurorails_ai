/**
 * GuardrailEnforcer — Applies hard safety guardrails to LLM action plans.
 *
 * `checkPlan()` enforces hard rules on TurnPlan:
 *   1. Force DELIVER when canDeliver has opportunities
 *   2. Force PICKUP when canPickup has opportunities and LLM chose BUILD/PASS
 *   3. Block UPGRADE during initialBuild phase
 *
 * These are NOT strategic overrides — they enforce game rules and mathematical
 * feasibility the LLM must not violate. Strategic decisions remain the LLM's.
 */

import {
  WorldSnapshot,
  GuardrailPlanResult,
  TurnPlan,
  GameContext,
  AIActionType,
} from '../../../shared/types/GameTypes';

export class GuardrailEnforcer {
  /**
   * Enforce hard guardrails on a TurnPlan (v6.3 pipeline).
   *
   * Returns the plan unchanged if no guardrail fires. If a guardrail fires,
   * returns a corrected plan with `overridden: true` and a reason string.
   *
   * Guardrails (checked in priority order):
   *   1. Force DELIVER: If bot can deliver right now and LLM chose something else
   *   2. Force PICKUP: If bot can pick up a demand-matching load and LLM chose BUILD/PASS
   *   3. Block UPGRADE during initialBuild: Upgrade is illegal during initial build phase
   */
  static checkPlan(
    plan: TurnPlan,
    context: GameContext,
    _snapshot: WorldSnapshot,
  ): GuardrailPlanResult {
    const planType = plan.type === 'MultiAction' ? GuardrailEnforcer.primaryActionType(plan) : plan.type;

    // Guardrail 1: Force DELIVER when canDeliver has opportunities
    // If the bot is sitting on a completable delivery and the LLM didn't choose DELIVER
    if (context.canDeliver.length > 0 && planType !== AIActionType.DeliverLoad) {
      const best = GuardrailEnforcer.bestDelivery(context);
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

    // Guardrail 2: Force PICKUP when bot is at a supply city with matching demand
    // and the LLM chose BUILD or PASS instead of picking up the load.
    // This prevents the bot from building more track when it should be loading cargo.
    if (
      context.canPickup.length > 0 &&
      planType !== AIActionType.PickupLoad &&
      planType !== AIActionType.MoveTrain &&
      planType !== AIActionType.DeliverLoad &&
      planType !== AIActionType.DiscardHand
    ) {
      const best = GuardrailEnforcer.bestPickup(context);
      // If the LLM chose BUILD, convert to PICKUP + BUILD multi-action
      if (planType === AIActionType.BuildTrack) {
        return {
          plan: {
            type: 'MultiAction',
            steps: [
              {
                type: AIActionType.PickupLoad,
                load: best.loadType,
                city: best.supplyCity,
              },
              plan, // Keep the original BUILD plan as second step
            ],
          },
          overridden: true,
          reason: `Injected PICKUP before BUILD: ${best.loadType} at ${best.supplyCity} → ${best.bestDeliveryCity} for ${best.bestPayout}M`,
        };
      }
      // For PASS or other actions, just force PICKUP
      return {
        plan: {
          type: AIActionType.PickupLoad,
          load: best.loadType,
          city: best.supplyCity,
        },
        overridden: true,
        reason: `Forced PICKUP: ${best.loadType} at ${best.supplyCity} → ${best.bestDeliveryCity} for ${best.bestPayout}M (LLM chose ${planType})`,
      };
    }

    // Guardrail 3: Block UPGRADE during initialBuild phase
    if (context.isInitialBuild && planType === AIActionType.UpgradeTrain) {
      return {
        plan: { type: AIActionType.PassTurn },
        overridden: true,
        reason: 'Blocked UPGRADE during initialBuild phase (not allowed)',
      };
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

  /**
   * Pick the highest-payout pickup opportunity.
   */
  private static bestPickup(context: GameContext) {
    return context.canPickup.reduce((best, opp) =>
      opp.bestPayout > best.bestPayout ? opp : best,
    );
  }
}
