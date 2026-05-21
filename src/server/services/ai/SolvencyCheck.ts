import { TrackSegment, WorldSnapshot, GameContext } from '../../../shared/types/GameTypes';

/** Result of a solvency check for proposed track segments */
export interface SolvencyCheckResult {
  canAfford: boolean;
  actualCost: number;
  availableForBuild: number;
  incomeBefore: number;
}

/**
 * Checks whether a bot can afford to build proposed track segments (JIRA-129).
 * Considers cash on hand plus projected income from on-network deliveries.
 * Static class — no instance state.
 */
export class SolvencyCheck {
  /**
   * Determine if a bot can afford a given set of TrackSegments.
   *
   * @param segments - Track segments from computeBuildSegments (Dijkstra output)
   * @param snapshot - WorldSnapshot with bot.money, bot.loads, bot.resolvedDemands
   * @param context - GameContext with citiesOnNetwork
   * @returns Affordability result with actual cost and available budget
   */
  static check(
    segments: TrackSegment[],
    snapshot: WorldSnapshot,
    context: GameContext,
  ): SolvencyCheckResult {
    // 1. Calculate actual cost from segment costs
    const actualCost = segments.reduce((sum, seg) => sum + seg.cost, 0);

    // 2. Calculate incomeBefore: payouts for carried loads whose delivery city is on network
    const incomeBefore = SolvencyCheck.calculateIncomeBefore(snapshot, context);

    // 3. Available for build = cash + income from on-network deliveries
    const availableForBuild = snapshot.bot.money + incomeBefore;

    // 4. Bot can spend to zero — no cash reserve
    const canAfford = availableForBuild >= actualCost;

    return { canAfford, actualCost, availableForBuild, incomeBefore };
  }

  /**
   * Calculate projected income from delivering currently carried loads
   * to cities that are already on the bot's track network.
   */
  private static calculateIncomeBefore(
    snapshot: WorldSnapshot,
    context: GameContext,
  ): number {
    const carriedLoads = snapshot.bot.loads; // string[] of load type names
    const networkCities = new Set(context.citiesOnNetwork);
    let income = 0;

    // For each carried load, find matching demand card deliveries to on-network cities
    for (const loadType of carriedLoads) {
      // Check each resolved demand for a matching delivery
      for (const demand of snapshot.bot.resolvedDemands) {
        for (const d of demand.demands) {
          if (d.loadType === loadType && networkCities.has(d.city)) {
            income += d.payment;
            break; // Count each carried load once (best match)
          }
        }
      }
    }

    return income;
  }
}
