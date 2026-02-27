/**
 * ResponseParser — Extracts structured selections from LLM text responses.
 *
 * Handles JSON parsing with markdown fence stripping, regex fallback for
 * malformed responses, and index validation against option counts.
 */

import { ParsedSelection, LLMActionIntent, LLMAction, AIActionType, StrategicRoute, RouteStop } from '../../../shared/types/GameTypes';

/** Custom error for unparseable LLM responses */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Parsed result from LLM plan selection response */
export interface PlanSelectionResult {
  chainIndex: number;
  reasoning: string;
}

export class ResponseParser {
  /**
   * Parse an LLM response text into a validated ParsedSelection.
   *
   * @param responseText - Raw text from the LLM response
   * @param moveOptionCount - Number of available move options (for validation)
   * @param buildOptionCount - Number of available build options (for validation)
   * @returns Validated ParsedSelection with indices and reasoning
   * @throws ParseError if the response cannot be parsed or indices are invalid
   */
  static parse(
    responseText: string,
    moveOptionCount: number,
    buildOptionCount: number,
  ): ParsedSelection {
    const text = responseText.trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Regex fallback: extract indices from malformed JSON
      const moveMatch = text.match(/"moveOption"\s*:\s*(-?\d+)/);
      const buildMatch = text.match(/"buildOption"\s*:\s*(\d+)/);
      if (moveMatch && buildMatch) {
        const moveIndex = parseInt(moveMatch[1], 10);
        const buildIndex = parseInt(buildMatch[1], 10);
        validateIndices(moveIndex, buildIndex, moveOptionCount, buildOptionCount);
        return {
          moveOptionIndex: moveIndex,
          buildOptionIndex: buildIndex,
          reasoning: 'Response was malformed but indices were extractable',
          planHorizon: '',
        };
      }
      throw new ParseError(`Unparseable LLM response: ${text.substring(0, 200)}`);
    }

    // Extract and validate moveOption index (-1 = skip movement, otherwise 0..N-1)
    const moveIndex = (parsed.moveOption as number) ?? -1;
    const buildIndex = parsed.buildOption as number;

    validateIndices(moveIndex, buildIndex, moveOptionCount, buildOptionCount);

