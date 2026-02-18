/**
 * ResponseParser — Extracts structured selections from LLM text responses.
 *
 * Handles JSON parsing with markdown fence stripping, regex fallback for
 * malformed responses, and index validation against option counts.
 */

import { ParsedSelection } from '../../../shared/types/GameTypes';

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
