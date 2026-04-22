/**
 * GuardrailEnforcer — Applies hard safety guardrails to LLM action plans.
 *
 * `checkPlan()` enforces hard rules on TurnPlan (checked in priority order):
 *   G1. Force DELIVER when canDeliver has opportunities (highest priority)
 *   Stuck. Force DiscardHand when no active route AND no deliverable load
 *   Broke-and-stuck. Force DiscardHand when bot is broke, has active route, and
 *       no demand is achievable on existing network (JIRA-177)
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
import {
  computeEffectivePathLength,
  isIntraCityEdge,
  getMajorCityLookup,
} from '../../../shared/services/majorCityGroups';

export class GuardrailEnforcer {
  /**
   * Enforce hard guardrails on a TurnPlan.
   *
   * Returns the plan unchanged if no guardrail fires. If a guardrail fires,
   * returns a corrected plan with `overridden: true` and a reason string.
   *
   * Guardrails (checked in priority order):
   *   G1: Force DELIVER when bot can deliver but LLM chose something else (highest priority)
   *   Stuck: Force DiscardHand when no active route AND no deliverable load (JIRA-68, JIRA-183)
   *   Broke-and-stuck: Force DiscardHand when broke, active route exists, and no demand is
   *       achievable on existing network (JIRA-177, JIRA-183)
   *   G3: Block UPGRADE during initialBuild phase
   *   G8: Movement budget enforcement (silent truncation)
   */
  static async checkPlan(
    plan: TurnPlan,
    context: GameContext,
    snapshot: WorldSnapshot,
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

    // Stuck (no route, no loads): force DiscardHand immediately when the bot has no active route
    // and no load on-train that can be delivered on-network. Nothing productive can happen — discard
    // for fresh cards. JIRA-68, JIRA-183: no noProgressTurns gate needed; state is deterministic.
    const hasDeliverableLoad = snapshot.bot.loads.length > 0 && context.demands.some(d => d.isLoadOnTrain && d.isDeliveryOnNetwork);
    if (!hasActiveRoute && !hasDeliverableLoad && planType !== AIActionType.DiscardHand) {
      console.warn(`[Guardrail Stuck] No active route and no deliverable load — forcing DiscardHand`);
      return {
        plan: { type: AIActionType.DiscardHand },
        overridden: true,
        reason: `Stuck: no active route and no deliverable load on network — forcing DiscardHand`,
      };
    }

    // Broke-and-stuck guardrail: force DiscardHand when bot is broke, has a stale active route
    // blocking the stuck detector, and no demand is achievable on the existing track network.
    // JIRA-177, JIRA-183: fires immediately on raw state — no noProgressTurns gate, no cap on
    // consecutive discards. A broke bot with unachievable demands gains nothing from waiting.
    const botIsBroke = snapshot.bot.money < 5;
    const hasAchievableDemand = context.demands.some(
      d => (d.isSupplyOnNetwork || d.isLoadOnTrain) && d.isDeliveryOnNetwork,
    );
    if (
      botIsBroke &&
      hasActiveRoute &&
      !hasAchievableDemand &&
      planType !== AIActionType.DiscardHand
    ) {
      console.warn(
        `[Guardrail Broke-Stuck] Broke ($${snapshot.bot.money}M) with active route and no achievable demand on network` +
        ` — forcing DiscardHand`,
      );
      return {
        plan: { type: AIActionType.DiscardHand },
        overridden: true,
        reason: `Broke-and-stuck: no achievable demand on existing network — forcing DiscardHand to draw playable cards`,
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
    // Uses effective mileposts — intra-city edges are free per game rules.
    // This is a silent truncation — returns overridden: false.
    if (plan.type === 'MultiAction') {
      const majorCityLookup = getMajorCityLookup();
      const moveIndices: number[] = [];
      let totalMovement = 0;
      for (let i = 0; i < plan.steps.length; i++) {
        if (plan.steps[i].type === AIActionType.MoveTrain) {
          moveIndices.push(i);
          totalMovement += computeEffectivePathLength(
            (plan.steps[i] as TurnPlanMoveTrain).path,
            majorCityLookup,
          );
        }
      }

      if (totalMovement > context.speed) {
        let excess = totalMovement - context.speed;
        console.warn(
          `[Guardrail 8] Movement budget exceeded: ${totalMovement}mp > ${context.speed}mp limit. Truncating.`,
        );
        const newSteps = [...plan.steps];
        // Truncate from last MOVE backward, skipping intra-city edges (they are free)
        for (let i = moveIndices.length - 1; i >= 0 && excess > 0; i--) {
          const idx = moveIndices[i];
          const movePlan = newSteps[idx] as TurnPlanMoveTrain;
          const path = movePlan.path;
          // Walk the path backwards to find how many raw edges to remove for `excess` effective mp
          let rawRemove = 0;
          let effectiveRemoved = 0;
          for (let j = path.length - 1; j >= 1 && effectiveRemoved < excess; j--) {
            const fromKey = `${path[j - 1].row},${path[j - 1].col}`;
            const toKey = `${path[j].row},${path[j].col}`;
            rawRemove++;
            if (!isIntraCityEdge(fromKey, toKey, majorCityLookup)) {
              effectiveRemoved++;
            }
          }
          const newPathLength = path.length - rawRemove;
          if (newPathLength > 1) {
            newSteps[idx] = { ...movePlan, path: path.slice(0, newPathLength) };
          } else {
            newSteps.splice(idx, 1);
          }
          excess -= effectiveRemoved;
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
