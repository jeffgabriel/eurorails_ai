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
};

/**
 * Shared major-city geometry derived from `configuration/gridPoints.json`.
 *
 * Purpose:
 * - Server-side pathfinding/fee computation needs the same "major city internal connectivity"
 *   assumptions as the client.
 * - We model the red-area connectivity as "public edges" (no owner) by connecting the
 *   major-city center to each outpost.
 */
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
      });
    }
  }

  return edges;
}

