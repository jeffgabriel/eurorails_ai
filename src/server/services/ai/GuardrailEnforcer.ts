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
  TurnPlanMoveTrain,
  GameContext,
  AIActionType,
} from '../../../shared/types/GameTypes';
import { ActionResolver } from './ActionResolver';

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
   *   7. Strategic hand discard: Force DiscardHand after 3 consecutive stuck turns
   *   6. Stuck turn escape hatch: Force PassTurn after 5 consecutive stuck turns
   */
  static async checkPlan(
    plan: TurnPlan,
    context: GameContext,
    snapshot: WorldSnapshot,
    consecutivePassTurns: number = 0,
  ): Promise<GuardrailPlanResult> {
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

    // Guardrail 7: Strategic hand discard — force DiscardHand after 3+ consecutive stuck turns
    // If the bot has made zero progress for 3 turns and hasn't already chosen to discard,
    // override to DiscardHand to get fresh demand cards.
    if (consecutivePassTurns >= 3 && planType !== AIActionType.DiscardHand) {
      console.warn(`[Guardrail 7] Strategic discard: ${consecutivePassTurns} consecutive stuck turns — forcing DiscardHand`);
      return {
        plan: { type: AIActionType.DiscardHand },
        overridden: true,
        reason: `Strategic hand discard: ${consecutivePassTurns} consecutive stuck turns — discarding hand for fresh demand cards`,
      };
    }

    // Guardrail 1: Force DELIVER when canDeliver has opportunities
    // If the bot is sitting on a completable delivery and the LLM didn't choose DELIVER
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
      const pickups = GuardrailEnforcer.bestPickups(context, snapshot);
      if (pickups.length === 0) {
        // Capacity full — let the original plan proceed
      } else {
        const pickupPlans = pickups.map(p => ({
          type: AIActionType.PickupLoad as const,
          load: p.loadType,
          city: p.supplyCity,
        }));
        const pickupDesc = pickups.map(p => `${p.loadType} at ${p.supplyCity}`).join(', ');
        console.warn(`[Guardrail 2] Forcing PICKUP(s): ${pickupDesc} (LLM chose ${planType})`);
        // If the LLM chose BUILD, convert to PICKUP(s) + BUILD multi-action
        if (planType === AIActionType.BuildTrack) {
          return {
            plan: {
              type: 'MultiAction' as const,
              steps: [
                ...pickupPlans,
                plan, // Keep the original BUILD plan as last step
              ],
            },
            overridden: true,
            reason: `Injected PICKUP(s) before BUILD: ${pickupDesc}`,
          };
        }
        // For PASS or other actions: single pickup → force PICKUP, multiple → MultiAction
        if (pickupPlans.length === 1) {
          return {
            plan: pickupPlans[0],
            overridden: true,
            reason: `Forced PICKUP: ${pickupDesc} (LLM chose ${planType})`,
          };
        }
        return {
          plan: {
            type: 'MultiAction' as const,
            steps: pickupPlans,
          },
          overridden: true,
          reason: `Forced PICKUP(s): ${pickupDesc} (LLM chose ${planType})`,
        };
      }
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

    // Guardrail 4: No passing while carrying loads (BE-008: real path computation)
    // Re-evaluates after Guardrail 5: if G5 dropped all loads, this won't fire.
    // If bot still has deliverable loads, it should do something productive.
    if (planType === AIActionType.PassTurn && context.loads.length > 0) {
      console.warn(`[Guardrail 4] Blocked PASS with ${context.loads.length} load(s): [${context.loads.join(', ')}]`);
      // Try to move toward highest-payout delivery city on network
      const sorted = [...context.demands].sort((a, b) => b.payout - a.payout);
      for (const demand of sorted) {
        if (demand.isLoadOnTrain && demand.isDeliveryOnNetwork) {
          const moveResult = await ActionResolver.resolveMove(
            { to: demand.deliveryCity },
            snapshot,
          );
          if (moveResult.success && moveResult.plan) {
            return {
              plan: moveResult.plan,
              overridden: true,
              reason: `Blocked PASS with loads: overriding to MOVE toward ${demand.deliveryCity} for ${demand.payout}M delivery`,
            };
          }
          console.warn(`[Guardrail 4] Skipping ${demand.deliveryCity}: ${moveResult.error}`);
        }
      }
      // Fallback: move toward any supply city on network
      for (const demand of sorted) {
        if (!demand.isLoadOnTrain && demand.isSupplyOnNetwork) {
          const moveResult = await ActionResolver.resolveMove(
            { to: demand.supplyCity },
            snapshot,
          );
          if (moveResult.success && moveResult.plan) {
            return {
              plan: moveResult.plan,
              overridden: true,
              reason: `Blocked PASS with loads: overriding to MOVE toward ${demand.supplyCity} to pick up ${demand.loadType}`,
            };
          }
          console.warn(`[Guardrail 4] Skipping ${demand.supplyCity}: ${moveResult.error}`);
        }
      }
      // All targets failed path computation — allow PassTurn to proceed (BE-008)
      console.warn(`[Guardrail 4] No feasible movement path found — allowing PassTurn`);
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

  /**
   * Pick the highest-payout pickup opportunities, up to remaining cargo capacity.
   * Returns a sorted array (highest payout first), limited by what the bot can carry.
   *
   * Filters out pickups where no matching demand has a feasible delivery route,
   * preventing the G2→G5 loop (pickup forced by G2, then immediately dropped by G5).
   */
  private static bestPickups(context: GameContext, snapshot: WorldSnapshot): typeof context.canPickup {
    const remainingCapacity = context.capacity - context.loads.length;
    if (remainingCapacity <= 0) return [];

    // Filter to only pickups with at least one feasible delivery demand
    const deliverablePickups = context.canPickup.filter(pickup => {
      const matchingDemands = context.demands.filter(
        d => d.loadType === pickup.loadType && !d.isLoadOnTrain,
      );
      if (matchingDemands.length === 0) return false;
      return matchingDemands.some(
        d => d.isDeliveryOnNetwork || d.estimatedTrackCostToDelivery <= snapshot.bot.money,
      );
    });

    return [...deliverablePickups]
      .sort((a, b) => b.bestPayout - a.bestPayout)
      .slice(0, remainingCapacity);
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
