import {
  TrainType,
  TRAIN_PROPERTIES,
  TrackSegment,
  GridPoint,
  TerrainType,
  TRACK_USAGE_FEE,
} from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import {
  buildUnionTrackGraph,
  Node,
} from '../../shared/services/trackUsageFees';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';
import { WorldSnapshot, FeasibilityResult } from './types';

// --- Constants ---

const MAX_BUILD_PER_TURN = 20;

const TERRAIN_COSTS: Record<TerrainType, number> = {
  [TerrainType.Clear]: 1,
  [TerrainType.Mountain]: 2,
  [TerrainType.Alpine]: 5,
  [TerrainType.SmallCity]: 3,
  [TerrainType.MediumCity]: 3,
  [TerrainType.MajorCity]: 5,
  [TerrainType.FerryPort]: 1, // Base cost; actual ferry crossing cost comes from ferryConnection.cost
  [TerrainType.Water]: 0,
};

const UPGRADE_COST = 20;
const CROSSGRADE_COST = 5;

interface UpgradePath {
  targetTrainType: TrainType;
  kind: 'upgrade' | 'crossgrade';
  cost: number;
}

const VALID_UPGRADES: Record<TrainType, UpgradePath[]> = {
  [TrainType.Freight]: [
    { targetTrainType: TrainType.FastFreight, kind: 'upgrade', cost: UPGRADE_COST },
    { targetTrainType: TrainType.HeavyFreight, kind: 'upgrade', cost: UPGRADE_COST },
  ],
  [TrainType.FastFreight]: [
    { targetTrainType: TrainType.Superfreight, kind: 'upgrade', cost: UPGRADE_COST },
    { targetTrainType: TrainType.HeavyFreight, kind: 'crossgrade', cost: CROSSGRADE_COST },
  ],
  [TrainType.HeavyFreight]: [
    { targetTrainType: TrainType.Superfreight, kind: 'upgrade', cost: UPGRADE_COST },
    { targetTrainType: TrainType.FastFreight, kind: 'crossgrade', cost: CROSSGRADE_COST },
  ],
  [TrainType.Superfreight]: [],
};

// --- Helpers ---

function nodeKey(n: Node): string {
  return `${n.row},${n.col}`;
}

function parseNodeKey(k: string): Node {
  const [rowStr, colStr] = k.split(',');
  return { row: Number(rowStr), col: Number(colStr) };
}

function pointToNode(p: { row: number; col: number }): Node {
  return { row: p.row, col: p.col };
}

function isCityTerrain(terrain: TerrainType): boolean {
  return (
    terrain === TerrainType.SmallCity ||
    terrain === TerrainType.MediumCity ||
    terrain === TerrainType.MajorCity
  );
}

function findGridPoint(mapPoints: GridPoint[], row: number, col: number): GridPoint | undefined {
  return mapPoints.find((p) => p.row === row && p.col === col);
}

// --- Reachability ---

export interface ReachableCity {
  cityName: string;
  row: number;
  col: number;
  distance: number;
  terrain: TerrainType;
}

/**
 * BFS on the union track graph to find all cities reachable within maxMovement mileposts.
 * Movement counts each edge traversal as 1 milepost.
 */
export function computeReachableCities(
  snapshot: WorldSnapshot,
  maxMovement: number,
): ReachableCity[] {
  if (!snapshot.position) return [];

  const { adjacency } = buildUnionTrackGraph({
    allTracks: snapshot.allPlayerTracks,
  });

  const startKey = nodeKey(pointToNode(snapshot.position));
  const distances = new Map<string, number>();
  distances.set(startKey, 0);
  const queue: string[] = [startKey];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDist = distances.get(current)!;
    if (currentDist >= maxMovement) continue;

    const neighbors = adjacency.get(current);
    if (!neighbors) continue;

    for (const next of neighbors) {
      if (!distances.has(next)) {
        distances.set(next, currentDist + 1);
        queue.push(next);
      }
    }
  }

  // Collect cities from reachable nodes
  const cities: ReachableCity[] = [];
  for (const [key, dist] of distances) {
    const node = parseNodeKey(key);
    const gridPoint = findGridPoint(snapshot.mapPoints, node.row, node.col);
    if (gridPoint && gridPoint.city && isCityTerrain(gridPoint.terrain)) {
      cities.push({
        cityName: gridPoint.city.name,
        row: node.row,
        col: node.col,
        distance: dist,
        terrain: gridPoint.terrain,
      });
    }
  }

  return cities;
}

