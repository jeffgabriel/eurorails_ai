/**
 * NetworkContext — Computes bot's network state: reachable cities, cities on
 * network, connected/unconnected major cities, and victory phase.
 *
 * Single responsibility: given the world snapshot and grid data, compute
 * all network-topology-derived context fields.
 *
 * JIRA-195: Extracted from ContextBuilder as part of Slice 1 decomposition.
 * Delegates to ContextBuilder static methods that still hold the full
 * implementation until BE-004 completes the code-motion.
 */

import {
  WorldSnapshot,
  GridPoint,
  TrainType,
  TRAIN_PROPERTIES,
  TrackSegment,
  TerrainType,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../../shared/services/majorCityGroups';
import { getConnectedMajorCities } from '../connectedMajorCities';
import { hexDistance, estimatePathCost, getFerryPairPort } from '../MapTopology';

/** Internal result type for NetworkContext.compute() */
export interface NetworkContextResult {
  /** Track network object (null if no segments yet) */
  network: ReturnType<typeof buildTrackNetwork> | null;
  /** City names reachable within the bot's speed this turn */
  reachableCities: string[];
  /** All city names anywhere on the bot's track network */
  citiesOnNetwork: string[];
  /** Names of major cities connected by bot's continuous track */
  connectedMajorCities: string[];
  /** Major cities not yet connected, sorted by estimated track cost */
  unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>;
  /** Bot's current game phase (Early Game / Mid Game / Late Game / Victory Imminent) */
  phase: string;
  /** Bot's position city name (if on a city) */
  positionCityName: string | undefined;
}

export class NetworkContext {
  /**
   * Compute all network-topology context fields from the world snapshot.
   */
  static compute(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): NetworkContextResult {
    const botPosition = snapshot.bot.position;
    const trainType = snapshot.bot.trainType as TrainType;
    const trainProps = TRAIN_PROPERTIES[trainType];
    const speed = snapshot.bot.ferryHalfSpeed
      ? Math.ceil(trainProps.speed / 2)
      : trainProps.speed;

    const network = snapshot.bot.existingSegments.length > 0
      ? buildTrackNetwork(snapshot.bot.existingSegments)
      : null;

    const reachableCities = botPosition && network
      ? NetworkContext.computeReachableCities(botPosition, speed, network, gridPoints)
      : [];

    const citiesOnNetwork = network
      ? NetworkContext.computeCitiesOnNetwork(network, gridPoints)
      : [];

    const connectedMajorCities = getConnectedMajorCities(snapshot.bot.existingSegments).map(c => c.name);

    const unconnectedMajorCities = NetworkContext.computeUnconnectedMajorCities(
      connectedMajorCities, snapshot.bot.existingSegments, gridPoints,
    );

    const phase = NetworkContext.computePhase(snapshot, connectedMajorCities);

    const positionCityName = botPosition
      ? gridPoints.find(gp => gp.row === botPosition.row && gp.col === botPosition.col)?.city?.name
      : undefined;

    return {
      network,
      reachableCities,
      citiesOnNetwork,
      connectedMajorCities,
      unconnectedMajorCities,
      phase,
      positionCityName,
    };
  }

  /** BFS reachability from bot position within speed limit. */
  static computeReachableCities(
    position: { row: number; col: number },
    speed: number,
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
    _visitedFerryPorts?: Set<string>,
  ): string[] {
    const startKey = `${position.row},${position.col}`;
    const visitedFerryPorts = _visitedFerryPorts ?? new Set<string>();

    // Ferry teleportation at start (matching ActionResolver behavior)
    const ferryStartPoint = gridPoints.find(gp => gp.row === position.row && gp.col === position.col);
    if (ferryStartPoint?.terrain === TerrainType.FerryPort && !visitedFerryPorts.has(startKey)) {
      visitedFerryPorts.add(startKey);
      const ferryEdges = getFerryEdges();
      const pairedPort = getFerryPairPort(position.row, position.col, ferryEdges);
      if (pairedPort) {
        const pairedKey = `${pairedPort.row},${pairedPort.col}`;
        if (network.nodes.has(pairedKey)) {
          const ferryReachable = NetworkContext.computeReachableCities(
            pairedPort, speed, network, gridPoints, visitedFerryPorts,
          );
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
      // Snap to nearest network node
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
      if (!bestKey || bestDist > 3) return [];
      const [snapRow, snapCol] = bestKey.split(',').map(Number);
      const adjustedSpeed = Math.max(0, speed - bestDist);
      if (adjustedSpeed <= 0) return [];
      return NetworkContext.computeReachableCities(
        { row: snapRow, col: snapCol }, adjustedSpeed, network, gridPoints, visitedFerryPorts,
      );
    }

    const gridLookup = new Map<string, GridPoint>();
    for (const gp of gridPoints) {
      gridLookup.set(`${gp.row},${gp.col}`, gp);
    }

    const visited = new Map<string, number>(); // key -> remaining speed when visited
    const queue: Array<{ key: string; remaining: number }> = [{ key: startKey, remaining: speed }];
    const reachableCityNames = new Set<string>();
    visited.set(startKey, speed);

    const startPoint = gridLookup.get(startKey);
    if (startPoint?.city?.name) {
      reachableCityNames.add(startPoint.city.name);
    }

    while (queue.length > 0) {
      const { key, remaining } = queue.shift()!;
      if (remaining <= 0) continue;

      const neighbors = network.edges.get(key) ?? [];
      for (const neighborKey of neighbors) {
        const cost = 1; // each milepost costs 1 movement
        const newRemaining = remaining - cost;
        if (newRemaining < 0) continue;

        const prevRemaining = visited.get(neighborKey) ?? -1;
        if (newRemaining <= prevRemaining) continue;

        visited.set(neighborKey, newRemaining);
        const neighborPoint = gridLookup.get(neighborKey);
        if (neighborPoint?.city?.name) {
          reachableCityNames.add(neighborPoint.city.name);
        }
        queue.push({ key: neighborKey, remaining: newRemaining });
      }
    }

    return Array.from(reachableCityNames);
  }

  /** All city names anywhere on the bot's track network (not speed-limited). */
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

  /** Determine game phase from connected major cities and cash. */
  static computePhase(
    snapshot: WorldSnapshot,
    connectedMajorCities: string[],
  ): string {
    if (snapshot.gameStatus === 'initialBuild') return 'Initial Build';
    if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 250) return 'Victory Imminent';
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 150) return 'Late Game';
    if (connectedMajorCities.length >= 3 || snapshot.bot.money >= 80) return 'Mid Game';
    return 'Early Game';
  }

  /** Unconnected major cities with estimated track cost from current network. */
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
        estimatedCost: NetworkContext.estimateTrackCostToCity(cityName, segments, gridPoints),
      }))
      .sort((a, b) => a.estimatedCost - b.estimatedCost);
  }

  /** Estimate track cost to connect a major city from the existing network. */
  private static estimateTrackCostToCity(
    cityName: string,
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): number {
    const cityGroup = getMajorCityGroups().find(g => g.cityName === cityName);
    if (!cityGroup) return 999;

    const targetPoints = [cityGroup.center, ...cityGroup.outposts];

    if (segments.length === 0) {
      // No network — just estimate from map center
      const minDist = Math.min(
        ...targetPoints.map(tp => hexDistance(30, 40, tp.row, tp.col)),
      );
      return minDist * 1.5; // rough cost estimate
    }

    // Find the nearest point on current network to the city
    const networkNodes = new Set<string>();
    for (const seg of segments) {
      networkNodes.add(`${seg.from.row},${seg.from.col}`);
      networkNodes.add(`${seg.to.row},${seg.to.col}`);
    }

    let minCost = Infinity;
    for (const nodeKey of Array.from(networkNodes)) {
      const [r, c] = nodeKey.split(',').map(Number);
      for (const tp of targetPoints) {
        const cost = estimatePathCost(r, c, tp.row, tp.col);
        if (cost < minCost) minCost = cost;
      }
    }

    return minCost === Infinity ? 999 : minCost;
  }
}
