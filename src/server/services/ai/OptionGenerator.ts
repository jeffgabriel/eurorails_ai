import { v4 as uuidv4 } from 'uuid';
import type { WorldSnapshot, FeasibleOption } from '../../../shared/types/AITypes';
import { AIActionType } from '../../../shared/types/AITypes';
import { TerrainType, TrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import type { GridPoint, Point } from '../../../shared/types/GameTypes';
import type { DemandCard } from '../../../shared/types/DemandCard';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';

function nodeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Terrain build costs (ECU millions). */
const TERRAIN_COSTS: Record<TerrainType, number> = {
  [TerrainType.Clear]: 1,
  [TerrainType.Mountain]: 2,
  [TerrainType.Alpine]: 5,
  [TerrainType.SmallCity]: 3,
  [TerrainType.MediumCity]: 3,
  [TerrainType.MajorCity]: 5,
  [TerrainType.FerryPort]: 0,
  [TerrainType.Water]: 0,
};

const TURN_BUILD_BUDGET = 20;
const UPGRADE_COST = 20;
const CROSSGRADE_COST = 5;

/**
 * Build a lookup from city name to grid coordinate keys.
 * Includes major city centers and outposts, medium cities, and small cities.
 */
function buildCityLookup(topology: readonly GridPoint[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const point of topology) {
    const name = point.city?.name ?? point.name;
    if (!name) continue;
    if (!lookup.has(name)) lookup.set(name, []);
    lookup.get(name)!.push(nodeKey(point.row, point.col));
  }
  return lookup;
}

/**
 * Build a lookup from grid coordinate key to GridPoint.
 */
function buildPointLookup(topology: readonly GridPoint[]): Map<string, GridPoint> {
  const lookup = new Map<string, GridPoint>();
  for (const point of topology) {
    lookup.set(nodeKey(point.row, point.col), point);
  }
  return lookup;
}

/**
 * BFS from a position on the track graph, returning all reachable nodes
 * within a given movement budget (number of mileposts/edges).
 */
function getReachableNodes(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  startKey: string,
  maxSteps: number,
): Set<string> {
  const reachable = new Set<string>();
  if (!graph.has(startKey)) return reachable;

  const queue: Array<{ key: string; steps: number }> = [{ key: startKey, steps: 0 }];
  const visited = new Map<string, number>(); // key -> min steps to reach
  visited.set(startKey, 0);
  reachable.add(startKey);

  while (queue.length > 0) {
    const { key, steps } = queue.shift()!;
    if (steps >= maxSteps) continue;

    const neighbors = graph.get(key);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      const newSteps = steps + 1;
      if (!visited.has(neighbor) || visited.get(neighbor)! > newSteps) {
        visited.set(neighbor, newSteps);
        reachable.add(neighbor);
        queue.push({ key: neighbor, steps: newSteps });
      }
    }
  }
  return reachable;
}

/**
 * Get hex grid neighbors of a given (row, col).
 * Uses the same adjacency logic as the client-side TrackDrawingManager.
 */
function getHexNeighbors(row: number, col: number): Array<{ row: number; col: number }> {
  const isOddRow = row % 2 === 1;
  const neighbors: Array<{ row: number; col: number }> = [
    { row, col: col - 1 },       // left
    { row, col: col + 1 },       // right
  ];
  if (isOddRow) {
    neighbors.push(
      { row: row - 1, col },     // upper-left
      { row: row - 1, col: col + 1 }, // upper-right
      { row: row + 1, col },     // lower-left
      { row: row + 1, col: col + 1 }, // lower-right
    );
  } else {
    neighbors.push(
      { row: row - 1, col: col - 1 }, // upper-left
      { row: row - 1, col },     // upper-right
      { row: row + 1, col: col - 1 }, // lower-left
      { row: row + 1, col },     // lower-right
    );
  }
  return neighbors;
}

function makeFeasible(
  type: AIActionType,
  parameters: Record<string, unknown>,
): FeasibleOption {
  return {
    id: uuidv4(),
    type,
    parameters,
    score: 0,
    feasible: true,
    rejectionReason: null,
  };
}

function makeInfeasible(
  type: AIActionType,
  parameters: Record<string, unknown>,
  reason: string,
): FeasibleOption {
  return {
    id: uuidv4(),
    type,
    parameters,
    score: 0,
    feasible: false,
    rejectionReason: reason,
  };
}

