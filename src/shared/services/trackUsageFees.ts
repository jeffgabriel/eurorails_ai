import { PlayerTrackState, TrackSegment } from "../types/TrackTypes";
import { getMajorCityGroups, MajorCityGroup, getFerryEdges, FerryEdge } from "./majorCityGroups";

export type Node = { row: number; col: number };

export type PathEdge = {
  from: Node;
  to: Node;
  ownerPlayerIds: string[];
};

export type TrackUsageComputation = {
  isValid: boolean;
  errorMessage?: string;
  path: PathEdge[];
  ownersUsed: Set<string>;
};

function nodeKey(n: Node): string {
  return `${n.row},${n.col}`;
}

function parseNodeKey(k: string): Node {
  const [rowStr, colStr] = k.split(",");
  return { row: Number(rowStr), col: Number(colStr) };
}

function edgeKey(a: Node, b: Node): string {
  // normalize ordering to make undirected edge key stable
  const aKey = nodeKey(a);
  const bKey = nodeKey(b);
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function addUndirectedEdge(
  adjacency: Map<string, Set<string>>,
  fromKey: string,
  toKey: string
): void {
  if (!adjacency.has(fromKey)) adjacency.set(fromKey, new Set());
  if (!adjacency.has(toKey)) adjacency.set(toKey, new Set());
  adjacency.get(fromKey)!.add(toKey);
  adjacency.get(toKey)!.add(fromKey);
}

function segmentEndpoints(seg: TrackSegment): { from: Node; to: Node } {
  return {
    from: { row: seg.from.row, col: seg.from.col },
    to: { row: seg.to.row, col: seg.to.col },
  };
}

export type BuildUnionGraphResult = {
  adjacency: Map<string, Set<string>>;
  edgeOwners: Map<string, Set<string>>; // edgeKey -> Set<ownerPlayerId>
};

/**
 * Build a union adjacency graph from all players' track segments and add public major-city
 * internal connectivity edges (ownerless) and ferry connections (ownerless).
 */
export function buildUnionTrackGraph(args: {
  allTracks: PlayerTrackState[];
  majorCityGroups?: MajorCityGroup[];
  ferryEdges?: FerryEdge[];
}): BuildUnionGraphResult {
  const adjacency = new Map<string, Set<string>>();
  const edgeOwners = new Map<string, Set<string>>();

  for (const track of args.allTracks) {
    const ownerId = track.playerId;
    for (const seg of track.segments || []) {
      const { from, to } = segmentEndpoints(seg);
      const fromKey = nodeKey(from);
      const toKey = nodeKey(to);
      addUndirectedEdge(adjacency, fromKey, toKey);

      const eKey = edgeKey(from, to);
      if (!edgeOwners.has(eKey)) edgeOwners.set(eKey, new Set());
      edgeOwners.get(eKey)!.add(ownerId);
    }
  }

  // Add major city internal connectivity (public/ownerless edges)
  const cities = args.majorCityGroups ?? getMajorCityGroups();
  for (const city of cities) {
    const centerKey = nodeKey(city.center);
    for (const outpost of city.outposts) {
      const outpostKey = nodeKey(outpost);
      addUndirectedEdge(adjacency, centerKey, outpostKey);
      // Ownerless/public edge: do not add to edgeOwners map
    }
  }

  // Add ferry connections (public/ownerless edges)
  // Ferry edges allow trains to traverse ferry routes for pathfinding
  const ferries = args.ferryEdges ?? getFerryEdges();
  for (const ferry of ferries) {
    const pointAKey = nodeKey(ferry.pointA);
    const pointBKey = nodeKey(ferry.pointB);
    addUndirectedEdge(adjacency, pointAKey, pointBKey);
    // Ownerless/public edge: do not add to edgeOwners map
  }

  return { adjacency, edgeOwners };
}

/**
 * Dijkstra-like pathfinding that prefers own-track and public edges over opponent track.
 * Own-track / public edges have cost 0; opponent-only edges have cost 1.
 * This ensures a player's own (possibly longer) route is chosen over a shorter
 * route through opponent track, avoiding unnecessary track usage fees.
 */
function preferOwnTrackPath(
  adjacency: Map<string, Set<string>>,
  edgeOwners: Map<string, Set<string>>,
  currentPlayerId: string,
  startKey: string,
  goalKey: string
): string[] | null {
  if (startKey === goalKey) return [startKey];

  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  dist.set(startKey, 0);

  const pq: Array<[number, string]> = [[0, startKey]];

  while (pq.length > 0) {
    pq.sort((a, b) => a[0] - b[0]);
    const [curCost, cur] = pq.shift()!;

    if (cur === goalKey) {
      const path: string[] = [goalKey];
      let step = goalKey;
      while (parent.has(step)) {
        step = parent.get(step)!;
        path.unshift(step);
      }
      return path;
    }

    if (curCost > (dist.get(cur) ?? Infinity)) continue;

    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;

    for (const next of neighbors) {
      const fromNode = parseNodeKey(cur);
      const toNode = parseNodeKey(next);
      const eKey = edgeKey(fromNode, toNode);
      const owners = edgeOwners.get(eKey);

      // Cost 0 for own track or public edges; cost 1 for opponent-only edges
      let edgeCost = 0;
      if (owners && owners.size > 0 && !owners.has(currentPlayerId)) {
        edgeCost = 1;
      }

      const newCost = curCost + edgeCost;
      if (newCost < (dist.get(next) ?? Infinity)) {
        dist.set(next, newCost);
        parent.set(next, cur);
        pq.push([newCost, next]);
      }
    }
  }

  return null;
}

export function computeTrackUsageForMove(args: {
  allTracks: PlayerTrackState[];
  from: Node;
  to: Node;
  currentPlayerId: string;
  majorCityGroups?: MajorCityGroup[];
  ferryEdges?: FerryEdge[];
}): TrackUsageComputation {
  const { adjacency, edgeOwners } = buildUnionTrackGraph({
    allTracks: args.allTracks,
    majorCityGroups: args.majorCityGroups,
    ferryEdges: args.ferryEdges,
  });

  const startKey = nodeKey(args.from);
  const goalKey = nodeKey(args.to);

  const pathKeys = preferOwnTrackPath(adjacency, edgeOwners, args.currentPlayerId, startKey, goalKey);
  if (!pathKeys) {
    return {
      isValid: false,
      errorMessage: "No valid path found on union track graph",
      path: [],
      ownersUsed: new Set(),
    };
  }

  const edges: PathEdge[] = [];
  const ownersUsed = new Set<string>();

  for (let i = 0; i < pathKeys.length - 1; i++) {
    const a = parseNodeKey(pathKeys[i]);
    const b = parseNodeKey(pathKeys[i + 1]);
    const eKey = edgeKey(a, b);
    const owners = edgeOwners.get(eKey);
    const ownerPlayerIds = owners ? Array.from(owners) : [];
    for (const ownerId of ownerPlayerIds) {
      if (ownerId !== args.currentPlayerId) ownersUsed.add(ownerId);
    }
    edges.push({ from: a, to: b, ownerPlayerIds });
  }

  return { isValid: true, path: edges, ownersUsed };
}