// --- Delivery Feasibility ---

/**
 * Validates whether a delivery action is feasible.
 * Checks: bot carries the load, demand card is valid, destination is reachable.
 */
export function validateDeliveryFeasibility(
  snapshot: WorldSnapshot,
  demandCardId: number,
  demandIndex: number,
): FeasibilityResult {
  // Find the demand card
  const card = snapshot.demandCards.find((c) => c.id === demandCardId);
  if (!card) {
    return { feasible: false, reason: `Demand card ${demandCardId} not in hand` };
  }

  // Validate demand index
  if (demandIndex < 0 || demandIndex >= card.demands.length) {
    return { feasible: false, reason: `Invalid demand index ${demandIndex}` };
  }

  const demand = card.demands[demandIndex];

  // Check bot carries the required load
  if (!snapshot.carriedLoads.includes(demand.resource)) {
    return { feasible: false, reason: `Not carrying ${demand.resource}` };
  }

  // Check bot has a position
  if (!snapshot.position) {
    return { feasible: false, reason: 'Bot has no position on the map' };
  }

  // Check destination city is reachable within remaining movement
  const reachable = computeReachableCities(snapshot, snapshot.remainingMovement);
  const canReach = reachable.some((c) => c.cityName === demand.city);
  if (!canReach) {
    return { feasible: false, reason: `Cannot reach ${demand.city} within ${snapshot.remainingMovement} movement` };
  }

  return { feasible: true };
}

// --- Pickup Feasibility ---

/**
 * Validates whether picking up a load at a city is feasible.
 * Checks: load is available at city, city is reachable, train has capacity.
 */
export function validatePickupFeasibility(
  snapshot: WorldSnapshot,
  loadType: LoadType,
  cityName: string,
): FeasibilityResult {
  if (!snapshot.position) {
    return { feasible: false, reason: 'Bot has no position on the map' };
  }

  // Check train has capacity
  const capacity = TRAIN_PROPERTIES[snapshot.trainType].capacity;
  if (snapshot.carriedLoads.length >= capacity) {
    return { feasible: false, reason: `Train at capacity (${capacity} loads)` };
  }

  // Check load is available at the city
  const cityLoads = snapshot.loadAvailability.get(cityName);
  if (!cityLoads || !cityLoads.includes(loadType)) {
    // Also check dropped loads
    const droppedAtCity = snapshot.droppedLoads.get(cityName);
    if (!droppedAtCity || !droppedAtCity.includes(loadType)) {
      return { feasible: false, reason: `${loadType} not available at ${cityName}` };
    }
  }

  // Check city is reachable
  const reachable = computeReachableCities(snapshot, snapshot.remainingMovement);
  const canReach = reachable.some((c) => c.cityName === cityName);
  if (!canReach) {
    return { feasible: false, reason: `Cannot reach ${cityName} within ${snapshot.remainingMovement} movement` };
  }

  return { feasible: true };
}

// --- Build Track Feasibility ---

/**
 * Validates whether building track segments is feasible.
 * Checks: segments have valid cost, total cost within budget, bot has funds.
 */
export function validateBuildTrackFeasibility(
  snapshot: WorldSnapshot,
  segments: TrackSegment[],
): FeasibilityResult {
  if (segments.length === 0) {
    return { feasible: false, reason: 'No segments to build' };
  }

  // Calculate total cost
  let totalCost = 0;
  for (const seg of segments) {
    if (seg.cost <= 0) {
      return { feasible: false, reason: `Invalid segment cost: ${seg.cost}` };
    }
    totalCost += seg.cost;
  }

  // Check turn build budget
  const remainingBudget = MAX_BUILD_PER_TURN - snapshot.turnBuildCostSoFar;
  if (totalCost > remainingBudget) {
    return {
      feasible: false,
      reason: `Build cost ${totalCost}M exceeds remaining turn budget ${remainingBudget}M`,
    };
  }

  // Check bot has funds
  if (totalCost > snapshot.money) {
    return { feasible: false, reason: `Insufficient funds: need ${totalCost}M, have ${snapshot.money}M` };
  }

  return { feasible: true };
}

// --- Upgrade Feasibility ---

/**
 * Validates whether upgrading/crossgrading the train is feasible.
 * Checks: valid upgrade path exists, bot has funds, within build budget.
 */
