/**
 * BuildContext — Computes build-budget and build-eligibility context fields.
 *
 * Single responsibility: given the world snapshot and pre-computed network data,
 * determine whether the bot can build this turn and what the remaining budget is.
 *
 * JIRA-195: Extracted from ContextBuilder as part of Slice 1 decomposition.
 */

import {
  WorldSnapshot,
  BotMemoryState,
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { NetworkContextResult } from './NetworkContext';
import { UPGRADE_DELIVERY_THRESHOLD, UPGRADE_OPERATING_BUFFER } from './UpgradeGatingConstants';

/** Internal result type for BuildContext.compute() */
export interface BuildContextResult {
  /** Whether the bot can build track this turn */
  canBuild: boolean;
  /** Whether the bot can upgrade this turn */
  canUpgrade: boolean;
  /** Amount of build budget already spent this turn */
  turnBuildCost: number;
}

export class BuildContext {
  /**
   * Compute build eligibility for this turn.
   *
   * @param snapshot    Current game state.
   * @param memory      Bot memory (reserved for future JIT-build context).
   * @param network     Pre-built network context (for future use — unconnected city costs etc.)
   * @param gridPoints  Full hex grid (for future use — path cost estimation).
   */
  static compute(
    snapshot: WorldSnapshot,
    _memory: BotMemoryState | undefined,
    _network: NetworkContextResult,
    _gridPoints: [],
  ): BuildContextResult {
    // turnBuildCost is not yet on WorldSnapshot — will be added in BE-021.
    // Default to 0 since ContextBuilder runs at the start of the bot's turn.
    const turnBuildCost = (snapshot.bot as { turnBuildCost?: number }).turnBuildCost ?? 0;

    const canBuild = (20 - turnBuildCost) > 0 && snapshot.bot.money > 0;

    const canUpgrade = BuildContext.checkCanUpgrade(snapshot);

    return { canBuild, canUpgrade, turnBuildCost };
  }

  /**
   * Check whether the bot can afford and is eligible for a train upgrade.
   *
   * Three-condition gate (JIRA-207A):
   *   1. bot.money >= upgradeCost (can afford the upgrade)
   *   2. deliveriesCompleted >= UPGRADE_DELIVERY_THRESHOLD (proven delivery track record)
   *   3. bot.money - upgradeCost >= UPGRADE_OPERATING_BUFFER (retains operating reserve)
   *
   * The `deliveriesCompleted` field on `snapshot.bot` is populated by ContextBuilder
   * from BotMemoryState.deliveryCount before this function is called.
   */
  static checkCanUpgrade(snapshot: WorldSnapshot): boolean {
    if (snapshot.gameStatus === 'initialBuild') return false;

    const trainType = snapshot.bot.trainType as TrainType;
    const upgradeCost = BuildContext.getUpgradeCost(trainType);
    if (upgradeCost === null) return false;  // Superfreight or unknown — no upgrade available

    const deliveriesCompleted = snapshot.bot.deliveriesCompleted ?? 0;

    return (
      snapshot.bot.money >= upgradeCost &&
      deliveriesCompleted >= UPGRADE_DELIVERY_THRESHOLD &&
      snapshot.bot.money - upgradeCost >= UPGRADE_OPERATING_BUFFER
    );
  }

  /**
   * Returns the upgrade cost (ECU millions) for a given train type.
   * Returns null if no upgrade is available (Superfreight or unknown type).
   */
  private static getUpgradeCost(trainType: TrainType): number | null {
    switch (trainType) {
      case TrainType.Freight:
        return 20;
      case TrainType.FastFreight:
        return 5;   // crossgrade cost; full upgrade to Superfreight is 20M
      case TrainType.HeavyFreight:
        return 5;   // crossgrade cost; full upgrade to Superfreight is 20M
      case TrainType.Superfreight:
        return null;  // no further upgrade
      default:
        return null;
    }
  }
}