export class OptionGenerator {
  /**
   * Generate all candidate actions for the AI player's turn.
   * Each option includes a feasibility flag and rejection reason if infeasible.
   */
  static generate(snapshot: WorldSnapshot): FeasibleOption[] {
    const options: FeasibleOption[] = [];
    const cityLookup = buildCityLookup(snapshot.mapTopology);
    const pointLookup = buildPointLookup(snapshot.mapTopology);

    const speed = TRAIN_PROPERTIES[snapshot.trainType]?.speed ?? 9;
    const capacity = TRAIN_PROPERTIES[snapshot.trainType]?.capacity ?? 2;
    const currentLoads = snapshot.carriedLoads.length;

    // Determine reachable nodes from bot's current position
    const botKey = snapshot.botPosition
      ? nodeKey(snapshot.botPosition.row, snapshot.botPosition.col)
      : null;
    const reachable = botKey
      ? getReachableNodes(snapshot.trackNetworkGraph, botKey, speed)
      : new Set<string>();

    // --- DeliverLoad ---
    options.push(...this.generateDeliverLoadOptions(snapshot, cityLookup, reachable));

    // --- PickupAndDeliver ---
    options.push(...this.generatePickupAndDeliverOptions(snapshot, cityLookup, reachable, capacity, currentLoads));

    // --- BuildTrack ---
    options.push(...this.generateBuildTrackOptions(snapshot, cityLookup, pointLookup));

    // --- UpgradeTrain ---
    options.push(...this.generateUpgradeTrainOptions(snapshot));

    // --- BuildTowardMajorCity ---
    options.push(...this.generateBuildTowardMajorCityOptions(snapshot, pointLookup));

    // --- PassTurn (always feasible) ---
    options.push(makeFeasible(AIActionType.PassTurn, {}));

    return options;
  }

  /**
   * Generate DeliverLoad options.
   * For each carried load, check if any demand card has a matching demand
   * and the delivery city is reachable this turn.
   */
  private static generateDeliverLoadOptions(
    snapshot: WorldSnapshot,
    cityLookup: Map<string, string[]>,
    reachable: Set<string>,
  ): FeasibleOption[] {
    const options: FeasibleOption[] = [];

    for (const loadType of snapshot.carriedLoads) {
      for (const card of snapshot.demandCards) {
        for (let di = 0; di < card.demands.length; di++) {
          const demand = card.demands[di];
          if (demand.resource !== loadType) continue;

          const cityKeys = cityLookup.get(demand.city) || [];
          const isReachable = cityKeys.some(k => reachable.has(k));

          const params = {
            loadType,
            demandCardId: card.id,
            demandIndex: di,
            destinationCity: demand.city,
            payment: demand.payment,
          };

          if (!isReachable) {
            // Check if city is at least on the network (multi-turn delivery)
            const isOnNetwork = cityKeys.some(k => snapshot.trackNetworkGraph.has(k));
            if (isOnNetwork) {
              options.push(makeInfeasible(
                AIActionType.DeliverLoad,
                params,
                `${demand.city} is on track network but not reachable within ${TRAIN_PROPERTIES[snapshot.trainType]?.speed ?? 9} mileposts this turn`,
              ));
            } else {
              options.push(makeInfeasible(
                AIActionType.DeliverLoad,
                params,
                `${demand.city} is not connected to track network`,
              ));
            }
          } else {
            options.push(makeFeasible(AIActionType.DeliverLoad, params));
          }
        }
      }
    }
    return options;
  }

  /**
   * Generate PickupAndDeliver options.
   * For each demand on each card, check if the load is available globally,
   * a supply city is reachable or on the network, and bot has capacity.
   */
  private static generatePickupAndDeliverOptions(
    snapshot: WorldSnapshot,
    cityLookup: Map<string, string[]>,
    reachable: Set<string>,
    capacity: number,
    currentLoads: number,
  ): FeasibleOption[] {
    const options: FeasibleOption[] = [];

    // Skip loads already carried (don't need to pick them up again)
    const carriedSet = new Set(snapshot.carriedLoads);

    for (const card of snapshot.demandCards) {
      for (let di = 0; di < card.demands.length; di++) {
        const demand = card.demands[di];
        // Skip if already carrying this load type
        if (carriedSet.has(demand.resource)) continue;

        const params = {
          loadType: demand.resource,
          demandCardId: card.id,
          demandIndex: di,
          destinationCity: demand.city,
          payment: demand.payment,
        };

        // Check global load availability
        const loadState = snapshot.globalLoadAvailability.find(
          s => s.loadType === demand.resource,
        );
        if (!loadState || loadState.availableCount <= 0) {
          options.push(makeInfeasible(
            AIActionType.PickupAndDeliver,
            params,
            `No ${demand.resource} available globally (all on other trains or depleted)`,
          ));
          continue;
        }

        // Check capacity
        if (currentLoads >= capacity) {
          options.push(makeInfeasible(
            AIActionType.PickupAndDeliver,
            params,
            `Train at full capacity (${currentLoads}/${capacity} loads)`,
          ));
          continue;
        }

        // Find supply cities for this load
        const supplyCities = loadState.cities || [];
        // Check if any supply city is reachable this turn
        const reachableSupplyCity = supplyCities.find(city => {
          const keys = cityLookup.get(city) || [];
          return keys.some(k => reachable.has(k));
        });

        if (reachableSupplyCity) {
          options.push(makeFeasible(AIActionType.PickupAndDeliver, {
            ...params,
            supplyCity: reachableSupplyCity,
          }));
          continue;
        }

        // Check if any supply city is at least on the network
        const networkSupplyCity = supplyCities.find(city => {
          const keys = cityLookup.get(city) || [];
          return keys.some(k => snapshot.trackNetworkGraph.has(k));
        });

        if (networkSupplyCity) {
          options.push(makeFeasible(AIActionType.PickupAndDeliver, {
            ...params,
            supplyCity: networkSupplyCity,
          }));
        } else {
          options.push(makeInfeasible(
            AIActionType.PickupAndDeliver,
            params,
            `No supply city for ${demand.resource} connected to track network`,
          ));
        }
      }
    }
    return options;
  }

