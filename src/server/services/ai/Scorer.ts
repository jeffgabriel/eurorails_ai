/**
 * Scorer — Ranks feasible options by strategic value for the AI bot.
 *
 * Applies a weighted scoring system considering terrain cost, segment count,
 * and bot archetype preferences. Returns options sorted highest score first.
 */

import {
  FeasibleOption,
  WorldSnapshot,
  BotConfig,
  BotArchetype,
  AIActionType,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { loadGridPoints } from './MapTopology';
import { DemandDeckService } from '../demandDeckService';

/** Base score for building track (encourages building over passing) */
const BUILD_BASE_SCORE = 10;

/** Bonus per new segment built */
const SEGMENT_BONUS = 3;

/** Bonus for reaching a named city */
const CITY_REACH_BONUS = 5;

/** Extra bonus for BuilderFirst archetype per segment */
const BUILDER_FIRST_SEGMENT_BONUS = 2;

/** PassTurn default score */
const PASS_TURN_SCORE = 0;

/** Base score for delivering a load (highest priority — immediate income) */
const DELIVER_BASE_SCORE = 100;

/** Multiplier for delivery payment in score */
const DELIVER_PAYMENT_FACTOR = 2;

/** Base score for picking up a load */
const PICKUP_BASE_SCORE = 50;

/** Multiplier for best matching demand payment when picking up */
const PICKUP_PAYMENT_FACTOR = 0.5;

/** Base score for moving train (higher than building to prefer delivery) */
const MOVE_BASE_SCORE = 15;

/** Bonus per ECU of demand payoff (scaled down) */
const PAYOFF_BONUS_FACTOR = 0.5;

/** Maximum distance score — closer destinations score higher */
const MOVE_DISTANCE_MAX_BONUS = 12;

export class Scorer {
  /**
   * Score and sort options by strategic value, highest first.
   * Only feasible options receive meaningful scores; infeasible options
   * get -Infinity so they sort to the bottom.
   */
  static score(
    options: FeasibleOption[],
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
  ): FeasibleOption[] {
    for (const option of options) {
      if (!option.feasible) {
        option.score = -Infinity;
        continue;
      }

      switch (option.action) {
        case AIActionType.BuildTrack:
          option.score = Scorer.calculateBuildTrackScore(option, snapshot, botConfig);
          break;
        case AIActionType.MoveTrain:
          option.score = Scorer.calculateMoveScore(option, snapshot);
          break;
        case AIActionType.DeliverLoad:
          option.score = Scorer.calculateDeliveryScore(option);
          break;
        case AIActionType.PickupLoad:
          option.score = Scorer.calculatePickupScore(option, snapshot);
          break;
        case AIActionType.PassTurn:
          option.score = Scorer.calculatePassTurnScore();
          break;
        default:
          option.score = 0;
      }
    }

    return options.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private static calculateBuildTrackScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
  ): number {
    let score = BUILD_BASE_SCORE;

    // Reward building more segments
    const segmentCount = option.segments?.length ?? 0;
    score += segmentCount * SEGMENT_BONUS;

    // Penalize cost (lower cost = higher score)
    score -= (option.estimatedCost ?? 0);

    // Bonus for reaching a named city
    if (option.targetCity) {
      score += CITY_REACH_BONUS;
    }

    // Archetype-specific adjustments
    if (botConfig?.archetype === BotArchetype.BuilderFirst) {
      // BuilderFirst bots get extra value from building more track
      score += segmentCount * BUILDER_FIRST_SEGMENT_BONUS;
    }

    // Demand proximity bonus: check if any segment endpoint is near a demand city
    score += Scorer.demandProximityBonus(option, snapshot);

    return score;
  }

  /**
   * Score a MoveTrain option based on distance to target, demand payoff, and track usage fees.
   * Closer destinations with higher payoffs and lower fees score higher.
   */
  private static calculateMoveScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    let score = MOVE_BASE_SCORE;

    const mileposts = option.mileposts ?? 0;
    const speed = 12; // max possible speed for normalization

    // Distance bonus: inversely proportional to remaining distance
    // If path reaches the target city, mileposts is the full distance — shorter = better
    if (mileposts > 0) {
      score += MOVE_DISTANCE_MAX_BONUS * (1 - (mileposts - 1) / speed);
    }

    // Payoff bonus: prioritize cities where we can actually deliver
    if (option.targetCity) {
      const demandDeck = DemandDeckService.getInstance();
      let bestDeliverablePayoff = 0;  // bot HAS the matching load
      let bestGeneralPayoff = 0;       // demand exists but bot doesn't have load

      for (const cardId of snapshot.bot.demandCards) {
        const card = demandDeck.getCard(cardId);
        if (!card) continue;
        for (const demand of card.demands) {
          if (demand.city !== option.targetCity) continue;
          if (snapshot.bot.loads.includes(demand.resource)) {
            if (demand.payment > bestDeliverablePayoff) bestDeliverablePayoff = demand.payment;
          } else {
            if (demand.payment > bestGeneralPayoff) bestGeneralPayoff = demand.payment;
          }
        }
      }

      if (bestDeliverablePayoff > 0) {
        // Bot can deliver here — strong bonus
        score += bestDeliverablePayoff * PAYOFF_BONUS_FACTOR + 15;
      } else if (bestGeneralPayoff > 0) {
        // Demand exists but bot can't deliver — weak bonus
        score += bestGeneralPayoff * 0.1;
      }
    }

    // Penalty: track usage fees
    score -= (option.estimatedCost ?? 0);

    return score;
  }

  /**
   * Score a DeliverLoad option. Delivery is the highest-priority action since
   * it produces immediate income. Base 100 + payment * 2.
   */
  private static calculateDeliveryScore(option: FeasibleOption): number {
    const payment = option.payment ?? 0;
    return DELIVER_BASE_SCORE + payment * DELIVER_PAYMENT_FACTOR;
  }

  /**
   * Score a PickupLoad option. Base 50 + best matching demand payment * 0.5.
   * Pickups with a matching demand are worth more than speculative pickups.
   */
  private static calculatePickupScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    let score = PICKUP_BASE_SCORE;

    // If the option already has a payment (from demand matching in OptionGenerator),
    // use it directly.
    if (option.payment && option.payment > 0) {
      score += option.payment * PICKUP_PAYMENT_FACTOR;
    } else {
      // Speculative pickup — find the best matching demand for this load type
      let bestPayment = 0;
      if (option.loadType) {
        for (const rd of snapshot.bot.resolvedDemands) {
          for (const demand of rd.demands) {
            if (demand.loadType === option.loadType && demand.payment > bestPayment) {
              bestPayment = demand.payment;
            }
          }
        }
      }
      score += bestPayment * PICKUP_PAYMENT_FACTOR;
    }

    return score;
  }

  private static calculatePassTurnScore(): number {
    return PASS_TURN_SCORE;
  }

  /**
   * Award bonus points if segments build toward cities that match demand cards.
   * Uses the grid point names to check against demand card city targets.
   */
  private static demandProximityBonus(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    if (!option.segments || option.segments.length === 0) return 0;
    if (snapshot.bot.demandCards.length === 0) return 0;

    const grid = loadGridPoints();
    let bonus = 0;

    // Check if any segment endpoint is a named location
    for (const seg of option.segments) {
      const toPoint = grid.get(`${seg.to.row},${seg.to.col}`);
      if (toPoint?.name) {
        // Any named location on the path is slightly valuable
        bonus += 1;
      }
    }

    return bonus;
  }
}
