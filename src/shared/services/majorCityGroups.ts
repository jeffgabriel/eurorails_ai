import mileposts from "../../../configuration/gridPoints.json";

export type MajorCityGroup = {
  cityName: string;
  center: { row: number; col: number };
  outposts: Array<{ row: number; col: number }>;
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


