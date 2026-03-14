/**
 * ResponseParser — Extracts structured selections from LLM text responses.
 *
 * Handles JSON parsing with markdown fence stripping, regex fallback for
 * malformed responses, and index validation against option counts.
 */

import { ParsedSelection, LLMActionIntent, LLMAction, AIActionType, StrategicRoute, RouteStop } from '../../../shared/types/GameTypes';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';

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
  static parseActionIntent(responseText: string | Record<string, unknown>): LLMActionIntent {
    // Fast-path: structured output already parsed as an object
    if (typeof responseText === 'object' && responseText !== null) {
      return ResponseParser.validateActionIntent(responseText);
    }

    const text = responseText.trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Attempt truncated JSON recovery before regex fallback
      const recovered = ResponseParser.recoverTruncatedJson(clean);
      if (recovered !== null) {
        console.warn('[ResponseParser] Recovered truncated JSON response');
        return ResponseParser.validateActionIntent(recovered);
      }

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

    return ResponseParser.validateActionIntent(parsed);
  }

  /**
   * Attempt to recover truncated JSON by closing open brackets/braces.
   * Returns the parsed object if recovery succeeds, null otherwise.
   */
  static recoverTruncatedJson(text: string): Record<string, unknown> | null {
    let opens = 0;
    let openBrackets = 0;
    const stack: ('{' | '[')[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { stack.push('{'); opens++; }
      else if (ch === '[') { stack.push('['); openBrackets++; }
      else if (ch === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); opens--; }
      else if (ch === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); openBrackets--; }
    }

    if (stack.length === 0) return null; // Not a bracket mismatch issue

    // Close open brackets in reverse order (LIFO)
    let repaired = text;
    for (let i = stack.length - 1; i >= 0; i--) {
      repaired += stack[i] === '{' ? '}' : ']';
    }

    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }

  /**
   * Validate a parsed object into an LLMActionIntent.
   * Shared by fast-path (pre-parsed object) and string-path (after JSON.parse).
   */
  private static validateActionIntent(parsed: Record<string, unknown>): LLMActionIntent {
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
      `LLM response missing 'action' or 'actions' field: ${JSON.stringify(parsed).substring(0, 200)}`,
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
  static parseStrategicRoute(responseText: string | Record<string, unknown>, turnNumber: number): StrategicRoute {
    let parsed: Record<string, unknown>;

    // Fast-path: structured output already parsed as an object
    if (typeof responseText === 'object' && responseText !== null) {
      parsed = responseText;
    } else {
      const text = responseText.trim();
      const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

      try {
        parsed = JSON.parse(clean);
      } catch {
        // Attempt truncated JSON recovery: close open brackets
        const recovered = ResponseParser.recoverTruncatedJson(clean);
        if (recovered !== null) {
          console.warn('[ResponseParser] Recovered truncated JSON response');
          parsed = recovered;
        } else {
          throw new ParseError(`Unparseable route planning response: ${text.substring(0, 200)}`);
        }
      }
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
    const rawStartingCity = parsed.startingCity ? String(parsed.startingCity) : undefined;

    // Validate startingCity is a major city; snap to nearest major city if not
    let startingCity = rawStartingCity;
    if (rawStartingCity) {
      const majorCities = getMajorCityGroups().map(g => g.cityName);
      const isMajor = majorCities.some(mc => mc.toLowerCase() === rawStartingCity.toLowerCase());
      if (!isMajor) {
        // Find the first supply city from route stops and pick nearest major city
        const firstSupply = stops.find(s => s.action === 'pickup')?.city;
        console.warn(`[ResponseParser] LLM chose non-major startingCity "${rawStartingCity}" — must be one of [${majorCities.join(', ')}]`);
        // Default to undefined so autoPlaceBot picks the best major city
        startingCity = undefined;
      }
    }

    const upgradeOnRoute = parsed.upgradeOnRoute ? String(parsed.upgradeOnRoute) : undefined;

    const route: StrategicRoute = {
      stops,
      currentStopIndex: 0,
      phase: 'build',
      startingCity,
      upgradeOnRoute,
      createdAtTurn: turnNumber,
      reasoning,
    };

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
