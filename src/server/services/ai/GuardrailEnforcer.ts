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
  TurnPlanDropLoad,
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
   *   5. Drop undeliverable loads: If carrying loads with no demand match or unreachable delivery
   *   4. No passing with loads: If bot has loads, do something productive (re-evaluates after G5)
   *   6. Stuck turn escape hatch: Force PassTurn after 5 consecutive stuck turns
   */
  static checkPlan(
    plan: TurnPlan,
    context: GameContext,
    snapshot: WorldSnapshot,
    consecutivePassTurns: number = 0,
  ): GuardrailPlanResult {
    const planType = plan.type === 'MultiAction' ? GuardrailEnforcer.primaryActionType(plan) : plan.type;

    // Guardrail 6: Stuck turn escape hatch — must be checked FIRST
    // After 5 consecutive stuck turns, allow PassTurn regardless of load state.
    // This prevents infinite loops when all other guardrails fail.
    if (consecutivePassTurns >= 5) {
      console.warn(`[Guardrail 6] Escape hatch: ${consecutivePassTurns} consecutive stuck turns — forcing PassTurn`);
      return {
        plan: { type: AIActionType.PassTurn },
        overridden: true,
        reason: `Escape hatch: ${consecutivePassTurns} consecutive stuck turns — forcing PassTurn to break deadlock`,
      };
    }

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

    // Guardrail 5: Drop undeliverable loads
    // If the bot is carrying loads with no matching demand or unreachable delivery,
    // override to drop them. This must fire BEFORE Guardrail 4 to prevent deadlock.
    const undeliverableDrops = GuardrailEnforcer.checkForUndeliverableLoads(context, snapshot);
    if (undeliverableDrops.length > 0) {
      for (const drop of undeliverableDrops) {
        console.warn(`[Guardrail 5] Dropping undeliverable load: ${drop.load} at ${drop.city} — no feasible delivery`);
      }
      if (undeliverableDrops.length === 1) {
        return {
          plan: undeliverableDrops[0],
          overridden: true,
          reason: `Dropping undeliverable load: ${undeliverableDrops[0].load} (no matching demand or delivery unreachable)`,
        };
      }
      return {
        plan: {
          type: 'MultiAction' as const,
          steps: undeliverableDrops,
        },
        overridden: true,
        reason: `Dropping ${undeliverableDrops.length} undeliverable loads: [${undeliverableDrops.map(d => d.load).join(', ')}]`,
      };
    }

    // Guardrail 4: No passing while carrying loads
    // Re-evaluates after Guardrail 5: if G5 dropped all loads, this won't fire.
    // If bot still has deliverable loads, it should do something productive.
    if (planType === AIActionType.PassTurn && context.loads.length > 0) {
      // Try to move toward highest-payout delivery city on network
      const sorted = [...context.demands].sort((a, b) => b.payout - a.payout);
      for (const demand of sorted) {
        if (demand.isLoadOnTrain && demand.isDeliveryOnNetwork) {
          return {
            plan: {
              type: AIActionType.MoveTrain,
              path: [],
              fees: new Set<string>(),
              totalFee: 0,
            },
            overridden: true,
            reason: `Blocked PASS with loads: overriding to MOVE toward ${demand.deliveryCity} for ${demand.payout}M delivery`,
          };
        }
      }
      // Fallback: move toward any supply city on network
      for (const demand of sorted) {
        if (!demand.isLoadOnTrain && demand.isSupplyOnNetwork) {
          return {
            plan: {
              type: AIActionType.MoveTrain,
              path: [],
              fees: new Set<string>(),
              totalFee: 0,
            },
            overridden: true,
            reason: `Blocked PASS with loads: overriding to MOVE toward ${demand.supplyCity} to pick up ${demand.loadType}`,
          };
        }
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

  /**
   * Pick the highest-payout pickup opportunity.
   */
  private static bestPickup(context: GameContext) {
    return context.canPickup.reduce((best, opp) =>
      opp.bestPayout > best.bestPayout ? opp : best,
    );
  }

  /**
   * Detect loads on the bot that cannot be delivered.
   *
   * A load is undeliverable if:
   * - No demand card matches the load type, OR
   * - All matching demand cards have unreachable delivery cities AND
   *   building to those cities costs more than the bot's money
   *
   * Returns DropLoadPlan[] for each undeliverable load.
   */
  static checkForUndeliverableLoads(
    context: GameContext,
    snapshot: WorldSnapshot,
  ): TurnPlanDropLoad[] {
    const drops: TurnPlanDropLoad[] = [];
    const cityName = context.position?.city ?? '';

    // Can only drop at a city
    if (!cityName) return drops;

    for (const load of context.loads) {
      // Find all demand entries for this load type that indicate it's on the train
      const matchingDemands = context.demands.filter(
        d => d.loadType === load && d.isLoadOnTrain,
      );

      // No demand card matches this load at all
      if (matchingDemands.length === 0) {
        drops.push({
          type: AIActionType.DropLoad,
          load,
          city: cityName,
        });
        continue;
      }

      // Check if ANY matching demand has a feasible delivery
      const hasFeasibleDelivery = matchingDemands.some(
        d => d.isDeliveryOnNetwork || d.estimatedTrackCostToDelivery <= snapshot.bot.money,
      );

      if (!hasFeasibleDelivery) {
        drops.push({
          type: AIActionType.DropLoad,
          load,
          city: cityName,
        });
      }
    }

    return drops;
  }
}
