import { VICTORY_CITY_COUNT } from '../../shared/types/GameTypes';
import { getMajorCityGroups, getFerryEdges } from '../../shared/services/majorCityGroups';
import type { TrackSegment } from '../../shared/types/TrackTypes';

export interface MajorCityCoordinate {
  name: string;
  row: number;
  col: number;
}

export enum UnmetWinCondition {
  InsufficientFunds = 'insufficient-funds',
  InsufficientCities = 'insufficient-cities',
}

export interface WinConditionsEvaluation {
  eligible: boolean;
  netWorth: number;
  connectedCities: MajorCityCoordinate[];
  unmetCondition?: UnmetWinCondition;
}

/** Pure evaluation of persisted player data; no mutable game state is retained. */
export class WinConditionsService {
  static evaluate(
    money: number,
    debt: number,
    segments: TrackSegment[],
    threshold: number,
  ): WinConditionsEvaluation {
    const netWorth = money - debt;
    const connectedCities = this.getConnectedMajorCities(segments);
    const unmetCondition = netWorth < threshold
      ? UnmetWinCondition.InsufficientFunds
      : connectedCities.length < VICTORY_CITY_COUNT
        ? UnmetWinCondition.InsufficientCities
        : undefined;
    return { eligible: unmetCondition === undefined, netWorth, connectedCities, unmetCondition };
  }

  /** Returns unique major cities in the component containing the most cities. */
  static getConnectedMajorCities(segments: TrackSegment[]): MajorCityCoordinate[] {
    if (segments.length === 0) return [];

    const graph = buildTrackGraph(segments);
    const cityGroups = getMajorCityGroups();

    // Find all connected components
    const allNodes = new Set(graph.keys());
    const visited = new Set<string>();
    const components: Set<string>[] = [];

    for (const startKey of allNodes) {
      if (!visited.has(startKey)) {
        const component = bfs(graph, startKey);
        component.forEach(node => visited.add(node));
        components.push(component);
      }
    }

    // Find the component with the most major cities
    let bestComponent: Set<string> | null = null;
    let bestCityCount = 0;

    for (const component of components) {
      let cityCount = 0;
      for (const group of cityGroups) {
        const allMileposts = [group.center, ...group.outposts];
        for (const mp of allMileposts) {
          if (component.has(`${mp.row},${mp.col}`)) {
            cityCount++;
            break;
          }
        }
      }
      if (cityCount > bestCityCount) {
        bestCityCount = cityCount;
        bestComponent = component;
      }
    }

    if (!bestComponent) return [];

    // Collect city details for cities in the best component
    const cities: MajorCityCoordinate[] = [];
    for (const group of cityGroups) {
      const allMileposts = [group.center, ...group.outposts];
      for (const mp of allMileposts) {
        if (bestComponent.has(`${mp.row},${mp.col}`)) {
          cities.push({ name: group.cityName, row: mp.row, col: mp.col });
          break; // One representative per city
        }
      }
    }

    return cities;
  }
}

/**
 * Build an adjacency graph from track segments, with implicit edges for:
 * - Major city internal connectivity (all outposts of the same city are connected)
 * - Ferry connections (both endpoints present = connected)
 */
function buildTrackGraph(segments: TrackSegment[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string): void => {
    if (!graph.has(from)) graph.set(from, new Set());
    if (!graph.has(to)) graph.set(to, new Set());
    graph.get(from)!.add(to);
    graph.get(to)!.add(from);
  };

  // Add edges from track segments
  for (const segment of segments) {
    const fromKey = `${segment.from.row},${segment.from.col}`;
    const toKey = `${segment.to.row},${segment.to.col}`;
    addEdge(fromKey, toKey);
  }

  // Add implicit edges within major cities
  const cityGroups = getMajorCityGroups();
  for (const group of cityGroups) {
    const allMileposts = [group.center, ...group.outposts];
    const cityNodesInGraph = allMileposts
      .map(mp => `${mp.row},${mp.col}`)
      .filter(key => graph.has(key));

    // Fully connect all city nodes that are in the graph
    for (let i = 0; i < cityNodesInGraph.length; i++) {
      for (let j = i + 1; j < cityNodesInGraph.length; j++) {
        addEdge(cityNodesInGraph[i], cityNodesInGraph[j]);
      }
    }
  }

  // Add implicit ferry edges
  const ferryEdges = getFerryEdges();
  for (const ferry of ferryEdges) {
    const keyA = `${ferry.pointA.row},${ferry.pointA.col}`;
    const keyB = `${ferry.pointB.row},${ferry.pointB.col}`;
    if (graph.has(keyA) && graph.has(keyB)) {
      addEdge(keyA, keyB);
    }
  }

  return graph;
}

/** BFS from a starting node, returning all reachable nodes. */
function bfs(graph: Map<string, Set<string>>, startKey: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startKey];
  visited.add(startKey);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = graph.get(current) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}
