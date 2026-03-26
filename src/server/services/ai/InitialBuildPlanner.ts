/**
 * InitialBuildPlanner — Pure computational opening planner for initial build phase.
 *
 * Replaces LLM calls during turns 1-2 with deterministic scoring of all viable
 * demand pairings. Produces a starting city + route for the bot's first moves.
 *
 * JIRA-142b
 */

import {
  WorldSnapshot,
  GridPoint,
  DemandOption,
  DeliveryPairing,
  InitialBuildPlan,
  RouteStop,
  TRAIN_PROPERTIES,
  TrainType,
} from '../../../shared/types/GameTypes';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';
import { hexDistance, estimatePathCost } from './MapTopology';
import { LoadService } from '../loadService';

/** Peripheral cities that get a scoring penalty */
const PERIPHERAL_CITIES = new Set(['London', 'Milano']);

/** Madrid is blocked as a starting city */
const BLOCKED_STARTING_CITIES = new Set(['Madrid']);

/** Max affordable build cost within 2 initial build turns (2 × 20M) */
const MAX_BUILD_BUDGET = 40;

/** Budget ratio above which single-delivery efficiency is penalized (80% of MAX_BUILD_BUDGET) */
const HIGH_BUDGET_RATIO = 0.8;

/** Multiplier applied to efficiency when build cost exceeds HIGH_BUDGET_RATIO */
const HIGH_BUDGET_PENALTY = 0.5;

/** Point penalty for ferry routes in double-delivery pairings */
const FERRY_PAIRING_PENALTY = 30;

export class InitialBuildPlanner {

  /**
   * Top-level entry point. Evaluates all demand options, scores pairings,
   * and returns the best initial build plan.
   */
  static planInitialBuild(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
    demandScores?: Map<string, number>,
  ): InitialBuildPlan {
    const options = InitialBuildPlanner.expandDemandOptions(snapshot, gridPoints, demandScores);

    if (options.length === 0) {
      return InitialBuildPlanner.emergencyFallback(snapshot, gridPoints);
    }

    // JIRA-148: Sort options by efficiency for logging and diagnostics
    const sorted = [...options].sort((a, b) => b.efficiency - a.efficiency);
    const evaluatedOptions = sorted.map((o, i) => ({
      rank: i + 1,
      loadType: o.loadType,
      supplyCity: o.supplyCity,
      deliveryCity: o.deliveryCity,
      startingCity: o.startingCity,
      payout: o.payout,
      totalBuildCost: o.totalBuildCost,
      buildCostToSupply: o.buildCostToSupply,
      buildCostSupplyToDelivery: o.buildCostSupplyToDelivery,
      estimatedTurns: o.estimatedTurns,
      efficiency: Math.round(o.efficiency * 100) / 100,
      penalized: o.totalBuildCost > HIGH_BUDGET_RATIO * MAX_BUILD_BUDGET,
    }));
    console.log(`[InitialBuildPlanner] ${options.length} options evaluated — top: ${sorted[0]?.loadType} ${sorted[0]?.supplyCity}→${sorted[0]?.deliveryCity} eff=${sorted[0]?.efficiency.toFixed(2)}`);

    const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, gridPoints);

    const bestSingle = options.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
    const bestDouble = pairings.length > 0
      ? pairings.reduce((a, b) => a.pairingScore > b.pairingScore ? a : b)
      : null;

    // Choose double if any within-budget pairing exists (budget cap enforced in computeDoubleDeliveryPairings)
    if (bestDouble) {
      const route: RouteStop[] = [
        { action: 'pickup', loadType: bestDouble.first.loadType, city: bestDouble.first.supplyCity },
        { action: 'deliver', loadType: bestDouble.first.loadType, city: bestDouble.first.deliveryCity, demandCardId: bestDouble.first.cardId, payment: bestDouble.first.payout },
        { action: 'pickup', loadType: bestDouble.second.loadType, city: bestDouble.second.supplyCity },
        { action: 'deliver', loadType: bestDouble.second.loadType, city: bestDouble.second.deliveryCity, demandCardId: bestDouble.second.cardId, payment: bestDouble.second.payout },
      ];
      return {
        startingCity: bestDouble.sharedStartingCity ?? bestDouble.first.startingCity,
        route,
        buildPriority: `Build toward ${bestDouble.first.supplyCity} for ${bestDouble.first.loadType} pickup`,
        totalBuildCost: bestDouble.totalBuildCost,
        totalPayout: bestDouble.totalPayout,
        estimatedTurns: bestDouble.estimatedTurns,
        evaluatedOptions,
      };
    }

