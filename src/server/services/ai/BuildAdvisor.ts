import {
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  GridPoint,
  BuildAdvisorResult,
} from '../../../shared/types/GameTypes';
import { MapRenderer } from './MapRenderer';
import { getBuildAdvisorPrompt } from './prompts/systemPrompts';
import { BUILD_ADVISOR_SCHEMA } from './schemas';
import { LLMStrategyBrain } from './LLMStrategyBrain';

/** Diagnostic data from the last advise() or retryWithSolvencyFeedback() call. */
export interface BuildAdvisorDiagnostics {
  rawResponse?: string;
  rawWaypoints?: [number, number][];
  error?: string;
}

/**
 * Build Advisor service — asks the LLM for track building strategy (JIRA-129).
 * Static class — no instance state.
 */
export class BuildAdvisor {
  /** Diagnostics from the most recent advise/retry call. Read after each call. */
  static lastDiagnostics: BuildAdvisorDiagnostics = {};

  /**
   * Core advisor: render map, build prompt, call LLM, validate waypoints.
   *
   * @returns BuildAdvisorResult or null on LLM failure (caller falls back)
   */
  static async advise(
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute | null,
    gridPoints: GridPoint[],
    brain: LLMStrategyBrain,
  ): Promise<BuildAdvisorResult | null> {
    BuildAdvisor.lastDiagnostics = {};
    try {
      // 1. Determine target and frontier for map rendering
      const targetCity = BuildAdvisor.getTargetCoord(activeRoute, context, gridPoints);
      if (!targetCity) {
        BuildAdvisor.lastDiagnostics.error = 'no target city';
        return null;
      }

      const frontier = BuildAdvisor.getNetworkFrontier(snapshot, gridPoints);
      const opponentTracks = snapshot.allPlayerTracks
        .filter(pt => pt.playerId !== snapshot.bot.playerId)
        .map(pt => pt.segments);

      // 2. Render corridor map
      const corridorMap = MapRenderer.renderCorridor(
        snapshot.bot.existingSegments,
        opponentTracks,
        gridPoints,
        frontier,
        targetCity,
      );

      // 3. Build prompt
      const { system, user } = getBuildAdvisorPrompt(context, activeRoute, corridorMap);

      // 4. Call LLM with structured output
      const response = await brain.providerAdapter.chat({
        model: brain.modelName,
        maxTokens: 2048,
        temperature: 0,
        systemPrompt: system,
        userPrompt: user,
        outputSchema: BUILD_ADVISOR_SCHEMA,
        timeoutMs: 30000,
      });

      BuildAdvisor.lastDiagnostics.rawResponse = response.text.substring(0, 1000);

      // 5. Parse and validate
      let parsed: BuildAdvisorResult;
      try {
        parsed = JSON.parse(response.text) as BuildAdvisorResult;
      } catch (parseErr) {
        const msg = `JSON parse failed: ${(parseErr as Error).message}`;
        BuildAdvisor.lastDiagnostics.error = msg;
        console.warn(`[BuildAdvisor] ${msg}, raw: ${response.text.substring(0, 200)}`);
        return null;
      }
      BuildAdvisor.lastDiagnostics.rawWaypoints = parsed.waypoints ? [...parsed.waypoints] : [];
      const validated = BuildAdvisor.validateWaypoints(parsed, gridPoints);
      if (!validated) {
        BuildAdvisor.lastDiagnostics.error = `all waypoints unrecoverable: ${JSON.stringify(parsed.waypoints)}`;
        console.warn(`[BuildAdvisor] validateWaypoints returned null for action=${parsed.action}, target=${parsed.target}, waypoints=${JSON.stringify(parsed.waypoints)}`);
      }
      return validated;
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      const errorMsg = err instanceof Error ? err.message : String(err);
      BuildAdvisor.lastDiagnostics.error = `${errorType}: ${errorMsg}`;
      console.warn(`[BuildAdvisor] advise failed: ${errorType}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Second LLM call when solvency check fails.
   * Adds actual cost + budget to prompt so LLM can propose cheaper waypoints.
   *
   * @returns BuildAdvisorResult or null on failure
   */
  static async retryWithSolvencyFeedback(
    previousResult: BuildAdvisorResult,
    actualCost: number,
    availableCash: number,
    snapshot: WorldSnapshot,
    context: GameContext,
    activeRoute: StrategicRoute | null,
    gridPoints: GridPoint[],
    brain: LLMStrategyBrain,
  ): Promise<BuildAdvisorResult | null> {
    try {
      // 1. Render map (same as advise)
      const targetCity = BuildAdvisor.getTargetCoord(activeRoute, context, gridPoints);
      if (!targetCity) return null;

      const frontier = BuildAdvisor.getNetworkFrontier(snapshot, gridPoints);
      const opponentTracks = snapshot.allPlayerTracks
        .filter(pt => pt.playerId !== snapshot.bot.playerId)
        .map(pt => pt.segments);

      const corridorMap = MapRenderer.renderCorridor(
        snapshot.bot.existingSegments,
        opponentTracks,
        gridPoints,
        frontier,
        targetCity,
      );

      // 2. Build prompt with solvency feedback
      const { system, user } = getBuildAdvisorPrompt(context, activeRoute, corridorMap);
      const solvencyFeedback = `\n\nSOLVENCY FEEDBACK:
Your previous recommendation (${previousResult.action} toward ${previousResult.target}) costs ${actualCost}M ECU to build, but you only have ${availableCash}M available.
Please suggest a cheaper route with fewer/different waypoints, use opponent track, or propose an alternative target.`;

      const response = await brain.providerAdapter.chat({
        model: brain.modelName,
        maxTokens: 2048,
        temperature: 0,
        systemPrompt: system,
        userPrompt: user + solvencyFeedback,
        outputSchema: BUILD_ADVISOR_SCHEMA,
        timeoutMs: 30000,
      });

      const parsed = JSON.parse(response.text) as BuildAdvisorResult;
      return BuildAdvisor.validateWaypoints(parsed, gridPoints);
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[BuildAdvisor] retryWithSolvencyFeedback failed: ${errorType}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Snap a [row, col] to the nearest valid grid point within maxDistance.
   * Returns the snapped coordinate or null if nothing is close enough.
   */
  private static snapToNearest(
    row: number,
    col: number,
    validPoints: Map<string, [number, number]>,
    maxDistance: number = 2,
  ): [number, number] | null {
    const exactKey = `${row},${col}`;
    if (validPoints.has(exactKey)) return [row, col];

    let best: [number, number] | null = null;
    let bestDist = Infinity;
    for (let dr = -maxDistance; dr <= maxDistance; dr++) {
      for (let dc = -maxDistance; dc <= maxDistance; dc++) {
        if (dr === 0 && dc === 0) continue;
        const key = `${row + dr},${col + dc}`;
        const match = validPoints.get(key);
        if (match) {
          const dist = Math.abs(dr) + Math.abs(dc);
          if (dist < bestDist) {
            bestDist = dist;
            best = match;
          }
        }
      }
    }
    return best;
  }

  /**
   * Validate and snap waypoints — exact matches pass through, near-misses
   * are snapped to the closest valid grid point (max distance 2).
   * If all waypoints are unrecoverable → return null (caller falls back).
   */
  private static validateWaypoints(
    result: BuildAdvisorResult,
    gridPoints: GridPoint[],
  ): BuildAdvisorResult | null {
    const validPoints = new Map<string, [number, number]>();
    for (const gp of gridPoints) {
      validPoints.set(`${gp.row},${gp.col}`, [gp.row, gp.col]);
    }

    const snappedWaypoints: [number, number][] = [];
    for (const [row, col] of result.waypoints) {
      const snapped = BuildAdvisor.snapToNearest(row, col, validPoints);
      if (snapped) snappedWaypoints.push(snapped);
    }

    // If all waypoints unrecoverable and action requires waypoints, return null
    if (snappedWaypoints.length === 0 && result.action !== 'useOpponentTrack' && result.action !== 'replan') {
      console.warn(`[BuildAdvisor] All waypoints unrecoverable — attempted: ${JSON.stringify(result.waypoints)}, valid set size: ${validPoints.size}`);
      return null;
    }

    // Also snap alternativeBuild waypoints if present
    let alternativeBuild = result.alternativeBuild;
    if (alternativeBuild) {
      const snappedAlt: [number, number][] = [];
      for (const [row, col] of alternativeBuild.waypoints) {
        const snapped = BuildAdvisor.snapToNearest(row, col, validPoints);
        if (snapped) snappedAlt.push(snapped);
      }
      alternativeBuild = { ...alternativeBuild, waypoints: snappedAlt };
    }

    return { ...result, waypoints: snappedWaypoints, alternativeBuild };
  }

  /**
   * Get the target city coordinate from active route or unconnected major cities.
   */
  private static getTargetCoord(
    activeRoute: StrategicRoute | null,
    context: GameContext,
    gridPoints: GridPoint[],
  ): { row: number; col: number } | null {
    // Use current route stop's city if available
    let targetCityName: string | null = null;
    if (activeRoute && activeRoute.currentStopIndex < activeRoute.stops.length) {
      targetCityName = activeRoute.stops[activeRoute.currentStopIndex].city;
    } else if (context.unconnectedMajorCities.length > 0) {
      // Fall back to cheapest unconnected major city
      targetCityName = context.unconnectedMajorCities[0].cityName;
    }

    if (!targetCityName) return null;

    // Find grid coordinate for the city
    const cityPoint = gridPoints.find(gp => gp.city?.name === targetCityName);
    return cityPoint ? { row: cityPoint.row, col: cityPoint.col } : null;
  }

  /**
   * Get network frontier positions — endpoints of bot's track segments.
   */
  private static getNetworkFrontier(
    snapshot: WorldSnapshot,
    _gridPoints: GridPoint[],
  ): { row: number; col: number }[] {
    const positions = new Set<string>();
    const frontier: { row: number; col: number }[] = [];

    for (const seg of snapshot.bot.existingSegments) {
      const fromKey = `${seg.from.row},${seg.from.col}`;
      const toKey = `${seg.to.row},${seg.to.col}`;
      if (!positions.has(fromKey)) {
        positions.add(fromKey);
        frontier.push({ row: seg.from.row, col: seg.from.col });
      }
      if (!positions.has(toKey)) {
        positions.add(toKey);
        frontier.push({ row: seg.to.row, col: seg.to.col });
      }
    }

    // If no track, use bot position
    if (frontier.length === 0 && snapshot.bot.position) {
      frontier.push(snapshot.bot.position);
    }

    return frontier;
  }
}