  /**
   * Generate BuildTrack options.
   * Identify frontier nodes (edges of bot's network) and suggest building
   * toward cities that serve current demands.
   */
  private static generateBuildTrackOptions(
    snapshot: WorldSnapshot,
    cityLookup: Map<string, string[]>,
    pointLookup: Map<string, GridPoint>,
  ): FeasibleOption[] {
    const options: FeasibleOption[] = [];

    if (snapshot.cash < 1) {
      options.push(makeInfeasible(
        AIActionType.BuildTrack,
        {},
        'Insufficient funds to build any track',
      ));
      return options;
    }

    const budget = Math.min(snapshot.cash, TURN_BUILD_BUDGET);

    // Collect unique target cities from demand cards
    const targetCities = new Set<string>();
    for (const card of snapshot.demandCards) {
      for (const demand of card.demands) {
        targetCities.add(demand.city);
        // Also add supply cities for loads we need
        const loadState = snapshot.globalLoadAvailability.find(
          s => s.loadType === demand.resource,
        );
        if (loadState) {
          for (const city of loadState.cities) {
            targetCities.add(city);
          }
        }
      }
    }

    // For each target city not yet on the network, generate a BuildTrack option
    for (const city of targetCities) {
      const cityKeys = cityLookup.get(city) || [];
      const isOnNetwork = cityKeys.some(k => snapshot.trackNetworkGraph.has(k));
      if (isOnNetwork) continue; // Already connected

      // Estimate distance (very rough: use grid distance from nearest network node to city)
      const estimatedCost = this.estimateBuildCost(cityKeys, snapshot, pointLookup);

      if (estimatedCost > 0) {
        // Even if total estimated cost exceeds budget, bot can make partial progress
        options.push(makeFeasible(AIActionType.BuildTrack, {
          destination: city,
          estimatedCost,
          budget,
          completableThisTurn: estimatedCost <= budget,
        }));
      }
    }

    // If the bot has no track yet, generate option to build from a major city
    if (snapshot.trackNetworkGraph.size === 0) {
      options.push(makeFeasible(AIActionType.BuildTrack, {
        destination: 'nearest_major_city',
        estimatedCost: 5,
        budget,
        note: 'Start track from major city',
      }));
    }

    return options;
  }

  /**
   * Estimate the build cost to extend the network to a target city.
   * Uses Manhattan-like grid distance with average terrain cost.
   */
  private static estimateBuildCost(
    cityKeys: string[],
    snapshot: WorldSnapshot,
    pointLookup: Map<string, GridPoint>,
  ): number {
    if (cityKeys.length === 0 || snapshot.trackNetworkGraph.size === 0) return 0;

    // Find the closest network node to the target city
    let minDist = Infinity;
    let targetTerrain = TerrainType.Clear;
    for (const cityKey of cityKeys) {
      const [cityRow, cityCol] = cityKey.split(',').map(Number);
      const point = pointLookup.get(cityKey);
      if (point) targetTerrain = point.terrain;

      for (const networkKey of snapshot.trackNetworkGraph.keys()) {
        const [nRow, nCol] = networkKey.split(',').map(Number);
        const dist = Math.abs(cityRow - nRow) + Math.abs(cityCol - nCol);
        if (dist < minDist) minDist = dist;
      }
    }

    if (minDist === Infinity) return 0;

    // Rough estimate: distance * average terrain cost (1.5M average)
    const avgCostPerMilepost = 1.5;
    // Add destination city terrain cost
    const destinationCost = TERRAIN_COSTS[targetTerrain] ?? 1;
    return Math.ceil(Math.max(1, (minDist - 1) * avgCostPerMilepost + destinationCost));
  }