    // Single delivery fallback
    const route: RouteStop[] = [
      { action: 'pickup', loadType: bestSingle.loadType, city: bestSingle.supplyCity },
      { action: 'deliver', loadType: bestSingle.loadType, city: bestSingle.deliveryCity, demandCardId: bestSingle.cardId, payment: bestSingle.payout },
    ];
    return {
      startingCity: bestSingle.startingCity,
      route,
      buildPriority: `Build toward ${bestSingle.supplyCity} for ${bestSingle.loadType} pickup`,
      totalBuildCost: bestSingle.totalBuildCost,
      totalPayout: bestSingle.payout,
      estimatedTurns: bestSingle.estimatedTurns,
      evaluatedOptions,
    };
  }

  /**
   * Expand all 9 demands × supply cities × starting cities into scored options.
   * Filters out ferry routes, over-budget, Madrid starts, and unavailable loads.
   */
  static expandDemandOptions(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
    demandScores?: Map<string, number>,
  ): DemandOption[] {
    const loadSvc = LoadService.getInstance();
    const majorCityGroups = getMajorCityGroups();
    const options: DemandOption[] = [];

    for (const rd of snapshot.bot.resolvedDemands) {
      for (let demandIdx = 0; demandIdx < rd.demands.length; demandIdx++) {
        const demand = rd.demands[demandIdx];
        const sourceCities = loadSvc.getSourceCitiesForLoad(demand.loadType);

        for (const supplyCity of sourceCities) {
          // Check load availability at supply city
          const available = snapshot.loadAvailability[supplyCity];
          if (!available || !available.includes(demand.loadType)) continue;

          // Check ferry requirement
          const ferryRequired = InitialBuildPlanner.isFerryBetween(
            supplyCity, demand.city, gridPoints,
          );
          if (ferryRequired) continue;

          // Evaluate each major city as a starting point
          let bestForPair: DemandOption | null = null;

          for (const group of majorCityGroups) {
            if (BLOCKED_STARTING_CITIES.has(group.cityName)) continue;

            // Check if ferry needed to reach supply from this starting city
            const ferryToSupply = InitialBuildPlanner.isFerryBetween(
              group.cityName, supplyCity, gridPoints,
            );
            if (ferryToSupply) continue;

            const costs = InitialBuildPlanner.estimateBuildCostFromCity(
              group.cityName, supplyCity, demand.city, gridPoints,
            );
            if (!costs) continue;
            if (costs.totalBuildCost > MAX_BUILD_BUDGET) continue;

            const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
            const buildTurns = Math.ceil(costs.totalBuildCost / 20);
            // Compute travel distance using hex distance (milepost proxy), not build cost
            const startPoints = gridPoints.filter(gp => gp.city?.name === group.cityName);
            const supplyGridPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
            const deliveryGridPoints = gridPoints.filter(gp => gp.city?.name === demand.city);
            let hexToSupply = Infinity;
            for (const sp of startPoints) {
              for (const sup of supplyGridPoints) {
                const d = hexDistance(sp.row, sp.col, sup.row, sup.col);
                if (d < hexToSupply) hexToSupply = d;
              }
            }
            let hexSupplyToDelivery = Infinity;
            for (const sup of supplyGridPoints) {
              for (const dp of deliveryGridPoints) {
                const d = hexDistance(sup.row, sup.col, dp.row, dp.col);
                if (d < hexSupplyToDelivery) hexSupplyToDelivery = d;
              }
            }
            const travelDistance = (hexToSupply === Infinity ? 0 : hexToSupply) + (hexSupplyToDelivery === Infinity ? 0 : hexSupplyToDelivery);
            const travelTurns = Math.ceil(travelDistance / speed) + 1;
            const estimatedTurns = Math.max(buildTurns + travelTurns, 1);
            // JIRA-148: Use pre-computed demand score (corridor + victory bonuses)
            // when available, falling back to simple ROI formula
            const scoreKey = `${demand.loadType}:${demand.city}`;
            const contextScore = demandScores?.get(scoreKey);
            let efficiency: number;
            if (contextScore !== undefined) {
              // Scale context score by local build cost efficiency
              const localCostFactor = Math.max(0, 1 - costs.totalBuildCost / MAX_BUILD_BUDGET);
              efficiency = contextScore * (1 + localCostFactor);
            } else {
              efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;
            }
            // Penalize routes that consume most of the initial budget
            if (costs.totalBuildCost > HIGH_BUDGET_RATIO * MAX_BUILD_BUDGET) {
              efficiency *= HIGH_BUDGET_PENALTY;
            }

            const option: DemandOption = {
              cardId: rd.cardId,
              demandIndex: demandIdx,
              loadType: demand.loadType,
              supplyCity,
              deliveryCity: demand.city,
              payout: demand.payment,
              startingCity: group.cityName,
              buildCostToSupply: costs.buildCostToSupply,
              buildCostSupplyToDelivery: costs.buildCostSupplyToDelivery,
              totalBuildCost: costs.totalBuildCost,
              ferryRequired: false,
              estimatedTurns,
              efficiency,
            };

            if (!bestForPair || costs.totalBuildCost < bestForPair.totalBuildCost) {
              bestForPair = option;
            }
          }

          if (bestForPair) {
            options.push(bestForPair);
          }
        }
      }
    }

    return options;
  }

  /**
   * Score all cross-card pairings for double delivery potential.
   */
  static computeDoubleDeliveryPairings(
    options: DemandOption[],
    gridPoints: GridPoint[],
  ): DeliveryPairing[] {
    const pairings: DeliveryPairing[] = [];

    for (let i = 0; i < options.length; i++) {
      for (let j = i + 1; j < options.length; j++) {
        const a = options[i];
        const b = options[j];

        // Must be from different cards
        if (a.cardId === b.cardId) continue;

        // Try both orderings (A→B and B→A) and pick the better one
        const pairingAB = InitialBuildPlanner.scorePairing(a, b, gridPoints);
        const pairingBA = InitialBuildPlanner.scorePairing(b, a, gridPoints);

        const best = pairingAB.pairingScore >= pairingBA.pairingScore ? pairingAB : pairingBA;

        // Budget cap on combined cost
        if (best.totalBuildCost > MAX_BUILD_BUDGET) continue;

        pairings.push(best);
      }
    }

    // Sort by pairing score descending
    pairings.sort((a, b) => b.pairingScore - a.pairingScore);
    return pairings;
  }

  /**
   * Estimate build cost from a specific starting major city to supply and delivery.
   */
  static estimateBuildCostFromCity(
    startingCity: string,
    supplyCity: string,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): { buildCostToSupply: number; buildCostSupplyToDelivery: number; totalBuildCost: number } | null {
    const startPoints = gridPoints.filter(gp => gp.city?.name === startingCity);
    const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
    const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);

    if (startPoints.length === 0 || supplyPoints.length === 0 || deliveryPoints.length === 0) {
      return null;
    }

    // Cost: starting city → supply city (0 if same city)
    let buildCostToSupply = Infinity;
    if (startingCity === supplyCity) {
      buildCostToSupply = 0;
    } else {
      for (const sp of startPoints) {
        for (const sup of supplyPoints) {
          const cost = InitialBuildPlanner.costBetween(sp.row, sp.col, sup.row, sup.col);
          if (cost < buildCostToSupply) buildCostToSupply = cost;
        }
      }
    }
    if (buildCostToSupply === Infinity) return null;

    // Cost: supply city → delivery city (0 if same city)
    let buildCostSupplyToDelivery = Infinity;
    if (supplyCity === deliveryCity) {
      buildCostSupplyToDelivery = 0;
    } else {
      for (const sup of supplyPoints) {
        for (const dp of deliveryPoints) {
          const cost = InitialBuildPlanner.costBetween(sup.row, sup.col, dp.row, dp.col);
          if (cost < buildCostSupplyToDelivery) buildCostSupplyToDelivery = cost;
        }
      }
    }
    if (buildCostSupplyToDelivery === Infinity) return null;

    return {
      buildCostToSupply,
      buildCostSupplyToDelivery,
      totalBuildCost: buildCostToSupply + buildCostSupplyToDelivery,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private static scorePairing(
    first: DemandOption,
    second: DemandOption,
    gridPoints: GridPoint[],
  ): DeliveryPairing {
    const sharedStartingCity = first.startingCity === second.startingCity
      ? first.startingCity
      : null;

    // Chain distance: hex distance from first delivery to second supply
    const firstDeliveryPoints = gridPoints.filter(gp => gp.city?.name === first.deliveryCity);
    const secondSupplyPoints = gridPoints.filter(gp => gp.city?.name === second.supplyCity);

    let chainDistance = Infinity;
    for (const dp of firstDeliveryPoints) {
      for (const sp of secondSupplyPoints) {
        const dist = hexDistance(dp.row, dp.col, sp.row, sp.col);
        if (dist < chainDistance) chainDistance = dist;
      }
    }
    if (chainDistance === Infinity) chainDistance = 99;

    // Fix 3: Extract terrain-aware chain leg cost, shared by both branches.
    // Fallback to chainDistance * 1.5 if costBetween returns Infinity (no grid points found).
    let chainLegCost = Infinity;
    for (const dp of firstDeliveryPoints) {
      for (const sp of secondSupplyPoints) {
        const c = InitialBuildPlanner.costBetween(dp.row, dp.col, sp.row, sp.col);
        if (c < chainLegCost) chainLegCost = c;
      }
    }
    if (chainLegCost === Infinity) chainLegCost = chainDistance * 1.5;

    // Fix 1 & 3: Estimate combined build cost using terrain-aware costs for both branches
    let totalBuildCost: number;
    if (sharedStartingCity) {
      // Shared hub: first legs already in first.totalBuildCost; add chain leg + second supply→delivery
      totalBuildCost = first.totalBuildCost + chainLegCost + second.buildCostSupplyToDelivery;
    } else {
      // Different hubs: first's full cost + min(second's full cost, chain leg + second's supply→delivery)
      const chainedSecondCost = chainLegCost + second.buildCostSupplyToDelivery;
      totalBuildCost = first.totalBuildCost + Math.min(second.totalBuildCost, chainedSecondCost);
    }

    // Fix 4: Use hex distance for travel time estimation, not build cost
    const speed = 9; // Freight default
    const firstSupplyPoints = gridPoints.filter(gp => gp.city?.name === first.supplyCity);
    const startPoints = gridPoints.filter(gp => gp.city?.name === first.startingCity);
    let firstLegHex = Infinity;
    for (const sp of startPoints) {
      for (const sup of firstSupplyPoints) {
        const d = hexDistance(sp.row, sp.col, sup.row, sup.col);
        if (d < firstLegHex) firstLegHex = d;
      }
    }
    let firstDeliveryHex = Infinity;
    for (const sup of firstSupplyPoints) {
      for (const dp of firstDeliveryPoints) {
        const d = hexDistance(sup.row, sup.col, dp.row, dp.col);
        if (d < firstDeliveryHex) firstDeliveryHex = d;
      }
    }
    const secondDeliveryPoints = gridPoints.filter(gp => gp.city?.name === second.deliveryCity);
    let secondDeliveryHex = Infinity;
    for (const sp of secondSupplyPoints) {
      for (const dp of secondDeliveryPoints) {
        const d = hexDistance(sp.row, sp.col, dp.row, dp.col);
        if (d < secondDeliveryHex) secondDeliveryHex = d;
      }
    }
    const totalHexDistance = (firstLegHex === Infinity ? 0 : firstLegHex)
      + (firstDeliveryHex === Infinity ? 0 : firstDeliveryHex)
      + chainDistance
      + (secondDeliveryHex === Infinity ? 0 : secondDeliveryHex);

    const totalPayout = first.payout + second.payout;
    const buildTurns = Math.ceil(totalBuildCost / 20);
    const travelTurns = Math.ceil(totalHexDistance / speed) + 2; // +2 for two deliveries
    const estimatedTurns = Math.max(buildTurns + travelTurns, 2);
    const efficiency = (totalPayout - totalBuildCost) / estimatedTurns;

    // Fix 2: Remove chainBonus cliff — hub bonus and penalties only
    const hubBonus = sharedStartingCity ? 15 : 0;
    const peripheralPenalty = PERIPHERAL_CITIES.has(first.startingCity) ? 30 : 0;

    // Penalize pairings where either leg requires a ferry
    const ferryOnFirstLeg = InitialBuildPlanner.isFerryBetween(first.supplyCity, first.deliveryCity, gridPoints)
      || InitialBuildPlanner.isFerryBetween(first.startingCity, first.supplyCity, gridPoints);
    const ferryOnSecondLeg = InitialBuildPlanner.isFerryBetween(second.supplyCity, second.deliveryCity, gridPoints)
      || InitialBuildPlanner.isFerryBetween(second.startingCity, second.supplyCity, gridPoints);
    const ferryPenalty = (ferryOnFirstLeg || ferryOnSecondLeg) ? FERRY_PAIRING_PENALTY : 0;

    const pairingScore = efficiency * 100 + hubBonus - peripheralPenalty - ferryPenalty;

    return {
      first,
      second,
      sharedStartingCity,
      chainDistance,
      totalBuildCost,
      totalPayout,
      estimatedTurns,
      efficiency,
      pairingScore,
    };
  }

  /**
   * Estimate path cost between two grid points, with fallback to hex distance.
   * Mirrors the costBetween helper in ContextBuilder.estimateColdStartRouteCost.
   */
  private static costBetween(
    fromRow: number, fromCol: number, toRow: number, toCol: number,
  ): number {
    if (fromRow === toRow && fromCol === toCol) return 0;
    const pathCost = estimatePathCost(fromRow, fromCol, toRow, toCol);
    if (pathCost > 0) return pathCost;
    const dist = hexDistance(fromRow, fromCol, toRow, toCol);
    return dist <= 1 ? 0 : Math.round(dist * 2.0);
  }

  /**
   * Check if a ferry is required between two cities using region classification.
   * Simplified version of ContextBuilder.isFerryOnRoute.
   */
  private static isFerryBetween(
    cityA: string, cityB: string, gridPoints: GridPoint[],
  ): boolean {
    // Check if either city IS a ferry port
    for (const gp of gridPoints) {
      if (gp.isFerryCity) {
        const cityName = gp.city?.name;
        if (cityName === cityA || cityName === cityB) return true;
      }
    }
    return InitialBuildPlanner.getCityRegion(cityA) !== InitialBuildPlanner.getCityRegion(cityB);
  }

  /** Classify city into continent/britain/ireland region */
  private static getCityRegion(city: string): string {
    const BRITAIN = new Set([
      'London', 'Birmingham', 'Nottingham', 'Liverpool', 'Manchester',
      'Edinburgh', 'Glasgow', 'Newcastle', 'Cardiff', 'Southampton',
      'Bristol', 'Leeds', 'Sheffield', 'Plymouth', 'Norwich',
    ]);
    const IRELAND = new Set(['Dublin', 'Belfast', 'Cork', 'Galway', 'Limerick', 'Rosslare']);
    if (BRITAIN.has(city)) return 'britain';
    if (IRELAND.has(city)) return 'ireland';
    return 'continent';
  }

  /**
   * Emergency fallback when all options are filtered out.
   * Relaxes ferry filter and picks the cheapest single delivery.
   */
  private static emergencyFallback(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): InitialBuildPlan {
    const loadSvc = LoadService.getInstance();
    const majorCityGroups = getMajorCityGroups();
    let bestOption: DemandOption | null = null;

    for (const rd of snapshot.bot.resolvedDemands) {
      for (let demandIdx = 0; demandIdx < rd.demands.length; demandIdx++) {
        const demand = rd.demands[demandIdx];
        const sourceCities = loadSvc.getSourceCitiesForLoad(demand.loadType);

        for (const supplyCity of sourceCities) {
          for (const group of majorCityGroups) {
            if (BLOCKED_STARTING_CITIES.has(group.cityName)) continue;
            const costs = InitialBuildPlanner.estimateBuildCostFromCity(
              group.cityName, supplyCity, demand.city, gridPoints,
            );
            if (!costs) continue;

            const ferryRequired = InitialBuildPlanner.isFerryBetween(
              supplyCity, demand.city, gridPoints,
            );
            const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
            const buildTurns = Math.ceil(costs.totalBuildCost / 20);
            const travelTurns = Math.ceil(costs.totalBuildCost / speed) + 1;
            const estimatedTurns = Math.max(buildTurns + travelTurns, 1);
            const efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;

            const option: DemandOption = {
              cardId: rd.cardId,
              demandIndex: demandIdx,
              loadType: demand.loadType,
              supplyCity,
              deliveryCity: demand.city,
              payout: demand.payment,
              startingCity: group.cityName,
              buildCostToSupply: costs.buildCostToSupply,
              buildCostSupplyToDelivery: costs.buildCostSupplyToDelivery,
              totalBuildCost: costs.totalBuildCost,
              ferryRequired,
              estimatedTurns,
              efficiency,
            };

            if (!bestOption || costs.totalBuildCost < bestOption.totalBuildCost) {
              bestOption = option;
            }
          }
        }
      }
    }

    // Absolute last resort — pick first major city
    if (!bestOption) {
      const fallbackCity = majorCityGroups.find(g => !BLOCKED_STARTING_CITIES.has(g.cityName))?.cityName ?? 'Paris';
      return {
        startingCity: fallbackCity,
        route: [],
        buildPriority: 'No viable demand found — build opportunistically',
        totalBuildCost: 0,
        totalPayout: 0,
        estimatedTurns: 0,
      };
    }

    return {
      startingCity: bestOption.startingCity,
      route: [
        { action: 'pickup', loadType: bestOption.loadType, city: bestOption.supplyCity },
        { action: 'deliver', loadType: bestOption.loadType, city: bestOption.deliveryCity, demandCardId: bestOption.cardId, payment: bestOption.payout },
      ],
      buildPriority: `Build toward ${bestOption.supplyCity} for ${bestOption.loadType} pickup`,
      totalBuildCost: bestOption.totalBuildCost,
      totalPayout: bestOption.payout,
      estimatedTurns: bestOption.estimatedTurns,
    };
  }
}
