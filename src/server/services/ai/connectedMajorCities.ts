/**
 * connectedMajorCities — Server-side utility to count major cities
 * connected by a player's track network.
 *
 * Ports the client-side VictoryService.getConnectedMajorCities() logic
 * for use in the AI pipeline (WorldSnapshot, Scorer, OptionGenerator).
 *
 * Algorithm:
 * 1. Build an adjacency graph from track segments
 * 2. Add implicit intra-city edges (major city outposts are internally connected)
 * 3. Add implicit ferry edges (both endpoints present = connected)
 * 4. Find connected components via BFS
 * 5. Return the count of major cities in the largest component
 */

import { TrackSegment } from '../../../shared/types/GameTypes';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';

/**
 * Count the number of major cities connected by a continuous track network.
 *
 * Only cities in the single largest connected component are counted,
 * matching the game's victory rule ("continuous line of track connects
 * seven major cities").
 *
 * @param segments - The player's built track segments
 * @returns Number of unique major cities connected in the largest component
 */
export function getConnectedMajorCityCount(segments: TrackSegment[]): number {
  if (segments.length === 0) return 0;

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

  // For each component, count how many major cities it contains
  let bestCityCount = 0;

  for (const component of components) {
    let cityCount = 0;
    for (const group of cityGroups) {
      // A city is connected if ANY of its mileposts (center or outposts) are in the component
      const allMileposts = [group.center, ...group.outposts];
      for (const mp of allMileposts) {
        if (component.has(`${mp.row},${mp.col}`)) {
          cityCount++;
          break; // Only count each city once
        }
      }
    }
    if (cityCount > bestCityCount) {
      bestCityCount = cityCount;
    }
  }

  return bestCityCount;
}

/**
 * Build an adjacency graph from track segments, with implicit edges for:
 * - Major city internal connectivity (all outposts of the same city are connected)
 * - Ferry connections (both endpoints present = connected)
 */
function buildTrackGraph(segments: TrackSegment[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string) => {
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
