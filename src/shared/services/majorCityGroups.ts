import mileposts from "../../../configuration/gridPoints.json";
import ferryPointsConfig from "../../../configuration/ferryPoints.json";

export type MajorCityGroup = {
  cityName: string;
  center: { row: number; col: number };
  outposts: Array<{ row: number; col: number }>;
};

export type FerryEdge = {
  name: string;
  pointA: { row: number; col: number };
  pointB: { row: number; col: number };
  /** Build cost in ECU millions to reach this ferry port (4–16M). */
  cost: number;
};

/**
 * Shared major-city geometry derived from `configuration/gridPoints.json`.
 *
 * Purpose:
 * - Server-side pathfinding/fee computation needs the same "major city internal connectivity"
 *   assumptions as the client.
 * - We model the red-area connectivity as "public edges" (no owner): see
 *   `getMajorCityInternalEdges`.
 */
/**
 * Lookup map from grid coordinate key ("row,col") to city name
 * for all major city points (center + outposts).
 * Used to detect intra-city edges that should not have track built between them.
 */
let _majorCityLookupCache: Map<string, string> | null = null;

export function getMajorCityLookup(): Map<string, string> {
  if (_majorCityLookupCache) return _majorCityLookupCache;

  const lookup = new Map<string, string>();
  for (const group of getMajorCityGroups()) {
    lookup.set(`${group.center.row},${group.center.col}`, group.cityName);
    for (const outpost of group.outposts) {
      lookup.set(`${outpost.row},${outpost.col}`, group.cityName);
    }
  }
  _majorCityLookupCache = lookup;
  return lookup;
}

export function getMajorCityGroups(): MajorCityGroup[] {
  const centers = new Map<string, { row: number; col: number }>();
  const outpostsByCity = new Map<string, Array<{ row: number; col: number }>>();

  for (const raw of mileposts as any[]) {
    const type = String(raw?.Type ?? "");
    const name = raw?.Name ? String(raw.Name) : null;
    const col = typeof raw?.GridX === "number" ? raw.GridX : null;
    const row = typeof raw?.GridY === "number" ? raw.GridY : null;
    if (!name || row === null || col === null) continue;

    if (type === "Major City") {
      centers.set(name, { row, col });
      continue;
    }
    if (type === "Major City Outpost") {
      if (!outpostsByCity.has(name)) outpostsByCity.set(name, []);
      outpostsByCity.get(name)!.push({ row, col });
    }
  }

  const cityNames = new Set<string>([...centers.keys(), ...outpostsByCity.keys()]);
  const groups: MajorCityGroup[] = [];
  for (const cityName of cityNames) {
    const center = centers.get(cityName);
    if (!center) continue; // defensive: skip malformed entries
    const outposts = outpostsByCity.get(cityName) || [];
    groups.push({ cityName, center, outposts });
  }
  return groups;
}

/**
 * Returns true if the edge from `fromKey` to `toKey` is entirely within
 * a single major city's red area (both endpoints belong to the same city).
 */
export function isIntraCityEdge(
  fromKey: string,
  toKey: string,
  majorCityLookup: Map<string, string>,
): boolean {
  const fromCity = majorCityLookup.get(fromKey);
  const toCity = majorCityLookup.get(toKey);
  return fromCity !== undefined && fromCity === toCity;
}

/** True when two mileposts are next to each other on the hex grid. */
function areHexNeighbors(
  a: { row: number; col: number },
  b: { row: number; col: number },
): boolean {
  const dRow = b.row - a.row;
  const dCol = b.col - a.col;
  if (dRow === 0) return Math.abs(dCol) === 1;
  if (Math.abs(dRow) !== 1) return false;
  // Even rows sit half a milepost to the left of odd rows.
  return a.row % 2 === 0 ? dCol === -1 || dCol === 0 : dCol === 0 || dCol === 1;
}

export type MajorCityInternalEdge = {
  from: { row: number; col: number };
  to: { row: number; col: number };
};

let _majorCityInternalEdgesCache: MajorCityInternalEdge[] | null = null;

/**
 * The edges a train may ride inside each major city's red area. The red area
 * is shared space: no player owns track there, and every milepost entered in
 * it counts toward movement like any other.
 *
 * Each city has an edge from its center to every outer milepost, and an edge
 * between every two outer mileposts that are next to each other. The second
 * kind lets a train that enters at one outer milepost and leaves from the
 * next one ride straight between them (2 mileposts) instead of through the
 * center (3 mileposts).
 *
 * @param cities the cities to use; the map's own when omitted.
 */
export function getMajorCityInternalEdges(cities?: readonly MajorCityGroup[]): MajorCityInternalEdge[] {
  if (!cities && _majorCityInternalEdgesCache) return _majorCityInternalEdgesCache;

  const edges: MajorCityInternalEdge[] = [];
  for (const city of cities ?? getMajorCityGroups()) {
    for (const outpost of city.outposts) {
      edges.push({ from: city.center, to: outpost });
    }
    for (let i = 0; i < city.outposts.length; i++) {
      for (let j = i + 1; j < city.outposts.length; j++) {
        if (areHexNeighbors(city.outposts[i], city.outposts[j])) {
          edges.push({ from: city.outposts[i], to: city.outposts[j] });
        }
      }
    }
  }
  if (!cities) _majorCityInternalEdgesCache = edges;
  return edges;
}

/**
 * Counts the mileposts a train uses to travel a path: one for every milepost
 * it enters, so one per edge. Mileposts inside a major city's red area count
 * like any other (the center included).
 *
 * `majorCityLookup` is no longer read; it stays in the signature so the bot
 * planners that call this do not all have to change.
 */
export function computeEffectivePathLength(
  path: Array<{ row: number; col: number }>,
  _majorCityLookup?: Map<string, string>,
): number {
  return Math.max(0, path.length - 1);
}

/**
 * Shared ferry edge geometry derived from configuration files.
 *
 * Purpose:
 * - Server-side pathfinding/fee computation needs ferry connections as valid edges
 * - We model ferry connections as bidirectional public edges (no owner)
 * - This allows trains to use ferries for movement validation
 */
export function getFerryEdges(): FerryEdge[] {
  // Build a lookup map for grid coordinates by milepost ID
  const idToCoords = new Map<string, { row: number; col: number }>();
  for (const raw of mileposts as any[]) {
    const id = raw?.Id;
    const col = typeof raw?.GridX === "number" ? raw.GridX : null;
    const row = typeof raw?.GridY === "number" ? raw.GridY : null;
    if (id && row !== null && col !== null) {
      idToCoords.set(id, { row, col });
    }
  }

  const edges: FerryEdge[] = [];
  for (const ferry of ferryPointsConfig.ferryPoints) {
    const [idA, idB] = ferry.connections;
    const coordsA = idToCoords.get(idA);
    const coordsB = idToCoords.get(idB);
    if (coordsA && coordsB) {
      edges.push({
        name: ferry.Name,
        pointA: coordsA,
        pointB: coordsB,
        cost: ferry.cost,
      });
    }
  }

  return edges;
}

