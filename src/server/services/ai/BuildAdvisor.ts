import {
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  GridPoint,
  BuildAdvisorResult,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { MapRenderer } from './MapRenderer';
import { getBuildAdvisorPrompt, getBuildAdvisorExtractionPrompt } from './prompts/systemPrompts';
import { BUILD_ADVISOR_SCHEMA } from './schemas';
import { LLMStrategyBrain } from './LLMStrategyBrain';

/** Diagnostic data from the last advise() or retryWithSolvencyFeedback() call. */
export interface BuildAdvisorDiagnostics {
  systemPrompt?: string;
  userPrompt?: string;
  rawResponse?: string;
  rawWaypoints?: [number, number][];
  error?: string;
  extractionUsed?: boolean;
  extractionLatencyMs?: number;
  extractionError?: string;
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

      const frontier = BuildAdvisor.getNetworkFrontier(snapshot, gridPoints, activeRoute);
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
      BuildAdvisor.lastDiagnostics.systemPrompt = system;
      BuildAdvisor.lastDiagnostics.userPrompt = user;

      // 4. Call LLM with structured output
      brain.providerAdapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, turn: snapshot.turnNumber, caller: 'build-advisor', method: 'adviseBuild' });
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
        console.warn(`[BuildAdvisor] ${msg}, raw: ${response.text.substring(0, 200)}`);
        // Two-pass extraction fallback: ask the same model to extract structured data from prose
        const extracted = await BuildAdvisor.extractFromProse(
          response.text, targetCity, frontier, brain, gridPoints, snapshot,
        );
        if (extracted) return extracted;
        BuildAdvisor.lastDiagnostics.error = msg;
        return null;
      }
      // JIRA-148: Validate LLM target matches computed target — override on mismatch
      if (parsed.target && targetCity.cityName &&
          parsed.target.toLowerCase() !== targetCity.cityName.toLowerCase()) {
        console.warn(`[BuildAdvisor] Target mismatch: LLM returned "${parsed.target}" but computed target is "${targetCity.cityName}" — overriding`);
        parsed.target = targetCity.cityName;
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
    BuildAdvisor.lastDiagnostics = {};
    try {
      // 1. Render map (same as advise)
      const targetCity = BuildAdvisor.getTargetCoord(activeRoute, context, gridPoints);
      if (!targetCity) return null;

      const frontier = BuildAdvisor.getNetworkFrontier(snapshot, gridPoints, activeRoute);
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
      const fullUserPrompt = user + solvencyFeedback;
      BuildAdvisor.lastDiagnostics.systemPrompt = system;
      BuildAdvisor.lastDiagnostics.userPrompt = fullUserPrompt;

      brain.providerAdapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, turn: snapshot.turnNumber, caller: 'build-advisor', method: 'adviseBuildInitial' });
      const response = await brain.providerAdapter.chat({
        model: brain.modelName,
        maxTokens: 2048,
        temperature: 0,
        systemPrompt: system,
        userPrompt: fullUserPrompt,
        outputSchema: BUILD_ADVISOR_SCHEMA,
        timeoutMs: 30000,
      });

      BuildAdvisor.lastDiagnostics.rawResponse = response.text.substring(0, 1000);

      let parsed: BuildAdvisorResult;
      try {
        parsed = JSON.parse(response.text) as BuildAdvisorResult;
      } catch (parseErr) {
        const msg = `JSON parse failed: ${(parseErr as Error).message}`;
        console.warn(`[BuildAdvisor] retryWithSolvencyFeedback ${msg}, raw: ${response.text.substring(0, 200)}`);
        const extracted = await BuildAdvisor.extractFromProse(
          response.text, targetCity, frontier, brain, gridPoints, snapshot,
        );
        if (extracted) return extracted;
        BuildAdvisor.lastDiagnostics.error = msg;
        return null;
      }
      return BuildAdvisor.validateWaypoints(parsed, gridPoints);
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      const errorMsg = err instanceof Error ? err.message : String(err);
      BuildAdvisor.lastDiagnostics.error = `${errorType}: ${errorMsg}`;
      console.warn(`[BuildAdvisor] retryWithSolvencyFeedback failed: ${errorType}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Two-pass extraction: on JSON parse failure, call the same model with
   * thinking=false and structured output enforced to extract waypoints from prose.
   */
  private static async extractFromProse(
    rawText: string,
    targetCity: { row: number; col: number },
    frontier: { row: number; col: number }[],
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
    snapshot: WorldSnapshot,
  ): Promise<BuildAdvisorResult | null> {
    const extractionStart = Date.now();
    BuildAdvisor.lastDiagnostics.extractionUsed = true;
    try {
      const { system, user } = getBuildAdvisorExtractionPrompt(
        rawText.substring(0, 2000),
        targetCity,
        frontier,
      );

      // Omit `thinking` to disable thinkingConfig — this allows structured output
      // (responseSchema) on thinking-capable models like Gemini 3
      brain.providerAdapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, turn: snapshot.turnNumber, caller: 'build-advisor', method: 'adviseBuildVictory' });
      const response = await brain.providerAdapter.chat({
        model: brain.modelName,
        maxTokens: 512,
        temperature: 0,
        systemPrompt: system,
        userPrompt: user,
        outputSchema: BUILD_ADVISOR_SCHEMA,
        timeoutMs: 10000,
      });

      BuildAdvisor.lastDiagnostics.extractionLatencyMs = Date.now() - extractionStart;

      const parsed = JSON.parse(response.text) as BuildAdvisorResult;
      const validated = BuildAdvisor.validateWaypoints(parsed, gridPoints);
      if (!validated) {
        BuildAdvisor.lastDiagnostics.extractionError = 'extraction waypoints unrecoverable';
      }
      return validated;
    } catch (err) {
      BuildAdvisor.lastDiagnostics.extractionLatencyMs = Date.now() - extractionStart;
      const msg = err instanceof Error ? err.message : String(err);
      BuildAdvisor.lastDiagnostics.extractionError = msg;
      console.warn(`[BuildAdvisor] extractFromProse failed: ${msg}`);
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
  ): { row: number; col: number; cityName: string } | null {
    // JIRA-145: Mirror PlanExecutor.findInitialBuildTarget — skip the starting
    // city and on-network stops to find the first unreached destination.
    let targetCityName: string | null = null;
    if (activeRoute) {
      for (const stop of activeRoute.stops) {
        const isStartingCity = activeRoute.startingCity &&
          stop.city.toLowerCase() === activeRoute.startingCity.toLowerCase();
        if (!isStartingCity && !context.citiesOnNetwork.includes(stop.city)) {
          targetCityName = stop.city;
          break;
        }
      }
      // Fall back to current stop if all stops are starting city or on-network
      if (!targetCityName && activeRoute.currentStopIndex < activeRoute.stops.length) {
        targetCityName = activeRoute.stops[activeRoute.currentStopIndex].city;
      }
    }

    if (!targetCityName && context.unconnectedMajorCities.length > 0) {
      // Fall back to cheapest unconnected major city
      targetCityName = context.unconnectedMajorCities[0].cityName;
    }

    if (!targetCityName) return null;

    // Find grid coordinate for the city
    const cityPoint = gridPoints.find(gp => gp.city?.name === targetCityName);
    return cityPoint ? { row: cityPoint.row, col: cityPoint.col, cityName: targetCityName } : null;
  }

  /**
   * Get network frontier positions — endpoints of bot's track segments.
   * Falls back to bot position, then to nearest major city to first route stop.
   */
  private static getNetworkFrontier(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
    activeRoute?: StrategicRoute | null,
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

    // Fallback 1: If no track, use bot position
    if (frontier.length === 0 && snapshot.bot.position) {
      frontier.push(snapshot.bot.position);
    }

    // Fallback 2: If no track AND no position (initial build turn 2),
    // seed from nearest major city to first route stop
    if (frontier.length === 0 && activeRoute?.stops?.length) {
      const firstStopCity = activeRoute.stops[0].city;
      const stopPoint = gridPoints.find(gp => gp.city?.name === firstStopCity);
      if (stopPoint) {
        // Find nearest major city to this stop
        const majorPoints = gridPoints.filter(gp => gp.city && gp.terrain === TerrainType.MajorCity);
        let bestDist = Infinity;
        let bestPoint: { row: number; col: number } | null = null;
        for (const mp of majorPoints) {
          const dist = Math.abs(mp.row - stopPoint.row) + Math.abs(mp.col - stopPoint.col);
          if (dist < bestDist) {
            bestDist = dist;
            bestPoint = { row: mp.row, col: mp.col };
          }
        }
        if (bestPoint) {
          frontier.push(bestPoint);
        }
      }
    }

    return frontier;
  }
}
