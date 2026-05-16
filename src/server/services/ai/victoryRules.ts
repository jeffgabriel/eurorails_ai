/**
 * victoryRules.ts — Pure functions for bot end-state detection and cost helpers.
 *
 * JIRA-241: Introduces a persistent game phase (GameState) that latches once the
 * bot's cash exceeds END_GAME_ENTRY_CASH (200M) and never reverts. Downstream
 * scoring (Task 2) and replan gate (Task 3) read gameState from GameContext.
 */

import {
  BotMemoryState,
  GameContext,
  GameState,
  END_GAME_ENTRY_CASH,
  VICTORY_CITY_COUNT,
} from '../../../shared/types/GameTypes';

/**
 * Compute the bot's persistent game phase.
 *
 * Latching rules (AC1a–AC1d):
 * - If memory.gameState is already End → stay End regardless of cash.
 * - Else if money > END_GAME_ENTRY_CASH (200M) → latch to End.
 * - Else → Mid (never returns Initial here; Initial is implicit in setup code).
 *
 * Fail-safe: missing memory.gameState is treated as Mid (default behavior).
 *
 * @param context - Minimal context with current cash (money).
 * @param memory  - Persistent bot memory (may have gameState from a prior turn).
 * @returns The resolved GameState — always End or Mid from this path.
 */
export function computeGameState(
  context: { money: number },
  memory: BotMemoryState,
): GameState {
  // Latch: once End, never revert — even if cash dips below threshold.
  if (memory.gameState === GameState.End) {
    return GameState.End;
  }

  // Transition: cash crosses the entry threshold.
  if (context.money > END_GAME_ENTRY_CASH) {
    return GameState.End;
  }

  // Default: mid-game (Initial is deferred per tech debt TD-1).
  return GameState.Mid;
}

/**
 * Return the estimated track cost to reach the cheapest unconnected major city.
 *
 * Used by end-state scoring (Task 2) to penalise routes that don't help
 * connect still-missing major cities.
 *
 * Returns 0 when:
 * - All major cities are already connected (connectedMajorCities.length >= VICTORY_CITY_COUNT).
 * - unconnectedMajorCities is empty.
 * - The first entry has no estimatedCost.
 *
 * @param context - Current game context (unconnectedMajorCities sorted by cost ascending).
 * @returns Estimated cost in ECU M, or 0 when not applicable.
 */
export function cheapestUnconnectedMajorConnectorCost(context: GameContext): number {
  if (context.connectedMajorCities.length >= VICTORY_CITY_COUNT) {
    return 0;
  }
  return context.unconnectedMajorCities[0]?.estimatedCost ?? 0;
}