    return {
      moveOptionIndex: moveIndex,
      buildOptionIndex: buildIndex,
      reasoning: String(parsed.reasoning || ''),
      planHorizon: String(parsed.planHorizon || ''),
    };
  }

  /**
   * Parse an LLM response for plan selection (chain picking).
   *
   * @param responseText - Raw text from the LLM response
   * @param chainCount - Number of available chains (for validation)
   * @returns Validated PlanSelectionResult with chain index and reasoning
   * @throws ParseError if the response cannot be parsed or index is invalid
   */
  static parsePlanSelection(
    responseText: string,
    chainCount: number,
  ): PlanSelectionResult {
    const text = responseText.trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Regex fallback: extract chainIndex from malformed JSON
      const chainMatch = text.match(/"chainIndex"\s*:\s*(\d+)/);
      if (chainMatch) {
        const chainIndex = parseInt(chainMatch[1], 10);
        if (chainIndex < 0 || chainIndex >= chainCount) {
          throw new ParseError(
            `Invalid chain index: ${chainIndex} (valid: 0 to ${chainCount - 1})`,
          );
        }
        return {
          chainIndex,
          reasoning: 'Response was malformed but chain index was extractable',
        };
      }
      throw new ParseError(`Unparseable plan selection response: ${text.substring(0, 200)}`);
    }

    const chainIndex = parsed.chainIndex as number;

    if (typeof chainIndex !== 'number' || !Number.isInteger(chainIndex) ||
        chainIndex < 0 || chainIndex >= chainCount) {
      throw new ParseError(
        `Invalid chain index: ${chainIndex} (valid: 0 to ${chainCount - 1})`,
      );
    }

    return {
      chainIndex,
      reasoning: String(parsed.reasoning || ''),
    };
  }

  /**
   * Valid action type strings: AIActionType enum values + LLM shorthand aliases.
   * ActionResolver.resolveSingleAction accepts both formats.
   */
  private static readonly VALID_ACTIONS = new Set<string>([
    ...Object.values(AIActionType),
    'BUILD', 'MOVE', 'DELIVER', 'PICKUP', 'UPGRADE', 'DISCARD_HAND', 'PASS',
  ]);

  /**
   * Parse an LLM response into a validated LLMActionIntent.
   *
   * Handles markdown fence stripping, JSON parsing with regex fallback,
   * and action type validation. Throws ParseError on unrecoverable failures.
   *
   * @param responseText - Raw text from the LLM response
   * @returns Validated LLMActionIntent
   * @throws ParseError if the response cannot be parsed or action types are invalid
   */
  static parseActionIntent(responseText: string): LLMActionIntent {
    const text = responseText.trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Regex fallback: try to extract action and key fields
      const actionMatch = text.match(/"action"\s*:\s*"([^"]+)"/);
      const reasoningMatch = text.match(/"reasoning"\s*:\s*"([^"]*)"/);
      const planHorizonMatch = text.match(/"planHorizon"\s*:\s*"([^"]*)"/);

      if (actionMatch) {
        const action = actionMatch[1];
        if (!ResponseParser.VALID_ACTIONS.has(action)) {
          throw new ParseError(
            `Invalid action type "${action}" extracted via regex fallback. Valid: ${[...ResponseParser.VALID_ACTIONS].join(', ')}`,
          );
        }
        // Try to extract details via regex
        const towardMatch = text.match(/"toward"\s*:\s*"([^"]*)"/);
        const toMatch = text.match(/"to"\s*:\s*"([^"]*)"/);
        const loadMatch = text.match(/"load"\s*:\s*"([^"]*)"/);
        const atMatch = text.match(/"at"\s*:\s*"([^"]*)"/);
        const details: Record<string, string> = {};
        if (towardMatch) details.toward = towardMatch[1];
        if (toMatch) details.to = toMatch[1];
        if (loadMatch) details.load = loadMatch[1];
        if (atMatch) details.at = atMatch[1];

        return {
          action,
          details: Object.keys(details).length > 0 ? details : undefined,
          reasoning: reasoningMatch?.[1] ?? 'Extracted via regex fallback',
          planHorizon: planHorizonMatch?.[1] ?? '',
        };
      }

      throw new ParseError(
        `Unparseable LLM action intent: ${text.substring(0, 200)}`,
      );
    }

    // Validate: must have either 'action' (single) or 'actions' (multi)
    if (parsed.action) {
      const action = String(parsed.action);
      if (!ResponseParser.VALID_ACTIONS.has(action)) {
        throw new ParseError(
          `Invalid action type "${action}". Valid: ${[...ResponseParser.VALID_ACTIONS].join(', ')}`,
        );
      }

      return {
        action,
        details: parsed.details as Record<string, string> | undefined,
        reasoning: String(parsed.reasoning ?? ''),
        planHorizon: String(parsed.planHorizon ?? ''),
      };
    }

    if (Array.isArray(parsed.actions)) {
      const actions: LLMAction[] = [];
      for (const item of parsed.actions) {
        const a = typeof item === 'object' && item !== null ? item as Record<string, unknown> : null;
        if (!a || !a.action) {
          throw new ParseError(
            `Invalid action in multi-action array: ${JSON.stringify(item)}`,
          );
        }
        const actionStr = String(a.action);
        if (!ResponseParser.VALID_ACTIONS.has(actionStr)) {
          throw new ParseError(
            `Invalid action type "${actionStr}" in multi-action sequence. Valid: ${[...ResponseParser.VALID_ACTIONS].join(', ')}`,
          );
        }
        actions.push({
          action: actionStr,
          details: (a.details as Record<string, string>) ?? {},
        });
      }

      return {
        actions,
        reasoning: String(parsed.reasoning ?? ''),
        planHorizon: String(parsed.planHorizon ?? ''),
      };
    }

    throw new ParseError(
      `LLM response missing 'action' or 'actions' field: ${clean.substring(0, 200)}`,
    );
  }

  /**
   * Parse an LLM response into a StrategicRoute.
   *
   * Expected format:
   * {
   *   "route": [
   *     { "action": "PICKUP", "load": "Potatoes", "city": "Szczecin" },
   *     { "action": "DELIVER", "load": "Potatoes", "city": "Paris" }
   *   ],
   *   "startingCity": "Berlin",
   *   "reasoning": "...",
   *   "planHorizon": "..."
   * }
   *
   * @param responseText - Raw text from the LLM response
   * @param turnNumber - Current turn number for createdAtTurn
   * @returns Validated StrategicRoute
   * @throws ParseError if the response cannot be parsed or route is invalid
   */
  static parseStrategicRoute(responseText: string, turnNumber: number): StrategicRoute {
    const text = responseText.trim();
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new ParseError(`Unparseable route planning response: ${text.substring(0, 200)}`);
    }

    const routeArray = parsed.route;
    if (!Array.isArray(routeArray) || routeArray.length === 0) {
      throw new ParseError('Route planning response must contain a non-empty "route" array.');
    }

    const stops: RouteStop[] = [];
    for (let i = 0; i < routeArray.length; i++) {
      const item = routeArray[i];
      if (typeof item !== 'object' || item === null) {
        throw new ParseError(`Route stop ${i} is not an object.`);
      }
      const raw = item as Record<string, unknown>;
      const action = String(raw.action ?? '').toUpperCase();
      if (action !== 'PICKUP' && action !== 'DELIVER') {
        throw new ParseError(
          `Route stop ${i} has invalid action "${raw.action}". Must be PICKUP or DELIVER.`,
        );
      }
      const loadType = String(raw.load ?? '');
      const city = String(raw.city ?? '');
      if (!loadType || !city) {
        throw new ParseError(`Route stop ${i} is missing "load" or "city".`);
      }

      const stop: RouteStop = {
        action: action.toLowerCase() as 'pickup' | 'deliver',
        loadType,
        city,
      };

      // Optional fields for deliver stops
      if (action === 'DELIVER') {
        if (raw.demandCardId != null) stop.demandCardId = Number(raw.demandCardId);
        if (raw.payment != null) stop.payment = Number(raw.payment);
      }

      stops.push(stop);
    }

    const reasoning = String(parsed.reasoning ?? '');
    const startingCity = parsed.startingCity ? String(parsed.startingCity) : undefined;

    // Parse optional secondaryBuildTarget
    let secondaryBuildTarget: { city: string; reasoning: string } | undefined;
    const rawTarget = parsed.secondaryBuildTarget;
    if (rawTarget != null && typeof rawTarget === 'object' && !Array.isArray(rawTarget)) {
      const targetObj = rawTarget as Record<string, unknown>;
      const targetCity = targetObj.city;
      if (typeof targetCity === 'string' && targetCity.trim().length > 0) {
        secondaryBuildTarget = {
          city: targetCity.trim(),
          reasoning: String(targetObj.reasoning ?? ''),
        };
      } else {
        console.warn('secondaryBuildTarget present but missing valid "city" field — ignoring.');
      }
    }

    const route: StrategicRoute = {
      stops,
      currentStopIndex: 0,
      phase: 'build',
      startingCity,
      createdAtTurn: turnNumber,
      reasoning,
    };

    if (secondaryBuildTarget) {
      route.secondaryBuildTarget = secondaryBuildTarget;
    }

    return route;
  }
}

/** Validate move and build indices against option counts */
function validateIndices(
  moveIndex: number,
  buildIndex: number,
  moveOptionCount: number,
  buildOptionCount: number,
): void {
  if (typeof moveIndex !== 'number' || !Number.isInteger(moveIndex) ||
      moveIndex < -1 || moveIndex >= moveOptionCount) {
    throw new ParseError(
      `Invalid move index: ${moveIndex} (valid: -1 to ${moveOptionCount - 1})`,
    );
  }

  if (typeof buildIndex !== 'number' || !Number.isInteger(buildIndex) ||
      buildIndex < 0 || buildIndex >= buildOptionCount) {
    throw new ParseError(
      `Invalid build index: ${buildIndex} (valid: 0 to ${buildOptionCount - 1})`,
    );
  }
}
