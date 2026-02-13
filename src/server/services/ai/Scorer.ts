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
