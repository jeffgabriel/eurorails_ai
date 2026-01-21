import { TrackSegment } from '../../shared/types/TrackTypes';
import { majorCityGroups, mapConfig } from '../config/mapConfig';

export interface MajorCityConnection {
  name: string;
  row: number;
  col: number;
}

export class VictoryService {
  private static instance: VictoryService;

  static getInstance(): VictoryService {
    if (!VictoryService.instance) {
      VictoryService.instance = new VictoryService();
    }
    return VictoryService.instance;
  }

  /**
   * Get all major city mileposts (center + outposts) grouped by city name
   * Returns a map of city name -> array of {row, col} coordinates
   */
  getMajorCityMileposts(): Map<string, Array<{ row: number; col: number }>> {
    const cityMileposts = new Map<string, Array<{ row: number; col: number }>>();

    for (const [cityName, mileposts] of Object.entries(majorCityGroups)) {
      const coords = mileposts.map((mp: { GridX: number; GridY: number }) => ({
        row: mp.GridY,
        col: mp.GridX,
      }));
      cityMileposts.set(cityName, coords);
    }

    return cityMileposts;
  }

  /**
   * Build a graph from track segments for connectivity checking
   * Uses row,col as node identifiers
   *
   * IMPORTANT: This also adds implicit edges between all outposts of the same
   * major city. When a track enters a major city at one outpost and exits at
   * another, there's no explicit track segment connecting them - but they should
   * be connected because they're part of the same city's rail network.
   */
  private buildTrackGraph(segments: TrackSegment[]): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();

    const addEdge = (from: string, to: string) => {
      if (!graph.has(from)) {
        graph.set(from, new Set());
      }
      if (!graph.has(to)) {
        graph.set(to, new Set());
      }
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
    // All outposts of the same city are connected via the city's internal rail network
    const cityMileposts = this.getMajorCityMileposts();
    for (const [, mileposts] of cityMileposts) {
      // Find which mileposts of this city are in the graph
      const cityNodesInGraph = mileposts
        .map(mp => `${mp.row},${mp.col}`)
        .filter(key => graph.has(key));

      // Connect all city nodes to each other (fully connected within the city)
      for (let i = 0; i < cityNodesInGraph.length; i++) {
        for (let j = i + 1; j < cityNodesInGraph.length; j++) {
          addEdge(cityNodesInGraph[i], cityNodesInGraph[j]);
        }
      }
    }

    // Add implicit edges for ferry connections
    // When both endpoints of a ferry are in the track, they're connected
    if (mapConfig?.ferryConnections) {
      for (const ferry of mapConfig.ferryConnections) {
        const point1 = ferry.connections[0];
        const point2 = ferry.connections[1];
        const key1 = `${point1.row},${point1.col}`;
        const key2 = `${point2.row},${point2.col}`;

        if (graph.has(key1) && graph.has(key2)) {
          addEdge(key1, key2);
        }
      }
    }

    return graph;
  }

  /**
   * Find all nodes connected to a starting node using BFS
   */
  private findConnectedNodes(graph: Map<string, Set<string>>, startKey: string): Set<string> {
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

  /**
   * Get all major cities connected by a player's track network
   * A city is "connected" if any of its mileposts (center or outposts) are in the track network
   *
   * IMPORTANT: All connected cities must be in the SAME connected component.
   * We find the largest component that contains major cities and return those cities.
   */
  getConnectedMajorCities(segments: TrackSegment[]): MajorCityConnection[] {
    if (segments.length === 0) {
      return [];
    }

    const graph = this.buildTrackGraph(segments);
    const cityMileposts = this.getMajorCityMileposts();

    // Find all connected components
    const allNodes = new Set(graph.keys());
    const visited = new Set<string>();
    const components: Set<string>[] = [];

    for (const startKey of allNodes) {
      if (!visited.has(startKey)) {
        const component = this.findConnectedNodes(graph, startKey);
        component.forEach(node => visited.add(node));
        components.push(component);
      }
    }

    // For each component, count how many major cities it contains
    let bestComponent: Set<string> | null = null;
    let bestCityCount = 0;

    for (const component of components) {
      let cityCount = 0;
      for (const [, mileposts] of cityMileposts) {
        for (const mp of mileposts) {
          const key = `${mp.row},${mp.col}`;
          if (component.has(key)) {
            cityCount++;
            break; // Only count each city once
          }
        }
      }
      if (cityCount > bestCityCount) {
        bestCityCount = cityCount;
        bestComponent = component;
      }
    }

    if (!bestComponent) {
      return [];
    }

    // Find which major cities have at least one milepost in the best component
    const connectedCities: MajorCityConnection[] = [];

    for (const [cityName, mileposts] of cityMileposts) {
      for (const mp of mileposts) {
        const key = `${mp.row},${mp.col}`;
        if (bestComponent.has(key)) {
          // City is connected - use the first milepost we found as the representative
          connectedCities.push({
            name: cityName,
            row: mp.row,
            col: mp.col,
          });
          break; // Only count each city once
        }
      }
    }

    return connectedCities;
  }

  /**
   * Check if a player meets the victory condition for major cities
   * Returns true if 7 or more major cities are connected
   */
  hasSevenConnectedCities(segments: TrackSegment[]): boolean {
    const connectedCities = this.getConnectedMajorCities(segments);
    return connectedCities.length >= 7;
  }

  /**
   * Check if a player meets all victory conditions
   */
  checkVictoryConditions(
    money: number,
    segments: TrackSegment[],
    threshold: number
  ): { eligible: boolean; connectedCities: MajorCityConnection[] } {
    const connectedCities = this.getConnectedMajorCities(segments);
    const hasEnoughMoney = money >= threshold;
    const hasEnoughCities = connectedCities.length >= 7;

    return {
      eligible: hasEnoughMoney && hasEnoughCities,
      connectedCities,
    };
  }
}
