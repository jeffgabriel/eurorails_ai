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
 * Precedence (highest first):
 *   1. End latch (JIRA-241) — once memory says End, stay End.
 *   2. Cash trigger (JIRA-241) — money > END_GAME_ENTRY_CASH (200M) → End.
 *   3. Turn brackets (JIRA-242):
 *        turnNumber > 25 → Mid
 *        turnNumber ≥ 4  → Early
 *        otherwise       → Initial
 *
 * Initial → Early → Mid transitions don't need latching because turn numbers
 * only increase. End takes precedence and is latched.
 *
 * Fail-safe: missing memory.gameState is treated as no prior latch.
 *
 * @param context - Minimal context with current cash and turn number.
 * @param memory  - Persistent bot memory (may have gameState from a prior turn).
 * @returns The resolved GameState.
 */
export function computeGameState(
  context: { money: number; turnNumber: number },
  memory: BotMemoryState,
): GameState {
  // Latch: once End, never revert — even if cash dips below threshold.
  if (memory.gameState === GameState.End) {
    return GameState.End;
  }

  // Cash trigger: precedence over any turn-based phase (JIRA-241).
  if (context.money > END_GAME_ENTRY_CASH) {
    return GameState.End;
  }

  // Turn brackets (JIRA-242):
  if (context.turnNumber > 25) {
    return GameState.Mid;
  }
  if (context.turnNumber >= 4) {
    return GameState.Early;
  }
  return GameState.Initial;
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
