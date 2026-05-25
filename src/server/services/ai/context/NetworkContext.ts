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
  GameState,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../../shared/services/majorCityGroups';
import { getConnectedMajorCities } from '../connectedMajorCities';
import { hexDistance, estimatePathCost, getFerryPairPort } from '../../MapTopology';

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

/**
 * JIRA-244: Returns true if `coord` is reachable on the given track network,
 * accounting for paid ferry crossings.
 *
 * A coord is on-network if:
 *   (a) it is a direct node in network.nodes ("row,col"), OR
 *   (b) it is the partner endpoint of a ferry edge whose other endpoint IS in network.nodes.
 *
 * This is the shared reachability check used by both computeCitiesOnNetwork (Fix A)
 * and the MovementPhasePlanner A3 empty-result branch (Fix B).
 */
export function isCoordOnNetwork(
  coord: { row: number; col: number },
  network: ReturnType<typeof buildTrackNetwork>,
  ferryEdges: ReturnType<typeof getFerryEdges>,
): boolean {
  const coordKey = `${coord.row},${coord.col}`;
  if (network.nodes.has(coordKey)) return true;

  for (const ferry of ferryEdges) {
    const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
    const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
    if (coordKey === bKey && network.nodes.has(aKey)) return true;
    if (coordKey === aKey && network.nodes.has(bKey)) return true;
  }
  return false;
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

  /** All city names anywhere on the bot's track network (not speed-limited).
   *
   * JIRA-244: Includes cities reachable via paid ferry crossing — if the bot
   * has track to a ferry port, the partner endpoint's city is also on-network.
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

    // JIRA-244 Fix A: walk ferry edges and include partner-endpoint cities when
    // exactly one endpoint is in network.nodes (paid ferry grants access to partner).
    const ferryEdges = getFerryEdges();
    for (const ferry of ferryEdges) {
      const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
      const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
      const aOnNetwork = network.nodes.has(aKey);
      const bOnNetwork = network.nodes.has(bKey);
      if (aOnNetwork && !bOnNetwork) {
        const partnerPoint = gridPoints.find(gp => gp.row === ferry.pointB.row && gp.col === ferry.pointB.col);
        if (partnerPoint?.city?.name) {
          cityNames.add(partnerPoint.city.name);
        }
      } else if (bOnNetwork && !aOnNetwork) {
        const partnerPoint = gridPoints.find(gp => gp.row === ferry.pointA.row && gp.col === ferry.pointA.col);
        if (partnerPoint?.city?.name) {
          cityNames.add(partnerPoint.city.name);
        }
      }
      // Both on network: partner city already added by the nodes loop above — no duplicate.
    }

    return Array.from(cityNames);
  }

  /**
   * Determine game phase from connected major cities and cash.
   *
   * JIRA-265 Layer 3: when the bot's persistent gameState has latched to End
   * (cash > $200M), the display must never drop back to "Mid Game" — that's
   * what produced the confusing "Mid Game | Cash: 255M" output in game
   * 086fa2ce s1 T65 (cash $255M but only 4 majors → old logic returned
   * Mid Game because the major-city thresholds dominated). With gameState=End
   * forced, the only relevant refinement is whether victory is one step away.
   */
  static computePhase(
    snapshot: WorldSnapshot,
    connectedMajorCities: string[],
    gameState?: GameState,
  ): string {
    if (snapshot.gameStatus === 'initialBuild') return 'Initial Build';
    if (gameState === GameState.End) {
      if (connectedMajorCities.length >= 7 && snapshot.bot.money >= 250) return 'Victory Imminent';
      if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
      return 'End Game';
    }
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

  // ── Track summary (JIRA-133) ──────────────────────────────────────────────

  private static readonly MAP_CENTER_ROW = 30;
  private static readonly MAP_CENTER_COL = 40;

  private static compassDirection(row: number, col: number): string {
    const dr = row - NetworkContext.MAP_CENTER_ROW;
    const dc = col - NetworkContext.MAP_CENTER_COL;
    if (Math.abs(dr) < 3 && Math.abs(dc) < 5) return 'central';
    const angle = Math.atan2(dc, -dr) * 180 / Math.PI;
    if (angle >= -22.5 && angle < 22.5) return 'north';
    if (angle >= 22.5 && angle < 67.5) return 'northeast';
    if (angle >= 67.5 && angle < 112.5) return 'east';
    if (angle >= 112.5 && angle < 157.5) return 'southeast';
    if (angle >= 157.5 || angle < -157.5) return 'south';
    if (angle >= -157.5 && angle < -112.5) return 'southwest';
    if (angle >= -112.5 && angle < -67.5) return 'west';
    return 'northwest';
  }

  /** Summarize track as "N mileposts. Backbone: City1 → City2. Spurs: ..." (JIRA-133). */
  static computeTrackSummary(segments: TrackSegment[], gridPoints: GridPoint[]): string {
    if (segments.length === 0) return 'No track built';
    const mileposts = segments.length;
    const cityPositions = new Map<string, { row: number; col: number; isMajor: boolean }>();
    for (const seg of segments) {
      for (const endpoint of [seg.from, seg.to]) {
        const gp = gridPoints.find(p => p.row === endpoint.row && p.col === endpoint.col);
        if (gp?.city?.name && !cityPositions.has(gp.city.name)) {
          cityPositions.set(gp.city.name, { row: gp.row, col: gp.col, isMajor: gp.terrain === TerrainType.MajorCity });
        }
      }
    }
    if (cityPositions.size === 0) return `${mileposts} mileposts (no cities connected yet)`;
    const majorCities = Array.from(cityPositions.entries())
      .filter(([, info]) => info.isMajor)
      .map(([name, info]) => ({ name, ...info }));
    if (majorCities.length === 0) return `${mileposts} mileposts covering ${Array.from(cityPositions.keys()).join(', ')}`;
    majorCities.sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row);
    const majorCityNames = new Set(majorCities.map(c => c.name));
    const spurs: Array<{ name: string; nearestMajor: string; direction: string }> = [];
    for (const [name, info] of cityPositions) {
      if (majorCityNames.has(name)) continue;
      let nearest = majorCities[0]; let bestDist = Infinity;
      for (const mc of majorCities) {
        const dist = hexDistance(info.row, info.col, mc.row, mc.col);
        if (dist < bestDist) { bestDist = dist; nearest = mc; }
      }
      spurs.push({ name, nearestMajor: nearest.name, direction: NetworkContext.compassDirection(info.row, info.col) });
    }
    const backboneStr = majorCities.map(c => c.name).join(' → ');
    const backboneDir = majorCities.length > 0
      ? NetworkContext.compassDirection(
          Math.round(majorCities.reduce((s, c) => s + c.row, 0) / majorCities.length),
          Math.round(majorCities.reduce((s, c) => s + c.col, 0) / majorCities.length),
        )
      : '';
    let result = `${mileposts} mileposts. Backbone: ${backboneStr}`;
    if (backboneDir) result += ` (${backboneDir})`;
    if (spurs.length > 0) result += `. Spurs: ${spurs.map(s => `${s.name} (${s.direction} via ${s.nearestMajor})`).join(', ')}`;
    return result;
  }
}