export function validateUpgradeFeasibility(
  snapshot: WorldSnapshot,
  targetTrainType: TrainType,
): FeasibilityResult {
  if (snapshot.trainType === targetTrainType) {
    return { feasible: false, reason: 'Already have this train type' };
  }

  const upgrades = VALID_UPGRADES[snapshot.trainType];
  const upgrade = upgrades.find((u) => u.targetTrainType === targetTrainType);
  if (!upgrade) {
    return {
      feasible: false,
      reason: `No valid upgrade path from ${snapshot.trainType} to ${targetTrainType}`,
    };
  }

  // Upgrades use the build budget; crossgrades cost 5M and allow 15M build remaining
  const remainingBudget = MAX_BUILD_PER_TURN - snapshot.turnBuildCostSoFar;
  if (upgrade.cost > remainingBudget) {
    return {
      feasible: false,
      reason: `Upgrade cost ${upgrade.cost}M exceeds remaining turn budget ${remainingBudget}M`,
    };
  }

  if (upgrade.cost > snapshot.money) {
    return {
      feasible: false,
      reason: `Insufficient funds: need ${upgrade.cost}M, have ${snapshot.money}M`,
    };
  }

  return { feasible: true };
}

// --- Build Segments (Dijkstra) ---

/**
 * Computes the cheapest track segments to build from the bot's existing network
 * toward a target point, within a given budget.
 * Uses Dijkstra on the hex grid with terrain costs.
 */
export function computeBuildSegments(
  snapshot: WorldSnapshot,
  targetRow: number,
  targetCol: number,
  budget: number,
): TrackSegment[] {
  const mapPoints = snapshot.mapPoints;

  // Build a lookup for grid points
  const gridLookup = new Map<string, GridPoint>();
  for (const p of mapPoints) {
    gridLookup.set(nodeKey(pointToNode(p)), p);
  }

  // Build set of existing network nodes
  const networkNodes = new Set<string>();
  for (const seg of snapshot.trackSegments) {
    networkNodes.add(nodeKey(pointToNode(seg.from)));
    networkNodes.add(nodeKey(pointToNode(seg.to)));
  }

  // Build set of existing network edges to avoid double-building
  const networkEdges = new Set<string>();
  for (const seg of snapshot.trackSegments) {
    const a = nodeKey(pointToNode(seg.from));
    const b = nodeKey(pointToNode(seg.to));
    networkEdges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }

  const targetKey = nodeKey({ row: targetRow, col: targetCol });

  // If target is already in network, nothing to build
  if (networkNodes.has(targetKey)) return [];

  // Dijkstra from all network edge nodes (multi-source)
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();

  // Priority queue (simple array sorted by distance)
  const pq: Array<{ key: string; cost: number }> = [];

  // Seed with all network nodes at cost 0.
  // When the network is empty (first build turn), seed with the bot's
  // current position — per rules, track building starts from a major city.
  if (networkNodes.size === 0 && snapshot.position) {
    const posKey = nodeKey({ row: snapshot.position.row, col: snapshot.position.col });
    dist.set(posKey, 0);
    pq.push({ key: posKey, cost: 0 });
  } else {
    for (const nk of networkNodes) {
      dist.set(nk, 0);
      pq.push({ key: nk, cost: 0 });
    }
  }

  // Sort ascending
  pq.sort((a, b) => a.cost - b.cost);

  while (pq.length > 0) {
    const { key: current, cost: currentCost } = pq.shift()!;

    if (visited.has(current)) continue;
    visited.add(current);

    // Found target
    if (current === targetKey && currentCost > 0) break;

    // Budget exceeded
    if (currentCost > budget) break;

    const currentNode = parseNodeKey(current);
    const currentPoint = gridLookup.get(current);
    if (!currentPoint) continue;

    // Get hex neighbors
    const neighbors = getHexNeighborKeys(currentNode);

    for (const neighborKey of neighbors) {
      if (visited.has(neighborKey)) continue;

      const neighborPoint = gridLookup.get(neighborKey);
      if (!neighborPoint) continue;
      if (neighborPoint.terrain === TerrainType.Water) continue;

      // Calculate edge cost (0 if edge already in network)
      const edgeStr =
        current < neighborKey ? `${current}|${neighborKey}` : `${neighborKey}|${current}`;
      let edgeCost: number;
      if (networkEdges.has(edgeStr)) {
        edgeCost = 0;
      } else if (neighborPoint.terrain === TerrainType.FerryPort && neighborPoint.ferryConnection) {
        // Ferry ports use route-specific cost (4-16 ECU) from ferryPoints.json
        edgeCost = neighborPoint.ferryConnection.cost;
      } else {
        edgeCost = TERRAIN_COSTS[neighborPoint.terrain];
      }

      const newCost = currentCost + edgeCost;
      if (newCost > budget) continue;

      const prevCost = dist.get(neighborKey);
      if (prevCost === undefined || newCost < prevCost) {
        dist.set(neighborKey, newCost);
        prev.set(neighborKey, current);
        pq.push({ key: neighborKey, cost: newCost });
        // Re-sort (simple approach; fine for moderate grid sizes)
        pq.sort((a, b) => a.cost - b.cost);
      }
    }
  }

  // Reconstruct path from target back to network
  if (!prev.has(targetKey)) return []; // No path found within budget

  const pathKeys: string[] = [];
  let step = targetKey;
  while (prev.has(step)) {
    pathKeys.unshift(step);
    step = prev.get(step)!;
  }
  pathKeys.unshift(step); // Add the network source node

  // Convert path to new segments (skip edges already in network)
  const segments: TrackSegment[] = [];
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const fromKey = pathKeys[i];
    const toKey = pathKeys[i + 1];
    const edgeStr = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;

    // Skip already-built edges
    if (networkEdges.has(edgeStr)) continue;

    const fromPoint = gridLookup.get(fromKey)!;
    const toPoint = gridLookup.get(toKey)!;

    // Ferry ports use route-specific cost; other terrain uses the cost table
    const segCost =
      toPoint.terrain === TerrainType.FerryPort && toPoint.ferryConnection
        ? toPoint.ferryConnection.cost
        : TERRAIN_COSTS[toPoint.terrain];

    segments.push({
      from: {
        x: fromPoint.x,
        y: fromPoint.y,
        row: fromPoint.row,
        col: fromPoint.col,
        terrain: fromPoint.terrain,
      },
      to: {
        x: toPoint.x,
        y: toPoint.y,
        row: toPoint.row,
        col: toPoint.col,
        terrain: toPoint.terrain,
      },
      cost: segCost,
    });
  }

  return segments;
}