  /**
   * Generate UpgradeTrain options.
   * Check valid upgrade/crossgrade transitions and funds.
   */
  private static generateUpgradeTrainOptions(
    snapshot: WorldSnapshot,
  ): FeasibleOption[] {
    const options: FeasibleOption[] = [];
    const current = snapshot.trainType;
    const cash = snapshot.cash;

    // Upgrade paths (20M, no track build this turn)
    const upgrades: Array<{ from: TrainType; to: TrainType }> = [
      { from: TrainType.Freight, to: TrainType.FastFreight },
      { from: TrainType.Freight, to: TrainType.HeavyFreight },
      { from: TrainType.FastFreight, to: TrainType.Superfreight },
      { from: TrainType.HeavyFreight, to: TrainType.Superfreight },
    ];

    for (const { from, to } of upgrades) {
      if (current !== from) continue;

      const params = {
        targetTrainType: to,
        cost: UPGRADE_COST,
        kind: 'upgrade' as const,
      };

      if (cash < UPGRADE_COST) {
        options.push(makeInfeasible(
          AIActionType.UpgradeTrain,
          params,
          `Insufficient funds: ${cash}M < ${UPGRADE_COST}M required for upgrade`,
        ));
      } else {
        options.push(makeFeasible(AIActionType.UpgradeTrain, params));
      }
    }

    // Crossgrade paths (5M)
    const crossgrades: Array<{ from: TrainType; to: TrainType }> = [
      { from: TrainType.FastFreight, to: TrainType.HeavyFreight },
      { from: TrainType.HeavyFreight, to: TrainType.FastFreight },
    ];

    for (const { from, to } of crossgrades) {
      if (current !== from) continue;

      const params = {
        targetTrainType: to,
        cost: CROSSGRADE_COST,
        kind: 'crossgrade' as const,
      };

      if (cash < CROSSGRADE_COST) {
        options.push(makeInfeasible(
          AIActionType.UpgradeTrain,
          params,
          `Insufficient funds: ${cash}M < ${CROSSGRADE_COST}M required for crossgrade`,
        ));
      } else {
        options.push(makeFeasible(AIActionType.UpgradeTrain, params));
      }
    }

    return options;
  }

  /**
   * Generate BuildTowardMajorCity options for victory condition progress.
   * For each major city not yet connected, suggest building toward it.
   */
  private static generateBuildTowardMajorCityOptions(
    snapshot: WorldSnapshot,
    pointLookup: Map<string, GridPoint>,
  ): FeasibleOption[] {
    const options: FeasibleOption[] = [];
    const budget = Math.min(snapshot.cash, TURN_BUILD_BUDGET);

    if (budget < 1) return options;

    const majorCityGroups = getMajorCityGroups();

    for (const group of majorCityGroups) {
      const connected = snapshot.majorCityConnectionStatus.get(group.cityName);
      if (connected) continue;

      // Estimate cost to extend network toward this city
      const cityKeys = [
        nodeKey(group.center.row, group.center.col),
        ...group.outposts.map(o => nodeKey(o.row, o.col)),
      ];
      const estimatedCost = this.estimateBuildCost(cityKeys, snapshot, pointLookup);

      const params = {
        majorCity: group.cityName,
        estimatedCost,
        budget,
      };

      if (snapshot.trackNetworkGraph.size === 0) {
        // No track yet - building toward a major city is always a first step option
        options.push(makeFeasible(AIActionType.BuildTowardMajorCity, {
          ...params,
          note: 'No track built yet - start from this major city',
        }));
      } else if (estimatedCost > budget) {
        options.push(makeInfeasible(
          AIActionType.BuildTowardMajorCity,
          params,
          `Estimated cost ${estimatedCost}M exceeds turn budget ${budget}M (can still make progress)`,
        ));
        // Even if over budget, the bot can make progress - add a feasible partial option
        options.push(makeFeasible(AIActionType.BuildTowardMajorCity, {
          ...params,
          partial: true,
          note: `Can build ${budget}M of estimated ${estimatedCost}M toward ${group.cityName}`,
        }));
      } else {
        options.push(makeFeasible(AIActionType.BuildTowardMajorCity, params));
      }
    }

    return options;
  }
}
