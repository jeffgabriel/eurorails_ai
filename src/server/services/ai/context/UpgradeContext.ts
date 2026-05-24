/**
 * UpgradeContext — Computes upgrade advisability for the bot's current loco.
 *
 * Single responsibility: given the current world state and delivery context,
 * determine whether the bot should upgrade (or crossgrade) its train and
 * produce an advisory string for the LLM prompt.
 *
 * Returns the same `string | undefined` shape as the legacy
 * `ContextBuilder.computeUpgradeAdvice()` — the facade re-uses this directly.
 *
 * JIRA-195: Extracted from ContextBuilder as part of Slice 1 decomposition.
 */

import {
  WorldSnapshot,
  DemandContext,
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../../shared/types/GameTypes';
import { MIN_DELIVERIES_BEFORE_UPGRADE } from '../AIStrategyEngine';

export class UpgradeContext {
  /**
   * Compute upgrade advice for the bot's current train.
   *
   * @param snapshot    Current game state.
   * @param demands     Computed demand contexts (for ROI estimates).
   * @param canBuild    Whether the bot can afford to build this turn.
   * @param deliveryCount  Total deliveries completed; advice is suppressed below
   *                       MIN_DELIVERIES_BEFORE_UPGRADE to prevent acting on advice
   *                       the upgrade gate will block anyway (JIRA-161).
   * @returns Advisory string for the LLM prompt, or undefined if no advice applies.
   */
  static compute(
    snapshot: WorldSnapshot,
    demands: DemandContext[],
    canBuild: boolean,
    deliveryCount: number = 0,
  ): string | undefined {
    if (snapshot.gameStatus === 'initialBuild') return undefined;
    // JIRA-161: Suppress advice when below the upgrade gate threshold.
    if (deliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) return undefined;

    const trainType = snapshot.bot.trainType as TrainType;
    const money = snapshot.bot.money;
    const turn = snapshot.turnNumber;

    if (trainType === TrainType.Superfreight) return undefined;

    const parts: string[] = [];

    // ROI data: compute avg route length and whether meaningful build exists
    const avgRouteLength = demands.length > 0
      ? Math.round(
          demands.reduce((sum, d) => sum + d.estimatedTurns * TRAIN_PROPERTIES[TrainType.Freight].speed, 0) / demands.length,
        )
      : 0;
    const maxBuildCost = Math.max(0, ...demands.map(d => d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery));
    const remainingBuildBudget = Math.min(20, money);
    const hasMeaningfulBuild = canBuild && maxBuildCost > 5 && remainingBuildBudget >= 5;

    if (trainType === TrainType.Freight) {
      if (turn >= 15 && money >= 20) {
        parts.push(`URGENT: Still on Freight at turn ${turn}. Upgrade NOW — every turn without Fast Freight or Heavy Freight costs you efficiency.`);
      } else if (turn >= 10 && money >= 20) {
        parts.push(`WARNING: Still on basic Freight at turn ${turn}. No one wins this game on Freight — upgrade to Fast Freight or Heavy Freight NOW.`);
      }
      if (money >= 20) {
        parts.push('Fast Freight (20M): +3 speed saves ~1 turn per delivery — almost always the best first upgrade. Heavy Freight (20M): +1 cargo slot for corridor deliveries.');
      }
      if (avgRouteLength > 15 && money >= 20) {
        parts.push(`Avg route ~${avgRouteLength} mileposts — Fast Freight saves ~1 turn per delivery at this distance.`);
      }
      if (!hasMeaningfulBuild && money >= 20) {
        parts.push('No route-critical build target this turn — upgrade is better value than building.');
      }
    } else if (trainType === TrainType.FastFreight || trainType === TrainType.HeavyFreight) {
      if (money >= 20) {
        parts.push(`Superfreight available (20M): 12 speed + 3 cargo. The endgame train — upgrade when no high-value build target exists.`);
      }
      if (money >= 5 && money < 20) {
        const other = trainType === TrainType.FastFreight ? 'Heavy Freight (3 cargo)' : 'Fast Freight (12 speed)';
        parts.push(`Crossgrade to ${other} for only 5M (and still build up to 15M this turn).`);
      }
      if (!hasMeaningfulBuild && money >= 20) {
        parts.push('No route-critical build target — consider Superfreight upgrade.');
      }
    }

    return parts.length > 0 ? parts.join(' ') : undefined;
  }
}
