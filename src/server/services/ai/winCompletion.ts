/**
 * winCompletion.ts
 *
 * JIRA-255 Layer B: helpers for determining whether a candidate route is
 * "win-completing" — i.e. its net payout (plus current cash) would cover
 * both the ECU 250M cash threshold and the cheapest remaining city-connection
 * build costs.
 *
 * Exposed as a separate module so DeterministicTripPlanner and tests can
 * import the helpers without pulling the full planner dependency graph.
 */

/**
 * ECU cash threshold required to win (ECU 250M).
 * Mirrors VICTORY_INITIAL_THRESHOLD from GameTypes.ts but reproduced here
 * so this module stays dependency-light.
 */
export const CASH_WIN_THRESHOLD_M = 250;

/**
 * Compute the full win cost: cash threshold plus the cheapest estimated cost
 * to connect the remaining (7 − cmcCount) major cities.
 *
 * @param unconnectedMajors - Sorted cheapest-first list of unconnected major
 *   cities with their estimated track connection cost.
 * @param cmcCount - Number of major cities already connected.
 * @returns Total ECU needed to win from the current position.
 */
export function fullWinCost(
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): number {
  const remaining = Math.max(0, 7 - cmcCount);
  const cityCost = unconnectedMajors
    .slice(0, remaining)
    .reduce((sum, c) => sum + c.estimatedCost, 0);
  return CASH_WIN_THRESHOLD_M + cityCost;
}

/**
 * Return true when executing a candidate (payout − buildCost = net) would
 * push the bot's cash position to or above the full win cost.
 *
 * @param currentCash    - Bot's current cash (ECU M).
 * @param candidateNet   - Candidate's net payout (payout − buildCost, ECU M).
 * @param unconnectedMajors - Sorted cheapest-first unconnected major cities.
 * @param cmcCount       - Current connected-major-city count.
 */
export function isWinCompleting(
  currentCash: number,
  candidateNet: number,
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): boolean {
  return currentCash + candidateNet >= fullWinCost(unconnectedMajors, cmcCount);
}
