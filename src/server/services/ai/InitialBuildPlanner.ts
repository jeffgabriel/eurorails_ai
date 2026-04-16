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

/** Starting cities that are too remote to be viable starting points */
const BLOCKED_STARTING_CITIES = new Set<string>();

/**
 * Remote/peripheral delivery cities excluded from expandDemandOptions().
 * These cities require extensive track into outlying areas, causing early bankruptcy.
 * emergencyFallback() does NOT apply this filter — they remain available as last resort.
 */
const REMOTE_DELIVERY_CITIES = new Set([
  'Nantes', 'Bordeaux', 'Bilbao', 'Porto', 'Lisboa', 'Madrid',
  'Roma', 'Napoli', 'Kobenhavn', 'Arhus', 'Goteborg', 'Oslo', 'Stockholm',
]);

/** Max affordable build cost within 2 initial build turns (2 × 20M) */
const MAX_BUILD_BUDGET = 40;


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
    }));
    console.log(`[InitialBuildPlanner] ${options.length} options evaluated — top: ${sorted[0]?.loadType} ${sorted[0]?.supplyCity}→${sorted[0]?.deliveryCity} eff=${sorted[0]?.efficiency.toFixed(2)}`);

    const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, gridPoints);

    // Map top 10 pairings to diagnostics shape
    const evaluatedPairings = pairings.slice(0, 10).map((p, i) => ({
      rank: i + 1,
      firstLoad: p.first.loadType,
      firstRoute: `${p.first.supplyCity}→${p.first.deliveryCity}`,
      secondLoad: p.second.loadType,
      secondRoute: `${p.second.supplyCity}→${p.second.deliveryCity}`,
      sharedHub: p.sharedStartingCity,
      chainDistance: p.chainDistance,
      totalBuildCost: p.totalBuildCost,
      totalPayout: p.totalPayout,
      estimatedTurns: p.estimatedTurns,
      efficiency: Math.round(p.efficiency * 100) / 100,
      pairingScore: Math.round(p.pairingScore * 100) / 100,
    }));
    const topPairing = pairings[0];
    console.log(`[InitialBuildPlanner] ${pairings.length} pairings evaluated${topPairing ? ` — top: ${topPairing.first.loadType} ${topPairing.first.supplyCity}→${topPairing.first.deliveryCity} + ${topPairing.second.loadType} ${topPairing.second.supplyCity}→${topPairing.second.deliveryCity} score=${topPairing.pairingScore.toFixed(2)}` : ''}`);

    const bestSingle = options.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
    const bestDouble = pairings.length > 0
      ? pairings.reduce((a, b) => a.pairingScore > b.pairingScore ? a : b)
      : null;

    // Choose double if any within-budget pairing exists (budget cap enforced in computeDoubleDeliveryPairings)
    if (bestDouble) {
      const isSharedPickup = bestDouble.first.supplyCity === bestDouble.second.supplyCity
        && bestDouble.first.loadType === bestDouble.second.loadType;

      const route: RouteStop[] = isSharedPickup
        ? [
          // Single pickup, two sequential deliveries
          { action: 'pickup', loadType: bestDouble.first.loadType, city: bestDouble.first.supplyCity },
          { action: 'deliver', loadType: bestDouble.first.loadType, city: bestDouble.first.deliveryCity, demandCardId: bestDouble.first.cardId, payment: bestDouble.first.payout },
          { action: 'deliver', loadType: bestDouble.second.loadType, city: bestDouble.second.deliveryCity, demandCardId: bestDouble.second.cardId, payment: bestDouble.second.payout },
        ]
        : [
          // Serial chain: pickup, deliver, pickup, deliver
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
        evaluatedPairings,
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
      evaluatedPairings,
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

          // Skip remote delivery cities — they require overextended track during initial build
          if (REMOTE_DELIVERY_CITIES.has(demand.city)) continue;

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
              // Scale context score by local build cost efficiency.
              // localCostFactor is higher for cheaper routes (0=max cost, 1=zero cost).
              // For positive scores: multiply by (1 + factor) to boost cheap routes.
              // For negative scores: divide by (1 + factor) — cheap routes (high factor)
              //   produce a result closer to 0 (less negative = better rank). Multiplying
              //   by (1 + factor) would instead amplify the negative magnitude, making cheap
              //   routes rank WORSE than expensive ones (the original bug).
              const localCostFactor = Math.max(0, 1 - costs.totalBuildCost / MAX_BUILD_BUDGET);
              if (contextScore >= 0) {
                efficiency = contextScore * (1 + localCostFactor);
              } else {
                efficiency = contextScore / (1 + localCostFactor);
              }
            } else {
              efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;
            }

            // JIRA-178: Apply peripheral penalty to single-delivery efficiency
            // so Milano/London don't dominate starting city selection.
            // Double-delivery scoring applies -30 additive on a ~(-100,+200) scale;
            // single-delivery efficiency is ~(-5,+5), so use 0.7 multiplicative discount.
            if (PERIPHERAL_CITIES.has(group.cityName)) {
              efficiency *= 0.7;
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

            if (!bestForPair || estimatedTurns < bestForPair.estimatedTurns || (estimatedTurns === bestForPair.estimatedTurns && costs.totalBuildCost < bestForPair.totalBuildCost)) {
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
   * Includes shared-pickup detection: when two demands share the same supplyCity
   * and loadType, they are scored via scoreSharedPickupPairing() instead of
   * the serial scorePairing() path.
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

        let best: DeliveryPairing;

        // Shared-pickup: same supply city and load type — pick up both at once
        if (a.supplyCity === b.supplyCity && a.loadType === b.loadType) {
          best = InitialBuildPlanner.scoreSharedPickupPairing(a, b, gridPoints);
        } else {
          // Serial chain: try both orderings (A→B and B→A) and pick the better one
          const pairingAB = InitialBuildPlanner.scorePairing(a, b, gridPoints);
          const pairingBA = InitialBuildPlanner.scorePairing(b, a, gridPoints);
          best = pairingAB.pairingScore >= pairingBA.pairingScore ? pairingAB : pairingBA;
        }

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
    // JIRA-152: Compare linear (supply→delivery) vs hub (start→delivery) routing.
    // The bot can deliver by going back through the starting city hub,
    // reusing the start→supply track. (Same fix as JIRA-72 in ContextBuilder.)
    let buildCostSupplyToDelivery = Infinity;
    if (supplyCity === deliveryCity) {
      buildCostSupplyToDelivery = 0;
    } else {
      // Linear: supply → delivery direct
      for (const sup of supplyPoints) {
        for (const dp of deliveryPoints) {
          const cost = InitialBuildPlanner.costBetween(sup.row, sup.col, dp.row, dp.col);
          if (cost < buildCostSupplyToDelivery) buildCostSupplyToDelivery = cost;
        }
      }
      // Hub: start → delivery (supply→start track already counted in buildCostToSupply)
      for (const sp of startPoints) {
        for (const dp of deliveryPoints) {
          const cost = InitialBuildPlanner.costBetween(sp.row, sp.col, dp.row, dp.col);
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

    // Recompute second supply→delivery cost fresh (Bug B fix).
    // second.buildCostSupplyToDelivery was evaluated from a different starting city context
    // and may be deflated. Use costBetween() directly from the actual grid point positions.
    const secondDeliveryPointsEarly = gridPoints.filter(gp => gp.city?.name === second.deliveryCity);
    let freshSecondSupplyToDeliveryCost = Infinity;
    for (const sp of secondSupplyPoints) {
      for (const dp of secondDeliveryPointsEarly) {
        const c = InitialBuildPlanner.costBetween(sp.row, sp.col, dp.row, dp.col);
        if (c < freshSecondSupplyToDeliveryCost) freshSecondSupplyToDeliveryCost = c;
      }
    }
    if (freshSecondSupplyToDeliveryCost === Infinity) {
      freshSecondSupplyToDeliveryCost = second.buildCostSupplyToDelivery; // fallback to stored
    }

    // Fix 1 & 3: Estimate combined build cost using terrain-aware costs for both branches
    let totalBuildCost: number;
    if (sharedStartingCity) {
      // Shared hub: first legs already in first.totalBuildCost; add chain leg + fresh second supply→delivery
      totalBuildCost = first.totalBuildCost + chainLegCost + freshSecondSupplyToDeliveryCost;
    } else {
      // Different hubs: first's full cost + chain leg + second supply→delivery
      // Cannot use second.totalBuildCost — it assumes starting from a disconnected city
      totalBuildCost = first.totalBuildCost + chainLegCost + freshSecondSupplyToDeliveryCost;
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
   * Score a shared-pickup pairing: both loads are picked up simultaneously at the
   * same supply city, then delivered sequentially (closer delivery city first).
   *
   * Cost model differs from serial scorePairing:
   *   totalBuildCost = first.totalBuildCost + deliveryChainCost
   * where deliveryChainCost = costBetween(closerDelivery, fartherDelivery).
   * No chain-back-to-supply leg needed — both loads already on board.
   */
  private static scoreSharedPickupPairing(
    first: DemandOption,
    second: DemandOption,
    gridPoints: GridPoint[],
  ): DeliveryPairing {
    // Shared supply — use whichever option's startingCity is better (first's by convention)
    const sharedStartingCity = first.startingCity === second.startingCity
      ? first.startingCity
      : null;

    const supplyPoints = gridPoints.filter(gp => gp.city?.name === first.supplyCity);
    const firstDeliveryPoints = gridPoints.filter(gp => gp.city?.name === first.deliveryCity);
    const secondDeliveryPoints = gridPoints.filter(gp => gp.city?.name === second.deliveryCity);

    // Compute hex distances from supply to each delivery city to determine ordering
    let supplyToFirstHex = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of firstDeliveryPoints) {
        const d = hexDistance(sp.row, sp.col, dp.row, dp.col);
        if (d < supplyToFirstHex) supplyToFirstHex = d;
      }
    }
    let supplyToSecondHex = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of secondDeliveryPoints) {
        const d = hexDistance(sp.row, sp.col, dp.row, dp.col);
        if (d < supplyToSecondHex) supplyToSecondHex = d;
      }
    }

    // Deliver closer city first to minimize total travel distance
    const [closer, farther] = supplyToFirstHex <= supplyToSecondHex
      ? [first, second]
      : [second, first];

    const closerDeliveryPoints = gridPoints.filter(gp => gp.city?.name === closer.deliveryCity);
    const fartherDeliveryPoints = gridPoints.filter(gp => gp.city?.name === farther.deliveryCity);

    // Inter-delivery leg cost (terrain-aware), fallback to hex distance * 2.0
    let deliveryChainCost = Infinity;
    for (const cp of closerDeliveryPoints) {
      for (const fp of fartherDeliveryPoints) {
        const c = InitialBuildPlanner.costBetween(cp.row, cp.col, fp.row, fp.col);
        if (c < deliveryChainCost) deliveryChainCost = c;
      }
    }
    if (deliveryChainCost === Infinity) {
      // Fallback: hex distance * 2.0 to match costBetween's own fallback
      let interDeliveryHex = Infinity;
      for (const cp of closerDeliveryPoints) {
        for (const fp of fartherDeliveryPoints) {
          const d = hexDistance(cp.row, cp.col, fp.row, fp.col);
          if (d < interDeliveryHex) interDeliveryHex = d;
        }
      }
      deliveryChainCost = interDeliveryHex === Infinity ? 99 : interDeliveryHex * 2.0;
    }

    // Chain distance (hex) between the two delivery cities, for travel time estimation
    let chainDistance = Infinity;
    for (const cp of closerDeliveryPoints) {
      for (const fp of fartherDeliveryPoints) {
        const d = hexDistance(cp.row, cp.col, fp.row, fp.col);
        if (d < chainDistance) chainDistance = d;
      }
    }
    if (chainDistance === Infinity) chainDistance = 99;

    // totalBuildCost: first delivery route already in closer.totalBuildCost,
    // add only the inter-delivery leg (no second supply leg needed)
    const totalBuildCost = closer.totalBuildCost + deliveryChainCost;

    // Travel time: start → supply → closerDelivery → fartherDelivery
    const speed = 9; // Freight default
    const startPoints = gridPoints.filter(gp => gp.city?.name === closer.startingCity);
    let startToSupplyHex = Infinity;
    for (const sp of startPoints) {
      for (const sup of supplyPoints) {
        const d = hexDistance(sp.row, sp.col, sup.row, sup.col);
        if (d < startToSupplyHex) startToSupplyHex = d;
      }
    }
    let supplyToCloserHex = Infinity;
    for (const sup of supplyPoints) {
      for (const dp of closerDeliveryPoints) {
        const d = hexDistance(sup.row, sup.col, dp.row, dp.col);
        if (d < supplyToCloserHex) supplyToCloserHex = d;
      }
    }

    const totalHexDistance = (startToSupplyHex === Infinity ? 0 : startToSupplyHex)
      + (supplyToCloserHex === Infinity ? 0 : supplyToCloserHex)
      + chainDistance;

    const totalPayout = closer.payout + farther.payout;
    const buildTurns = Math.ceil(totalBuildCost / 20);
    const travelTurns = Math.ceil(totalHexDistance / speed) + 1; // +1 for single pickup, two delivers
    const estimatedTurns = Math.max(buildTurns + travelTurns, 2);
    const efficiency = (totalPayout - totalBuildCost) / estimatedTurns;

    const hubBonus = sharedStartingCity ? 15 : 0;
    const peripheralPenalty = PERIPHERAL_CITIES.has(closer.startingCity) ? 30 : 0;

    const ferryOnFirstLeg = InitialBuildPlanner.isFerryBetween(closer.supplyCity, closer.deliveryCity, gridPoints)
      || InitialBuildPlanner.isFerryBetween(closer.startingCity, closer.supplyCity, gridPoints);
    const ferryOnSecondLeg = InitialBuildPlanner.isFerryBetween(farther.supplyCity, farther.deliveryCity, gridPoints)
      || InitialBuildPlanner.isFerryBetween(farther.startingCity, farther.supplyCity, gridPoints);
    const ferryPenalty = (ferryOnFirstLeg || ferryOnSecondLeg) ? FERRY_PAIRING_PENALTY : 0;

    const pairingScore = efficiency * 100 + hubBonus - peripheralPenalty - ferryPenalty;

    return {
      first: closer,
      second: farther,
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
