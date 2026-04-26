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

  /** Check whether the bot can afford and is eligible for a train upgrade. */
  static checkCanUpgrade(snapshot: WorldSnapshot): boolean {
    if (snapshot.gameStatus === 'initialBuild') return false;
    if (snapshot.bot.money < 5) return false;

    const trainType = snapshot.bot.trainType as TrainType;
    switch (trainType) {
      case TrainType.Freight:
        return snapshot.bot.money >= 20;
      case TrainType.FastFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.HeavyFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.Superfreight:
        return false;
      default:
        return false;
    }
  }
}
