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
  VICTORY_INITIAL_THRESHOLD,
} from '../../../shared/types/GameTypes';

/**
 * A "victory clinch" — a currently-carried load + matching demand card whose
 * delivery would satisfy both victory conditions (cash ≥ 250M, ≥ 7 majors
 * connected) without further building.
 */
export interface VictoryClinch {
  loadType: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
}

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

/**
 * Detect whether a currently-carried load + matching demand card delivery
 * would clinch victory immediately — i.e. both victory conditions are met
 * after the delivery without any further track building.
 *
 * Conditions (all required):
 *   1. ≥ 7 major cities already connected (city condition satisfied pre-delivery).
 *   2. There exists a demand `d` such that:
 *        a. `d.isLoadOnTrain === true` (load is in cargo right now).
 *        b. `d.isDeliveryOnNetwork === true` (no build required to reach delivery).
 *        c. `money + d.payout >= 250` (cash condition satisfied post-delivery).
 *
 * When multiple carried loads qualify, the highest-payout one wins. This is
 * the simplest correct tiebreak — payout is monotone for victory and the cash
 * margin is always strictly nonneg.
 *
 * Returns null when no clinch is available. Callers should fall through to
 * normal trip planning in that case.
 *
 * Background: forensic analysis of game c990fa47 (JIRA-243) showed s2 was
 * carrying a Labor load with a matching `Labor → Bordeaux 34M` card at T74
 * after just connecting its 7th major (Madrid), yet the deterministic pair-
 * scoring continued executing a Wroclaw → Antwerpen detour for Copper. The
 * matching demand card was silently discarded post-delivery and the game ran
 * ~15 turns longer than necessary. This hard gate short-circuits that case.
 *
 * @param context - Current game context with demands + connected majors + cash.
 * @returns The clinch candidate, or null when none exists.
 */
export function detectVictoryClinch(context: GameContext): VictoryClinch | null {
  if (context.connectedMajorCities.length < VICTORY_CITY_COUNT) return null;
  if (!context.demands || context.demands.length === 0) return null;

  let best: VictoryClinch | null = null;
  for (const d of context.demands) {
    if (!d.isLoadOnTrain) continue;
    if (!d.isDeliveryOnNetwork) continue;
    if (context.money + d.payout < VICTORY_INITIAL_THRESHOLD) continue;
    if (!best || d.payout > best.payout) {
      best = {
        loadType: d.loadType,
        deliveryCity: d.deliveryCity,
        payout: d.payout,
        cardIndex: d.cardIndex,
      };
    }
  }
  return best;
}
