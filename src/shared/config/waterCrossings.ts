import crossings from "../../../configuration/waterCrossings.json";
import { WaterCrossingType } from "../types/GameTypes";

type WaterCrossingsJson = {
  riverEdges: string[];
  nonRiverWaterEdges: string[];
  riverAttribution?: Record<string, string[]>;
};

const json = crossings as unknown as WaterCrossingsJson;

function edgeKey(a: { row: number; col: number }, b: { row: number; col: number }): string {
  const aKey = `${a.row},${a.col}`;
  const bKey = `${b.row},${b.col}`;
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

// Precompute sets once for O(1) lookup.
const riverSet = new Set<string>(json.riverEdges || []);
const nonRiverSet = new Set<string>(json.nonRiverWaterEdges || []);

// Precompute per-river edge sets from riverAttribution for flood logic.
const riverEdgesByName = new Map<string, Set<string>>();
if (json.riverAttribution) {
  for (const [edgeKey, rivers] of Object.entries(json.riverAttribution)) {
    for (const river of rivers) {
      if (!riverEdgesByName.has(river)) riverEdgesByName.set(river, new Set());
      riverEdgesByName.get(river)!.add(edgeKey);
    }
  }
}

/**
 * Return the set of all river crossing edge keys for the named river,
 * or null if the river is not found in the attribution data.
 */
export function getRiverEdgeKeysByName(riverName: string): Set<string> | null {
  return riverEdgesByName.get(riverName) ?? null;
}

export function getWaterCrossingExtraCost(from: { row: number; col: number }, to: { row: number; col: number }): number {
  const key = edgeKey(from, to);
  if (riverSet.has(key)) return WaterCrossingType.River; // 2
  if (nonRiverSet.has(key)) return WaterCrossingType.Lake; // 3 (also used for ocean inlet)
  return 0;
}