// --- Connected Major Cities ---

/**
 * Counts how many major cities the bot's track network connects.
 * A major city is "connected" if any of its mileposts (center or outpost) appear
 * in the bot's track network.
 */
export function countConnectedMajorCities(snapshot: WorldSnapshot): number {
  const majorCityGroups = getMajorCityGroups();

  // Build set of all nodes in the bot's track network
  const networkNodes = new Set<string>();
  for (const seg of snapshot.trackSegments) {
    networkNodes.add(nodeKey(pointToNode(seg.from)));
    networkNodes.add(nodeKey(pointToNode(seg.to)));
  }

  let count = 0;
  for (const city of majorCityGroups) {
    const centerKey = nodeKey(city.center);
    const outpostKeys = city.outposts.map((o) => nodeKey(o));

    if (networkNodes.has(centerKey) || outpostKeys.some((k) => networkNodes.has(k))) {
      count++;
    }
  }

  return count;
}

// --- Hex Grid Neighbors ---

/**
 * Returns the node keys of all hex-adjacent cells for a given node.
 * Even rows: neighbors on adjacent rows shift left (col, col-1)
 * Odd rows: neighbors on adjacent rows shift right (col, col+1)
 */
function getHexNeighborKeys(node: Node): string[] {
  const { row, col } = node;
  const isOdd = row % 2 === 1;
  const keys: string[] = [];

  // Same row: left and right
  keys.push(nodeKey({ row, col: col - 1 }));
  keys.push(nodeKey({ row, col: col + 1 }));

  if (isOdd) {
    // Odd row: upper/lower neighbors at (col, col+1)
    keys.push(nodeKey({ row: row - 1, col }));
    keys.push(nodeKey({ row: row - 1, col: col + 1 }));
    keys.push(nodeKey({ row: row + 1, col }));
    keys.push(nodeKey({ row: row + 1, col: col + 1 }));
  } else {
    // Even row: upper/lower neighbors at (col-1, col)
    keys.push(nodeKey({ row: row - 1, col: col - 1 }));
    keys.push(nodeKey({ row: row - 1, col }));
    keys.push(nodeKey({ row: row + 1, col: col - 1 }));
    keys.push(nodeKey({ row: row + 1, col }));
  }

  return keys;
}

// --- Exports for upgrade path lookup ---

export { VALID_UPGRADES, TERRAIN_COSTS, MAX_BUILD_PER_TURN };
