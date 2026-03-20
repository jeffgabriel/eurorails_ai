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

/**
 * Build Advisor service — asks the LLM for track building strategy (JIRA-129).
 * Static class — no instance state.
 */
export class BuildAdvisor {
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
    try {
      // 1. Determine target and frontier for map rendering
      const targetCity = BuildAdvisor.getTargetCoord(activeRoute, context, gridPoints);
      if (!targetCity) return null;

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

      // 5. Parse and validate
      const parsed = JSON.parse(response.text) as BuildAdvisorResult;
      const validated = BuildAdvisor.validateWaypoints(parsed, gridPoints);
      return validated;
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      const errorMsg = err instanceof Error ? err.message : String(err);
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
   * Validate waypoints — remove any [row, col] not in gridPoints.
   * If all invalid → return null (caller falls back).
   */
  private static validateWaypoints(
    result: BuildAdvisorResult,
    gridPoints: GridPoint[],
  ): BuildAdvisorResult | null {
    const validPoints = new Set<string>();
    for (const gp of gridPoints) {
      validPoints.add(`${gp.row},${gp.col}`);
    }

    const validWaypoints = result.waypoints.filter(
      ([row, col]) => validPoints.has(`${row},${col}`)
    );

    // If all waypoints invalid and action requires waypoints, return null
    if (validWaypoints.length === 0 && result.action !== 'useOpponentTrack' && result.action !== 'replan') {
      console.warn(`[BuildAdvisor] All waypoints invalid — attempted: ${JSON.stringify(result.waypoints)}, valid set size: ${validPoints.size}`);
      return null;
    }

    // Also validate alternativeBuild waypoints if present
    let alternativeBuild = result.alternativeBuild;
    if (alternativeBuild) {
      const validAltWaypoints = alternativeBuild.waypoints.filter(
        ([row, col]) => validPoints.has(`${row},${col}`)
      );
      alternativeBuild = { ...alternativeBuild, waypoints: validAltWaypoints };
    }

    return { ...result, waypoints: validWaypoints, alternativeBuild };
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
