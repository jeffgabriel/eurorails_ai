/**
 * ContextBuilder — Computes decision-relevant game context for the LLM prompt.
 *
 * Computes reachability, demand feasibility, and
 * opponent context, then serializes into a structured prompt string.
 *
 * All methods are private static (matching AI service conventions).
 */

import {
  WorldSnapshot,
  GameContext,
  DemandContext,
  DeliveryOpportunity,
  PickupOpportunity,
  OpponentContext,
  BotSkillLevel,
  TrackSegment,
  TRAIN_PROPERTIES,
  TrainType,
  GridPoint,
  TerrainType,
  RouteStop,
  StrategicRoute,
  EnRoutePickup,
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { hexDistance, estimateHopDistance, estimatePathCost, computeLandmass, computeFerryRouteInfo, makeKey, loadGridPoints, getFerryPairPort } from './MapTopology';
import { MIN_DELIVERIES_BEFORE_UPGRADE } from './AIStrategyEngine';

/** Major cities in the cheap, dense core of the map */
const CORE_CITIES = new Set(['Paris', 'Ruhr', 'Holland', 'Berlin', 'Wien']);

/** Corridor of demands sharing pickup/delivery routes */
interface Corridor {
  demandIndices: number[];
  sharedDeliveryArea: string;
  combinedPayout: number;
  combinedTrackCost: number;
  onTheWayDemands: number[];
}

export class ContextBuilder {
  // Corridor detection thresholds (hex distance)
  private static readonly CORRIDOR_DELIVERY_THRESHOLD = 8;
  private static readonly CORRIDOR_SUPPLY_THRESHOLD = 12;
  private static readonly ON_THE_WAY_THRESHOLD = 5;

  /**
   * Build a GameContext from the WorldSnapshot for LLM prompt generation.
   * Orchestrates all sub-computations using existing shared services.
   */
  static async build(
    snapshot: WorldSnapshot,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
  ): Promise<GameContext> {
    const botPosition = snapshot.bot.position;
    const trainType = snapshot.bot.trainType as TrainType;
    const trainProps = TRAIN_PROPERTIES[trainType];
    const speed = snapshot.bot.ferryHalfSpeed
      ? Math.ceil(trainProps.speed / 2)
      : trainProps.speed;

    // Build the track network from bot's segments
    const network = snapshot.bot.existingSegments.length > 0
      ? buildTrackNetwork(snapshot.bot.existingSegments)
      : null;

    // Compute reachable cities within speed limit
    const reachableCities = botPosition && network
      ? ContextBuilder.computeReachableCities(botPosition, speed, network, gridPoints)
      : [];

    // Compute all cities on the track network (not speed-limited)
    const citiesOnNetwork = network
      ? ContextBuilder.computeCitiesOnNetwork(network, gridPoints)
      : [];

    // Compute connected major cities
    const connectedMajorCities = ContextBuilder.computeConnectedMajorCities(
      snapshot.bot.existingSegments, gridPoints,
    );

    // Compute demand context for each demand card
    const demands = ContextBuilder.computeAllDemandContexts(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );

    // Compute immediate delivery opportunities
    const canDeliver = ContextBuilder.computeCanDeliver(snapshot, gridPoints);

    // Compute pickup opportunities at current position
    const canPickup = ContextBuilder.computeCanPickup(snapshot, gridPoints);

    // turnBuildCost is not yet on WorldSnapshot — will be added in BE-021.
    // Default to 0 since ContextBuilder runs at the start of the bot's turn.
    const turnBuildCost = (snapshot.bot as { turnBuildCost?: number }).turnBuildCost ?? 0;

    // Determine if the bot can build
    const canBuild = (20 - turnBuildCost) > 0 && snapshot.bot.money > 0;

    // Determine if the bot can upgrade and generate advice (JIRA-55: pass demands + canBuild for ROI)
    const canUpgrade = ContextBuilder.checkCanUpgrade(snapshot);
    const upgradeAdvice = ContextBuilder.computeUpgradeAdvice(snapshot, demands, canBuild);

    // Determine game phase
    const isInitialBuild = snapshot.gameStatus === 'initialBuild';
    const phase = ContextBuilder.computePhase(snapshot, connectedMajorCities);

    // Build opponent context based on skill level
    const opponents = ContextBuilder.buildOpponentContext(
      snapshot.opponents ?? [], skillLevel,
    );

    // Compute track summary
    const trackSummary = ContextBuilder.computeTrackSummary(
      snapshot.bot.existingSegments, gridPoints,
    );

    // Compute unconnected major cities with estimated track costs
    const unconnectedMajorCities = ContextBuilder.computeUnconnectedMajorCities(
      connectedMajorCities,
      snapshot.bot.existingSegments,
      gridPoints,
    );

    return {
      position: botPosition
        ? {
          row: botPosition.row,
          col: botPosition.col,
          city: ContextBuilder.getCityNameAtPosition(botPosition, gridPoints),
        }
        : null,
      money: snapshot.bot.money,
      trainType: snapshot.bot.trainType,
      speed,
      capacity: trainProps.capacity,
      loads: snapshot.bot.loads,
      connectedMajorCities,
      unconnectedMajorCities,
      totalMajorCities: 8,
      trackSummary,
      turnBuildCost,
      demands,
      canDeliver,
      canPickup,
      reachableCities,
      citiesOnNetwork,
      canUpgrade,
      canBuild,
      isInitialBuild,
      opponents,
      phase,
      turnNumber: snapshot.turnNumber,
      upgradeAdvice,
    };
  }

  /**
   * Recompute demand contexts from a fresh snapshot (JIRA-56).
   * Used after DiscardHand to refresh demandRanking with new cards.
   */
  static rebuildDemands(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DemandContext[] {
    const network = snapshot.bot.existingSegments.length > 0
      ? buildTrackNetwork(snapshot.bot.existingSegments)
      : null;
    const trainType = snapshot.bot.trainType as keyof typeof TRAIN_PROPERTIES;
    const trainProps = TRAIN_PROPERTIES[trainType];
    const speed = snapshot.bot.ferryHalfSpeed
      ? Math.ceil(trainProps.speed / 2)
      : trainProps.speed;
    const botPosition = snapshot.bot.position as { row: number; col: number } | null;
    const reachableCities = botPosition && network
      ? ContextBuilder.computeReachableCities(botPosition, speed, network, gridPoints)
      : [];
    const citiesOnNetwork = network
      ? ContextBuilder.computeCitiesOnNetwork(network, gridPoints)
      : [];
    const connectedMajorCities = ContextBuilder.computeConnectedMajorCities(
      snapshot.bot.existingSegments, gridPoints,
    );
    return ContextBuilder.computeAllDemandContexts(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );
  }

  // ── Reachable cities (BE-003) ───────────────────────────────────────────

  /**
   * BFS from bot position with depth limit of `speed` mileposts.
   * Returns city names reachable within the speed limit on the existing track network.
   * Halves remaining depth when a ferry node is encountered.
   */
  static computeReachableCities(
    position: { row: number; col: number },
    speed: number,
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
    /** Tracks ferry ports already visited via teleportation to prevent infinite recursion
     *  between paired ports (e.g., Sassnitz ↔ Malmo). Internal parameter — callers omit. */
    _visitedFerryPorts?: Set<string>,
  ): string[] {
    const startKey = `${position.row},${position.col}`;
    const visitedFerryPorts = _visitedFerryPorts ?? new Set<string>();

    // JIRA-121 Bug 2: If bot starts at a ferry port, model teleportation to the
    // paired port (matching ActionResolver.resolveFerryCrossing behavior).
    // Speed is already halved by WorldSnapshotService, so we BFS from the paired port.
    const ferryStartPoint = gridPoints.find(gp => gp.row === position.row && gp.col === position.col);
    if (ferryStartPoint?.terrain === TerrainType.FerryPort && !visitedFerryPorts.has(startKey)) {
      visitedFerryPorts.add(startKey);
      const ferryEdges = getFerryEdges();
      const pairedPort = getFerryPairPort(position.row, position.col, ferryEdges);
      if (pairedPort) {
        const pairedKey = `${pairedPort.row},${pairedPort.col}`;
        if (network.nodes.has(pairedKey)) {
          console.log(`[ContextBuilder] Ferry teleport: BFS starting from paired port (${pairedPort.row},${pairedPort.col}) instead of ferry port`);
          // BFS from the paired port at the already-halved speed.
          // Also include cities reachable from the original position via non-ferry neighbors.
          const ferryReachable = ContextBuilder.computeReachableCities(
            pairedPort, speed, network, gridPoints, visitedFerryPorts,
          );
          // Include the paired port's city name if it has one
          const pairedPoint = gridPoints.find(gp => gp.row === pairedPort.row && gp.col === pairedPort.col);
          const pairedCityName = pairedPoint?.city?.name ?? pairedPoint?.name;
          if (pairedCityName && !ferryReachable.includes(pairedCityName)) {
            ferryReachable.push(pairedCityName);
          }
          return Array.from(new Set(ferryReachable));
        }
      }
    }

    if (!network.nodes.has(startKey)) {
      // Bot position is not on the track network (e.g., at a major city center
      // adjacent to but not directly on own track). Snap to nearest network node.
      let bestKey: string | null = null;
      let bestDist = Infinity;
      for (const nodeKey of Array.from(network.nodes)) {
        const [r, c] = nodeKey.split(',').map(Number);
        const dist = hexDistance(position.row, position.col, r, c);
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = nodeKey;
        }
      }
      // Only snap if the nearest node is within 3 hexes (otherwise bot is truly disconnected)
      if (!bestKey || bestDist > 3) return [];
      const [snapRow, snapCol] = bestKey.split(',').map(Number);
      const adjustedSpeed = Math.max(0, speed - bestDist);
      if (adjustedSpeed <= 0) return [];
      return ContextBuilder.computeReachableCities(
        { row: snapRow, col: snapCol }, adjustedSpeed, network, gridPoints, visitedFerryPorts,
      );
    }

    // Build a lookup for grid points by "row,col" key
    const gridLookup = new Map<string, GridPoint>();
    for (const gp of gridPoints) {
      gridLookup.set(`${gp.row},${gp.col}`, gp);
    }

    // BFS with depth tracking — track best remaining speed per node
    const bestRemaining = new Map<string, number>();
    bestRemaining.set(startKey, speed);
    const queue: Array<{ key: string; remaining: number }> = [
      { key: startKey, remaining: speed },
    ];

    const reachableCities: string[] = [];

    // Check if starting position is a city
    const startPoint = gridLookup.get(startKey);
    const startCityName = startPoint?.city?.name ?? startPoint?.name;
    if (startCityName) {
      reachableCities.push(startCityName);
    }

    while (queue.length > 0) {
      const { key, remaining } = queue.shift()!;

      const neighbors = network.edges.get(key);
      if (!neighbors) continue;

      for (const neighborKey of Array.from(neighbors)) {
        // Each edge costs 1 milepost of movement
        const neighborPoint = gridLookup.get(neighborKey);
        const isFerry = neighborPoint?.terrain === TerrainType.FerryPort;

        // Ferry halves remaining movement after consuming 1 milepost
        let newRemaining: number;
        if (isFerry) {
          newRemaining = Math.floor((remaining - 1) / 2);
        } else {
          newRemaining = remaining - 1;
        }

        if (newRemaining < 0) continue;

        // Only visit if we arrive with more remaining speed than previously
        const prev = bestRemaining.get(neighborKey);
        if (prev !== undefined && prev >= newRemaining) continue;

        bestRemaining.set(neighborKey, newRemaining);
        queue.push({ key: neighborKey, remaining: newRemaining });

        // Collect city name if this is a city (including FerryPort points which have name but no city)
        const neighborCityName = neighborPoint?.city?.name ?? neighborPoint?.name;
        if (neighborCityName) {
          reachableCities.push(neighborCityName);
        }
      }
    }

    // Deduplicate (major cities may have multiple mileposts with the same name)
    return Array.from(new Set(reachableCities));
  }

  // ── Cities on network (not speed-limited) ──────────────────────────────

  /**
   * Compute all city names that have at least one milepost on the bot's track network.
   * Unlike computeReachableCities, this is NOT limited by speed — it shows all cities
   * the bot can eventually reach by moving along its track (multi-turn destinations).
   */
  static computeCitiesOnNetwork(
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
  ): string[] {
    const cityNames = new Set<string>();
    for (const nodeKey of Array.from(network.nodes)) {
      const point = gridPoints.find(gp => `${gp.row},${gp.col}` === nodeKey);
      if (point?.city?.name) {
        cityNames.add(point.city.name);
      }
    }
    return Array.from(cityNames);
  }

  // ── Load runtime availability (BE-004) ──────────────────────────────────

  /**
   * Count how many copies of a load type are currently carried by any player.
   * Used by both isLoadRuntimeAvailable() and computeDemandContext() for scarcity data.
   */
  private static countCarriedLoads(
    loadType: string,
    snapshot: WorldSnapshot,
  ): number {
    let carriedCount = 0;

    // Count bot's loads
    for (const load of snapshot.bot.loads) {
      if (load === loadType) carriedCount++;
    }

    // Count opponent loads (available for Medium/Hard skill)
    if (snapshot.opponents) {
      for (const opp of snapshot.opponents) {
        for (const load of opp.loads) {
          if (load === loadType) carriedCount++;
        }
      }
    }

    return carriedCount;
  }

  /**
   * Check if any copies of loadType are available (not currently carried by any player).
   * Supplements LoadService.isLoadAvailableAtCity which only checks static config.
   */
  static isLoadRuntimeAvailable(
    loadType: string,
    snapshot: WorldSnapshot,
  ): boolean {
    const carriedCount = ContextBuilder.countCarriedLoads(loadType, snapshot);

    // If no opponent data available (Easy), we can only check the bot's own loads.
    // Optimistically assume at least one copy is available if bot isn't carrying all of them.
    // Load chip counts are typically 3-4 copies per type.
    if (!snapshot.opponents) {
      // Without opponent data, assume available unless the bot alone holds 3+ copies
      return carriedCount < 3;
    }

    // With full opponent data, check against the known total copies.
    // Most loads have 3 copies; loads with 4+ source cities have 4 copies.
    // We use a conservative default of 3 if we can't determine the exact count.
    const totalCopies = ContextBuilder.getLoadTotalCopies(loadType);
    return carriedCount < totalCopies;
  }

  /** Get total load chip count for a load type from configuration defaults */
  private static getLoadTotalCopies(loadType: string): number {
    // Hard-coded defaults from load_cities.json configuration.
    // Loads with 4+ source cities: Beer(4), Cheese(4), Machinery(4), Oil(4), Wine(4).
    // All others: 3 copies.
    const fourCopyLoads = ['Beer', 'Cheese', 'Machinery', 'Oil', 'Wine'];
    return fourCopyLoads.includes(loadType) ? 4 : 3;
  }

  // ── Build affordability (BE-001) ────────────────────────────────────────

  /**
   * Check if a build target is achievable with current cash plus projected
   * delivery income from carried loads. Also flags negative ROI builds
   * where track cost exceeds payout.
   */
  static isBuildAffordable(
    estimatedTrackCost: number,
    botMoney: number,
    carriedLoads: string[],
    resolvedDemands: WorldSnapshot['bot']['resolvedDemands'],
    payout: number,
  ): { affordable: boolean; projectedFunds: number } {
    // Calculate projected income from currently carried loads
    let projectedIncome = 0;
    for (const loadType of carriedLoads) {
      // Find matching demand for this carried load
      for (const resolved of resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType) {
            projectedIncome += demand.payment;
            break; // Only count one demand per carried load instance
          }
        }
      }
    }
    const projectedFunds = botMoney + projectedIncome;

    // Negative ROI check: track cost exceeds payout
    if (estimatedTrackCost > payout) {
      return { affordable: false, projectedFunds };
    }

    // Affordability check: can bot afford the build with projected funds?
    const affordable = estimatedTrackCost <= projectedFunds;
    return { affordable, projectedFunds };
  }

  // ── Demand context (BE-005) ─────────────────────────────────────────────

  /**
   * Evaluate ALL supply cities for a demand and return the DemandContext with the
   * highest demandScore. This ensures the bot considers every possible route for
   * a load type, not just the geographically nearest supply city.
   */
  private static computeBestDemandContext(
    cardIndex: number,
    demand: { city: string; loadType: string; payment: number },
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContext {
    // Find all cities that supply this load type
    const supplyCityNames = new Set<string>();
    for (const gp of gridPoints) {
      if (gp.city && gp.city.availableLoads.includes(demand.loadType)) {
        supplyCityNames.add(gp.city.name);
      }
    }

    // If load is already on train, supply city doesn't matter — evaluate once with null
    if (snapshot.bot.loads.includes(demand.loadType)) {
      return ContextBuilder.computeSingleSupplyDemandContext(
        cardIndex, demand, null, snapshot, network, gridPoints,
        reachableCities, citiesOnNetwork, connectedMajorCities,
      );
    }

    // JIRA-82: No supply cities have available chips AND load is NOT on train.
    // Previously this fell into the "on train" path, producing supplyCity: "Unknown",
    // estimatedTurns: 1, trackCost: 0 — making the LLM think the load was carried.
    // Instead, return a context with explicit unfulfillable indicators.
    if (supplyCityNames.size === 0) {
      const ctx = ContextBuilder.computeSingleSupplyDemandContext(
        cardIndex, demand, null, snapshot, network, gridPoints,
        reachableCities, citiesOnNetwork, connectedMajorCities,
      );
      // Override misleading values: supply is not "Unknown" (on train) — it's gone
      ctx.supplyCity = 'NoSupply';
      ctx.estimatedTurns = 99;
      ctx.demandScore = -999;
      ctx.efficiencyPerTurn = -999;
      return ctx;
    }

    // Evaluate each supply city and pick the one with the best demandScore
    let bestContext: DemandContext | null = null;
    for (const supplyCity of supplyCityNames) {
      const ctx = ContextBuilder.computeSingleSupplyDemandContext(
        cardIndex, demand, supplyCity, snapshot, network, gridPoints,
        reachableCities, citiesOnNetwork, connectedMajorCities,
      );
      if (!bestContext || ctx.demandScore > bestContext.demandScore) {
        bestContext = ctx;
      }
    }

    return bestContext!;
  }

  /**
   * Pre-compute reachability and cost estimates for a single demand with a specific supply city.
   * Uses the string-based track network and gridPoints for all lookups.
   */
  private static computeSingleSupplyDemandContext(
    cardIndex: number,
    demand: { city: string; loadType: string; payment: number },
    supplyCity: string | null,
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContext {
    const deliveryCity = demand.city;
    const loadType = demand.loadType;

    // 1. Check if the load is already on the bot's train
    const isLoadOnTrain = snapshot.bot.loads.includes(loadType);

    // 3. Check reachability — is the city in the reachable cities list?
    const isSupplyReachable = supplyCity ? reachableCities.includes(supplyCity) : false;
    const isDeliveryReachable = reachableCities.includes(deliveryCity);

    // 4. Check if the city is on the network at all (connected but maybe not
    //    reachable this turn due to speed). Used for cost estimation.
    const isSupplyOnNetwork = supplyCity
      ? ContextBuilder.isCityOnNetwork(supplyCity, network, gridPoints)
      : false;
    const isDeliveryOnNetwork = ContextBuilder.isCityOnNetwork(
      deliveryCity, network, gridPoints,
    );

    // 5. Estimate track cost to reach cities not on the network
    // JIRA-72: On cold-start, use hub-aware cost model instead of mismatched estimateTrackCost calls
    let estimatedTrackCostToSupply = 0;
    let estimatedTrackCostToDelivery = 0;
    let optimalStartingCity: string | undefined;

    const isColdStart = snapshot.bot.existingSegments.length === 0;
    if (isColdStart && supplyCity && !isLoadOnTrain) {
      const coldStartResult = ContextBuilder.estimateColdStartRouteCost(
        supplyCity, deliveryCity, gridPoints,
      );
      if (coldStartResult) {
        estimatedTrackCostToSupply = coldStartResult.supplyCost;
        estimatedTrackCostToDelivery = coldStartResult.deliveryCost;
        optimalStartingCity = coldStartResult.startingCity;
      } else {
        // Fallback to existing estimateTrackCost behavior if hub model fails
        estimatedTrackCostToSupply = ContextBuilder.estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
        estimatedTrackCostToDelivery = ContextBuilder.estimateTrackCost(deliveryCity, snapshot.bot.existingSegments, gridPoints, supplyCity);
      }
    } else {
      estimatedTrackCostToSupply = isSupplyOnNetwork || !supplyCity || isLoadOnTrain
        ? 0
        : ContextBuilder.estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
      estimatedTrackCostToDelivery = isDeliveryOnNetwork
        ? 0
        : ContextBuilder.estimateTrackCost(
            deliveryCity, snapshot.bot.existingSegments, gridPoints,
          );
    }

    // 6. Check runtime load availability
    const isLoadAvailable = ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot);

    // 7. Check if a ferry is required to reach supply or delivery
    const ferryRequired = ContextBuilder.isFerryOnRoute(
      supplyCity, deliveryCity, gridPoints,
    );

    // 8. Load chip scarcity data
    const totalCopies = ContextBuilder.getLoadTotalCopies(loadType);
    const carriedCount = ContextBuilder.countCarriedLoads(loadType, snapshot);

    // 9. Turn estimate: build turns + travel turns + 1 (for pickup/deliver)
    const totalTrackCost = estimatedTrackCostToSupply + estimatedTrackCostToDelivery;
    const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType].speed;
    const buildTurns = totalTrackCost > 0 ? Math.ceil(totalTrackCost / 20) : 0;

    // Travel distance: BFS hop count through actual hex grid (JIRA-66)
    // JIRA-75: On cold-start, travel is startingCity→supply + supply→delivery (not just supply→delivery)
    let travelTurns = 0;
    const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
    if (supplyCity) {
      const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);

      if (isColdStart && optimalStartingCity) {
        // Cold-start: bot starts at optimalStartingCity, must travel to supply then delivery
        const startPoints = gridPoints.filter(gp => gp.city?.name === optimalStartingCity);
        if (startPoints.length > 0 && supplyPoints.length > 0 && deliveryPoints.length > 0) {
          // Leg 1: startingCity → supply
          let hopStartToSupply = Infinity;
          for (const stP of startPoints) {
            for (const sp of supplyPoints) {
              const d = estimateHopDistance(stP.row, stP.col, sp.row, sp.col);
              if (d >= 0 && d < hopStartToSupply) hopStartToSupply = d;
            }
          }
          // Leg 2: supply → delivery
          let hopSupplyToDelivery = Infinity;
          for (const sp of supplyPoints) {
            for (const dp of deliveryPoints) {
              const d = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
              if (d >= 0 && d < hopSupplyToDelivery) hopSupplyToDelivery = d;
            }
          }
          // JIRA-79: Fallback to Euclidean distance when BFS can't cross water
          if (hopStartToSupply === Infinity) {
            let minEuc = Infinity;
            for (const stP of startPoints) {
              for (const sp of supplyPoints) {
                const d = Math.sqrt((sp.row - stP.row) ** 2 + (sp.col - stP.col) ** 2);
                if (d < minEuc) minEuc = d;
              }
            }
            if (minEuc < Infinity) hopStartToSupply = minEuc;
          }
          if (hopSupplyToDelivery === Infinity) {
            let minEuc = Infinity;
            for (const sp of supplyPoints) {
              for (const dp of deliveryPoints) {
                const d = Math.sqrt((dp.row - sp.row) ** 2 + (dp.col - sp.col) ** 2);
                if (d < minEuc) minEuc = d;
              }
            }
            if (minEuc < Infinity) hopSupplyToDelivery = minEuc;
          }
          const totalHops = (hopStartToSupply < Infinity ? hopStartToSupply : 0)
            + (hopSupplyToDelivery < Infinity ? hopSupplyToDelivery : 0);
          if (totalHops > 0) {
            travelTurns = Math.ceil(totalHops / speed);
          }
        }
      } else if (supplyPoints.length > 0 && deliveryPoints.length > 0) {
        // Non-cold-start: supply→delivery (bot is already on network)
        let minDist = Infinity;
        for (const sp of supplyPoints) {
          for (const dp of deliveryPoints) {
            const dist = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
            if (dist > 0) {
              minDist = Math.min(minDist, dist);
            }
          }
        }
        if (minDist < Infinity) {
          travelTurns = Math.ceil(minDist / speed);
        } else {
          // JIRA-79: BFS returns 0 for water-separated routes (Ireland, Britain, Scandinavia)
          // because it skips Water terrain tiles. Use Euclidean hex distance as fallback.
          let minEuclidean = Infinity;
          for (const sp of supplyPoints) {
            for (const dp of deliveryPoints) {
              const eucDist = Math.sqrt((dp.row - sp.row) ** 2 + (dp.col - sp.col) ** 2);
              if (eucDist < minEuclidean) minEuclidean = eucDist;
            }
          }
          if (minEuclidean < Infinity) {
            travelTurns = Math.ceil(minEuclidean / speed);
          }
        }
      }
    } else if (isLoadOnTrain && snapshot.bot.position) {
      // On-train case: compute travel from bot position to delivery city
      const botPos = snapshot.bot.position as { row: number; col: number };
      if (deliveryPoints.length > 0) {
        let minDist = Infinity;
        for (const dp of deliveryPoints) {
          const dist = estimateHopDistance(botPos.row, botPos.col, dp.row, dp.col);
          if (dist > 0) {
            minDist = Math.min(minDist, dist);
          }
        }
        if (minDist < Infinity) {
          travelTurns = Math.ceil(minDist / speed);
        } else {
          // Euclidean fallback for cross-water routes (consistent with JIRA-79)
          let minEuc = Infinity;
          for (const dp of deliveryPoints) {
            const eucDist = Math.sqrt((dp.row - botPos.row) ** 2 + (dp.col - botPos.col) ** 2);
            if (eucDist < minEuc) minEuc = eucDist;
          }
          if (minEuc < Infinity) {
            travelTurns = Math.ceil(minEuc / speed);
          }
        }
      }
    }
    // JIRA-88: Add ferry penalty — each crossing costs ~2 turns
    // (1 turn mandatory stop at port + ~1 turn half-rate movement)
    const ferryCrossings = ferryRequired
      ? ContextBuilder.countFerryCrossings(supplyCity, deliveryCity, gridPoints)
      : 0;
    const estimatedTurns = buildTurns + travelTurns + (ferryCrossings * 2) + 1;

    // 10. Build affordability check (BE-001) — moved before scoring for JIRA-51
    const affordability = ContextBuilder.isBuildAffordable(
      totalTrackCost, snapshot.bot.money,
      snapshot.bot.loads, snapshot.bot.resolvedDemands,
      demand.payment,
    );

    // 11. Compute corridor value and demand score (JIRA-13, JIRA-51, JIRA-72)
    const corridorValue = ContextBuilder.computeCorridorValue(
      supplyCity, deliveryCity,
      snapshot.bot.existingSegments, gridPoints, connectedMajorCities,
      optimalStartingCity,
    );
    // JIRA-125: Amplify victory bonus in endgame — demands routing through
    // unconnected major cities become significantly more attractive when
    // the bot already has enough cash but needs city connections.
    let victoryMajorCitiesForScoring = corridorValue.victoryMajorCities;
    if (snapshot.bot.money >= 250 && connectedMajorCities.length < 7) {
      victoryMajorCitiesForScoring = corridorValue.victoryMajorCities * 3;
    }
    const demandScore = ContextBuilder.scoreDemand(
      demand.payment, totalTrackCost,
      corridorValue.networkCities, victoryMajorCitiesForScoring,
      estimatedTurns,
      affordability.affordable, affordability.projectedFunds,
    );
    const efficiencyPerTurn = (demand.payment - totalTrackCost) / estimatedTurns;

    return {
      cardIndex,
      loadType,
      supplyCity: supplyCity ?? 'OnTrain',
      deliveryCity,
      payout: demand.payment,
      isSupplyReachable,
      isDeliveryReachable,
      isSupplyOnNetwork: supplyCity ? citiesOnNetwork.includes(supplyCity) : false,
      isDeliveryOnNetwork: citiesOnNetwork.includes(deliveryCity),
      estimatedTrackCostToSupply,
      estimatedTrackCostToDelivery,
      isLoadAvailable,
      isLoadOnTrain,
      ferryRequired,
      loadChipTotal: totalCopies,
      loadChipCarried: carriedCount,
      estimatedTurns,
      demandScore,
      efficiencyPerTurn,
      networkCitiesUnlocked: corridorValue.networkCities,
      victoryMajorCitiesEnRoute: corridorValue.victoryMajorCities,
      isAffordable: affordability.affordable,
      projectedFundsAfterDelivery: affordability.projectedFunds,
      optimalStartingCity,
    };
  }

  // ── Opponent context (BE-006) ───────────────────────────────────────────

  /**
   * Filter and format opponent information based on skill level.
   * Easy: no opponents. Medium: position + cash. Hard: full info.
   */
  static buildOpponentContext(
    opponents: WorldSnapshot['opponents'],
    skillLevel: BotSkillLevel,
  ): OpponentContext[] {
    // Easy bots get no opponent info
    if (skillLevel === BotSkillLevel.Easy) return [];
    if (!opponents || opponents.length === 0) return [];

    return opponents.map(opp => {
      // Format position as a readable string
      const positionStr = opp.position
        ? `(${opp.position.row},${opp.position.col})`
        : 'unknown';

      if (skillLevel === BotSkillLevel.Medium) {
        // Medium: name, money, trainType, position only
        return {
          name: opp.playerId,
          money: opp.money,
          trainType: opp.trainType,
          position: positionStr,
          loads: [],
          trackCoverage: '',
        };
      }

      // Hard: full info including loads and track coverage
      return {
        name: opp.playerId,
        money: opp.money,
        trainType: opp.trainType,
        position: positionStr,
        loads: opp.loads,
        trackCoverage: opp.trackSummary ?? '',
      };
    });
  }

  // ── Prompt serialization (BE-007) ───────────────────────────────────────

  /**
   * Render GameContext into structured text for the LLM user prompt.
   * Follows PRD Section 4.3 template with skill-level-dependent detail.
   */
  static serializePrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
  ): string {
    const lines: string[] = [];

    // ── STRONG UPGRADE NUDGE (extreme cases — JIRA-55 Part D) ──
    if (
      context.trainType === 'Freight' &&
      context.turnNumber >= 15 &&
      context.money >= 60 &&
      (context.deliveryCount ?? 0) >= 5 // JIRA-60: only nudge after 5 deliveries (strong nudge is higher than the 4-delivery upgrade gate)
    ) {
      lines.push(`STRONG RECOMMENDATION: You are still on Freight at turn ${context.turnNumber}. UPGRADE to FastFreight this turn.`);
      lines.push('Every turn on Freight costs you ~3 mileposts of wasted movement. Output UPGRADE as your Phase B action.');
      lines.push('');
    }

    // ── TURN/PHASE header ──
    lines.push(`TURN ${context.turnNumber} \u2014 GAME PHASE: ${context.phase}`);
    // Game-clock awareness: humans typically win in ~100 turns; bots should not play as if game goes forever
    lines.push(`(Games typically last ~100 turns. Plan accordingly \u2014 upgrades and expensive track that cut travel time often pay off.)`);
    lines.push('');

    // ── TURN PRESSURE: escalate risk tolerance past midpoint ──
    if (context.turnNumber >= 40 && !context.isInitialBuild) {
      lines.push(`TURN PRESSURE: You are past turn 40. Favor upgrades and expensive track that significantly cuts travel time over conservative play. The game will not go on forever.`);
      lines.push('');
    }

    // ── PREVIOUS TURN (context continuity) ──
    if (context.previousTurnSummary) {
      lines.push('PREVIOUS TURN:');
      lines.push(`- ${context.previousTurnSummary}`);
      lines.push('⚠️ PLAN PERSISTENCE: You MUST continue your existing plan unless:');
      lines.push('  (a) The delivery was completed, or');
      lines.push('  (b) The load is no longer available (taken by opponent), or');
      lines.push('  (c) A dramatically better opportunity appeared (2x+ payout with less track needed).');
      lines.push('  Switching plans mid-execution wastes track already built. Stay the course.');
      lines.push('');
    }

    // ── YOUR STATUS ──
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city
        ? `${context.position.city} (${context.position.row},${context.position.col})`
        : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push(`- Build budget remaining this turn: ${20 - context.turnBuildCost}M`);
    lines.push('');

    // ── VICTORY PROGRESS ──
    const cashRemaining = Math.max(0, 250 - context.money);
    lines.push('VICTORY PROGRESS:');
    lines.push(`- Cash: ${context.money}M / 250M needed (${cashRemaining}M remaining)`);
    lines.push(`- Cities connected: ${context.connectedMajorCities.length}/7 needed (${context.connectedMajorCities.join(', ') || 'none'})`);

    if (context.unconnectedMajorCities.length === 0) {
      lines.push('- All cities connected! Earn more cash to win.');
    } else {
      const unconnectedStr = context.unconnectedMajorCities
        .map(u => `${u.cityName} (~${u.estimatedCost}M to connect)`)
        .join(', ');
      lines.push(`- Cities NOT connected: ${unconnectedStr}`);
      const nearest = context.unconnectedMajorCities[0];
      lines.push(`- Nearest unconnected city: ${nearest.cityName} (~${nearest.estimatedCost}M from your network)`);

      const cheapestCost = nearest.estimatedCost;
      if (context.money >= 250 && context.connectedMajorCities.length < 7) {
        lines.push(`- STRATEGIC PRIORITY: You have enough cash — focus ALL building budget on connecting [${context.unconnectedMajorCities.map(u => u.cityName).join(', ')}].`);
        // JIRA-125: Dynamic route selection directive for endgame
        lines.push(`- ROUTE SELECTION: Prefer demands whose supply or delivery city IS an unconnected major city. Building track toward these cities happens automatically — choose routes that take you there. Do NOT chase high-payout deliveries to non-major cities.`);
      } else if (cheapestCost > context.money) {
        lines.push(`- STRATEGIC PRIORITY: Earn more before connecting — cheapest unconnected city costs ~${cheapestCost}M, you have ${context.money}M.`);
      } else {
        lines.push(`- STRATEGIC PRIORITY: Connect ${nearest.cityName} (cheapest) while pursuing deliveries through that corridor.`);
      }
    }

    // Phase-appropriate victory directive
    if (context.phase === 'Victory Imminent' && context.unconnectedMajorCities.length > 0) {
      const last = context.unconnectedMajorCities[0];
      const cashNeeded = Math.max(0, 250 - context.money);
      lines.push(`- LATE-GAME DIRECTIVE: VICTORY IS IMMINENT: Connect ${last.cityName} (~${last.estimatedCost}M) and earn ${cashNeeded}M more. Take calculated risks \u2014 upgrades and expensive track that cut travel time in half are justified to close the gap.`);
    } else if (context.phase === 'Late Game' && context.unconnectedMajorCities.length > 0) {
      const citiesNeeded = 7 - context.connectedMajorCities.length;
      const cashNeeded = Math.max(0, 250 - context.money);
      const cheapest = context.unconnectedMajorCities[0];
      lines.push(`- LATE-GAME DIRECTIVE: You need ${citiesNeeded} more cities and ${cashNeeded}M more cash. Connect ${cheapest.cityName} (~${cheapest.estimatedCost}M) before chasing deliveries. Victory is within reach.`);
    } else if (context.phase === 'Mid Game' && context.unconnectedMajorCities.length > 0) {
      lines.push('- MID-GAME DIRECTIVE: Start routing deliveries through unconnected major cities when possible. Every major city you pass through counts toward victory.');
    }
    lines.push('');

    // ── YOUR DEMAND CARDS ──
    lines.push('YOUR DEMAND CARDS:');
    if (context.demands.length === 0) {
      lines.push('  No demand cards.');
    } else {
      // Group demands by cardIndex
      const cardGroups = new Map<number, typeof context.demands>();
      for (const d of context.demands) {
        if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
        cardGroups.get(d.cardIndex)!.push(d);
      }
      let cardNum = 0;
      for (const [, demands] of Array.from(cardGroups.entries())) {
        cardNum++;
        lines.push(`Card ${cardNum} (pick at most one):`);
        const labels = ['a', 'b', 'c', 'd', 'e'];
        for (let i = 0; i < demands.length; i++) {
          const d = demands[i];
          const label = labels[i] ?? `${i + 1}`;
          const note = ContextBuilder.formatReachabilityNote(d, skillLevel);
          const victoryBonus = ContextBuilder.formatVictoryBonus(d, context.unconnectedMajorCities);
          const suffix = victoryBonus ? ` \u2014 ${note} \u2014 ${victoryBonus}` : ` \u2014 ${note}`;
          lines.push(`  ${label}) ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)${suffix}`);
        }
      }

      // Build cardIndex → cardNum map for ranking annotation (JIRA-123)
      const cardIndexToNum = new Map<number, number>();
      let cardMapNum = 0;
      for (const [cardIdx] of Array.from(cardGroups.entries())) {
        cardMapNum++;
        cardIndexToNum.set(cardIdx, cardMapNum);
      }

      // Demand ranking by score (JIRA-13) — helps LLM prioritize
      const sorted = [...context.demands].sort((a, b) => b.demandScore - a.demandScore);
      lines.push('');
      lines.push('DEMAND RANKING (by investment value):');
      for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        const tag = i === 0 ? ' ← RECOMMENDED' : (d.demandScore < 0 ? ' (low priority)' : '');
        const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
        const cardLabel = cardIndexToNum.has(d.cardIndex) ? ` (Card ${cardIndexToNum.get(d.cardIndex)})` : '';
        lines.push(`  #${i + 1} ${d.loadType} ${d.supplyCity}→${d.deliveryCity}${cardLabel}: score ${d.demandScore} (payout: ${d.payout}M, build: ~${buildCost}M, ROI: ${d.payout - buildCost}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn, network: +${d.networkCitiesUnlocked} cities, victory: +${d.victoryMajorCitiesEnRoute} major)${tag}`);
      }
    }
    lines.push('');

    // ── IMMEDIATE OPPORTUNITIES ──
    lines.push('IMMEDIATE OPPORTUNITIES:');
    if (context.canDeliver.length > 0) {
      for (const opp of context.canDeliver) {
        lines.push(`- DELIVER ${opp.loadType} at ${opp.deliveryCity} for ${opp.payout}M! (DO THIS FIRST)`);
      }
    }
    if (context.canPickup.length > 0) {
      for (const opp of context.canPickup) {
        lines.push(`- PICKUP ${opp.loadType} here at ${opp.supplyCity} → deliver to ${opp.bestDeliveryCity} for ${opp.bestPayout}M`);
      }
    }
    if (context.canDeliver.length === 0 && context.canPickup.length === 0) {
      lines.push('- No deliveries or pickups available at your position.');
    }
    // Multi-action turn hints
    if (context.canPickup.length > 0) {
      // Check if any pickup's delivery city is reachable this turn (PICKUP → MOVE → DELIVER in one turn!)
      for (const opp of context.canPickup) {
        if (context.reachableCities.includes(opp.bestDeliveryCity)) {
          lines.push(`⚡ COMBO: PICKUP ${opp.loadType} here → MOVE to ${opp.bestDeliveryCity} → DELIVER for ${opp.bestPayout}M — all in ONE turn!`);
        }
      }
      if (context.canBuild) {
        lines.push('TIP: You can PICKUP then BUILD in the same turn using a multi-action sequence.');
      }
    }
    if (context.canDeliver.length > 0 && context.canBuild) {
      lines.push('TIP: After DELIVER, you can BUILD track in the same turn (up to 20M).');
    }
    lines.push('IMPORTANT: Only use DELIVER if a delivery is listed above. You must be AT the delivery city with the matching load to deliver.');
    if (context.loads.length > 0 && context.canDeliver.length === 0) {
      lines.push(`WARNING: You are carrying [${context.loads.join(', ')}] but cannot deliver here. MOVE toward a delivery city — do NOT pass your turn!`);
    }
    // Remind about using full movement
    if (context.speed > 0 && !context.isInitialBuild) {
      lines.push(`REMINDER: Use ALL ${context.speed} movement points each turn. Stopping early wastes your turn. Loading/unloading costs ZERO movement.`);
    }
    lines.push('');

    // ── EN-ROUTE PICKUPS (JIRA-87) ──
    if (context.enRoutePickups && context.enRoutePickups.length > 0) {
      lines.push('EN-ROUTE PICKUPS (near your route):');
      for (const p of context.enRoutePickups) {
        const detour = p.onRoute ? 'on route' : `${p.detourMileposts} mp detour`;
        lines.push(`- ${p.city}: ${p.load} → ${p.demandCity} ${p.payoff}M (${detour})`);
      }
      lines.push('');
    }

    // ── CITIES REACHABLE ──
    if (context.reachableCities.length > 0) {
      lines.push(`CITIES REACHABLE THIS TURN (within speed ${context.speed} on existing track):`);
      lines.push(context.reachableCities.join(', '));
    } else {
      lines.push('CITIES REACHABLE THIS TURN: None (no track or no position).');
    }
    lines.push('');

    // ── CITIES ON YOUR TRACK NETWORK (multi-turn destinations) ──
    const networkOnlyCities = context.citiesOnNetwork.filter(
      c => !context.reachableCities.includes(c),
    );
    if (networkOnlyCities.length > 0) {
      lines.push('CITIES ON YOUR TRACK NETWORK (reachable by MOVE in multiple turns):');
      lines.push(networkOnlyCities.join(', '));
      lines.push('TIP: Use MOVE to travel along your track toward these cities for pickup/delivery.');
      lines.push('');
    }

    // ── UPGRADE OPTIONS (JIRA-55 Part B, JIRA-105: lowered gates) ──
    // Gate: mention upgrades after 1+ delivery with >= 30M cash
    const upgradeEligible = (context.deliveryCount ?? 0) >= MIN_DELIVERIES_BEFORE_UPGRADE && context.money >= 30;
    if (upgradeEligible && context.upgradeAdvice) {
      const strongUpgrade = context.trainType === 'Freight' &&
        context.turnNumber >= 8;
      if (strongUpgrade) {
        lines.push(`RECOMMENDED PHASE B ACTION: UPGRADE to FastFreight \u2014 {"action": "UPGRADE", "details": {"to": "FastFreight"}}`);
        lines.push(`You've been on Freight for ${context.turnNumber} turns. +3 speed saves ~1 turn per delivery.`);
        lines.push(context.upgradeAdvice);
      } else {
        lines.push(`UPGRADE ADVICE: ${context.upgradeAdvice}`);
      }
    } else if (upgradeEligible && context.canUpgrade) {
      lines.push('YOU CAN UPGRADE: Check available train types (20M for upgrade, 5M for crossgrade).');
    }

    // ── BUILD CONSTRAINTS ──
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build \u2014 build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Apply the GEOGRAPHIC STRATEGY and CAPITAL VELOCITY principles from your instructions to choose where to build first.');
    }
    if (!context.canBuild) {
      lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    }

    // ── OPPONENTS ──
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if (opp.recentBuildDirection) parts.push(`building toward ${opp.recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Render a route-planning-specific prompt with corridor data and turn estimates.
   * Used by planRoute() — excludes per-turn noise (immediate opportunities, reachable cities)
   * and adds demand corridors + on-the-way signals.
   */
  static serializeRoutePlanningPrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
    segments: TrackSegment[] = [],
    lastAbandonedRouteKey?: string | null,
    previousRouteStops?: RouteStop[] | null, // BE-010
  ): string {
    const lines: string[] = [];

    // ── TURN/PHASE header ──
    lines.push(`TURN ${context.turnNumber} \u2014 GAME PHASE: ${context.phase}`);
    lines.push(`(Games typically last ~100 turns. Prefer routes that cut travel time \u2014 expensive track that halves a route pays off.)`);
    if (context.turnNumber >= 40 && !context.isInitialBuild) {
      lines.push(`TURN PRESSURE: Past turn 40. Favor speed and expensive shortcuts.`);
    }
    lines.push('');

    // ── YOUR STATUS (same as serializePrompt) ──
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city
        ? `${context.position.city} (${context.position.row},${context.position.col})`
        : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push('');

    // ── VICTORY PROGRESS (same as serializePrompt) ──
    const cashRemaining = Math.max(0, 250 - context.money);
    lines.push('VICTORY PROGRESS:');
    lines.push(`- Cash: ${context.money}M / 250M needed (${cashRemaining}M remaining)`);
    lines.push(`- Cities connected: ${context.connectedMajorCities.length}/7 needed (${context.connectedMajorCities.join(', ') || 'none'})`);

    if (context.unconnectedMajorCities.length === 0) {
      lines.push('- All cities connected! Earn more cash to win.');
    } else {
      const unconnectedStr = context.unconnectedMajorCities
        .map(u => `${u.cityName} (~${u.estimatedCost}M to connect)`)
        .join(', ');
      lines.push(`- Cities NOT connected: ${unconnectedStr}`);
      // JIRA-125: Dynamic route selection directive for endgame (route planning)
      if (context.money >= 250 && context.connectedMajorCities.length < 7) {
        lines.push(`- ROUTE SELECTION: Prefer demands whose supply or delivery city IS an unconnected major city. Building track toward these cities happens automatically — choose routes that take you there. Do NOT chase high-payout deliveries to non-major cities.`);
      }
    }
    lines.push('');

    // ── YOUR DEMAND CARDS (with turn estimates and scarcity) ──
    lines.push('=== YOUR DEMAND CARDS (cards in your hand) ===');
    lines.push('You may ONLY plan deliveries for demands listed below. Do not reference loads or cities not shown here.');
    if (context.demands.length === 0) {
      lines.push('  No demand cards.');
    } else {
      const cardGroups = new Map<number, typeof context.demands>();
      for (const d of context.demands) {
        if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
        cardGroups.get(d.cardIndex)!.push(d);
      }
      let cardNum = 0;
      const cardBestSummaries: string[] = [];
      let corePlayableCount = 0;
      for (const [, demands] of Array.from(cardGroups.entries())) {
        cardNum++;
        const best = ContextBuilder.bestDemandForCard(demands);
        const bestRegion = ContextBuilder.cityRegionTag(best.deliveryCity);
        const ferryTag = best.ferryRequired ? ', ferry' : '';
        cardBestSummaries.push(
          `Card ${cardNum}: best=${best.loadType}\u2192${best.deliveryCity} ${best.payout}M (${bestRegion}${ferryTag})`,
        );
        if (bestRegion === 'core' && !best.ferryRequired) corePlayableCount++;

        lines.push(`Card ${cardNum} (pick at most one):`);
        const labels = ['a', 'b', 'c', 'd', 'e'];
        for (let i = 0; i < demands.length; i++) {
          const d = demands[i];
          const label = labels[i] ?? `${i + 1}`;
          const isBest = d === best;
          const bestTag = isBest ? ' \u2605 BEST' : '';
          const note = ContextBuilder.formatReachabilityNote(d, skillLevel);
          const turnEst = `~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn`;
          const victoryBonus = ContextBuilder.formatVictoryBonus(d, context.unconnectedMajorCities);
          let suffix = ` \u2014 ${note}, ${turnEst}`;
          if (victoryBonus) suffix += ` \u2014 ${victoryBonus}`;
          lines.push(`  ${label}) ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)${suffix}${bestTag}`);
        }
      }

      // HAND QUALITY summary (JIRA-16)
      lines.push('');
      lines.push(`HAND QUALITY: ${cardBestSummaries.join('. ')}. Hand quality: ${corePlayableCount}/${cardNum} cards playable in core.`);

      // Build cardIndex → cardNum map for ranking annotation (JIRA-123)
      const cardIndexToNumRP = new Map<number, number>();
      let cardMapNumRP = 0;
      for (const [cardIdx] of Array.from(cardGroups.entries())) {
        cardMapNumRP++;
        cardIndexToNumRP.set(cardIdx, cardMapNumRP);
      }

      // Demand ranking by score (JIRA-13)
      const sorted = [...context.demands].sort((a, b) => b.demandScore - a.demandScore);
      lines.push('');
      lines.push('DEMAND RANKING (by investment value):');
      for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        const tag = i === 0 ? ' ← RECOMMENDED' : (d.demandScore < 0 ? ' (low priority)' : '');
        const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
        const cardLabel = cardIndexToNumRP.has(d.cardIndex) ? ` (Card ${cardIndexToNumRP.get(d.cardIndex)})` : '';
        lines.push(`  #${i + 1} ${d.loadType} ${d.supplyCity}→${d.deliveryCity}${cardLabel}: score ${d.demandScore} (payout: ${d.payout}M, build: ~${buildCost}M, ROI: ${d.payout - buildCost}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn, network: +${d.networkCitiesUnlocked} cities, victory: +${d.victoryMajorCitiesEnRoute} major)${tag}`);
      }
    }
    lines.push('');

    // ── DEMAND CORRIDORS ──
    const corridors = ContextBuilder.computeCorridors(context.demands, gridPoints);
    ContextBuilder.detectOnTheWay(corridors, context.demands, gridPoints);

    if (corridors.length > 0) {
      lines.push('DEMAND CORRIDORS (demands sharing routes \u2014 combine for efficiency):');
      for (let ci = 0; ci < corridors.length; ci++) {
        const c = corridors[ci];
        const corridorLabel = String.fromCharCode(65 + ci); // A, B, C...
        lines.push(`  Corridor ${corridorLabel} (${c.sharedDeliveryArea}):`);
        for (const idx of c.demandIndices) {
          const d = context.demands[idx];
          lines.push(`    - ${d.loadType} ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)`);
        }
        lines.push(`    Combined payout: ${c.combinedPayout}M, shared track: ~${c.combinedTrackCost}M`);
        if (c.onTheWayDemands.length > 0) {
          for (const otwIdx of c.onTheWayDemands) {
            const d = context.demands[otwIdx];
            lines.push(`    ON THE WAY: ${d.loadType} ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M, near-zero extra cost)`);
          }
        }
      }
      lines.push('');
    }

    // ── PROXIMITY CONTEXT (JIRA-10) ──
    // Only include proximity sections when the bot has track segments
    if (segments.length > 0) {
      // Collect route stop cities from demands (supply + delivery)
      const routeStopCities = new Set<string>();
      for (const d of context.demands) {
        routeStopCities.add(d.supplyCity);
        routeStopCities.add(d.deliveryCity);
      }

      const nearbyCities = ContextBuilder.computeNearbyCities(
        Array.from(routeStopCities), gridPoints, segments,
      );
      if (nearbyCities.length > 0) {
        lines.push('NEARBY CITIES (per route stop):');
        for (const entry of nearbyCities) {
          const citiesStr = entry.nearbyCities
            .map(c => `${c.city} (${c.estimatedCost}M, ${c.distance} hexes)`)
            .join(', ');
          lines.push(`  ${entry.routeStop}: ${citiesStr}`);
        }
        lines.push('');
      }

      const unconnected = ContextBuilder.computeUnconnectedDemandCosts(
        context.demands, segments, gridPoints,
      );
      if (unconnected.length > 0) {
        lines.push('UNCONNECTED DEMAND CITIES (build costs):');
        for (const u of unconnected) {
          const d = context.demands[u.demandIndex];
          lines.push(`  ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M payout): ${u.city} needs ~${u.estimatedCost}M track to connect`);
        }
        lines.push('');
      }

      const resourceProx = ContextBuilder.computeResourceProximity(
        context.demands, segments, gridPoints,
      );
      if (resourceProx.length > 0) {
        lines.push('RESOURCE PROXIMITY (cheap pickups near your track):');
        for (const r of resourceProx) {
          lines.push(`  ${r.loadType} available at ${r.supplyCity}, ~${r.estimatedCost}M from your network (${r.distanceFromNetwork} hexes)`);
        }
        lines.push('');
      }
    }

    // ── BUILD CONSTRAINTS ──
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build \u2014 build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Use GEOGRAPHIC STRATEGY and HAND EVALUATION from the system prompt to choose your first demand. Prioritise capital velocity.');
      lines.push('STARTING CITY: You will place your train at any major city before moving.');
      lines.push('Choose your starting city AND first delivery together:');
      lines.push('- Start at or near a supply city so you can pick up immediately on turn 3');
      lines.push('- Prefer demands where supply\u2192delivery is short and affordable within 40M total budget');
      lines.push('- A demand with supply at a major city lets you start there and pick up without traveling');
    }
    if (!context.canBuild) {
      lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    }

    // ── OPPONENTS ──
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if (opp.recentBuildDirection) parts.push(`building toward ${opp.recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }

    // ── RECENTLY ABANDONED ROUTE (BE-005) ──
    if (lastAbandonedRouteKey) {
      lines.push('');
      lines.push(`RECENTLY ABANDONED ROUTE: ${lastAbandonedRouteKey}`);
      lines.push('Avoid planning a route identical to this one — it was abandoned because it could not be completed.');
    }

    // ── PREVIOUS ROUTE CONTEXT (BE-010) ──
    if (previousRouteStops && previousRouteStops.length > 0) {
      lines.push('');
      lines.push('PREVIOUS ROUTE (remaining stops from partially completed route):');
      for (const stop of previousRouteStops) {
        const paymentStr = stop.payment ? ` for ${stop.payment}M` : '';
        lines.push(`  - ${stop.action} ${stop.loadType} at ${stop.city}${paymentStr}`);
      }
      lines.push('Consider continuing this route if the stops are still valid with your current demand cards. You may also extend, modify, or abandon it.');
    }

    return lines.join('\n');
  }

  /**
   * Format a reachability note for a demand, following PRD Section 4.4.
   * Detail level varies by skill level (Easy = simple, Medium/Hard = with costs).
   */
  private static formatReachabilityNote(
    d: DemandContext,
    skillLevel: BotSkillLevel,
  ): string {
    // Load unavailable overrides everything
    if (!d.isLoadAvailable) {
      return `UNAVAILABLE \u2014 all ${d.loadType} copies on other trains.`;
    }

    // JIRA-82: No supply cities have available chips (all copies in tray or carried)
    if (d.supplyCity === 'NoSupply') {
      return `UNAVAILABLE \u2014 no ${d.loadType} available at any supply city.`;
    }

    // Compute scarcity suffix (appended to all return values below)
    const scarcitySuffix = (d.loadChipCarried >= d.loadChipTotal - 1 && d.isLoadAvailable)
      ? `. SCARCE: ${d.loadChipCarried}/${d.loadChipTotal} carried`
      : '';

    const ferry = d.ferryRequired ? ' Requires ferry crossing (movement penalty).' : '';

    // Helper: flag costs — never says "DO NOT pursue" (JIRA-13 fix)
    const affordabilityTag = (cost: number): string => {
      if (cost <= 0) return '';
      const turnsNeeded = Math.ceil(cost / 20);
      if (turnsNeeded > 1) {
        return ` (~${cost}M track needed, ${turnsNeeded} build turns)`;
      }
      return ` (~${cost}M track needed)`;
    };

    // Load is on train
    if (d.isLoadOnTrain) {
      if (d.isDeliveryReachable) {
        return `DELIVERABLE NOW for ${d.payout}M${ferry}${scarcitySuffix}`;
      }
      if (d.isDeliveryOnNetwork) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} ON YOUR TRACK — MOVE toward it!${ferry}${scarcitySuffix}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} not reachable.${ferry}${scarcitySuffix}`;
      }
      return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} needs track${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
    }

    // Supply + delivery reachability
    if (d.isSupplyReachable && d.isDeliveryReachable) {
      return `Supply at ${d.supplyCity} (reachable). Delivery reachable.${ferry}${scarcitySuffix}`;
    }
    if (d.isSupplyReachable && !d.isDeliveryReachable) {
      if (d.isDeliveryOnNetwork) {
        return `Supply at ${d.supplyCity} (reachable). Delivery at ${d.deliveryCity} ON YOUR TRACK (multi-turn MOVE).${ferry}${scarcitySuffix}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `Supply at ${d.supplyCity} (reachable). Delivery not reachable.${ferry}${scarcitySuffix}`;
      }
      return `Supply at ${d.supplyCity} (reachable). Delivery needs${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
    }

    // Supply on network but not reachable this turn
    if (d.isSupplyOnNetwork) {
      const deliveryNote = d.isDeliveryOnNetwork
        ? `Delivery at ${d.deliveryCity} also on track.`
        : `Delivery needs track.`;
      return `Supply at ${d.supplyCity} ON YOUR TRACK — MOVE toward it! ${deliveryNote}${ferry}${scarcitySuffix}`;
    }

    // Supply not reachable
    if (skillLevel === BotSkillLevel.Easy) {
      return `Supply not reachable.${ferry}${scarcitySuffix}`;
    }
    const totalCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    return `Supply not reachable${affordabilityTag(totalCost)}.${ferry}${scarcitySuffix}`;
  }

  /**
   * Format VICTORY BONUS note when a demand's supply or delivery city is unconnected.
   * Encourages routing through unconnected major cities for victory progress.
   */
  private static formatVictoryBonus(
    d: DemandContext,
    unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>,
  ): string {
    const unconnected = unconnectedMajorCities.filter(
      (u) => u.cityName === d.supplyCity || u.cityName === d.deliveryCity,
    );
    if (unconnected.length === 0) return '';
    const parts = unconnected.map(
      (u) => `route passes near ${u.cityName} (unconnected, ~${u.estimatedCost}M to connect)`,
    );
    return `VICTORY BONUS: ${parts.join('; ')}`;
  }

  /**
   * Identify the "best" demand on a card — cheapest to reach in the core network.
   * Heuristic priority: (1) both supply+delivery on network, (2) lowest track cost,
   * (3) core cities over peripheral.
   */
  private static bestDemandForCard(demands: DemandContext[]): DemandContext {
    if (demands.length === 1) return demands[0];

    const scored = demands.map((d) => {
      let score = 0;
      // Highest priority: both endpoints on existing network
      if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) score += 1000;
      else if (d.isSupplyOnNetwork || d.isDeliveryOnNetwork) score += 500;
      // Penalise track cost (lower is better)
      score -= (d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery);
      // Prefer core cities
      if (CORE_CITIES.has(d.supplyCity)) score += 20;
      if (CORE_CITIES.has(d.deliveryCity)) score += 20;
      // Penalise ferry
      if (d.ferryRequired) score -= 50;
      // Prefer available loads
      if (!d.isLoadAvailable) score -= 200;
      return { d, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].d;
  }

  /**
   * Classify a city as 'core' or 'peripheral' for the hand quality summary.
   */
  private static cityRegionTag(city: string): 'core' | 'peripheral' {
    return CORE_CITIES.has(city) ? 'core' : 'peripheral';
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Compute all demand contexts from the snapshot's resolved demands */
  private static computeAllDemandContexts(
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContext[] {
    const contexts: DemandContext[] = [];
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        contexts.push(
          ContextBuilder.computeBestDemandContext(
            resolved.cardId, demand, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
          ),
        );
      }
    }
    return contexts;
  }

  /** Compute immediate delivery opportunities at current position */
  private static computeCanDeliver(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DeliveryOpportunity[] {
    if (!snapshot.bot.position) return [];
    const cityName = ContextBuilder.getCityNameAtPosition(snapshot.bot.position, gridPoints);
    if (!cityName) return [];

    const opportunities: DeliveryOpportunity[] = [];
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        if (
          demand.city === cityName &&
          snapshot.bot.loads.includes(demand.loadType)
        ) {
          opportunities.push({
            loadType: demand.loadType,
            deliveryCity: demand.city,
            payout: demand.payment,
            cardIndex: resolved.cardId,
          });
        }
      }
    }
    return opportunities;
  }

  /**
   * Compute loads the bot can pick up at its current position.
   * Matches available loads at the city against demand cards for strategic relevance.
   * Only includes loads the bot has capacity for and that match a demand card.
   */
  private static computeCanPickup(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): PickupOpportunity[] {
    if (!snapshot.bot.position) return [];
    if (snapshot.gameStatus === 'initialBuild') return [];

    const trainType = snapshot.bot.trainType as TrainType;
    const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
    if (snapshot.bot.loads.length >= capacity) return [];

    const cityName = ContextBuilder.getCityNameAtPosition(snapshot.bot.position, gridPoints);
    if (!cityName) return [];

    // Find what loads are available at this city using the snapshot's loadAvailability
    // (populated by WorldSnapshotService from LoadService — canonical source of truth)
    const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
    if (availableLoads.length === 0) return [];

    // Match against demand cards — only suggest pickups that help fulfill demands
    const opportunities: PickupOpportunity[] = [];
    for (const loadType of availableLoads) {
      // Skip if bot is already carrying this load type
      if (snapshot.bot.loads.includes(loadType)) continue;

      // Find the best-paying demand card for this load
      let bestPayout = 0;
      let bestDeliveryCity = '';
      for (const resolved of snapshot.bot.resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType && demand.payment > bestPayout) {
            bestPayout = demand.payment;
            bestDeliveryCity = demand.city;
          }
        }
      }

      if (bestPayout > 0) {
        opportunities.push({
          loadType,
          supplyCity: cityName,
          bestPayout,
          bestDeliveryCity,
        });
      }
    }

    return opportunities;
  }

  /**
   * Scan cities within 3 hex distance of the bot's route stops for loads
   * matching demand cards. Returns top 5 opportunities sorted by net value.
   * Called post-build from AIStrategyEngine and injected into context.
   */
  static computeEnRoutePickups(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    gridPoints: GridPoint[],
  ): EnRoutePickup[] {
    if (!routeStops || routeStops.length === 0) return [];
    if (snapshot.gameStatus === 'initialBuild') return [];

    const SCAN_RADIUS = 3;
    const MAX_RESULTS = 5;

    // Build lookup: city name → grid coordinates
    const cityCoords = new Map<string, { row: number; col: number }>();
    for (const gp of gridPoints) {
      if (gp.city?.name && !cityCoords.has(gp.city.name)) {
        cityCoords.set(gp.city.name, { row: gp.row, col: gp.col });
      }
    }

    // Collect route stop coordinates
    const routeCoordsList: Array<{ row: number; col: number }> = [];
    const routeCityNames = new Set<string>();
    for (const stop of routeStops) {
      const coord = cityCoords.get(stop.city);
      if (coord) {
        routeCoordsList.push(coord);
        routeCityNames.add(stop.city);
      }
    }
    if (routeCoordsList.length === 0) return [];

    // Build set of demanded load types → { demandCity, payoff }
    const demandMap = new Map<string, { demandCity: string; payoff: number }>();
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        const existing = demandMap.get(demand.loadType);
        if (!existing || demand.payment > existing.payoff) {
          demandMap.set(demand.loadType, {
            demandCity: demand.city,
            payoff: demand.payment,
          });
        }
      }
    }
    if (demandMap.size === 0) return [];

    // Scan all cities within SCAN_RADIUS of any route stop
    const results: EnRoutePickup[] = [];
    const seenCityLoad = new Set<string>();

    for (const [cityName, coord] of cityCoords) {
      let minDist = Infinity;
      for (const routeCoord of routeCoordsList) {
        const dist = hexDistance(coord.row, coord.col, routeCoord.row, routeCoord.col);
        if (dist < minDist) minDist = dist;
      }
      if (minDist > SCAN_RADIUS) continue;

      const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
      for (const loadType of availableLoads) {
        const key = `${cityName}:${loadType}`;
        if (seenCityLoad.has(key)) continue;
        seenCityLoad.add(key);

        if (snapshot.bot.loads.includes(loadType)) continue;

        const demand = demandMap.get(loadType);
        if (!demand) continue;

        results.push({
          city: cityName,
          load: loadType,
          demandCity: demand.demandCity,
          payoff: demand.payoff,
          detourMileposts: minDist,
          onRoute: routeCityNames.has(cityName) || minDist === 0,
        });
      }
    }

    results.sort((a, b) => (b.payoff - b.detourMileposts) - (a.payoff - a.detourMileposts));
    return results.slice(0, MAX_RESULTS);
  }

  /**
   * JIRA-89: Build user prompt for the secondary delivery evaluation LLM call.
   * Includes planned route, remaining demands (excluding primary), and near-route loads.
   */
  static serializeSecondaryDeliveryPrompt(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    demands: DemandContext[],
    enRoutePickups: EnRoutePickup[],
  ): string {
    const lines: string[] = [];
    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Cash: ${snapshot.bot.money}M | Train: ${snapshot.bot.trainType} | Loads: ${snapshot.bot.loads.join(', ') || 'none'}`);

    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    lines.push(`Cargo capacity: ${snapshot.bot.loads.length}/${capacity} (${capacity - snapshot.bot.loads.length} free slots)`);
    lines.push('');

    lines.push('PLANNED ROUTE:');
    for (const stop of routeStops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    lines.push('');

    // Exclude demands already being fulfilled by the primary route
    const primaryLoadTypes = new Set(routeStops.filter(s => s.action === 'pickup').map(s => s.loadType));
    const remainingDemands = demands.filter(d => !primaryLoadTypes.has(d.loadType));

    lines.push('YOUR OTHER DEMAND CARDS (not part of primary route):');
    if (remainingDemands.length === 0) {
      lines.push('  (none — all demands are part of the primary route)');
    } else {
      for (const d of remainingDemands) {
        lines.push(`  ${d.loadType}: ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M, ~${d.estimatedTurns} turns)`);
      }
    }
    lines.push('');

    lines.push('AVAILABLE LOADS NEAR YOUR ROUTE:');
    if (enRoutePickups.length === 0) {
      lines.push('  (none found within scan radius)');
    } else {
      for (const p of enRoutePickups) {
        lines.push(`  ${p.load} at ${p.city} → deliver to ${p.demandCity} (${p.payoff}M, ${p.onRoute ? 'ON ROUTE' : `${p.detourMileposts}mp detour`})`);
      }
    }
    lines.push('');
    lines.push('Should you add a secondary pickup to this route?');

    return lines.join('\n');
  }

  /**
   * JIRA-92: Serialize context for cargo conflict evaluation.
   *
   * Builds a focused prompt showing the planned route value vs carried load delivery details,
   * so the LLM can decide whether to drop carried cargo to free slots for the better route.
   */
  static serializeCargoConflictPrompt(
    snapshot: WorldSnapshot,
    plannedRoute: StrategicRoute,
    conflictingLoads: string[],
    demands: DemandContext[],
  ): string {
    const lines: string[] = [];
    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    const freeSlots = capacity - snapshot.bot.loads.length;

    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Train: ${snapshot.bot.trainType} (capacity ${capacity}, speed ${TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9})`);
    lines.push(`Cash: ${snapshot.bot.money}M`);
    lines.push(`Carried loads: ${snapshot.bot.loads.join(', ') || 'none'}`);
    lines.push(`Free slots: ${freeSlots} of ${capacity}`);
    lines.push('');

    // Planned route summary
    const routeStops = plannedRoute.stops;
    const pickupCount = routeStops.filter(s => s.action === 'pickup').length;
    const totalPayout = routeStops
      .filter(s => s.action === 'deliver' && s.payment)
      .reduce((sum, s) => sum + (s.payment ?? 0), 0);

    lines.push('PLANNED ROUTE:');
    for (const stop of routeStops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    lines.push(`  Pickups needed: ${pickupCount} | Total payout: ${totalPayout}M`);
    lines.push('');

    // Conflicting carried loads — loads NOT in the route's delivery plan
    lines.push('CARRIED LOADS BLOCKING THE ROUTE (not part of planned deliveries):');
    for (const loadType of conflictingLoads) {
      // Find the best demand context for this carried load
      const demandCtx = demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
      if (demandCtx) {
        const trackCost = demandCtx.estimatedTrackCostToDelivery;
        const netProfit = demandCtx.payout - trackCost;
        const onNetwork = trackCost === 0 ? 'YES — delivery on existing network' : 'NO — requires building track';
        lines.push(`  ${loadType} → ${demandCtx.deliveryCity}: ${demandCtx.payout}M payout, ~${trackCost}M track cost, ~${demandCtx.estimatedTurns} turns, net profit: ${netProfit}M`);
        lines.push(`    Delivery on network: ${onNetwork}`);
        lines.push(`    Efficiency: ${demandCtx.efficiencyPerTurn.toFixed(1)}M/turn`);
      } else {
        // No demand context found — load has no matching demand card (shouldn't happen, but be safe)
        lines.push(`  ${loadType} → no matching demand card found`);
      }
    }
    lines.push('');

    // Full demand ranking for context
    lines.push('YOUR DEMAND CARDS:');
    for (let i = 0; i < demands.length; i++) {
      const d = demands[i];
      const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
      const tag = d.isLoadOnTrain ? ' [ON TRAIN]' : '';
      lines.push(`  #${i + 1} ${d.loadType} ${d.supplyCity}→${d.deliveryCity}: ${d.payout}M, build ~${buildCost}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn${tag}`);
    }
    lines.push('');

    lines.push(`CARGO CONFLICT: Your planned route needs ${pickupCount} pickup slots but you only have ${freeSlots} free.`);
    lines.push('Should you DROP any of the carried loads listed above to free slots for the planned route?');

    return lines.join('\n');
  }

  /**
   * JIRA-105b: Serialize context for upgrade-before-drop evaluation.
   *
   * Builds a focused prompt showing upgrade cost vs route payout and the value
   * of the load that would be dropped, so the LLM can decide whether to upgrade.
   */
  static serializeUpgradeBeforeDropPrompt(
    snapshot: WorldSnapshot,
    route: StrategicRoute,
    upgradeOptions: { targetTrain: string; cost: number }[],
    totalRoutePayout: number,
    demands: DemandContext[],
  ): string {
    const lines: string[] = [];
    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    const freeSlots = capacity - snapshot.bot.loads.length;

    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Train: ${snapshot.bot.trainType} (capacity ${capacity}, speed ${TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9})`);
    lines.push(`Cash: ${snapshot.bot.money}M`);
    lines.push(`Carried loads: ${snapshot.bot.loads.join(', ') || 'none'}`);
    lines.push(`Free slots: ${freeSlots} of ${capacity}`);
    lines.push('');

    // Route summary with payouts
    lines.push('PLANNED ROUTE:');
    for (const stop of route.stops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    const pickupCount = route.stops.filter(s => s.action === 'pickup').length;
    lines.push(`  Pickups needed: ${pickupCount} | Total route payout: ${totalRoutePayout}M`);
    lines.push('');

    // Upgrade options
    lines.push('AVAILABLE UPGRADES (capacity-increasing):');
    for (const opt of upgradeOptions) {
      const targetCap = TRAIN_PROPERTIES[opt.targetTrain as TrainType]?.capacity ?? 3;
      const targetSpeed = TRAIN_PROPERTIES[opt.targetTrain as TrainType]?.speed ?? 9;
      const netBenefit = totalRoutePayout - opt.cost;
      lines.push(`  ${opt.targetTrain} (capacity ${targetCap}, speed ${targetSpeed}) — cost: ${opt.cost}M, net benefit: ${netBenefit}M`);
    }
    lines.push('');

    // Identify the load most likely to be dropped (carried loads not in route delivery)
    const routeDeliveryLoads = new Set(
      route.stops.filter(s => s.action === 'deliver').map(s => s.loadType),
    );
    const conflictingLoads = snapshot.bot.loads.filter(l => !routeDeliveryLoads.has(l));
    if (conflictingLoads.length > 0) {
      lines.push('LOAD THAT WOULD BE DROPPED IF NOT UPGRADING:');
      for (const loadType of conflictingLoads) {
        const demandCtx = demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
        if (demandCtx) {
          lines.push(`  ${loadType} → ${demandCtx.deliveryCity}: ${demandCtx.payout}M payout, ~${demandCtx.estimatedTrackCostToDelivery}M track cost, ~${demandCtx.estimatedTurns} turns`);
        } else {
          lines.push(`  ${loadType} → no matching demand card found`);
        }
      }
      lines.push('');
    }

    lines.push(`DECISION: You need ${pickupCount} pickup slots but only have ${freeSlots} free.`);
    lines.push(`Upgrading costs ${upgradeOptions[0]?.cost ?? 20}M but lets you carry all ${pickupCount + snapshot.bot.loads.length} loads.`);
    lines.push('Should you UPGRADE your train or SKIP and drop a load instead?');

    return lines.join('\n');
  }

  /** Generate dynamic upgrade advice with ROI data (JIRA-55 Part C) */
  private static computeUpgradeAdvice(
    snapshot: WorldSnapshot,
    demands: DemandContext[] = [],
    canBuild: boolean = true,
  ): string | undefined {
    if (snapshot.gameStatus === 'initialBuild') return undefined;
    const trainType = snapshot.bot.trainType as TrainType;
    const money = snapshot.bot.money;
    const turn = snapshot.turnNumber;

    if (trainType === TrainType.Superfreight) return undefined;

    const parts: string[] = [];

    // ROI data: compute avg route length and whether meaningful build exists
    const avgRouteLength = demands.length > 0
      ? Math.round(demands.reduce((sum, d) => sum + d.estimatedTurns * 9, 0) / demands.length)
      : 0;
    const maxBuildCost = Math.max(0, ...demands.map(d => d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery));
    const remainingBuildBudget = Math.min(20, money);
    const hasMeaningfulBuild = canBuild && maxBuildCost > 5 && remainingBuildBudget >= 5;

    if (trainType === TrainType.Freight) {
      if (turn >= 15 && money >= 20) {
        parts.push(`URGENT: Still on Freight at turn ${turn}. Upgrade NOW — every turn without Fast Freight or Heavy Freight costs you efficiency.`);
      } else if (turn >= 10 && money >= 20) {
        parts.push(`WARNING: Still on basic Freight at turn ${turn}. No one wins this game on Freight — upgrade to Fast Freight or Heavy Freight NOW.`);
      }
      if (money >= 20) {
        parts.push('Fast Freight (20M): +3 speed saves ~1 turn per delivery — almost always the best first upgrade. Heavy Freight (20M): +1 cargo slot for corridor deliveries.');
      }
      // ROI enrichment
      if (avgRouteLength > 15 && money >= 20) {
        parts.push(`Avg route ~${avgRouteLength} mileposts \u2014 Fast Freight saves ~1 turn per delivery at this distance.`);
      }
      if (!hasMeaningfulBuild && money >= 20) {
        parts.push('No route-critical build target this turn \u2014 upgrade is better value than building.');
      }
    } else if (trainType === TrainType.FastFreight || trainType === TrainType.HeavyFreight) {
      if (money >= 20) {
        parts.push(`Superfreight available (20M): 12 speed + 3 cargo. The endgame train \u2014 upgrade when no high-value build target exists.`);
      }
      if (money >= 5 && money < 20) {
        const other = trainType === TrainType.FastFreight ? 'Heavy Freight (3 cargo)' : 'Fast Freight (12 speed)';
        parts.push(`Crossgrade to ${other} for only 5M (and still build up to 15M this turn).`);
      }
      // ROI for mid-tier: note if no meaningful build
      if (!hasMeaningfulBuild && money >= 20) {
        parts.push('No route-critical build target \u2014 consider Superfreight upgrade.');
      }
    }

    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  /** Check whether the bot can afford and is eligible for a train upgrade */
  private static checkCanUpgrade(snapshot: WorldSnapshot): boolean {
    if (snapshot.gameStatus === 'initialBuild') return false;
    if (snapshot.bot.money < 5) return false;

    const trainType = snapshot.bot.trainType as TrainType;
    switch (trainType) {
      case TrainType.Freight:
        return snapshot.bot.money >= 20;
      case TrainType.FastFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.HeavyFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.Superfreight:
        return false;
      default:
        return false;
    }
  }

  /** Determine the current game phase string */
  private static computePhase(
    snapshot: WorldSnapshot,
    connectedMajorCities: string[],
  ): string {
    if (snapshot.gameStatus === 'initialBuild') return 'Initial Build';
    // JIRA-125: 5+ cities with 250M+ is functionally in victory mode — needs cities, not cash
    if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 250) return 'Victory Imminent';
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 150) return 'Late Game';
    if (connectedMajorCities.length >= 3 || snapshot.bot.money >= 80) return 'Mid Game';
    return 'Early Game';
  }

  /** Compute unconnected major cities with estimated track cost from current network */
  private static computeUnconnectedMajorCities(
    connectedMajorCities: string[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ cityName: string; estimatedCost: number }> {
    const allMajorCityNames = getMajorCityGroups().map(g => g.cityName);
    const connectedSet = new Set(connectedMajorCities);
    const unconnected = allMajorCityNames.filter(name => !connectedSet.has(name));

    if (unconnected.length === 0) return [];

    return unconnected
      .map(cityName => ({
        cityName,
        estimatedCost: ContextBuilder.estimateTrackCost(cityName, segments, gridPoints),
      }))
      .sort((a, b) => a.estimatedCost - b.estimatedCost);
  }

  /** Get city name at a grid position, or undefined if not a city */
  private static getCityNameAtPosition(
    position: { row: number; col: number },
    gridPoints: GridPoint[],
  ): string | undefined {
    const point = gridPoints.find(
      gp => gp.row === position.row && gp.col === position.col,
    );
    return point?.city?.name;
  }

  /** Compute connected major cities from the bot's track segments */
  private static computeConnectedMajorCities(
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): string[] {
    if (segments.length === 0) return [];

    const network = buildTrackNetwork(segments);
    const majorCityPoints = gridPoints.filter(
      gp => gp.terrain === TerrainType.MajorCity && gp.city,
    );

    // Find which major cities are on the network
    const connectedCities: string[] = [];
    for (const mc of majorCityPoints) {
      const key = `${mc.row},${mc.col}`;
      if (network.nodes.has(key)) {
        connectedCities.push(mc.city!.name);
      }
    }

    // Deduplicate (major cities may have multiple mileposts)
    return Array.from(new Set(connectedCities));
  }

  /** Summarize track as "N mileposts: City1-City2, City2-City3" */
  private static computeTrackSummary(
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): string {
    if (segments.length === 0) return 'No track built';

    const mileposts = segments.length;

    // Collect city names touched by the track
    const cityNames = new Set<string>();
    for (const seg of segments) {
      const fromPoint = gridPoints.find(
        gp => gp.row === seg.from.row && gp.col === seg.from.col,
      );
      const toPoint = gridPoints.find(
        gp => gp.row === seg.to.row && gp.col === seg.to.col,
      );
      if (fromPoint?.city?.name) cityNames.add(fromPoint.city.name);
      if (toPoint?.city?.name) cityNames.add(toPoint.city.name);
    }

    if (cityNames.size === 0) {
      return `${mileposts} mileposts (no cities connected yet)`;
    }

    const cities = Array.from(cityNames).sort();
    // Build corridor pairs from consecutive cities in the sorted list
    const corridors: string[] = [];
    for (let i = 0; i < cities.length - 1; i++) {
      corridors.push(`${cities[i]}\u2013${cities[i + 1]}`);
    }

    return corridors.length > 0
      ? `${mileposts} mileposts: ${corridors.join(', ')}`
      : `${mileposts} mileposts covering ${cities.join(', ')}`;
  }

  // ── Demand scoring (JIRA-13) ────────────────────────────────────────────

  /** Radius (hex distance) around the corridor line to count cities */
  private static readonly CORRIDOR_RADIUS = 5;


  /**
   * Estimate how many cities lie near the proposed track corridor from
   * the bot's track frontier (or a starting major city) to the supply city.
   *
   * The corridor is defined as all grid points within CORRIDOR_RADIUS hexes
   * of either endpoint or the midpoint of the line between them.
   *
   * Returns { networkCities, victoryMajorCities } counts.
   */
  /**
   * On cold-start (no track), evaluate each major city as a potential starting hub.
   * Compares hub topology (S→supply + S→delivery) vs linear (S→supply + supply→delivery)
   * and picks the starting city with the cheapest min(hub, linear) total. (JIRA-72)
   */
  private static estimateColdStartRouteCost(
    supplyCity: string,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): { supplyCost: number; deliveryCost: number; totalCost: number; startingCity: string; isHubModel: boolean } | null {
    const majorCityGroups = getMajorCityGroups();
    const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
    const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
    if (supplyPoints.length === 0 || deliveryPoints.length === 0) return null;

    // Helper: estimatePathCost returns 0 for both "same point" and "unreachable".
    // Fall back to hexDistance * 2 (conservative estimate) when pathCost is 0 but points differ.
    const costBetween = (
      fromRow: number, fromCol: number, toRow: number, toCol: number,
    ): number => {
      if (fromRow === toRow && fromCol === toCol) return 0;
      const pathCost = estimatePathCost(fromRow, fromCol, toRow, toCol);
      if (pathCost > 0) return pathCost;
      const dist = hexDistance(fromRow, fromCol, toRow, toCol);
      return dist <= 1 ? 0 : Math.round(dist * 2.0);
    };

    // Pre-compute linear delivery cost (supply→delivery) — invariant across starting cities
    let bestLinearDeliveryCost = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of deliveryPoints) {
        const cost = costBetween(sp.row, sp.col, dp.row, dp.col);
        if (cost < bestLinearDeliveryCost) bestLinearDeliveryCost = cost;
      }
    }

    let bestTotalCost = Infinity;
    let bestSupplyCost = 0;
    let bestDeliveryCost = 0;
    let bestStartingCity = '';
    let bestIsHub = false;

    // Build a set of supply city major city names for fast lookup
    const supplyIsMajor = majorCityGroups.some(g => g.cityName === supplyCity);
    const deliveryIsMajor = majorCityGroups.some(g => g.cityName === deliveryCity);

    for (const group of majorCityGroups) {
      // Use gridPoints coordinates for the starting city (handles mock tests where
      // real major city centers don't match mock coordinates)
      const startPoints = gridPoints.filter(gp => gp.city?.name === group.cityName);
      const S = startPoints.length > 0
        ? { row: startPoints[0].row, col: startPoints[0].col }
        : group.center;

      // Spoke 1: hub → supply city (0 if hub IS the supply city)
      let supplyCost = Infinity;
      if (group.cityName === supplyCity) {
        supplyCost = 0;
      } else {
        for (const sp of supplyPoints) {
          const cost = costBetween(S.row, S.col, sp.row, sp.col);
          if (cost < supplyCost) supplyCost = cost;
        }
      }
      if (supplyCost === Infinity) continue;

      // Hub model: hub → delivery city (separate spoke from hub, 0 if hub IS delivery city)
      let hubDeliveryCost = Infinity;
      if (group.cityName === deliveryCity) {
        hubDeliveryCost = 0;
      } else {
        for (const dp of deliveryPoints) {
          const cost = costBetween(S.row, S.col, dp.row, dp.col);
          if (cost < hubDeliveryCost) hubDeliveryCost = cost;
        }
      }

      // Compare hub vs linear topology for this starting city
      const hubTotal = hubDeliveryCost < Infinity
        ? supplyCost + hubDeliveryCost
        : Infinity;
      const linearTotal = bestLinearDeliveryCost < Infinity
        ? supplyCost + bestLinearDeliveryCost
        : Infinity;

      const isHub = hubTotal <= linearTotal;
      const totalForCity = Math.min(hubTotal, linearTotal);
      const deliveryCostForCity = isHub
        ? (hubDeliveryCost < Infinity ? hubDeliveryCost : 0)
        : (bestLinearDeliveryCost < Infinity ? bestLinearDeliveryCost : 0);

      // Break ties by preferring lower supply cost (starting at supply city is ideal)
      if (totalForCity < bestTotalCost
        || (totalForCity === bestTotalCost && supplyCost < bestSupplyCost)) {
        bestTotalCost = totalForCity;
        bestSupplyCost = supplyCost;
        bestDeliveryCost = deliveryCostForCity;
        bestStartingCity = group.cityName;
        bestIsHub = isHub;
      }
    }

    if (bestTotalCost === Infinity || !bestStartingCity) return null;

    return {
      supplyCost: bestSupplyCost,
      deliveryCost: bestDeliveryCost,
      totalCost: bestTotalCost,
      startingCity: bestStartingCity,
      isHubModel: bestIsHub,
    };
  }

  private static computeCorridorValue(
    supplyCity: string | null,
    deliveryCity: string,
    segments: TrackSegment[],
    gridPoints: GridPoint[],
    connectedMajorCities: string[],
    startingCity?: string,
  ): { networkCities: number; victoryMajorCities: number } {
    if (!supplyCity) return { networkCities: 0, victoryMajorCities: 0 };

    // Find supply city and delivery city coordinates (use first gridpoint for each)
    const supplyCityPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
    const deliveryCityPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
    if (supplyCityPoints.length === 0) return { networkCities: 0, victoryMajorCities: 0 };

    const supplyPt = supplyCityPoints[0];

    // Find the nearest frontier point on the bot's track to the supply city
    let corridorStart: { row: number; col: number };
    if (segments.length > 0) {
      let bestDist = Infinity;
      corridorStart = { row: segments[0].to.row, col: segments[0].to.col };
      for (const seg of segments) {
        const dist = hexDistance(supplyPt.row, supplyPt.col, seg.to.row, seg.to.col);
        if (dist < bestDist) {
          bestDist = dist;
          corridorStart = { row: seg.to.row, col: seg.to.col };
        }
      }
    } else {
      // No track: use provided starting city (from JIRA-72 hub model) or closest major city
      if (startingCity) {
        const startPoints = gridPoints.filter(gp => gp.city?.name === startingCity);
        if (startPoints.length > 0) {
          corridorStart = { row: startPoints[0].row, col: startPoints[0].col };
        } else {
          corridorStart = { row: supplyPt.row, col: supplyPt.col };
        }
      } else {
        const majorCityGroups = getMajorCityGroups();
        let bestDist = Infinity;
        corridorStart = { row: supplyPt.row, col: supplyPt.col };
        for (const group of majorCityGroups) {
          const dist = hexDistance(supplyPt.row, supplyPt.col, group.center.row, group.center.col);
          if (dist < bestDist) {
            bestDist = dist;
            corridorStart = { row: group.center.row, col: group.center.col };
          }
        }
      }
    }

    // Corridor waypoints: start (frontier), supply, delivery (if available)
    const waypoints: Array<{ row: number; col: number }> = [corridorStart, supplyPt];
    if (deliveryCityPoints.length > 0) {
      waypoints.push(deliveryCityPoints[0]);
    }

    // Also add midpoints between consecutive waypoints for better corridor coverage
    const allCheckpoints: Array<{ row: number; col: number }> = [];
    for (let i = 0; i < waypoints.length; i++) {
      allCheckpoints.push(waypoints[i]);
      if (i < waypoints.length - 1) {
        allCheckpoints.push({
          row: Math.round((waypoints[i].row + waypoints[i + 1].row) / 2),
          col: Math.round((waypoints[i].col + waypoints[i + 1].col) / 2),
        });
      }
    }

    // Build set of cities already on the network (don't count them as "unlocked")
    const networkCitySet = new Set<string>();
    if (segments.length > 0) {
      const network = buildTrackNetwork(segments);
      for (const gp of gridPoints) {
        if (gp.city?.name) {
          const key = `${gp.row},${gp.col}`;
          if (network.nodes.has(key)) networkCitySet.add(gp.city.name);
        }
      }
    }

    // Count cities near the corridor that are NOT on the bot's network
    const connectedSet = new Set(connectedMajorCities);
    const seenCities = new Set<string>();
    let networkCities = 0;
    let victoryMajorCities = 0;

    for (const gp of gridPoints) {
      if (!gp.city?.name) continue;
      if (networkCitySet.has(gp.city.name)) continue;
      if (seenCities.has(gp.city.name)) continue;

      // Check if this city is within CORRIDOR_RADIUS of any checkpoint
      let nearCorridor = false;
      for (const cp of allCheckpoints) {
        if (hexDistance(gp.row, gp.col, cp.row, cp.col) <= ContextBuilder.CORRIDOR_RADIUS) {
          nearCorridor = true;
          break;
        }
      }
      if (!nearCorridor) continue;

      seenCities.add(gp.city.name);
      networkCities++;

      // Check if it's an unconnected major city (victory value)
      if (gp.terrain === TerrainType.MajorCity && !connectedSet.has(gp.city.name)) {
        victoryMajorCities++;
      }
    }

    return { networkCities, victoryMajorCities };
  }

  /**
   * Compute a demand score using payout-relative corridor and victory bonuses.
   * Higher scores mean better demand options for the bot to pursue.
   *
   * baseROI = (payout - totalTrackCost) / estimatedTurns
   * corridorMultiplier = min(networkCities * 0.05, 0.5)
   * victoryBonus = victoryMajorCities * max(payout * 0.15, 5)
   * score = baseROI + corridorMultiplier * baseROI + victoryBonus
   *
   * The corridor multiplier scales with baseROI so geographical advantages
   * amplify good deliveries rather than overshadowing economic value.
   *
   * JIRA-51: When the bot can't afford the required track, the score is
   * penalized proportionally to the cash shortfall. Slightly unaffordable
   * demands get a mild penalty; massively unaffordable ones score near zero.
   */
  private static scoreDemand(
    payout: number,
    totalTrackCost: number,
    networkCities: number,
    victoryMajorCities: number,
    estimatedTurns: number,
    isAffordable: boolean = true,
    projectedFunds: number = Infinity,
  ): number {
    const baseROI = (payout - totalTrackCost) / estimatedTurns;
    const corridorMultiplier = Math.min(networkCities * 0.05, 0.5);
    const victoryBonus = (victoryMajorCities * Math.max(payout * 0.15, 5)) / estimatedTurns;
    const rawScore = baseROI + (corridorMultiplier * baseROI) + victoryBonus;

    if (!isAffordable && totalTrackCost > 0) {
      const shortfall = totalTrackCost - Math.max(projectedFunds, 0);
      const shortfallRatio = Math.min(shortfall / totalTrackCost, 1);
      const penalty = Math.max(0.05, 0.3 * (1 - shortfallRatio));
      return rawScore * penalty;
    }

    return rawScore;
  }

  // ── Demand context helpers (BE-005) ─────────────────────────────────────

  /**
   * Find the best supply city for a load type.
   * Prefers cities that are already on the bot's track network.
   * Falls back to the first supply city found in gridPoints.
   */
  private static findBestSupplyCity(
    loadType: string,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    segments: TrackSegment[],
  ): string | null {
    // Find all cities that supply this load type
    const supplyCities: Array<{ name: string; row: number; col: number }> = [];
    for (const gp of gridPoints) {
      if (gp.city && gp.city.availableLoads.includes(loadType)) {
        supplyCities.push({ name: gp.city.name, row: gp.row, col: gp.col });
      }
    }

    if (supplyCities.length === 0) return null;

    // Prefer a supply city that's already on our network
    if (network) {
      for (const sc of supplyCities) {
        const key = `${sc.row},${sc.col}`;
        if (network.nodes.has(key)) {
          return sc.name;
        }
      }
    }

    // If no supply city is on the network, pick the one closest to the track frontier
    if (segments.length > 0) {
      let bestCity = supplyCities[0].name;
      let bestDist = Infinity;
      for (const sc of supplyCities) {
        for (const seg of segments) {
          const dist = hexDistance(
            sc.row, sc.col, seg.to.row, seg.to.col,
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestCity = sc.name;
          }
        }
      }
      return bestCity;
    }

    // No track at all — pick supply city closest to any major city
    // (bot can start building from any major city per game rules)
    const majorCityGroups = getMajorCityGroups();
    let bestCity = supplyCities[0].name;
    let bestDist = Infinity;
    for (const sc of supplyCities) {
      for (const group of majorCityGroups) {
        const dist = hexDistance(
          sc.row, sc.col, group.center.row, group.center.col,
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestCity = sc.name;
        }
      }
    }
    return bestCity;
  }

  /** Check if a city name is on the track network (has at least one milepost in the network) */
  private static isCityOnNetwork(
    cityName: string,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
  ): boolean {
    if (!network) return false;
    for (const gp of gridPoints) {
      if (gp.city?.name === cityName) {
        const key = `${gp.row},${gp.col}`;
        if (network.nodes.has(key)) return true;
      }
    }
    return false;
  }

  /**
   * Estimate track building cost to reach a city from the existing track.
   * Uses hex distance with an average terrain cost multiplier (~1.5M per milepost).
   * Returns 0 if no track exists (can't estimate without a frontier).
   *
   * For cities with multiple mileposts (e.g. major cities with 5-7 gridpoints),
   * checks ALL mileposts and uses the one closest to the bot's track.
   */
  private static estimateTrackCost(
    cityName: string,
    segments: TrackSegment[],
    gridPoints: GridPoint[],
    fromCity?: string,
  ): number {
    // Find ALL mileposts for this city (major cities have multiple)
    const cityPoints = gridPoints.filter(gp => gp.city?.name === cityName);
    if (cityPoints.length === 0) return 0;

    // JIRA-102: Destination city milepost cost (added to fallback estimates)
    // Major cities cost 5M, small/medium cities cost 3M to build into.
    const cityCost = ContextBuilder.getDestinationCityCost(cityPoints[0]);

    if (segments.length === 0) {
      // Cold-start: if fromCity specified, estimate cost from that city
      // (used for delivery cost estimation from the supply city)
      if (fromCity) {
        const fromPoints = gridPoints.filter(gp => gp.city?.name === fromCity);
        if (fromPoints.length > 0) {
          let bestFrom = fromPoints[0];
          let bestTo = cityPoints[0];
          let minDist = Infinity;
          for (const cityPoint of cityPoints) {
            for (const fp of fromPoints) {
              const dist = hexDistance(
                cityPoint.row, cityPoint.col, fp.row, fp.col,
              );
              if (dist < minDist) {
                minDist = dist;
                bestFrom = fp;
                bestTo = cityPoint;
              }
            }
          }
          if (minDist === Infinity || minDist <= 1) return 0;
          const pathCost = estimatePathCost(bestFrom.row, bestFrom.col, bestTo.row, bestTo.col);
          // JIRA-102: Fall back to conservative estimate with terrain multiplier + city cost
          return pathCost > 0 ? pathCost : Math.round(minDist * 3.0) + cityCost;
        }
      }

      // Default cold-start: estimate cost from nearest major city center
      // (bot can start building from any major city per game rules)
      const majorCityGroups = getMajorCityGroups();
      let bestMajor = { row: 0, col: 0 };
      let bestCity = cityPoints[0];
      let minDist = Infinity;
      for (const cityPoint of cityPoints) {
        for (const group of majorCityGroups) {
          const dist = hexDistance(
            cityPoint.row, cityPoint.col,
            group.center.row, group.center.col,
          );
          if (dist < minDist) {
            minDist = dist;
            bestMajor = { row: group.center.row, col: group.center.col };
            bestCity = cityPoint;
          }
        }
      }
      if (minDist === Infinity || minDist <= 1) return 0; // City IS a major city
      const pathCost2 = estimatePathCost(bestMajor.row, bestMajor.col, bestCity.row, bestCity.col);
      // JIRA-102: Conservative fallback with terrain multiplier + city cost
      return pathCost2 > 0 ? pathCost2 : Math.round(minDist * 3.0) + cityCost;
    }

    // Collect unique track endpoints for landmass detection
    const endpointSet = new Set<string>();
    const trackEndpoints: Array<{ row: number; col: number }> = [];
    for (const seg of segments) {
      const fk = makeKey(seg.from.row, seg.from.col);
      if (!endpointSet.has(fk)) {
        endpointSet.add(fk);
        trackEndpoints.push({ row: seg.from.row, col: seg.from.col });
      }
      const tk = makeKey(seg.to.row, seg.to.col);
      if (!endpointSet.has(tk)) {
        endpointSet.add(tk);
        trackEndpoints.push({ row: seg.to.row, col: seg.to.col });
      }
    }

    // Check if target city is on a different landmass from the bot's track
    const grid = loadGridPoints();
    const sourceLandmass = computeLandmass(trackEndpoints, grid);
    const targetOnSourceLandmass = cityPoints.some(
      cp => sourceLandmass.has(makeKey(cp.row, cp.col)),
    );

    if (targetOnSourceLandmass) {
      // Same landmass — find closest segment endpoint and use Dijkstra estimate
      let bestSeg = { row: 0, col: 0 };
      let bestCity = cityPoints[0];
      let minDist = Infinity;
      for (const cityPoint of cityPoints) {
        for (const seg of segments) {
          const distFrom = hexDistance(
            cityPoint.row, cityPoint.col, seg.from.row, seg.from.col,
          );
          if (distFrom < minDist) {
            minDist = distFrom;
            bestSeg = { row: seg.from.row, col: seg.from.col };
            bestCity = cityPoint;
          }
          const distTo = hexDistance(
            cityPoint.row, cityPoint.col, seg.to.row, seg.to.col,
          );
          if (distTo < minDist) {
            minDist = distTo;
            bestSeg = { row: seg.to.row, col: seg.to.col };
            bestCity = cityPoint;
          }
        }
      }
      if (minDist === Infinity) return 0;
      const sameLandCost = estimatePathCost(bestSeg.row, bestSeg.col, bestCity.row, bestCity.col);
      // JIRA-102: Conservative fallback with terrain multiplier + city cost
      return sameLandCost > 0 ? sameLandCost : Math.round(minDist * 3.0) + cityCost;
    }

    // Cross-water target — check ferry state
    const ferryEdges = getFerryEdges();
    const ferryInfo = computeFerryRouteInfo(sourceLandmass, endpointSet, ferryEdges);

    if (ferryInfo.canCrossFerry) {
      // Bot already has track at a departure ferry port — crossing is free
      // Estimate = distance from arrival port to target
      let minFarDist = Infinity;
      let bestArrival = ferryInfo.arrivalPorts[0];
      let bestCity = cityPoints[0];
      for (const arrival of ferryInfo.arrivalPorts) {
        for (const cp of cityPoints) {
          const dist = hexDistance(arrival.row, arrival.col, cp.row, cp.col);
          if (dist < minFarDist) {
            minFarDist = dist;
            bestArrival = arrival;
            bestCity = cp;
          }
        }
      }
      if (minFarDist === Infinity) return 0;
      const ferryCrossCost = estimatePathCost(bestArrival.row, bestArrival.col, bestCity.row, bestCity.col);
      // JIRA-102: Conservative fallback with terrain multiplier + city cost
      return ferryCrossCost > 0 ? ferryCrossCost : Math.round(minFarDist * 3.0) + cityCost;
    }

    // Bot has no ferry access — estimate full route via best ferry
    let bestTotal = Infinity;
    for (let i = 0; i < ferryInfo.departurePorts.length; i++) {
      const dep = ferryInfo.departurePorts[i];
      const arr = ferryInfo.arrivalPorts[i];
      // Overland cost from nearest track endpoint to departure port (terrain-aware)
      let bestEp = trackEndpoints[0];
      let nearestTrackDist = Infinity;
      for (const ep of trackEndpoints) {
        const d = hexDistance(ep.row, ep.col, dep.row, dep.col);
        if (d < nearestTrackDist) {
          nearestTrackDist = d;
          bestEp = ep;
        }
      }
      const overlandToDep = estimatePathCost(bestEp.row, bestEp.col, dep.row, dep.col);
      // JIRA-102: Conservative multiplier (no city cost — destination is a ferry port)
      const nearSideCost = overlandToDep > 0 ? overlandToDep : Math.round(nearestTrackDist * 3.0);

      // Far-side cost from arrival port to target city (terrain-aware)
      let bestCp = cityPoints[0];
      let nearestTargetDist = Infinity;
      for (const cp of cityPoints) {
        const d = hexDistance(arr.row, arr.col, cp.row, cp.col);
        if (d < nearestTargetDist) {
          nearestTargetDist = d;
          bestCp = cp;
        }
      }
      const overlandFromArr = estimatePathCost(arr.row, arr.col, bestCp.row, bestCp.col);
      // JIRA-102: Conservative fallback with terrain multiplier + city cost
      const farSideCost = overlandFromArr > 0 ? overlandFromArr : Math.round(nearestTargetDist * 3.0) + cityCost;

      // Look up the ferry cost for this specific departure port
      let ferryCost = ferryInfo.cheapestFerryCost;
      for (const fe of ferryEdges) {
        const aKey = makeKey(fe.pointA.row, fe.pointA.col);
        const bKey = makeKey(fe.pointB.row, fe.pointB.col);
        if (aKey === makeKey(dep.row, dep.col) || bKey === makeKey(dep.row, dep.col)) {
          ferryCost = fe.cost;
          break;
        }
      }
      const total = nearSideCost + ferryCost + farSideCost;
      bestTotal = Math.min(bestTotal, total);
    }

    if (bestTotal === Infinity) {
      // No ferry route found — fall back to conservative hex distance estimate
      let minDist = Infinity;
      for (const cp of cityPoints) {
        for (const ep of trackEndpoints) {
          const d = hexDistance(ep.row, ep.col, cp.row, cp.col);
          minDist = Math.min(minDist, d);
        }
      }
      // JIRA-102: Conservative fallback with terrain multiplier + city cost
      return Math.round(minDist * 3.0) + cityCost;
    }

    return Math.round(bestTotal);
  }

  /**
   * JIRA-102: Get the build cost of a destination city milepost.
   * Major cities cost 5M, small/medium cities cost 3M.
   * Used to improve fallback estimates when Dijkstra can't find a path.
   */
  private static getDestinationCityCost(cityPoint: GridPoint): number {
    switch (cityPoint.terrain) {
      case TerrainType.MajorCity: return 5;
      case TerrainType.SmallCity:
      case TerrainType.MediumCity: return 3;
      default: return 0;
    }
  }

  /**
   * Check if a ferry is likely required to reach supply or delivery cities.
   * Looks for ferry port terrain at any grid point named for those cities.
   */
  // Static region classification for the EuroRails map.
  // The hex grid doesn't model water barriers as complete walls, so BFS-based
  // landmass detection won't work. Instead, we classify cities by geographic region.
  private static readonly BRITAIN_CITIES = new Set([
    'Aberdeen', 'Birmingham', 'Cardiff', 'Dover', 'Glasgow', 'Harwich',
    'Liverpool', 'London', 'Manchester', 'Newcastle', 'Plymouth',
    'Portsmouth', 'Southampton', 'Stranraer',
  ]);
  private static readonly IRELAND_CITIES = new Set([
    'Belfast', 'Cork', 'Dublin',
  ]);

  /**
   * Classify a city's geographic region: 'britain', 'ireland', or 'continent'.
   */
  private static getCityRegion(cityName: string): 'britain' | 'ireland' | 'continent' {
    if (ContextBuilder.BRITAIN_CITIES.has(cityName)) return 'britain';
    if (ContextBuilder.IRELAND_CITIES.has(cityName)) return 'ireland';
    return 'continent';
  }

  private static isFerryOnRoute(
    supplyCity: string | null,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): boolean {
    // Check 1: supply or delivery IS a ferry port city
    for (const gp of gridPoints) {
      if (gp.terrain === TerrainType.FerryPort || gp.isFerryCity) {
        const cityName = gp.city?.name;
        if (cityName === supplyCity || cityName === deliveryCity) {
          return true;
        }
      }
    }

    // Check 2: route crosses a water barrier (Channel or Irish Sea)
    // Uses static region classification — ferry required when cities are in different regions.
    if (!supplyCity) return false;
    return ContextBuilder.getCityRegion(supplyCity) !== ContextBuilder.getCityRegion(deliveryCity);
  }

  /**
   * Count the number of distinct water barrier crossings between supply and delivery.
   * Groups ferries by barrier (English Channel vs Irish Sea) so that multiple
   * Channel ferry options count as a single crossing.
   * Belfast (from continent): 2 crossings (Channel + Irish Sea).
   * Dublin (from Britain): 1 crossing (Irish Sea).
   * Continent to Britain: 1 crossing (Channel).
   */
  private static countFerryCrossings(
    supplyCity: string | null,
    deliveryCity: string,
    _gridPoints: GridPoint[],
  ): number {
    if (!supplyCity) return 0;

    const supplyRegion = ContextBuilder.getCityRegion(supplyCity);
    const deliveryRegion = ContextBuilder.getCityRegion(deliveryCity);
    if (supplyRegion === deliveryRegion) return 0;

    // Count crossings based on region pair:
    // Continent↔Britain: 1 (Channel)
    // Britain↔Ireland: 1 (Irish Sea)
    // Continent↔Ireland: 2 (Channel + Irish Sea — must transit through Britain)
    const regions = new Set([supplyRegion, deliveryRegion]);
    if (regions.has('continent') && regions.has('ireland')) return 2;
    return 1;
  }

  // ── Corridor detection (BE-002, BE-003) ─────────────────────────────────

  private static computeCorridors(
    demands: DemandContext[],
    gridPoints: GridPoint[],
  ): Corridor[] {
    if (demands.length < 2) return [];

    // Find grid positions for each demand's supply and delivery cities
    const cityPos = (cityName: string): { row: number; col: number } | null => {
      const gp = gridPoints.find(g => g.city?.name === cityName);
      return gp ? { row: gp.row, col: gp.col } : null;
    };

    // Union-find for merging corridor groups
    const parent = demands.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

    // Check all pairs
    for (let i = 0; i < demands.length; i++) {
      for (let j = i + 1; j < demands.length; j++) {
        const di = demands[i];
        const dj = demands[j];

        const delPosI = cityPos(di.deliveryCity);
        const delPosJ = cityPos(dj.deliveryCity);
        const supPosI = cityPos(di.supplyCity);
        const supPosJ = cityPos(dj.supplyCity);

        if (!delPosI || !delPosJ || !supPosI || !supPosJ) continue;

        const deliveryDist = di.deliveryCity === dj.deliveryCity ? 0 :
          hexDistance(delPosI.row, delPosI.col, delPosJ.row, delPosJ.col);
        const supplyDist = hexDistance(supPosI.row, supPosI.col, supPosJ.row, supPosJ.col);

        if (deliveryDist <= ContextBuilder.CORRIDOR_DELIVERY_THRESHOLD &&
            supplyDist <= ContextBuilder.CORRIDOR_SUPPLY_THRESHOLD) {
          union(i, j);
        }
      }
    }

    // Group demands by their root
    const groups = new Map<number, number[]>();
    for (let i = 0; i < demands.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }

    // Build corridors (only for groups with 2+ demands)
    const corridors: Corridor[] = [];
    for (const [, indices] of groups) {
      if (indices.length < 2) continue;

      const corridorDemands = indices.map(i => demands[i]);
      const combinedPayout = corridorDemands.reduce((sum, d) => sum + d.payout, 0);

      // Estimate combined track cost (roughly: max of individual costs, not sum,
      // because they share track)
      const maxSupplyCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToSupply));
      const maxDeliveryCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToDelivery));
      const combinedTrackCost = maxSupplyCost + maxDeliveryCost;

      // Label the corridor
      const deliveryCities = [...new Set(corridorDemands.map(d => d.deliveryCity))];
      const supplyCities = [...new Set(corridorDemands.map(d => d.supplyCity))];
      const deliveryLabel = deliveryCities.length === 1 ? deliveryCities[0] : deliveryCities.join('/');
      const supplyLabel = supplyCities.join('/');
      const sharedDeliveryArea = `${supplyLabel} \u2192 ${deliveryLabel}`;

      corridors.push({
        demandIndices: indices,
        sharedDeliveryArea,
        combinedPayout,
        combinedTrackCost,
        onTheWayDemands: [], // filled by detectOnTheWay
      });
    }

    return corridors;
  }

  // ── Proximity computation (BE-002, JIRA-10) ──────────────────────────────

  /** Proximity threshold: max hex distance for "nearby" cities */
  private static readonly PROXIMITY_THRESHOLD = 5;
  /** Max nearby cities to return per route stop */
  private static readonly MAX_NEARBY_PER_STOP = 5;

  /**
   * For each route stop city, find all cities within hexDistance <= 5
   * that are NOT already on the bot's track network.
   */
  private static computeNearbyCities(
    routeStopCities: string[],
    gridPoints: GridPoint[],
    segments: TrackSegment[],
  ): Array<{ routeStop: string; nearbyCities: Array<{ city: string; distance: number; estimatedCost: number }> }> {
    if (routeStopCities.length === 0 || segments.length === 0) return [];

    const network = buildTrackNetwork(segments);

    // Build a set of city names already on the network
    const networkCities = new Set<string>();
    for (const gp of gridPoints) {
      if (gp.city?.name) {
        const key = `${gp.row},${gp.col}`;
        if (network.nodes.has(key)) networkCities.add(gp.city.name);
      }
    }

    // All city grid points (small, medium, major)
    const allCityPoints = gridPoints.filter(
      gp => gp.city && (
        gp.terrain === TerrainType.SmallCity ||
        gp.terrain === TerrainType.MediumCity ||
        gp.terrain === TerrainType.MajorCity
      ),
    );

    const result: Array<{ routeStop: string; nearbyCities: Array<{ city: string; distance: number; estimatedCost: number }> }> = [];

    for (const stopCity of routeStopCities) {
      // Find the grid position(s) for this route stop
      const stopPoints = gridPoints.filter(gp => gp.city?.name === stopCity);
      if (stopPoints.length === 0) continue;

      const nearbyMap = new Map<string, { distance: number; estimatedCost: number }>();

      for (const stopPt of stopPoints) {
        for (const cityPt of allCityPoints) {
          const cityName = cityPt.city!.name;
          // Skip cities already on the network or the stop city itself
          if (networkCities.has(cityName) || cityName === stopCity) continue;

          const dist = hexDistance(stopPt.row, stopPt.col, cityPt.row, cityPt.col);
          if (dist <= ContextBuilder.PROXIMITY_THRESHOLD && dist > 0) {
            const existing = nearbyMap.get(cityName);
            if (!existing || dist < existing.distance) {
              nearbyMap.set(cityName, {
                distance: dist,
                estimatedCost: ContextBuilder.estimateTrackCost(cityName, segments, gridPoints),
              });
            }
          }
        }
      }

      if (nearbyMap.size > 0) {
        const nearbyCities = Array.from(nearbyMap.entries())
          .map(([city, data]) => ({ city, distance: data.distance, estimatedCost: data.estimatedCost }))
          .sort((a, b) => a.estimatedCost - b.estimatedCost)
          .slice(0, ContextBuilder.MAX_NEARBY_PER_STOP);

        result.push({ routeStop: stopCity, nearbyCities });
      }
    }

    return result;
  }

  /**
   * For each demand where supply OR delivery city is not on the network,
   * compute estimated build cost to connect it.
   */
  private static computeUnconnectedDemandCosts(
    demands: DemandContext[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> {
    if (segments.length === 0) return [];

    const results: Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> = [];

    for (let i = 0; i < demands.length; i++) {
      const d = demands[i];
      // Skip if both cities already on network
      if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) continue;

      if (!d.isSupplyOnNetwork) {
        results.push({
          demandIndex: i,
          city: d.supplyCity,
          estimatedCost: ContextBuilder.estimateTrackCost(d.supplyCity, segments, gridPoints),
          payout: d.payout,
          isSupply: true,
        });
      }
      if (!d.isDeliveryOnNetwork) {
        results.push({
          demandIndex: i,
          city: d.deliveryCity,
          estimatedCost: ContextBuilder.estimateTrackCost(d.deliveryCity, segments, gridPoints),
          payout: d.payout,
          isSupply: false,
        });
      }
    }

    return results;
  }

  /**
   * For each demand, check if the supply city is near (hexDistance <= 5)
   * any milepost on the bot's network. Excludes supplies already on network.
   */
  private static computeResourceProximity(
    demands: DemandContext[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> {
    if (segments.length === 0) return [];

    const network = buildTrackNetwork(segments);
    const results: Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> = [];
    const seen = new Set<string>(); // deduplicate by supplyCity

    for (const d of demands) {
      if (d.isSupplyOnNetwork) continue;
      if (seen.has(d.supplyCity)) continue;

      // Find the supply city's grid position(s)
      const supplyPoints = gridPoints.filter(gp => gp.city?.name === d.supplyCity);
      if (supplyPoints.length === 0) continue;

      // Find minimum hex distance from any supply point to any network node
      let minDist = Infinity;
      for (const sp of supplyPoints) {
        for (const nodeKey of network.nodes) {
          const [nRow, nCol] = nodeKey.split(',').map(Number);
          const dist = hexDistance(sp.row, sp.col, nRow, nCol);
          if (dist < minDist) minDist = dist;
        }
      }

      if (minDist <= ContextBuilder.PROXIMITY_THRESHOLD && minDist > 0) {
        seen.add(d.supplyCity);
        results.push({
          loadType: d.loadType,
          supplyCity: d.supplyCity,
          distanceFromNetwork: minDist,
          estimatedCost: ContextBuilder.estimateTrackCost(d.supplyCity, segments, gridPoints),
        });
      }
    }

    return results;
  }

  private static detectOnTheWay(
    corridors: Corridor[],
    demands: DemandContext[],
    gridPoints: GridPoint[],
  ): void {
    // Collect all demand indices already in corridors
    const corridorIndices = new Set<number>();
    for (const c of corridors) {
      for (const idx of c.demandIndices) {
        corridorIndices.add(idx);
      }
    }

    const cityPos = (cityName: string): { row: number; col: number } | null => {
      const gp = gridPoints.find(g => g.city?.name === cityName);
      return gp ? { row: gp.row, col: gp.col } : null;
    };

    for (const corridor of corridors) {
      const corridorCityPositions: Array<{ row: number; col: number }> = [];
      for (const idx of corridor.demandIndices) {
        const d = demands[idx];
        const sp = cityPos(d.supplyCity);
        const dp = cityPos(d.deliveryCity);
        if (sp) corridorCityPositions.push(sp);
        if (dp) corridorCityPositions.push(dp);
      }

      for (let i = 0; i < demands.length; i++) {
        if (corridorIndices.has(i)) continue;
        if (corridor.onTheWayDemands.includes(i)) continue;

        const d = demands[i];
        const sp = cityPos(d.supplyCity);
        const dp = cityPos(d.deliveryCity);

        for (const cPos of corridorCityPositions) {
          let matched = false;
          if (sp) {
            const dist = hexDistance(sp.row, sp.col, cPos.row, cPos.col);
            if (dist <= ContextBuilder.ON_THE_WAY_THRESHOLD) {
              corridor.onTheWayDemands.push(i);
              matched = true;
            }
          }
          if (!matched && dp) {
            const dist = hexDistance(dp.row, dp.col, cPos.row, cPos.col);
            if (dist <= ContextBuilder.ON_THE_WAY_THRESHOLD) {
              corridor.onTheWayDemands.push(i);
              matched = true;
            }
          }
          if (matched) break;
        }
      }
    }
  }


}
