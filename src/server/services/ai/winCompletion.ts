/**
 * winCompletion.ts
 *
 * Pure-function helper module for end-game win-completion math.
 * Centralises the win-cost calculation and the win-completer predicate
 * so they can be reused by cheapPrune (carve-out gate) and the rank
 * pass (two-tier sort key) without duplicating logic.
 *
 * The lock that activates end-game routing is one-way (sticky): once
 * endGameLocked is set on BotMemoryState it never unsets, even if
 * the bot temporarily dips below the threshold due to track builds.
 * This module contains no I/O and no state — it is pure math.
 */

/**
 * Cash threshold in ECU millions required to win the game.
 * A bot must hold at least this much cash AND have a continuous line
 * of track connecting 7 major cities to declare victory.
 */
export const CASH_WIN_THRESHOLD_M = 250;

/**
 * Calculate the total cash a bot needs in order to win the game,
 * taking into account the track still needed to connect the remaining
 * major cities.
 *
 * Algorithm:
 *  1. Determine how many more major cities still need to be connected:
 *     `remaining = 7 - cmcCount`.
 *  2. If `remaining <= 0` (all 7 already connected), no track cost is
 *     required — return `CASH_WIN_THRESHOLD_M`.
 *  3. Otherwise, sort `unconnectedMajors` by `estimatedCost` ascending
 *     and sum the cheapest `remaining` entries.
 *  4. Return `CASH_WIN_THRESHOLD_M + sumOfCheapestRemainingCosts`.
 *
 * @param unconnectedMajors - Array of major cities not yet on the bot's
 *   network, each with an `estimatedCost` in ECU millions (from
 *   `NetworkContext.computeUnconnectedMajorCities`).
 * @param cmcCount - Number of major cities currently connected to the
 *   bot's network.
 * @returns The minimum cash (ECU millions) the bot needs to pay both the
 *   cash win threshold and all remaining track connection costs.
 */
export function fullWinCost(
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): number {
  const remaining = Math.max(0, 7 - cmcCount);
  if (remaining === 0 || unconnectedMajors.length === 0) {
    return CASH_WIN_THRESHOLD_M;
  }

  // Sort ascending by estimatedCost so we take the cheapest connections first.
  const sorted = [...unconnectedMajors].sort((a, b) => a.estimatedCost - b.estimatedCost);
  const slice = sorted.slice(0, remaining);
  const trackCost = slice.reduce((sum, m) => sum + m.estimatedCost, 0);

  return CASH_WIN_THRESHOLD_M + trackCost;
}

/**
 * Determine whether a candidate route would complete the win condition
 * if executed — i.e., would the bot have enough cash after collecting
 * the payout AND spending on remaining track connections?
 *
 * Formula:
 *   `(currentCash + candidateNet) >= fullWinCost(unconnectedMajors, cmcCount)`
 *
 * Note: `candidateNet` must already account for track building costs
 * along the route itself. The `fullWinCost` tracks only the connection
 * costs for major cities not yet reachable via the candidate route.
 *
 * @param currentCash - Bot's current cash balance in ECU millions.
 * @param candidateNet - Net income from the candidate route (payout minus
 *   estimated build costs along the route) in ECU millions.
 * @param unconnectedMajors - Major cities not yet connected, each with an
 *   `estimatedCost` (from `NetworkContext.computeUnconnectedMajorCities`).
 * @param cmcCount - Number of major cities currently connected.
 * @returns `true` if executing this candidate would leave the bot with
 *   enough resources to win; `false` otherwise.
 */
export function isWinCompleting(
  currentCash: number,
  candidateNet: number,
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): boolean {
  const required = fullWinCost(unconnectedMajors, cmcCount);
  return currentCash + candidateNet >= required;
}
