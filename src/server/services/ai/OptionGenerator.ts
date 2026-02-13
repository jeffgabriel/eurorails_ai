/**
 * OptionGenerator — Produces feasible action options for the AI bot.
 *
 * Given a WorldSnapshot, generates BuildTrack and PassTurn options
 * for the Scorer to evaluate.
 */

import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  TrackSegment,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { computeBuildSegments } from './computeBuildSegments';
import { loadGridPoints, GridCoord } from './MapTopology';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';

const TURN_BUILD_BUDGET = 20; // ECU 20M per turn

function makeFeasible(
  action: AIActionType,
  reason: string,
  extra?: Partial<FeasibleOption>,
): FeasibleOption {
  return { action, feasible: true, reason, ...extra };
}

function makeInfeasible(
  action: AIActionType,
  reason: string,
): FeasibleOption {
  return { action, feasible: false, reason };
}

export class OptionGenerator {
  /**
   * Generate all feasible options for this bot's turn.
   * During initialBuild phase, only BuildTrack and PassTurn are offered.
   */
  static generate(snapshot: WorldSnapshot): FeasibleOption[] {
    const options: FeasibleOption[] = [];

    // BuildTrack options
    const buildOptions = OptionGenerator.generateBuildTrackOptions(snapshot);
    options.push(...buildOptions);

    // PassTurn is always available
    options.push(OptionGenerator.generatePassTurnOption());

    return options;
  }

  private static generateBuildTrackOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    const budget = Math.min(TURN_BUILD_BUDGET, snapshot.bot.money);
    if (budget <= 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No money to build')];
    }

    const startPositions = OptionGenerator.determineStartPositions(snapshot);
    if (startPositions.length === 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No valid start positions')];
    }

    const segments = computeBuildSegments(
      startPositions,
      snapshot.bot.existingSegments,
      budget,
    );

    if (segments.length === 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No buildable segments found')];
    }

    const totalCost = segments.reduce((sum, s) => sum + s.cost, 0);
    const targetCity = OptionGenerator.identifyTargetCity(segments);

    return [
      makeFeasible(AIActionType.BuildTrack, 'Build track segments', {
        segments,
        estimatedCost: totalCost,
        targetCity: targetCity ?? undefined,
      }),
    ];
  }

  private static generatePassTurnOption(): FeasibleOption {
    return makeFeasible(AIActionType.PassTurn, 'Always an option');
  }

  /**
   * Determine where the bot can start building from.
   * - If bot has existing track, use all unique positions from those segments.
   * - If no track, use major city center positions.
   */
  private static determineStartPositions(snapshot: WorldSnapshot): GridCoord[] {
    if (snapshot.bot.existingSegments.length > 0) {
      // Extract unique positions from existing track
      const seen = new Set<string>();
      const positions: GridCoord[] = [];
      for (const seg of snapshot.bot.existingSegments) {
        for (const end of [seg.from, seg.to]) {
          const key = `${end.row},${end.col}`;
          if (!seen.has(key)) {
            seen.add(key);
            positions.push({ row: end.row, col: end.col });
          }
        }
      }
      return positions;
    }

    // No track yet — start from major city positions
    const groups = getMajorCityGroups();
    return groups.map((g) => g.center);
  }

  /**
   * Check if any segment endpoint is a named city.
   */
  private static identifyTargetCity(segments: TrackSegment[]): string | null {
    const grid = loadGridPoints();
    // Check the last segment's destination first (most likely the target)
    for (let i = segments.length - 1; i >= 0; i--) {
      const to = segments[i].to;
      const point = grid.get(`${to.row},${to.col}`);
      if (point?.name) return point.name;
    }
    return null;
  }
}
